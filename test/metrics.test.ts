/**
 * Tests for the operational metrics collector.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsCollector, METRIC } from '../src/observability/metrics.js';

describe('MetricsCollector', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = new MetricsCollector();
  });

  // ─── Counters ──────────────────────────────────────────────────────────

  it('starts counters at zero', () => {
    expect(metrics.getCounter('foo')).toBe(0);
  });

  it('increments counter by 1', () => {
    metrics.increment('foo');
    expect(metrics.getCounter('foo')).toBe(1);
  });

  it('increments counter by custom amount', () => {
    metrics.increment('foo', 5);
    expect(metrics.getCounter('foo')).toBe(5);
  });

  it('accumulates increments', () => {
    metrics.increment('foo');
    metrics.increment('foo');
    metrics.increment('foo', 3);
    expect(metrics.getCounter('foo')).toBe(5);
  });

  it('tracks multiple counters independently', () => {
    metrics.increment('a');
    metrics.increment('b', 10);
    expect(metrics.getCounter('a')).toBe(1);
    expect(metrics.getCounter('b')).toBe(10);
  });

  // ─── Histograms ────────────────────────────────────────────────────────

  it('returns empty histogram for unrecorded metric', () => {
    const snap = metrics.getHistogram('latency');
    expect(snap.count).toBe(0);
    expect(snap.sum).toBe(0);
  });

  it('records histogram values correctly', () => {
    metrics.record('latency', 100);
    metrics.record('latency', 200);
    metrics.record('latency', 300);
    const snap = metrics.getHistogram('latency');
    expect(snap.count).toBe(3);
    expect(snap.sum).toBe(600);
    expect(snap.min).toBe(100);
    expect(snap.max).toBe(300);
    expect(snap.avg).toBe(200);
  });

  it('computes percentiles', () => {
    for (let i = 1; i <= 100; i++) {
      metrics.record('latency', i);
    }
    const snap = metrics.getHistogram('latency');
    expect(snap.p50).toBe(51);
    expect(snap.p95).toBe(96);
    expect(snap.p99).toBe(100);
  });

  it('ignores NaN and Infinity', () => {
    metrics.record('latency', NaN);
    metrics.record('latency', Infinity);
    metrics.record('latency', 100);
    expect(metrics.getHistogram('latency').count).toBe(1);
  });

  it('bounds histogram to MAX_HISTOGRAM_SAMPLES', () => {
    for (let i = 0; i < 1500; i++) {
      metrics.record('latency', i);
    }
    expect(metrics.getHistogram('latency').count).toBe(1000);
  });

  // ─── Snapshot ──────────────────────────────────────────────────────────

  it('exports full snapshot', () => {
    metrics.increment(METRIC.TRADE_SUCCESS, 3);
    metrics.record(METRIC.RPC_LATENCY, 150);

    const snap = metrics.snapshot();
    expect(snap.counters[METRIC.TRADE_SUCCESS]).toBe(3);
    expect(snap.histograms[METRIC.RPC_LATENCY].count).toBe(1);
    expect(snap.uptime_ms).toBeGreaterThanOrEqual(0);
    expect(snap.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // ─── Reset ─────────────────────────────────────────────────────────────

  it('reset clears all data', () => {
    metrics.increment('foo', 10);
    metrics.record('bar', 500);
    metrics.reset();

    expect(metrics.getCounter('foo')).toBe(0);
    expect(metrics.getHistogram('bar').count).toBe(0);
  });

  // ─── Well-Known Metric Names ───────────────────────────────────────────

  it('METRIC constants are unique strings', () => {
    const values = Object.values(METRIC);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});
