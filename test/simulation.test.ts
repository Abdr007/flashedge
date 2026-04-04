/**
 * Behavior-locking tests for SimulatedFlashClient.
 *
 * These tests verify the financial logic is correct and lock behavior
 * so that refactoring cannot silently alter PnL, fees, or balances.
 *
 * Uses a mock price service to ensure deterministic results.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SimulatedFlashClient } from '../src/client/simulation.js';
import { TradeSide } from '../src/types/index.js';

// Mock PriceService to return deterministic prices
vi.mock('../src/data/prices.js', () => ({
  PriceService: class {
    async getPrices(symbols: string[]) {
      const prices = new Map<string, { price: number; priceChange24h: number }>();
      const mockPrices: Record<string, number> = {
        SOL: 150.0,
        BTC: 60000.0,
        ETH: 3500.0,
      };
      for (const sym of symbols) {
        const price = mockPrices[sym] ?? 100.0;
        prices.set(sym, { price, priceChange24h: 0 });
      }
      return prices;
    }
  },
}));

// Mock fstats client
vi.mock('../src/data/fstats.js', () => ({
  FStatsClient: class {
    async getOpenPositions() { return []; }
  },
}));

// Mock protocol fees — use deterministic values
vi.mock('../src/utils/protocol-fees.js', () => ({
  getProtocolFeeRates: async () => ({
    openFeeRate: 0.0008,
    closeFeeRate: 0.0008,
    maintenanceMarginRate: 0.01,
    maxLeverage: 100,
    source: 'sdk-default' as const,
  }),
  calcFeeUsd: (sizeUsd: number, feeRate: number) => {
    if (!Number.isFinite(sizeUsd) || !Number.isFinite(feeRate) || sizeUsd <= 0 || feeRate <= 0) return 0;
    return sizeUsd * feeRate;
  },
}));

// Mock config
vi.mock('../src/config/index.js', () => ({
  getAllMarkets: () => ['SOL', 'BTC', 'ETH'],
  getMaxLeverage: () => 100,
}));

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    trade: () => {},
  }),
}));

describe('SimulatedFlashClient', () => {
  let client: SimulatedFlashClient;

  beforeEach(() => {
    client = new SimulatedFlashClient(10_000);
  });

  // ─── Balance & Initialization ──────────────────────────────────────────

  it('initializes with correct balance', () => {
    expect(client.getBalance()).toBe(10_000);
  });

  it('generates SIM_ wallet address', () => {
    expect(client.walletAddress).toMatch(/^SIM_/);
  });

  // ─── Open Position ────────────────────────────────────────────────────

  it('opens a long position with correct size calculation', async () => {
    const result = await client.openPosition('SOL', TradeSide.Long, 100, 5);

    expect(result.txSignature).toMatch(/^SIM_/);
    expect(result.sizeUsd).toBe(500); // collateral * leverage
    // Entry price includes simulated slippage (8 bps worse for longs)
    expect(result.entryPrice).toBeCloseTo(150.0, 0);
    expect(result.liquidationPrice).toBeGreaterThan(0);
  });

  it('deducts collateral + fee from balance on open', async () => {
    await client.openPosition('SOL', TradeSide.Long, 100, 5);

    const sizeUsd = 100 * 5; // 500
    const fee = sizeUsd * 0.0008; // 0.40
    const expectedBalance = 10_000 - 100 - fee;

    expect(client.getBalance()).toBeCloseTo(expectedBalance, 2);
  });

  it('merges duplicate position on same market/side (increaseSize)', async () => {
    await client.openPosition('SOL', TradeSide.Long, 100, 5);
    const result = await client.openPosition('SOL', TradeSide.Long, 50, 3);

    // Position should be merged, not rejected
    expect(result).toBeDefined();
    expect(result.txSignature).toContain('SIM_');
    const positions = await client.getPositions();
    const solLong = positions.find(p => p.market === 'SOL' && p.side === TradeSide.Long);
    expect(solLong).toBeDefined();
    // Merged: 100*5=500 + 50*3=150 = 650 total size
    expect(solLong!.sizeUsd).toBeCloseTo(650, 0);
  });

  it('allows opposite side on same market', async () => {
    await client.openPosition('SOL', TradeSide.Long, 100, 5);

    await expect(
      client.openPosition('SOL', TradeSide.Short, 50, 3)
    ).resolves.toBeDefined();
  });

  it('rejects collateral exceeding balance', async () => {
    await expect(
      client.openPosition('SOL', TradeSide.Long, 20_000, 2)
    ).rejects.toThrow(/insufficient|balance/i);
  });

  // ─── Close Position ───────────────────────────────────────────────────

  it('closes position and returns collateral + PnL - fee', async () => {
    await client.openPosition('SOL', TradeSide.Long, 100, 5);
    const balanceAfterOpen = client.getBalance();

    const result = await client.closePosition('SOL', TradeSide.Long);

    expect(result.txSignature).toMatch(/^SIM_CLOSE_/);
    expect(result.exitPrice).toBe(150.0);
    expect(Number.isFinite(result.pnl)).toBe(true);

    // Balance should be: balanceAfterOpen + collateral + pnl - closeFee
    const closeFee = 500 * 0.0008;
    const expectedBalance = balanceAfterOpen + 100 + result.pnl - closeFee;
    expect(client.getBalance()).toBeCloseTo(expectedBalance, 2);
  });

  it('removes position from list after close', async () => {
    await client.openPosition('SOL', TradeSide.Long, 100, 5);
    expect((await client.getPositions()).length).toBe(1);

    await client.closePosition('SOL', TradeSide.Long);
    expect((await client.getPositions()).length).toBe(0);
  });

  it('rejects closing non-existent position', async () => {
    await expect(
      client.closePosition('SOL', TradeSide.Long)
    ).rejects.toThrow(/no open/i);
  });

  // ─── PnL Formula ──────────────────────────────────────────────────────

  it('calculates correct PnL for long (entry == mark)', async () => {
    await client.openPosition('SOL', TradeSide.Long, 100, 5);
    const positions = await client.getPositions();
    const pos = positions[0];

    // When entry == mark, PnL should be ~0
    const expectedPnl = ((pos.markPrice - pos.entryPrice) / pos.entryPrice) * pos.sizeUsd;
    expect(pos.unrealizedPnl).toBeCloseTo(expectedPnl, 4);
  });

  it('calculates correct PnL % relative to collateral', async () => {
    await client.openPosition('SOL', TradeSide.Long, 100, 5);
    const positions = await client.getPositions();
    const pos = positions[0];

    const expectedPnlPct = (pos.unrealizedPnl / pos.collateralUsd) * 100;
    expect(pos.unrealizedPnlPercent).toBeCloseTo(expectedPnlPct, 2);
  });

  // ─── Collateral Management ────────────────────────────────────────────

  it('adds collateral and reduces leverage', async () => {
    await client.openPosition('SOL', TradeSide.Long, 100, 5);
    const balanceBefore = client.getBalance();

    const result = await client.addCollateral('SOL', TradeSide.Long, 50);

    expect(result.txSignature).toMatch(/^SIM_ADD_/);
    expect(client.getBalance()).toBeCloseTo(balanceBefore - 50, 2);

    const positions = await client.getPositions();
    expect(positions[0].collateralUsd).toBeCloseTo(150, 2);
    // Leverage: 500 / 150 ≈ 3.33
    expect(positions[0].leverage).toBeCloseTo(500 / 150, 1);
  });

  it('removes collateral and increases leverage', async () => {
    await client.openPosition('SOL', TradeSide.Long, 100, 5);
    const balanceBefore = client.getBalance();

    const result = await client.removeCollateral('SOL', TradeSide.Long, 20);

    expect(result.txSignature).toMatch(/^SIM_RM_/);
    expect(client.getBalance()).toBeCloseTo(balanceBefore + 20, 2);

    const positions = await client.getPositions();
    expect(positions[0].collateralUsd).toBeCloseTo(80, 2);
    // Leverage: 500 / 80 = 6.25
    expect(positions[0].leverage).toBeCloseTo(500 / 80, 1);
  });

  it('rejects removing all collateral', async () => {
    await client.openPosition('SOL', TradeSide.Long, 100, 5);

    await expect(
      client.removeCollateral('SOL', TradeSide.Long, 100)
    ).rejects.toThrow(/cannot remove all/i);
  });

  it('rejects adding more collateral than balance', async () => {
    await client.openPosition('SOL', TradeSide.Long, 100, 5);

    await expect(
      client.addCollateral('SOL', TradeSide.Long, 50_000)
    ).rejects.toThrow(/insufficient/i);
  });

  // ─── Portfolio ────────────────────────────────────────────────────────

  it('returns correct portfolio summary', async () => {
    await client.openPosition('SOL', TradeSide.Long, 100, 5);

    const portfolio = await client.getPortfolio();

    expect(portfolio.positions.length).toBe(1);
    expect(portfolio.totalCollateralUsd).toBeCloseTo(100, 2);
    expect(portfolio.totalPositionValue).toBeCloseTo(500, 2);
    expect(Number.isFinite(portfolio.totalUnrealizedPnl)).toBe(true);
    expect(portfolio.totalFees).toBeGreaterThan(0);
  });

  it('tracks realized PnL across closes', async () => {
    await client.openPosition('SOL', TradeSide.Long, 100, 5);
    const closeResult = await client.closePosition('SOL', TradeSide.Long);

    const portfolio = await client.getPortfolio();
    expect(portfolio.totalRealizedPnl).toBeCloseTo(closeResult.pnl, 4);
  });

  // ─── Trade History ────────────────────────────────────────────────────

  it('records trades in history', async () => {
    await client.openPosition('SOL', TradeSide.Long, 100, 5);
    await client.closePosition('SOL', TradeSide.Long);

    const history = client.getTradeHistory();
    expect(history.length).toBe(2);
    expect(history[0].action).toBe('open');
    expect(history[1].action).toBe('close');
  });

  // ─── Safety Guards ────────────────────────────────────────────────────

  it('all position fields are finite numbers', async () => {
    await client.openPosition('SOL', TradeSide.Long, 100, 5);
    const positions = await client.getPositions();
    const pos = positions[0];

    expect(Number.isFinite(pos.entryPrice)).toBe(true);
    expect(Number.isFinite(pos.markPrice)).toBe(true);
    expect(Number.isFinite(pos.sizeUsd)).toBe(true);
    expect(Number.isFinite(pos.collateralUsd)).toBe(true);
    expect(Number.isFinite(pos.leverage)).toBe(true);
    expect(Number.isFinite(pos.unrealizedPnl)).toBe(true);
    expect(Number.isFinite(pos.unrealizedPnlPercent)).toBe(true);
    expect(Number.isFinite(pos.liquidationPrice)).toBe(true);
    expect(Number.isFinite(pos.openFee)).toBe(true);
    expect(Number.isFinite(pos.totalFees)).toBe(true);
  });

  it('balance never goes negative', async () => {
    // Open position using most of the balance (min leverage 1.1x for SOL)
    await client.openPosition('SOL', TradeSide.Long, 9000, 1.1);
    await client.closePosition('SOL', TradeSide.Long);

    expect(client.getBalance()).toBeGreaterThanOrEqual(0);
  });

  // ─── Short Position ───────────────────────────────────────────────────

  it('opens and closes short position correctly', async () => {
    const result = await client.openPosition('SOL', TradeSide.Short, 100, 3);

    expect(result.sizeUsd).toBe(300);

    const positions = await client.getPositions();
    expect(positions[0].side).toBe(TradeSide.Short);

    // Short PnL formula: (entry - mark) / entry * size
    const pos = positions[0];
    const expectedPnl = ((pos.entryPrice - pos.markPrice) / pos.entryPrice) * pos.sizeUsd;
    expect(pos.unrealizedPnl).toBeCloseTo(expectedPnl, 4);

    await client.closePosition('SOL', TradeSide.Short);
    expect((await client.getPositions()).length).toBe(0);
  });
});
