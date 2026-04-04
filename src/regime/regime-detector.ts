import { MarketData, VolumeData, OpenInterestData } from '../types/index.js';
import { MarketRegime, RegimeState, RegimeWeights } from './regime-types.js';
import { computeTrend } from './trend.js';
import { estimateVolatilityFromChange } from './volatility.js';
import { computeLiquidity } from './liquidity.js';

/**
 * Market Regime Detector.
 *
 * Pure computation layer — no I/O, no RPC calls.
 * Uses data already fetched by SolanaInspector.
 *
 * Regime classification priority:
 * 1. HIGH_VOLATILITY (most dangerous — takes precedence)
 * 2. LOW_LIQUIDITY   (thin markets — caution)
 * 3. WHALE_DOMINATED (whale-driven moves)
 * 4. TRENDING        (strong directional move)
 * 5. RANGING         (mean-reversion territory)
 * 6. LOW_VOLATILITY  (quiet markets)
 */
export class RegimeDetector {
  private cache = new Map<string, { state: RegimeState; expiry: number }>();
  private static readonly CACHE_TTL = 30_000; // 30s
  private static readonly MAX_CACHE = 50;

  /**
   * Detect market regime for a single market.
   * Uses cached market data — no I/O.
   */
  detectRegime(
    market: MarketData,
    volume: VolumeData,
    openInterest: OpenInterestData,
    whaleVolume = 0,
    totalVolume = 0,
  ): RegimeState {
    const key = market.symbol.toUpperCase();
    const now = Date.now();

    // Check cache
    const cached = this.cache.get(key);
    if (cached && now < cached.expiry) {
      return cached.state;
    }

    // 1. Trend detection
    // We only have 24h change from MarketData, so estimate shorter timeframes
    // by scaling: 1h ≈ 24h/6, 4h ≈ 24h/2 (rough heuristic for available data)
    const priceChange24h = Number.isFinite(market.priceChange24h) ? market.priceChange24h : 0;
    const trend = computeTrend({
      priceChange1h: priceChange24h / 6, // estimated
      priceChange4h: priceChange24h / 2, // estimated
      priceChange24h,
    });

    // 2. Volatility detection (from 24h change proxy)
    const vol = estimateVolatilityFromChange(priceChange24h);

    // 3. Liquidity analysis
    const oi = openInterest.markets.find((m) => m.market.toUpperCase() === key);
    const totalOi = oi ? oi.longOi + oi.shortOi : 0;

    // Volume: use last day from dailyVolumes if available
    const lastDay = volume.dailyVolumes.length > 0 ? volume.dailyVolumes[volume.dailyVolumes.length - 1] : null;
    const vol24h = lastDay?.volumeUsd ?? 0;
    const tradeCount = lastDay?.trades ?? 0; // Only use daily trade count, not lifetime

    const liq = computeLiquidity({
      volume24h: vol24h,
      openInterest: totalOi,
      tradeCount,
    });

    // 4. Whale dominance
    const whaleShare = totalVolume > 0 ? Math.min(1, whaleVolume / totalVolume) : 0;

    // 5. Classify regime (priority order)
    const { regime, confidence } = this.classifyRegime(
      trend.trendStrength,
      trend.isTrending,
      trend.isRanging,
      vol.volatility,
      vol.isHighVolatility,
      vol.isLowVolatility,
      liq.liquidityScore,
      liq.isLowLiquidity,
      whaleShare,
    );

    const state: RegimeState = {
      market: key,
      trendStrength: trend.trendStrength,
      volatility: vol.volatility,
      liquidity: liq.liquidityScore,
      whaleActivity: whaleShare,
      regime,
      confidence,
      timestamp: now,
    };

    // Cache with eviction
    if (this.cache.size > RegimeDetector.MAX_CACHE) {
      for (const [k, entry] of this.cache) {
        if (entry.expiry <= now) this.cache.delete(k);
      }
      // If still over capacity, remove oldest entries
      if (this.cache.size > RegimeDetector.MAX_CACHE) {
        const toRemove = this.cache.size - RegimeDetector.MAX_CACHE;
        const keys = Array.from(this.cache.keys());
        for (let i = 0; i < toRemove; i++) {
          this.cache.delete(keys[i]);
        }
      }
    }
    this.cache.set(key, { state, expiry: now + RegimeDetector.CACHE_TTL });

    return state;
  }

  /**
   * Detect regimes for all markets in a single pass.
   */
  detectAll(
    markets: MarketData[],
    volume: VolumeData,
    openInterest: OpenInterestData,
    whaleVolumeByMarket: Map<string, number> = new Map(),
    totalVolumeByMarket: Map<string, number> = new Map(),
  ): Map<string, RegimeState> {
    const result = new Map<string, RegimeState>();
    for (const market of markets) {
      const key = market.symbol.toUpperCase();
      const state = this.detectRegime(
        market,
        volume,
        openInterest,
        whaleVolumeByMarket.get(key) ?? 0,
        totalVolumeByMarket.get(key) ?? 0,
      );
      result.set(key, state);
    }
    return result;
  }

  /**
   * Get dynamic strategy weights for a given regime.
   */
  getWeights(regime: MarketRegime): RegimeWeights {
    switch (regime) {
      case MarketRegime.TRENDING:
        return {
          momentum: 0.7,
          meanReversion: 0.2,
          whaleFollow: 0.1,
          leverageMultiplier: 1.0,
          collateralMultiplier: 1.0,
        };

      case MarketRegime.RANGING:
        return {
          momentum: 0.2,
          meanReversion: 0.6,
          whaleFollow: 0.2,
          leverageMultiplier: 1.0,
          collateralMultiplier: 1.0,
        };

      case MarketRegime.HIGH_VOLATILITY:
        return {
          momentum: 0.4,
          meanReversion: 0.3,
          whaleFollow: 0.3,
          leverageMultiplier: 0.7, // reduce leverage by 30%
          collateralMultiplier: 1.0,
        };

      case MarketRegime.LOW_VOLATILITY:
        return {
          momentum: 0.3,
          meanReversion: 0.5,
          whaleFollow: 0.2,
          leverageMultiplier: 1.0,
          collateralMultiplier: 1.0,
        };

      case MarketRegime.WHALE_DOMINATED:
        return {
          momentum: 0.2,
          meanReversion: 0.2,
          whaleFollow: 0.6,
          leverageMultiplier: 0.85, // slightly reduce leverage
          collateralMultiplier: 1.0,
        };

      case MarketRegime.LOW_LIQUIDITY:
        return {
          momentum: 0.3,
          meanReversion: 0.4,
          whaleFollow: 0.3,
          leverageMultiplier: 0.7,
          collateralMultiplier: 0.5, // reduce collateral by 50%
        };

      default:
        // Safety net: return balanced weights for any unexpected regime value
        return {
          momentum: 0.4,
          meanReversion: 0.4,
          whaleFollow: 0.2,
          leverageMultiplier: 1.0,
          collateralMultiplier: 1.0,
        };
    }
  }

  /** Clear the regime cache. */
  clearCache(): void {
    this.cache.clear();
  }

  private classifyRegime(
    trendStrength: number,
    isTrending: boolean,
    isRanging: boolean,
    volatility: number,
    isHighVol: boolean,
    isLowVol: boolean,
    liquidityScore: number,
    isLowLiq: boolean,
    whaleShare: number,
  ): { regime: MarketRegime; confidence: number } {
    // Priority 1: HIGH_VOLATILITY — most dangerous
    if (isHighVol) {
      return { regime: MarketRegime.HIGH_VOLATILITY, confidence: volatility };
    }

    // Priority 2: LOW_LIQUIDITY — thin markets
    if (isLowLiq) {
      return { regime: MarketRegime.LOW_LIQUIDITY, confidence: 1 - liquidityScore };
    }

    // Priority 3: WHALE_DOMINATED
    if (whaleShare > 0.35) {
      return { regime: MarketRegime.WHALE_DOMINATED, confidence: whaleShare };
    }

    // Priority 4: TRENDING
    if (isTrending) {
      return { regime: MarketRegime.TRENDING, confidence: trendStrength };
    }

    // Priority 5: RANGING
    if (isRanging) {
      return { regime: MarketRegime.RANGING, confidence: 1 - trendStrength };
    }

    // Priority 6: LOW_VOLATILITY
    if (isLowVol) {
      return { regime: MarketRegime.LOW_VOLATILITY, confidence: 1 - volatility };
    }

    // Default: ranging with moderate confidence
    return { regime: MarketRegime.RANGING, confidence: 0.5 };
  }
}
