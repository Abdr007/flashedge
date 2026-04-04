/**
 * Tests for metrics export formats (Prometheus, Datadog, JSON, CLI).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsCollector, METRIC } from '../src/observability/metrics.js';
import { toPrometheus, toDatadog, toJSON, formatMetricsSummary } from '../src/observability/metrics-export.js';

// We need to seed the singleton for export functions
import { resetMetrics, getMetrics } from '../src/observability/metrics.js';

describe('Metrics Export', () => {
  beforeEach(() => {
    resetMetrics();
  });

  describe('Prometheus format', () => {
    it('exports empty metrics', () => {
      const output = toPrometheus();
      expect(output).toContain('flash_uptime_ms');
    });

    it('exports counters', () => {
      getMetrics().increment(METRIC.TRADE_SUCCESS, 5);
      const output = toPrometheus();
      expect(output).toContain('# TYPE trade_success_total counter');
      expect(output).toContain('trade_success_total 5');
    });

    it('exports histograms as summaries', () => {
      getMetrics().record(METRIC.RPC_LATENCY, 100);
      getMetrics().record(METRIC.RPC_LATENCY, 200);
      const output = toPrometheus();
      expect(output).toContain('rpc_latency_ms_count 2');
      expect(output).toContain('rpc_latency_ms_sum');
      expect(output).toContain('quantile="0.95"');
    });
  });

  describe('Datadog format', () => {
    it('exports as series array', () => {
      getMetrics().increment(METRIC.TRADE_FAILURE, 3);
      const output = toDatadog(['env:prod']);
      expect(output.series.length).toBeGreaterThan(0);
      const metric = output.series.find(s => s.metric === 'flash.trade_failure_total');
      expect(metric).toBeDefined();
      expect(metric!.points[0][1]).toBe(3);
      expect(metric!.tags).toEqual(['env:prod']);
    });

    it('includes histogram avg and p95', () => {
      for (let i = 0; i < 10; i++) getMetrics().record(METRIC.TX_CONFIRM_TIME, 100 + i * 10);
      const output = toDatadog();
      const avg = output.series.find(s => s.metric === 'flash.transaction_confirmation_time_ms.avg');
      expect(avg).toBeDefined();
      const p95 = output.series.find(s => s.metric === 'flash.transaction_confirmation_time_ms.p95');
      expect(p95).toBeDefined();
    });
  });

  describe('JSON format', () => {
    it('exports valid JSON', () => {
      getMetrics().increment(METRIC.TRADE_OPEN, 2);
      const json = toJSON();
      const parsed = JSON.parse(json);
      expect(parsed.counters.trade_open_total).toBe(2);
      expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('compact mode works', () => {
      const json = toJSON(false);
      expect(json).not.toContain('\n');
    });
  });

  describe('CLI summary', () => {
    it('formats readable output', () => {
      getMetrics().increment(METRIC.TRADE_SUCCESS, 10);
      getMetrics().increment(METRIC.TRADE_FAILURE, 1);
      getMetrics().record(METRIC.RPC_LATENCY, 150);
      const output = formatMetricsSummary();
      expect(output).toContain('Operational Metrics');
      expect(output).toContain('Uptime');
    });
  });
});
