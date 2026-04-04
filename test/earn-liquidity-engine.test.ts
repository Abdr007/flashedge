/**
 * Liquidity Intelligence Engine Tests
 *
 * PnL tracking, demand analysis, rotation suggestions,
 * auto-routing, and command parsing.
 */

import { describe, it } from 'vitest';
import assert from 'assert';
import { localParse } from '../src/ai/interpreter.js';
import { ActionType } from '../src/types/index.js';

// ─── Command Parsing ────────────────────────────────────────────────────────

describe('Liquidity Intelligence Commands', () => {
  it('earn pnl → earn_pnl', () => {
    const r = localParse('earn pnl');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnPnl);
  });

  it('earn profit → earn_pnl', () => {
    const r = localParse('earn profit');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnPnl);
  });

  it('earn performance → earn_pnl', () => {
    const r = localParse('earn performance');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnPnl);
  });

  it('earn demand → earn_demand', () => {
    const r = localParse('earn demand');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnDemand);
  });

  it('earn utilization → earn_demand', () => {
    const r = localParse('earn utilization');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnDemand);
  });

  it('earn rotate → earn_rotate', () => {
    const r = localParse('earn rotate');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnRotate);
  });

  it('earn optimize → earn_rotate', () => {
    const r = localParse('earn optimize');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnRotate);
  });

  it('earn rebalance → earn_rotate', () => {
    const r = localParse('earn rebalance');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnRotate);
  });

  it('earn best 500 → auto-route deposit to top pool', () => {
    const r = localParse('earn best 500');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnAddLiquidity);
    assert.strictEqual((r as any).amount, 500);
    assert.strictEqual((r as any).pool, '__best__');
  });

  it('earn best $1000 → auto-route with $ prefix', () => {
    const r = localParse('earn best $1000');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnAddLiquidity);
    assert.strictEqual((r as any).amount, 1000);
  });
});

// ─── Complete Earn Command Set ──────────────────────────────────────────────

describe('Complete Earn Command Set', () => {
  const commands: [string, string][] = [
    ['earn', 'earn_status'],
    ['earn pools', 'earn_status'],
    ['earn best', 'earn_best'],
    ['earn info crypto', 'earn_info'],
    ['earn simulate $1000 crypto', 'earn_simulate'],
    ['earn dashboard', 'earn_dashboard'],
    ['earn positions', 'earn_positions'],
    ['earn deposit $100 crypto', 'earn_add_liquidity'],
    ['earn withdraw 50% crypto', 'earn_remove_liquidity'],
    ['earn stake $100 crypto', 'earn_stake'],
    ['earn unstake 50% crypto', 'earn_unstake'],
    ['earn claim crypto', 'earn_claim_rewards'],
    ['earn $100 crypto', 'earn_add_liquidity'],
    ['earn pnl', 'earn_pnl'],
    ['earn demand', 'earn_demand'],
    ['earn rotate', 'earn_rotate'],
    ['earn best 500', 'earn_add_liquidity'],
  ];

  for (const [input, action] of commands) {
    it(`${input} → ${action}`, () => {
      const r = localParse(input);
      assert.ok(r, `should parse: ${input}`);
      assert.strictEqual(r.action, action);
    });
  }
});
