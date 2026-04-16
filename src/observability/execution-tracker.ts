/**
 * Execution Tracker — Observability for every API execution
 *
 * Captures deterministic telemetry for every trade execution:
 *   - executionId (UUID)
 *   - action, endpoint, latency
 *   - success / failure with error context
 *
 * Design:
 *   - Non-blocking: never throws, never affects execution flow
 *   - Non-visible: never writes to stdout/stderr (CLI output unchanged)
 *   - Uses existing logger infrastructure for persistence
 *   - Bounded history (MAX_HISTORY entries, LRU eviction)
 */

import { randomUUID } from 'crypto';
import { getLogger } from '../utils/logger.js';
import type { ExecutionAction, ExecutionErrorCode } from '../core/execution-error.js';

// ─── Telemetry Types ────────────────────────────────────────────────────────

export interface ExecutionTelemetry {
  executionId: string;
  action: ExecutionAction;
  endpoint: string;
  startedAt: number; // Date.now()
  completedAt?: number;
  latencyMs?: number;
  success: boolean;
  errorCode?: ExecutionErrorCode;
  errorMessage?: string;
  txSignature?: string;
  /** Safe param subset for diagnostics (never secrets) */
  params?: Record<string, unknown>;
}

export interface ExecutionStats {
  totalExecutions: number;
  successCount: number;
  failureCount: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  lastExecutionAt: number;
  errorBreakdown: Record<string, number>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_HISTORY = 200;
const MAX_ACTIVE_SIZE = 100;
const ACTIVE_TTL_MS = 5 * 60_000; // 5 minutes
const LOG_CATEGORY = 'EXECUTION';

// ─── Tracker State ──────────────────────────────────────────────────────────

const _history: ExecutionTelemetry[] = [];
const _active = new Map<string, ExecutionTelemetry>();

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Begin tracking an execution. Returns the executionId.
 * Call trackExecutionSuccess or trackExecutionFailure when done.
 */
export function trackExecutionStart(
  action: ExecutionAction,
  endpoint: string,
  params?: Record<string, unknown>,
): string {
  const executionId = randomUUID();
  const telemetry: ExecutionTelemetry = {
    executionId,
    action,
    endpoint,
    startedAt: Date.now(),
    success: false,
    params,
  };

  // Prune expired entries from _active to prevent unbounded growth
  if (_active.size >= MAX_ACTIVE_SIZE) {
    const now = Date.now();
    for (const [id, t] of _active) {
      if (now - t.startedAt > ACTIVE_TTL_MS) {
        _active.delete(id);
      }
    }
  }

  _active.set(executionId, telemetry);

  try {
    getLogger().debug(LOG_CATEGORY, `[${executionId.slice(0, 8)}] ${action} → ${endpoint}`, params);
  } catch {
    // Logger failure must never block execution
  }

  return executionId;
}

/**
 * Record successful execution completion.
 */
export function trackExecutionSuccess(
  executionId: string,
  txSignature?: string,
): void {
  const telemetry = _active.get(executionId);
  if (!telemetry) return;

  telemetry.completedAt = Date.now();
  telemetry.latencyMs = telemetry.completedAt - telemetry.startedAt;
  telemetry.success = true;
  telemetry.txSignature = txSignature;

  _active.delete(executionId);
  _pushHistory(telemetry);

  try {
    getLogger().info(
      LOG_CATEGORY,
      `[${executionId.slice(0, 8)}] ${telemetry.action} ✓ ${telemetry.latencyMs}ms` +
        (txSignature ? ` tx:${txSignature.slice(0, 12)}…` : ''),
    );
  } catch {
    // Never block
  }
}

/**
 * Record execution failure.
 */
export function trackExecutionFailure(
  executionId: string,
  errorCode: ExecutionErrorCode,
  errorMessage: string,
): void {
  const telemetry = _active.get(executionId);
  if (!telemetry) return;

  telemetry.completedAt = Date.now();
  telemetry.latencyMs = telemetry.completedAt - telemetry.startedAt;
  telemetry.success = false;
  telemetry.errorCode = errorCode;
  telemetry.errorMessage = errorMessage;

  _active.delete(executionId);
  _pushHistory(telemetry);

  try {
    getLogger().warn(
      LOG_CATEGORY,
      `[${executionId.slice(0, 8)}] ${telemetry.action} ✗ ${telemetry.latencyMs}ms — ${errorCode}: ${errorMessage}`,
    );
  } catch {
    // Never block
  }
}

/**
 * Get aggregate execution statistics.
 */
export function getExecutionStats(): ExecutionStats {
  const completed = _history.filter((t) => t.completedAt);
  const successes = completed.filter((t) => t.success);
  const failures = completed.filter((t) => !t.success);
  const latencies = completed.map((t) => t.latencyMs ?? 0).sort((a, b) => a - b);

  const errorBreakdown: Record<string, number> = {};
  for (const f of failures) {
    const code = f.errorCode ?? 'UNKNOWN';
    errorBreakdown[code] = (errorBreakdown[code] ?? 0) + 1;
  }

  return {
    totalExecutions: completed.length,
    successCount: successes.length,
    failureCount: failures.length,
    averageLatencyMs: latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0,
    p95LatencyMs: latencies.length > 0
      ? latencies[Math.floor(latencies.length * 0.95)] ?? latencies[latencies.length - 1]
      : 0,
    lastExecutionAt: completed.length > 0 ? completed[completed.length - 1].completedAt ?? 0 : 0,
    errorBreakdown,
  };
}

/**
 * Get recent execution history (most recent first).
 */
export function getExecutionHistory(limit = 20): ExecutionTelemetry[] {
  return _history.slice(-limit).reverse();
}

/**
 * Get currently in-flight executions.
 */
export function getActiveExecutions(): ExecutionTelemetry[] {
  return Array.from(_active.values());
}

// ─── Internal ───────────────────────────────────────────────────────────────

function _pushHistory(telemetry: ExecutionTelemetry): void {
  _history.push(telemetry);
  // Bounded LRU: evict oldest when full
  if (_history.length > MAX_HISTORY) {
    _history.splice(0, _history.length - MAX_HISTORY);
  }
}
