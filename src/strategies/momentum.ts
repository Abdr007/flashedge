import { StrategySignal, MarketData, VolumeData } from '../types/index.js';

export interface MomentumInput {
  market: MarketData;
  volume: VolumeData;
}

/**
 * Compute a momentum signal based on price direction and volume trend.
 * Compares the last 3 days of volume against the previous 3 days.
 */
export function computeMomentumSignal({ market, volume }: MomentumInput): StrategySignal {
  const dailyVols = volume.dailyVolumes;

  // Need at least 6 days of data for comparison
  if (dailyVols.length < 6) {
    return {
      name: 'Momentum',
      signal: 'neutral',
      confidence: 0.3,
      reasoning: 'Insufficient volume history for momentum analysis.',
    };
  }

  const recent3 = dailyVols.slice(-3);
  const prev3 = dailyVols.slice(-6, -3);

  const recentAvg = recent3.reduce((s, d) => s + d.volumeUsd, 0) / 3;
  const prevAvg = prev3.reduce((s, d) => s + d.volumeUsd, 0) / 3;
  const rawGrowth = prevAvg > 0 ? (recentAvg - prevAvg) / prevAvg : 0;
  const volumeGrowth = Number.isFinite(rawGrowth) ? rawGrowth : 0;
  const safePriceChange = Number.isFinite(market.priceChange24h) ? market.priceChange24h : 0;

  const priceUp = safePriceChange > 0;
  const priceDown = safePriceChange < 0;
  const priceFlat = safePriceChange === 0;
  const volumeUp = volumeGrowth > 0.1; // 10% growth threshold
  const volumeDown = volumeGrowth < -0.1;

  let signal: 'bullish' | 'bearish' | 'neutral';
  let confidence: number;
  let reasoning: string;

  if (priceFlat) {
    // Flat price is ambiguous regardless of volume — always neutral
    signal = 'neutral';
    confidence = 0.3;
    reasoning = `Price unchanged (0.00%) with volume ${volumeUp ? 'rising' : volumeDown ? 'declining' : 'flat'}. No directional momentum.`;
  } else if (priceUp && volumeUp) {
    signal = 'bullish';
    confidence = Math.min(0.85, 0.5 + Math.abs(volumeGrowth) * 0.5);
    reasoning = `Price rising (+${safePriceChange.toFixed(2)}%) with increasing volume (+${(volumeGrowth * 100).toFixed(1)}%). Strong upward momentum.`;
  } else if (priceDown && volumeUp) {
    signal = 'bearish';
    confidence = Math.min(0.8, 0.5 + Math.abs(volumeGrowth) * 0.4);
    reasoning = `Price falling (${safePriceChange.toFixed(2)}%) with increasing volume (+${(volumeGrowth * 100).toFixed(1)}%). Selling pressure intensifying.`;
  } else if (priceUp && volumeDown) {
    signal = 'neutral';
    confidence = 0.4;
    reasoning = `Price rising but volume declining (${(volumeGrowth * 100).toFixed(1)}%). Momentum may be weakening.`;
  } else if (!priceUp && volumeDown) {
    signal = 'neutral';
    confidence = 0.4;
    reasoning = `Price and volume both declining. Market losing interest, possible consolidation.`;
  } else {
    signal = 'neutral';
    confidence = 0.3;
    reasoning = 'No clear momentum signal detected.';
  }

  return { name: 'Momentum', signal, confidence, reasoning };
}
