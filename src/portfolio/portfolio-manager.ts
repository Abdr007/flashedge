import { Position, TradeSide, Opportunity } from '../types/index.js';
import { computeAllocation, filterOpportunities } from './allocation-engine.js';
import { checkPortfolioRisk } from './portfolio-risk.js';
import { analyzeRebalance, RebalanceResult } from './rebalance.js';
import { getLogger } from '../utils/logger.js';

/**
 * Portfolio state snapshot — computed from live data on each call.
 * Not cached (< 1ms to compute from existing data).
 */
export interface PortfolioState {
  totalCapital: number;
  allocatedCapital: number;
  freeCapital: number;
  positions: PortfolioPosition[];
  exposureByMarket: Record<string, number>;
  exposureLong: number;
  exposureShort: number;
  positionCount: number;
  utilizationPct: number;
}

export interface PortfolioPosition {
  market: string;
  side: TradeSide;
  entryPrice: number;
  leverage: number;
  collateral: number;
  notional: number;
  timestamp: number;
  pnlPct: number;
}

/**
 * Portfolio Intelligence Engine.
 *
 * Provides portfolio-level capital management on top of the existing
 * scanner → risk → trade pipeline. Pure computation — no RPC calls,
 * no trade execution. Uses only data already fetched by SolanaInspector.
 */
export class PortfolioManager {
  /**
   * Compute current portfolio state from positions and balance.
   * Runs in < 1ms — no I/O.
   */
  getState(positions: Position[], balance: number): PortfolioState {
    const exposureByMarket: Record<string, number> = {};
    let exposureLong = 0;
    let exposureShort = 0;
    let allocatedCapital = 0;

    const portfolioPositions: PortfolioPosition[] = [];

    for (const pos of positions) {
      const key = pos.market.toUpperCase();
      const notional = Number.isFinite(pos.sizeUsd) ? pos.sizeUsd : 0;
      const collateral = Number.isFinite(pos.collateralUsd) ? pos.collateralUsd : 0;

      exposureByMarket[key] = (exposureByMarket[key] ?? 0) + notional;
      allocatedCapital += collateral;

      if (pos.side === TradeSide.Long) {
        exposureLong += notional;
      } else {
        exposureShort += notional;
      }

      portfolioPositions.push({
        market: pos.market,
        side: pos.side,
        entryPrice: Number.isFinite(pos.entryPrice) ? pos.entryPrice : 0,
        leverage: Number.isFinite(pos.leverage) ? pos.leverage : 0,
        collateral,
        notional,
        timestamp: pos.timestamp,
        pnlPct: Number.isFinite(pos.unrealizedPnlPercent) ? pos.unrealizedPnlPercent : 0,
      });
    }

    const safeBalance = Number.isFinite(balance) ? balance : 0;
    const totalCapital = safeBalance + allocatedCapital;
    const freeCapital = Math.max(0, safeBalance);
    const utilizationPct = totalCapital > 0 ? (allocatedCapital / totalCapital) * 100 : 0;

    return {
      totalCapital,
      allocatedCapital,
      freeCapital,
      positions: portfolioPositions,
      exposureByMarket,
      exposureLong,
      exposureShort,
      positionCount: positions.length,
      utilizationPct,
    };
  }

  /**
   * Evaluate scanner opportunities through portfolio constraints.
   * Returns the best opportunity that fits, or null if none qualify.
   *
   * Flow:
   * 1. Compute portfolio state
   * 2. Filter opportunities by allocation/correlation/exposure limits
   * 3. Apply portfolio risk check to the best candidate
   * 4. Compute optimal allocation size
   *
   * Returns the opportunity with adjusted collateral, or null.
   */
  evaluate(
    opportunities: Opportunity[],
    positions: Position[],
    balance: number,
    maxPositionSize: number,
    maxExposure: number,
  ): Opportunity | null {
    const logger = getLogger();
    const state = this.getState(positions, balance);

    if (state.freeCapital < 10) {
      logger.info('PORTFOLIO', 'No free capital for new trades');
      return null;
    }

    // 1. Filter through portfolio constraints
    const { accepted, rejected } = filterOpportunities(
      opportunities,
      positions,
      state.totalCapital,
      state.freeCapital,
      maxPositionSize,
    );

    if (rejected.length > 0) {
      logger.debug(
        'PORTFOLIO',
        `Rejected ${rejected.length} opportunities: ${rejected.map((r) => `${r.market}(${r.reason})`).join(', ')}`,
      );
    }

    if (accepted.length === 0) {
      logger.info('PORTFOLIO', 'No opportunities passed portfolio constraints');
      return null;
    }

    // 2. Take the best (already sorted by scanner score)
    const best = accepted[0];

    // 3. Portfolio risk check
    const riskCheck = checkPortfolioRisk({
      opportunity: best,
      positions,
      totalCapital: state.totalCapital,
      maxExposure,
    });

    if (!riskCheck.passed) {
      logger.info('PORTFOLIO', `Best opportunity ${best.market} blocked by portfolio risk: ${riskCheck.reason}`);
      return null;
    }

    // 4. Compute optimal allocation
    const allocation = computeAllocation(state.totalCapital, state.freeCapital, maxPositionSize);

    if (allocation.collateral <= 0) {
      logger.info('PORTFOLIO', 'Allocation engine returned zero — skipping');
      return null;
    }

    // 5. Return opportunity with adjusted collateral
    logger.info('PORTFOLIO', `Selected ${best.market} ${best.direction} — ${allocation.reason}`);

    return {
      ...best,
      recommendedCollateral: allocation.collateral,
    };
  }

  /**
   * Analyze portfolio balance and suggest rebalancing actions.
   */
  analyzeRebalance(positions: Position[], balance: number): RebalanceResult {
    const state = this.getState(positions, balance);
    return analyzeRebalance(positions, state.totalCapital);
  }
}
