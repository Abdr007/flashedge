/**
 * Parser v2 tests — symbol intelligence, command memory, learned aliases,
 * context resolution, and filler tolerance.
 */

import { describe, it, afterAll } from 'vitest';
import { localParse } from '../src/ai/interpreter.js';
import { ActionType, TradeSide } from '../src/types/index.js';
import { setAlias, removeAlias, clearCache } from '../src/cli/learned-aliases.js';
import { resolveMarket } from '../src/utils/market-resolver.js';
import assert from 'assert';

// ─── Symbol Intelligence ────────────────────────────────────────────────────

describe('Symbol Intelligence', () => {
  it('sol-perp → SOL', () => {
    assert.strictEqual(resolveMarket('sol-perp'), 'SOL');
  });

  it('sol perpetual → SOL', () => {
    assert.strictEqual(resolveMarket('sol perpetual'), 'SOL');
  });

  it('btc-perp → BTC', () => {
    assert.strictEqual(resolveMarket('btc-perp'), 'BTC');
  });

  it('eth-perpetual → ETH', () => {
    assert.strictEqual(resolveMarket('eth-perpetual'), 'ETH');
  });

  it('sol-perp long 2x 10 parses correctly', () => {
    const r = localParse('sol-perp long 2x 10');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual(r.side, TradeSide.Long);
  });

  it('sol perpetual long 2x 10 parses correctly', () => {
    const r = localParse('sol perpetual long 2x 10');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
  });
});

// ─── Complex Natural Language ───────────────────────────────────────────────

describe('Complex Natural Language', () => {
  it('i want to go long on solana with 50 bucks at 3x', () => {
    const r = localParse('i want to go long on solana with 50 bucks at 3x');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual(r.side, TradeSide.Long);
    assert.strictEqual(r.leverage, 3);
    assert.strictEqual(r.collateral, 50);
  });

  it('yo just long sol 5x 100', () => {
    const r = localParse('yo just long sol 5x 100');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual(r.leverage, 5);
    assert.strictEqual(r.collateral, 100);
  });

  it('hey can you open a 2x long on bitcoin with 50 dollars', () => {
    const r = localParse('hey can you open a 2x long on bitcoin with 50 dollars');
    assert.ok(r);
    assert.strictEqual(r.market, 'BTC');
    assert.strictEqual(r.collateral, 50);
  });

  it('ok go short ethereum 3x 20', () => {
    const r = localParse('ok go short ethereum 3x 20');
    assert.ok(r);
    assert.strictEqual(r.market, 'ETH');
    assert.strictEqual(r.side, TradeSide.Short);
  });

  it('open a 10x position on eth with 100', () => {
    const r = localParse('open a 10x position on eth with 100');
    assert.ok(r);
    assert.strictEqual(r.market, 'ETH');
    assert.strictEqual(r.leverage, 10);
    assert.strictEqual(r.collateral, 100);
  });
});

// ─── Learned Aliases ────────────────────────────────────────────────────────

describe('Learned Aliases', () => {
  afterAll(() => {
    removeAlias('lsol');
    removeAlias('sb');
    removeAlias('quicktrade');
    clearCache();
  });

  it('can set and use a simple alias', () => {
    setAlias('lsol', 'long sol');
    clearCache();
    const r = localParse('lsol 2x 10');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual(r.side, TradeSide.Long);
  });

  it('can set and use a multi-word alias', () => {
    setAlias('sb', 'short btc');
    clearCache();
    const r = localParse('sb 3x 50');
    assert.ok(r);
    assert.strictEqual(r.market, 'BTC');
    assert.strictEqual(r.side, TradeSide.Short);
  });

  it('can remove an alias', () => {
    setAlias('quicktrade', 'long sol 2x');
    clearCache();
    assert.ok(removeAlias('quicktrade'));
    clearCache();
    // After removal, should not expand
    const r = localParse('quicktrade 10');
    assert.strictEqual(r, null);
  });

  it('alias expansion is case-insensitive', () => {
    setAlias('LSOL', 'long sol');
    clearCache();
    const r = localParse('lsol 2x 10');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
  });
});

// ─── Context Resolution (these test the patterns, not live session) ─────────

describe('Context Resolution Patterns', () => {
  it('bare close pattern exists in context resolver', () => {
    // The context resolver handles "close" when session has a lastMarket
    // We can only test the pattern exists (actual context requires AIInterpreter)
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/ai/interpreter.ts'), 'utf8'
    );
    assert.ok(src.includes("'close'") || src.includes('/^close$/'));
  });

  it('increase leverage pattern exists', () => {
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/ai/interpreter.ts'), 'utf8'
    );
    assert.ok(src.includes('increase') && src.includes('leverage'));
  });

});

// ─── Comprehensive Parsing (all prompt examples) ───────────────────────────

describe('All Prompt Examples', () => {
  const cases: [string, string, string][] = [
    ['long sol 2x 10', 'SOL', 'long'],
    ['open long sol 10 dollars', 'SOL', 'long'],
    ['buy sol 10 2x', 'SOL', 'long'],
    ['enter a 2x long on sol with 10 bucks', 'SOL', 'long'],
    ['yo open a sol long for 10 usd at 2x', 'SOL', 'long'],
    ['sol long 2x 10', 'SOL', 'long'],
    ['10 usd sol long 2x', 'SOL', 'long'],
    ['please long sol using ten dollars leverage two', 'SOL', 'long'],
    ['short btc 3x 50', 'BTC', 'short'],
    ['short bitcoin for twenty dollars 5x', 'BTC', 'short'],
  ];

  for (const [input, market, side] of cases) {
    it(input, () => {
      const r = localParse(input);
      assert.ok(r, `should parse: ${input}`);
      assert.strictEqual(r.action, ActionType.OpenPosition);
      assert.strictEqual(r.market, market);
      assert.strictEqual(r.side, side);
    });
  }
});
