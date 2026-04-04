/**
 * Limit Order Engine — session-scoped limit order automation.
 *
 * Observes valuation prices and triggers the existing open-position pipeline
 * when price conditions are met. Runs as an isolated observer module —
 * never modifies trading logic.
 *
 * Evaluation paths:
 *   1. Called from the risk monitor tick (if active)
 *   2. Self-polls prices via IFlashClient.getMarketData() when orders exist
 *      (auto-starts/stops, uses .unref() so it won't prevent exit)
 *
 * Safety features:
 *   - Spike protection: requires 2 consecutive confirmation ticks
 *   - Duplicate protection: triggered flag prevents re-execution
 *   - Pre-trigger validation: circuit breaker clear, kill switch inactive
 *   - Session-scoped: orders cleared on terminal restart (in-memory only)
 */

import chalk from 'chalk';
import { IFlashClient, TradeSide } from '../types/index.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';
import { getCircuitBreaker } from '../security/circuit-breaker.js';
import { getTradingGate } from '../security/trading-gate.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LimitOrder {
  market: string;
  side: TradeSide;
  leverage: number;
  collateralUsd: number;
  limitPrice: number;
  triggered: boolean;
  confirmationTicks: number;
  createdAt: number;
}

/** Callback to execute an open. Provided by the terminal at init time. */
export type OpenExecutor = (market: string, side: TradeSide, leverage: number, collateralUsd: number) => Promise<void>;

// ─── Constants ───────────────────────────────────────────────────────────────

const REQUIRED_CONFIRMATION_TICKS = 2;
const POLL_INTERVAL_MS = 5_000; // 5 seconds — matches risk monitor cadence
const MAX_LIMIT_ORDERS = 50; // prevent unbounded growth

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: LimitOrderEngine | null = null;

export function getLimitOrderEngine(): LimitOrderEngine {
  if (!_instance) {
    _instance = new LimitOrderEngine();
  }
  return _instance;
}

export function resetLimitOrderEngine(): void {
  if (_instance) {
    _instance.stop();
  }
  _instance = null;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export class LimitOrderEngine {
  private orders = new Map<string, LimitOrder>();
  private openExecutor: OpenExecutor | null = null;
  private executingIds = new Set<string>();
  private client: IFlashClient | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInProgress = false;
  private nextOrderNum = 1;

  /** Register the open executor (called once at terminal init). */
  setOpenExecutor(executor: OpenExecutor): void {
    this.openExecutor = executor;
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

  // ─── Order Management ──────────────────────────────────────────────

  /**
   * Place a new limit order. Returns formatted CLI output.
   */
  placeOrder(market: string, side: TradeSide, leverage: number, collateralUsd: number, limitPrice: number): string {
    if (this.orders.size >= MAX_LIMIT_ORDERS) {
      return chalk.red(`  Maximum limit orders (${MAX_LIMIT_ORDERS}) reached. Cancel an order first.`);
    }

    if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
      return chalk.red('  Invalid limit price.');
    }
    if (!Number.isFinite(collateralUsd) || collateralUsd <= 0) {
      return chalk.red('  Invalid collateral amount.');
    }
    if (!Number.isFinite(leverage) || leverage < 1) {
      return chalk.red('  Invalid leverage.');
    }

    const orderId = `order-${this.nextOrderNum++}`;
    const order: LimitOrder = {
      market: market.toUpperCase(),
      side,
      leverage,
      collateralUsd,
      limitPrice,
      triggered: false,
      confirmationTicks: 0,
      createdAt: Date.now(),
    };

    this.orders.set(orderId, order);
    this.ensurePolling();

    const logger = getLogger();
    logger.info(
      'LIMIT_ORDER',
      `LIMIT_ORDER_CREATED: ${orderId} ${order.side} ${order.market} ${order.leverage}x $${order.collateralUsd} @ $${order.limitPrice}`,
    );

    const sideColor = side === TradeSide.Long ? chalk.green : chalk.red;

    return [
      '',
      chalk.green('  Limit order placed'),
      chalk.dim('  ─────────────────'),
      `  Order ID:      ${chalk.bold(orderId)}`,
      `  Market:        ${order.market}`,
      `  Side:          ${sideColor(order.side.toUpperCase())}`,
      `  Leverage:      ${order.leverage}x`,
      `  Collateral:    $${order.collateralUsd.toFixed(2)}`,
      `  Trigger price: $${order.limitPrice.toFixed(2)}`,
      '',
    ].join('\n');
  }

  /**
   * Cancel an existing limit order. Returns formatted CLI output.
   */
  cancelOrder(orderId: string): string {
    const order = this.orders.get(orderId);
    if (!order) {
      return chalk.yellow(`  Order "${orderId}" not found.`);
    }
    if (order.triggered) {
      return chalk.yellow(`  Order "${orderId}" has already been triggered.`);
    }

    this.orders.delete(orderId);
    this.maybeStopPolling();

    const logger = getLogger();
    logger.info(
      'LIMIT_ORDER',
      `LIMIT_ORDER_CANCELLED: ${orderId} ${order.side} ${order.market} @ $${order.limitPrice}`,
    );

    return chalk.green(`  Order "${orderId}" cancelled.`);
  }

  /**
   * Get all orders (snapshot).
   */
  getOrders(): Map<string, LimitOrder> {
    return new Map(this.orders);
  }

  /**
   * Format the orders list for CLI display.
   */
  formatOrderList(): string {
    const activeOrders = [...this.orders.entries()].filter(([, o]) => !o.triggered);

    if (activeOrders.length === 0) {
      return [
        '',
        chalk.dim('  No active limit orders.'),
        chalk.dim('  Use "limit long SOL 2x $100 @ $82" to place one.'),
        '',
      ].join('\n');
    }

    const lines = [
      '',
      `  ${chalk.bold('ACTIVE LIMIT ORDERS')}`,
      chalk.dim(`  ${'─'.repeat(64)}`),
      '',
      chalk.dim('  ID          Market  Side    Lev  Collateral   Limit Price'),
      chalk.dim(`  ${'─'.repeat(64)}`),
    ];

    for (const [id, order] of activeOrders) {
      const sideStr = order.side === TradeSide.Long ? chalk.green('LONG ') : chalk.red('SHORT');
      lines.push(
        `  ${id.padEnd(12)}${order.market.padEnd(8)}${sideStr}   ${(order.leverage + 'x').padEnd(5)}$${order.collateralUsd.toFixed(2).padEnd(13)}$${order.limitPrice.toFixed(2)}`,
      );
    }

    lines.push('');
    return lines.join('\n');
  }

  hasActiveOrders(): boolean {
    for (const o of this.orders.values()) {
      if (!o.triggered) return true;
    }
    return false;
  }

  // ─── Self-Polling ───────────────────────────────────────────────────

  /** Start price polling if not already running and there are active orders. */
  private ensurePolling(): void {
    if (this.pollTimer) return;
    if (!this.client) return;

    this.pollTimer = setInterval(() => {
      this.pollTick().catch((err) => {
        getLogger().debug('LIMIT_ORDER', `Poll tick error: ${getErrorMessage(err)}`);
      });
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  /** Stop polling if no active orders remain. */
  private maybeStopPolling(): void {
    if (!this.hasActiveOrders()) {
      this.stop();
    }
  }

  /** Single poll tick: fetch market data and evaluate. */
  private async pollTick(): Promise<void> {
    if (this.pollInProgress || !this.client) return;
    if (!this.hasActiveOrders()) {
      this.stop();
      return;
    }
    this.pollInProgress = true;
    try {
      // Fetch all market data to get valuation prices
      const marketData = await this.client.getMarketData();
      const priceMap = new Map<string, number>();
      for (const md of marketData) {
        if (Number.isFinite(md.price) && md.price > 0) {
          priceMap.set(md.symbol.toUpperCase(), md.price);
        }
      }
      await this.evaluate(priceMap);
    } catch (err) {
      getLogger().debug('LIMIT_ORDER', `Market data fetch failed: ${getErrorMessage(err)}`);
    } finally {
      this.pollInProgress = false;
    }
  }

  // ─── Evaluation (called from risk monitor tick OR self-poll) ────────

  /**
   * Evaluate all active limit orders against current prices.
   * Price map: market symbol (uppercase) → valuation price.
   *
   * For limit orders:
   *   LONG:  triggers when price drops to or below limitPrice (buy the dip)
   *   SHORT: triggers when price rises to or above limitPrice (sell the rally)
   */
  async evaluate(priceMap: Map<string, number>): Promise<void> {
    if (this.orders.size === 0) return;

    const logger = getLogger();

    for (const [orderId, order] of this.orders) {
      if (order.triggered) continue;

      const valuationPrice = priceMap.get(order.market);
      if (!valuationPrice || !Number.isFinite(valuationPrice) || valuationPrice <= 0) continue;

      const conditionMet =
        order.side === TradeSide.Long
          ? valuationPrice <= order.limitPrice // LONG limit order: trigger when price drops to limit
          : valuationPrice >= order.limitPrice; // SHORT limit order: trigger when price rises to limit

      // Spike protection: increment or reset confirmation ticks
      if (conditionMet) {
        order.confirmationTicks += 1;
      } else {
        order.confirmationTicks = 0;
      }

      // Require N consecutive ticks
      if (!conditionMet || order.confirmationTicks < REQUIRED_CONFIRMATION_TICKS) {
        continue;
      }

      // ── Pre-trigger validation ───────────────────────────────────────

      // Already executing this order?
      if (this.executingIds.has(orderId)) continue;

      // Circuit breaker check
      const breaker = getCircuitBreaker();
      const breakerCheck = breaker.check();
      if (!breakerCheck.allowed) {
        logger.warn('LIMIT_ORDER', `Order ${orderId} trigger blocked by circuit breaker: ${breakerCheck.reason}`);
        continue;
      }

      // Kill switch check
      const gate = getTradingGate();
      const killCheck = gate.checkKillSwitch();
      if (!killCheck.allowed) {
        logger.warn('LIMIT_ORDER', `Order ${orderId} trigger blocked by kill switch: ${killCheck.reason}`);
        continue;
      }

      // No open executor registered
      if (!this.openExecutor) {
        logger.warn('LIMIT_ORDER', `Order ${orderId} condition met but no open executor registered`);
        continue;
      }

      // ── Trigger ──────────────────────────────────────────────────────

      order.triggered = true;
      this.executingIds.add(orderId);

      logger.info(
        'LIMIT_ORDER',
        `LIMIT_ORDER_TRIGGERED: ${orderId} ${order.side} ${order.market} at $${valuationPrice.toFixed(4)} (limit: $${order.limitPrice.toFixed(2)})`,
      );
      process.stdout.write(
        chalk.bold.yellow(`\n  [LIMIT] Order ${orderId} triggered — ${order.market} ${order.side.toUpperCase()}`) +
          chalk.dim(` — price: $${valuationPrice.toFixed(4)}`) +
          chalk.dim(` — opening position...\n`),
      );

      // Fire-and-forget open execution (non-blocking for other orders)
      this.executeOpen(orderId, order, valuationPrice).catch((err) => {
        logger.warn('LIMIT_ORDER', `Open execution failed for ${orderId}: ${getErrorMessage(err)}`);
      });
    }

    // Auto-stop polling when all orders are triggered
    this.maybeStopPolling();
  }

  private async executeOpen(orderId: string, order: LimitOrder, executionPrice: number): Promise<void> {
    const logger = getLogger();
    try {
      await this.openExecutor!(order.market, order.side, order.leverage, order.collateralUsd);
      logger.info(
        'LIMIT_ORDER',
        `Order ${orderId} executed: ${order.side} ${order.market} ${order.leverage}x $${order.collateralUsd} at $${executionPrice.toFixed(4)}`,
      );
    } catch (err) {
      process.stdout.write(chalk.red(`\n  [LIMIT] Order ${orderId} execution failed: ${getErrorMessage(err)}\n`));
      // Mark as not triggered so user can see it failed
      order.triggered = false;
      order.confirmationTicks = 0;
    } finally {
      this.executingIds.delete(orderId);
    }
  }
}
