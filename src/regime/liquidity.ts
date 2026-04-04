/**
 * Liquidity analysis — pure function.
 *
 * Computes liquidity score from volume, open interest, and trade count.
 * No I/O, no side effects.
 */

export interface LiquidityInput {
  volume24h: number;
  openInterest: number;
  tradeCount: number;
  /** Reference values for normalization. Uses Flash Trade typical ranges. */
  volumeRef?: number;
  oiRef?: number;
  tradeRef?: number;
}

export interface LiquidityResult {
  volumeNormalized: number;
  oiNormalized: number;
  tradeCountNormalized: number;
  liquidityScore: number; // 0-1
  isLowLiquidity: boolean; // score < 0.3
}

/**
 * Compute liquidity score from three components.
 *
 * Formula:
 *   liquidityScore =
 *     (volumeNormalized × 0.5) +
 *     (oiNormalized × 0.3) +
 *     (tradeCountNormalized × 0.2)
 *
 * Normalization: each metric is divided by a reference value, clamped 0-1.
 * Reference values represent "healthy" levels for Flash Trade.
 *
 * Classification:
 *   < 0.3 → LOW_LIQUIDITY
 */
export function computeLiquidity(input: LiquidityInput): LiquidityResult {
  const {
    volume24h,
    openInterest,
    tradeCount,
    volumeRef = 5_000_000, // $5M daily volume = fully liquid
    oiRef = 10_000_000, // $10M OI = fully liquid
    tradeRef = 1000, // 1000 trades/day = fully liquid
  } = input;

  const safeDiv = (a: number, b: number): number => (b > 0 && Number.isFinite(a) ? a / b : 0);
  const volumeNormalized = Math.min(1, Math.max(0, safeDiv(volume24h, volumeRef)));
  const oiNormalized = Math.min(1, Math.max(0, safeDiv(openInterest, oiRef)));
  const tradeCountNormalized = Math.min(1, Math.max(0, safeDiv(tradeCount, tradeRef)));

  const liquidityScore = volumeNormalized * 0.5 + oiNormalized * 0.3 + tradeCountNormalized * 0.2;

  return {
    volumeNormalized,
    oiNormalized,
    tradeCountNormalized,
    liquidityScore,
    isLowLiquidity: liquidityScore < 0.3,
  };
}
