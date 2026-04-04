/**
 * Tests for shadow-events.ts — shadow observability logging.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    trade: vi.fn(),
  }),
}));

// Mock metrics
const mockIncrement = vi.fn();
const mockRecord = vi.fn();
vi.mock('../src/observability/metrics.js', () => ({
  getMetrics: () => ({
    increment: mockIncrement,
    record: mockRecord,
  }),
}));

import {
  logShadowTrade,
  logShadowDivergence,
  logShadowStateChange,
  SHADOW_METRIC,
} from '../src/observability/shadow-events.js';
import { TradeSide } from '../src/types/index.js';

describe('Shadow Events', () => {
  beforeEach(() => {
    mockIncrement.mockClear();
    mockRecord.mockClear();
  });

  it('logShadowTrade increments success metric on success', () => {
    logShadowTrade({
      action: 'open',
      market: 'SOL',
      side: TradeSide.Long,
      success: true,
      latencyMs: 5,
    });
    expect(mockIncrement).toHaveBeenCalledWith(SHADOW_METRIC.SHADOW_TRADE_SUCCESS);
    expect(mockRecord).toHaveBeenCalledWith(SHADOW_METRIC.SHADOW_LATENCY, 5);
  });

  it('logShadowTrade increments failure metric on failure', () => {
    logShadowTrade({
      action: 'open',
      market: 'SOL',
      side: TradeSide.Long,
      success: false,
      error: 'boom',
      latencyMs: 3,
    });
    expect(mockIncrement).toHaveBeenCalledWith(SHADOW_METRIC.SHADOW_TRADE_FAILURE);
  });

  it('logShadowDivergence increments divergence metric', () => {
    logShadowDivergence({
      type: 'pnl',
      message: 'PnL divergence',
      liveValue: 10,
      shadowValue: 5,
      delta: 5,
      timestamp: new Date().toISOString(),
    });
    expect(mockIncrement).toHaveBeenCalledWith(SHADOW_METRIC.SHADOW_DIVERGENCE);
  });

  it('logShadowStateChange does not throw', () => {
    expect(() => logShadowStateChange(true)).not.toThrow();
    expect(() => logShadowStateChange(false)).not.toThrow();
  });

  it('SHADOW_METRIC contains expected keys', () => {
    expect(SHADOW_METRIC.SHADOW_TRADE_SUCCESS).toBe('shadow_trade_success_total');
    expect(SHADOW_METRIC.SHADOW_TRADE_FAILURE).toBe('shadow_trade_failure_total');
    expect(SHADOW_METRIC.SHADOW_DIVERGENCE).toBe('shadow_divergence_total');
    expect(SHADOW_METRIC.SHADOW_LATENCY).toBe('shadow_latency_ms');
  });

  it('all functions swallow errors gracefully', () => {
    // Even with invalid data, should not throw
    expect(() => logShadowTrade(null as any)).not.toThrow();
    expect(() => logShadowDivergence(null as any)).not.toThrow();
    expect(() => logShadowStateChange(undefined as any)).not.toThrow();
  });
});
