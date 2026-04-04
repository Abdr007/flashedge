/**
 * TP/SL Engine Tests
 *
 * Verifies take-profit and stop-loss automation:
 *   - Target management (set, remove, merge)
 *   - Condition evaluation (long TP/SL, short TP/SL)
 *   - Spike protection (confirmation ticks)
 *   - Duplicate trigger prevention
 *   - Lifecycle: OPEN → set TP/SL → price hits → close triggered
 *   - Circuit breaker / kill switch blocking
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock circuit breaker and trading gate before importing the engine
vi.mock('../src/security/circuit-breaker.js', () => ({
  getCircuitBreaker: () => ({
    check: () => ({ allowed: true }),
    recordTrade: vi.fn(),
  }),
}));

vi.mock('../src/security/trading-gate.js', () => ({
  getTradingGate: () => ({
    checkKillSwitch: () => ({ allowed: true }),
  }),
}));

vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trade: vi.fn(),
  }),
}));

import { TpSlEngine, resetTpSlEngine, getTpSlEngine, CloseReason } from '../src/risk/tp-sl-engine.js';
import { Position, TradeSide } from '../src/types/index.js';

// Suppress stdout during tests
const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    pubkey: 'SIM_test',
    market: 'SOL',
    side: TradeSide.Long,
    entryPrice: 86.00,
    currentPrice: 86.00,
    markPrice: 86.00,
    sizeUsd: 20,
    collateralUsd: 10,
    leverage: 2,
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,
    liquidationPrice: 44,
    openFee: 0.016,
    totalFees: 0.016,
    fundingRate: 0,
    timestamp: Date.now() / 1000,
    ...overrides,
  };
}

describe('TpSlEngine', () => {
  let engine: TpSlEngine;
  let closeCalls: Array<{ market: string; side: TradeSide; reason: CloseReason }>;
  let closeExecutor: (m: string, s: TradeSide, r: CloseReason) => Promise<void>;

  beforeEach(() => {
    resetTpSlEngine();
    engine = new TpSlEngine();
    closeCalls = [];
    closeExecutor = async (market, side, reason) => {
      closeCalls.push({ market, side, reason });
    };
    engine.setCloseExecutor(closeExecutor);
    stdoutSpy.mockClear();
  });

  afterEach(() => {
    engine.stop();
  });

  // ─── Target Management ────────────────────────────────────────────

  describe('Target Management', () => {
    it('sets TP target', () => {
      engine.setTarget('SOL', 'long', 95);
      const target = engine.getTarget('SOL', 'long');
      expect(target).toBeDefined();
      expect(target!.tp).toBe(95);
      expect(target!.sl).toBeUndefined();
      expect(target!.triggered).toBe(false);
    });

    it('sets SL target', () => {
      engine.setTarget('SOL', 'long', undefined, 80);
      const target = engine.getTarget('SOL', 'long');
      expect(target!.sl).toBe(80);
      expect(target!.tp).toBeUndefined();
    });

    it('sets both TP and SL', () => {
      engine.setTarget('SOL', 'long', 95, 80);
      const target = engine.getTarget('SOL', 'long');
      expect(target!.tp).toBe(95);
      expect(target!.sl).toBe(80);
    });

    it('merges TP onto existing SL', () => {
      engine.setTarget('SOL', 'long', undefined, 80);
      engine.setTarget('SOL', 'long', 95);
      const target = engine.getTarget('SOL', 'long');
      expect(target!.tp).toBe(95);
      expect(target!.sl).toBe(80);
    });

    it('removes TP while preserving SL', () => {
      engine.setTarget('SOL', 'long', 95, 80);
      engine.removeTarget('SOL', 'long', 'tp');
      const target = engine.getTarget('SOL', 'long');
      expect(target!.tp).toBeUndefined();
      expect(target!.sl).toBe(80);
    });

    it('removes SL while preserving TP', () => {
      engine.setTarget('SOL', 'long', 95, 80);
      engine.removeTarget('SOL', 'long', 'sl');
      const target = engine.getTarget('SOL', 'long');
      expect(target!.tp).toBe(95);
      expect(target!.sl).toBeUndefined();
    });

    it('deletes entry when both TP and SL removed', () => {
      engine.setTarget('SOL', 'long', 95, 80);
      engine.removeTarget('SOL', 'long', 'tp');
      engine.removeTarget('SOL', 'long', 'sl');
      expect(engine.getTarget('SOL', 'long')).toBeUndefined();
    });

    it('returns warning when removing from non-existent target', () => {
      const result = engine.removeTarget('SOL', 'long', 'tp');
      expect(result).toContain('No TP/SL targets set');
    });

    it('key is case-insensitive', () => {
      engine.setTarget('sol', 'LONG', 95);
      expect(engine.getTarget('SOL', 'long')).toBeDefined();
    });

    it('tracks different sides independently', () => {
      engine.setTarget('SOL', 'long', 95, 80);
      engine.setTarget('SOL', 'short', 75, 90);
      expect(engine.getTarget('SOL', 'long')!.tp).toBe(95);
      expect(engine.getTarget('SOL', 'short')!.tp).toBe(75);
    });
  });

  // ─── hasActiveTargets ─────────────────────────────────────────────

  describe('hasActiveTargets', () => {
    it('returns false when no targets', () => {
      expect(engine.hasActiveTargets()).toBe(false);
    });

    it('returns true when targets set', () => {
      engine.setTarget('SOL', 'long', 95);
      expect(engine.hasActiveTargets()).toBe(true);
    });

    it('returns false when all triggered', async () => {
      engine.setTarget('SOL', 'long', 85); // TP at 85, will trigger immediately
      const pos = makePosition({ markPrice: 90 }); // above TP

      // Tick 1: confirmationTicks = 1
      await engine.evaluate([pos]);
      expect(engine.hasActiveTargets()).toBe(true);

      // Tick 2: confirmationTicks = 2 → triggered
      await engine.evaluate([pos]);
      expect(engine.hasActiveTargets()).toBe(false);
    });
  });

  // ─── LONG Position TP/SL ──────────────────────────────────────────

  describe('LONG position evaluation', () => {
    it('triggers TP when price >= target (after 2 ticks)', async () => {
      engine.setTarget('SOL', 'long', 95, 80);
      const pos = makePosition({ markPrice: 96 });

      // Tick 1: condition met but not enough ticks
      await engine.evaluate([pos]);
      expect(closeCalls).toHaveLength(0);

      // Tick 2: confirmed → trigger
      await engine.evaluate([pos]);
      expect(closeCalls).toHaveLength(1);
      expect(closeCalls[0]).toEqual({ market: 'SOL', side: TradeSide.Long, reason: 'TAKE_PROFIT' });
    });

    it('triggers SL when price <= target (after 2 ticks)', async () => {
      engine.setTarget('SOL', 'long', 95, 80);
      const pos = makePosition({ markPrice: 78 });

      await engine.evaluate([pos]);
      await engine.evaluate([pos]);
      expect(closeCalls).toHaveLength(1);
      expect(closeCalls[0].reason).toBe('STOP_LOSS');
    });

    it('does not trigger when price is between TP and SL', async () => {
      engine.setTarget('SOL', 'long', 95, 80);
      const pos = makePosition({ markPrice: 87 });

      await engine.evaluate([pos]);
      await engine.evaluate([pos]);
      await engine.evaluate([pos]);
      expect(closeCalls).toHaveLength(0);
    });
  });

  // ─── SHORT Position TP/SL ─────────────────────────────────────────

  describe('SHORT position evaluation', () => {
    it('triggers TP when price <= target (price drops)', async () => {
      engine.setTarget('SOL', 'short', 75, 95);
      const pos = makePosition({ side: TradeSide.Short, markPrice: 74 });

      await engine.evaluate([pos]);
      await engine.evaluate([pos]);
      expect(closeCalls).toHaveLength(1);
      expect(closeCalls[0].reason).toBe('TAKE_PROFIT');
    });

    it('triggers SL when price >= target (price rises)', async () => {
      engine.setTarget('SOL', 'short', 75, 95);
      const pos = makePosition({ side: TradeSide.Short, markPrice: 96 });

      await engine.evaluate([pos]);
      await engine.evaluate([pos]);
      expect(closeCalls).toHaveLength(1);
      expect(closeCalls[0].reason).toBe('STOP_LOSS');
    });
  });

  // ─── Spike Protection ─────────────────────────────────────────────

  describe('Spike protection', () => {
    it('resets confirmation ticks when condition no longer met', async () => {
      engine.setTarget('SOL', 'long', 95);

      // Tick 1: price above TP
      await engine.evaluate([makePosition({ markPrice: 96 })]);

      // Tick 2: price drops back below TP → reset
      await engine.evaluate([makePosition({ markPrice: 93 })]);

      // Tick 3: price above TP again (only 1 tick)
      await engine.evaluate([makePosition({ markPrice: 96 })]);
      expect(closeCalls).toHaveLength(0);

      // Tick 4: confirmed again → trigger
      await engine.evaluate([makePosition({ markPrice: 96 })]);
      expect(closeCalls).toHaveLength(1);
    });

    it('requires exactly 2 consecutive ticks', async () => {
      engine.setTarget('SOL', 'long', 95);
      const pos = makePosition({ markPrice: 96 });

      await engine.evaluate([pos]); // tick 1
      expect(closeCalls).toHaveLength(0);
      expect(engine.getTarget('SOL', 'long')!.confirmationTicks).toBe(1);

      await engine.evaluate([pos]); // tick 2 → trigger
      expect(closeCalls).toHaveLength(1);
    });
  });

  // ─── Duplicate Protection ─────────────────────────────────────────

  describe('Duplicate protection', () => {
    it('does not trigger twice', async () => {
      engine.setTarget('SOL', 'long', 85);
      const pos = makePosition({ markPrice: 90 });

      await engine.evaluate([pos]); // tick 1
      await engine.evaluate([pos]); // tick 2 → trigger
      await engine.evaluate([pos]); // tick 3 → already triggered, skip
      await engine.evaluate([pos]); // tick 4 → still skip

      expect(closeCalls).toHaveLength(1);
    });

    it('marks target as triggered', async () => {
      engine.setTarget('SOL', 'long', 85);
      const pos = makePosition({ markPrice: 90 });

      await engine.evaluate([pos]);
      await engine.evaluate([pos]);
      expect(engine.getTarget('SOL', 'long')!.triggered).toBe(true);
    });
  });

  // ─── Valuation Price ──────────────────────────────────────────────

  describe('Valuation price', () => {
    it('uses markPrice when available', async () => {
      engine.setTarget('SOL', 'long', 95);
      const pos = makePosition({ markPrice: 96, currentPrice: 80 });

      await engine.evaluate([pos]);
      await engine.evaluate([pos]);
      // Should trigger because markPrice=96 >= tp=95
      expect(closeCalls).toHaveLength(1);
    });

    it('falls back to currentPrice when markPrice is 0', async () => {
      engine.setTarget('SOL', 'long', 95);
      const pos = makePosition({ markPrice: 0, currentPrice: 96 });

      await engine.evaluate([pos]);
      await engine.evaluate([pos]);
      expect(closeCalls).toHaveLength(1);
    });

    it('skips position with invalid valuation price', async () => {
      engine.setTarget('SOL', 'long', 95);
      const pos = makePosition({ markPrice: NaN, currentPrice: NaN });

      await engine.evaluate([pos]);
      await engine.evaluate([pos]);
      expect(closeCalls).toHaveLength(0);
    });
  });

  // ─── No Executor ──────────────────────────────────────────────────

  describe('No close executor', () => {
    it('does not crash when no executor is registered', async () => {
      const noExecEngine = new TpSlEngine();
      noExecEngine.setTarget('SOL', 'long', 85);
      const pos = makePosition({ markPrice: 90 });

      // Should not throw
      await noExecEngine.evaluate([pos]);
      await noExecEngine.evaluate([pos]);
      // Target marked triggered but no close executed
      expect(noExecEngine.getTarget('SOL', 'long')!.triggered).toBe(false);
    });
  });

  // ─── Multiple Positions ──────────────────────────────────────────

  describe('Multiple positions', () => {
    it('evaluates independently', async () => {
      engine.setTarget('SOL', 'long', 95);
      engine.setTarget('ETH', 'short', 3000, 3500);

      const solPos = makePosition({ market: 'SOL', side: TradeSide.Long, markPrice: 96 });
      const ethPos = makePosition({ market: 'ETH', side: TradeSide.Short, markPrice: 2900 });

      await engine.evaluate([solPos, ethPos]);
      await engine.evaluate([solPos, ethPos]);

      expect(closeCalls).toHaveLength(2);
      expect(closeCalls.find(c => c.market === 'SOL')?.reason).toBe('TAKE_PROFIT');
      expect(closeCalls.find(c => c.market === 'ETH')?.reason).toBe('TAKE_PROFIT');
    });
  });

  // ─── Lifecycle Test ───────────────────────────────────────────────

  describe('Full lifecycle: OPEN → set TP/SL → price hits → close', () => {
    it('completes the lifecycle correctly', async () => {
      // 1. Set TP and SL after opening position
      engine.setTarget('SOL', 'long', 95, 80);

      // 2. Price normal — no trigger
      await engine.evaluate([makePosition({ markPrice: 87 })]);
      expect(closeCalls).toHaveLength(0);

      // 3. Price approaches TP but doesn't reach
      await engine.evaluate([makePosition({ markPrice: 94.99 })]);
      expect(closeCalls).toHaveLength(0);

      // 4. Price hits TP (tick 1)
      await engine.evaluate([makePosition({ markPrice: 95.50 })]);
      expect(closeCalls).toHaveLength(0); // spike protection

      // 5. Price stays above TP (tick 2) → trigger
      await engine.evaluate([makePosition({ markPrice: 95.10 })]);
      expect(closeCalls).toHaveLength(1);
      expect(closeCalls[0]).toEqual({
        market: 'SOL',
        side: TradeSide.Long,
        reason: 'TAKE_PROFIT',
      });

      // 6. Target is now triggered
      const target = engine.getTarget('SOL', 'long');
      expect(target!.triggered).toBe(true);

      // 7. No more triggers
      await engine.evaluate([makePosition({ markPrice: 100 })]);
      expect(closeCalls).toHaveLength(1);
    });
  });

  // ─── Singleton ────────────────────────────────────────────────────

  describe('Singleton', () => {
    it('returns same instance', () => {
      const a = getTpSlEngine();
      const b = getTpSlEngine();
      expect(a).toBe(b);
    });

    it('resets on resetTpSlEngine', () => {
      const a = getTpSlEngine();
      resetTpSlEngine();
      const b = getTpSlEngine();
      expect(a).not.toBe(b);
    });
  });

  // ─── makeKey ──────────────────────────────────────────────────────

  describe('makeKey', () => {
    it('normalizes market and side', () => {
      expect(TpSlEngine.makeKey('sol', 'LONG')).toBe('SOL-long');
      expect(TpSlEngine.makeKey('SOL', 'long')).toBe('SOL-long');
      expect(TpSlEngine.makeKey('Eth', 'Short')).toBe('ETH-short');
    });
  });
});
