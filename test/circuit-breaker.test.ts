/**
 * Behavior-locking tests for CircuitBreaker.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CircuitBreaker } from '../src/security/circuit-breaker.js';

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    trade: () => {},
  }),
}));

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  // ─── Default state ─────────────────────────────────────────────────────

  it('allows trading by default (no limits configured)', () => {
    breaker = new CircuitBreaker();
    expect(breaker.check().allowed).toBe(true);
  });

  it('reports not configured when all limits are 0', () => {
    breaker = new CircuitBreaker({ maxSessionLossUsd: 0, maxDailyLossUsd: 0, maxTradesPerSession: 0 });
    expect(breaker.isConfigured).toBe(false);
  });

  it('reports configured when any limit is set', () => {
    breaker = new CircuitBreaker({ maxSessionLossUsd: 100 });
    expect(breaker.isConfigured).toBe(true);
  });

  // ─── Session loss limit ────────────────────────────────────────────────

  describe('session loss limit', () => {
    beforeEach(() => {
      breaker = new CircuitBreaker({ maxSessionLossUsd: 50 });
    });

    it('allows trading when loss is below limit', () => {
      breaker.recordTrade(-20); // $20 loss
      expect(breaker.check().allowed).toBe(true);
    });

    it('trips when session loss reaches limit', () => {
      breaker.recordTrade(-30);
      breaker.recordTrade(-25); // total $55 > $50
      const check = breaker.check();
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain('Session loss limit');
    });

    it('ignores profitable trades (does not reduce loss count)', () => {
      breaker.recordTrade(-40);
      breaker.recordTrade(100); // profit doesn't offset
      expect(breaker.getState().sessionLossUsd).toBe(40);
    });

    it('stays tripped after manual profit', () => {
      breaker.recordTrade(-60); // trips at $60 > $50
      breaker.recordTrade(1000); // profit doesn't un-trip
      expect(breaker.check().allowed).toBe(false);
    });
  });

  // ─── Daily loss limit ─────────────────────────────────────────────────

  describe('daily loss limit', () => {
    beforeEach(() => {
      breaker = new CircuitBreaker({ maxDailyLossUsd: 100 });
    });

    it('allows trading when daily loss is below limit', () => {
      breaker.recordTrade(-50);
      expect(breaker.check().allowed).toBe(true);
    });

    it('trips when daily loss reaches limit', () => {
      breaker.recordTrade(-60);
      breaker.recordTrade(-50); // total $110 > $100
      const check = breaker.check();
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain('Daily loss limit');
    });
  });

  // ─── Trade count limit ────────────────────────────────────────────────

  describe('trade count limit', () => {
    beforeEach(() => {
      breaker = new CircuitBreaker({ maxTradesPerSession: 3 });
    });

    it('allows trading when count is below limit', () => {
      breaker.recordOpen();
      breaker.recordOpen();
      expect(breaker.check().allowed).toBe(true);
    });

    it('trips when trade count reaches limit', () => {
      breaker.recordOpen();
      breaker.recordOpen();
      breaker.recordOpen(); // 3 >= 3, trips
      expect(breaker.check().allowed).toBe(false);
      expect(breaker.check().reason).toContain('trade limit');
    });

    it('recordTrade also increments count', () => {
      breaker.recordTrade(10);
      breaker.recordTrade(10);
      breaker.recordTrade(10); // 3 trades
      expect(breaker.check().allowed).toBe(false);
    });
  });

  // ─── Manual reset ─────────────────────────────────────────────────────

  it('reset clears tripped state', () => {
    breaker = new CircuitBreaker({ maxSessionLossUsd: 10 });
    breaker.recordTrade(-20);
    expect(breaker.check().allowed).toBe(false);

    breaker.reset();
    expect(breaker.check().allowed).toBe(true);
  });

  // ─── State snapshot ───────────────────────────────────────────────────

  it('getState returns a read-only snapshot', () => {
    breaker = new CircuitBreaker({ maxSessionLossUsd: 100 });
    breaker.recordTrade(-25);
    breaker.recordOpen();

    const state = breaker.getState();
    expect(state.sessionLossUsd).toBe(25);
    expect(state.sessionTradeCount).toBe(2); // recordTrade + recordOpen
    expect(state.tripped).toBe(false);
    expect(state.currentDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('getConfig returns configuration', () => {
    breaker = new CircuitBreaker({ maxSessionLossUsd: 42, maxDailyLossUsd: 99 });
    const config = breaker.getConfig();
    expect(config.maxSessionLossUsd).toBe(42);
    expect(config.maxDailyLossUsd).toBe(99);
    expect(config.maxTradesPerSession).toBe(0);
  });

  // ─── Edge cases ───────────────────────────────────────────────────────

  it('handles NaN pnl gracefully', () => {
    breaker = new CircuitBreaker({ maxSessionLossUsd: 100 });
    breaker.recordTrade(NaN);
    expect(breaker.getState().sessionLossUsd).toBe(0);
    expect(breaker.getState().sessionTradeCount).toBe(1);
  });

  it('handles Infinity pnl gracefully', () => {
    breaker = new CircuitBreaker({ maxSessionLossUsd: 100 });
    breaker.recordTrade(-Infinity);
    expect(breaker.getState().sessionLossUsd).toBe(0);
  });

  it('handles zero pnl', () => {
    breaker = new CircuitBreaker({ maxSessionLossUsd: 100 });
    breaker.recordTrade(0);
    expect(breaker.getState().sessionLossUsd).toBe(0);
    expect(breaker.getState().sessionTradeCount).toBe(1);
  });
});
