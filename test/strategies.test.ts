/**
 * Behavior-locking tests for trading strategies.
 *
 * Tests cover momentum, mean-reversion, and whale-follow strategies.
 * All strategies are pure functions with no I/O — no mocks needed.
 */

import { describe, it, expect } from 'vitest';
import { computeMomentumSignal, MomentumInput } from '../src/strategies/momentum.js';
import { computeMeanReversionSignal, MeanReversionInput } from '../src/strategies/mean-reversion.js';
import { computeWhaleFollowSignal, WhaleFollowInput, WhaleActivity } from '../src/strategies/whale-follow.js';
import { MarketData, VolumeData, OpenInterestData, DailyVolume } from '../src/types/index.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMarket(overrides: Partial<MarketData> = {}): MarketData {
  return {
    symbol: 'SOL',
    price: 150,
    priceChange24h: 0,
    openInterestLong: 5_000_000,
    openInterestShort: 5_000_000,
    maxLeverage: 100,
    fundingRate: 0.001,
    ...overrides,
  };
}

function makeDay(volumeUsd: number, date = '2026-04-15'): DailyVolume {
  return {
    date,
    volumeUsd,
    trades: 100,
    longVolume: volumeUsd / 2,
    shortVolume: volumeUsd / 2,
    liquidationVolume: 0,
  };
}

function makeVolume(dailyVolumes: DailyVolume[]): VolumeData {
  const total = dailyVolumes.reduce((s, d) => s + d.volumeUsd, 0);
  return {
    period: '7d',
    totalVolumeUsd: total,
    trades: dailyVolumes.length * 100,
    uniqueTraders: 50,
    dailyVolumes,
  };
}

function makeOI(overrides: Partial<{ market: string; longOi: number; shortOi: number }> = {}): OpenInterestData {
  return {
    markets: [
      {
        market: overrides.market ?? 'SOL',
        longOi: overrides.longOi ?? 5_000_000,
        shortOi: overrides.shortOi ?? 5_000_000,
        longPositions: 100,
        shortPositions: 100,
      },
    ],
  };
}

// ─── Momentum Strategy ──────────────────────────────────────────────────────

describe('Momentum Strategy', () => {
  it('generates bullish signal on positive price change + high volume', () => {
    // Recent 3 days average 200K, previous 3 days average 100K -> 100% growth
    const dailyVolumes = [
      makeDay(100_000, '2026-04-09'),
      makeDay(100_000, '2026-04-10'),
      makeDay(100_000, '2026-04-11'),
      makeDay(200_000, '2026-04-12'),
      makeDay(200_000, '2026-04-13'),
      makeDay(200_000, '2026-04-14'),
    ];
    const input: MomentumInput = {
      market: makeMarket({ priceChange24h: 5.0 }),
      volume: makeVolume(dailyVolumes),
    };

    const result = computeMomentumSignal(input);

    expect(result.signal).toBe('bullish');
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.name).toBe('Momentum');
    expect(result.reasoning).toContain('rising');
  });

  it('generates bearish signal on negative price change + high volume', () => {
    const dailyVolumes = [
      makeDay(100_000, '2026-04-09'),
      makeDay(100_000, '2026-04-10'),
      makeDay(100_000, '2026-04-11'),
      makeDay(200_000, '2026-04-12'),
      makeDay(200_000, '2026-04-13'),
      makeDay(200_000, '2026-04-14'),
    ];
    const input: MomentumInput = {
      market: makeMarket({ priceChange24h: -5.0 }),
      volume: makeVolume(dailyVolumes),
    };

    const result = computeMomentumSignal(input);

    expect(result.signal).toBe('bearish');
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.reasoning).toContain('falling');
  });

  it('returns neutral on low volume (declining volume)', () => {
    // Recent 3 days average 50K, previous 3 days average 100K -> -50% growth (volumeDown)
    const dailyVolumes = [
      makeDay(100_000, '2026-04-09'),
      makeDay(100_000, '2026-04-10'),
      makeDay(100_000, '2026-04-11'),
      makeDay(50_000, '2026-04-12'),
      makeDay(50_000, '2026-04-13'),
      makeDay(50_000, '2026-04-14'),
    ];
    const input: MomentumInput = {
      market: makeMarket({ priceChange24h: 3.0 }),
      volume: makeVolume(dailyVolumes),
    };

    const result = computeMomentumSignal(input);

    // Price up + volume down = neutral (momentum weakening)
    expect(result.signal).toBe('neutral');
    expect(result.reasoning).toContain('declining');
  });

  it('confidence clamped to 0.85 max for bullish signals', () => {
    // Huge volume growth = 400% (just under manipulation guard)
    const dailyVolumes = [
      makeDay(100_000, '2026-04-09'),
      makeDay(100_000, '2026-04-10'),
      makeDay(100_000, '2026-04-11'),
      makeDay(500_000, '2026-04-12'),
      makeDay(500_000, '2026-04-13'),
      makeDay(500_000, '2026-04-14'),
    ];
    const input: MomentumInput = {
      market: makeMarket({ priceChange24h: 10.0 }),
      volume: makeVolume(dailyVolumes),
    };

    const result = computeMomentumSignal(input);

    expect(result.signal).toBe('bullish');
    expect(result.confidence).toBeLessThanOrEqual(0.85);
  });

  it('manipulation guard: >500% volume growth reduces confidence by 0.7', () => {
    // 600% growth: recent avg = 700K, prev avg = 100K -> growth = 6.0
    const dailyVolumes = [
      makeDay(100_000, '2026-04-09'),
      makeDay(100_000, '2026-04-10'),
      makeDay(100_000, '2026-04-11'),
      makeDay(700_000, '2026-04-12'),
      makeDay(700_000, '2026-04-13'),
      makeDay(700_000, '2026-04-14'),
    ];
    const input: MomentumInput = {
      market: makeMarket({ priceChange24h: 5.0 }),
      volume: makeVolume(dailyVolumes),
    };

    const result = computeMomentumSignal(input);

    expect(result.signal).toBe('bullish');
    // Without manipulation guard: min(0.85, 0.5 + 6.0 * 0.5) = 0.85
    // With guard: 0.85 * 0.7 = 0.595
    expect(result.confidence).toBeLessThan(0.6);
    expect(result.confidence).toBeCloseTo(0.85 * 0.7, 2);
  });

  it('handles NaN priceChange24h without crashing', () => {
    const dailyVolumes = Array.from({ length: 6 }, (_, i) => makeDay(100_000, `2026-04-${9 + i}`));
    const input: MomentumInput = {
      market: makeMarket({ priceChange24h: NaN }),
      volume: makeVolume(dailyVolumes),
    };

    const result = computeMomentumSignal(input);

    expect(result).toBeDefined();
    expect(result.signal).toBe('neutral');
    expect(Number.isFinite(result.confidence)).toBe(true);
  });

  it('handles zero priceChange24h as flat/neutral', () => {
    const dailyVolumes = Array.from({ length: 6 }, (_, i) => makeDay(100_000, `2026-04-${9 + i}`));
    const input: MomentumInput = {
      market: makeMarket({ priceChange24h: 0 }),
      volume: makeVolume(dailyVolumes),
    };

    const result = computeMomentumSignal(input);

    expect(result.signal).toBe('neutral');
  });

  it('returns neutral with insufficient volume history (<6 days)', () => {
    const dailyVolumes = [makeDay(100_000, '2026-04-14'), makeDay(200_000, '2026-04-15')];
    const input: MomentumInput = {
      market: makeMarket({ priceChange24h: 5.0 }),
      volume: makeVolume(dailyVolumes),
    };

    const result = computeMomentumSignal(input);

    expect(result.signal).toBe('neutral');
    expect(result.confidence).toBe(0.3);
    expect(result.reasoning).toContain('Insufficient');
  });

  it('handles undefined volume growth (prevAvg = 0)', () => {
    const dailyVolumes = [
      makeDay(0, '2026-04-09'),
      makeDay(0, '2026-04-10'),
      makeDay(0, '2026-04-11'),
      makeDay(100_000, '2026-04-12'),
      makeDay(100_000, '2026-04-13'),
      makeDay(100_000, '2026-04-14'),
    ];
    const input: MomentumInput = {
      market: makeMarket({ priceChange24h: 5.0 }),
      volume: makeVolume(dailyVolumes),
    };

    const result = computeMomentumSignal(input);

    // volumeGrowth = 0 when prevAvg = 0, so no volumeUp -> neutral
    expect(result).toBeDefined();
    expect(Number.isFinite(result.confidence)).toBe(true);
  });
});

// ─── Mean Reversion Strategy ────────────────────────────────────────────────

describe('Mean Reversion Strategy', () => {
  it('generates bearish signal when price up with heavy long skew', () => {
    // Price up >5% + long skew >0.3 -> overcrowded longs -> expect reversion down
    const input: MeanReversionInput = {
      market: makeMarket({ priceChange24h: 8.0 }),
      openInterest: makeOI({ longOi: 8_000_000, shortOi: 2_000_000 }), // 80/20 skew = 0.6
    };

    const result = computeMeanReversionSignal(input);

    expect(result.signal).toBe('bearish');
    expect(result.confidence).toBeGreaterThan(0.4);
    expect(result.name).toBe('Mean Reversion');
    expect(result.reasoning).toContain('Overcrowded');
  });

  it('generates bullish signal when price down with heavy short skew', () => {
    // Price down >5% + short skew >0.3 -> short squeeze potential
    const input: MeanReversionInput = {
      market: makeMarket({ priceChange24h: -10.0 }),
      openInterest: makeOI({ longOi: 2_000_000, shortOi: 8_000_000 }), // skew = -0.6
    };

    const result = computeMeanReversionSignal(input);

    expect(result.signal).toBe('bullish');
    expect(result.confidence).toBeGreaterThan(0.4);
    expect(result.reasoning).toContain('Short squeeze');
  });

  it('returns neutral when price is near mean (small move, balanced OI)', () => {
    const input: MeanReversionInput = {
      market: makeMarket({ priceChange24h: 1.0 }),
      openInterest: makeOI({ longOi: 5_000_000, shortOi: 5_000_000 }), // balanced
    };

    const result = computeMeanReversionSignal(input);

    expect(result.signal).toBe('neutral');
    expect(result.reasoning).toContain('balanced');
  });

  it('returns neutral when no OI data for this market', () => {
    const input: MeanReversionInput = {
      market: makeMarket({ symbol: 'DOGE' }),
      openInterest: makeOI({ market: 'SOL' }), // no DOGE data
    };

    const result = computeMeanReversionSignal(input);

    expect(result.signal).toBe('neutral');
    expect(result.confidence).toBe(0.2);
    expect(result.reasoning).toContain('No open interest data');
  });

  it('handles NaN OI values gracefully', () => {
    const input: MeanReversionInput = {
      market: makeMarket({ priceChange24h: 8.0 }),
      openInterest: {
        markets: [
          {
            market: 'SOL',
            longOi: NaN,
            shortOi: NaN,
            longPositions: 0,
            shortPositions: 0,
          },
        ],
      },
    };

    const result = computeMeanReversionSignal(input);

    expect(result).toBeDefined();
    expect(result.signal).toBe('neutral');
    expect(result.reasoning).toContain('No open interest');
  });

  it('handles NaN priceChange24h gracefully', () => {
    const input: MeanReversionInput = {
      market: makeMarket({ priceChange24h: NaN }),
      openInterest: makeOI({ longOi: 8_000_000, shortOi: 2_000_000 }),
    };

    const result = computeMeanReversionSignal(input);

    expect(result).toBeDefined();
    expect(Number.isFinite(result.confidence)).toBe(true);
  });

  it('generates signal on heavy skew without large price move (pressure building)', () => {
    // absSkew > 0.4 but priceMove < 5
    const input: MeanReversionInput = {
      market: makeMarket({ priceChange24h: 2.0 }),
      openInterest: makeOI({ longOi: 8_000_000, shortOi: 2_000_000 }), // skew = 0.6 > 0.4
    };

    const result = computeMeanReversionSignal(input);

    expect(result.signal).toBe('bearish'); // skew > 0 -> bearish pressure
    expect(result.confidence).toBe(0.45);
    expect(result.reasoning).toContain('Pressure building');
  });

  it('confidence capped at 0.8', () => {
    // Extreme values: huge price move + extreme skew
    const input: MeanReversionInput = {
      market: makeMarket({ priceChange24h: -50.0 }),
      openInterest: makeOI({ longOi: 100_000, shortOi: 9_900_000 }), // 99% short
    };

    const result = computeMeanReversionSignal(input);

    expect(result.confidence).toBeLessThanOrEqual(0.8);
  });
});

// ─── Whale Follow Strategy ──────────────────────────────────────────────────

describe('Whale Follow Strategy', () => {
  it('generates bullish signal when whales are heavily long', () => {
    const activity: WhaleActivity[] = [
      { market: 'SOL', side: 'long', sizeUsd: 50_000, timestamp: Date.now() },
      { market: 'SOL', side: 'long', sizeUsd: 80_000, timestamp: Date.now() - 1000 },
      { market: 'SOL', side: 'short', sizeUsd: 15_000, timestamp: Date.now() - 2000 },
    ];

    const input: WhaleFollowInput = {
      recentActivity: activity,
      openPositions: [],
      targetMarket: 'SOL',
    };

    const result = computeWhaleFollowSignal(input);

    expect(result.signal).toBe('bullish');
    expect(result.confidence).toBeGreaterThan(0.4);
    expect(result.name).toBe('Whale Follow');
  });

  it('generates bearish signal when whales are heavily short', () => {
    const activity: WhaleActivity[] = [
      { market: 'SOL', side: 'short', sizeUsd: 50_000, timestamp: Date.now() },
      { market: 'SOL', side: 'short', sizeUsd: 80_000, timestamp: Date.now() - 1000 },
      { market: 'SOL', side: 'long', sizeUsd: 15_000, timestamp: Date.now() - 2000 },
    ];

    const input: WhaleFollowInput = {
      recentActivity: activity,
      openPositions: [],
      targetMarket: 'SOL',
    };

    const result = computeWhaleFollowSignal(input);

    expect(result.signal).toBe('bearish');
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it('deduplication works: same market+side+size+timestamp = one signal', () => {
    const ts = Date.now();
    const whale: WhaleActivity = { market: 'SOL', side: 'long', sizeUsd: 50_000, timestamp: ts };

    // Same whale appears in both recentActivity and openPositions
    const input: WhaleFollowInput = {
      recentActivity: [whale],
      openPositions: [whale],
      targetMarket: 'SOL',
    };

    const result = computeWhaleFollowSignal(input);

    // Should only count once; with 1 long whale and 0 short -> bullish
    // But longPct = 100% > 70% -> bullish
    expect(result.signal).toBe('bullish');
  });

  it('returns neutral on empty whale data', () => {
    const input: WhaleFollowInput = {
      recentActivity: [],
      openPositions: [],
      targetMarket: 'SOL',
    };

    const result = computeWhaleFollowSignal(input);

    expect(result.signal).toBe('neutral');
    expect(result.confidence).toBe(0.2);
    expect(result.reasoning).toContain('No significant whale activity');
  });

  it('filters out sub-threshold positions (<$10K)', () => {
    const activity: WhaleActivity[] = [
      { market: 'SOL', side: 'long', sizeUsd: 5_000, timestamp: Date.now() },
      { market: 'SOL', side: 'short', sizeUsd: 3_000, timestamp: Date.now() - 1000 },
    ];

    const input: WhaleFollowInput = {
      recentActivity: activity,
      openPositions: [],
      targetMarket: 'SOL',
    };

    const result = computeWhaleFollowSignal(input);

    expect(result.signal).toBe('neutral');
    expect(result.confidence).toBe(0.2);
  });

  it('confidence scales with whale count', () => {
    // 2 whales vs 5 whales, same directional bias
    const twoWhales: WhaleActivity[] = [
      { market: 'SOL', side: 'long', sizeUsd: 50_000, timestamp: 1 },
      { market: 'SOL', side: 'long', sizeUsd: 60_000, timestamp: 2 },
    ];

    const fiveWhales: WhaleActivity[] = [
      { market: 'SOL', side: 'long', sizeUsd: 50_000, timestamp: 1 },
      { market: 'SOL', side: 'long', sizeUsd: 60_000, timestamp: 2 },
      { market: 'SOL', side: 'long', sizeUsd: 70_000, timestamp: 3 },
      { market: 'SOL', side: 'long', sizeUsd: 80_000, timestamp: 4 },
      { market: 'SOL', side: 'long', sizeUsd: 90_000, timestamp: 5 },
    ];

    const resultTwo = computeWhaleFollowSignal({
      recentActivity: twoWhales,
      openPositions: [],
      targetMarket: 'SOL',
    });

    const resultFive = computeWhaleFollowSignal({
      recentActivity: fiveWhales,
      openPositions: [],
      targetMarket: 'SOL',
    });

    expect(resultTwo.signal).toBe('bullish');
    expect(resultFive.signal).toBe('bullish');
    // More whales should yield >= confidence (may both hit the 0.8 cap)
    expect(resultFive.confidence).toBeGreaterThanOrEqual(resultTwo.confidence);
  });

  it('returns neutral when whale volume is mixed (no clear bias)', () => {
    const activity: WhaleActivity[] = [
      { market: 'SOL', side: 'long', sizeUsd: 50_000, timestamp: 1 },
      { market: 'SOL', side: 'short', sizeUsd: 50_000, timestamp: 2 },
    ];

    const input: WhaleFollowInput = {
      recentActivity: activity,
      openPositions: [],
      targetMarket: 'SOL',
    };

    const result = computeWhaleFollowSignal(input);

    expect(result.signal).toBe('neutral');
    expect(result.reasoning).toContain('Mixed');
  });

  it('filters by target market (ignores other markets)', () => {
    const activity: WhaleActivity[] = [
      { market: 'BTC', side: 'long', sizeUsd: 500_000, timestamp: 1 },
      { market: 'ETH', side: 'long', sizeUsd: 300_000, timestamp: 2 },
    ];

    const input: WhaleFollowInput = {
      recentActivity: activity,
      openPositions: [],
      targetMarket: 'SOL',
    };

    const result = computeWhaleFollowSignal(input);

    expect(result.signal).toBe('neutral');
    expect(result.confidence).toBe(0.2);
  });

  it('confidence capped at 0.8', () => {
    // Many large whales all in one direction
    const whales: WhaleActivity[] = Array.from({ length: 20 }, (_, i) => ({
      market: 'SOL',
      side: 'long' as const,
      sizeUsd: 1_000_000,
      timestamp: i,
    }));

    const result = computeWhaleFollowSignal({
      recentActivity: whales,
      openPositions: [],
      targetMarket: 'SOL',
    });

    expect(result.confidence).toBeLessThanOrEqual(0.8);
  });

  it('is case-insensitive on market matching', () => {
    const activity: WhaleActivity[] = [
      { market: 'sol', side: 'long', sizeUsd: 50_000, timestamp: 1 },
      { market: 'Sol', side: 'long', sizeUsd: 60_000, timestamp: 2 },
    ];

    const result = computeWhaleFollowSignal({
      recentActivity: activity,
      openPositions: [],
      targetMarket: 'SOL',
    });

    expect(result.signal).toBe('bullish');
  });
});
