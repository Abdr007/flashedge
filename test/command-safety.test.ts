/**
 * Command Safety Tests
 *
 * Validates that destructive commands cannot execute from typos,
 * fuzzy matches, or AI misinterpretation.
 */

import { describe, it } from 'vitest';
import assert from 'assert';
import { shouldBlockAiIntent, isProtectedCommand, getSafeCommandSuggestion } from '../src/core/command-safety.js';
import { ActionType } from '../src/types/index.js';
import { localParse } from '../src/ai/interpreter.js';

// ─── Protected Command Detection ────────────────────────────────────────────

describe('Protected Commands', () => {
  it('exit is protected', () => {
    assert.strictEqual(isProtectedCommand('exit'), true);
  });

  it('quit is protected', () => {
    assert.strictEqual(isProtectedCommand('quit'), true);
  });

  it('wallet disconnect is protected', () => {
    assert.strictEqual(isProtectedCommand('wallet disconnect'), true);
  });

  it('close all is protected', () => {
    assert.strictEqual(isProtectedCommand('close all'), true);
  });

  it('normal commands are not protected', () => {
    assert.strictEqual(isProtectedCommand('positions'), false);
    assert.strictEqual(isProtectedCommand('help'), false);
    assert.strictEqual(isProtectedCommand('long sol 2x 10'), false);
  });
});

// ─── AI Intent Blocking ─────────────────────────────────────────────────────

describe('AI Intent Blocking', () => {
  it('blocks WalletDisconnect from non-exact input', () => {
    assert.strictEqual(shouldBlockAiIntent('walet disconnect', ActionType.WalletDisconnect), true);
    assert.strictEqual(shouldBlockAiIntent('disconnect wallet', ActionType.WalletDisconnect), true);
  });

  it('allows WalletDisconnect from exact input', () => {
    assert.strictEqual(shouldBlockAiIntent('wallet disconnect', ActionType.WalletDisconnect), false);
  });

  it('blocks CloseAll from non-exact input', () => {
    assert.strictEqual(shouldBlockAiIntent('clsoe all', ActionType.CloseAll), true);
    assert.strictEqual(shouldBlockAiIntent('close al', ActionType.CloseAll), true);
  });

  it('allows CloseAll from exact input', () => {
    assert.strictEqual(shouldBlockAiIntent('close all', ActionType.CloseAll), false);
    assert.strictEqual(shouldBlockAiIntent('close-all', ActionType.CloseAll), false);
    assert.strictEqual(shouldBlockAiIntent('closeall', ActionType.CloseAll), false);
  });

  it('does not block non-destructive actions', () => {
    assert.strictEqual(shouldBlockAiIntent('positions', ActionType.GetPositions), false);
    assert.strictEqual(shouldBlockAiIntent('lon sol 2x 10', ActionType.OpenPosition), false);
  });
});

// ─── Did You Mean Suggestions ───────────────────────────────────────────────

describe('Safe Command Suggestions', () => {
  it('suggests exit for eexit', () => {
    assert.strictEqual(getSafeCommandSuggestion('eexit'), 'exit');
  });

  it('suggests exit for exiit', () => {
    assert.strictEqual(getSafeCommandSuggestion('exiit'), 'exit');
  });

  it('suggests close all for clsoe all', () => {
    assert.strictEqual(getSafeCommandSuggestion('clsoe all'), 'close all');
  });

  it('suggests quit for quiit', () => {
    assert.strictEqual(getSafeCommandSuggestion('quiit'), 'quit');
  });

  it('returns null for unrelated input', () => {
    assert.strictEqual(getSafeCommandSuggestion('long sol 2x 10'), null);
    assert.strictEqual(getSafeCommandSuggestion('help'), null);
  });
});

// ─── Typo Safety ────────────────────────────────────────────────────────────

describe('Typo Command Safety', () => {
  const dangerousTypos = [
    'eexit', 'exiit', 'exitt', 'exi',
    'clsoe all', 'colse all', 'closee all',
    'walet disconnect', 'wallet disconect',
  ];

  for (const typo of dangerousTypos) {
    it(`"${typo}" does not parse as a destructive action`, () => {
      const r = localParse(typo);
      // Should either be null or a non-destructive action
      if (r) {
        assert.ok(
          r.action !== ActionType.CloseAll &&
          r.action !== ActionType.WalletDisconnect &&
          r.action !== ActionType.WalletRemove,
          `"${typo}" parsed as destructive action: ${r.action}`
        );
      }
    });
  }
});

// ─── Terminal Integration ───────────────────────────────────────────────────

describe('Terminal Safety Integration', () => {
  it('terminal uses shouldBlockAiIntent', () => {
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/cli/terminal.ts'), 'utf8'
    );
    assert.ok(src.includes('shouldBlockAiIntent'));
  });

  it('terminal uses getSafeCommandSuggestion', () => {
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/cli/terminal.ts'), 'utf8'
    );
    assert.ok(src.includes('getSafeCommandSuggestion'));
  });

  it('exit requires exact match (=== not includes)', () => {
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/cli/terminal.ts'), 'utf8'
    );
    assert.ok(src.includes("lower === 'exit'"));
  });

  it('exit confirms before shutdown in live mode', () => {
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/cli/terminal.ts'), 'utf8'
    );
    assert.ok(src.includes('Exit Flash Terminal?'));
  });
});
