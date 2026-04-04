/**
 * Risk Mirror — compares shadow state vs live state for divergence detection.
 *
 * Observes both the shadow engine and the live client to detect:
 *   - PnL divergence beyond threshold
 *   - Position count mismatches
 *   - Exposure drift
 *   - Liquidation estimate differences
 *
 * OBSERVE ONLY — never modifies live risk controls.
 * All comparisons are fire-and-forget with error isolation.
 */

import { Position, IFlashClient } from '../types/index.js';
import { ShadowEngine } from './shadow-engine.js';
import { getLogger } from '../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RiskDivergence {
  type: 'position_count' | 'pnl' | 'exposure' | 'liquidation';
  message: string;
  liveValue: number;
  shadowValue: number;
  delta: number;
  timestamp: string;
}

export interface RiskMirrorSnapshot {
  divergences: RiskDivergence[];
  livePositionCount: number;
  shadowPositionCount: number;
  liveExposure: number;
  shadowExposure: number;
  timestamp: string;
}

// ─── Configuration ───────────────────────────────────────────────────────────

export interface RiskMirrorConfig {
  /** PnL divergence threshold (USD) before warning. */
  pnlThresholdUsd: number;
  /** Exposure divergence threshold (USD) before warning. */
  exposureThresholdUsd: number;
  /** Liquidation price divergence threshold (%) before warning. */
  liqThresholdPercent: number;
}

const DEFAULT_CONFIG: RiskMirrorConfig = {
  pnlThresholdUsd: 1.0,
  exposureThresholdUsd: 10.0,
  liqThresholdPercent: 5.0,
};

// ─── Risk Mirror ─────────────────────────────────────────────────────────────

export class RiskMirror {
  private config: RiskMirrorConfig;
  private divergenceHistory: RiskDivergence[] = [];
  private static readonly MAX_HISTORY = 200;

  constructor(config?: Partial<RiskMirrorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Compare live positions against shadow positions.
   * Returns detected divergences (empty = aligned).
   */
  async compare(liveClient: IFlashClient, shadowEngine: ShadowEngine): Promise<RiskMirrorSnapshot> {
    const now = new Date().toISOString();
    const divergences: RiskDivergence[] = [];

    let livePositions: Position[];
    let shadowPositions: Position[];

    try {
      livePositions = await liveClient.getPositions();
    } catch {
      // Live fetch failure — skip comparison
      return {
        divergences: [],
        livePositionCount: 0,
        shadowPositionCount: 0,
        liveExposure: 0,
        shadowExposure: 0,
        timestamp: now,
      };
    }

    try {
      shadowPositions = await shadowEngine.getPositions();
    } catch {
      return {
        divergences: [],
        livePositionCount: livePositions.length,
        shadowPositionCount: 0,
        liveExposure: 0,
        shadowExposure: 0,
        timestamp: now,
      };
    }

    // Position count divergence
    if (livePositions.length !== shadowPositions.length) {
      divergences.push({
        type: 'position_count',
        message: `Position count mismatch: live=${livePositions.length} shadow=${shadowPositions.length}`,
        liveValue: livePositions.length,
        shadowValue: shadowPositions.length,
        delta: Math.abs(livePositions.length - shadowPositions.length),
        timestamp: now,
      });
    }

    // Exposure divergence
    const liveExposure = livePositions.reduce((s, p) => s + (Number.isFinite(p.sizeUsd) ? p.sizeUsd : 0), 0);
    const shadowExposure = shadowPositions.reduce((s, p) => s + (Number.isFinite(p.sizeUsd) ? p.sizeUsd : 0), 0);

    if (Math.abs(liveExposure - shadowExposure) > this.config.exposureThresholdUsd) {
      divergences.push({
        type: 'exposure',
        message: `Exposure divergence: live=$${liveExposure.toFixed(2)} shadow=$${shadowExposure.toFixed(2)}`,
        liveValue: liveExposure,
        shadowValue: shadowExposure,
        delta: Math.abs(liveExposure - shadowExposure),
        timestamp: now,
      });
    }

    // Per-position PnL and liquidation divergence
    for (const livePos of livePositions) {
      const shadowPos = shadowPositions.find((p) => p.market === livePos.market && p.side === livePos.side);
      if (!shadowPos) continue;

      // PnL divergence
      const pnlDelta = Math.abs(livePos.unrealizedPnl - shadowPos.unrealizedPnl);
      if (pnlDelta > this.config.pnlThresholdUsd) {
        divergences.push({
          type: 'pnl',
          message: `PnL divergence on ${livePos.market} ${livePos.side}: live=$${livePos.unrealizedPnl.toFixed(4)} shadow=$${shadowPos.unrealizedPnl.toFixed(4)}`,
          liveValue: livePos.unrealizedPnl,
          shadowValue: shadowPos.unrealizedPnl,
          delta: pnlDelta,
          timestamp: now,
        });
      }

      // Liquidation price divergence
      if (livePos.liquidationPrice > 0 && shadowPos.liquidationPrice > 0) {
        const liqDeltaPct =
          (Math.abs(livePos.liquidationPrice - shadowPos.liquidationPrice) / livePos.liquidationPrice) * 100;
        if (liqDeltaPct > this.config.liqThresholdPercent) {
          divergences.push({
            type: 'liquidation',
            message: `Liq price divergence on ${livePos.market} ${livePos.side}: live=$${livePos.liquidationPrice.toFixed(2)} shadow=$${shadowPos.liquidationPrice.toFixed(2)} (${liqDeltaPct.toFixed(1)}%)`,
            liveValue: livePos.liquidationPrice,
            shadowValue: shadowPos.liquidationPrice,
            delta: liqDeltaPct,
            timestamp: now,
          });
        }
      }
    }

    // Log divergences
    if (divergences.length > 0) {
      try {
        const logger = getLogger();
        for (const d of divergences) {
          logger.warn('RISK_MIRROR', d.message, {
            type: d.type,
            liveValue: d.liveValue,
            shadowValue: d.shadowValue,
            delta: d.delta,
          });
        }
      } catch {
        /* logging must never throw */
      }

      // Store in history (bounded)
      for (const d of divergences) {
        this.divergenceHistory.push(d);
      }
      while (this.divergenceHistory.length > RiskMirror.MAX_HISTORY) {
        this.divergenceHistory.shift();
      }
    }

    return {
      divergences,
      livePositionCount: livePositions.length,
      shadowPositionCount: shadowPositions.length,
      liveExposure,
      shadowExposure,
      timestamp: now,
    };
  }

  /** Get recent divergences. */
  getHistory(limit?: number): ReadonlyArray<RiskDivergence> {
    const n = limit ?? RiskMirror.MAX_HISTORY;
    return this.divergenceHistory.slice(-n);
  }

  /** Get divergence count by type. */
  getDivergenceCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const d of this.divergenceHistory) {
      counts[d.type] = (counts[d.type] ?? 0) + 1;
    }
    return counts;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: RiskMirror | null = null;

export function getRiskMirror(): RiskMirror {
  if (!_instance) {
    _instance = new RiskMirror();
  }
  return _instance;
}

export function initRiskMirror(config?: Partial<RiskMirrorConfig>): RiskMirror {
  _instance = new RiskMirror(config);
  return _instance;
}
