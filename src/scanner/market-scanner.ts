import { MarketData, VolumeData, OpenInterestData, Opportunity, TradeSide, StrategySignal } from '../types/index.js';
import { SolanaInspector } from '../agent/solana-inspector.js';
import { computeMomentumSignal } from '../strategies/momentum.js';
import { computeMeanReversionSignal } from '../strategies/mean-reversion.js';
import { computeWhaleFollowSignal, WhaleActivity } from '../strategies/whale-follow.js';
import { RegimeDetector } from '../regime/regime-detector.js';
import { MarketRegime } from '../regime/regime-types.js';
import { getLogger } from '../utils/logger.js';

const SCAN_CACHE_TTL = 30_000; // 30s cache
const SCAN_TIMEOUT_MS = 15_000; // 15s max per scan cycle

/**
 * Compute opportunity score from component signals.
 *
 * Formula:
 *   score = (signalConfidence × 0.5) + (volumeStrength × 0.2)
 *         + (openInterestTrend × 0.2) + (whaleActivity × 0.1)
 *
 * All inputs are 0-1 normalized. Output is 0-1.
 */
function computeScore(
  signalConfidence: number,
  volumeStrength: number,
  oiTrend: number,
  whaleActivity: number,
): number {
  return signalConfidence * 0.5 + volumeStrength * 0.2 + oiTrend * 0.2 + whaleActivity * 0.1;
}

/**
 * Compute a 0-1 volume strength score from recent daily volume data.
 * Compares last 3 days average to prior 3 days. Returns 0.5 if insufficient data.
 */
function computeVolumeStrength(volume: VolumeData): number {
  const dailies = volume.dailyVolumes;
  if (dailies.length < 6) return 0.5;

  const recent = dailies.slice(-3).reduce((s, d) => s + d.volumeUsd, 0) / 3;
  const prior = dailies.slice(-6, -3).reduce((s, d) => s + d.volumeUsd, 0) / 3;

  if (prior === 0) return 0.5;
  const growth = (recent - prior) / prior;
  // Clamp to 0-1: -100% = 0, 0% = 0.5, +100% = 1
  return Math.min(1, Math.max(0, 0.5 + growth * 0.5));
}

/**
 * Compute a 0-1 OI trend score based on skew magnitude.
 * Higher skew (imbalance) = higher score.
 */
function computeOiScore(market: MarketData, openInterest: OpenInterestData): number {
  const oi = openInterest.markets.find((m) => m.market.toUpperCase() === market.symbol.toUpperCase());
  if (!oi) return 0.5;

  const total = oi.longOi + oi.shortOi;
  if (total === 0) return 0.5;

  const longRatio = oi.longOi / total;
  const skew = Math.abs(longRatio - 0.5) * 2; // 0 = balanced, 1 = max skew
  return Math.min(1, 0.3 + skew * 0.7);
}

/**
 * Compute a 0-1 whale activity score based on whale signal confidence.
 */
function computeWhaleScore(signal: StrategySignal): number {
  if (signal.signal === 'neutral') return 0.3;
  return Math.min(1, 0.3 + signal.confidence * 0.7);
}

/**
 * Build a human-readable explanation for an opportunity.
 */
function buildReasoning(signals: StrategySignal[]): string {
  const parts: string[] = [];
  for (const sig of signals) {
    if (sig.signal !== 'neutral') {
      parts.push(`${sig.name}: ${sig.signal} (${(sig.confidence * 100).toFixed(0)}%)`);
    }
  }
  if (parts.length === 0) return 'No strong directional signals.';
  return parts.join('. ') + '.';
}

/**
 * Market Scanner — scans all available markets, runs strategies,
 * and returns ranked trade opportunities.
 *
 * Thread-safe: uses SolanaInspector caching (no extra RPC load).
 * Does NOT execute trades — only provides opportunity data.
 */
export class MarketScanner {
  private inspector: SolanaInspector;
  private regimeDetector: RegimeDetector;
  private cachedResults: Opportunity[] | null = null;
  private cacheExpiry = 0;
  /** Mutex: prevents overlapping concurrent scans from wasting RPC quota */
  private scanInProgress: Promise<Opportunity[]> | null = null;

  constructor(inspector: SolanaInspector) {
    this.inspector = inspector;
    this.regimeDetector = new RegimeDetector();
  }

  /**
   * Scan all markets and return ranked opportunities.
   * Results are cached for 30 seconds to avoid redundant RPC calls.
   * Concurrent calls share the same in-flight promise (scan mutex).
   */
  async scan(balance: number, topN = 10): Promise<Opportunity[]> {
    const now = Date.now();
    if (this.cachedResults && now < this.cacheExpiry) {
      return this.cachedResults;
    }

    // If a scan is already in progress, wait for it instead of starting a new one
    if (this.scanInProgress) {
      return this.scanInProgress;
    }

    this.scanInProgress = this.doScanWithTimeout(balance, topN);
    try {
      return await this.scanInProgress;
    } finally {
      this.scanInProgress = null;
    }
  }

  private async doScanWithTimeout(balance: number, topN: number): Promise<Opportunity[]> {
    const logger = getLogger();
    try {
      return await Promise.race([
        this.doScan(balance, topN),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('scan timeout')), SCAN_TIMEOUT_MS)),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown';
      logger.warn('SCANNER', `Scan aborted: ${msg} — returning cached or empty results`);
      return this.cachedResults ?? [];
    }
  }

  private async doScan(balance: number, topN: number): Promise<Opportunity[]> {
    const logger = getLogger();
    const startTime = Date.now();

    // Fetch all data in parallel (leverages SolanaInspector's internal caches)
    const [markets, volume, openInterest, recentActivity, openPositions] = await Promise.all([
      this.inspector.getMarkets(),
      this.inspector.getVolume(),
      this.inspector.getOpenInterest(),
      this.inspector.getRecentActivity(50),
      this.inspector.getOpenPositions(),
    ]);

    // Filter out markets with zero/missing prices — never trade on fabricated data
    const validMarkets = markets.filter((m) => m.price > 0 && Number.isFinite(m.price));
    if (validMarkets.length === 0) {
      logger.info('SCANNER', 'No market data with valid prices available');
      return [];
    }
    if (validMarkets.length < markets.length) {
      logger.info('SCANNER', `Excluded ${markets.length - validMarkets.length} markets with missing/zero prices`);
    }

    // Normalize whale data once (shared across all market evaluations)
    // Unknown sides are preserved as-is — whale-follow strategy ignores non-long/short
    const whaleRecent: WhaleActivity[] = recentActivity
      .filter((a) => {
        const s = String(a.side ?? '').toLowerCase();
        return s === 'long' || s === 'short';
      })
      .map((a) => ({
        market: String(a.market_symbol ?? a.market ?? ''),
        side: String(a.side),
        sizeUsd: Number(a.size_usd ?? 0),
        timestamp: Number(a.timestamp ?? Date.now()),
      }));
    const whaleOpen: WhaleActivity[] = openPositions
      .filter((p) => {
        const s = String(p.side ?? '').toLowerCase();
        return s === 'long' || s === 'short';
      })
      .map((p) => ({
        market: String(p.market_symbol ?? p.market ?? ''),
        side: String(p.side),
        sizeUsd: Number(p.size_usd ?? 0),
        timestamp: Number(p.timestamp ?? Date.now()),
      }));

    const volumeStrength = computeVolumeStrength(volume);

    // Compute whale volume per market for regime detection
    const whaleVolumeByMarket = new Map<string, number>();
    for (const w of [...whaleRecent, ...whaleOpen]) {
      const key = w.market.toUpperCase();
      whaleVolumeByMarket.set(key, (whaleVolumeByMarket.get(key) ?? 0) + w.sizeUsd);
    }

    // Total volume per market from daily data
    const totalVolumeByMarket = new Map<string, number>();
    // Use 24h volume from last day as proxy for total
    const lastDayVol =
      volume.dailyVolumes.length > 0 ? volume.dailyVolumes[volume.dailyVolumes.length - 1].volumeUsd : 0;
    for (const m of validMarkets) {
      totalVolumeByMarket.set(m.symbol.toUpperCase(), lastDayVol / Math.max(1, validMarkets.length));
    }

    // Detect regimes for all markets in a single pass
    const regimes = this.regimeDetector.detectAll(
      validMarkets,
      volume,
      openInterest,
      whaleVolumeByMarket,
      totalVolumeByMarket,
    );

    // Evaluate each market
    const opportunities: Opportunity[] = [];

    for (const market of validMarkets) {
      const momentum = computeMomentumSignal({ market, volume });
      const meanReversion = computeMeanReversionSignal({ market, openInterest });
      const whaleSignal = computeWhaleFollowSignal({
        recentActivity: whaleRecent,
        openPositions: whaleOpen,
        targetMarket: market.symbol,
      });

      const signals: StrategySignal[] = [momentum, meanReversion, whaleSignal];

      // Get regime weights for this market (getWeights always returns a value)
      const regimeState = regimes.get(market.symbol.toUpperCase());
      const regime = regimeState?.regime ?? MarketRegime.RANGING;
      const weights = this.regimeDetector.getWeights(regime);
      const safeW = (v: number, fb: number) => (Number.isFinite(v) ? v : fb);

      // Regime-weighted direction consensus (guard NaN from upstream)
      const strategyWeights = [
        safeW(weights.momentum, 0.4),
        safeW(weights.meanReversion, 0.4),
        safeW(weights.whaleFollow, 0.2),
      ];
      let bullish = 0;
      let bearish = 0;
      for (let i = 0; i < signals.length; i++) {
        const s = signals[i];
        const w = strategyWeights[i];
        if (s.signal === 'bullish') bullish += s.confidence * w;
        else if (s.signal === 'bearish') bearish += s.confidence * w;
      }

      // Skip if all neutral or exactly tied (no directional bias)
      if (bullish === 0 && bearish === 0) continue;
      if (bullish === bearish) continue;

      const direction = bullish > bearish ? TradeSide.Long : TradeSide.Short;
      const confidence = Math.max(bullish, bearish) / (bullish + bearish + 0.5);
      const oiScore = computeOiScore(market, openInterest);
      const whaleScore = computeWhaleScore(whaleSignal);

      const totalScore = computeScore(confidence, volumeStrength, oiScore, whaleScore);

      // Conservative leverage based on confidence, adjusted by regime
      let leverage: number;
      if (confidence >= 0.65) leverage = 3;
      else if (confidence >= 0.4) leverage = 2;
      else leverage = 1.5;
      leverage = Math.max(1.1, leverage * weights.leverageMultiplier);

      // Collateral: 5% of balance, clamped $10-$1000, adjusted by regime
      const collateral = Math.min(1000, Math.max(10, Math.round(balance * 0.05 * weights.collateralMultiplier)));

      opportunities.push({
        market: market.symbol,
        direction,
        confidence,
        volumeScore: volumeStrength,
        oiScore,
        whaleScore,
        totalScore,
        recommendedLeverage: leverage,
        recommendedCollateral: collateral,
        signals,
        reasoning: buildReasoning(signals),
        regime,
      });
    }

    // Sort by totalScore descending
    opportunities.sort((a, b) => b.totalScore - a.totalScore);
    const results = opportunities.slice(0, topN);

    // Cache results
    this.cachedResults = results;
    this.cacheExpiry = Date.now() + SCAN_CACHE_TTL;

    const elapsed = Date.now() - startTime;
    logger.info(
      'SCANNER',
      `Scanned ${validMarkets.length} markets in ${elapsed}ms — ${results.length} opportunities found`,
    );

    // Log top opportunities
    for (const opp of results.slice(0, 5)) {
      logger.info(
        'SCANNER',
        `${opp.market} ${opp.direction.toUpperCase()} confidence=${opp.confidence.toFixed(2)} score=${opp.totalScore.toFixed(2)}`,
      );
    }

    return results;
  }

  /** Clear scanner cache (useful for testing or force-refresh). */
  clearCache(): void {
    this.cachedResults = null;
    this.cacheExpiry = 0;
  }
}
