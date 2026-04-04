/**
 * Parser v3 tests — trade templates, predictive suggestions, and trade predictor.
 */

import { describe, it, afterAll } from 'vitest';
import assert from 'assert';
import { localParse } from '../src/ai/interpreter.js';
import { ActionType, TradeSide } from '../src/types/index.js';
import { setTemplate, removeTemplate, expandTemplate, clearTemplateCache } from '../src/cli/trade-templates.js';
import { recordTradeCommand, getPredictions, getPreferredLeverage, clearPredictorCache } from '../src/cli/trade-predictor.js';

// ─── Trade Templates ────────────────────────────────────────────────────────

describe('Trade Templates', () => {
  afterAll(() => {
    removeTemplate('scalp');
    removeTemplate('swing');
    removeTemplate('degen');
    clearTemplateCache();
  });

  it('set and expand a simple template', () => {
    setTemplate('scalp', 'long sol 3x 50');
    clearTemplateCache();
    const expanded = expandTemplate('scalp');
    assert.strictEqual(expanded, 'long sol 3x 50');
  });

  it('template expands through localParse', () => {
    setTemplate('scalp', 'long sol 3x 50');
    clearTemplateCache();
    const r = localParse('scalp');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.OpenPosition);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual(r.leverage, 3);
    assert.strictEqual(r.collateral, 50);
  });

  it('template with TP/SL', () => {
    setTemplate('swing', 'long btc 2x 200 tp 75000 sl 60000');
    clearTemplateCache();
    const r = localParse('swing');
    assert.ok(r);
    assert.strictEqual(r.market, 'BTC');
    assert.strictEqual((r as any).takeProfit, 75000);
    assert.strictEqual((r as any).stopLoss, 60000);
  });

  it('template with override parameter', () => {
    setTemplate('degen', 'long sol 10x');
    clearTemplateCache();
    // "degen 100" should expand to "long sol 10x 100"
    const expanded = expandTemplate('degen 100');
    assert.strictEqual(expanded, 'long sol 10x 100');
  });

  it('remove template', () => {
    setTemplate('temp', 'long sol 2x 10');
    clearTemplateCache();
    assert.ok(removeTemplate('temp'));
    clearTemplateCache();
    assert.strictEqual(expandTemplate('temp'), null);
  });

  it('non-existent template returns null', () => {
    assert.strictEqual(expandTemplate('nonexistent'), null);
  });
});

// ─── Trade Predictor ────────────────────────────────────────────────────────

describe('Trade Predictor', () => {
  afterAll(() => {
    clearPredictorCache();
  });

  it('records and predicts trade commands', () => {
    // Record some trades
    for (let i = 0; i < 5; i++) {
      recordTradeCommand('long sol 2x 10');
    }
    for (let i = 0; i < 3; i++) {
      recordTradeCommand('long sol 3x 20');
    }

    const predictions = getPredictions('long sol');
    assert.ok(predictions.length > 0, 'should have predictions');
    assert.ok(predictions.some(p => p.includes('long sol')));
  });

  it('returns empty for no-match prefix', () => {
    const predictions = getPredictions('xyznonexistent');
    assert.strictEqual(predictions.length, 0);
  });

  it('detects preferred leverage', () => {
    for (let i = 0; i < 10; i++) {
      recordTradeCommand('long sol 5x 100');
    }
    clearPredictorCache();

    const lev = getPreferredLeverage('sol');
    assert.ok(lev !== null, 'should detect preferred leverage');
  });

  it('only records trade-like commands', () => {
    const before = getPredictions('help').length;
    recordTradeCommand('help');
    recordTradeCommand('positions');
    recordTradeCommand('wallet tokens');
    clearPredictorCache();
    const after = getPredictions('help').length;
    assert.strictEqual(before, after, 'non-trade commands should not be recorded');
  });

  it('limits to max patterns', () => {
    // Record many different commands
    for (let i = 0; i < 30; i++) {
      recordTradeCommand(`long sol ${i + 1}x ${i * 10}`);
    }
    clearPredictorCache();
    // Should not crash, and predictions should still work
    const predictions = getPredictions('long sol');
    assert.ok(predictions.length <= 3, 'should return at most 3 predictions');
  });
});

// ─── Template + Alias Integration ───────────────────────────────────────────

describe('Template + Alias Priority', () => {
  afterAll(() => {
    removeTemplate('mylong');
    clearTemplateCache();
  });

  it('templates are expanded before aliases', () => {
    // Template takes priority — if "mylong" is a template, it expands first
    setTemplate('mylong', 'long eth 2x 50');
    clearTemplateCache();
    const r = localParse('mylong');
    assert.ok(r);
    assert.strictEqual(r.market, 'ETH');
  });
});

// ─── Existing Parser Still Works ────────────────────────────────────────────

describe('Parser Backward Compatibility', () => {
  const cases: [string, string, string, number, number][] = [
    ['long sol 2x 10', 'SOL', 'long', 2, 10],
    ['short btc 3x 50', 'BTC', 'short', 3, 50],
    ['open 5x long sol $100', 'SOL', 'long', 5, 100],
    ['buy sol 10 2x', 'SOL', 'long', 2, 10],
    ['sol long 2x 10', 'SOL', 'long', 2, 10],
  ];

  for (const [input, market, side, leverage, collateral] of cases) {
    it(input, () => {
      const r = localParse(input);
      assert.ok(r, `should parse: ${input}`);
      assert.strictEqual(r.market, market);
      assert.strictEqual(r.side, side);
      assert.strictEqual(r.leverage, leverage);
      assert.strictEqual(r.collateral, collateral);
    });
  }
});
