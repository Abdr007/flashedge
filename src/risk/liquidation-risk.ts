import { Position, RiskAssessment, TradeSide } from '../types/index.js';

/**
 * Assess liquidation risk for a single position.
 * Uses directional distance (not abs) so already-liquidated positions are detected.
 * - healthy: >15% distance to liquidation
 * - warning: 5-15% distance
 * - critical: <5% distance (or already past liquidation)
 */
export function assessLiquidationRisk(position: Position): RiskAssessment {
  let distancePct = 0;

  const curPrice = Number.isFinite(position.currentPrice) ? position.currentPrice : 0;
  const liqPrice = Number.isFinite(position.liquidationPrice) ? position.liquidationPrice : 0;
  const entryPrice = Number.isFinite(position.entryPrice) ? position.entryPrice : 0;

  if (curPrice > 0 && liqPrice > 0 && entryPrice > 0) {
    // Directional distance normalized by entry price (not current price)
    // Positive means safe, negative means past liquidation
    if (position.side === TradeSide.Long) {
      distancePct = ((curPrice - liqPrice) / entryPrice) * 100;
    } else {
      distancePct = ((liqPrice - curPrice) / entryPrice) * 100;
    }
    // Final NaN guard
    if (!Number.isFinite(distancePct)) distancePct = 0;
  }

  let riskLevel: 'healthy' | 'warning' | 'critical';
  let message: string;

  if (distancePct <= 0) {
    riskLevel = 'critical';
    message = `CRITICAL: ${position.market} ${position.side} is PAST liquidation price ($${position.liquidationPrice.toFixed(2)}). Position may already be liquidated.`;
  } else if (distancePct < 5) {
    riskLevel = 'critical';
    message = `CRITICAL: ${position.market} ${position.side} is only ${distancePct.toFixed(1)}% from liquidation at $${position.liquidationPrice.toFixed(2)}. Consider adding collateral or reducing position.`;
  } else if (distancePct < 15) {
    riskLevel = 'warning';
    message = `WARNING: ${position.market} ${position.side} is ${distancePct.toFixed(1)}% from liquidation at $${position.liquidationPrice.toFixed(2)}. Monitor closely.`;
  } else {
    riskLevel = 'healthy';
    message = `${position.market} ${position.side} is ${distancePct.toFixed(1)}% from liquidation. Position looks healthy.`;
  }

  return {
    market: position.market,
    side: position.side,
    leverage: position.leverage,
    distanceToLiquidation: distancePct,
    riskLevel,
    message,
  };
}

/**
 * Assess liquidation risk for all positions.
 */
export function assessAllPositions(positions: Position[]): RiskAssessment[] {
  return positions.map(assessLiquidationRisk);
}
