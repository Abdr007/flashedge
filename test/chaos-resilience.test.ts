/**
 * Chaos & Failure Resilience Tests
 *
 * Simulates partial failures and degraded conditions to verify
 * the system degrades safely without data corruption.
 */

import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker } from '../src/security/circuit-breaker.js';
import { TradingGate } from '../src/security/trading-gate.js';
import type { IFlashClient } from '../src/types/index.js';

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, trade: () => {} }),
}));

describe('Chaos: Circuit Breaker Under Stress', () => {
  it('handles rapid successive losses correctly', () => {
    const breaker = new CircuitBreaker({ maxSessionLossUsd: 100 });

    // Simulate 50 rapid losing trades at $1.50 each = $75 (under limit)
    for (let i = 0; i < 50; i++) {
      breaker.recordTrade(-1.5);
    }
    expect(breaker.check().allowed).toBe(true);
    expect(breaker.getState().sessionLossUsd).toBe(75);

    // 20 more trades: total $105 > $100 → trips
    for (let i = 0; i < 20; i++) {
      breaker.recordTrade(-1.5);
    }
    expect(breaker.check().allowed).toBe(false);
    expect(breaker.getState().sessionLossUsd).toBe(105);
    expect(breaker.getState().sessionTradeCount).toBe(70);
  });

  it('handles mixed profit/loss without false trips', () => {
    const breaker = new CircuitBreaker({ maxSessionLossUsd: 100 });

    // Alternate wins and losses
    for (let i = 0; i < 30; i++) {
      breaker.recordTrade(i % 2 === 0 ? -5 : 50); // -5 every other trade
    }

    // Total losses: 15 * 5 = 75, under $100 limit
    expect(breaker.check().allowed).toBe(true);
    expect(breaker.getState().sessionLossUsd).toBe(75);
  });

  it('concurrent trade count limit under rapid fire', () => {
    const breaker = new CircuitBreaker({ maxTradesPerSession: 10 });

    for (let i = 0; i < 15; i++) {
      breaker.recordOpen();
    }

    expect(breaker.check().allowed).toBe(false);
    expect(breaker.getState().sessionTradeCount).toBe(15);
  });

  it('remains tripped after reset boundary values', () => {
    const breaker = new CircuitBreaker({ maxSessionLossUsd: 50 });
    breaker.recordTrade(-50); // exactly at limit
    expect(breaker.check().allowed).toBe(false);

    breaker.reset();
    expect(breaker.check().allowed).toBe(true);
    expect(breaker.getState().sessionLossUsd).toBe(0);
  });
});

describe('Chaos: Trading Gate Under RPC Failures', () => {
  it('fails open when getPositions throws', async () => {
    const gate = new TradingGate({ tradingEnabled: true, maxPortfolioExposure: 10000 });
    const failingClient = {
      getPositions: async () => { throw new Error('Connection reset'); },
    } as unknown as IFlashClient;

    // Should allow trade despite RPC failure (fail-open)
    const check = await gate.checkExposure(50000, failingClient);
    expect(check.allowed).toBe(true);
  });

  it('fails open when getPositions returns after delay', async () => {
    const gate = new TradingGate({ tradingEnabled: true, maxPortfolioExposure: 10000 });
    const slowClient = {
      getPositions: () => new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Timeout')), 50);
      }),
    } as unknown as IFlashClient;

    const check = await gate.checkExposure(5000, slowClient);
    expect(check.allowed).toBe(true);
  });

  it('handles positions with missing sizeUsd', async () => {
    const gate = new TradingGate({ tradingEnabled: true, maxPortfolioExposure: 10000 });
    const brokenClient = {
      getPositions: async () => [
        { sizeUsd: undefined },
        { sizeUsd: null },
        { sizeUsd: NaN },
        { sizeUsd: 5000 },
      ],
    } as unknown as IFlashClient;

    // Should sum only valid sizeUsd values
    const check = await gate.checkExposure(6000, brokenClient);
    // 0 + 0 + NaN(→0) + 5000 + 6000 = 11000 > 10000
    expect(check.allowed).toBe(false);
  });

  it('kill switch survives rapid enable/disable toggling', () => {
    const gate = new TradingGate({ tradingEnabled: true });

    for (let i = 0; i < 100; i++) {
      gate.disable();
      gate.enable();
    }

    expect(gate.tradingEnabled).toBe(true);
    expect(gate.checkKillSwitch().allowed).toBe(true);

    gate.disable();
    expect(gate.tradingEnabled).toBe(false);
    expect(gate.checkKillSwitch().allowed).toBe(false);
  });
});

describe('Chaos: Combined Safety Mechanisms', () => {
  it('all three gates reject independently', async () => {
    // Kill switch off
    const gate1 = new TradingGate({ tradingEnabled: false });
    expect(gate1.checkKillSwitch().allowed).toBe(false);

    // Exposure over limit
    const gate2 = new TradingGate({ tradingEnabled: true, maxPortfolioExposure: 100 });
    const bigClient = {
      getPositions: async () => [{ sizeUsd: 90 }],
    } as unknown as IFlashClient;
    expect((await gate2.checkExposure(20, bigClient)).allowed).toBe(false);

    // Circuit breaker tripped
    const breaker = new CircuitBreaker({ maxSessionLossUsd: 10 });
    breaker.recordTrade(-15);
    expect(breaker.check().allowed).toBe(false);
  });

  it('system recovers after all gates reset', async () => {
    // Kill switch recovery
    const gate = new TradingGate({ tradingEnabled: false });
    gate.enable();
    expect(gate.checkKillSwitch().allowed).toBe(true);

    // Circuit breaker recovery
    const breaker = new CircuitBreaker({ maxSessionLossUsd: 10 });
    breaker.recordTrade(-15);
    expect(breaker.check().allowed).toBe(false);
    breaker.reset();
    expect(breaker.check().allowed).toBe(true);

    // Exposure recovery (new trade under limit)
    const gate2 = new TradingGate({ tradingEnabled: true, maxPortfolioExposure: 10000 });
    const emptyClient = {
      getPositions: async () => [],
    } as unknown as IFlashClient;
    expect((await gate2.checkExposure(5000, emptyClient)).allowed).toBe(true);
  });

  it('rapid state transitions do not corrupt', () => {
    const breaker = new CircuitBreaker({
      maxSessionLossUsd: 100,
      maxDailyLossUsd: 200,
      maxTradesPerSession: 50,
    });

    // Rapid fire: mix of opens, losses, profits, resets
    for (let i = 0; i < 20; i++) {
      breaker.recordOpen();
      breaker.recordTrade(-3);
      breaker.recordTrade(10);
    }

    const state = breaker.getState();
    expect(state.sessionTradeCount).toBe(60); // 20 opens + 40 recordTrade calls
    expect(state.sessionLossUsd).toBe(60); // 20 * 3
    expect(Number.isFinite(state.sessionLossUsd)).toBe(true);
    expect(Number.isFinite(state.dailyLossUsd)).toBe(true);
  });
});

describe('Chaos: Edge Cases in Position Data', () => {
  it('exposure check with empty position array', async () => {
    const gate = new TradingGate({ tradingEnabled: true, maxPortfolioExposure: 1000 });
    const emptyClient = {
      getPositions: async () => [],
    } as unknown as IFlashClient;

    const check = await gate.checkExposure(500, emptyClient);
    expect(check.allowed).toBe(true);
  });

  it('exposure check with zero-size positions', async () => {
    const gate = new TradingGate({ tradingEnabled: true, maxPortfolioExposure: 1000 });
    const zeroClient = {
      getPositions: async () => [
        { sizeUsd: 0 },
        { sizeUsd: 0 },
      ],
    } as unknown as IFlashClient;

    const check = await gate.checkExposure(500, zeroClient);
    expect(check.allowed).toBe(true);
  });

  it('circuit breaker with exact boundary value', () => {
    const breaker = new CircuitBreaker({ maxSessionLossUsd: 100 });
    breaker.recordTrade(-100); // exactly at limit
    expect(breaker.check().allowed).toBe(false);
  });

  it('circuit breaker with sub-cent losses', () => {
    const breaker = new CircuitBreaker({ maxSessionLossUsd: 1 });
    for (let i = 0; i < 200; i++) {
      breaker.recordTrade(-0.005); // half cent
    }
    // Total: $1.00 exactly
    expect(breaker.getState().sessionLossUsd).toBeCloseTo(1.0, 2);
    expect(breaker.check().allowed).toBe(false);
  });
});
