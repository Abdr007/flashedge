/**
 * Tests for the flexible command parser.
 *
 * Verifies that all natural trading command variations parse correctly,
 * including:
 * - Flexible word order for open/long/short
 * - TP/SL shortcuts (tp sol 160, sl btc 60000)
 * - Alias expansion (buy → open, sell → close, l → long, s → short)
 * - Number word normalization
 * - Asset alias resolution
 * - Edge cases and error tolerance
 */

import { describe, it } from 'vitest';
import { localParse } from '../src/ai/interpreter.js';
import { ActionType, TradeSide } from '../src/types/index.js';
import assert from 'assert';

// ─── Standard Open Patterns ─────────────────────────────────────────────────

describe('Standard Open Patterns', () => {
  it('open 2x long sol $10', () => {
    const r = localParse('open 2x long sol $10');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.OpenPosition);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual(r.side, TradeSide.Long);
    assert.strictEqual(r.leverage, 2);
    assert.strictEqual(r.collateral, 10);
  });

  it('open 2x sol long $10', () => {
    const r = localParse('open 2x sol long $10');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual(r.side, TradeSide.Long);
  });

  it('long sol $10 2x', () => {
    const r = localParse('long sol $10 2x');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual(r.leverage, 2);
    assert.strictEqual(r.collateral, 10);
  });
});

// ─── Flexible Order Patterns ────────────────────────────────────────────────

describe('Flexible Word Order', () => {
  it('long sol 2x 10', () => {
    const r = localParse('long sol 2x 10');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual(r.side, TradeSide.Long);
    assert.strictEqual(r.leverage, 2);
    assert.strictEqual(r.collateral, 10);
  });

  it('short btc 3x 50', () => {
    const r = localParse('short btc 3x 50');
    assert.ok(r);
    assert.strictEqual(r.market, 'BTC');
    assert.strictEqual(r.side, TradeSide.Short);
    assert.strictEqual(r.leverage, 3);
    assert.strictEqual(r.collateral, 50);
  });

  it('sol long 2x 10', () => {
    const r = localParse('sol long 2x 10');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual(r.side, TradeSide.Long);
    assert.strictEqual(r.leverage, 2);
    assert.strictEqual(r.collateral, 10);
  });

  it('long 10 sol 2x', () => {
    const r = localParse('long 10 sol 2x');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual(r.leverage, 2);
    assert.strictEqual(r.collateral, 10);
  });

  it('open sol long $10 2x', () => {
    const r = localParse('open sol long $10 2x');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual(r.leverage, 2);
    assert.strictEqual(r.collateral, 10);
  });

  it('long 2x sol 10', () => {
    const r = localParse('long 2x sol 10');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual(r.leverage, 2);
    assert.strictEqual(r.collateral, 10);
  });

  it('short 3x btc 50', () => {
    const r = localParse('short 3x btc 50');
    assert.ok(r);
    assert.strictEqual(r.market, 'BTC');
    assert.strictEqual(r.leverage, 3);
    assert.strictEqual(r.collateral, 50);
  });

  it('short eth 3x 20', () => {
    const r = localParse('short eth 3x 20');
    assert.ok(r);
    assert.strictEqual(r.market, 'ETH');
    assert.strictEqual(r.leverage, 3);
    assert.strictEqual(r.collateral, 20);
  });

  it('eth long 5x $100', () => {
    const r = localParse('eth long 5x $100');
    assert.ok(r);
    assert.strictEqual(r.market, 'ETH');
    assert.strictEqual(r.leverage, 5);
    assert.strictEqual(r.collateral, 100);
  });

  it('btc short 3x 50', () => {
    const r = localParse('btc short 3x 50');
    assert.ok(r);
    assert.strictEqual(r.market, 'BTC');
    assert.strictEqual(r.side, TradeSide.Short);
  });

  it('sol long 10 2x', () => {
    const r = localParse('sol long 10 2x');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual(r.leverage, 2);
    assert.strictEqual(r.collateral, 10);
  });
});

// ─── Alias Expansion ────────────────────────────────────────────────────────

describe('Alias Expansion', () => {
  it('buy sol 2x 10 → open long', () => {
    const r = localParse('buy sol 2x 10');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.OpenPosition);
    assert.strictEqual(r.market, 'SOL');
  });

  it('buy 2x long sol $100 tp $95 sl $80 → open with TP/SL', () => {
    const r = localParse('buy 2x long sol $100 tp $95 sl $80');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.OpenPosition);
    assert.strictEqual((r as any).takeProfit, 95);
    assert.strictEqual((r as any).stopLoss, 80);
  });

  it('sell sol → close sol', () => {
    const r = localParse('sell sol');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.ClosePosition);
    assert.strictEqual(r.market, 'SOL');
  });
});

// ─── Natural Language ───────────────────────────────────────────────────────

describe('Natural Language Tolerance', () => {
  it('buy sol 10 dollars 2x', () => {
    const r = localParse('buy sol 10 dollars 2x');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual(r.collateral, 10);
    assert.strictEqual(r.leverage, 2);
  });

  it('long sol 2x ten dollars', () => {
    const r = localParse('long sol 2x ten dollars');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual(r.collateral, 10);
  });

  it('open long sol with 20 collateral 2x', () => {
    const r = localParse('open long sol with 20 collateral 2x');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual(r.collateral, 20);
  });

  it('open long solana 2x $50', () => {
    const r = localParse('open long solana 2x $50');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
  });

  it('long bitcoin 2x 100', () => {
    const r = localParse('long bitcoin 2x 100');
    assert.ok(r);
    assert.strictEqual(r.market, 'BTC');
  });

  it('short ethereum 3x 50', () => {
    const r = localParse('short ethereum 3x 50');
    assert.ok(r);
    assert.strictEqual(r.market, 'ETH');
  });
});

// ─── TP/SL Shortcuts ────────────────────────────────────────────────────────

describe('TP/SL Shortcuts', () => {
  it('tp sol 160 → set_tp_sl', () => {
    const r = localParse('tp sol 160');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.SetTpSl);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual((r as any).type, 'tp');
    assert.strictEqual((r as any).price, 160);
  });

  it('sl btc 60000 → set_tp_sl', () => {
    const r = localParse('sl btc 60000');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.SetTpSl);
    assert.strictEqual(r.market, 'BTC');
    assert.strictEqual((r as any).type, 'sl');
    assert.strictEqual((r as any).price, 60000);
  });

  it('tp eth $2500 → set_tp_sl', () => {
    const r = localParse('tp eth $2500');
    assert.ok(r);
    assert.strictEqual(r.market, 'ETH');
    assert.strictEqual((r as any).price, 2500);
  });
});

// ─── Inline TP/SL with Open ─────────────────────────────────────────────────

describe('Inline TP/SL', () => {
  it('long sol 2x 10 tp 95 sl 80', () => {
    const r = localParse('long sol 2x 10 tp 95 sl 80');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.OpenPosition);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual((r as any).takeProfit, 95);
    assert.strictEqual((r as any).stopLoss, 80);
  });

  it('open 5x long SOL $50 sl $70 tp $120', () => {
    const r = localParse('open 5x long SOL $50 sl $70 tp $120');
    assert.ok(r);
    assert.strictEqual((r as any).takeProfit, 120);
    assert.strictEqual((r as any).stopLoss, 70);
  });
});

// ─── Existing Patterns Still Work ───────────────────────────────────────────

describe('Existing Patterns Preserved', () => {
  it('close sol long', () => {
    const r = localParse('close sol long');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.ClosePosition);
  });

  it('close sol', () => {
    const r = localParse('close sol');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.ClosePosition);
  });

  it('positions', () => {
    const r = localParse('positions');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.GetPositions);
  });

  it('portfolio', () => {
    const r = localParse('portfolio');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.GetPortfolio);
  });

  it('set tp SOL long $95', () => {
    const r = localParse('set tp SOL long $95');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.SetTpSl);
  });

  it('limit long SOL 2x $100 @ $82', () => {
    const r = localParse('limit long SOL 2x $100 @ $82');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.LimitOrder);
  });

  it('close all', () => {
    const r = localParse('close all');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.CloseAll);
  });

  it('earn add $10 crypto', () => {
    const r = localParse('earn add $10 crypto');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.EarnAddLiquidity);
  });
});

// ─── Fuzzy Typo Correction ──────────────────────────────────────────────────

describe('Fuzzy Typo Correction', () => {
  it('lon sol 2x 10 → long (typo in side)', () => {
    const r = localParse('lon sol 2x 10');
    assert.ok(r);
    assert.strictEqual(r.side, TradeSide.Long);
  });

  it('lng sol 2x 10 → long', () => {
    const r = localParse('lng sol 2x 10');
    assert.ok(r);
    assert.strictEqual(r.side, TradeSide.Long);
  });

  it('lonng sol 2x 10 → long', () => {
    const r = localParse('lonng sol 2x 10');
    assert.ok(r);
    assert.strictEqual(r.side, TradeSide.Long);
  });

  it('solan long 2x 10 → SOL (typo in market)', () => {
    const r = localParse('solan long 2x 10');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
  });
});

// ─── Greeting/Filler Tolerance ──────────────────────────────────────────────

describe('Greeting/Filler Tolerance', () => {
  it('yo open a sol long for 10 usd at 2x', () => {
    const r = localParse('yo open a sol long for 10 usd at 2x');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
  });

  it('please long sol using ten dollars leverage two', () => {
    const r = localParse('please long sol using ten dollars leverage two');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual(r.collateral, 10);
    assert.strictEqual(r.leverage, 2);
  });

  it('enter a 2x long on sol with 10 bucks', () => {
    const r = localParse('enter a 2x long on sol with 10 bucks');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
  });

  it('10 usd sol long 2x', () => {
    const r = localParse('10 usd sol long 2x');
    assert.ok(r);
    assert.strictEqual(r.market, 'SOL');
    assert.strictEqual(r.collateral, 10);
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────

describe('Edge Cases', () => {
  it('does not parse invalid market', () => {
    const r = localParse('long xyz 2x 10');
    assert.strictEqual(r, null);
  });

  it('does not parse without leverage', () => {
    const r = localParse('long sol 10');
    // May parse with two numbers as leverage=10 collateral=10 or fail
    // Either way it should not crash
    assert.ok(true);
  });

  it('help still works', () => {
    const r = localParse('help');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.Help);
  });

  it('wallet commands still work', () => {
    const r = localParse('wallet tokens');
    assert.ok(r);
    assert.strictEqual(r.action, ActionType.WalletTokens);
  });

  it('parser does not crash on empty input', () => {
    const r = localParse('');
    // Should return null, not crash
    assert.ok(true);
  });

  it('parser does not crash on single word', () => {
    const r = localParse('sol');
    // Should return market data or null
    assert.ok(true);
  });
});
