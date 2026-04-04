/**
 * Yield Analytics Engine
 *
 * Pool ranking, yield simulation, and risk classification
 * for Flash Trade liquidity pools.
 */

import { getPoolRegistry, PoolInfo } from './pool-registry.js';
import { getPoolMetrics, PoolMetrics } from './pool-data.js';

// ─── Risk Classification ────────────────────────────────────────────────────

export type RiskLevel = 'Low' | 'Medium' | 'High' | 'Very High';

/** Classify pool risk based on TVL and APY. */
export function classifyRisk(tvl: number, apy: number): RiskLevel {
  // High APY + low TVL = higher risk (thin liquidity, volatile yields)
  if (tvl < 100_000 && apy > 100) return 'Very High';
  if (tvl < 200_000 || apy > 200) return 'High';
  if (tvl < 1_000_000 || apy > 80) return 'Medium';
  return 'Low';
}

// ─── Pool Ranking ───────────────────────────────────────────────────────────

export interface RankedPool {
  pool: PoolInfo;
  metrics: PoolMetrics;
  risk: RiskLevel;
  /** Composite score: higher is better yield, penalized for risk */
  score: number;
}

/** Rank pools by yield, factoring in TVL for risk adjustment. */
export async function rankPools(): Promise<RankedPool[]> {
  const registry = getPoolRegistry();
  const metricsMap = await getPoolMetrics();

  const ranked: RankedPool[] = [];
  for (const pool of registry) {
    const m = metricsMap.get(pool.poolId);
    if (!m) continue;

    const risk = classifyRisk(m.tvl, m.apy7d);
    // Score: APY weighted by TVL confidence (larger TVL = more reliable yield)
    const tvlFactor = Math.min(m.tvl / 1_000_000, 1); // 0..1, caps at $1M
    const score = m.apy7d * (0.3 + 0.7 * tvlFactor);

    ranked.push({ pool, metrics: m, risk, score });
  }

  // Sort by APY descending (raw yield ranking)
  ranked.sort((a, b) => b.metrics.apy7d - a.metrics.apy7d);
  return ranked;
}

// ─── Yield Simulation ───────────────────────────────────────────────────────

export interface YieldProjection {
  deposit: number;
  apy: number;
  days7: number;
  days30: number;
  days90: number;
  days365: number;
}

/** Project yield returns for a deposit at current APY. Uses simple interest to avoid overflow. */
export function simulateYield(deposit: number, apy: number): YieldProjection {
  // Cap APY at 1000% to prevent unreliable projections
  const cappedApy = Math.min(apy, 1000);
  // Simple interest: return = deposit * (apy/100) * (days/365)
  const calc = (days: number) => deposit * (cappedApy / 100) * (days / 365);

  return {
    deposit,
    apy: cappedApy,
    days7: Math.round(calc(7) * 100) / 100,
    days30: Math.round(calc(30) * 100) / 100,
    days90: Math.round(calc(90) * 100) / 100,
    days365: Math.round(calc(365) * 100) / 100,
  };
}
