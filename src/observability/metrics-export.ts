/**
 * Metrics Export — optional Prometheus, Datadog, and JSON export.
 *
 * Disabled by default. Enable via:
 *   METRICS_EXPORT=json     → JSON dump via CLI command
 *   METRICS_EXPORT=prometheus → Prometheus text format
 *
 * ADDITIVE ONLY — never affects trading execution.
 */

import { createServer, type Server } from 'http';
import { getMetrics, METRIC } from './metrics.js';
import { getLogger } from '../utils/logger.js';

// ─── Prometheus Format ───────────────────────────────────────────────────────

/** Export metrics in Prometheus text exposition format. */
export function toPrometheus(): string {
  const snap = getMetrics().snapshot();
  const lines: string[] = [];

  // Counters
  for (const [name, value] of Object.entries(snap.counters)) {
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${value}`);
  }

  // Histograms (exported as summary-style gauges)
  for (const [name, hist] of Object.entries(snap.histograms)) {
    if (hist.count === 0) continue;
    lines.push(`# TYPE ${name} summary`);
    lines.push(`${name}_count ${hist.count}`);
    lines.push(`${name}_sum ${hist.sum.toFixed(2)}`);
    lines.push(`${name}{quantile="0.5"} ${hist.p50.toFixed(2)}`);
    lines.push(`${name}{quantile="0.95"} ${hist.p95.toFixed(2)}`);
    lines.push(`${name}{quantile="0.99"} ${hist.p99.toFixed(2)}`);
  }

  // Uptime
  lines.push('# TYPE flash_uptime_ms gauge');
  lines.push(`flash_uptime_ms ${snap.uptime_ms}`);

  return lines.join('\n') + '\n';
}

// ─── Datadog Format ──────────────────────────────────────────────────────────

interface DatadogMetric {
  metric: string;
  type: 'count' | 'gauge';
  points: Array<[number, number]>;
  tags?: string[];
}

/** Export metrics in Datadog API format. */
export function toDatadog(tags?: string[]): { series: DatadogMetric[] } {
  const snap = getMetrics().snapshot();
  const now = Math.floor(Date.now() / 1000);
  const series: DatadogMetric[] = [];

  for (const [name, value] of Object.entries(snap.counters)) {
    series.push({
      metric: `flash.${name}`,
      type: 'count',
      points: [[now, value]],
      tags,
    });
  }

  for (const [name, hist] of Object.entries(snap.histograms)) {
    if (hist.count === 0) continue;
    series.push({
      metric: `flash.${name}.avg`,
      type: 'gauge',
      points: [[now, hist.avg]],
      tags,
    });
    series.push({
      metric: `flash.${name}.p95`,
      type: 'gauge',
      points: [[now, hist.p95]],
      tags,
    });
    series.push({
      metric: `flash.${name}.p99`,
      type: 'gauge',
      points: [[now, hist.p99]],
      tags,
    });
  }

  return { series };
}

// ─── JSON Format ─────────────────────────────────────────────────────────────

/** Export metrics as formatted JSON string. */
export function toJSON(pretty = true): string {
  const snap = getMetrics().snapshot();
  return pretty ? JSON.stringify(snap, null, 2) : JSON.stringify(snap);
}

// ─── CLI-Friendly Summary ────────────────────────────────────────────────────

// ─── HTTP Metrics Server ──────────────────────────────────────────────────────

let _metricsServer: Server | null = null;

/**
 * Start an HTTP server that exposes metrics in Prometheus format on /metrics.
 * Enable via METRICS_PORT env var (e.g., METRICS_PORT=9090).
 * Binds to 127.0.0.1 only — not externally accessible.
 */
export function startMetricsServer(port?: number): Server | null {
  const metricsPort = port ?? parseInt(process.env.METRICS_PORT ?? '0', 10);
  if (!metricsPort || metricsPort <= 0) return null;
  if (_metricsServer) return _metricsServer;

  const logger = getLogger();

  _metricsServer = createServer((req, res) => {
    if (req.url === '/metrics' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(toPrometheus());
    } else if (req.url === '/metrics/json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(toJSON(false));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  _metricsServer.listen(metricsPort, '127.0.0.1', () => {
    logger.info('METRICS', `Metrics server listening on http://127.0.0.1:${metricsPort}/metrics`);
  });

  _metricsServer.unref(); // Don't prevent process exit

  return _metricsServer;
}

/** Stop the metrics HTTP server. */
export function stopMetricsServer(): void {
  if (_metricsServer) {
    _metricsServer.close();
    _metricsServer = null;
  }
}

// ─── CLI-Friendly Summary ────────────────────────────────────────────────────

/** Format metrics for CLI display. */
export function formatMetricsSummary(): string {
  const snap = getMetrics().snapshot();
  const lines: string[] = [];

  lines.push('  Operational Metrics');
  lines.push('  ─────────────────────────────');

  // Counters
  const counterOrder = [
    METRIC.TRADE_SUCCESS,
    METRIC.TRADE_FAILURE,
    METRIC.TRADE_OPEN,
    METRIC.TRADE_CLOSE,
    METRIC.CIRCUIT_BREAKER_TRIPS,
    METRIC.KILL_SWITCH_BLOCKS,
    METRIC.EXPOSURE_BLOCKS,
    METRIC.RPC_FAILOVER,
    METRIC.CACHE_HIT,
    METRIC.CACHE_MISS,
    METRIC.ERROR_PARSE,
    METRIC.ERROR_RPC,
    METRIC.ERROR_SDK,
  ];

  for (const name of counterOrder) {
    const value = snap.counters[name] ?? 0;
    if (value > 0 || name === METRIC.TRADE_SUCCESS || name === METRIC.TRADE_FAILURE) {
      const label = name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      lines.push(`  ${label}: ${value}`);
    }
  }

  // Histograms
  const histOrder = [METRIC.RPC_LATENCY, METRIC.TX_CONFIRM_TIME, METRIC.COMMAND_LATENCY];
  for (const name of histOrder) {
    const hist = snap.histograms[name];
    if (hist && hist.count > 0) {
      const label = name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      lines.push(`  ${label}: avg=${hist.avg.toFixed(0)}ms p95=${hist.p95.toFixed(0)}ms (n=${hist.count})`);
    }
  }

  const uptimeMin = (snap.uptime_ms / 60000).toFixed(1);
  lines.push(`  Uptime: ${uptimeMin} min`);

  return lines.join('\n');
}
