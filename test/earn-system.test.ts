/**
 * Earn System Tests
 *
 * Validates pool registry, alias resolution, command parsing,
 * token mint mapping, and earn command routing.
 */

import { describe, it } from 'vitest';
import assert from 'assert';
import { localParse } from '../src/ai/interpreter.js';
import { ActionType } from '../src/types/index.js';
import { getPoolRegistry, resolvePool, resolveTokenMint, getAllPoolAliases } from '../src/earn/pool-registry.js';

// ─── Pool Registry ──────────────────────────────────────────────────────────

describe('Pool Registry', () => {
  it('loads all 7 active pools', () => {
    const pools = getPoolRegistry();
    assert.ok(pools.length >= 7, `expected >= 7 pools, got ${pools.length}`);
  });

  it('each pool has required fields', () => {
    for (const pool of getPoolRegistry()) {
      assert.ok(pool.poolId, `poolId missing for ${pool.displayName}`);
      assert.ok(pool.displayName, 'displayName missing');
      assert.ok(pool.aliases.length > 0, 'aliases missing');
      assert.ok(pool.flpSymbol, 'flpSymbol missing');
      assert.ok(pool.sflpSymbol, 'sflpSymbol missing');
      assert.ok(pool.flpMint, 'flpMint missing');
      assert.ok(pool.sflpMint, 'sflpMint missing');
      assert.ok(pool.assets.length > 0, 'assets missing');
      assert.ok(pool.feeShare > 0, 'feeShare missing');
    }
  });

  it('excludes RWA pool', () => {
    const pools = getPoolRegistry();
    const rwa = pools.find(p => p.poolId.includes('Ondo') || p.displayName.includes('RWA'));
    assert.strictEqual(rwa, undefined, 'RWA pool should be excluded');
  });

  it('Crypto.1 has correct metadata', () => {
    const crypto = getPoolRegistry().find(p => p.poolId === 'Crypto.1');
    assert.ok(crypto);
    assert.strictEqual(crypto.flpSymbol, 'FLP.1');
    assert.strictEqual(crypto.sflpSymbol, 'sFLP.1');
    assert.strictEqual(crypto.feeShare, 0.70);
    assert.ok(crypto.assets.includes('SOL'));
    assert.ok(crypto.assets.includes('BTC'));
  });
});

// ─── Pool Resolution ────────────────────────────────────────────────────────

describe('Pool Resolution', () => {
  const cases: [string, string][] = [
    ['crypto', 'Crypto.1'],
    ['gold', 'Virtual.1'],
    ['defi', 'Governance.1'],
    ['governance', 'Governance.1'],
    ['meme', 'Community.1'],
    ['wif', 'Community.2'],
    ['ore', 'Ore.1'],
    ['fart', 'Trump.1'],
    ['trump', 'Trump.1'],
    ['Crypto.1', 'Crypto.1'],
    ['virtual', 'Virtual.1'],
    ['forex', 'Virtual.1'],
  ];

  for (const [alias, expected] of cases) {
    it(`"${alias}" → ${expected}`, () => {
      const pool = resolvePool(alias);
      assert.ok(pool, `should resolve: ${alias}`);
      assert.strictEqual(pool.poolId, expected);
    });
  }

  it('returns null for unknown pool', () => {
    assert.strictEqual(resolvePool('nonexistent'), null);
  });
});

// ─── Token Mint Resolution ──────────────────────────────────────────────────

describe('Token Mint Resolution', () => {
  it('resolves FLP.1 mint to crypto pool', () => {
    const crypto = getPoolRegistry().find(p => p.poolId === 'Crypto.1')!;
    const result = resolveTokenMint(crypto.flpMint.toBase58());
    assert.ok(result);
    assert.strictEqual(result.pool.poolId, 'Crypto.1');
    assert.strictEqual(result.type, 'FLP');
  });

  it('resolves sFLP.1 mint to crypto pool', () => {
    const crypto = getPoolRegistry().find(p => p.poolId === 'Crypto.1')!;
    const result = resolveTokenMint(crypto.sflpMint.toBase58());
    assert.ok(result);
    assert.strictEqual(result.pool.poolId, 'Crypto.1');
    assert.strictEqual(result.type, 'sFLP');
  });

  it('returns null for unknown mint', () => {
    assert.strictEqual(resolveTokenMint('11111111111111111111111111111111'), null);
  });
});

// ─── Earn Command Parsing ───────────────────────────────────────────────────

describe('Earn Command Parsing', () => {
  it('earn → earn_status', () => {
    const r = localParse('earn');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnStatus);
  });

  it('earn pools → earn_status', () => {
    const r = localParse('earn pools');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnStatus);
  });

  it('earn info crypto → earn_info', () => {
    const r = localParse('earn info crypto');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnInfo);
  });

  it('earn deposit $100 crypto → earn_add_liquidity', () => {
    const r = localParse('earn deposit $100 crypto');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnAddLiquidity);
    assert.strictEqual((r as any).amount, 100);
  });

  it('earn add $50 gold → earn_add_liquidity', () => {
    const r = localParse('earn add $50 gold');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnAddLiquidity);
  });

  it('earn withdraw 50% crypto → earn_remove_liquidity', () => {
    const r = localParse('earn withdraw 50% crypto');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnRemoveLiquidity);
    assert.strictEqual((r as any).percent, 50);
  });

  it('earn remove 100% gold → earn_remove_liquidity', () => {
    const r = localParse('earn remove 100% gold');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnRemoveLiquidity);
  });

  it('earn stake $100 crypto → earn_stake', () => {
    const r = localParse('earn stake $100 crypto');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnStake);
  });

  it('earn unstake 50% crypto → earn_unstake', () => {
    const r = localParse('earn unstake 50% crypto');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnUnstake);
  });

  it('earn claim crypto → earn_claim_rewards', () => {
    const r = localParse('earn claim crypto');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnClaimRewards);
  });

  it('earn positions → earn_positions', () => {
    const r = localParse('earn positions');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnPositions);
  });
});

// ─── Pool Aliases for Autocomplete ──────────────────────────────────────────

describe('Pool Aliases', () => {
  it('getAllPoolAliases returns all aliases', () => {
    const aliases = getAllPoolAliases();
    assert.ok(aliases.includes('crypto'));
    assert.ok(aliases.includes('gold'));
    assert.ok(aliases.includes('defi'));
    assert.ok(aliases.includes('meme'));
    assert.ok(aliases.includes('wif'));
    assert.ok(aliases.includes('ore'));
    assert.ok(aliases.includes('fart'));
  });
});
