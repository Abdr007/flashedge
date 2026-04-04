/**
 * Volatility detection — pure function.
 *
 * Computes volatility from a series of price returns.
 * No I/O, no side effects.
 */

export interface VolatilityInput {
  /** Array of prices ordered chronologically (oldest first). */
  prices: number[];
  /** Threshold for normalization (stddev at this value = 1.0). Default 3%. */
  threshold?: number;
}

export interface VolatilityResult {
  stddev: number; // raw standard deviation of returns
  volatility: number; // normalized 0-1
  isHighVolatility: boolean; // volatility > 0.7
  isLowVolatility: boolean; // volatility < 0.3
}

/**
 * Compute volatility from price series using standard deviation of returns.
 *
 * NOTE: Currently unused in active code paths. The regime detector uses
 * estimateVolatilityFromChange() instead since only 24h change data is available.
 * Retained for future use when full price history becomes available.
 *
 * Steps:
 * 1. Compute returns: (price[t] - price[t-1]) / price[t-1]
 * 2. Compute standard deviation of returns
 * 3. Normalize: volatility = min(stddev / threshold, 1)
 *
 * Classification:
 *   > 0.7 → HIGH_VOLATILITY
 *   < 0.3 → LOW_VOLATILITY
 *
 * If fewer than 2 valid prices, returns neutral (0.5).
 */
export function computeVolatility(input: VolatilityInput): VolatilityResult {
  const { prices, threshold = 0.03 } = input;

  // Filter to only valid finite prices
  const validPrices = prices.filter((p) => Number.isFinite(p) && p > 0);

  if (validPrices.length < 2) {
    return { stddev: 0, volatility: 0.5, isHighVolatility: false, isLowVolatility: false };
  }

  // Compute returns
  const returns: number[] = [];
  for (let i = 1; i < validPrices.length; i++) {
    returns.push((validPrices[i] - validPrices[i - 1]) / validPrices[i - 1]);
  }

  if (returns.length === 0) {
    return { stddev: 0, volatility: 0.5, isHighVolatility: false, isLowVolatility: false };
  }

  // Standard deviation
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
  const stddev = Math.sqrt(variance);

  // Normalize
  const volatility = Math.min(1, stddev / threshold);

  return {
    stddev,
    volatility,
    isHighVolatility: volatility > 0.7,
    isLowVolatility: volatility < 0.3,
  };
}

/**
 * Estimate volatility from 24h price change when full price history is unavailable.
 * This is a rough approximation: uses abs(priceChange24h) as a proxy.
 *
 * Mapping: 0% = 0, 6%+ = 1.0
 */
export function estimateVolatilityFromChange(priceChange24h: number, threshold = 6): VolatilityResult {
  if (!Number.isFinite(priceChange24h) || threshold <= 0) {
    return { stddev: 0, volatility: 0.5, isHighVolatility: false, isLowVolatility: false };
  }
  const absChange = Math.abs(priceChange24h);
  const volatility = Math.min(1, absChange / threshold);
  const stddev = absChange / 100; // rough approximation

  return {
    stddev,
    volatility,
    isHighVolatility: volatility > 0.7,
    isLowVolatility: volatility < 0.3,
  };
}
