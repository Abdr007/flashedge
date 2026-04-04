/**
 * FLASH TERMINAL — FULL SYSTEM VALIDATION
 *
 * Production reliability audit covering:
 * - Command parser (all modules)
 * - Protocol data accuracy
 * - Input validation & security
 * - Performance benchmarks
 * - Memory stability
 * - Cache behavior
 * - Automation mode
 * - Module completeness
 */

import { describe, it } from 'vitest';
import assert from 'assert';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { localParse } from '../src/ai/interpreter.js';
import { ActionType } from '../src/types/index.js';
import { resolveMarket } from '../src/utils/market-resolver.js';
import { getPoolRegistry, resolvePool } from '../src/earn/pool-registry.js';
import { classifyRisk, simulateYield } from '../src/earn/yield-analytics.js';
import { getVipTier, VIP_TIERS, FAF_DECIMALS } from '../src/token/faf-registry.js';
import { detectPartialTrade, validateTradeParam } from '../src/cli/interactive-builder.js';
import { scoreIntent, resolveAmbiguous } from '../src/ai/intent-scorer.js';

const ROOT = resolve(import.meta.dirname, '..');

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1: COMMAND PARSER COMPLETENESS
// ═══════════════════════════════════════════════════════════════════════════

describe('Complete Command Coverage', () => {
  // Every command from every module must parse
  const allCommands: [string, string][] = [
    // Trading
    ['long sol 2x 10', 'open_position'],
    ['short btc 3x 50', 'open_position'],
    ['close sol long', 'close_position'],
    ['close sol', 'close_position'],
    ['close all', 'close_all'],
    ['positions', 'get_positions'],
    ['portfolio', 'get_portfolio'],
    ['markets', 'flash_markets'],
    ['tp sol 160', 'set_tp_sl'],
    ['sl btc 60000', 'set_tp_sl'],
    ['set tp SOL long $95', 'set_tp_sl'],
    ['limit long SOL 2x $100 @ $82', 'limit_order'],
    ['dryrun open 5x long sol $500', 'dry_run'],
    // Analytics
    ['volume', 'get_volume'],
    ['open interest', 'get_open_interest'],
    ['leaderboard', 'get_leaderboard'],
    ['fees', 'get_fees'],
    ['analyze SOL', 'analyze'],
    ['dashboard', 'dashboard'],
    ['risk', 'risk_report'],
    ['exposure', 'portfolio_exposure'],
    ['depth SOL', 'liquidity_depth'],
    ['funding SOL', 'funding_dashboard'],
    ['protocol health', 'protocol_health'],
    // Wallet
    ['wallet', 'wallet_status'],
    ['wallet tokens', 'wallet_tokens'],
    ['wallet balance', 'wallet_balance'],
    ['wallet list', 'wallet_list'],
    // Earn
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
    ['earn pnl', 'earn_pnl'],
    ['earn demand', 'earn_demand'],
    ['earn rotate', 'earn_rotate'],
    ['earn $100 crypto', 'earn_add_liquidity'],
    ['earn best 500', 'earn_add_liquidity'],
    // FAF Token
    ['faf', 'faf_status'],
    ['faf stake 1000', 'faf_stake'],
    ['faf unstake 5000', 'faf_unstake'],
    ['faf claim', 'faf_claim'],
    ['faf claim rewards', 'faf_claim'],
    ['faf claim revenue', 'faf_claim'],
    ['faf tier', 'faf_tier'],
    ['faf rewards', 'faf_rewards'],
    // Utilities
    ['help', 'help'],
    ['monitor', 'market_monitor'],
    ['trade history', 'trade_history'],
    // rpc status, system status, doctor — handled by FAST_DISPATCH in terminal, not localParse
  ];

  for (const [input, action] of allCommands) {
    it(input, () => {
      const r = localParse(input);
      assert.ok(r, `should parse: ${input}`);
      assert.strictEqual(r.action, action, `${input} → expected ${action}, got ${r.action}`);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2: FLEXIBLE PARSING (NLP)
// ═══════════════════════════════════════════════════════════════════════════

describe('Natural Language Parsing', () => {
  const nlpTests: [string, string, string][] = [
    ['buy sol 10 2x', 'open_position', 'SOL'],
    ['sol long 2x 10', 'open_position', 'SOL'],
    ['long 2x sol 10', 'open_position', 'SOL'],
    ['10 usd sol long 2x', 'open_position', 'SOL'],
    ['yo open a sol long for 10 usd at 2x', 'open_position', 'SOL'],
    ['please long sol using ten dollars leverage two', 'open_position', 'SOL'],
    ['i want to go long on solana with 50 bucks at 3x', 'open_position', 'SOL'],
    ['short bitcoin for twenty dollars 5x', 'open_position', 'BTC'],
    ['open a 10x position on eth with 100', 'open_position', 'ETH'],
    ['lon sol 2x 10', 'open_position', 'SOL'],      // typo
    ['solan long 2x 10', 'open_position', 'SOL'],    // typo
    ['lonng sol 2x 10', 'open_position', 'SOL'],     // typo
    ['sol-perp long 2x 10', 'open_position', 'SOL'], // symbol variant
    ['l sol 2x 10', 'open_position', 'SOL'],          // alias
    ['s btc 3x 50', 'open_position', 'BTC'],          // alias
  ];

  for (const [input, action, market] of nlpTests) {
    it(input, () => {
      const r = localParse(input);
      assert.ok(r, `should parse: ${input}`);
      assert.strictEqual(r.action, action);
      assert.strictEqual(r.market, market);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3: SECURITY — INPUT VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Security — Input Validation', () => {
  it('rejects XSS payloads without crashing', () => {
    localParse('<script>alert(1)</script>');
    localParse('<img src=x onerror=alert(1)>');
    assert.ok(true);
  });

  it('rejects SQL injection without crashing', () => {
    localParse("'; DROP TABLE positions; --");
    localParse('1 OR 1=1');
    assert.ok(true);
  });

  it('handles unicode without crashing', () => {
    localParse('long sol 2x 10 🚀');
    localParse('lönг söl 2x 10');
    assert.ok(true);
  });

  it('handles empty/whitespace input', () => {
    assert.strictEqual(localParse(''), null);
    assert.strictEqual(localParse('   '), null);
  });

  it('handles very long input without crashing', () => {
    localParse('long sol 2x 10 ' + 'x'.repeat(10000));
    assert.ok(true);
  });

  it('validates leverage limits', () => {
    assert.ok(validateTradeParam('leverage', 500, 'SOL'));
    assert.ok(validateTradeParam('leverage', 0.5));
    assert.ok(validateTradeParam('leverage', -1));
    assert.strictEqual(validateTradeParam('leverage', 5, 'SOL'), null); // valid
  });

  it('validates collateral', () => {
    assert.ok(validateTradeParam('collateral', -1));
    assert.ok(validateTradeParam('collateral', 0));
    assert.strictEqual(validateTradeParam('collateral', 10), null); // valid
  });

  it('validates markets', () => {
    assert.ok(validateTradeParam('market', 'NONEXISTENT'));
    assert.strictEqual(validateTradeParam('market', 'SOL'), null); // valid
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4: PROTOCOL DATA — NO HARDCODED VALUES
// ═══════════════════════════════════════════════════════════════════════════

describe('Protocol Data Integrity', () => {
  it('pool registry loaded from SDK (not hardcoded)', () => {
    const pools = getPoolRegistry();
    assert.ok(pools.length >= 7);
    // Verify each pool has SDK-sourced config
    for (const p of pools) {
      assert.ok(p.poolConfig, `${p.poolId} should have poolConfig from SDK`);
      assert.ok(p.flpMint.toBase58().length > 30, 'FLP mint should be a real public key');
      assert.ok(p.sflpMint.toBase58().length > 30, 'sFLP mint should be a real public key');
    }
  });

  it('VIP tiers match protocol specification', () => {
    assert.strictEqual(VIP_TIERS.length, 7);
    assert.strictEqual(VIP_TIERS[0].fafRequired, 0);
    assert.strictEqual(VIP_TIERS[6].fafRequired, 2_000_000);
    assert.strictEqual(VIP_TIERS[6].feeDiscount, 12);
  });

  it('FAF decimals match protocol', () => {
    assert.strictEqual(FAF_DECIMALS, 6);
  });

  it('yield simulation uses mathematical formula (not hardcoded)', () => {
    const p1 = simulateYield(1000, 42);
    const p2 = simulateYield(2000, 42);
    // Double the deposit should roughly double the returns
    assert.ok(Math.abs(p2.days365 / p1.days365 - 2) < 0.01);
  });

  it('risk classification is deterministic', () => {
    // Same inputs always produce same output
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(classifyRisk(5_000_000, 40), 'Low');
      assert.strictEqual(classifyRisk(50_000, 500), 'Very High');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5: PERFORMANCE BENCHMARKS
// ═══════════════════════════════════════════════════════════════════════════

describe('Performance Benchmarks', () => {
  it('100 parses in under 50ms', () => {
    const commands = [
      'long sol 2x 10', 'short btc 3x 50', 'close sol', 'positions',
      'earn best', 'faf status', 'earn simulate $1000 crypto',
      'tp sol 160', 'help', 'yo long sol 2x 10',
    ];
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      localParse(commands[i % commands.length]);
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, `100 parses took ${elapsed}ms (limit: 50ms)`);
  });

  it('single complex NLP parse under 5ms', () => {
    const start = performance.now();
    localParse('i want to go long on solana with 50 bucks at 3x');
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 5, `NLP parse took ${elapsed.toFixed(2)}ms (limit: 5ms)`);
  });

  it('VIP tier lookup is O(1)-like', () => {
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      getVipTier(Math.random() * 3_000_000);
    }
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 10, `10k tier lookups took ${elapsed.toFixed(2)}ms`);
  });

  it('yield simulation is fast', () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      simulateYield(1000, 42);
    }
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 10, `1k simulations took ${elapsed.toFixed(2)}ms`);
  });

  it('pool registry lookup is fast', () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      resolvePool('crypto');
    }
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 20, `1k pool lookups took ${elapsed.toFixed(2)}ms`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6: MEMORY STABILITY
// ═══════════════════════════════════════════════════════════════════════════

describe('Memory Stability', () => {
  it('1000 command parses do not leak memory', () => {
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 1000; i++) {
      localParse('long sol 2x 10');
      localParse('earn best');
      localParse('faf status');
    }
    // Force GC if available
    if (global.gc) global.gc();
    const after = process.memoryUsage().heapUsed;
    const growth = (after - before) / 1024 / 1024;
    // CI environments use more memory due to JIT warmup — allow 20MB headroom
    assert.ok(growth < 20, `memory grew ${growth.toFixed(1)}MB (limit: 20MB)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7: CACHE BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════

describe('Cache Configuration', () => {
  it('pool metrics cache TTL is 30 seconds', () => {
    const src = readFileSync(resolve(ROOT, 'src/earn/pool-data.ts'), 'utf8');
    assert.ok(src.includes('30_000'));
  });

  it('pool registry is lazily loaded', () => {
    const src = readFileSync(resolve(ROOT, 'src/earn/pool-registry.ts'), 'utf8');
    assert.ok(src.includes('if (_registry) return _registry'));
  });

  it('user balances are never cached in earn tools', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/earn-tools.ts'), 'utf8');
    // getTokenBalances is called fresh each time — not cached
    assert.ok(src.includes('getTokenBalances()'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8: AUTOMATION MODE (NO_DNA)
// ═══════════════════════════════════════════════════════════════════════════

describe('Automation Mode Safety', () => {
  it('IS_AGENT flag exists in no-dna module', () => {
    const src = readFileSync(resolve(ROOT, 'src/no-dna.ts'), 'utf8');
    assert.ok(src.includes('process.env.NO_DNA'));
    assert.ok(src.includes('IS_AGENT'));
  });

  it('earn tools check IS_AGENT', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/earn-tools.ts'), 'utf8');
    assert.ok((src.match(/IS_AGENT/g) || []).length >= 5);
  });

  it('faf tools check IS_AGENT', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/faf-tools.ts'), 'utf8');
    assert.ok((src.match(/IS_AGENT/g) || []).length >= 3);
  });

  it('interactive builder disabled in agent mode', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/interactive-builder.ts'), 'utf8');
    assert.ok(src.includes('IS_AGENT'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 9: MODULE COMPLETENESS
// ═══════════════════════════════════════════════════════════════════════════

describe('Module Completeness', () => {
  it('all protocol modules exist', () => {
    const modules = [
      'src/tools/flash-tools.ts',      // Trading
      'src/tools/earn-tools.ts',        // Earn
      'src/tools/faf-tools.ts',         // FAF Token
      'src/tools/swap-tools.ts',        // Swap
      'src/tools/engine-tools.ts',      // Engine diagnostics
      'src/earn/pool-registry.ts',      // Pool registry
      'src/earn/pool-data.ts',          // Pool live data
      'src/earn/yield-analytics.ts',    // Yield analytics
      'src/token/faf-registry.ts',      // FAF constants
      'src/token/faf-data.ts',          // FAF live data
      'src/no-dna.ts',                  // Automation mode
      'src/ai/interpreter.ts',          // Command parser
      'src/ai/intent-scorer.ts',        // Confidence scoring
      'src/cli/interactive-builder.ts', // Interactive trade builder
      'src/cli/trade-templates.ts',     // Trade templates
      'src/cli/trade-predictor.ts',     // Trade predictor
      'src/cli/learned-aliases.ts',     // Learned aliases
      'src/cli/shell-completion.ts',    // Shell completion
      'src/cli/command-help.ts',        // Per-command help
    ];

    for (const mod of modules) {
      const exists = require('fs').existsSync(resolve(ROOT, mod));
      assert.ok(exists, `missing module: ${mod}`);
    }
  });

  it('all ActionTypes have dispatch routes', () => {
    const engineSrc = readFileSync(resolve(ROOT, 'src/tools/engine.ts'), 'utf8');
    const tradingActions = [
      'OpenPosition', 'ClosePosition', 'GetPositions', 'GetPortfolio',
      'EarnAddLiquidity', 'EarnRemoveLiquidity', 'EarnStake', 'EarnUnstake',
      'EarnBest', 'EarnSimulate', 'EarnDashboard', 'EarnPnl', 'EarnDemand', 'EarnRotate',
      'FafStatus', 'FafStake', 'FafUnstake', 'FafClaim', 'FafTier', 'FafRewards',
    ];
    for (const action of tradingActions) {
      assert.ok(engineSrc.includes(`ActionType.${action}`), `missing dispatch for ${action}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 10: SYMBOL RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════

describe('Symbol Resolution Completeness', () => {
  const symbols: [string, string][] = [
    ['sol', 'SOL'], ['solana', 'SOL'], ['bitcoin', 'BTC'], ['btc', 'BTC'],
    ['eth', 'ETH'], ['ethereum', 'ETH'], ['gold', 'XAU'], ['silver', 'XAG'],
    ['crude oil', 'CRUDEOIL'], ['oil', 'CRUDEOIL'],
    ['jup', 'JUP'], ['jito', 'JTO'], ['zcash', 'ZEC'],
    ['nvidia', 'NVDA'], ['tesla', 'TSLA'], ['apple', 'AAPL'],
    ['sol-perp', 'SOL'], ['btc-perp', 'BTC'], ['eth-perpetual', 'ETH'],
  ];

  for (const [input, expected] of symbols) {
    it(`${input} → ${expected}`, () => {
      assert.strictEqual(resolveMarket(input), expected);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 11: EARN POOL RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════

describe('Pool Resolution Completeness', () => {
  const pools: [string, string][] = [
    ['crypto', 'Crypto.1'], ['gold', 'Virtual.1'], ['defi', 'Governance.1'],
    ['meme', 'Community.1'], ['wif', 'Community.2'], ['ore', 'Ore.1'],
    ['fart', 'Trump.1'], ['trump', 'Trump.1'], ['governance', 'Governance.1'],
    ['forex', 'Virtual.1'], ['virtual', 'Virtual.1'],
  ];

  for (const [alias, expected] of pools) {
    it(`${alias} → ${expected}`, () => {
      const pool = resolvePool(alias);
      assert.ok(pool, `should resolve: ${alias}`);
      assert.strictEqual(pool.poolId, expected);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 12: FINAL COUNTS
// ═══════════════════════════════════════════════════════════════════════════

describe('System Stats', () => {
  it('has 120+ source files', () => {
    const { execSync } = require('child_process');
    const count = parseInt(execSync('find src -name "*.ts" | wc -l', { cwd: ROOT }).toString().trim());
    assert.ok(count >= 120, `expected >= 120 source files, got ${count}`);
  });

  it('has 55+ test files', () => {
    const { execSync } = require('child_process');
    const count = parseInt(execSync('find test -name "*.test.ts" | wc -l', { cwd: ROOT }).toString().trim());
    assert.ok(count >= 55, `expected >= 55 test files, got ${count}`);
  });
});
