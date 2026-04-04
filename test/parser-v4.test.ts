/**
 * Parser v4 tests — intent confidence scoring, ambiguous resolution,
 * history-based defaults, and predictive leveraging.
 */

import { describe, it } from 'vitest';
import assert from 'assert';
import { localParse } from '../src/ai/interpreter.js';
import { ActionType, TradeSide } from '../src/types/index.js';
import {
  scoreIntent,
  resolveAmbiguous,
  needsConfirmation,
  formatConfirmation,
} from '../src/ai/intent-scorer.js';
import { recordTradeCommand, clearPredictorCache } from '../src/cli/trade-predictor.js';

// ─── Confidence Scoring ─────────────────────────────────────────────────────

describe('Intent Confidence Scoring', () => {
  it('fully explicit command scores 1.0', () => {
    const r = localParse('long sol 2x 10');
    assert.ok(r);
    const scored = scoreIntent(r, ['long', 'sol', '2x', '10']);
    assert.strictEqual(scored.confidence, 1.0);
    assert.strictEqual(scored.defaults.length, 0);
  });

  it('command without explicit leverage scores lower', () => {
    const r = localParse('long sol 10');
    assert.ok(r);
    const scored = scoreIntent(r, ['long', 'sol', '10']);
    assert.ok(scored.confidence < 1.0, 'should be less than 1.0');
    assert.ok(scored.defaults.includes('leverage'));
  });

  it('non-trade commands always score 1.0', () => {
    const r = localParse('positions');
    assert.ok(r);
    const scored = scoreIntent(r, ['positions']);
    assert.strictEqual(scored.confidence, 1.0);
  });

  it('command with $ prefix on collateral scores higher than bare number', () => {
    const r1 = localParse('long sol 2x $10');
    const r2 = localParse('long sol 2x 10');
    assert.ok(r1 && r2);
    const s1 = scoreIntent(r1, ['long', 'sol', '2x', '$10']);
    const s2 = scoreIntent(r2, ['long', 'sol', '2x', '10']);
    assert.ok(s1.confidence >= s2.confidence);
  });
});

// ─── Ambiguous Resolution ───────────────────────────────────────────────────

describe('Ambiguous Resolution', () => {
  it('resolves "long sol" with history defaults', () => {
    const result = resolveAmbiguous('long sol', 'SOL', TradeSide.Long, 3, 20);
    assert.ok(result);
    assert.strictEqual(result.intent.action, ActionType.OpenPosition);
    assert.strictEqual(result.intent.market, 'SOL');
    assert.strictEqual(result.intent.side, TradeSide.Long);
    assert.ok(result.defaults.length > 0, 'should have defaults');
    assert.ok(result.confidence < 0.8, 'should be below threshold');
  });

  it('resolves "short btc" with defaults', () => {
    const result = resolveAmbiguous('short btc', undefined, undefined, 5, 50);
    assert.ok(result);
    assert.strictEqual(result.intent.market, 'BTC');
    assert.strictEqual(result.intent.side, TradeSide.Short);
  });

  it('returns null for non-trade input', () => {
    assert.strictEqual(resolveAmbiguous('help', undefined), null);
    assert.strictEqual(resolveAmbiguous('positions', undefined), null);
    assert.strictEqual(resolveAmbiguous('wallet tokens', undefined), null);
  });

  it('returns null for unknown market', () => {
    assert.strictEqual(resolveAmbiguous('long xyzabc', undefined), null);
  });

  it('uses trade history for leverage when available', () => {
    // Record enough trades to establish preference
    for (let i = 0; i < 10; i++) {
      recordTradeCommand('long sol 5x 100');
    }
    clearPredictorCache();

    const result = resolveAmbiguous('long sol');
    assert.ok(result);
    // Should use preferred leverage from history (5x)
    assert.strictEqual((result.intent as any).leverage, 5);
  });
});

// ─── Confirmation Logic ─────────────────────────────────────────────────────

describe('Confirmation Logic', () => {
  it('needsConfirmation returns true for low-confidence with defaults', () => {
    const scored = {
      intent: { action: ActionType.OpenPosition, market: 'SOL', side: TradeSide.Long, leverage: 2, collateral: 10 } as any,
      confidence: 0.60,
      defaults: ['leverage', 'collateral'],
    };
    assert.strictEqual(needsConfirmation(scored), true);
  });

  it('needsConfirmation returns false for high confidence', () => {
    const scored = {
      intent: { action: ActionType.OpenPosition, market: 'SOL', side: TradeSide.Long, leverage: 2, collateral: 10 } as any,
      confidence: 0.95,
      defaults: [],
    };
    assert.strictEqual(needsConfirmation(scored), false);
  });

  it('formatConfirmation produces readable output', () => {
    const scored = {
      intent: { action: ActionType.OpenPosition, market: 'SOL', side: 'long', leverage: 2, collateral: 10 } as any,
      confidence: 0.70,
      defaults: ['leverage', 'collateral'],
    };
    const msg = formatConfirmation(scored);
    assert.ok(msg.includes('LONG SOL 2x $10'), 'should show interpreted command');
    assert.ok(msg.includes('leverage'), 'should list defaulted fields');
    assert.ok(msg.includes('70%'), 'should show confidence');
  });
});

// ─── History-Based Leverage Default ─────────────────────────────────────────

describe('History-Based Leverage', () => {
  it('long eth 10 uses preferred leverage from history', () => {
    // Record consistent 3x ETH usage (use ETH to avoid history pollution from other tests)
    for (let i = 0; i < 20; i++) {
      recordTradeCommand('long eth 3x 50');
    }
    clearPredictorCache();

    const r = localParse('long eth 10');
    assert.ok(r);
    assert.strictEqual(r.market, 'ETH');
    // Should use 3x from history (most common for ETH)
    assert.strictEqual(r.leverage, 3);
    assert.strictEqual(r.collateral, 10);
  });
});

// ─── Integration — Parser Still Works ───────────────────────────────────────

describe('Parser v4 Backward Compatibility', () => {
  const cases: [string, string][] = [
    ['long sol 2x 10', 'SOL'],
    ['short btc 3x 50', 'BTC'],
    ['open 5x long sol $100', 'SOL'],
    ['sol long 2x 10', 'SOL'],
    ['close sol long', 'SOL'],
    ['positions', '-'],
    ['portfolio', '-'],
    ['tp sol 160', 'SOL'],
  ];

  for (const [input, market] of cases) {
    it(input, () => {
      const r = localParse(input);
      assert.ok(r, `should parse: ${input}`);
      if (market !== '-') {
        assert.strictEqual(r.market, market);
      }
    });
  }
});
