/**
 * FAF Token System Tests
 *
 * VIP tier calculations, command parsing, registry constants,
 * and tool registration.
 */

import { describe, it } from 'vitest';
import assert from 'assert';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { localParse } from '../src/ai/interpreter.js';
import { ActionType } from '../src/types/index.js';
import { getVipTier, getNextTier, formatFaf, VIP_TIERS, FAF_DECIMALS, FAF_MINT } from '../src/token/faf-registry.js';

const ROOT = resolve(import.meta.dirname, '..');

// ─── VIP Tier Calculations ──────────────────────────────────────────────────

describe('VIP Tier System', () => {
  it('0 FAF = Level 0', () => {
    assert.strictEqual(getVipTier(0).level, 0);
  });

  it('20,000 FAF = Level 1', () => {
    assert.strictEqual(getVipTier(20_000).level, 1);
  });

  it('40,000 FAF = Level 2', () => {
    assert.strictEqual(getVipTier(40_000).level, 2);
  });

  it('100,000 FAF = Level 3', () => {
    assert.strictEqual(getVipTier(100_000).level, 3);
  });

  it('200,000 FAF = Level 4', () => {
    assert.strictEqual(getVipTier(200_000).level, 4);
  });

  it('1,000,000 FAF = Level 5', () => {
    assert.strictEqual(getVipTier(1_000_000).level, 5);
  });

  it('2,000,000 FAF = Level 6', () => {
    assert.strictEqual(getVipTier(2_000_000).level, 6);
  });

  it('in-between amounts use lower tier', () => {
    assert.strictEqual(getVipTier(19_999).level, 0);
    assert.strictEqual(getVipTier(39_999).level, 1);
    assert.strictEqual(getVipTier(99_999).level, 2);
  });

  it('above max still returns Level 6', () => {
    assert.strictEqual(getVipTier(5_000_000).level, 6);
  });

  it('getNextTier returns correct next level', () => {
    assert.strictEqual(getNextTier(0)?.level, 1);
    assert.strictEqual(getNextTier(5)?.level, 6);
    assert.strictEqual(getNextTier(6), null); // max
  });

  it('fee discounts increase with tier', () => {
    for (let i = 1; i < VIP_TIERS.length; i++) {
      assert.ok(VIP_TIERS[i].feeDiscount > VIP_TIERS[i - 1].feeDiscount,
        `Level ${i} discount should > Level ${i - 1}`);
    }
  });

  it('7 tiers defined (0-6)', () => {
    assert.strictEqual(VIP_TIERS.length, 7);
    assert.strictEqual(VIP_TIERS[0].level, 0);
    assert.strictEqual(VIP_TIERS[6].level, 6);
  });
});

// ─── FAF Constants ──────────────────────────────────────────────────────────

describe('FAF Constants', () => {
  it('FAF decimals = 6', () => {
    assert.strictEqual(FAF_DECIMALS, 6);
  });

  it('FAF mint is correct', () => {
    assert.strictEqual(FAF_MINT.toBase58(), 'FAFxVxnkzZHMCodkWyoccgUNgVScqMw2mhhQBYDFjFAF');
  });
});

// ─── Format FAF ─────────────────────────────────────────────────────────────

describe('Format FAF', () => {
  it('formats millions', () => {
    assert.ok(formatFaf(2_500_000).includes('M'));
  });

  it('formats thousands', () => {
    assert.ok(formatFaf(50_000).includes('K'));
  });

  it('formats small amounts', () => {
    assert.ok(formatFaf(123.45).includes('123.45'));
  });
});

// ─── Command Parsing ────────────────────────────────────────────────────────

describe('FAF Command Parsing', () => {
  it('faf → faf_status', () => {
    const r = localParse('faf');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.FafStatus);
  });

  it('faf status → faf_status', () => {
    const r = localParse('faf status');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.FafStatus);
  });

  it('faf stake 1000 → faf_stake', () => {
    const r = localParse('faf stake 1000');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.FafStake);
    assert.strictEqual((r as any).amount, 1000);
  });

  it('faf stake $50000 → faf_stake', () => {
    const r = localParse('faf stake $50000');
    assert.ok(r);
    assert.strictEqual((r as any).amount, 50000);
  });

  it('faf unstake 5000 → faf_unstake', () => {
    const r = localParse('faf unstake 5000');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.FafUnstake);
    assert.strictEqual((r as any).amount, 5000);
  });

  it('faf claim → faf_claim (all)', () => {
    const r = localParse('faf claim');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.FafClaim);
    assert.strictEqual((r as any).type, 'all');
  });

  it('faf claim rewards → faf_claim (rewards)', () => {
    const r = localParse('faf claim rewards');
    assert.ok(r);
    assert.strictEqual((r as any).type, 'rewards');
  });

  it('faf claim revenue → faf_claim (revenue)', () => {
    const r = localParse('faf claim revenue');
    assert.ok(r);
    assert.strictEqual((r as any).type, 'revenue');
  });

  it('faf claim rebate → faf_claim (rebate)', () => {
    const r = localParse('faf claim rebate');
    assert.ok(r);
    assert.strictEqual((r as any).type, 'rebate');
  });

  it('faf tier → faf_tier', () => {
    const r = localParse('faf tier');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.FafTier);
  });

  it('faf vip → faf_tier', () => {
    const r = localParse('faf vip');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.FafTier);
  });

  it('faf rewards → faf_rewards', () => {
    const r = localParse('faf rewards');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.FafRewards);
  });

  it('faf pending → faf_unstake_requests', () => {
    const r = localParse('faf pending');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.FafUnstakeRequests);
  });

  it('unknown faf subcommand → faf_status', () => {
    const r = localParse('faf xyz');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.FafStatus);
  });
});

// ─── Tool Registration ──────────────────────────────────────────────────────

describe('FAF Tool Registration', () => {
  it('engine registers FAF tools', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/engine.ts'), 'utf8');
    assert.ok(src.includes('allFafTools'));
    assert.ok(src.includes('faf_status'));
    assert.ok(src.includes('faf_stake'));
    assert.ok(src.includes('faf_claim'));
    assert.ok(src.includes('faf_tier'));
  });

  it('command registry includes FAF commands', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/command-registry.ts'), 'utf8');
    assert.ok(src.includes('FafStatus'));
    assert.ok(src.includes('FafTier'));
    assert.ok(src.includes('FafClaim'));
  });
});

// ─── Security ───────────────────────────────────────────────────────────────

describe('FAF Security', () => {
  it('stake tool validates amount', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/faf-tools.ts'), 'utf8');
    assert.ok(src.includes('Number.isFinite(amount)'));
    assert.ok(src.includes('Insufficient FAF'));
  });

  it('tools check wallet connection', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/faf-tools.ts'), 'utf8');
    assert.ok(src.includes('No wallet connected'));
  });

  it('tools support NO_DNA agent mode', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/faf-tools.ts'), 'utf8');
    const agentChecks = (src.match(/IS_AGENT/g) || []).length;
    assert.ok(agentChecks >= 3, `expected >= 3 IS_AGENT checks, found ${agentChecks}`);
  });
});
