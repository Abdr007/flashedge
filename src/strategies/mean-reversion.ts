import { StrategySignal, MarketData, OpenInterestData } from '../types/index.js';

export interface MeanReversionInput {
  market: MarketData;
  openInterest: OpenInterestData;
}

/**
 * Compute a mean-reversion signal based on OI skew and large price moves.
 * When OI is heavily skewed one direction and price has moved significantly,
 * a reversion becomes more likely.
 */
export function computeMeanReversionSignal({ market, openInterest }: MeanReversionInput): StrategySignal {
  const oi = openInterest.markets.find((m) => m.market.toUpperCase() === market.symbol.toUpperCase());

  if (!oi) {
    return {
      name: 'Mean Reversion',
      signal: 'neutral',
      confidence: 0.2,
      reasoning: 'No open interest data available for this market.',
    };
  }

  const safeLong = Number.isFinite(oi.longOi) ? oi.longOi : 0;
  const safeShort = Number.isFinite(oi.shortOi) ? oi.shortOi : 0;
  const totalOi = safeLong + safeShort;
  if (totalOi === 0) {
    return {
      name: 'Mean Reversion',
      signal: 'neutral',
      confidence: 0.2,
      reasoning: 'No open interest in this market.',
    };
  }

  const longRatio = safeLong / totalOi;
  const shortRatio = safeShort / totalOi;
  const skew = longRatio - shortRatio; // positive = long-heavy, negative = short-heavy
  const absSkew = Number.isFinite(skew) ? Math.abs(skew) : 0;
  const priceMove = Number.isFinite(market.priceChange24h) ? Math.abs(market.priceChange24h) : 0;

  let signal: 'bullish' | 'bearish' | 'neutral';
  let confidence: number;
  let reasoning: string;

  // Large price move + heavy skew = reversion opportunity
  if (priceMove > 5 && absSkew > 0.3) {
    // Price up + heavy longs → expect reversion down (bearish)
    if (market.priceChange24h > 0 && skew > 0) {
      signal = 'bearish';
      confidence = Math.min(0.8, 0.4 + absSkew * 0.5 + priceMove * 0.02);
      reasoning = `Large price increase (+${market.priceChange24h.toFixed(2)}%) with heavy long skew (${(longRatio * 100).toFixed(0)}% longs). Overcrowded — mean reversion likely.`;
    }
    // Price down + heavy shorts → expect reversion up (bullish)
    else if (market.priceChange24h < 0 && skew < 0) {
      signal = 'bullish';
      confidence = Math.min(0.8, 0.4 + absSkew * 0.5 + priceMove * 0.02);
      reasoning = `Large price drop (${market.priceChange24h.toFixed(2)}%) with heavy short skew (${(shortRatio * 100).toFixed(0)}% shorts). Short squeeze potential — mean reversion likely.`;
    } else {
      signal = 'neutral';
      confidence = 0.35;
      reasoning = `Mixed signals: price moved ${market.priceChange24h > 0 ? 'up' : 'down'} but OI skew doesn't confirm overcrowding.`;
    }
  } else if (absSkew > 0.4) {
    // Heavy skew without large price move — building pressure
    signal = skew > 0 ? 'bearish' : 'bullish';
    confidence = 0.45;
    reasoning = `OI heavily skewed ${skew > 0 ? 'long' : 'short'} (${(Math.max(longRatio, shortRatio) * 100).toFixed(0)}%). Pressure building for potential reversion.`;
  } else {
    signal = 'neutral';
    confidence = 0.3;
    reasoning = `OI is relatively balanced (${(longRatio * 100).toFixed(0)}% long / ${(shortRatio * 100).toFixed(0)}% short). No strong reversion signal.`;
  }

  return { name: 'Mean Reversion', signal, confidence, reasoning };
}
