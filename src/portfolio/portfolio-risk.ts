import { Position, TradeSide, Opportunity } from '../types/index.js';
import { ALLOCATION_LIMITS } from './allocation-engine.js';
import { checkCorrelation } from './correlation.js';

export interface PortfolioRiskCheck {
  passed: boolean;
  reason?: string;
}

/**
 * Comprehensive portfolio-level risk check for a proposed trade.
 * This runs on top of existing risk-config checks.
 *
 * Checks:
 * 1. Max positions (5)
 * 2. Max exposure ($2000 or config)
 * 3. Max capital per market (30%)
 * 4. Max long/short imbalance (60%)
 * 5. Max correlated exposure (30%)
 * 6. Max leverage exposure
 */
export function checkPortfolioRisk(params: {
  opportunity: Opportunity;
  positions: Position[];
  totalCapital: number;
  maxExposure: number;
}): PortfolioRiskCheck {
  const { opportunity, positions, totalCapital, maxExposure } = params;

  if (!Number.isFinite(totalCapital) || totalCapital <= 0) {
    return { passed: false, reason: 'Invalid or zero capital' };
  }

  const market = opportunity.market.toUpperCase();
  const rawNotional = opportunity.recommendedCollateral * opportunity.recommendedLeverage;
  const notional = Number.isFinite(rawNotional) ? rawNotional : 0;
  if (notional <= 0) {
    return { passed: false, reason: 'Invalid notional value (zero or NaN)' };
  }

  // 1. Max positions
  if (positions.length >= ALLOCATION_LIMITS.MAX_POSITIONS) {
    return { passed: false, reason: `Max positions (${ALLOCATION_LIMITS.MAX_POSITIONS}) reached` };
  }

  // 2. Compute current exposure
  let longExposure = 0;
  let shortExposure = 0;
  const exposureByMarket: Record<string, number> = {};

  for (const pos of positions) {
    const key = pos.market.toUpperCase();
    exposureByMarket[key] = (exposureByMarket[key] ?? 0) + pos.sizeUsd;
    if (pos.side === TradeSide.Long) {
      longExposure += pos.sizeUsd;
    } else {
      shortExposure += pos.sizeUsd;
    }
  }

  const currentTotalExposure = longExposure + shortExposure;

  // 3. Total exposure limit
  if (currentTotalExposure + notional > maxExposure) {
    return {
      passed: false,
      reason: `New exposure $${(currentTotalExposure + notional).toFixed(0)} exceeds max $${maxExposure}`,
    };
  }

  // 4. Market concentration limit (30%)
  const currentMarketExp = exposureByMarket[market] ?? 0;
  const maxMarket = totalCapital * ALLOCATION_LIMITS.MAX_MARKET_EXPOSURE;
  if (currentMarketExp + notional > maxMarket) {
    return {
      passed: false,
      reason: `Market ${market} exposure $${(currentMarketExp + notional).toFixed(0)} exceeds ${(ALLOCATION_LIMITS.MAX_MARKET_EXPOSURE * 100).toFixed(0)}% limit ($${maxMarket.toFixed(0)})`,
    };
  }

  // 5. Directional imbalance (60%)
  const newLong = opportunity.direction === TradeSide.Long ? longExposure + notional : longExposure;
  const newShort = opportunity.direction === TradeSide.Short ? shortExposure + notional : shortExposure;
  const maxDirectional = totalCapital * ALLOCATION_LIMITS.MAX_DIRECTIONAL_EXPOSURE;

  if (newLong > maxDirectional) {
    return {
      passed: false,
      reason: `Long exposure $${newLong.toFixed(0)} exceeds ${(ALLOCATION_LIMITS.MAX_DIRECTIONAL_EXPOSURE * 100).toFixed(0)}% limit ($${maxDirectional.toFixed(0)})`,
    };
  }
  if (newShort > maxDirectional) {
    return {
      passed: false,
      reason: `Short exposure $${newShort.toFixed(0)} exceeds ${(ALLOCATION_LIMITS.MAX_DIRECTIONAL_EXPOSURE * 100).toFixed(0)}% limit ($${maxDirectional.toFixed(0)})`,
    };
  }

  // 6. Correlation check — includes proposed trade's notional
  const corrCheck = checkCorrelation(
    market,
    exposureByMarket,
    totalCapital,
    ALLOCATION_LIMITS.MAX_CORRELATED_EXPOSURE,
    notional,
  );
  if (!corrCheck.passed) {
    return { passed: false, reason: corrCheck.reason };
  }

  return { passed: true };
}
