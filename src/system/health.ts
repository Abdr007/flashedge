/**
 * System Health Monitor V3 — self-aware, adaptive runtime health.
 *
 * Tracks: memory, event loop lag, RPC latency, error rate
 * States: HEALTHY → DEGRADED → CRITICAL (with circuit breaker cooldown)
 *
 * V3 capabilities:
 *   - Root-cause attribution for every degraded/critical state
 *   - Adaptive degradation parameters (scan freq, concurrency, retry rate)
 *   - Rolling history at 5m / 15m / 60m windows for trending
 *   - Circuit breaker cooldown prevents rapid state oscillation
 *
 * Singleton: initHealth() / getHealth() / shutdownHealth()
 */

import { getLogger } from '../utils/logger.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const HEALTH_TICK_MS = 5_000;
const LAG_POLL_MS = 500;

// Thresholds
const LAG_WARNING_MS = 500;   // Node.js with heavy SDK ops regularly hits 200-400ms
const LAG_CRITICAL_MS = 2000; // Only flag truly blocked event loops
// Memory thresholds — realistic for Node.js + flash-sdk + Solana libs.
// Baseline: flash-sdk PoolConfig loads ~80MB per pool (IDL, accounts, buffers).
// With 6 pools + state-cache + connections: ~500-800MB is NORMAL operating range.
const MEM_WARNING_BYTES = 1.8 * 1024 * 1024 * 1024;  // 1.8 GB
const MEM_CRITICAL_BYTES = 2.5 * 1024 * 1024 * 1024;  // 2.5 GB
const ERROR_RATE_WARNING = 10;
const ERROR_RATE_CRITICAL = 30;
const RPC_LATENCY_WARNING_MS = 2000;
const RPC_LATENCY_CRITICAL_MS = 5000;

// Hysteresis
const LAG_RECOVERY_MS = 100;
const MEM_RECOVERY_BYTES = 1.0 * 1024 * 1024 * 1024; // 1 GB

// Circuit breaker: minimum time in CRITICAL before allowing recovery
const CRITICAL_COOLDOWN_MS = 60_000;

// History
const HISTORY_SAMPLE_INTERVAL_MS = 15_000; // sample every 15s
const HISTORY_MAX_SAMPLES = 240; // 240 × 15s = 60 min of history

// ─── Types ───────────────────────────────────────────────────────────────────

export type HealthState = 'HEALTHY' | 'DEGRADED' | 'CRITICAL';

export type HealthCause =
  | 'event_loop_lag'
  | 'memory_pressure'
  | 'high_error_rate'
  | 'rpc_latency'
  | 'none';

export interface CauseBreakdown {
  cause: HealthCause;
  severity: 'warning' | 'critical';
  value: number;
  threshold: number;
  label: string;
}

export interface HealthSnapshot {
  state: HealthState;
  /** Unified health score: 100 = perfect, 0 = critical failure */
  healthScore: number;
  eventLoopLagMs: number;
  memoryRssMB: number;
  heapUsedMB: number;
  errorRate: number;
  rpcLatencyMs: number;
  uptimeSeconds: number;
  reasons: string[];
  /** Primary cause of degradation (null if HEALTHY) */
  primaryCause: HealthCause;
  /** All contributing factors, sorted by severity */
  causes: CauseBreakdown[];
  /** Time spent in current state (seconds) */
  stateAge: number;
}

/** Adaptive parameters adjusted based on health state */
export interface DegradationParams {
  /** Multiplier for scan/poll intervals (1.0 = normal, 2.0 = half speed) */
  scanIntervalMultiplier: number;
  /** Max concurrent async operations */
  maxConcurrency: number;
  /** Multiplier for trade score thresholds (1.0 = normal, 1.5 = stricter) */
  tradeThresholdMultiplier: number;
  /** Multiplier for retry delays (1.0 = normal, 2.0 = slower retries) */
  retryDelayMultiplier: number;
  /** Whether new trades are blocked */
  tradesBlocked: boolean;
}

export interface HistorySample {
  timestamp: number;
  lagMs: number;
  rssMB: number;
  heapMB: number;
  errorRate: number;
  rpcLatencyMs: number;
  state: HealthState;
}

export interface HealthHistory {
  /** Average over last 5 minutes */
  avg5m: { lagMs: number; rssMB: number; errorRate: number; rpcLatencyMs: number };
  /** Average over last 15 minutes */
  avg15m: { lagMs: number; rssMB: number; errorRate: number; rpcLatencyMs: number };
  /** Average over last 60 minutes */
  avg60m: { lagMs: number; rssMB: number; errorRate: number; rpcLatencyMs: number };
  /** Trends: positive = increasing, negative = decreasing */
  trends: { lag: 'rising' | 'stable' | 'falling'; memory: 'rising' | 'stable' | 'falling'; errors: 'rising' | 'stable' | 'falling' };
  /** Raw sample count */
  sampleCount: number;
}

export interface HealthMonitor {
  readonly state: HealthState;
  snapshot(): HealthSnapshot;
  recordError(): void;
  recordRpcLatency(ms: number): void;
  isTradeBlocked(): boolean;
  /** Get adaptive degradation parameters for current state */
  getDegradationParams(): DegradationParams;
  /** Get rolling history and trends */
  getHistory(): HealthHistory;
  shutdown(): void;
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: HealthMonitorImpl | null = null;

export function initHealth(): HealthMonitor {
  if (_instance) _instance.shutdown();
  _instance = new HealthMonitorImpl();
  return _instance;
}

export function getHealth(): HealthMonitor | null {
  return _instance;
}

export function shutdownHealth(): void {
  if (_instance) {
    _instance.shutdown();
    _instance = null;
  }
}

// ─── Implementation ──────────────────────────────────────────────────────────

class HealthMonitorImpl implements HealthMonitor {
  private _state: HealthState = 'HEALTHY';
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private lagTimer: ReturnType<typeof setInterval> | null = null;
  private historyTimer: ReturnType<typeof setInterval> | null = null;

  // Event loop lag
  private lastLagCheck = performance.now();
  private currentLagMs = 0;
  private lagSamples: number[] = [];
  private static readonly MAX_LAG_SAMPLES = 20;

  // Error rate (sliding window: 60s)
  private errorTimestamps: number[] = [];

  // RPC latency (rolling)
  private rpcLatencies: number[] = [];
  private static readonly MAX_RPC_SAMPLES = 20;

  // State tracking
  private lastStateChange = Date.now();
  private criticalEnteredAt = 0; // timestamp when CRITICAL was entered
  private startTime = Date.now();

  // Root cause
  private _primaryCause: HealthCause = 'none';
  private _causes: CauseBreakdown[] = [];

  // History
  private history: HistorySample[] = [];

  constructor() {
    // Event loop lag monitor — CRITICAL, never throttled
    this.lagTimer = setInterval(() => this.measureLag(), LAG_POLL_MS);
    this.lagTimer.unref();

    // Health evaluation — CRITICAL, never throttled
    this.healthTimer = setInterval(() => this.evaluate(), HEALTH_TICK_MS);
    this.healthTimer.unref();

    // History sampling — throttled in IDLE via scheduler (deferred registration)
    this.historyTimer = setInterval(() => this.recordHistorySample(), HISTORY_SAMPLE_INTERVAL_MS);
    this.historyTimer.unref();

    getLogger().info('HEALTH', 'System health monitor v3 started (root-cause, adaptive, trending)');
  }

  private measureLag(): void {
    const now = performance.now();
    const actual = now - this.lastLagCheck;
    const lag = Math.max(0, actual - LAG_POLL_MS);
    this.lastLagCheck = now;

    this.lagSamples.push(lag);
    if (this.lagSamples.length > HealthMonitorImpl.MAX_LAG_SAMPLES) {
      this.lagSamples.shift();
    }
    this.currentLagMs = this.percentile(this.lagSamples, 0.9);
  }

  get state(): HealthState {
    return this._state;
  }

  snapshot(): HealthSnapshot {
    const mem = process.memoryUsage();
    const { primary, causes } = this.analyzeCauses();
    const lagMs = Math.round(this.currentLagMs);
    const rssMB = Math.round(mem.rss / (1024 * 1024));
    const errorRate = this.getErrorRate();
    const rpcLatencyMs = this.getAvgRpcLatency();
    return {
      state: this._state,
      healthScore: this.computeHealthScore(lagMs, mem.rss, errorRate, rpcLatencyMs),
      eventLoopLagMs: lagMs,
      memoryRssMB: rssMB,
      heapUsedMB: Math.round(mem.heapUsed / (1024 * 1024)),
      errorRate,
      rpcLatencyMs,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      reasons: causes.map((c) => c.label),
      primaryCause: primary,
      causes: [...causes],
      stateAge: Math.floor((Date.now() - this.lastStateChange) / 1000),
    };
  }

  /**
   * Compute a unified 0-100 health score.
   * 100 = perfect, 80+ = healthy, 60-80 = degraded, <60 = critical
   *
   * Weighted components:
   *   - Event loop lag:  30 points (most important for CLI responsiveness)
   *   - Error rate:      25 points
   *   - RPC latency:     25 points
   *   - Memory:          20 points
   */
  private computeHealthScore(lagMs: number, rssBytes: number, errorRate: number, rpcLatencyMs: number): number {
    // Each component scores 0-1 (1 = perfect)
    const lagScore = lagMs <= 50 ? 1 : lagMs >= LAG_CRITICAL_MS ? 0 : 1 - (lagMs - 50) / (LAG_CRITICAL_MS - 50);
    const errorScore = errorRate <= 0 ? 1 : errorRate >= ERROR_RATE_CRITICAL ? 0 : 1 - errorRate / ERROR_RATE_CRITICAL;
    const rpcScore = rpcLatencyMs <= 200 ? 1 : rpcLatencyMs >= RPC_LATENCY_CRITICAL_MS ? 0 : 1 - (rpcLatencyMs - 200) / (RPC_LATENCY_CRITICAL_MS - 200);
    const memScore = rssBytes <= 0.8e9 ? 1 : rssBytes >= MEM_CRITICAL_BYTES ? 0 : 1 - (rssBytes - 0.8e9) / (MEM_CRITICAL_BYTES - 0.8e9);

    const weighted = lagScore * 30 + errorScore * 25 + rpcScore * 25 + memScore * 20;
    return Math.max(0, Math.min(100, Math.round(weighted)));
  }

  recordError(): void {
    this.errorTimestamps.push(Date.now());
    const cutoff = Date.now() - 60_000;
    while (this.errorTimestamps.length > 0 && this.errorTimestamps[0] < cutoff) {
      this.errorTimestamps.shift();
    }
  }

  recordRpcLatency(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.rpcLatencies.push(ms);
    if (this.rpcLatencies.length > HealthMonitorImpl.MAX_RPC_SAMPLES) {
      this.rpcLatencies.shift();
    }
  }

  isTradeBlocked(): boolean {
    return this._state === 'CRITICAL';
  }

  getDegradationParams(): DegradationParams {
    switch (this._state) {
      case 'HEALTHY':
        return {
          scanIntervalMultiplier: 1.0,
          maxConcurrency: 10,
          tradeThresholdMultiplier: 1.0,
          retryDelayMultiplier: 1.0,
          tradesBlocked: false,
        };
      case 'DEGRADED':
        return {
          scanIntervalMultiplier: 2.0,   // Halve scan frequency
          maxConcurrency: 5,              // Reduce concurrency
          tradeThresholdMultiplier: 1.3,  // Raise trade score threshold 30%
          retryDelayMultiplier: 2.0,      // Double retry delays
          tradesBlocked: false,
        };
      case 'CRITICAL':
        return {
          scanIntervalMultiplier: 4.0,   // Quarter scan frequency
          maxConcurrency: 2,             // Minimal concurrency
          tradeThresholdMultiplier: 2.0, // Double trade threshold (moot — blocked)
          retryDelayMultiplier: 4.0,     // 4x retry delays
          tradesBlocked: true,
        };
    }
  }

  getHistory(): HealthHistory {
    const now = Date.now();
    const samples5m = this.history.filter((s) => now - s.timestamp < 5 * 60_000);
    const samples15m = this.history.filter((s) => now - s.timestamp < 15 * 60_000);
    const samples60m = this.history;

    return {
      avg5m: this.averageSamples(samples5m),
      avg15m: this.averageSamples(samples15m),
      avg60m: this.averageSamples(samples60m),
      trends: this.computeTrends(samples5m, samples15m),
      sampleCount: this.history.length,
    };
  }

  shutdown(): void {
    if (this.lagTimer) { clearInterval(this.lagTimer); this.lagTimer = null; }
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    if (this.historyTimer) { clearInterval(this.historyTimer); this.historyTimer = null; }
    this.history = [];
    getLogger().info('HEALTH', 'System health monitor stopped');
  }

  // ─── Root-Cause Analysis ─────────────────────────────────────────────

  private analyzeCauses(): { primary: HealthCause; causes: CauseBreakdown[] } {
    const causes: CauseBreakdown[] = [];
    const mem = process.memoryUsage();
    const lag = this.currentLagMs;
    const errorRate = this.getErrorRate();
    const rpcLatency = this.getAvgRpcLatency();

    // Event loop lag
    if (lag >= LAG_CRITICAL_MS) {
      causes.push({ cause: 'event_loop_lag', severity: 'critical', value: Math.round(lag), threshold: LAG_CRITICAL_MS, label: `event loop lag ${Math.round(lag)}ms (critical >=${LAG_CRITICAL_MS}ms)` });
    } else if (lag >= LAG_WARNING_MS) {
      causes.push({ cause: 'event_loop_lag', severity: 'warning', value: Math.round(lag), threshold: LAG_WARNING_MS, label: `event loop lag ${Math.round(lag)}ms (>=${LAG_WARNING_MS}ms)` });
    }

    // Memory
    if (mem.rss >= MEM_CRITICAL_BYTES) {
      causes.push({ cause: 'memory_pressure', severity: 'critical', value: Math.round(mem.rss / (1024 * 1024)), threshold: Math.round(MEM_CRITICAL_BYTES / (1024 * 1024)), label: `RSS ${Math.round(mem.rss / (1024 * 1024))}MB (critical >=${Math.round(MEM_CRITICAL_BYTES / (1024 * 1024))}MB)` });
    } else if (mem.rss >= MEM_WARNING_BYTES) {
      causes.push({ cause: 'memory_pressure', severity: 'warning', value: Math.round(mem.rss / (1024 * 1024)), threshold: Math.round(MEM_WARNING_BYTES / (1024 * 1024)), label: `RSS ${Math.round(mem.rss / (1024 * 1024))}MB (>=${Math.round(MEM_WARNING_BYTES / (1024 * 1024))}MB)` });
    }

    // Error rate
    if (errorRate >= ERROR_RATE_CRITICAL) {
      causes.push({ cause: 'high_error_rate', severity: 'critical', value: errorRate, threshold: ERROR_RATE_CRITICAL, label: `error rate ${errorRate}/min (critical >=${ERROR_RATE_CRITICAL})` });
    } else if (errorRate >= ERROR_RATE_WARNING) {
      causes.push({ cause: 'high_error_rate', severity: 'warning', value: errorRate, threshold: ERROR_RATE_WARNING, label: `error rate ${errorRate}/min (>=${ERROR_RATE_WARNING})` });
    }

    // RPC latency
    if (rpcLatency >= RPC_LATENCY_CRITICAL_MS) {
      causes.push({ cause: 'rpc_latency', severity: 'critical', value: rpcLatency, threshold: RPC_LATENCY_CRITICAL_MS, label: `RPC latency ${rpcLatency}ms (critical >=${RPC_LATENCY_CRITICAL_MS}ms)` });
    } else if (rpcLatency >= RPC_LATENCY_WARNING_MS) {
      causes.push({ cause: 'rpc_latency', severity: 'warning', value: rpcLatency, threshold: RPC_LATENCY_WARNING_MS, label: `RPC latency ${rpcLatency}ms (>=${RPC_LATENCY_WARNING_MS}ms)` });
    }

    // Sort: critical first, then by value/threshold ratio (worst first)
    causes.sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
      return (b.value / b.threshold) - (a.value / a.threshold);
    });

    const primary: HealthCause = causes.length > 0 ? causes[0].cause : 'none';
    return { primary, causes };
  }

  // ─── Evaluation ────────────────────────────────────────────────────────

  private evaluate(): void {
    const mem = process.memoryUsage();
    const lag = this.currentLagMs;
    const errorRate = this.getErrorRate();
    const rpcLatency = this.getAvgRpcLatency();
    const prevState = this._state;

    // Analyze causes first
    const { primary, causes } = this.analyzeCauses();
    this._primaryCause = primary;
    this._causes = causes;

    // Determine new state — worst condition wins
    let newState: HealthState = 'HEALTHY';

    const hasCritical = causes.some((c) => c.severity === 'critical');
    const hasWarning = causes.length > 0;

    if (hasCritical) {
      newState = 'CRITICAL';
    } else if (hasWarning) {
      newState = 'DEGRADED';
    }

    // Recovery hysteresis
    if (newState === 'HEALTHY' && (prevState === 'DEGRADED' || prevState === 'CRITICAL')) {
      if (lag > LAG_RECOVERY_MS || mem.rss > MEM_RECOVERY_BYTES) {
        newState = 'DEGRADED';
      }
    }

    // Circuit breaker cooldown: CRITICAL must persist for minimum duration
    if (prevState === 'CRITICAL' && newState !== 'CRITICAL') {
      const timeInCritical = Date.now() - this.criticalEnteredAt;
      if (timeInCritical < CRITICAL_COOLDOWN_MS) {
        newState = 'CRITICAL'; // Hold CRITICAL until cooldown expires
      }
    }

    if (newState !== prevState) {
      this._state = newState;
      this.lastStateChange = Date.now();
      if (newState === 'CRITICAL') {
        this.criticalEnteredAt = Date.now();
      }

      const logger = getLogger();
      const causeSummary = causes.map((c) => c.label).join('; ') || 'recovered';

      if (newState === 'CRITICAL') {
        logger.error('HEALTH', `CRITICAL — primary: ${primary} | ${causeSummary}`, {
          primaryCause: primary,
          causeCount: causes.length,
          lagMs: Math.round(lag),
          rssMB: Math.round(mem.rss / (1024 * 1024)),
          errorRate,
          rpcLatencyMs: rpcLatency,
        });
      } else if (newState === 'DEGRADED') {
        logger.warn('HEALTH', `DEGRADED — primary: ${primary} | ${causeSummary}`, {
          primaryCause: primary,
          causeCount: causes.length,
          lagMs: Math.round(lag),
          rssMB: Math.round(mem.rss / (1024 * 1024)),
          errorRate,
          rpcLatencyMs: rpcLatency,
        });
      } else {
        const duration = Math.round((Date.now() - this.lastStateChange) / 1000);
        logger.info('HEALTH', `Recovered to HEALTHY (was ${prevState} for ${duration}s, cause was: ${primary})`);
      }
    }
  }

  // ─── History & Trending ────────────────────────────────────────────────

  private recordHistorySample(): void {
    const mem = process.memoryUsage();
    this.history.push({
      timestamp: Date.now(),
      lagMs: Math.round(this.currentLagMs),
      rssMB: Math.round(mem.rss / (1024 * 1024)),
      heapMB: Math.round(mem.heapUsed / (1024 * 1024)),
      errorRate: this.getErrorRate(),
      rpcLatencyMs: this.getAvgRpcLatency(),
      state: this._state,
    });

    // Cap history
    if (this.history.length > HISTORY_MAX_SAMPLES) {
      this.history = this.history.slice(-HISTORY_MAX_SAMPLES);
    }
  }

  private averageSamples(samples: HistorySample[]): { lagMs: number; rssMB: number; errorRate: number; rpcLatencyMs: number } {
    if (samples.length === 0) return { lagMs: 0, rssMB: 0, errorRate: 0, rpcLatencyMs: 0 };
    const n = samples.length;
    return {
      lagMs: Math.round(samples.reduce((s, x) => s + x.lagMs, 0) / n),
      rssMB: Math.round(samples.reduce((s, x) => s + x.rssMB, 0) / n),
      errorRate: Math.round(samples.reduce((s, x) => s + x.errorRate, 0) / n * 10) / 10,
      rpcLatencyMs: Math.round(samples.reduce((s, x) => s + x.rpcLatencyMs, 0) / n),
    };
  }

  private computeTrends(
    recent: HistorySample[], // 5m
    older: HistorySample[],  // 15m
  ): { lag: 'rising' | 'stable' | 'falling'; memory: 'rising' | 'stable' | 'falling'; errors: 'rising' | 'stable' | 'falling' } {
    // Compare recent 5m average vs full 15m average
    // If recent is >20% higher → rising, >20% lower → falling, else stable
    const avg5 = this.averageSamples(recent);
    const avg15 = this.averageSamples(older);

    const trend = (recent5: number, older15: number): 'rising' | 'stable' | 'falling' => {
      if (older15 === 0) return 'stable';
      const ratio = recent5 / older15;
      if (ratio > 1.2) return 'rising';
      if (ratio < 0.8) return 'falling';
      return 'stable';
    };

    return {
      lag: trend(avg5.lagMs, avg15.lagMs),
      memory: trend(avg5.rssMB, avg15.rssMB),
      errors: trend(avg5.errorRate, avg15.errorRate),
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private getErrorRate(): number {
    const cutoff = Date.now() - 60_000;
    while (this.errorTimestamps.length > 0 && this.errorTimestamps[0] < cutoff) {
      this.errorTimestamps.shift();
    }
    return this.errorTimestamps.length;
  }

  private getAvgRpcLatency(): number {
    if (this.rpcLatencies.length === 0) return 0;
    return Math.round(this.rpcLatencies.reduce((a, b) => a + b, 0) / this.rpcLatencies.length);
  }

  private percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
    return sorted[idx];
  }
}
