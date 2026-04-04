/**
 * Trend detection — pure function.
 *
 * Computes trend strength from multi-timeframe price changes.
 * No I/O, no side effects.
 */

export interface TrendInput {
  priceChange1h: number; // percentage
  priceChange4h: number; // percentage
  priceChange24h: number; // percentage
}

export interface TrendResult {
  trendScore: number; // raw weighted % score
  trendStrength: number; // normalized 0-1
  isTrending: boolean; // trendScore > 5%
  isRanging: boolean; // trendScore < 2%
}

/**
 * Compute trend strength from price momentum across timeframes.
 *
 * Formula:
 *   trendScore = abs(1h) * 0.4 + abs(4h) * 0.4 + abs(24h) * 0.2
 *
 * Classification:
 *   > 5% → TRENDING
 *   < 2% → RANGING
 *   2-5% → neither (transitional)
 *
 * Returns normalized trendStrength 0-1 (capped at 10% = 1.0).
 */
export function computeTrend(input: TrendInput): TrendResult {
  const priceChange1h = Number.isFinite(input.priceChange1h) ? input.priceChange1h : 0;
  const priceChange4h = Number.isFinite(input.priceChange4h) ? input.priceChange4h : 0;
  const priceChange24h = Number.isFinite(input.priceChange24h) ? input.priceChange24h : 0;

  const trendScore = Math.abs(priceChange1h) * 0.4 + Math.abs(priceChange4h) * 0.4 + Math.abs(priceChange24h) * 0.2;

  // Normalize: 0% = 0, 10% = 1.0
  const trendStrength = Math.min(1, trendScore / 10);

  return {
    trendScore,
    trendStrength,
    isTrending: trendScore > 5,
    isRanging: trendScore < 2,
  };
}
