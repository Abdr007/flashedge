/**
 * Market Regime Detection — Type definitions.
 *
 * Regimes classify current market conditions so strategies
 * can dynamically adjust their weights and risk parameters.
 */

export enum MarketRegime {
  TRENDING = 'TRENDING',
  RANGING = 'RANGING',
  HIGH_VOLATILITY = 'HIGH_VOLATILITY',
  LOW_VOLATILITY = 'LOW_VOLATILITY',
  WHALE_DOMINATED = 'WHALE_DOMINATED',
  LOW_LIQUIDITY = 'LOW_LIQUIDITY',
}

export interface RegimeState {
  market: string;
  trendStrength: number; // 0-1
  volatility: number; // 0-1
  liquidity: number; // 0-1
  whaleActivity: number; // 0-1 (share of whale volume)
  regime: MarketRegime;
  confidence: number; // 0-1
  timestamp: number;
}

/**
 * Strategy weight profile driven by the detected regime.
 * Used to modulate strategy contributions based on detected regime.
 */
export interface RegimeWeights {
  momentum: number;
  meanReversion: number;
  whaleFollow: number;
  leverageMultiplier: number; // 1.0 = normal, <1 = reduce
  collateralMultiplier: number; // 1.0 = normal, <1 = reduce
}

/**
 * Raw metrics fed into the regime classifier.
 */
export interface RegimeMetrics {
  priceChange1h: number;
  priceChange4h: number;
  priceChange24h: number;
  volatility: number;
  liquidityScore: number;
  whaleShare: number;
  volume24h: number;
  openInterest: number;
  tradeCount: number;
}
