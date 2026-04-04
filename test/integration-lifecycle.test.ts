/**
 * Integration tests — full trade lifecycle.
 *
 * Tests the complete open → hold → close pipeline using SimulatedFlashClient,
 * verifying that PnL, fees, balances, and safety mechanisms interact correctly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SimulatedFlashClient } from '../src/client/simulation.js';
import { CircuitBreaker } from '../src/security/circuit-breaker.js';
import { TradingGate } from '../src/security/trading-gate.js';
import { TradeSide } from '../src/types/index.js';
import type { IFlashClient } from '../src/types/index.js';

// ── Mocks (same as simulation.test.ts for deterministic prices) ──

vi.mock('../src/data/prices.js', () => ({
  PriceService: class {
    async getPrices(symbols: string[]) {
      const prices = new Map<string, { price: number; priceChange24h: number }>();
      const mockPrices: Record<string, number> = { SOL: 150.0, BTC: 60000.0, ETH: 3500.0 };
      for (const sym of symbols) {
        prices.set(sym, { price: mockPrices[sym] ?? 100.0, priceChange24h: 0 });
      }
      return prices;
    }
  },
}));

vi.mock('../src/data/fstats.js', () => ({
  FStatsClient: class { async getOpenPositions() { return []; } },
}));

vi.mock('../src/utils/protocol-fees.js', () => ({
  getProtocolFeeRates: async () => ({
    openFeeRate: 0.0008, closeFeeRate: 0.0008,
    maintenanceMarginRate: 0.01, maxLeverage: 100, source: 'sdk-default' as const,
  }),
  calcFeeUsd: (sizeUsd: number, feeRate: number) => {
    if (!Number.isFinite(sizeUsd) || !Number.isFinite(feeRate) || sizeUsd <= 0 || feeRate <= 0) return 0;
    return sizeUsd * feeRate;
  },
}));

vi.mock('../src/config/index.js', () => ({
  getAllMarkets: () => ['SOL', 'BTC', 'ETH'],
  getMaxLeverage: () => 100,
}));

vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, trade: () => {} }),
}));

describe('Integration: Trade Lifecycle', () => {
  let client: SimulatedFlashClient;

  beforeEach(() => {
    client = new SimulatedFlashClient(10_000);
  });

  // ─── Full Lifecycle ──────────────────────────────────────────────────

  it('open → hold → close preserves accounting integrity', async () => {
    const startBalance = client.getBalance();

    // Open
    const openResult = await client.openPosition('SOL', TradeSide.Long, 200, 5);
    expect(openResult.sizeUsd).toBe(1000);
    // Entry price includes simulated slippage (8 bps)
    expect(openResult.entryPrice).toBeCloseTo(150, 0);

    const afterOpenBalance = client.getBalance();
    const openFee = 1000 * 0.0008; // $0.80
    expect(afterOpenBalance).toBeCloseTo(startBalance - 200 - openFee, 2);

    // Hold — verify position exists
    const positions = await client.getPositions();
    expect(positions.length).toBe(1);
    expect(positions[0].sizeUsd).toBe(1000);
    expect(positions[0].collateralUsd).toBe(200);
    expect(positions[0].leverage).toBeCloseTo(5, 1);

    // Close
    const closeResult = await client.closePosition('SOL', TradeSide.Long);
    expect(closeResult.exitPrice).toBe(150);
    expect(Number.isFinite(closeResult.pnl)).toBe(true);

    // Verify final state
    const closeFee = 1000 * 0.0008;
    const expectedFinal = afterOpenBalance + 200 + closeResult.pnl - closeFee;
    expect(client.getBalance()).toBeCloseTo(expectedFinal, 2);
    expect((await client.getPositions()).length).toBe(0);

    // Trade history
    const history = client.getTradeHistory();
    expect(history.length).toBe(2);
    expect(history[0].action).toBe('open');
    expect(history[1].action).toBe('close');
  });

  it('multiple positions lifecycle', async () => {
    // Open two positions on different markets
    await client.openPosition('SOL', TradeSide.Long, 100, 3);
    await client.openPosition('BTC', TradeSide.Short, 200, 5);

    const positions = await client.getPositions();
    expect(positions.length).toBe(2);

    // Portfolio reflects both
    const portfolio = await client.getPortfolio();
    expect(portfolio.positions.length).toBe(2);
    expect(portfolio.totalCollateralUsd).toBeCloseTo(300, 0);
    expect(portfolio.totalPositionValue).toBeCloseTo(300 + 1000, 0); // 100*3 + 200*5

    // Close both
    await client.closePosition('SOL', TradeSide.Long);
    await client.closePosition('BTC', TradeSide.Short);

    expect((await client.getPositions()).length).toBe(0);
    expect(client.getBalance()).toBeGreaterThan(0);
  });

  it('collateral modification mid-lifecycle', async () => {
    await client.openPosition('SOL', TradeSide.Long, 100, 5);

    // Add collateral — reduces leverage
    await client.addCollateral('SOL', TradeSide.Long, 50);
    const pos1 = (await client.getPositions())[0];
    expect(pos1.collateralUsd).toBeCloseTo(150, 1);
    expect(pos1.leverage).toBeCloseTo(500 / 150, 1);

    // Remove collateral — increases leverage
    await client.removeCollateral('SOL', TradeSide.Long, 30);
    const pos2 = (await client.getPositions())[0];
    expect(pos2.collateralUsd).toBeCloseTo(120, 1);
    expect(pos2.leverage).toBeCloseTo(500 / 120, 1);

    // Close
    await client.closePosition('SOL', TradeSide.Long);
    expect((await client.getPositions()).length).toBe(0);
  });

  // ─── Circuit Breaker Integration ─────────────────────────────────────

  it('circuit breaker trips after cumulative losses', async () => {
    const breaker = new CircuitBreaker({ maxSessionLossUsd: 10 });

    // Simulate trade with loss
    breaker.recordTrade(-5);
    expect(breaker.check().allowed).toBe(true);

    breaker.recordTrade(-8);
    expect(breaker.check().allowed).toBe(false);
    expect(breaker.getState().sessionLossUsd).toBe(13);
    expect(breaker.getState().tripped).toBe(true);
  });

  it('circuit breaker trade count limit with real trades', async () => {
    const breaker = new CircuitBreaker({ maxTradesPerSession: 2 });

    // First trade
    await client.openPosition('SOL', TradeSide.Long, 100, 5);
    breaker.recordOpen();
    expect(breaker.check().allowed).toBe(true);

    // Second trade
    await client.closePosition('SOL', TradeSide.Long);
    breaker.recordOpen();
    expect(breaker.check().allowed).toBe(false);
  });

  // ─── Exposure Control Integration ────────────────────────────────────

  it('exposure limit blocks when total exceeds cap', async () => {
    await client.openPosition('SOL', TradeSide.Long, 100, 5); // $500 exposure

    const gate = new TradingGate({ tradingEnabled: true, maxPortfolioExposure: 800 });
    const check = await gate.checkExposure(500, client as unknown as IFlashClient); // $500 + $500 = $1000 > $800
    expect(check.allowed).toBe(false);
  });

  it('exposure limit allows when under cap', async () => {
    await client.openPosition('SOL', TradeSide.Long, 100, 2); // $200 exposure

    const gate = new TradingGate({ tradingEnabled: true, maxPortfolioExposure: 5000 });
    const check = await gate.checkExposure(500, client as unknown as IFlashClient); // $200 + $500 = $700 < $5000
    expect(check.allowed).toBe(true);
  });

  // ─── Kill Switch Integration ─────────────────────────────────────────

  it('kill switch blocks all operations', () => {
    const gate = new TradingGate({ tradingEnabled: false });

    expect(gate.checkKillSwitch().allowed).toBe(false);

    // Enable at runtime
    gate.enable();
    expect(gate.checkKillSwitch().allowed).toBe(true);

    // Disable again
    gate.disable('market crash');
    expect(gate.checkKillSwitch().allowed).toBe(false);
  });

  // ─── Error Handling ──────────────────────────────────────────────────

  it('duplicate position merges in lifecycle (increaseSize)', async () => {
    await client.openPosition('SOL', TradeSide.Long, 100, 5);
    const result = await client.openPosition('SOL', TradeSide.Long, 50, 3);
    expect(result).toBeDefined();

    // Position should be merged: 500 + 150 = 650
    const pos = (await client.getPositions()).find(p => p.market === 'SOL' && p.side === TradeSide.Long);
    expect(pos).toBeDefined();
    expect(pos!.sizeUsd).toBeCloseTo(650, 0);
  });

  it('close non-existent position rejected', async () => {
    await expect(
      client.closePosition('BTC', TradeSide.Short)
    ).rejects.toThrow(/no open/i);
  });

  it('insufficient balance for second position rejected', async () => {
    await client.openPosition('SOL', TradeSide.Long, 9000, 1.1);
    await expect(
      client.openPosition('BTC', TradeSide.Long, 2000, 2)
    ).rejects.toThrow(/insufficient|balance/i);
  });
});
