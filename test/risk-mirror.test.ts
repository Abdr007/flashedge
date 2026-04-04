/**
 * Tests for RiskMirror — divergence detection between live and shadow state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RiskMirror } from '../src/shadow/risk-mirror.js';
import { TradeSide } from '../src/types/index.js';
import type { Position, IFlashClient } from '../src/types/index.js';
import type { ShadowEngine } from '../src/shadow/shadow-engine.js';

vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    trade: vi.fn(),
  }),
}));

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    market: 'SOL',
    side: TradeSide.Long,
    sizeUsd: 500,
    collateralUsd: 100,
    leverage: 5,
    entryPrice: 100,
    markPrice: 102,
    liquidationPrice: 80,
    unrealizedPnl: 10,
    openFee: 0.4,
    totalFees: 0.4,
    fundingRate: 0.001,
    ...overrides,
  };
}

function mockLiveClient(positions: Position[]): IFlashClient {
  return {
    walletAddress: 'LIVE_WALLET',
    getPositions: vi.fn().mockResolvedValue(positions),
    openPosition: vi.fn(),
    closePosition: vi.fn(),
    addCollateral: vi.fn(),
    removeCollateral: vi.fn(),
    getMarketData: vi.fn(),
    getPortfolio: vi.fn(),
    dryRunOpen: vi.fn(),
  } as unknown as IFlashClient;
}

function mockShadowEngine(positions: Position[]): ShadowEngine {
  return {
    getPositions: vi.fn().mockResolvedValue(positions),
  } as unknown as ShadowEngine;
}

describe('RiskMirror', () => {
  let mirror: RiskMirror;

  beforeEach(() => {
    mirror = new RiskMirror();
  });

  it('reports no divergence when states match', async () => {
    const pos = makePosition();
    const snapshot = await mirror.compare(
      mockLiveClient([pos]),
      mockShadowEngine([pos]),
    );
    expect(snapshot.divergences).toHaveLength(0);
    expect(snapshot.livePositionCount).toBe(1);
    expect(snapshot.shadowPositionCount).toBe(1);
  });

  it('detects position count mismatch', async () => {
    const snapshot = await mirror.compare(
      mockLiveClient([makePosition()]),
      mockShadowEngine([]),
    );
    expect(snapshot.divergences.length).toBeGreaterThanOrEqual(1);
    const d = snapshot.divergences.find(x => x.type === 'position_count');
    expect(d).toBeDefined();
    expect(d!.type).toBe('position_count');
    expect(d.liveValue).toBe(1);
    expect(d.shadowValue).toBe(0);
  });

  it('detects exposure divergence', async () => {
    mirror = new RiskMirror({ exposureThresholdUsd: 5 });
    const snapshot = await mirror.compare(
      mockLiveClient([makePosition({ sizeUsd: 500 })]),
      mockShadowEngine([makePosition({ sizeUsd: 480 })]),
    );
    const exposureDiv = snapshot.divergences.find(d => d.type === 'exposure');
    expect(exposureDiv).toBeDefined();
    expect(exposureDiv!.delta).toBe(20);
  });

  it('detects PnL divergence', async () => {
    mirror = new RiskMirror({ pnlThresholdUsd: 0.5 });
    const snapshot = await mirror.compare(
      mockLiveClient([makePosition({ unrealizedPnl: 10 })]),
      mockShadowEngine([makePosition({ unrealizedPnl: 5 })]),
    );
    const pnlDiv = snapshot.divergences.find(d => d.type === 'pnl');
    expect(pnlDiv).toBeDefined();
    expect(pnlDiv!.delta).toBe(5);
  });

  it('detects liquidation price divergence', async () => {
    mirror = new RiskMirror({ liqThresholdPercent: 1.0 });
    const snapshot = await mirror.compare(
      mockLiveClient([makePosition({ liquidationPrice: 80 })]),
      mockShadowEngine([makePosition({ liquidationPrice: 70 })]),
    );
    const liqDiv = snapshot.divergences.find(d => d.type === 'liquidation');
    expect(liqDiv).toBeDefined();
    expect(liqDiv!.delta).toBeGreaterThan(1);
  });

  it('skips PnL/liq check for positions not in shadow', async () => {
    const snapshot = await mirror.compare(
      mockLiveClient([makePosition({ market: 'BTC' })]),
      mockShadowEngine([makePosition({ market: 'ETH' })]),
    );
    // Should have position count divergence but no PnL/liq per-position divergence
    const pnlDiv = snapshot.divergences.filter(d => d.type === 'pnl');
    expect(pnlDiv).toHaveLength(0);
  });

  it('returns empty divergences on live client error', async () => {
    const liveClient = {
      walletAddress: 'LIVE',
      getPositions: vi.fn().mockRejectedValue(new Error('RPC down')),
    } as unknown as IFlashClient;
    const snapshot = await mirror.compare(liveClient, mockShadowEngine([]));
    expect(snapshot.divergences).toHaveLength(0);
    expect(snapshot.livePositionCount).toBe(0);
  });

  it('returns empty divergences on shadow engine error', async () => {
    const shadowEngine = {
      getPositions: vi.fn().mockRejectedValue(new Error('shadow crash')),
    } as unknown as ShadowEngine;
    const snapshot = await mirror.compare(mockLiveClient([makePosition()]), shadowEngine);
    expect(snapshot.divergences).toHaveLength(0);
  });

  it('stores divergence history (bounded)', async () => {
    mirror = new RiskMirror({ pnlThresholdUsd: 0.01 });
    for (let i = 0; i < 5; i++) {
      await mirror.compare(
        mockLiveClient([makePosition({ unrealizedPnl: 10 + i })]),
        mockShadowEngine([makePosition({ unrealizedPnl: 0 })]),
      );
    }
    const history = mirror.getHistory();
    expect(history.length).toBeGreaterThan(0);
    expect(history.length).toBeLessThanOrEqual(200);
  });

  it('getDivergenceCounts returns type counts', async () => {
    mirror = new RiskMirror({ pnlThresholdUsd: 0.01 });
    await mirror.compare(
      mockLiveClient([makePosition({ unrealizedPnl: 10 })]),
      mockShadowEngine([makePosition({ unrealizedPnl: 0 })]),
    );
    const counts = mirror.getDivergenceCounts();
    expect(counts['pnl']).toBeGreaterThanOrEqual(1);
  });

  it('getHistory respects limit parameter', async () => {
    mirror = new RiskMirror({ pnlThresholdUsd: 0.01 });
    for (let i = 0; i < 10; i++) {
      await mirror.compare(
        mockLiveClient([makePosition({ unrealizedPnl: 10 + i })]),
        mockShadowEngine([makePosition({ unrealizedPnl: 0 })]),
      );
    }
    const limited = mirror.getHistory(3);
    expect(limited.length).toBeLessThanOrEqual(3);
  });

  it('handles non-finite sizeUsd in exposure calculation', async () => {
    mirror = new RiskMirror({ exposureThresholdUsd: 5 });
    const snapshot = await mirror.compare(
      mockLiveClient([makePosition({ sizeUsd: NaN })]),
      mockShadowEngine([makePosition({ sizeUsd: 500 })]),
    );
    // NaN sizeUsd treated as 0 in exposure calc
    expect(snapshot.liveExposure).toBe(0);
    expect(snapshot.shadowExposure).toBe(500);
  });

  it('skips liquidation check when prices are zero', async () => {
    mirror = new RiskMirror({ liqThresholdPercent: 1.0 });
    const snapshot = await mirror.compare(
      mockLiveClient([makePosition({ liquidationPrice: 0 })]),
      mockShadowEngine([makePosition({ liquidationPrice: 0 })]),
    );
    const liqDiv = snapshot.divergences.filter(d => d.type === 'liquidation');
    expect(liqDiv).toHaveLength(0);
  });
});
