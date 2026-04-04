/**
 * Session Metrics
 *
 * Tracks runtime performance metrics for the current CLI session.
 * Zero external dependencies — pure in-memory counters.
 */

export interface SessionStats {
  /** Session start time */
  startedAt: number;
  /** Total commands executed */
  commandCount: number;
  /** Total commands that failed */
  errorCount: number;
  /** Average command latency (ms) */
  avgLatencyMs: number;
  /** Peak command latency (ms) */
  peakLatencyMs: number;
  /** Cache hits (pool registry, metrics) */
  cacheHits: number;
  /** Cache misses */
  cacheMisses: number;
  /** RPC requests made */
  rpcRequests: number;
  /** RPC failures */
  rpcFailures: number;
  /** Transactions submitted */
  txSubmitted: number;
  /** Transactions confirmed */
  txConfirmed: number;
}

class MetricsCollector {
  private stats: SessionStats = {
    startedAt: Date.now(),
    commandCount: 0,
    errorCount: 0,
    avgLatencyMs: 0,
    peakLatencyMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
    rpcRequests: 0,
    rpcFailures: 0,
    txSubmitted: 0,
    txConfirmed: 0,
  };

  private latencySum = 0;

  recordCommand(latencyMs: number, success: boolean): void {
    this.stats.commandCount++;
    if (!success) this.stats.errorCount++;
    this.latencySum += latencyMs;
    this.stats.avgLatencyMs = Math.round(this.latencySum / this.stats.commandCount);
    if (latencyMs > this.stats.peakLatencyMs) this.stats.peakLatencyMs = latencyMs;
  }

  recordCacheHit(): void {
    this.stats.cacheHits++;
  }
  recordCacheMiss(): void {
    this.stats.cacheMisses++;
  }
  recordRpcRequest(): void {
    this.stats.rpcRequests++;
  }
  recordRpcFailure(): void {
    this.stats.rpcFailures++;
  }
  recordTxSubmitted(): void {
    this.stats.txSubmitted++;
  }
  recordTxConfirmed(): void {
    this.stats.txConfirmed++;
  }

  getStats(): SessionStats {
    return { ...this.stats };
  }

  getUptime(): string {
    const ms = Date.now() - this.stats.startedAt;
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  getCacheHitRate(): number {
    const total = this.stats.cacheHits + this.stats.cacheMisses;
    if (total === 0) return 0;
    return Math.round((this.stats.cacheHits / total) * 100);
  }
}

// Singleton
let _instance: MetricsCollector | null = null;

export function getSessionMetrics(): MetricsCollector {
  if (!_instance) _instance = new MetricsCollector();
  return _instance;
}

export function resetSessionMetrics(): void {
  _instance = new MetricsCollector();
}
