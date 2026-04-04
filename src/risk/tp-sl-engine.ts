/**
 * TP/SL Engine — Take-Profit and Stop-Loss automation.
 *
 * Observes positions and valuation prices, triggers existing close pipeline
 * when TP or SL conditions are met. Runs as an isolated observer module —
 * never modifies trading logic.
 *
 * Evaluation is dual-path:
 *   1. Called from the risk monitor tick (if active)
 *   2. Self-polls positions via IFlashClient.getPositions() when targets are set
 *      (auto-starts/stops, uses .unref() so it won't prevent exit)
 *
 * Safety features:
 *   - Spike protection: requires 2 consecutive confirmation ticks
 *   - Duplicate protection: triggered flag prevents re-execution
 *   - Pre-trigger validation: position exists, circuit breaker clear, not already closing
 *   - Session-scoped: targets cleared on terminal restart
 */

import chalk from 'chalk';
import { IFlashClient, Position, TradeSide } from '../types/index.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';
import { getCircuitBreaker } from '../security/circuit-breaker.js';
import { getTradingGate } from '../security/trading-gate.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TpSlTarget {
  tp?: number;
  sl?: number;
  triggered: boolean;
  confirmationTicks: number;
}

export type CloseReason = 'TAKE_PROFIT' | 'STOP_LOSS';

/** Callback to execute a close. Provided by the terminal at init time. */
export type CloseExecutor = (market: string, side: TradeSide, reason: CloseReason) => Promise<void>;

// ─── Constants ───────────────────────────────────────────────────────────────

const REQUIRED_CONFIRMATION_TICKS = 2;
const POLL_INTERVAL_MS = 5_000; // 5 seconds — matches risk monitor cadence

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: TpSlEngine | null = null;

export function getTpSlEngine(): TpSlEngine {
  if (!_instance) {
    _instance = new TpSlEngine();
  }
  return _instance;
}

export function resetTpSlEngine(): void {
  if (_instance) {
    _instance.stop();
  }
  _instance = null;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export class TpSlEngine {
  private targets = new Map<string, TpSlTarget>();
  private closeExecutor: CloseExecutor | null = null;
  private closingKeys = new Set<string>();
  private client: IFlashClient | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInProgress = false;

  /** Register the close executor (called once at terminal init). */
  setCloseExecutor(executor: CloseExecutor): void {
    this.closeExecutor = executor;
  }

  /** Register the flash client for self-polling. */
  setClient(client: IFlashClient): void {
    this.client = client;
  }

  /** Stop the self-polling timer. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ─── Target Management ──────────────────────────────────────────────

  static makeKey(market: string, side: string): string {
    return `${market.toUpperCase()}-${side.toLowerCase()}`;
  }

  setTarget(market: string, side: string, tp?: number, sl?: number): string {
    const key = TpSlEngine.makeKey(market, side);
    const existing = this.targets.get(key);

    const target: TpSlTarget = {
      tp: tp ?? existing?.tp,
      sl: sl ?? existing?.sl,
      triggered: false,
      confirmationTicks: 0,
    };

    if (target.tp === undefined && target.sl === undefined) {
      return chalk.yellow(`  No TP or SL value provided.`);
    }

    this.targets.set(key, target);
    this.ensurePolling();

    const parts: string[] = [];
    if (target.tp !== undefined) parts.push(`TP: $${target.tp.toFixed(2)}`);
    if (target.sl !== undefined) parts.push(`SL: $${target.sl.toFixed(2)}`);

    return [
      '',
      chalk.green(`  TP/SL set for ${market.toUpperCase()} ${side.toUpperCase()}`),
      chalk.dim(`  ${parts.join('  |  ')}`),
      '',
    ].join('\n');
  }

  removeTarget(market: string, side: string, type: 'tp' | 'sl'): string {
    const key = TpSlEngine.makeKey(market, side);
    const existing = this.targets.get(key);

    if (!existing) {
      return chalk.yellow(`  No TP/SL targets set for ${market.toUpperCase()} ${side.toUpperCase()}.`);
    }

    if (type === 'tp') {
      existing.tp = undefined;
    } else {
      existing.sl = undefined;
    }

    // Reset confirmation state when target changes
    existing.confirmationTicks = 0;
    existing.triggered = false;

    // Remove entry entirely if both are cleared
    if (existing.tp === undefined && existing.sl === undefined) {
      this.targets.delete(key);
      this.maybeStopPolling();
      return chalk.green(`  All TP/SL targets removed for ${market.toUpperCase()} ${side.toUpperCase()}.`);
    }

    return chalk.green(`  ${type.toUpperCase()} removed for ${market.toUpperCase()} ${side.toUpperCase()}.`);
  }

  getTargets(): Map<string, TpSlTarget> {
    return new Map(this.targets);
  }

  getTarget(market: string, side: string): TpSlTarget | undefined {
    return this.targets.get(TpSlEngine.makeKey(market, side));
  }

  hasActiveTargets(): boolean {
    for (const t of this.targets.values()) {
      if (!t.triggered) return true;
    }
    return false;
  }

  // ─── Self-Polling ───────────────────────────────────────────────────

  /** Start position polling if not already running and there are active targets. */
  private ensurePolling(): void {
    if (this.pollTimer) return;
    if (!this.client) return;

    this.pollTimer = setInterval(() => {
      this.pollTick().catch((err) => {
        getLogger().debug('TP_SL', `Poll tick error: ${getErrorMessage(err)}`);
      });
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  /** Stop polling if no active targets remain. */
  private maybeStopPolling(): void {
    if (!this.hasActiveTargets()) {
      this.stop();
    }
  }

  /** Single poll tick: fetch positions and evaluate. */
  private async pollTick(): Promise<void> {
    if (this.pollInProgress || !this.client) return;
    if (!this.hasActiveTargets()) {
      this.stop();
      return;
    }
    this.pollInProgress = true;
    try {
      const positions = await this.client.getPositions();
      await this.evaluate(positions);
    } catch (err) {
      getLogger().debug('TP_SL', `Position fetch failed: ${getErrorMessage(err)}`);
    } finally {
      this.pollInProgress = false;
    }
  }

  // ─── Evaluation (called from risk monitor tick OR self-poll) ────────

  async evaluate(positions: Position[]): Promise<void> {
    if (this.targets.size === 0) return;

    const logger = getLogger();

    for (const pos of positions) {
      const key = TpSlEngine.makeKey(pos.market, pos.side);
      const target = this.targets.get(key);

      if (!target) continue;
      if (target.triggered) continue;

      // Use the same valuation price used by the position engine
      // (markPrice = currentPrice from Pyth oracle, same as PnL/liq calculations)
      const valuationPrice = pos.markPrice > 0 ? pos.markPrice : pos.currentPrice;
      if (!Number.isFinite(valuationPrice) || valuationPrice <= 0) continue;

      let conditionMet = false;
      let reason: CloseReason | null = null;

      if (pos.side === TradeSide.Long) {
        if (target.tp !== undefined && valuationPrice >= target.tp) {
          conditionMet = true;
          reason = 'TAKE_PROFIT';
        } else if (target.sl !== undefined && valuationPrice <= target.sl) {
          conditionMet = true;
          reason = 'STOP_LOSS';
        }
      } else {
        // SHORT: TP when price drops, SL when price rises
        if (target.tp !== undefined && valuationPrice <= target.tp) {
          conditionMet = true;
          reason = 'TAKE_PROFIT';
        } else if (target.sl !== undefined && valuationPrice >= target.sl) {
          conditionMet = true;
          reason = 'STOP_LOSS';
        }
      }

      if (conditionMet) {
        target.confirmationTicks += 1;
      } else {
        target.confirmationTicks = 0;
      }

      // Spike protection: require N consecutive ticks
      if (!conditionMet || target.confirmationTicks < REQUIRED_CONFIRMATION_TICKS) {
        continue;
      }

      // ── Pre-trigger validation ───────────────────────────────────────

      // Already closing this position?
      if (this.closingKeys.has(key)) continue;

      // Circuit breaker check
      const breaker = getCircuitBreaker();
      const breakerCheck = breaker.check();
      if (!breakerCheck.allowed) {
        logger.warn('TP_SL', `${reason} trigger blocked by circuit breaker: ${breakerCheck.reason}`);
        continue;
      }

      // Kill switch check
      const gate = getTradingGate();
      const killCheck = gate.checkKillSwitch();
      if (!killCheck.allowed) {
        logger.warn('TP_SL', `${reason} trigger blocked by kill switch: ${killCheck.reason}`);
        continue;
      }

      // No close executor registered
      if (!this.closeExecutor) {
        logger.warn('TP_SL', `${reason} condition met for ${key} but no close executor registered`);
        continue;
      }

      // ── Trigger ──────────────────────────────────────────────────────

      target.triggered = true;
      this.closingKeys.add(key);

      const side = pos.side === TradeSide.Long ? TradeSide.Long : TradeSide.Short;

      logger.info('TP_SL', `${reason} triggered for ${pos.market} ${pos.side} at $${valuationPrice.toFixed(4)}`);
      process.stdout.write(
        chalk.bold.yellow(`\n  [TP/SL] ${reason} triggered for ${pos.market} ${pos.side.toUpperCase()}`) +
          chalk.dim(` — price: $${valuationPrice.toFixed(4)}`) +
          chalk.dim(` — executing close...\n`),
      );

      // Fire-and-forget close execution (non-blocking for other positions)
      this.executeClose(pos.market, side, reason!, key).catch((err) => {
        logger.warn('TP_SL', `Close execution failed for ${key}: ${getErrorMessage(err)}`);
      });
    }

    // Auto-stop polling when all targets are triggered
    this.maybeStopPolling();
  }

  private async executeClose(market: string, side: TradeSide, reason: CloseReason, key: string): Promise<void> {
    try {
      await this.closeExecutor!(market, side, reason);
    } finally {
      this.closingKeys.delete(key);
    }
  }
}
