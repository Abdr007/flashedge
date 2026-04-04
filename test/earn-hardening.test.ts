/**
 * Earn System Hardening Tests
 *
 * Edge cases, invalid inputs, security, cache behavior,
 * and error handling for production safety.
 */

import { describe, it } from 'vitest';
import assert from 'assert';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { localParse } from '../src/ai/interpreter.js';
import { ActionType } from '../src/types/index.js';
import { resolvePool, getPoolRegistry, resolveTokenMint } from '../src/earn/pool-registry.js';
import { classifyRisk, simulateYield } from '../src/earn/yield-analytics.js';

const ROOT = resolve(import.meta.dirname, '..');

// ─── Input Validation ───────────────────────────────────────────────────────

describe('Earn Input Validation', () => {
  it('deposit tool validates positive amount', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/earn-tools.ts'), 'utf8');
    // Count Number.isFinite checks — should have at least 3 (deposit, stake, simulate)
    const checks = (src.match(/Number\.isFinite\(amount\)/g) || []).length;
    assert.ok(checks >= 3, `expected >= 3 amount validations, found ${checks}`);
  });

  it('withdraw tool validates percent range', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/earn-tools.ts'), 'utf8');
    // Should validate percent in both withdraw and unstake
    const percentChecks = (src.match(/percent < 1 \|\| percent > 100/g) || []).length;
    assert.ok(percentChecks >= 2, `expected >= 2 percent validations, found ${percentChecks}`);
  });

  it('wallet check exists for positions command', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/earn-tools.ts'), 'utf8');
    assert.ok(src.includes('No wallet connected'));
  });

  it('simulation mode check exists', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/earn-tools.ts'), 'utf8');
    assert.ok(src.includes('NOT_AVAILABLE_MSG'));
  });
});

// ─── Pool Resolution Edge Cases ─────────────────────────────────────────────

describe('Pool Resolution Edge Cases', () => {
  it('empty string returns null', () => {
    assert.strictEqual(resolvePool(''), null);
  });

  it('whitespace returns null', () => {
    assert.strictEqual(resolvePool('   '), null);
  });

  it('case-insensitive resolution', () => {
    assert.ok(resolvePool('CRYPTO'));
    assert.ok(resolvePool('Crypto'));
    assert.ok(resolvePool('crypto'));
  });

  it('unknown pool returns null', () => {
    assert.strictEqual(resolvePool('nonexistent_pool_xyz'), null);
    assert.strictEqual(resolvePool('rwa'), null); // excluded
  });

  it('pool ID resolution works', () => {
    assert.ok(resolvePool('Crypto.1'));
    assert.ok(resolvePool('Virtual.1'));
    assert.ok(resolvePool('Governance.1'));
  });
});

// ─── Token Mint Edge Cases ──────────────────────────────────────────────────

describe('Token Mint Edge Cases', () => {
  it('null/empty mint returns null', () => {
    assert.strictEqual(resolveTokenMint(''), null);
    assert.strictEqual(resolveTokenMint('11111111111111111111111111111111'), null);
  });

  it('random base58 returns null', () => {
    assert.strictEqual(resolveTokenMint('So11111111111111111111111111111112'), null);
  });
});

// ─── Yield Simulation Edge Cases ────────────────────────────────────────────

describe('Yield Simulation Edge Cases', () => {
  it('zero deposit returns zero yields', () => {
    const proj = simulateYield(0, 42);
    assert.strictEqual(proj.days7, 0);
    assert.strictEqual(proj.days365, 0);
  });

  it('negative APY handled gracefully', () => {
    const proj = simulateYield(1000, -10);
    assert.ok(proj.days365 < 0, 'negative APY should produce negative returns');
  });

  it('extremely high APY does not produce Infinity', () => {
    const proj = simulateYield(1000, 10000);
    assert.ok(Number.isFinite(proj.days365), 'should not be Infinity');
  });

  it('very small deposit works', () => {
    const proj = simulateYield(0.01, 42);
    assert.ok(proj.days365 >= 0);
  });
});

// ─── Risk Classification Edge Cases ─────────────────────────────────────────

describe('Risk Classification Edge Cases', () => {
  it('zero TVL = Very High risk', () => {
    assert.strictEqual(classifyRisk(0, 500), 'Very High');
  });

  it('zero APY with high TVL = Low risk', () => {
    assert.strictEqual(classifyRisk(5_000_000, 0), 'Low');
  });

  it('boundary: exactly $1M TVL and 80% APY', () => {
    const risk = classifyRisk(1_000_000, 80);
    assert.ok(risk === 'Low' || risk === 'Medium');
  });

  it('boundary: exactly $200K TVL', () => {
    const risk = classifyRisk(200_000, 50);
    assert.ok(risk === 'Medium' || risk === 'High');
  });
});

// ─── Cache Configuration ────────────────────────────────────────────────────

describe('Cache Configuration', () => {
  it('pool metrics cache TTL is 30 seconds', () => {
    const src = readFileSync(resolve(ROOT, 'src/earn/pool-data.ts'), 'utf8');
    assert.ok(src.includes('30_000'), 'cache TTL should be 30_000ms');
  });

  it('pool registry is lazily loaded and cached', () => {
    const src = readFileSync(resolve(ROOT, 'src/earn/pool-registry.ts'), 'utf8');
    assert.ok(src.includes('if (_registry) return _registry'));
  });
});

// ─── Command Parsing Edge Cases ─────────────────────────────────────────────

describe('Earn Parsing Edge Cases', () => {
  it('earn with unknown subcommand defaults to status', () => {
    const r = localParse('earn xyz');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnStatus);
  });

  it('earn deposit without amount defaults to status', () => {
    const r = localParse('earn deposit');
    assert.ok(r);
    // Should fall through to earn_status since no amount
    assert.strictEqual(r.action, ActionType.EarnStatus);
  });

  it('earn info without pool name works', () => {
    const r = localParse('earn info');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnInfo);
  });

  it('earn with special characters does not crash', () => {
    localParse('earn <script>alert(1)</script>');
    localParse('earn "; DROP TABLE pools;');
    assert.ok(true);
  });
});

// ─── NO_DNA / Automation Safety ─────────────────────────────────────────────

describe('Earn Automation Safety', () => {
  it('all major earn tools check IS_AGENT for JSON output', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/earn-tools.ts'), 'utf8');
    const agentChecks = (src.match(/IS_AGENT/g) || []).length;
    assert.ok(agentChecks >= 5, `expected >= 5 IS_AGENT checks, found ${agentChecks}`);
  });
});

// ─── Registry Completeness ──────────────────────────────────────────────────

describe('Registry Completeness', () => {
  it('all 7 active pools have FLP and sFLP mints', () => {
    const registry = getPoolRegistry();
    for (const pool of registry) {
      assert.ok(pool.flpMint, `${pool.poolId} missing flpMint`);
      assert.ok(pool.sflpMint, `${pool.poolId} missing sflpMint`);
      assert.ok(pool.flpMint.toBase58().length > 10, `${pool.poolId} flpMint too short`);
      assert.ok(pool.sflpMint.toBase58().length > 10, `${pool.poolId} sflpMint too short`);
    }
  });

  it('all pools have non-empty assets', () => {
    for (const pool of getPoolRegistry()) {
      assert.ok(pool.assets.length > 0, `${pool.poolId} has no assets`);
    }
  });

  it('all pools have valid fee share (0-1)', () => {
    for (const pool of getPoolRegistry()) {
      assert.ok(pool.feeShare > 0 && pool.feeShare <= 1, `${pool.poolId} invalid feeShare: ${pool.feeShare}`);
    }
  });

  it('no duplicate pool IDs', () => {
    const ids = getPoolRegistry().map(p => p.poolId);
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate pool IDs found');
  });
});
