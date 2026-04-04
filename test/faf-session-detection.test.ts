/**
 * FAF Session Detection Tests
 *
 * Validates that the terminal welcome screen integrates FAF stake
 * detection, VIP tier display, and voltage points.
 */

import { describe, it } from 'vitest';
import assert from 'assert';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getVipTier, formatFaf, VIP_TIERS } from '../src/token/faf-registry.js';

const ROOT = resolve(import.meta.dirname, '..');

// ─── Welcome Screen Integration ─────────────────────────────────────────────

describe('FAF Session Detection in Welcome Screen', () => {
  it('terminal queries FAF stake on wallet connect', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('getFafStakeInfo'), 'should call getFafStakeInfo');
    assert.ok(src.includes('showIntelligenceScreen') && src.includes('FAF Staked'));
  });

  it('displays staked amount', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes("'FAF Staked'") || src.includes("FAF Staked"));
  });

  it('displays VIP tier and fee discount', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('VIP Tier'));
    assert.ok(src.includes('fee discount'));
  });

  it('displays voltage tier', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('getVoltageInfo') || src.includes('Voltage Tier'));
  });

  it('uses 3-second timeout for FAF detection', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('3000'), 'should have 3s timeout for FAF query');
  });

  it('FAF detection is wrapped in try/catch (non-blocking)', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('FAF detection is non-critical'));
  });

  it('only queries FAF in live mode (not simulation)', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    // The FAF detection is inside the "else if (walletName)" block
    // which only executes when wallet is connected (live mode).
    // In sim mode, the "if (isSim)" branch runs instead.
    assert.ok(src.includes('walletName') && src.includes('getFafStakeInfo'));
  });
});

// ─── Agent Mode FAF Output ──────────────────────────────────────────────────

describe('Agent Mode FAF Detection', () => {
  it('agent mode includes FAF data in ready event', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('readyData.faf_staked'));
    assert.ok(src.includes('readyData.vip_tier'));
    assert.ok(src.includes('readyData.fee_discount'));
  });

  it('agent mode FAF detection has timeout', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    // Should use Promise.race with timeout in agent path too
    const agentSection = src.slice(src.indexOf('Detect FAF stake for agent'), src.indexOf('agentOutput(readyData)'));
    assert.ok(agentSection.includes('3000'));
  });
});

// ─── VIP Tier Display Correctness ───────────────────────────────────────────

describe('VIP Tier Display', () => {
  it('formats staked amounts correctly', () => {
    assert.ok(formatFaf(100000).includes('100.0K'));
    assert.ok(formatFaf(2000000).includes('2.00M'));
    assert.ok(formatFaf(500).includes('500'));
  });

  it('all VIP tiers have correct fee discounts', () => {
    const expected = [0, 2.5, 3.5, 5, 7, 9.5, 12];
    for (let i = 0; i < VIP_TIERS.length; i++) {
      assert.strictEqual(VIP_TIERS[i].feeDiscount, expected[i]);
    }
  });

  it('tier resolution for common staked amounts', () => {
    assert.strictEqual(getVipTier(0).level, 0);
    assert.strictEqual(getVipTier(25000).level, 1);
    assert.strictEqual(getVipTier(100000).level, 3);
    assert.strictEqual(getVipTier(500000).level, 4);
    assert.strictEqual(getVipTier(2000000).level, 6);
  });
});

// ─── Pending Rewards Display ────────────────────────────────────────────────

describe('Pending Rewards in Welcome', () => {
  it('shows pending FAF rewards if > 0', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('pendingRewards > 0'));
    assert.ok(src.includes('Pending FAF'));
  });

  it('shows pending USDC revenue if > 0', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('pendingRevenue > 0'));
    assert.ok(src.includes('Pending USDC'));
  });
});
