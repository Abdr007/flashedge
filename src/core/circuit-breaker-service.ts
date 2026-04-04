/**
 * Generic Service Circuit Breaker — prevents cascading failures for external dependencies.
 *
 * States:
 *   CLOSED    — normal operation, requests flow through
 *   OPEN      — service unhealthy, requests blocked for cooldown period
 *   HALF_OPEN — testing recovery, one request allowed through
 *
 * Usage:
 *   const cb = new ServiceCircuitBreaker('pyth', { failureThreshold: 3, cooldownMs: 30_000 });
 *   if (!cb.allowRequest()) return fallback();
 *   try {
 *     const result = await fetchPyth();
 *     cb.recordSuccess();
 *     return result;
 *   } catch (err) {
 *     cb.recordFailure();
 *     throw err;
 *   }
 */

import { getLogger } from '../utils/logger.js';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit */
  failureThreshold: number;
  /** How long the circuit stays open before half-open test (ms) */
  cooldownMs: number;
  /** Max cooldown after exponential backoff (ms) */
  maxCooldownMs: number;
  /** Multiplier for exponential cooldown growth */
  cooldownMultiplier: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  cooldownMs: 30_000,
  maxCooldownMs: 120_000,
  cooldownMultiplier: 2,
};

export interface CircuitBreakerSnapshot {
  name: string;
  state: CircuitState;
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  lastFailureAt: number;
  currentCooldownMs: number;
  opensUntil: number;
}

export class ServiceCircuitBreaker {
  readonly name: string;
  private config: CircuitBreakerConfig;
  private state: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private lastFailureAt = 0;
  private opensUntil = 0;
  private currentCooldownMs: number;
  private tripCount = 0; // how many times circuit has opened (for exponential cooldown)

  constructor(name: string, config: Partial<CircuitBreakerConfig> = {}) {
    this.name = name;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.currentCooldownMs = this.config.cooldownMs;
  }

  /** Check if a request is allowed. Returns false if circuit is OPEN. */
  allowRequest(): boolean {
    if (this.state === CircuitState.CLOSED) return true;

    if (this.state === CircuitState.OPEN) {
      // Check if cooldown has elapsed → transition to HALF_OPEN
      if (Date.now() >= this.opensUntil) {
        this.state = CircuitState.HALF_OPEN;
        getLogger().info(this.name, `Circuit HALF_OPEN — testing recovery`);
        return true; // Allow one test request
      }
      return false; // Still in cooldown
    }

    // HALF_OPEN — already allowed one request, block further until result
    return false;
  }

  /** Record a successful response — resets circuit to CLOSED. */
  recordSuccess(): void {
    this.totalSuccesses++;
    if (this.state === CircuitState.HALF_OPEN) {
      this.close();
    } else {
      this.consecutiveFailures = 0;
    }
  }

  /** Record a failed response — may trip the circuit to OPEN. */
  recordFailure(): void {
    this.consecutiveFailures++;
    this.totalFailures++;
    this.lastFailureAt = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      // Recovery test failed — re-open with increased cooldown
      this.open();
      return;
    }

    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.open();
    }
  }

  /** Current circuit state. */
  get currentState(): CircuitState {
    // Check for auto-transition from OPEN to HALF_OPEN
    if (this.state === CircuitState.OPEN && Date.now() >= this.opensUntil) {
      return CircuitState.HALF_OPEN;
    }
    return this.state;
  }

  /** Whether the circuit is currently blocking requests. */
  get isOpen(): boolean {
    return this.state === CircuitState.OPEN && Date.now() < this.opensUntil;
  }

  /** Snapshot for diagnostics. */
  snapshot(): CircuitBreakerSnapshot {
    return {
      name: this.name,
      state: this.currentState,
      consecutiveFailures: this.consecutiveFailures,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      lastFailureAt: this.lastFailureAt,
      currentCooldownMs: this.currentCooldownMs,
      opensUntil: this.opensUntil,
    };
  }

  /** Force-reset the circuit to CLOSED (for manual recovery). */
  reset(): void {
    this.close();
    this.tripCount = 0;
    this.currentCooldownMs = this.config.cooldownMs;
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private open(): void {
    this.tripCount++;
    // Exponential cooldown: 30s → 60s → 120s (capped)
    this.currentCooldownMs = Math.min(
      this.config.cooldownMs * Math.pow(this.config.cooldownMultiplier, this.tripCount - 1),
      this.config.maxCooldownMs,
    );
    this.opensUntil = Date.now() + this.currentCooldownMs;
    this.state = CircuitState.OPEN;
    getLogger().info(
      this.name,
      `Circuit OPEN — ${this.consecutiveFailures} consecutive failures, cooldown ${Math.round(this.currentCooldownMs / 1000)}s`,
    );
  }

  private close(): void {
    this.state = CircuitState.CLOSED;
    this.consecutiveFailures = 0;
    // Reset cooldown after successful recovery
    this.currentCooldownMs = this.config.cooldownMs;
    this.tripCount = 0;
    getLogger().info(this.name, 'Circuit CLOSED — service recovered');
  }
}

// ─── Global Registry ──────────────────────────────────────────────────────────

const breakers = new Map<string, ServiceCircuitBreaker>();

/** Get or create a circuit breaker for a service. */
export function getServiceBreaker(name: string, config?: Partial<CircuitBreakerConfig>): ServiceCircuitBreaker {
  let cb = breakers.get(name);
  if (!cb) {
    cb = new ServiceCircuitBreaker(name, config);
    breakers.set(name, cb);
  }
  return cb;
}

/** Get all registered circuit breakers (for diagnostics). */
export function getAllBreakers(): ServiceCircuitBreaker[] {
  return Array.from(breakers.values());
}

/** Reset all breakers (for testing). */
export function resetAllBreakers(): void {
  for (const cb of breakers.values()) cb.reset();
  breakers.clear();
}
