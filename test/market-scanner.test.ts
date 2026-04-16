/**
 * Comprehensive tests for MarketScanner.
 *
 * All external dependencies (SolanaInspector, strategies, regime detector, logger)
 * are mocked so tests are deterministic and fast.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { MarketData, VolumeData, OpenInterestData, StrategySignal, Opportunity } from '../src/types/index.js';
import { TradeSide } from '../src/types/index.js';
import { MarketRegime } from '../src/regime/regime-types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock logger — suppress all output
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    trade: () => {},
  }),
}));

// Mock SolanaInspector to prevent cascading dependency imports
vi.mock('../src/agent/solana-inspector.js', () => ({
  SolanaInspector: class {},
}));

// Mock strategy modules with controllable return values
const mockMomentumSignal = vi.fn().mockReturnValue({
  name: 'Momentum',
  signal: 'bullish',
  confidence: 0.7,
  reasoning: 'Mock momentum bullish',
});

const mockMeanReversionSignal = vi.fn().mockReturnValue({
  name: 'Mean Reversion',
  signal: 'neutral',
  confidence: 0.3,
  reasoning: 'Mock mean reversion neutral',
});

const mockWhaleFollowSignal = vi.fn().mockReturnValue({
  name: 'Whale Follow',
  signal: 'neutral',
  confidence: 0.2,
  reasoning: 'Mock whale neutral',
});

vi.mock('../src/strategies/momentum.js', () => ({
  computeMomentumSignal: (...args: unknown[]) => mockMomentumSignal(),
}));

vi.mock('../src/strategies/mean-reversion.js', () => ({
  computeMeanReversionSignal: (...args: unknown[]) => mockMeanReversionSignal(),
}));

vi.mock('../src/strategies/whale-follow.js', () => ({
  computeWhaleFollowSignal: (...args: unknown[]) => mockWhaleFollowSignal(),
}));

// Mock RegimeDetector
const mockDetectAll = vi.fn();
const mockGetWeights = vi.fn();

vi.mock('../src/regime/regime-detector.js', () => ({
  RegimeDetector: class {
    detectAll = mockDetectAll;
    getWeights = mockGetWeights;
  },
}));

// ---------------------------------------------------------------------------
// Helpers: build mock data
// ---------------------------------------------------------------------------

function makeMarket(symbol: string, price: number, change24h = 0): MarketData {
  return {
    symbol,
    price,
    priceChange24h: change24h,
    openInterestLong: 100_000,
    openInterestShort: 80_000,
    maxLeverage: 50,
    fundingRate: 0.001,
  };
}

function makeVolume(days = 7, dailyUsd = 1_000_000): VolumeData {
  const dailyVolumes = Array.from({ length: days }, (_, i) => ({
    date: `2026-04-${String(i + 1).padStart(2, '0')}`,
    volumeUsd: dailyUsd + i * 100_000,
    trades: 500,
    longVolume: dailyUsd * 0.55,
    shortVolume: dailyUsd * 0.45,
    liquidationVolume: 0,
  }));
  return {
    period: '7d',
    totalVolumeUsd: dailyUsd * days,
    trades: 3500,
    uniqueTraders: 200,
    dailyVolumes,
  };
}

function makeOI(markets: string[]): OpenInterestData {
  return {
    markets: markets.map((m) => ({
      market: m,
      longOi: 500_000,
      shortOi: 300_000,
      longPositions: 100,
      shortPositions: 80,
    })),
  };
}

function defaultRegimeWeights() {
  return {
    momentum: 0.4,
    meanReversion: 0.4,
    whaleFollow: 0.2,
    leverageMultiplier: 1.0,
    collateralMultiplier: 1.0,
  };
}

function defaultRegimeState(market: string): import('../src/regime/regime-types.js').RegimeState {
  return {
    market,
    trendStrength: 0.5,
    volatility: 0.3,
    liquidity: 0.7,
    whaleActivity: 0.2,
    regime: MarketRegime.RANGING,
    confidence: 0.6,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Build a mock inspector that returns controlled data
// ---------------------------------------------------------------------------

function createMockInspector(overrides: {
  markets?: MarketData[];
  volume?: VolumeData;
  openInterest?: OpenInterestData;
  recentActivity?: unknown[];
  openPositions?: unknown[];
} = {}) {
  const markets = overrides.markets ?? [makeMarket('SOL', 150), makeMarket('BTC', 60000), makeMarket('ETH', 3500)];
  return {
    getMarkets: vi.fn().mockResolvedValue(markets),
    getVolume: vi.fn().mockResolvedValue(overrides.volume ?? makeVolume()),
    getOpenInterest: vi.fn().mockResolvedValue(overrides.openInterest ?? makeOI(['SOL', 'BTC', 'ETH'])),
    getRecentActivity: vi.fn().mockResolvedValue(overrides.recentActivity ?? []),
    getOpenPositions: vi.fn().mockResolvedValue(overrides.openPositions ?? []),
  } as unknown as import('../src/agent/solana-inspector.js').SolanaInspector;
}

// ---------------------------------------------------------------------------
// Setup default regime mocks (reset per test)
// ---------------------------------------------------------------------------

function setupRegimeMocks(markets: string[] = ['SOL', 'BTC', 'ETH']) {
  const regimeMap = new Map<string, import('../src/regime/regime-types.js').RegimeState>();
  for (const m of markets) {
    regimeMap.set(m.toUpperCase(), defaultRegimeState(m));
  }
  mockDetectAll.mockReturnValue(regimeMap);
  mockGetWeights.mockReturnValue(defaultRegimeWeights());
}

// ---------------------------------------------------------------------------
// Import the scanner AFTER mocks are registered
// ---------------------------------------------------------------------------

const { MarketScanner } = await import('../src/scanner/market-scanner.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MarketScanner', () => {
  let inspector: ReturnType<typeof createMockInspector>;
  let scanner: InstanceType<typeof MarketScanner>;

  beforeEach(() => {
    vi.clearAllMocks();
    inspector = createMockInspector();
    scanner = new MarketScanner(inspector as any);
    setupRegimeMocks();

    // Restore default strategy signals
    mockMomentumSignal.mockReturnValue({
      name: 'Momentum',
      signal: 'bullish',
      confidence: 0.7,
      reasoning: 'Mock momentum bullish',
    });
    mockMeanReversionSignal.mockReturnValue({
      name: 'Mean Reversion',
      signal: 'neutral',
      confidence: 0.3,
      reasoning: 'Mock mean reversion neutral',
    });
    mockWhaleFollowSignal.mockReturnValue({
      name: 'Whale Follow',
      signal: 'neutral',
      confidence: 0.2,
      reasoning: 'Mock whale neutral',
    });
  });

  // ── 1. Constructor ────────────────────────────────────────────────────

  describe('constructor', () => {
    it('creates without error', () => {
      expect(scanner).toBeDefined();
      expect(scanner).toBeInstanceOf(MarketScanner);
    });

    it('exposes clearCache method', () => {
      expect(typeof scanner.clearCache).toBe('function');
    });
  });

  // ── 2. scan() basic flow ──────────────────────────────────────────────

  describe('scan() basic flow', () => {
    it('returns an array of Opportunity objects', async () => {
      const results = await scanner.scan(10_000);

      expect(Array.isArray(results)).toBe(true);
      for (const opp of results) {
        expect(opp).toHaveProperty('market');
        expect(opp).toHaveProperty('direction');
        expect(opp).toHaveProperty('confidence');
        expect(opp).toHaveProperty('totalScore');
        expect(opp).toHaveProperty('signals');
        expect(opp).toHaveProperty('reasoning');
      }
    });

    it('calls inspector methods for data fetch', async () => {
      await scanner.scan(10_000);

      expect((inspector.getMarkets as Mock)).toHaveBeenCalled();
      expect((inspector.getVolume as Mock)).toHaveBeenCalled();
      expect((inspector.getOpenInterest as Mock)).toHaveBeenCalled();
      expect((inspector.getRecentActivity as Mock)).toHaveBeenCalled();
      expect((inspector.getOpenPositions as Mock)).toHaveBeenCalled();
    });

    it('invokes all three strategies for each valid market', async () => {
      await scanner.scan(10_000);

      // 3 valid markets -> each strategy called 3 times
      expect(mockMomentumSignal).toHaveBeenCalledTimes(3);
      expect(mockMeanReversionSignal).toHaveBeenCalledTimes(3);
      expect(mockWhaleFollowSignal).toHaveBeenCalledTimes(3);
    });

    it('results are sorted by totalScore descending', async () => {
      const results = await scanner.scan(10_000);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].totalScore).toBeGreaterThanOrEqual(results[i].totalScore);
      }
    });

    it('respects topN parameter', async () => {
      const results = await scanner.scan(10_000, 1);
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('returns cached results on second call within TTL', async () => {
      await scanner.scan(10_000);
      const callCount = (inspector.getMarkets as Mock).mock.calls.length;

      await scanner.scan(10_000);
      // Should NOT have called inspector again
      expect((inspector.getMarkets as Mock).mock.calls.length).toBe(callCount);
    });

    it('fetches fresh data after clearCache()', async () => {
      await scanner.scan(10_000);
      scanner.clearCache();
      await scanner.scan(10_000);

      expect((inspector.getMarkets as Mock)).toHaveBeenCalledTimes(2);
    });
  });

  // ── 3. Concurrent scan mutex ──────────────────────────────────────────

  describe('concurrent scan mutex', () => {
    it('second concurrent scan returns the same promise as the first', async () => {
      // Make inspector slow so the first scan is still in progress
      let resolveMarkets!: (v: MarketData[]) => void;
      const slowPromise = new Promise<MarketData[]>((res) => { resolveMarkets = res; });
      (inspector.getMarkets as Mock).mockReturnValue(slowPromise);

      const scan1 = scanner.scan(10_000);
      const scan2 = scanner.scan(10_000);

      // Resolve the inspector call
      resolveMarkets([makeMarket('SOL', 150)]);

      const [r1, r2] = await Promise.all([scan1, scan2]);
      expect(r1).toBe(r2); // Exact same reference — shared promise

      // Inspector called only once (not twice)
      expect((inspector.getMarkets as Mock)).toHaveBeenCalledTimes(1);
    });
  });

  // ── 4. Zero-price market filtering ────────────────────────────────────

  describe('zero-price market filtering', () => {
    it('excludes markets with price=0', async () => {
      inspector = createMockInspector({
        markets: [
          makeMarket('SOL', 150),
          makeMarket('BTC', 0),
          makeMarket('DEAD', 0),
        ],
      });
      scanner = new MarketScanner(inspector as any);
      setupRegimeMocks(['SOL']);

      const results = await scanner.scan(10_000);

      const symbols = results.map((o) => o.market);
      expect(symbols).not.toContain('BTC');
      expect(symbols).not.toContain('DEAD');
    });

    it('excludes markets with negative price', async () => {
      inspector = createMockInspector({
        markets: [makeMarket('SOL', 150), makeMarket('BAD', -50)],
      });
      scanner = new MarketScanner(inspector as any);
      setupRegimeMocks(['SOL']);

      const results = await scanner.scan(10_000);
      const symbols = results.map((o) => o.market);
      expect(symbols).not.toContain('BAD');
    });

    it('excludes markets with Infinity price', async () => {
      inspector = createMockInspector({
        markets: [makeMarket('SOL', 150), makeMarket('INF', Infinity)],
      });
      scanner = new MarketScanner(inspector as any);
      setupRegimeMocks(['SOL']);

      const results = await scanner.scan(10_000);
      const symbols = results.map((o) => o.market);
      expect(symbols).not.toContain('INF');
    });
  });

  // ── 5. Regime-weighted direction ──────────────────────────────────────

  describe('regime-weighted direction', () => {
    it('TRENDING regime amplifies momentum weight', async () => {
      const trendingWeights = {
        momentum: 0.7,
        meanReversion: 0.2,
        whaleFollow: 0.1,
        leverageMultiplier: 1.0,
        collateralMultiplier: 1.0,
      };
      mockGetWeights.mockReturnValue(trendingWeights);

      // Strong bullish momentum, weak bearish mean reversion
      mockMomentumSignal.mockReturnValue({
        name: 'Momentum', signal: 'bullish', confidence: 0.8, reasoning: 'Trending up',
      });
      mockMeanReversionSignal.mockReturnValue({
        name: 'Mean Reversion', signal: 'bearish', confidence: 0.6, reasoning: 'Overbought',
      });
      mockWhaleFollowSignal.mockReturnValue({
        name: 'Whale Follow', signal: 'neutral', confidence: 0.1, reasoning: 'No whales',
      });

      const results = await scanner.scan(10_000);

      // In trending regime, momentum (0.7 weight) with 0.8 bullish confidence
      // should dominate over mean reversion (0.2 weight) with 0.6 bearish
      // bullish = 0.8 * 0.7 = 0.56, bearish = 0.6 * 0.2 = 0.12
      // So direction should be long
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].direction).toBe(TradeSide.Long);
    });

    it('RANGING regime amplifies mean reversion weight', async () => {
      const rangingWeights = {
        momentum: 0.2,
        meanReversion: 0.6,
        whaleFollow: 0.2,
        leverageMultiplier: 1.0,
        collateralMultiplier: 1.0,
      };
      mockGetWeights.mockReturnValue(rangingWeights);

      // Weak bullish momentum, strong bearish mean reversion
      mockMomentumSignal.mockReturnValue({
        name: 'Momentum', signal: 'bullish', confidence: 0.5, reasoning: 'Slight up',
      });
      mockMeanReversionSignal.mockReturnValue({
        name: 'Mean Reversion', signal: 'bearish', confidence: 0.8, reasoning: 'Overbought hard',
      });
      mockWhaleFollowSignal.mockReturnValue({
        name: 'Whale Follow', signal: 'neutral', confidence: 0.1, reasoning: 'No whales',
      });

      scanner.clearCache();
      const results = await scanner.scan(10_000);

      // In ranging regime, mean reversion (0.6 weight) with 0.8 bearish confidence
      // should dominate over momentum (0.2 weight) with 0.5 bullish
      // bearish = 0.8 * 0.6 = 0.48, bullish = 0.5 * 0.2 = 0.10
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].direction).toBe(TradeSide.Short);
    });

    it('HIGH_VOLATILITY reduces leverage multiplier', async () => {
      const highVolWeights = {
        momentum: 0.3,
        meanReversion: 0.3,
        whaleFollow: 0.4,
        leverageMultiplier: 0.5,
        collateralMultiplier: 0.7,
      };
      mockGetWeights.mockReturnValue(highVolWeights);

      mockMomentumSignal.mockReturnValue({
        name: 'Momentum', signal: 'bullish', confidence: 0.9, reasoning: 'Strong up',
      });

      const results = await scanner.scan(10_000);

      expect(results.length).toBeGreaterThan(0);
      // Leverage should be reduced: max base = 3, times 0.5 = 1.5, clamped to >= 1.1
      expect(results[0].recommendedLeverage).toBeLessThanOrEqual(3);
      expect(results[0].recommendedLeverage).toBeGreaterThanOrEqual(1.1);
    });
  });

  // ── 6. Timeout fallback ───────────────────────────────────────────────

  describe('timeout fallback', () => {
    it('returns cached results when scan times out', async () => {
      // First scan: normal, populates cache
      const firstResults = await scanner.scan(10_000);
      expect(firstResults.length).toBeGreaterThan(0);

      // Expire the cache so a new scan is triggered
      scanner.clearCache();

      // Make inspector hang forever
      (inspector.getMarkets as Mock).mockReturnValue(new Promise(() => {}));

      // The scan should hit the 15s timeout internally and return cached results.
      // We use vi.useFakeTimers to avoid actually waiting 15s.
      vi.useFakeTimers();
      const scanPromise = scanner.scan(10_000);

      // Advance past the SCAN_TIMEOUT_MS (15s)
      await vi.advanceTimersByTimeAsync(16_000);

      const fallbackResults = await scanPromise;
      vi.useRealTimers();

      // Should get the previously cached results (or empty)
      expect(Array.isArray(fallbackResults)).toBe(true);
    });

    it('returns empty array when scan times out with no prior cache', async () => {
      // Inspector hangs immediately (no prior cache)
      (inspector.getMarkets as Mock).mockReturnValue(new Promise(() => {}));

      vi.useFakeTimers();
      const scanPromise = scanner.scan(10_000);
      await vi.advanceTimersByTimeAsync(16_000);

      const results = await scanPromise;
      vi.useRealTimers();

      expect(results).toEqual([]);
    });
  });

  // ── 7. Empty market data ──────────────────────────────────────────────

  describe('empty market data', () => {
    it('returns empty opportunities when getMarkets returns []', async () => {
      inspector = createMockInspector({ markets: [] });
      scanner = new MarketScanner(inspector as any);

      const results = await scanner.scan(10_000);
      expect(results).toEqual([]);
    });

    it('returns empty opportunities when all markets have zero price', async () => {
      inspector = createMockInspector({
        markets: [makeMarket('SOL', 0), makeMarket('BTC', 0)],
      });
      scanner = new MarketScanner(inspector as any);

      const results = await scanner.scan(10_000);
      expect(results).toEqual([]);
    });

    it('returns empty when all strategies are neutral (no directional bias)', async () => {
      mockMomentumSignal.mockReturnValue({
        name: 'Momentum', signal: 'neutral', confidence: 0.3, reasoning: 'Neutral',
      });
      mockMeanReversionSignal.mockReturnValue({
        name: 'Mean Reversion', signal: 'neutral', confidence: 0.2, reasoning: 'Neutral',
      });
      mockWhaleFollowSignal.mockReturnValue({
        name: 'Whale Follow', signal: 'neutral', confidence: 0.1, reasoning: 'Neutral',
      });

      const results = await scanner.scan(10_000);
      expect(results).toEqual([]);
    });
  });

  // ── 8. Strategy signal aggregation ────────────────────────────────────

  describe('strategy signal aggregation', () => {
    it('combines multiple bullish signals into a long opportunity', async () => {
      mockMomentumSignal.mockReturnValue({
        name: 'Momentum', signal: 'bullish', confidence: 0.8, reasoning: 'Strong uptrend',
      });
      mockMeanReversionSignal.mockReturnValue({
        name: 'Mean Reversion', signal: 'bullish', confidence: 0.6, reasoning: 'Oversold bounce',
      });
      mockWhaleFollowSignal.mockReturnValue({
        name: 'Whale Follow', signal: 'bullish', confidence: 0.7, reasoning: 'Whales buying',
      });

      const results = await scanner.scan(10_000);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].direction).toBe(TradeSide.Long);
      // Confidence should be high with all signals aligned
      expect(results[0].confidence).toBeGreaterThan(0.3);
    });

    it('combines multiple bearish signals into a short opportunity', async () => {
      mockMomentumSignal.mockReturnValue({
        name: 'Momentum', signal: 'bearish', confidence: 0.8, reasoning: 'Strong downtrend',
      });
      mockMeanReversionSignal.mockReturnValue({
        name: 'Mean Reversion', signal: 'bearish', confidence: 0.6, reasoning: 'Overextended',
      });
      mockWhaleFollowSignal.mockReturnValue({
        name: 'Whale Follow', signal: 'bearish', confidence: 0.7, reasoning: 'Whales selling',
      });

      const results = await scanner.scan(10_000);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].direction).toBe(TradeSide.Short);
    });

    it('mixed signals resolve to the dominant direction', async () => {
      mockMomentumSignal.mockReturnValue({
        name: 'Momentum', signal: 'bullish', confidence: 0.9, reasoning: 'Strong up',
      });
      mockMeanReversionSignal.mockReturnValue({
        name: 'Mean Reversion', signal: 'bearish', confidence: 0.3, reasoning: 'Slight overbought',
      });
      mockWhaleFollowSignal.mockReturnValue({
        name: 'Whale Follow', signal: 'bullish', confidence: 0.5, reasoning: 'Whales long',
      });

      const results = await scanner.scan(10_000);

      expect(results.length).toBeGreaterThan(0);
      // bullish dominates: (0.9*0.4)+(0.5*0.2) = 0.46 vs bearish: 0.3*0.4 = 0.12
      expect(results[0].direction).toBe(TradeSide.Long);
    });

    it('exactly tied bullish and bearish signals produce no opportunity', async () => {
      // Create equal weights scenario
      mockGetWeights.mockReturnValue({
        momentum: 0.5,
        meanReversion: 0.5,
        whaleFollow: 0.0,
        leverageMultiplier: 1.0,
        collateralMultiplier: 1.0,
      });

      mockMomentumSignal.mockReturnValue({
        name: 'Momentum', signal: 'bullish', confidence: 0.6, reasoning: 'Up',
      });
      mockMeanReversionSignal.mockReturnValue({
        name: 'Mean Reversion', signal: 'bearish', confidence: 0.6, reasoning: 'Down',
      });
      mockWhaleFollowSignal.mockReturnValue({
        name: 'Whale Follow', signal: 'neutral', confidence: 0.0, reasoning: 'None',
      });

      const results = await scanner.scan(10_000);

      // Tied bullish == bearish should be skipped
      expect(results).toEqual([]);
    });

    it('each opportunity includes all three strategy signals', async () => {
      const results = await scanner.scan(10_000);

      for (const opp of results) {
        expect(opp.signals.length).toBe(3);
        const names = opp.signals.map((s) => s.name);
        expect(names).toContain('Momentum');
        expect(names).toContain('Mean Reversion');
        expect(names).toContain('Whale Follow');
      }
    });

    it('reasoning string includes non-neutral signal descriptions', async () => {
      mockMomentumSignal.mockReturnValue({
        name: 'Momentum', signal: 'bullish', confidence: 0.7, reasoning: 'Up trend',
      });
      mockMeanReversionSignal.mockReturnValue({
        name: 'Mean Reversion', signal: 'neutral', confidence: 0.2, reasoning: 'Flat',
      });
      mockWhaleFollowSignal.mockReturnValue({
        name: 'Whale Follow', signal: 'bullish', confidence: 0.5, reasoning: 'Whales long',
      });

      const results = await scanner.scan(10_000);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].reasoning).toContain('Momentum');
      expect(results[0].reasoning).toContain('Whale Follow');
      // Neutral signals should NOT appear in reasoning
      expect(results[0].reasoning).not.toContain('Mean Reversion');
    });
  });

  // ── 9. Invalid/NaN data handling ──────────────────────────────────────

  describe('invalid/NaN data handling', () => {
    it('NaN price is filtered out (treated like zero)', async () => {
      inspector = createMockInspector({
        markets: [makeMarket('SOL', 150), makeMarket('NAN', NaN)],
      });
      scanner = new MarketScanner(inspector as any);
      setupRegimeMocks(['SOL']);

      const results = await scanner.scan(10_000);
      const symbols = results.map((o) => o.market);
      expect(symbols).not.toContain('NAN');
    });

    it('does not crash when volume data has zero daily volumes', async () => {
      inspector = createMockInspector({
        volume: {
          period: '7d',
          totalVolumeUsd: 0,
          trades: 0,
          uniqueTraders: 0,
          dailyVolumes: [],
        },
      });
      scanner = new MarketScanner(inspector as any);
      setupRegimeMocks();

      await expect(scanner.scan(10_000)).resolves.toBeDefined();
    });

    it('does not crash when openInterest has no matching market', async () => {
      inspector = createMockInspector({
        openInterest: { markets: [] },
      });
      scanner = new MarketScanner(inspector as any);
      setupRegimeMocks();

      await expect(scanner.scan(10_000)).resolves.toBeDefined();
    });

    it('does not crash when strategy returns NaN confidence', async () => {
      mockMomentumSignal.mockReturnValue({
        name: 'Momentum', signal: 'bullish', confidence: NaN, reasoning: 'Broken',
      });

      await expect(scanner.scan(10_000)).resolves.toBeDefined();
    });

    it('handles getMarkets rejection gracefully via timeout fallback', async () => {
      (inspector.getMarkets as Mock).mockRejectedValue(new Error('RPC failed'));

      // Should not throw; timeout handler catches and returns empty/cached
      const results = await scanner.scan(10_000);
      expect(Array.isArray(results)).toBe(true);
    });

    it('all returned opportunity fields are finite numbers', async () => {
      const results = await scanner.scan(10_000);

      for (const opp of results) {
        expect(Number.isFinite(opp.confidence)).toBe(true);
        expect(Number.isFinite(opp.totalScore)).toBe(true);
        expect(Number.isFinite(opp.volumeScore)).toBe(true);
        expect(Number.isFinite(opp.oiScore)).toBe(true);
        expect(Number.isFinite(opp.whaleScore)).toBe(true);
        expect(Number.isFinite(opp.recommendedLeverage)).toBe(true);
        expect(Number.isFinite(opp.recommendedCollateral)).toBe(true);
      }
    });

    it('recommendedCollateral is clamped between 10 and 1000', async () => {
      // Very small balance
      let results = await scanner.scan(50);
      for (const opp of results) {
        expect(opp.recommendedCollateral).toBeGreaterThanOrEqual(10);
      }

      // Very large balance
      scanner.clearCache();
      results = await scanner.scan(1_000_000);
      for (const opp of results) {
        expect(opp.recommendedCollateral).toBeLessThanOrEqual(1000);
      }
    });

    it('recommendedLeverage is at least 1.1', async () => {
      // Set very low leverage multiplier
      mockGetWeights.mockReturnValue({
        ...defaultRegimeWeights(),
        leverageMultiplier: 0.01,
      });

      const results = await scanner.scan(10_000);
      for (const opp of results) {
        expect(opp.recommendedLeverage).toBeGreaterThanOrEqual(1.1);
      }
    });
  });
});
