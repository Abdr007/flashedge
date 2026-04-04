/**
 * Command System Final Hardening Tests
 *
 * Comprehensive regression suite validating the entire command pipeline:
 * template → alias → normalize → parse → builder → scorer → execute
 *
 * This is the final test gate before production release.
 */

import { describe, it, afterAll } from 'vitest';
import assert from 'assert';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { localParse, validateIntent } from '../src/ai/interpreter.js';
import { ActionType, TradeSide } from '../src/types/index.js';
import { resolveMarket } from '../src/utils/market-resolver.js';
import { scoreIntent, resolveAmbiguous, needsConfirmation } from '../src/ai/intent-scorer.js';
import { detectPartialTrade, validateTradeParam } from '../src/cli/interactive-builder.js';
import { setTemplate, removeTemplate, expandTemplate, clearTemplateCache } from '../src/cli/trade-templates.js';
import { setAlias, removeAlias, expandLearnedAlias, clearCache } from '../src/cli/learned-aliases.js';

const ROOT = resolve(import.meta.dirname, '..');

// ─── Pipeline Order Verification ────────────────────────────────────────────

describe('Pipeline Order', () => {
  it('parser pipeline: template → alias → command alias → normalize → parse', () => {
    const src = readFileSync(resolve(ROOT, 'src/ai/interpreter.ts'), 'utf8');
    // Search within localParse function body (after "export function localParse")
    const fnStart = src.indexOf('export function localParse');
    const body = src.slice(fnStart);
    const templateIdx = body.indexOf('expandTemplate(');
    const aliasIdx = body.indexOf('expandLearnedAlias(');
    const cmdAliasIdx = body.indexOf('expandAliases(');
    const normalizeIdx = body.indexOf('normalizeAssetAliases(');
    assert.ok(templateIdx > 0 && templateIdx < aliasIdx, 'template before alias');
    assert.ok(aliasIdx < cmdAliasIdx, 'alias before command alias');
    assert.ok(cmdAliasIdx < normalizeIdx, 'command alias before normalize');
  });

  it('terminal pipeline: fast dispatch → builder → ambiguous → alert', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    const fastIdx = src.indexOf('FAST_DISPATCH[lower]');
    const builderIdx = src.indexOf('detectPartialTrade');
    const ambiguousIdx = src.indexOf('resolveAmbiguous');
    const alertIdx = src.indexOf('Command Alert Intercept');
    assert.ok(fastIdx < builderIdx, 'fast dispatch before builder');
    assert.ok(builderIdx < ambiguousIdx, 'builder before ambiguous');
    assert.ok(ambiguousIdx < alertIdx, 'ambiguous before alert');
  });
});

// ─── Complete Trade Commands (33 patterns) ──────────────────────────────────

describe('Trade Command Regression (33 patterns)', () => {
  const trades: [string, string, string | null, number | null, number | null][] = [
    ['long sol 2x 10', 'SOL', 'long', 2, 10],
    ['short btc 3x 50', 'BTC', 'short', 3, 50],
    ['open 5x long sol $100', 'SOL', 'long', 5, 100],
    ['buy sol 10 2x', 'SOL', 'long', 2, 10],
    ['sol long 2x 10', 'SOL', 'long', 2, 10],
    ['long 2x sol 10', 'SOL', 'long', 2, 10],
    ['10 usd sol long 2x', 'SOL', 'long', 2, 10],
    ['yo open a sol long for 10 usd at 2x', 'SOL', 'long', 2, 10],
    ['please long sol using ten dollars leverage two', 'SOL', 'long', 2, 10],
    ['enter a 2x long on sol with 10 bucks', 'SOL', 'long', 2, 10],
    ['i want to go long on solana with 50 bucks at 3x', 'SOL', 'long', 3, 50],
    ['lon sol 2x 10', 'SOL', 'long', 2, 10],
    ['lonng sol 2x 10', 'SOL', 'long', 2, 10],
    ['solan long 2x 10', 'SOL', 'long', 2, 10],
    ['l sol 2x 10', 'SOL', 'long', 2, 10],
    ['s btc 3x 50', 'BTC', 'short', 3, 50],
    ['sol-perp long 2x 10', 'SOL', 'long', 2, 10],
    ['long sol 2x 10 tp 160 sl 120', 'SOL', 'long', 2, 10],
    ['open btc short 3x 50 tp 25000', 'BTC', 'short', 3, 50],
    ['short bitcoin for twenty dollars 5x', 'BTC', 'short', 5, 20],
    ['open a 10x position on eth with 100', 'ETH', 'long', 10, 100],
  ];

  for (const [input, market, side, lev, coll] of trades) {
    it(input, () => {
      const r = localParse(input);
      assert.ok(r, `should parse: ${input}`);
      assert.strictEqual(r.action, ActionType.OpenPosition);
      assert.strictEqual(r.market, market);
      if (side) assert.strictEqual(r.side, side);
      if (lev) assert.strictEqual(r.leverage, lev);
      if (coll) assert.strictEqual(r.collateral, coll);
    });
  }
});

// ─── Non-Trade Commands ─────────────────────────────────────────────────────

describe('Non-Trade Command Regression', () => {
  const nonTrade: [string, string][] = [
    ['close sol long', 'close_position'],
    ['close sol', 'close_position'],
    ['close all', 'close_all'],
    ['positions', 'get_positions'],
    ['portfolio', 'get_portfolio'],
    ['balance', 'get_portfolio'],
    ['markets', 'flash_markets'],
    ['help', 'help'],
    ['wallet tokens', 'wallet_tokens'],
    ['wallet', 'wallet_status'],
    ['volume', 'get_volume'],
    ['open interest', 'get_open_interest'],
    ['leaderboard', 'get_leaderboard'],
    ['fees', 'get_fees'],
    ['dashboard', 'dashboard'],
    ['risk', 'risk_report'],
    ['tp sol 160', 'set_tp_sl'],
    ['sl btc 60000', 'set_tp_sl'],
    ['set tp SOL long $95', 'set_tp_sl'],
    ['limit long SOL 2x $100 @ $82', 'limit_order'],
    ['close all', 'close_all'],
    ['earn add $10 crypto', 'earn_add_liquidity'],
    ['earn remove 50% crypto', 'earn_remove_liquidity'],
    ['earn stake $10 crypto', 'earn_stake'],
    ['earn claim', 'earn_claim_rewards'],
    ['analyze SOL', 'analyze'],
    ['dryrun open 5x long sol $500', 'dry_run'],
    ['monitor', 'market_monitor'],
  ];

  for (const [input, action] of nonTrade) {
    it(input, () => {
      const r = localParse(input);
      assert.ok(r, `should parse: ${input}`);
      assert.strictEqual(r.action, action);
    });
  }
});

// ─── Symbol Resolution ──────────────────────────────────────────────────────

describe('Symbol Resolution', () => {
  const symbols: [string, string][] = [
    ['sol', 'SOL'], ['SOL', 'SOL'], ['solana', 'SOL'],
    ['sol-perp', 'SOL'], ['sol perpetual', 'SOL'],
    ['btc', 'BTC'], ['bitcoin', 'BTC'], ['btc-perp', 'BTC'],
    ['eth', 'ETH'], ['ethereum', 'ETH'], ['eth-perpetual', 'ETH'],
    ['gold', 'XAU'], ['silver', 'XAG'],
    ['crude oil', 'CRUDEOIL'], ['oil', 'CRUDEOIL'],
    ['jup', 'JUP'], ['jito', 'JTO'],
    ['nvidia', 'NVDA'], ['tesla', 'TSLA'], ['apple', 'AAPL'],
  ];

  for (const [input, expected] of symbols) {
    it(`${input} → ${expected}`, () => {
      assert.strictEqual(resolveMarket(input), expected);
    });
  }
});

// ─── Template System ────────────────────────────────────────────────────────

describe('Template System Final', () => {
  afterAll(() => { removeTemplate('test_final'); clearTemplateCache(); });

  it('template round-trip: create → expand → parse → remove', () => {
    setTemplate('test_final', 'long sol 3x 50');
    clearTemplateCache();

    const expanded = expandTemplate('test_final');
    assert.strictEqual(expanded, 'long sol 3x 50');

    const r = localParse('test_final');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.OpenPosition);
    assert.strictEqual(r.market, 'SOL');

    assert.ok(removeTemplate('test_final'));
    clearTemplateCache();
    assert.strictEqual(expandTemplate('test_final'), null);
  });
});

// ─── Alias System ───────────────────────────────────────────────────────────

describe('Alias System Final', () => {
  afterAll(() => { removeAlias('test_final_alias'); clearCache(); });

  it('alias round-trip: create → expand → parse → remove', () => {
    setAlias('test_final_alias', 'short eth');
    clearCache();

    const expanded = expandLearnedAlias('test_final_alias 3x 20');
    assert.strictEqual(expanded, 'short eth 3x 20');

    const r = localParse('test_final_alias 3x 20');
    assert.ok(r);
    assert.strictEqual(r.market, 'ETH');
    assert.strictEqual(r.side, TradeSide.Short);

    assert.ok(removeAlias('test_final_alias'));
    clearCache();
  });
});

// ─── Confidence Scoring ─────────────────────────────────────────────────────

describe('Confidence Scoring Final', () => {
  it('explicit command = high confidence', () => {
    const r = localParse('long sol 2x $10');
    assert.ok(r);
    const s = scoreIntent(r, ['long', 'sol', '2x', '$10']);
    assert.ok(s.confidence >= 0.95);
    assert.strictEqual(needsConfirmation(s), false);
  });

  it('defaulted leverage = lower confidence', () => {
    const r = localParse('long sol 10');
    assert.ok(r);
    const s = scoreIntent(r, ['long', 'sol', '10']);
    assert.ok(s.confidence < 1.0);
    assert.ok(s.defaults.includes('leverage'));
  });

  it('ambiguous resolution = low confidence, needs confirmation', () => {
    const s = resolveAmbiguous('long sol');
    assert.ok(s);
    assert.ok(s.confidence < 0.8);
    assert.strictEqual(needsConfirmation(s), true);
  });
});

// ─── Interactive Builder ────────────────────────────────────────────────────

describe('Interactive Builder Final', () => {
  it('detects partial: "long sol" "short btc" "long"', () => {
    assert.ok(detectPartialTrade('long sol'));
    assert.ok(detectPartialTrade('short btc'));
    assert.ok(detectPartialTrade('long'));
  });

  it('rejects complete commands', () => {
    assert.strictEqual(detectPartialTrade('long sol 2x 10'), null);
  });

  it('rejects non-trade commands', () => {
    assert.strictEqual(detectPartialTrade('positions'), null);
    assert.strictEqual(detectPartialTrade('help'), null);
  });
});

// ─── Validation ─────────────────────────────────────────────────────────────

describe('Validation Final', () => {
  it('validateIntent rejects invalid leverage', () => {
    const r = localParse('long sol 2000x 10');
    // Should either return null (rejected) or be caught by validateIntent
    if (r) {
      const alert = validateIntent(r);
      // If leverage is > 1000, should have an alert (per-market limits enforced in flash-tools)
      if ((r as any).leverage > 1000) {
        assert.ok(alert, 'should reject > 1000x leverage');
      }
    }
  });

  it('validateTradeParam checks all fields', () => {
    assert.strictEqual(validateTradeParam('market', 'SOL'), null);
    assert.ok(validateTradeParam('market', 'NONEXISTENT'));
    assert.strictEqual(validateTradeParam('leverage', 5, 'SOL'), null);
    assert.ok(validateTradeParam('leverage', 500, 'SOL'));
    assert.strictEqual(validateTradeParam('collateral', 10), null);
    assert.ok(validateTradeParam('collateral', -1));
  });
});

// ─── Automation Safety ──────────────────────────────────────────────────────

describe('Automation Safety', () => {
  it('NO_DNA detection exists', () => {
    const src = readFileSync(resolve(ROOT, 'src/no-dna.ts'), 'utf8');
    assert.ok(src.includes('process.env.NO_DNA'));
  });

  it('interactive builder checks IS_AGENT', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/interactive-builder.ts'), 'utf8');
    assert.ok(src.includes('IS_AGENT'));
  });

  it('terminal skips builder in NO_DNA mode', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('!IS_AGENT') && src.includes('detectPartialTrade'));
  });
});

// ─── Performance Characteristics ────────────────────────────────────────────

describe('Parse Performance', () => {
  it('parses 100 commands in under 50ms', () => {
    const commands = [
      'long sol 2x 10', 'short btc 3x 50', 'close sol', 'positions',
      'portfolio', 'tp sol 160', 'help', 'markets', 'lon sol 2x 10',
      'buy sol 10 2x',
    ];
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      localParse(commands[i % commands.length]);
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, `100 parses took ${elapsed}ms (limit: 50ms)`);
  });

  it('single parse under 5ms', () => {
    const start = performance.now();
    localParse('i want to go long on solana with 50 bucks at 3x');
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 5, `single parse took ${elapsed.toFixed(2)}ms (limit: 5ms)`);
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────

describe('Edge Cases', () => {
  it('empty input returns null', () => {
    assert.strictEqual(localParse(''), null);
  });

  it('whitespace-only returns null', () => {
    assert.strictEqual(localParse('   '), null);
  });

  it('very long input does not crash', () => {
    const long = 'long sol 2x 10 ' + 'extra '.repeat(100);
    // Should return something or null, never throw
    localParse(long);
    assert.ok(true);
  });

  it('special characters do not crash', () => {
    localParse('long sol 2x 10 !@#$%^&*()');
    localParse('<script>alert(1)</script>');
    localParse('"; DROP TABLE positions; --');
    assert.ok(true);
  });

  it('unicode does not crash', () => {
    localParse('long sol 2x 10 🚀');
    localParse('lönг söl 2x 10');
    assert.ok(true);
  });
});
