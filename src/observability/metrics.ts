/**
 * Operational Metrics Collector — in-memory counters and histograms.
 *
 * Tracks key operational metrics for the trading terminal:
 *   - trade success/failure counts
 *   - RPC latency percentiles
 *   - circuit breaker and kill switch events
 *   - transaction confirmation times
 *
 * ADDITIVE ONLY — never blocks the trading pipeline.
 * All methods are synchronous and fire-and-forget.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MetricSnapshot {
  counters: Record<string, number>;
  histograms: Record<string, HistogramSnapshot>;
  uptime_ms: number;
  timestamp: string;
}

export interface HistogramSnapshot {
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}

// ─── Histogram ───────────────────────────────────────────────────────────────

const MAX_HISTOGRAM_SAMPLES = 1000;

class Histogram {
  private samples: number[] = [];

  record(value: number): void {
    if (!Number.isFinite(value)) return;
    this.samples.push(value);
    if (this.samples.length > MAX_HISTOGRAM_SAMPLES) {
      this.samples = this.samples.slice(-MAX_HISTOGRAM_SAMPLES);
    }
  }

  snapshot(): HistogramSnapshot {
    if (this.samples.length === 0) {
      return { count: 0, sum: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);
    return {
      count: sorted.length,
      sum,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: sum / sorted.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
    };
  }

  reset(): void {
    this.samples = [];
  }
}

// ─── Metrics Collector ───────────────────────────────────────────────────────

export class MetricsCollector {
  private counters = new Map<string, number>();
  private histograms = new Map<string, Histogram>();
  private startTime = Date.now();

  /** Increment a counter by 1 (or a custom amount). */
  increment(name: string, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  /** Record a value in a histogram (e.g., latency in ms). */
  record(name: string, value: number): void {
    let hist = this.histograms.get(name);
    if (!hist) {
      hist = new Histogram();
      this.histograms.set(name, hist);
    }
    hist.record(value);
  }

  /** Get a counter value. */
  getCounter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  /** Get a histogram snapshot. */
  getHistogram(name: string): HistogramSnapshot {
    return (
      this.histograms.get(name)?.snapshot() ?? {
        count: 0,
        sum: 0,
        min: 0,
        max: 0,
        avg: 0,
        p50: 0,
        p95: 0,
        p99: 0,
      }
    );
  }

  /** Export all metrics as a JSON-serializable snapshot. */
  snapshot(): MetricSnapshot {
    const counters: Record<string, number> = {};
    for (const [k, v] of this.counters) {
      counters[k] = v;
    }

    const histograms: Record<string, HistogramSnapshot> = {};
    for (const [k, h] of this.histograms) {
      histograms[k] = h.snapshot();
    }

    return {
      counters,
      histograms,
      uptime_ms: Date.now() - this.startTime,
      timestamp: new Date().toISOString(),
    };
  }

  /** Reset all metrics. */
  reset(): void {
    this.counters.clear();
    for (const h of this.histograms.values()) {
      h.reset();
    }
    this.startTime = Date.now();
  }
}

// ─── Well-Known Metric Names ─────────────────────────────────────────────────

export const METRIC = {
  TRADE_SUCCESS: 'trade_success_total',
  TRADE_FAILURE: 'trade_failure_total',
  TRADE_OPEN: 'trade_open_total',
  TRADE_CLOSE: 'trade_close_total',
  RPC_FAILOVER: 'rpc_failover_total',
  CIRCUIT_BREAKER_TRIPS: 'circuit_breaker_trips',
  KILL_SWITCH_BLOCKS: 'kill_switch_blocks',
  EXPOSURE_BLOCKS: 'exposure_blocks',
  RATE_LIMIT_BLOCKS: 'rate_limit_blocks',
  RPC_LATENCY: 'rpc_latency_ms',
  TX_CONFIRM_TIME: 'transaction_confirmation_time_ms',
  TX_REBROADCAST: 'transaction_rebroadcast_total',
  COMMAND_LATENCY: 'command_latency_ms',
  CACHE_HIT: 'cache_hit_total',
  CACHE_MISS: 'cache_miss_total',
  ERROR_PARSE: 'error_parse_total',
  ERROR_RPC: 'error_rpc_total',
  ERROR_SDK: 'error_sdk_total',
} as const;

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: MetricsCollector | null = null;

export function getMetrics(): MetricsCollector {
  if (!_instance) {
    _instance = new MetricsCollector();
  }
  return _instance;
}

export function resetMetrics(): MetricsCollector {
  _instance = new MetricsCollector();
  return _instance;
}
