/**
 * Behavior-locking tests for RiskMonitor.
 *
 * Tests the risk classification logic, hysteresis, and collateral suggestions
 * using a mock client with controlled position data.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RiskMonitor, RiskLevel } from '../src/monitor/risk-monitor.js';
import type { IFlashClient, Position, MarketData, Portfolio, OpenPositionResult, ClosePositionResult, CollateralResult, DryRunPreview } from '../src/types/index.js';
import { TradeSide } from '../src/types/index.js';

// Mock protocol fees
vi.mock('../src/utils/protocol-fees.js', () => ({
  getProtocolFeeRates: async () => ({
    openFeeRate: 0.0008,
    closeFeeRate: 0.0008,
    maintenanceMarginRate: 0.01,
    maxLeverage: 100,
    source: 'sdk-default' as const,
  }),
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

// Suppress console output from risk monitor alerts
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    pubkey: 'test-pubkey',
    market: 'SOL',
    side: TradeSide.Long,
    entryPrice: 150,
    currentPrice: 145,
    markPrice: 145,
    sizeUsd: 500,
    collateralUsd: 100,
    leverage: 5,
    unrealizedPnl: -16.67,
    unrealizedPnlPercent: -16.67,
    liquidationPrice: 125,
    openFee: 0.4,
    totalFees: 0.4,
    fundingRate: 0,
    timestamp: Date.now() / 1000,
    ...overrides,
  };
}

function makeMockClient(positions: Position[] = []): IFlashClient {
  return {
    walletAddress: 'mock-wallet',
    getPositions: async () => positions,
    getMarketData: async () => [],
    getPortfolio: async () => ({
      walletAddress: 'mock-wallet',
      balance: 10000,
      balanceLabel: 'Balance: $10000.00',
      totalCollateralUsd: 0,
      totalUnrealizedPnl: 0,
      totalRealizedPnl: 0,
      totalFees: 0,
      positions: [],
      totalPositionValue: 0,
      usdcBalance: 10000,
    }),
    openPosition: async () => ({ txSignature: '', entryPrice: 0, liquidationPrice: 0, sizeUsd: 0 }),
    closePosition: async () => ({ txSignature: '', exitPrice: 0, pnl: 0 }),
    addCollateral: async () => ({ txSignature: '' }),
    removeCollateral: async () => ({ txSignature: '' }),
    previewOpenPosition: async () => ({
      market: '', side: TradeSide.Long, collateral: 0, leverage: 0,
      positionSize: 0, entryPrice: 0, liquidationPrice: 0, estimatedFee: 0,
    }),
    getBalance: () => 10000,
  };
}

describe('RiskMonitor', () => {

  describe('Risk Classification with Hysteresis', () => {

    it('classifies SAFE when distance > 35%', () => {
      // Access private method via prototype for unit testing
      const monitor = new RiskMonitor(makeMockClient());
      const classify = (monitor as any).classifyRiskWithHysteresis.bind(monitor);

      expect(classify(0.40, RiskLevel.Safe)).toBe(RiskLevel.Safe);
      expect(classify(0.50, RiskLevel.Safe)).toBe(RiskLevel.Safe);
      expect(classify(1.0, RiskLevel.Safe)).toBe(RiskLevel.Safe);
    });

    it('enters WARNING from SAFE when distance < 30%', () => {
      const monitor = new RiskMonitor(makeMockClient());
      const classify = (monitor as any).classifyRiskWithHysteresis.bind(monitor);

      expect(classify(0.29, RiskLevel.Safe)).toBe(RiskLevel.Warning);
      expect(classify(0.20, RiskLevel.Safe)).toBe(RiskLevel.Warning);
    });

    it('enters CRITICAL from SAFE when distance < 15%', () => {
      const monitor = new RiskMonitor(makeMockClient());
      const classify = (monitor as any).classifyRiskWithHysteresis.bind(monitor);

      expect(classify(0.14, RiskLevel.Safe)).toBe(RiskLevel.Critical);
      expect(classify(0.05, RiskLevel.Safe)).toBe(RiskLevel.Critical);
    });

    it('recovers from WARNING to SAFE only when distance > 35% (hysteresis gap)', () => {
      const monitor = new RiskMonitor(makeMockClient());
      const classify = (monitor as any).classifyRiskWithHysteresis.bind(monitor);

      // At 31% — entered WARNING, should NOT recover to SAFE yet
      expect(classify(0.31, RiskLevel.Warning)).toBe(RiskLevel.Warning);
      // At 34% — still in hysteresis gap
      expect(classify(0.34, RiskLevel.Warning)).toBe(RiskLevel.Warning);
      // At 36% — past recovery threshold
      expect(classify(0.36, RiskLevel.Warning)).toBe(RiskLevel.Safe);
    });

    it('recovers from CRITICAL to WARNING at > 18%', () => {
      const monitor = new RiskMonitor(makeMockClient());
      const classify = (monitor as any).classifyRiskWithHysteresis.bind(monitor);

      // At 16% — still CRITICAL
      expect(classify(0.16, RiskLevel.Critical)).toBe(RiskLevel.Critical);
      // At 19% — recovers to WARNING
      expect(classify(0.19, RiskLevel.Critical)).toBe(RiskLevel.Warning);
    });

    it('recovers from CRITICAL directly to SAFE at > 35%', () => {
      const monitor = new RiskMonitor(makeMockClient());
      const classify = (monitor as any).classifyRiskWithHysteresis.bind(monitor);

      expect(classify(0.40, RiskLevel.Critical)).toBe(RiskLevel.Safe);
    });
  });

  describe('Position Assessment', () => {

    it('calculates distance to liquidation correctly', async () => {
      const pos = makePosition({
        markPrice: 140,
        entryPrice: 150,
        liquidationPrice: 125,
      });

      const monitor = new RiskMonitor(makeMockClient([pos]));
      const assessed = await (monitor as any).assessPosition(pos);

      // distance = |currentPrice - liqPrice| / entryPrice = |140 - 125| / 150 = 0.10
      expect(assessed.distanceToLiquidation).toBeCloseTo(0.10, 2);
    });

    it('clamps distance between 0 and 1', async () => {
      const pos = makePosition({
        markPrice: 200,
        entryPrice: 150,
        liquidationPrice: 50,
      });

      const monitor = new RiskMonitor(makeMockClient([pos]));
      const assessed = await (monitor as any).assessPosition(pos);

      // distance = |200 - 50| / 150 = 1.0 — clamped to 1.0
      expect(assessed.distanceToLiquidation).toBeLessThanOrEqual(1);
      expect(assessed.distanceToLiquidation).toBeGreaterThanOrEqual(0);
    });

    it('handles zero liquidation price gracefully', async () => {
      const pos = makePosition({ liquidationPrice: 0 });

      const monitor = new RiskMonitor(makeMockClient([pos]));
      const assessed = await (monitor as any).assessPosition(pos);

      expect(assessed.distanceToLiquidation).toBe(1); // default safe
    });
  });

  describe('Start / Stop', () => {

    it('starts and reports active', () => {
      const monitor = new RiskMonitor(makeMockClient());
      const msg = monitor.start();

      expect(monitor.active).toBe(true);
      expect(msg).toContain('started');

      monitor.stop();
    });

    it('stops and reports inactive', () => {
      const monitor = new RiskMonitor(makeMockClient());
      monitor.start();
      const msg = monitor.stop();

      expect(monitor.active).toBe(false);
      expect(msg).toContain('stopped');
    });

    it('reports already running on double start', () => {
      const monitor = new RiskMonitor(makeMockClient());
      monitor.start();
      const msg = monitor.start();

      expect(msg).toContain('already running');
      monitor.stop();
    });
  });
});
