/**
 * Execution Store — Persistent execution history and failure intelligence
 *
 * Persists execution telemetry to disk for post-session analysis,
 * provides rolling failure rate calculations, error distribution,
 * and latency spike detection.
 *
 * Storage: ~/.flash/execution-history.json (max 100 entries)
 * Format: JSON array of ExecutionRecord objects
 *
 * Design:
 *   - Non-blocking: disk writes are fire-and-forget
 *   - Non-visible: never affects CLI output
 *   - Bounded: max MAX_STORED entries, oldest evicted
 *   - Crash-safe: atomic write via temp file + rename
 */

import { existsSync, readFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';
import { atomicWriteFileSync } from '../system/safe-file.js';
import type { ExecutionTelemetry } from './execution-tracker.js';

// ─── Configuration ──────────────────────────────────────────────────────────

const MAX_STORED = 100;
const STORE_FILE = join(homedir(), '.flash', 'execution-history.json');
const MAX_FILE_BYTES = 512 * 1024; // 512KB safety cap
const FLUSH_DEBOUNCE_MS = 2_000; // Debounce disk writes

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExecutionRecord {
  executionId: string;
  action: string;
  endpoint: string;
  startedAt: number;
  completedAt: number;
  latencyMs: number;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  txSignature?: string;
}

export interface SystemHealthMetrics {
  /** Rolling failure rate over the given window */
  failureRate: number;
  /** Number of executions in the window */
  windowSize: number;
  /** Error code distribution: { errorCode: count } */
  errorDistribution: Record<string, number>;
  /** Average latency in ms */
  averageLatencyMs: number;
  /** p95 latency in ms */
  p95LatencyMs: number;
  /** Whether a latency spike is detected (p95 > 3x average) */
  latencySpike: boolean;
  /** Total executions ever stored */
  totalStored: number;
  /** Last execution timestamp */
  lastExecutionAt: number;
  /** Consecutive failures (from most recent backward) */
  consecutiveFailures: number;
}

// ─── Store State ────────────────────────────────────────────────────────────

let _records: ExecutionRecord[] = [];
let _loaded = false;
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Persist a completed execution to the store.
 * Non-blocking — schedules a debounced disk write.
 */
export function persistExecution(telemetry: ExecutionTelemetry): void {
  _ensureLoaded();

  if (!telemetry.completedAt || !telemetry.latencyMs) return;

  const record: ExecutionRecord = {
    executionId: telemetry.executionId,
    action: telemetry.action,
    endpoint: telemetry.endpoint,
    startedAt: telemetry.startedAt,
    completedAt: telemetry.completedAt,
    latencyMs: telemetry.latencyMs,
    success: telemetry.success,
    errorCode: telemetry.errorCode,
    errorMessage: telemetry.errorMessage,
    txSignature: telemetry.txSignature,
  };

  _records.push(record);

  // Evict oldest if over limit
  if (_records.length > MAX_STORED) {
    _records.splice(0, _records.length - MAX_STORED);
  }

  _scheduleDiskFlush();
}

/**
 * Get recent executions, most recent first.
 */
export function getRecentExecutions(limit = 20): ExecutionRecord[] {
  _ensureLoaded();
  return _records.slice(-limit).reverse();
}

/**
 * Get failure rate over a rolling time window.
 * @param windowMs — time window in ms (default 5 minutes)
 */
export function getFailureRate(windowMs = 5 * 60_000): number {
  _ensureLoaded();
  const cutoff = Date.now() - windowMs;
  const recent = _records.filter((r) => r.completedAt > cutoff);
  if (recent.length === 0) return 0;
  const failures = recent.filter((r) => !r.success).length;
  return failures / recent.length;
}

/**
 * Get the p95 latency from recent executions.
 * Used by the adaptive timeout system.
 * @param windowMs — time window in ms (default 10 minutes)
 */
export function getP95Latency(windowMs = 10 * 60_000): number {
  _ensureLoaded();
  const cutoff = Date.now() - windowMs;
  const recent = _records.filter((r) => r.completedAt > cutoff && r.success && r.latencyMs > 0);
  if (recent.length < 3) return 0; // Not enough data — return 0 to signal "use default"
  const sorted = recent.map((r) => r.latencyMs).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
}

/**
 * Comprehensive system health metrics.
 * Combines failure rate, error distribution, latency analysis.
 */
export function getSystemHealthMetrics(windowMs = 5 * 60_000): SystemHealthMetrics {
  _ensureLoaded();
  const cutoff = Date.now() - windowMs;
  const recent = _records.filter((r) => r.completedAt > cutoff);
  const failures = recent.filter((r) => !r.success);
  const latencies = recent.filter((r) => r.latencyMs > 0).map((r) => r.latencyMs).sort((a, b) => a - b);

  // Error distribution
  const errorDistribution: Record<string, number> = {};
  for (const f of failures) {
    const code = f.errorCode ?? 'UNKNOWN';
    errorDistribution[code] = (errorDistribution[code] ?? 0) + 1;
  }

  // Latency stats
  const averageLatencyMs = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;
  const p95LatencyMs = latencies.length > 0
    ? latencies[Math.floor(latencies.length * 0.95)] ?? latencies[latencies.length - 1]
    : 0;

  // Latency spike: p95 > 3x average (indicates congestion)
  const latencySpike = averageLatencyMs > 0 && p95LatencyMs > averageLatencyMs * 3;

  // Consecutive failures from most recent
  let consecutiveFailures = 0;
  for (let i = _records.length - 1; i >= 0; i--) {
    if (!_records[i].success) consecutiveFailures++;
    else break;
  }

  return {
    failureRate: recent.length > 0 ? failures.length / recent.length : 0,
    windowSize: recent.length,
    errorDistribution,
    averageLatencyMs,
    p95LatencyMs,
    latencySpike,
    totalStored: _records.length,
    lastExecutionAt: _records.length > 0 ? _records[_records.length - 1].completedAt : 0,
    consecutiveFailures,
  };
}

/**
 * Flush execution history to disk immediately.
 * Call on process shutdown.
 */
export function flushExecutionStore(): void {
  _writeToDisk();
}

// ─── Internal ───────────────────────────────────────────────────────────────

function _ensureLoaded(): void {
  if (_loaded) return;
  _loaded = true;
  _loadFromDisk();
}

function _loadFromDisk(): void {
  try {
    if (!existsSync(STORE_FILE)) return;
    const raw = readFileSync(STORE_FILE, 'utf8');
    if (raw.length > MAX_FILE_BYTES) {
      getLogger().warn('EXEC-STORE', `Execution history too large (${raw.length} bytes), starting fresh`);
      return;
    }
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      // Validate and filter
      _records = data.filter(
        (r: unknown): r is ExecutionRecord =>
          typeof r === 'object' && r !== null &&
          'executionId' in r && 'action' in r &&
          'completedAt' in r && typeof (r as ExecutionRecord).completedAt === 'number',
      );
      // Trim to max
      if (_records.length > MAX_STORED) {
        _records = _records.slice(-MAX_STORED);
      }
      getLogger().debug('EXEC-STORE', `Loaded ${_records.length} execution records from disk`);
    }
  } catch (err) {
    getLogger().warn('EXEC-STORE', `Corrupted execution history — deleting and starting fresh: ${err instanceof Error ? err.message : 'unknown'}`);
    // Delete corrupted file so it doesn't persist across restarts
    try {
      if (existsSync(STORE_FILE)) unlinkSync(STORE_FILE);
    } catch { /* best-effort cleanup */ }
  }
}

function _writeToDisk(): void {
  try {
    const dir = join(homedir(), '.flash');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const json = JSON.stringify(_records);
    if (json.length > MAX_FILE_BYTES) {
      // Trim older entries to fit
      const half = Math.floor(_records.length / 2);
      _records = _records.slice(half);
    }
    atomicWriteFileSync(STORE_FILE, JSON.stringify(_records));
  } catch (err) {
    getLogger().debug('EXEC-STORE', `Failed to persist execution history: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

function _scheduleDiskFlush(): void {
  if (_flushTimer) return; // Already scheduled
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    _writeToDisk();
  }, FLUSH_DEBOUNCE_MS);
  // Don't block process exit
  if (_flushTimer && typeof _flushTimer === 'object' && 'unref' in _flushTimer) {
    _flushTimer.unref();
  }
}
