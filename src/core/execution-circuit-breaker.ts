/**
 * Execution Circuit Breaker
 *
 * Self-protecting gate for the trade execution pipeline.
 * Prevents cascading failures by halting execution when the system
 * detects degraded conditions.
 *
 * States:
 *   CLOSED  — normal operation, all executions proceed
 *   OPEN    — execution halted, all requests rejected immediately
 *   HALF_OPEN — one test request allowed to probe recovery
 *
 * Transition rules:
 *   CLOSED → OPEN:
 *     - Failure rate > FAILURE_RATE_THRESHOLD (40%) over last WINDOW_SIZE (20) executions
 *     - OR consecutive failures ≥ CONSECUTIVE_FAILURE_THRESHOLD (5)
 *
 *   OPEN → HALF_OPEN:
 *     - After COOLDOWN_MS (30s) elapses
 *
 *   HALF_OPEN → CLOSED:
 *     - Test request succeeds
 *
 *   HALF_OPEN → OPEN:
 *     - Test request fails (resets cooldown timer)
 *
 * This circuit breaker is SEPARATE from the API-level circuit breaker
 * in circuit-breaker-service.ts. That one guards HTTP fetch calls.
 * This one guards the entire trade execution pipeline (API + sign + broadcast).
 */

import { ExecutionError } from './execution-error.js';
import { getLogger } from '../utils/logger.js';

// ─── Configuration ──────────────────────────────────────────────────────────

const WINDOW_SIZE = 20;
const FAILURE_RATE_THRESHOLD = 0.4; // 40%
const CONSECUTIVE_FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 30_000; // 30s before HALF_OPEN probe
const MAX_COOLDOWN_MS = 120_000; // 2min cap on exponential backoff
const COOLDOWN_MULTIPLIER = 1.5;

// ─── Types ──────────────────────────────────────────────────────────────────

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface ExecutionResult {
  success: boolean;
  timestamp: number;
  errorCode?: string;
  latencyMs?: number;
}

export interface CircuitBreakerSnapshot {
  state: CircuitState;
  failureRate: number;
  consecutiveFailures: number;
  windowSize: number;
  totalRecorded: number;
  lastFailureAt: number;
  lastSuccessAt: number;
  tripCount: number;
  cooldownRemainingMs: number;
}

// ─── Circuit Breaker ────────────────────────────────────────────────────────

class ExecutionCircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private window: ExecutionResult[] = [];
  private consecutiveFailures = 0;
  private lastFailureAt = 0;
  private lastSuccessAt = 0;
  private openedAt = 0;
  private tripCount = 0;
  private currentCooldownMs = COOLDOWN_MS;
  private halfOpenProbeInFlight = false; // Guard: only one HALF_OPEN probe at a time

  /**
   * Check if execution is allowed.
   * Throws ExecutionError if circuit is OPEN.
   * Returns true if allowed (CLOSED or HALF_OPEN probe).
   */
  checkExecution(): void {
    switch (this.state) {
      case 'CLOSED':
        return; // Proceed

      case 'OPEN': {
        const elapsed = Date.now() - this.openedAt;
        if (elapsed >= this.currentCooldownMs) {
          // Transition to HALF_OPEN — allow one probe request
          this.state = 'HALF_OPEN';
          getLogger().info(
            'CIRCUIT-BREAKER',
            `State: OPEN → HALF_OPEN (cooldown ${Math.round(this.currentCooldownMs / 1000)}s elapsed, allowing probe)`,
          );
          return; // Allow this one request
        }

        const remainingMs = this.currentCooldownMs - elapsed;
        throw new ExecutionError(
          `Circuit breaker OPEN — execution halted. System detected degraded conditions.\n` +
          `  Failure rate: ${(this.getFailureRate() * 100).toFixed(0)}% (threshold: ${FAILURE_RATE_THRESHOLD * 100}%)\n` +
          `  Consecutive failures: ${this.consecutiveFailures}\n` +
          `  Retry in: ${Math.ceil(remainingMs / 1000)}s`,
          {
            action: 'healthCheck',
            errorCode: 'HEALTH_CHECK_FAILED',
            params: {
              circuitState: 'OPEN',
              failureRate: this.getFailureRate(),
              consecutiveFailures: this.consecutiveFailures,
              cooldownRemainingMs: remainingMs,
            },
          },
        );
      }

      case 'HALF_OPEN':
        // Only one concurrent probe allowed in HALF_OPEN state.
        // Second request while probe is in-flight gets blocked.
        if (this.halfOpenProbeInFlight) {
          throw new ExecutionError(
            'Circuit breaker HALF_OPEN — probe in progress. Wait for result.',
            { action: 'healthCheck', errorCode: 'HEALTH_CHECK_FAILED',
              params: { circuitState: 'HALF_OPEN' } },
          );
        }
        this.halfOpenProbeInFlight = true;
        return; // Allow this one probe
    }
  }

  /**
   * Record a successful execution result.
   */
  recordSuccess(latencyMs?: number): void {
    this.consecutiveFailures = 0;
    this.lastSuccessAt = Date.now();

    this._pushResult({ success: true, timestamp: Date.now(), latencyMs });

    if (this.state === 'HALF_OPEN') {
      // Probe succeeded — close circuit
      this.state = 'CLOSED';
      this.halfOpenProbeInFlight = false;
      this.currentCooldownMs = COOLDOWN_MS; // Reset cooldown
      getLogger().info('CIRCUIT-BREAKER', 'State: HALF_OPEN → CLOSED (probe succeeded)');
    }
  }

  /**
   * Record a failed execution result.
   */
  recordFailure(errorCode?: string, latencyMs?: number): void {
    this.consecutiveFailures++;
    this.lastFailureAt = Date.now();

    this._pushResult({ success: false, timestamp: Date.now(), errorCode, latencyMs });

    if (this.state === 'HALF_OPEN') {
      // Probe failed — re-open with increased cooldown
      this.halfOpenProbeInFlight = false;
      this._trip('HALF_OPEN probe failed');
      return;
    }

    if (this.state === 'CLOSED') {
      // Check if we should trip
      if (this.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
        this._trip(`${this.consecutiveFailures} consecutive failures`);
        return;
      }

      const failureRate = this.getFailureRate();
      if (this.window.length >= 5 && failureRate > FAILURE_RATE_THRESHOLD) {
        this._trip(`failure rate ${(failureRate * 100).toFixed(0)}% exceeds ${FAILURE_RATE_THRESHOLD * 100}%`);
      }
    }
  }

  /**
   * Get current failure rate over the sliding window.
   */
  getFailureRate(): number {
    if (this.window.length === 0) return 0;
    const failures = this.window.filter((r) => !r.success).length;
    return failures / this.window.length;
  }

  /**
   * Get diagnostic snapshot of circuit breaker state.
   */
  snapshot(): CircuitBreakerSnapshot {
    const cooldownRemainingMs =
      this.state === 'OPEN'
        ? Math.max(0, this.currentCooldownMs - (Date.now() - this.openedAt))
        : 0;

    return {
      state: this.state,
      failureRate: this.getFailureRate(),
      consecutiveFailures: this.consecutiveFailures,
      windowSize: this.window.length,
      totalRecorded: this.window.length,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      tripCount: this.tripCount,
      cooldownRemainingMs,
    };
  }

  /**
   * Force reset the circuit breaker to CLOSED state.
   * Used for manual intervention or testing.
   */
  reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.currentCooldownMs = COOLDOWN_MS;
    this.halfOpenProbeInFlight = false;
    this.window = [];
    getLogger().info('CIRCUIT-BREAKER', 'Manual reset → CLOSED');
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private _trip(reason: string): void {
    this.state = 'OPEN';
    this.openedAt = Date.now();
    this.tripCount++;

    // Exponential backoff on cooldown (capped)
    if (this.tripCount > 1) {
      this.currentCooldownMs = Math.min(
        this.currentCooldownMs * COOLDOWN_MULTIPLIER,
        MAX_COOLDOWN_MS,
      );
    }

    getLogger().warn(
      'CIRCUIT-BREAKER',
      `State: ${this.state} → OPEN (trip #${this.tripCount}: ${reason}, cooldown: ${Math.round(this.currentCooldownMs / 1000)}s)`,
    );
  }

  private _pushResult(result: ExecutionResult): void {
    this.window.push(result);
    if (this.window.length > WINDOW_SIZE) {
      this.window.shift();
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: ExecutionCircuitBreaker | null = null;

/** Get the global execution circuit breaker. */
export function getExecutionCircuitBreaker(): ExecutionCircuitBreaker {
  if (!_instance) _instance = new ExecutionCircuitBreaker();
  return _instance;
}

/**
 * Pre-execution gate: checks circuit breaker state.
 * Throws ExecutionError if circuit is OPEN.
 * Called in every execute* method after health check.
 */
export function checkCircuitBreaker(): void {
  getExecutionCircuitBreaker().checkExecution();
}
