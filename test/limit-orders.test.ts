/**
 * Limit Order Engine Tests
 *
 * Verifies limit order automation:
 *   - Order placement and validation
 *   - Long order trigger (price drops to limit)
 *   - Short order trigger (price rises to limit)
 *   - Cancel order
 *   - Duplicate trigger prevention
 *   - Spike protection (confirmation ticks)
 *   - Multiple orders
 *   - Order list display
 *   - Circuit breaker / kill switch blocking
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock circuit breaker and trading gate before importing the engine
const mockCircuitBreaker = {
  check: vi.fn(() => ({ allowed: true })),
  recordTrade: vi.fn(),
  recordOpen: vi.fn(),
};

const mockTradingGate = {
  checkKillSwitch: vi.fn(() => ({ allowed: true })),
};

vi.mock('../src/security/circuit-breaker.js', () => ({
  getCircuitBreaker: () => mockCircuitBreaker,
}));

vi.mock('../src/security/trading-gate.js', () => ({
  getTradingGate: () => mockTradingGate,
}));

vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trade: vi.fn(),
  }),
}));

import { LimitOrderEngine, resetLimitOrderEngine } from '../src/orders/limit-order-engine.js';
import { TradeSide } from '../src/types/index.js';

// Suppress stdout during tests
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

describe('LimitOrderEngine', () => {
  let engine: LimitOrderEngine;
  let openCalls: Array<{ market: string; side: TradeSide; leverage: number; collateral: number }>;
  let openExecutor: (m: string, s: TradeSide, l: number, c: number) => Promise<void>;

  beforeEach(() => {
    resetLimitOrderEngine();
    engine = new LimitOrderEngine();
    openCalls = [];
    openExecutor = async (market, side, leverage, collateral) => {
      openCalls.push({ market, side, leverage, collateral });
    };
    engine.setOpenExecutor(openExecutor);
    mockCircuitBreaker.check.mockReturnValue({ allowed: true });
    mockTradingGate.checkKillSwitch.mockReturnValue({ allowed: true });
  });

  // ─── Order Placement ──────────────────────────────────────────────

  it('should place a limit order', () => {
    const result = engine.placeOrder('SOL', TradeSide.Long, 2, 100, 82);
    expect(result).toContain('Limit order placed');
    expect(result).toContain('order-1');
    expect(result).toContain('SOL');
    expect(result).toContain('$82.00');

    const orders = engine.getOrders();
    expect(orders.size).toBe(1);
    const order = orders.get('order-1')!;
    expect(order.market).toBe('SOL');
    expect(order.side).toBe(TradeSide.Long);
    expect(order.leverage).toBe(2);
    expect(order.collateralUsd).toBe(100);
    expect(order.limitPrice).toBe(82);
    expect(order.triggered).toBe(false);
  });

  it('should reject invalid limit price', () => {
    const result = engine.placeOrder('SOL', TradeSide.Long, 2, 100, -5);
    expect(result).toContain('Invalid limit price');
  });

  it('should reject invalid collateral', () => {
    const result = engine.placeOrder('SOL', TradeSide.Long, 2, 0, 82);
    expect(result).toContain('Invalid collateral');
  });

  it('should reject invalid leverage', () => {
    const result = engine.placeOrder('SOL', TradeSide.Long, 0.5, 100, 82);
    expect(result).toContain('Invalid leverage');
  });

  // ─── Long Order Trigger ───────────────────────────────────────────

  it('should trigger long order when price drops to limit', async () => {
    engine.placeOrder('SOL', TradeSide.Long, 2, 100, 82);

    // Tick 1: condition met, but needs 2 ticks
    await engine.evaluate(new Map([['SOL', 81]]));
    expect(openCalls).toHaveLength(0);

    // Tick 2: condition still met — triggers
    await engine.evaluate(new Map([['SOL', 80]]));
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0]).toEqual({
      market: 'SOL', side: TradeSide.Long, leverage: 2, collateral: 100,
    });
  });

  it('should not trigger long order when price is above limit', async () => {
    engine.placeOrder('SOL', TradeSide.Long, 2, 100, 82);

    await engine.evaluate(new Map([['SOL', 85]]));
    await engine.evaluate(new Map([['SOL', 84]]));
    expect(openCalls).toHaveLength(0);
  });

  // ─── Short Order Trigger ──────────────────────────────────────────

  it('should trigger short order when price rises to limit', async () => {
    engine.placeOrder('BTC', TradeSide.Short, 3, 200, 72000);

    // Tick 1
    await engine.evaluate(new Map([['BTC', 72500]]));
    expect(openCalls).toHaveLength(0);

    // Tick 2
    await engine.evaluate(new Map([['BTC', 73000]]));
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0]).toEqual({
      market: 'BTC', side: TradeSide.Short, leverage: 3, collateral: 200,
    });
  });

  it('should not trigger short order when price is below limit', async () => {
    engine.placeOrder('BTC', TradeSide.Short, 3, 200, 72000);

    await engine.evaluate(new Map([['BTC', 71000]]));
    await engine.evaluate(new Map([['BTC', 71500]]));
    expect(openCalls).toHaveLength(0);
  });

  // ─── Cancel Order ─────────────────────────────────────────────────

  it('should cancel an active order', () => {
    engine.placeOrder('SOL', TradeSide.Long, 2, 100, 82);
    const result = engine.cancelOrder('order-1');
    expect(result).toContain('cancelled');
    expect(engine.getOrders().size).toBe(0);
  });

  it('should return error when cancelling non-existent order', () => {
    const result = engine.cancelOrder('order-99');
    expect(result).toContain('not found');
  });

  it('should not trigger cancelled order', async () => {
    engine.placeOrder('SOL', TradeSide.Long, 2, 100, 82);
    engine.cancelOrder('order-1');

    await engine.evaluate(new Map([['SOL', 80]]));
    await engine.evaluate(new Map([['SOL', 79]]));
    expect(openCalls).toHaveLength(0);
  });

  // ─── Duplicate Trigger Prevention ─────────────────────────────────

  it('should not trigger the same order twice', async () => {
    engine.placeOrder('SOL', TradeSide.Long, 2, 100, 82);

    // Trigger it
    await engine.evaluate(new Map([['SOL', 80]]));
    await engine.evaluate(new Map([['SOL', 79]]));
    expect(openCalls).toHaveLength(1);

    // Price still below limit — should not trigger again
    await engine.evaluate(new Map([['SOL', 78]]));
    await engine.evaluate(new Map([['SOL', 77]]));
    expect(openCalls).toHaveLength(1);
  });

  // ─── Spike Protection ─────────────────────────────────────────────

  it('should reset confirmation ticks when condition no longer met', async () => {
    engine.placeOrder('SOL', TradeSide.Long, 2, 100, 82);

    // Tick 1: condition met
    await engine.evaluate(new Map([['SOL', 81]]));
    expect(openCalls).toHaveLength(0);

    // Price bounces back — resets ticks
    await engine.evaluate(new Map([['SOL', 85]]));
    expect(openCalls).toHaveLength(0);

    // Need 2 consecutive ticks again
    await engine.evaluate(new Map([['SOL', 80]]));
    expect(openCalls).toHaveLength(0);

    await engine.evaluate(new Map([['SOL', 79]]));
    expect(openCalls).toHaveLength(1);
  });

  // ─── Multiple Orders ─────────────────────────────────────────────

  it('should handle multiple orders independently', async () => {
    engine.placeOrder('SOL', TradeSide.Long, 2, 100, 82);
    engine.placeOrder('BTC', TradeSide.Short, 3, 200, 72000);

    // Only SOL condition met
    await engine.evaluate(new Map([['SOL', 80], ['BTC', 70000]]));
    await engine.evaluate(new Map([['SOL', 79], ['BTC', 71000]]));

    expect(openCalls).toHaveLength(1);
    expect(openCalls[0].market).toBe('SOL');

    // Now BTC condition met
    await engine.evaluate(new Map([['SOL', 79], ['BTC', 73000]]));
    await engine.evaluate(new Map([['SOL', 79], ['BTC', 74000]]));

    expect(openCalls).toHaveLength(2);
    expect(openCalls[1].market).toBe('BTC');
  });

  it('should assign unique order IDs', () => {
    engine.placeOrder('SOL', TradeSide.Long, 2, 100, 82);
    engine.placeOrder('BTC', TradeSide.Short, 3, 200, 72000);
    engine.placeOrder('ETH', TradeSide.Long, 5, 50, 1500);

    const orders = engine.getOrders();
    expect(orders.has('order-1')).toBe(true);
    expect(orders.has('order-2')).toBe(true);
    expect(orders.has('order-3')).toBe(true);
  });

  // ─── Order List Display ───────────────────────────────────────────

  it('should display empty state when no orders', () => {
    const result = engine.formatOrderList();
    expect(result).toContain('No active limit orders');
  });

  it('should display active orders in list', () => {
    engine.placeOrder('SOL', TradeSide.Long, 2, 100, 82);
    engine.placeOrder('BTC', TradeSide.Short, 3, 200, 72000);

    const result = engine.formatOrderList();
    expect(result).toContain('ACTIVE LIMIT ORDERS');
    expect(result).toContain('SOL');
    expect(result).toContain('BTC');
  });

  it('should not show triggered orders in list', async () => {
    engine.placeOrder('SOL', TradeSide.Long, 2, 100, 82);
    engine.placeOrder('BTC', TradeSide.Short, 3, 200, 72000);

    // Trigger SOL order
    await engine.evaluate(new Map([['SOL', 80], ['BTC', 70000]]));
    await engine.evaluate(new Map([['SOL', 79], ['BTC', 70000]]));

    const result = engine.formatOrderList();
    // SOL order is triggered — should not appear, BTC should
    expect(result).toContain('BTC');
  });

  // ─── Circuit Breaker Blocking ─────────────────────────────────────

  it('should block trigger when circuit breaker is tripped', async () => {
    engine.placeOrder('SOL', TradeSide.Long, 2, 100, 82);

    // Trip circuit breaker
    mockCircuitBreaker.check.mockReturnValue({ allowed: false, reason: 'loss limit' });

    await engine.evaluate(new Map([['SOL', 80]]));
    await engine.evaluate(new Map([['SOL', 79]]));

    expect(openCalls).toHaveLength(0);
    // Order should NOT be marked as triggered (so it can fire when breaker resets)
    const order = engine.getOrders().get('order-1')!;
    expect(order.triggered).toBe(false);
  });

  // ─── Kill Switch Blocking ─────────────────────────────────────────

  it('should block trigger when kill switch is active', async () => {
    engine.placeOrder('SOL', TradeSide.Long, 2, 100, 82);

    // Activate kill switch
    mockTradingGate.checkKillSwitch.mockReturnValue({ allowed: false, reason: 'trading disabled' });

    await engine.evaluate(new Map([['SOL', 80]]));
    await engine.evaluate(new Map([['SOL', 79]]));

    expect(openCalls).toHaveLength(0);
  });

  // ─── No Executor ──────────────────────────────────────────────────

  it('should not crash when no executor is registered', async () => {
    const bareEngine = new LimitOrderEngine();
    bareEngine.placeOrder('SOL', TradeSide.Long, 2, 100, 82);

    // Should not throw
    await bareEngine.evaluate(new Map([['SOL', 80]]));
    await bareEngine.evaluate(new Map([['SOL', 79]]));
  });

  // ─── Invalid Price Data ───────────────────────────────────────────

  it('should skip evaluation when price is invalid', async () => {
    engine.placeOrder('SOL', TradeSide.Long, 2, 100, 82);

    await engine.evaluate(new Map([['SOL', NaN]]));
    await engine.evaluate(new Map([['SOL', 0]]));
    await engine.evaluate(new Map([['SOL', -1]]));
    await engine.evaluate(new Map());

    expect(openCalls).toHaveLength(0);
  });

  // ─── Execution Failure Recovery ───────────────────────────────────

  it('should reset triggered flag on execution failure', async () => {
    const failExecutor = async () => { throw new Error('tx failed'); };
    engine.setOpenExecutor(failExecutor);
    engine.placeOrder('SOL', TradeSide.Long, 2, 100, 82);

    await engine.evaluate(new Map([['SOL', 80]]));
    await engine.evaluate(new Map([['SOL', 79]]));

    // Order should be un-triggered so it can retry
    const order = engine.getOrders().get('order-1')!;
    expect(order.triggered).toBe(false);
    expect(order.confirmationTicks).toBe(0);
  });

  // ─── hasActiveOrders ──────────────────────────────────────────────

  it('should report no active orders after all triggered', async () => {
    engine.placeOrder('SOL', TradeSide.Long, 2, 100, 82);

    expect(engine.hasActiveOrders()).toBe(true);

    await engine.evaluate(new Map([['SOL', 80]]));
    await engine.evaluate(new Map([['SOL', 79]]));

    expect(engine.hasActiveOrders()).toBe(false);
  });

  it('should report no active orders when empty', () => {
    expect(engine.hasActiveOrders()).toBe(false);
  });

  // ─── Max Orders Limit ─────────────────────────────────────────────

  it('should reject orders when at max capacity', () => {
    // Place 50 orders
    for (let i = 0; i < 50; i++) {
      engine.placeOrder('SOL', TradeSide.Long, 2, 100, 80 - i * 0.1);
    }
    expect(engine.getOrders().size).toBe(50);

    // 51st should be rejected
    const result = engine.placeOrder('BTC', TradeSide.Short, 3, 200, 72000);
    expect(result).toContain('Maximum limit orders');
    expect(engine.getOrders().size).toBe(50);
  });
});
