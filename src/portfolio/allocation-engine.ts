import { Opportunity, Position, TradeSide } from '../types/index.js';
import { checkCorrelation } from './correlation.js';
import {
  MAX_POSITION_ALLOCATION,
  MAX_MARKET_EXPOSURE,
  MAX_DIRECTIONAL_EXPOSURE,
  MAX_CORRELATED_EXPOSURE,
  MAX_POSITIONS,
} from '../core/risk-config.js';

/**
 * Portfolio allocation limits.
 * All values sourced from core/risk-config.ts — single source of truth.
 */
export const ALLOCATION_LIMITS = {
  MAX_POSITION_ALLOCATION,
  MAX_MARKET_EXPOSURE,
  MAX_DIRECTIONAL_EXPOSURE,
  MAX_CORRELATED_EXPOSURE,
  MAX_POSITIONS,
} as const;

export interface AllocationResult {
  collateral: number;
  leverage: number;
  reason: string;
}

export interface AllocationRejectReason {
  market: string;
  reason: string;
}

/**
 * Compute the optimal collateral for a new trade given portfolio state.
 *
 * Formula:
 *   capitalForTrade = min(freeCapital * 0.25, totalCapital * MAX_POSITION_ALLOCATION)
 *   clamp to [10, config maxPositionSize]
 */
export function computeAllocation(
  totalCapital: number,
  freeCapital: number,
  maxPositionSize: number,
): AllocationResult {
  if (totalCapital <= 0 || freeCapital <= 0) {
    return { collateral: 0, leverage: 0, reason: 'No free capital available' };
  }

  // Core formula: smaller of 25% free capital or 20% total capital
  const raw = Math.min(freeCapital * 0.25, totalCapital * ALLOCATION_LIMITS.MAX_POSITION_ALLOCATION);

  // Clamp to [10, maxPositionSize]
  const collateral = Math.min(maxPositionSize, Math.max(10, Math.round(raw)));

  if (collateral < 10) {
    return { collateral: 0, leverage: 0, reason: 'Allocation too small (< $10)' };
  }

  return {
    collateral,
    leverage: 0, // Leverage is set by the scanner/strategy — not by allocation
    reason: `Allocated $${collateral} (${((collateral / totalCapital) * 100).toFixed(1)}% of capital)`,
  };
}

export interface PortfolioFilterResult {
  accepted: Opportunity[];
  rejected: AllocationRejectReason[];
}

/**
 * Filter scanner opportunities through portfolio constraints.
 * Returns only opportunities that fit within exposure/correlation/diversification limits.
 *
 * This is the core portfolio intelligence function:
 * scanner → portfolio filter → risk check → trade
 */
export function filterOpportunities(
  opportunities: Opportunity[],
  positions: Position[],
  totalCapital: number,
  freeCapital: number,
  _maxPositionSize: number,
): PortfolioFilterResult {
  const accepted: Opportunity[] = [];
  const rejected: AllocationRejectReason[] = [];

  // Pre-compute current exposure
  const exposureByMarket: Record<string, number> = {};
  let longExposure = 0;
  let shortExposure = 0;

  for (const pos of positions) {
    if (!pos.market || !Number.isFinite(pos.sizeUsd)) continue;
    const key = pos.market.toUpperCase();
    exposureByMarket[key] = (exposureByMarket[key] ?? 0) + pos.sizeUsd;
    if (pos.side === TradeSide.Long) {
      longExposure += pos.sizeUsd;
    } else if (pos.side === TradeSide.Short) {
      shortExposure += pos.sizeUsd;
    }
  }

  const existingMarkets = new Set(positions.map((p) => p.market.toUpperCase()));

  for (const opp of opportunities) {
    const market = opp.market.toUpperCase();

    // 1. Position count limit
    if (positions.length + accepted.length >= ALLOCATION_LIMITS.MAX_POSITIONS) {
      rejected.push({ market, reason: 'Max positions reached' });
      continue;
    }

    // 2. Duplicate market check
    if (existingMarkets.has(market)) {
      rejected.push({ market, reason: 'Already holding position in this market' });
      continue;
    }

    // 3. Market exposure limit (30%)
    const currentMarketExposure = exposureByMarket[market] ?? 0;
    const maxMarketAllowed = totalCapital * ALLOCATION_LIMITS.MAX_MARKET_EXPOSURE;
    if (currentMarketExposure >= maxMarketAllowed) {
      rejected.push({
        market,
        reason: `Market exposure ${((currentMarketExposure / totalCapital) * 100).toFixed(0)}% >= ${(ALLOCATION_LIMITS.MAX_MARKET_EXPOSURE * 100).toFixed(0)}% limit`,
      });
      continue;
    }

    // 4. Directional exposure limit (60%) — includes proposed trade's notional
    const proposedNotional = Number.isFinite(opp.recommendedCollateral * opp.recommendedLeverage)
      ? opp.recommendedCollateral * opp.recommendedLeverage
      : 0;
    const directionExposure =
      opp.direction === TradeSide.Long ? longExposure + proposedNotional : shortExposure + proposedNotional;
    const maxDirectional = totalCapital * ALLOCATION_LIMITS.MAX_DIRECTIONAL_EXPOSURE;
    if (directionExposure > maxDirectional) {
      rejected.push({
        market,
        reason: `${opp.direction} exposure $${directionExposure.toFixed(0)} > ${(ALLOCATION_LIMITS.MAX_DIRECTIONAL_EXPOSURE * 100).toFixed(0)}% limit ($${maxDirectional.toFixed(0)})`,
      });
      continue;
    }

    // 5. Correlation check (30%) — includes proposed trade's notional
    const corrCheck = checkCorrelation(
      market,
      exposureByMarket,
      totalCapital,
      ALLOCATION_LIMITS.MAX_CORRELATED_EXPOSURE,
      proposedNotional,
    );
    if (!corrCheck.passed) {
      rejected.push({ market, reason: corrCheck.reason ?? 'Correlated exposure limit' });
      continue;
    }

    // 6. Free capital check
    if (freeCapital < 10) {
      rejected.push({ market, reason: 'Insufficient free capital' });
      continue;
    }

    // Passed all checks — accept
    accepted.push(opp);

    // Update running totals so subsequent opportunities are evaluated correctly
    const rawNotional = opp.recommendedCollateral * opp.recommendedLeverage;
    const notional = Number.isFinite(rawNotional) ? rawNotional : 0;
    exposureByMarket[market] = (exposureByMarket[market] ?? 0) + notional;
    if (opp.direction === TradeSide.Long) {
      longExposure += notional;
    } else {
      shortExposure += notional;
    }
    // Deduct from free capital — prevents multiple opportunities sharing the same capital
    freeCapital -= opp.recommendedCollateral;
  }

  return { accepted, rejected };
}
