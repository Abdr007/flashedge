/**
 * Earn Intelligence Tests
 *
 * Pool ranking, yield simulation, risk classification,
 * smart deposit parsing, and dashboard.
 */

import { describe, it } from 'vitest';
import assert from 'assert';
import { localParse } from '../src/ai/interpreter.js';
import { ActionType } from '../src/types/index.js';
import { classifyRisk, simulateYield } from '../src/earn/yield-analytics.js';

// ─── Risk Classification ────────────────────────────────────────────────────

describe('Risk Classification', () => {
  it('high TVL + low APY = Low risk', () => {
    assert.strictEqual(classifyRisk(5_000_000, 40), 'Low');
  });

  it('medium TVL + moderate APY = Medium risk', () => {
    assert.strictEqual(classifyRisk(500_000, 50), 'Medium');
  });

  it('low TVL + high APY = High risk', () => {
    assert.strictEqual(classifyRisk(150_000, 120), 'High');
  });

  it('very low TVL + extreme APY = Very High risk', () => {
    assert.strictEqual(classifyRisk(50_000, 500), 'Very High');
  });

  it('large TVL always caps at Low or Medium', () => {
    assert.strictEqual(classifyRisk(10_000_000, 30), 'Low');
  });
});

// ─── Yield Simulation ───────────────────────────────────────────────────────

describe('Yield Simulation', () => {
  it('projects 7-day returns correctly', () => {
    const proj = simulateYield(1000, 42);
    assert.ok(proj.days7 > 0, 'should have positive 7-day returns');
    assert.ok(proj.days7 < 20, '7-day returns should be reasonable');
  });

  it('projects 30-day returns correctly', () => {
    const proj = simulateYield(1000, 42);
    assert.ok(proj.days30 > proj.days7, '30d > 7d');
  });

  it('projects 1-year returns correctly', () => {
    const proj = simulateYield(1000, 42);
    assert.ok(proj.days365 > 400, '1-year at 42% should be > $400');
    assert.ok(proj.days365 < 550, '1-year at 42% should be < $550 (compounding)');
  });

  it('zero APY returns zero', () => {
    const proj = simulateYield(1000, 0);
    assert.strictEqual(proj.days7, 0);
    assert.strictEqual(proj.days365, 0);
  });

  it('deposit amount is preserved', () => {
    const proj = simulateYield(500, 100);
    assert.strictEqual(proj.deposit, 500);
    assert.strictEqual(proj.apy, 100);
  });

  it('high APY compounds significantly', () => {
    const proj = simulateYield(1000, 500);
    assert.ok(proj.days365 > 4000, 'high APY should compound');
  });
});

// ─── Command Parsing ────────────────────────────────────────────────────────

describe('Earn Intelligence Commands', () => {
  it('earn best → earn_best', () => {
    const r = localParse('earn best');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnBest);
  });

  it('earn simulate $1000 crypto → earn_simulate', () => {
    const r = localParse('earn simulate $1000 crypto');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnSimulate);
    assert.strictEqual((r as any).amount, 1000);
  });

  it('earn sim $500 gold → earn_simulate', () => {
    const r = localParse('earn sim $500 gold');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnSimulate);
  });

  it('earn dashboard → earn_dashboard', () => {
    const r = localParse('earn dashboard');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnDashboard);
  });

  it('earn dash → earn_dashboard', () => {
    const r = localParse('earn dash');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnDashboard);
  });

  it('earn $100 crypto → smart deposit shortcut', () => {
    const r = localParse('earn $100 crypto');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnAddLiquidity);
    assert.strictEqual((r as any).amount, 100);
  });

  it('earn 500 gold → smart deposit shortcut', () => {
    const r = localParse('earn 500 gold');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnAddLiquidity);
    assert.strictEqual((r as any).amount, 500);
  });
});
