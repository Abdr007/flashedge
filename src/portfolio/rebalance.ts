import { Position, TradeSide } from '../types/index.js';
import {
  REBALANCE_CONCENTRATION_TRIGGER,
  REBALANCE_DIRECTIONAL_TRIGGER,
  MAX_MARKET_EXPOSURE,
} from '../core/risk-config.js';

export interface RebalanceAction {
  type: 'reduce_collateral' | 'close_position' | 'info';
  market: string;
  side: TradeSide;
  reason: string;
  amount?: number; // For reduce_collateral: how much to remove
}

export interface RebalanceResult {
  balanced: boolean;
  longPct: number;
  shortPct: number;
  directionalBias: string;
  actions: RebalanceAction[];
}

/**
 * Analyze portfolio balance and suggest rebalancing actions.
 *
 * Uses sequential evaluation to prevent contradictory suggestions:
 *   1. Detect directional imbalance
 *   2. Simulate position closures (remove from working set)
 *   3. Recompute exposure after simulated closures
 *   4. Detect concentration on remaining positions
 *   5. Generate minimal corrective actions
 *
 * This function is pure — it does NOT execute any trades.
 */
export function analyzeRebalance(positions: Position[], totalCapital: number): RebalanceResult {
  if (positions.length === 0 || !Number.isFinite(totalCapital) || totalCapital <= 0) {
    return {
      balanced: true,
      longPct: 0,
      shortPct: 0,
      directionalBias: 'none',
      actions: [],
    };
  }

  // ── Step 1: Compute initial exposure ──
  let longExposure = 0;
  let shortExposure = 0;

  for (const pos of positions) {
    if (!pos.market || !Number.isFinite(pos.sizeUsd)) continue;
    if (pos.side === TradeSide.Long) {
      longExposure += pos.sizeUsd;
    } else if (pos.side === TradeSide.Short) {
      shortExposure += pos.sizeUsd;
    }
  }

  const totalExposure = longExposure + shortExposure;
  const longPct = totalExposure > 0 ? (longExposure / totalExposure) * 100 : 0;
  const shortPct = totalExposure > 0 ? (shortExposure / totalExposure) * 100 : 0;

  const actions: RebalanceAction[] = [];
  let balanced = true;

  // ── Step 2: Directional imbalance → suggest weakest closure ──
  const closedKeys = new Set<string>();

  if (longPct > REBALANCE_DIRECTIONAL_TRIGGER) {
    balanced = false;
    const longs = positions
      .filter((p) => p.side === TradeSide.Long)
      .sort((a, b) => (a.unrealizedPnlPercent || 0) - (b.unrealizedPnlPercent || 0));

    if (longs.length > 0) {
      const weakest = longs[0];
      actions.push({
        type: 'close_position',
        market: weakest.market,
        side: TradeSide.Long,
        reason: `Long-heavy (${longPct.toFixed(0)}%): close weakest long ${weakest.market} (PnL: ${weakest.unrealizedPnlPercent.toFixed(1)}%)`,
      });
      closedKeys.add(`${weakest.market}:${weakest.side}`);
    }
  }

  if (shortPct > REBALANCE_DIRECTIONAL_TRIGGER) {
    balanced = false;
    const shorts = positions
      .filter((p) => p.side === TradeSide.Short)
      .sort((a, b) => (a.unrealizedPnlPercent || 0) - (b.unrealizedPnlPercent || 0));

    if (shorts.length > 0) {
      const weakest = shorts[0];
      actions.push({
        type: 'close_position',
        market: weakest.market,
        side: TradeSide.Short,
        reason: `Short-heavy (${shortPct.toFixed(0)}%): close weakest short ${weakest.market} (PnL: ${weakest.unrealizedPnlPercent.toFixed(1)}%)`,
      });
      closedKeys.add(`${weakest.market}:${weakest.side}`);
    }
  }

  // ── Step 3: Recompute exposure AFTER simulated closures ──
  const remainingPositions = positions.filter((p) => !closedKeys.has(`${p.market}:${p.side}`));

  const remainingExposure = new Map<string, number>();
  for (const pos of remainingPositions) {
    if (!pos.market || !Number.isFinite(pos.sizeUsd)) continue;
    const current = remainingExposure.get(pos.market) ?? 0;
    remainingExposure.set(pos.market, current + pos.sizeUsd);
  }

  // ── Step 4: Concentration check on remaining positions ──
  // Use totalCapital as denominator (not remainingTotal) so concentration
  // is measured against total portfolio, preventing false triggers when
  // portfolio is mostly cash.
  for (const [market, exposure] of remainingExposure.entries()) {
    const pct = totalCapital > 0 ? exposure / totalCapital : 0;
    if (pct > REBALANCE_CONCENTRATION_TRIGGER) {
      balanced = false;
      const marketPositions = remainingPositions
        .filter((p) => p.market === market)
        .sort((a, b) => (a.unrealizedPnlPercent || 0) - (b.unrealizedPnlPercent || 0));

      if (marketPositions.length > 0) {
        const target = marketPositions[0];
        const reductionTarget = exposure - totalCapital * MAX_MARKET_EXPOSURE;
        if (reductionTarget > 0) {
          actions.push({
            type: 'reduce_collateral',
            market: target.market,
            side: target.side,
            amount: Math.round(Math.max(10, target.leverage > 0 ? reductionTarget / target.leverage : reductionTarget)),
            reason: `${market} concentration ${(pct * 100).toFixed(0)}%: reduce by ~$${Math.round(reductionTarget)}`,
          });
        }
      }
    }
  }

  // ── Step 5: Directional bias label ──
  let directionalBias: string;
  if (longPct > 60 && shortPct > 0) directionalBias = `${(longPct / shortPct).toFixed(1)}:1 Long`;
  else if (longPct > 60) directionalBias = 'Long Only';
  else if (shortPct > 60 && longPct > 0) directionalBias = `${(shortPct / longPct).toFixed(1)}:1 Short`;
  else if (shortPct > 60) directionalBias = 'Short Only';
  else directionalBias = 'Balanced';

  return {
    balanced,
    longPct,
    shortPct,
    directionalBias,
    actions,
  };
}
