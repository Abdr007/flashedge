/**
 * Parser v5 tests — interactive trade builder, partial command detection,
 * inline validation, and trade parameter checking.
 */

import { describe, it } from 'vitest';
import assert from 'assert';
import { TradeSide } from '../src/types/index.js';
import {
  detectPartialTrade,
  validateTradeParam,
} from '../src/cli/interactive-builder.js';

// ─── Partial Trade Detection ────────────────────────────────────────────────

describe('Partial Trade Detection', () => {
  it('detects "long sol" as partial (missing leverage + collateral)', () => {
    const p = detectPartialTrade('long sol');
    assert.ok(p);
    assert.strictEqual(p.side, TradeSide.Long);
    assert.strictEqual(p.market, 'SOL');
    assert.strictEqual(p.leverage, undefined);
    assert.strictEqual(p.collateral, undefined);
  });

  it('detects "short btc" as partial', () => {
    const p = detectPartialTrade('short btc');
    assert.ok(p);
    assert.strictEqual(p.side, TradeSide.Short);
    assert.strictEqual(p.market, 'BTC');
  });

  it('detects "long sol 2x" as partial (missing collateral)', () => {
    const p = detectPartialTrade('long sol 2x');
    assert.ok(p);
    assert.strictEqual(p.side, TradeSide.Long);
    assert.strictEqual(p.market, 'SOL');
    assert.strictEqual(p.leverage, 2);
    assert.strictEqual(p.collateral, undefined);
  });

  it('detects "long" as partial (side only)', () => {
    const p = detectPartialTrade('long');
    assert.ok(p);
    assert.strictEqual(p.side, TradeSide.Long);
    assert.strictEqual(p.market, undefined);
  });

  it('returns null for market-only input (no side)', () => {
    const p = detectPartialTrade('sol');
    // "sol" alone is more likely a price query than a trade
    assert.strictEqual(p, null);
  });

  it('returns null for complete command', () => {
    const p = detectPartialTrade('long sol 2x 10');
    assert.strictEqual(p, null, 'complete command should not be partial');
  });

  it('returns null for non-trade input', () => {
    assert.strictEqual(detectPartialTrade('help'), null);
    assert.strictEqual(detectPartialTrade('positions'), null);
    assert.strictEqual(detectPartialTrade('wallet tokens'), null);
  });

  it('returns null for long input (> 4 tokens)', () => {
    assert.strictEqual(detectPartialTrade('long sol 2x 10 extra'), null);
  });

  it('detects "buy sol" as partial', () => {
    const p = detectPartialTrade('buy sol');
    assert.ok(p);
    assert.strictEqual(p.side, TradeSide.Long);
    assert.strictEqual(p.market, 'SOL');
  });

  it('detects "s btc" as partial (short alias)', () => {
    const p = detectPartialTrade('s btc');
    assert.ok(p);
    assert.strictEqual(p.side, TradeSide.Short);
    assert.strictEqual(p.market, 'BTC');
  });
});

// ─── Inline Validation ──────────────────────────────────────────────────────

describe('Inline Trade Validation', () => {
  it('validates leverage within limits', () => {
    assert.strictEqual(validateTradeParam('leverage', 2, 'SOL'), null);
    assert.strictEqual(validateTradeParam('leverage', 5, 'SOL'), null);
  });

  it('rejects leverage exceeding market max', () => {
    const err = validateTradeParam('leverage', 200, 'SOL');
    assert.ok(err);
    assert.ok(err.includes('Maximum leverage'));
  });

  it('rejects leverage below minimum', () => {
    const err = validateTradeParam('leverage', 0.5);
    assert.ok(err);
    assert.ok(err.includes('at least'));
  });

  it('validates collateral', () => {
    assert.strictEqual(validateTradeParam('collateral', 10), null);
    assert.strictEqual(validateTradeParam('collateral', 0.01), null);
  });

  it('rejects negative collateral', () => {
    const err = validateTradeParam('collateral', -5);
    assert.ok(err);
    assert.ok(err.includes('positive'));
  });

  it('rejects zero collateral', () => {
    const err = validateTradeParam('collateral', 0);
    assert.ok(err);
  });

  it('validates known market', () => {
    assert.strictEqual(validateTradeParam('market', 'SOL'), null);
    assert.strictEqual(validateTradeParam('market', 'BTC'), null);
    assert.strictEqual(validateTradeParam('market', 'ETH'), null);
  });

  it('rejects unknown market', () => {
    const err = validateTradeParam('market', 'NONEXISTENT');
    assert.ok(err);
    assert.ok(err.includes('Unknown market'));
  });
});

// ─── Interactive Builder (non-interactive validation) ───────────────────────

describe('Interactive Builder Code Structure', () => {
  it('interactive builder file exists and exports required functions', async () => {
    const mod = await import('../src/cli/interactive-builder.js');
    assert.ok(typeof mod.detectPartialTrade === 'function');
    assert.ok(typeof mod.buildTradeInteractively === 'function');
    assert.ok(typeof mod.validateTradeParam === 'function');
  });

  it('buildTradeInteractively returns null in agent mode', async () => {
    // We can't fully test interactive prompting in vitest,
    // but we can verify the NO_DNA guard
    const { IS_AGENT } = await import('../src/no-dna.js');
    if (IS_AGENT) {
      const { buildTradeInteractively } = await import('../src/cli/interactive-builder.js');
      const result = await buildTradeInteractively(
        async () => '',
        { side: TradeSide.Long, market: 'SOL' },
      );
      assert.strictEqual(result, null);
    }
  });
});

// ─── Terminal Integration ───────────────────────────────────────────────────

describe('Terminal Builder Integration', () => {
  it('terminal.ts imports interactive builder', () => {
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/cli/terminal.ts'), 'utf8'
    );
    assert.ok(src.includes('detectPartialTrade'));
    assert.ok(src.includes('buildTradeInteractively'));
  });

  it('builder is triggered before ambiguous resolution', () => {
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/cli/terminal.ts'), 'utf8'
    );
    const builderIdx = src.indexOf('Interactive Trade Builder');
    const ambiguousIdx = src.indexOf('Ambiguous Resolution');
    assert.ok(builderIdx > 0, 'should have builder section');
    assert.ok(ambiguousIdx > 0, 'should have ambiguous section');
    assert.ok(builderIdx < ambiguousIdx, 'builder should come before ambiguous resolution');
  });

  it('builder is skipped in NO_DNA mode', () => {
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/cli/terminal.ts'), 'utf8'
    );
    // The condition should check !IS_AGENT
    assert.ok(src.includes('!IS_AGENT') && src.includes('detectPartialTrade'));
  });
});
