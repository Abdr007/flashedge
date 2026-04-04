/**
 * Trading Gate — Master kill switch and exposure control.
 *
 * Provides two additive safety layers:
 *
 * 1. Kill Switch: TRADING_ENABLED env var. If 'false', all trades are blocked.
 *    The CLI still operates in monitoring-only mode (positions, prices, etc work).
 *
 * 2. Exposure Control: MAX_PORTFOLIO_EXPOSURE env var. If the total portfolio
 *    exposure (sum of all position sizes) would exceed this after opening a
 *    new position, the trade is rejected.
 *
 * ADDITIVE ONLY — does not modify any existing trading logic.
 * Called from the tool layer before trade execution proceeds.
 */

import { getLogger } from '../utils/logger.js';
import type { IFlashClient } from '../types/index.js';

// ─── Configuration ──────────────────────────────────────────────────────────

export interface TradingGateConfig {
  /** Master switch. If false, all trade execution is blocked. */
  tradingEnabled: boolean;
  /** Maximum total portfolio exposure (sum of position sizes) in USD. 0 = disabled. */
  maxPortfolioExposure: number;
}

function loadConfigFromEnv(): TradingGateConfig {
  const tradingEnabledRaw = (process.env.TRADING_ENABLED ?? 'true').toLowerCase().trim();
  const tradingEnabled = tradingEnabledRaw !== 'false' && tradingEnabledRaw !== '0';

  const maxExposureRaw = process.env.MAX_PORTFOLIO_EXPOSURE;
  let maxPortfolioExposure = 0;
  if (maxExposureRaw) {
    const parsed = parseFloat(maxExposureRaw);
    if (Number.isFinite(parsed) && parsed > 0) {
      maxPortfolioExposure = parsed;
    }
  }

  return { tradingEnabled, maxPortfolioExposure };
}

// ─── Check Result ───────────────────────────────────────────────────────────

export interface TradingGateCheck {
  allowed: boolean;
  reason?: string;
}

// ─── Trading Gate ───────────────────────────────────────────────────────────

export class TradingGate {
  private config: TradingGateConfig;

  constructor(config?: Partial<TradingGateConfig>) {
    const envConfig = loadConfigFromEnv();
    this.config = { ...envConfig, ...config };
  }

  /** Check the master kill switch. Must be called before any trade execution. */
  checkKillSwitch(): TradingGateCheck {
    if (!this.config.tradingEnabled) {
      return {
        allowed: false,
        reason:
          'Trading is disabled (TRADING_ENABLED=false). ' +
          'Set TRADING_ENABLED=true in .env to resume trading. ' +
          'CLI is operating in monitoring-only mode.',
      };
    }
    return { allowed: true };
  }

  /**
   * Check if a new position would exceed portfolio exposure limits.
   * @param newPositionSizeUsd - The leveraged size of the proposed new position
   * @param client - The flash client to query current positions
   */
  async checkExposure(newPositionSizeUsd: number, client: IFlashClient): Promise<TradingGateCheck> {
    if (this.config.maxPortfolioExposure <= 0) {
      return { allowed: true }; // Limit not configured
    }

    try {
      const positions = await client.getPositions();
      const currentExposure = positions.reduce((sum, p) => sum + (p.sizeUsd || 0), 0);
      const projectedExposure = currentExposure + newPositionSizeUsd;

      if (projectedExposure > this.config.maxPortfolioExposure) {
        return {
          allowed: false,
          reason:
            `Portfolio exposure limit exceeded.\n` +
            `  Current exposure: $${currentExposure.toFixed(2)}\n` +
            `  New position:     $${newPositionSizeUsd.toFixed(2)}\n` +
            `  Projected total:  $${projectedExposure.toFixed(2)}\n` +
            `  Limit:            $${this.config.maxPortfolioExposure.toFixed(2)}\n` +
            `  Adjust MAX_PORTFOLIO_EXPOSURE in .env to change this limit.`,
        };
      }

      return { allowed: true };
    } catch (err) {
      // If we can't fetch positions, don't block the trade — the on-chain
      // program is the final authority. Log the failure for investigation.
      getLogger().warn('TRADING_GATE', `Exposure check failed (non-blocking): ${err}`);
      return { allowed: true };
    }
  }

  /** Disable trading at runtime (programmatic kill switch) */
  disable(reason?: string): void {
    this.config.tradingEnabled = false;
    getLogger().warn('TRADING_GATE', `Trading disabled${reason ? `: ${reason}` : ''}`);
  }

  /** Re-enable trading at runtime */
  enable(): void {
    this.config.tradingEnabled = true;
    getLogger().info('TRADING_GATE', 'Trading re-enabled');
  }

  get tradingEnabled(): boolean {
    return this.config.tradingEnabled;
  }

  get maxPortfolioExposure(): number {
    return this.config.maxPortfolioExposure;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: TradingGate | null = null;

export function getTradingGate(): TradingGate {
  if (!_instance) {
    _instance = new TradingGate();
  }
  return _instance;
}

export function initTradingGate(config?: Partial<TradingGateConfig>): TradingGate {
  _instance = new TradingGate(config);
  return _instance;
}
