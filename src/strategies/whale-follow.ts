import { StrategySignal } from '../types/index.js';

export interface WhaleActivity {
  market: string;
  side: string;
  sizeUsd: number;
  timestamp: number;
}

export interface WhaleFollowInput {
  recentActivity: WhaleActivity[];
  openPositions: WhaleActivity[];
  targetMarket: string;
}

const WHALE_SIZE_THRESHOLD = 10_000; // $10K minimum to consider "whale"
const MAX_WHALE_EVENTS = 100; // Cap input arrays to prevent unbounded processing

/**
 * Compute a whale-follow signal by tracking direction of large positions.
 */
export function computeWhaleFollowSignal({
  recentActivity,
  openPositions,
  targetMarket,
}: WhaleFollowInput): StrategySignal {
  const marketUpper = targetMarket.toUpperCase();

  // Cap input arrays before processing
  const cappedActivity = recentActivity.slice(0, MAX_WHALE_EVENTS);
  const cappedPositions = openPositions.slice(0, MAX_WHALE_EVENTS);

  // Filter for whale-size activities in this market
  const whaleActivity = cappedActivity.filter(
    (a) => a.market.toUpperCase() === marketUpper && a.sizeUsd >= WHALE_SIZE_THRESHOLD,
  );

  const whalePositions = cappedPositions.filter(
    (p) => p.market.toUpperCase() === marketUpper && p.sizeUsd >= WHALE_SIZE_THRESHOLD,
  );

  const totalWhales = whaleActivity.length + whalePositions.length;

  if (totalWhales === 0) {
    return {
      name: 'Whale Follow',
      signal: 'neutral',
      confidence: 0.2,
      reasoning: `No significant whale activity detected in ${marketUpper}.`,
    };
  }

  // Deduplicate: use a Set to avoid counting the same position in both activity and open
  const seen = new Set<string>();
  const dedupedWhales: WhaleActivity[] = [];

  for (const a of [...whaleActivity, ...whalePositions]) {
    const key = `${a.market}:${a.side}:${a.sizeUsd}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedupedWhales.push(a);
    }
  }

  // Count long vs short by volume dominance (not count)
  // Only count known sides; unknown sides are excluded from both numerator and denominator
  let longVolume = 0;
  let shortVolume = 0;
  let longCount = 0;
  let shortCount = 0;

  for (const a of dedupedWhales) {
    const side = a.side.toLowerCase();
    if (side === 'long') {
      longCount++;
      longVolume += Number.isFinite(a.sizeUsd) ? a.sizeUsd : 0;
    } else if (side === 'short') {
      shortCount++;
      shortVolume += Number.isFinite(a.sizeUsd) ? a.sizeUsd : 0;
    }
    // Unknown sides excluded from both volumes — prevents skewed percentages
  }

  const totalVolume = longVolume + shortVolume;
  const longPct = totalVolume > 0 ? (longVolume / totalVolume) * 100 : 50;
  const shortPct = 100 - longPct;

  let signal: 'bullish' | 'bearish' | 'neutral';
  let confidence: number;
  let reasoning: string;

  // Volume-dominance only (removed count-based trigger that could contradict volume)
  if (longPct > 70) {
    signal = 'bullish';
    confidence = Math.min(0.8, 0.4 + (longPct - 50) * 0.008 + Math.min(dedupedWhales.length, 10) * 0.03);
    reasoning = `Whales are heavily long in ${marketUpper}: ${longCount} long vs ${shortCount} short positions (${longPct.toFixed(0)}% long by volume). Following whale direction.`;
  } else if (shortPct > 70) {
    signal = 'bearish';
    confidence = Math.min(0.8, 0.4 + (shortPct - 50) * 0.008 + Math.min(dedupedWhales.length, 10) * 0.03);
    reasoning = `Whales are heavily short in ${marketUpper}: ${shortCount} short vs ${longCount} long positions (${shortPct.toFixed(0)}% short by volume). Following whale direction.`;
  } else {
    signal = 'neutral';
    confidence = 0.35;
    reasoning = `Mixed whale activity in ${marketUpper}: ${longCount} long, ${shortCount} short (${longPct.toFixed(0)}/${shortPct.toFixed(0)}% volume). No clear directional bias.`;
  }

  return { name: 'Whale Follow', signal, confidence, reasoning };
}
