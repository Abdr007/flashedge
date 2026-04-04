/**
 * Shadow Trading Engine — parallel simulation of live trades.
 *
 * Duplicates trade requests and executes them through a SimulatedFlashClient
 * to compute hypothetical PnL without affecting live state.
 *
 * COMPLETELY ISOLATED from the live pipeline:
 *   - Never submits transactions
 *   - Never modifies wallet state
 *   - Never interacts with signing logic
 *   - Crashes are caught and logged, never propagated
 *
 * Configuration:
 *   SHADOW_TRADING=true  — enable shadow system
 *   Default: disabled
 */

import { SimulatedFlashClient } from '../client/simulation.js';
import { TradeSide, Position } from '../types/index.js';
import { getLogger } from '../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ShadowTradeResult {
  action: 'open' | 'close' | 'add_collateral' | 'remove_collateral';
  market: string;
  side: TradeSide;
  success: boolean;
  shadowPnl?: number;
  shadowBalance?: number;
  entryPrice?: number;
  exitPrice?: number;
  error?: string;
  latencyMs: number;
}

export interface ShadowState {
  enabled: boolean;
  balance: number;
  positions: Position[];
  totalRealizedPnl: number;
  tradeCount: number;
}

// ─── Shadow Engine ───────────────────────────────────────────────────────────

export class ShadowEngine {
  private client: SimulatedFlashClient;
  private enabled: boolean;
  private tradeCount = 0;
  private totalRealizedPnl = 0;

  constructor(initialBalance = 10_000) {
    this.enabled = (process.env.SHADOW_TRADING ?? '').toLowerCase() === 'true';
    this.client = new SimulatedFlashClient(initialBalance);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Shadow-execute an open position. Returns result or null if disabled. */
  async shadowOpen(
    market: string,
    side: TradeSide,
    collateral: number,
    leverage: number,
  ): Promise<ShadowTradeResult | null> {
    if (!this.enabled) return null;

    const start = Date.now();
    try {
      const result = await this.client.openPosition(market, side, collateral, leverage);
      this.tradeCount++;
      return {
        action: 'open',
        market,
        side,
        success: true,
        shadowBalance: this.client.getBalance(),
        entryPrice: result.entryPrice,
        latencyMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        action: 'open',
        market,
        side,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }

  /** Shadow-execute a close position. */
  async shadowClose(market: string, side: TradeSide): Promise<ShadowTradeResult | null> {
    if (!this.enabled) return null;

    const start = Date.now();
    try {
      const result = await this.client.closePosition(market, side);
      this.tradeCount++;
      this.totalRealizedPnl += result.pnl;
      return {
        action: 'close',
        market,
        side,
        success: true,
        shadowPnl: result.pnl,
        shadowBalance: this.client.getBalance(),
        exitPrice: result.exitPrice,
        latencyMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        action: 'close',
        market,
        side,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }

  /** Shadow-execute add collateral. */
  async shadowAddCollateral(market: string, side: TradeSide, amount: number): Promise<ShadowTradeResult | null> {
    if (!this.enabled) return null;

    const start = Date.now();
    try {
      await this.client.addCollateral(market, side, amount);
      this.tradeCount++;
      return {
        action: 'add_collateral',
        market,
        side,
        success: true,
        shadowBalance: this.client.getBalance(),
        latencyMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        action: 'add_collateral',
        market,
        side,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }

  /** Shadow-execute remove collateral. */
  async shadowRemoveCollateral(market: string, side: TradeSide, amount: number): Promise<ShadowTradeResult | null> {
    if (!this.enabled) return null;

    const start = Date.now();
    try {
      await this.client.removeCollateral(market, side, amount);
      this.tradeCount++;
      return {
        action: 'remove_collateral',
        market,
        side,
        success: true,
        shadowBalance: this.client.getBalance(),
        latencyMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        action: 'remove_collateral',
        market,
        side,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }

  /** Get current shadow positions. */
  async getPositions(): Promise<Position[]> {
    if (!this.enabled) return [];
    try {
      return await this.client.getPositions();
    } catch {
      return [];
    }
  }

  /** Get shadow state snapshot. */
  async getState(): Promise<ShadowState> {
    return {
      enabled: this.enabled,
      balance: this.enabled ? this.client.getBalance() : 0,
      positions: await this.getPositions(),
      totalRealizedPnl: this.totalRealizedPnl,
      tradeCount: this.tradeCount,
    };
  }

  /** Enable shadow trading at runtime. */
  enable(): void {
    this.enabled = true;
    try {
      getLogger().info('SHADOW', 'Shadow trading enabled');
    } catch {
      /* never throw */
    }
  }

  /** Disable shadow trading at runtime. */
  disable(): void {
    this.enabled = false;
    try {
      getLogger().info('SHADOW', 'Shadow trading disabled');
    } catch {
      /* never throw */
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: ShadowEngine | null = null;

export function getShadowEngine(): ShadowEngine {
  if (!_instance) {
    _instance = new ShadowEngine();
  }
  return _instance;
}

export function initShadowEngine(initialBalance?: number): ShadowEngine {
  _instance = new ShadowEngine(initialBalance);
  return _instance;
}
