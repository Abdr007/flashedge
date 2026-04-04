/**
 * CLI Guidance System tests.
 *
 * Verifies that the guidance module returns correct suggestions for:
 * - unknown commands (fuzzy matching)
 * - incomplete commands (missing parameters)
 * - invalid parameters (out-of-range values)
 * - pool suggestions (earn commands)
 * - position-based suggestions (context-aware)
 */

import { describe, it, expect } from 'vitest';
import { getCommandGuidance } from '../src/utils/command-guidance.js';

// ─── Unknown Commands ───────────────────────────────────────────────────────

describe('unknown command guidance', () => {
  it('suggests "positions" for "positons" (typo)', () => {
    const result = getCommandGuidance('positons');
    expect(result).not.toBeNull();
    expect(result).toContain('Unknown command');
    expect(result).toContain('positions');
  });

  it('suggests "portfolio" for "porfolio" (typo)', () => {
    const result = getCommandGuidance('porfolio');
    expect(result).not.toBeNull();
    expect(result).toContain('Unknown command');
    expect(result).toContain('portfolio');
  });

  it('suggests "dashboard" for "dashbaord" (typo)', () => {
    const result = getCommandGuidance('dashbaord');
    expect(result).not.toBeNull();
    expect(result).toContain('Unknown command');
    expect(result).toContain('dashboard');
  });

  it('suggests "monitor" for "monior" (typo)', () => {
    const result = getCommandGuidance('monior');
    expect(result).not.toBeNull();
    expect(result).toContain('Unknown command');
    expect(result).toContain('monitor');
  });

  it('suggests earn commands for "earn ad" (typo)', () => {
    const result = getCommandGuidance('earn ad');
    expect(result).not.toBeNull();
    expect(result).toContain('earn add');
  });

  it('suggests earn commands for "earn remov" (typo)', () => {
    const result = getCommandGuidance('earn remov');
    expect(result).not.toBeNull();
    // Should suggest earn remove
    expect(result).toContain('earn');
  });

  it('returns null for empty input', () => {
    expect(getCommandGuidance('')).toBeNull();
  });
});

// ─── Incomplete Commands ────────────────────────────────────────────────────

describe('incomplete command guidance', () => {
  it('"open" shows open examples', () => {
    const result = getCommandGuidance('open');
    expect(result).not.toBeNull();
    expect(result).toContain('Incomplete command');
    expect(result).toContain('open 5x long SOL $500');
  });

  it('"close" shows close examples', () => {
    const result = getCommandGuidance('close');
    expect(result).not.toBeNull();
    expect(result).toContain('Incomplete command');
    expect(result).toContain('close SOL long');
  });

  it('"earn add" shows earn add examples', () => {
    const result = getCommandGuidance('earn add');
    expect(result).not.toBeNull();
    expect(result).toContain('Incomplete command');
    expect(result).toContain('earn add $100 crypto');
  });

  it('"earn remove" shows earn remove examples', () => {
    const result = getCommandGuidance('earn remove');
    expect(result).not.toBeNull();
    expect(result).toContain('Incomplete command');
    expect(result).toContain('earn remove 50% crypto');
  });

  it('"earn stake" shows earn stake examples', () => {
    const result = getCommandGuidance('earn stake');
    expect(result).not.toBeNull();
    expect(result).toContain('Incomplete command');
    expect(result).toContain('earn stake $200 governance');
  });

  it('"earn unstake" shows earn unstake examples', () => {
    const result = getCommandGuidance('earn unstake');
    expect(result).not.toBeNull();
    expect(result).toContain('Incomplete command');
    expect(result).toContain('earn unstake 50% governance');
  });

  it('"swap" shows swap examples', () => {
    const result = getCommandGuidance('swap');
    expect(result).not.toBeNull();
    expect(result).toContain('Incomplete command');
    expect(result).toContain('swap');
    expect(result).toContain('SOL');
  });

  it('"limit" shows limit order examples', () => {
    const result = getCommandGuidance('limit');
    expect(result).not.toBeNull();
    expect(result).toContain('Incomplete command');
    expect(result).toContain('limit long SOL');
  });

  it('"analyze" shows analyze examples', () => {
    const result = getCommandGuidance('analyze');
    expect(result).not.toBeNull();
    expect(result).toContain('Incomplete command');
    expect(result).toContain('analyze SOL');
  });

  it('"dryrun" shows dryrun examples', () => {
    const result = getCommandGuidance('dryrun');
    expect(result).not.toBeNull();
    expect(result).toContain('Incomplete command');
    expect(result).toContain('dryrun open');
  });

  it('"add" shows add collateral examples', () => {
    const result = getCommandGuidance('add');
    expect(result).not.toBeNull();
    expect(result).toContain('Incomplete command');
    expect(result).toContain('add $');
  });

  it('"remove" shows remove collateral examples', () => {
    const result = getCommandGuidance('remove');
    expect(result).not.toBeNull();
    expect(result).toContain('Incomplete command');
    expect(result).toContain('remove $');
  });

  it('"set tp" shows TP examples', () => {
    const result = getCommandGuidance('set tp');
    expect(result).not.toBeNull();
    expect(result).toContain('take-profit');
    expect(result).toContain('set tp');
  });

  it('"set sl" shows SL examples', () => {
    const result = getCommandGuidance('set sl');
    expect(result).not.toBeNull();
    expect(result).toContain('stop-loss');
    expect(result).toContain('set sl');
  });
});

// ─── Invalid Parameters ─────────────────────────────────────────────────────

describe('invalid parameter guidance', () => {
  it('"earn remove 200%" warns about invalid percentage', () => {
    const result = getCommandGuidance('earn remove 200%');
    expect(result).not.toBeNull();
    expect(result).toContain('Invalid percentage');
    expect(result).toContain('1%');
    expect(result).toContain('100%');
  });

  it('"earn unstake 0%" warns about invalid percentage', () => {
    const result = getCommandGuidance('earn unstake 0%');
    expect(result).not.toBeNull();
    expect(result).toContain('Invalid percentage');
  });

  it('"close SOL long 150%" warns about invalid percentage', () => {
    const result = getCommandGuidance('close SOL long 150%');
    expect(result).not.toBeNull();
    expect(result).toContain('Invalid percentage');
  });

  it('"open 200x long SOL $100" warns about leverage', () => {
    const result = getCommandGuidance('open 200x long SOL $100');
    expect(result).not.toBeNull();
    expect(result).toContain('Invalid leverage');
    expect(result).toContain('1.1x');
    expect(result).toContain('100x');
  });

  it('"open 0x long SOL $100" warns about leverage', () => {
    const result = getCommandGuidance('open 0x long SOL $100');
    expect(result).not.toBeNull();
    expect(result).toContain('Invalid leverage');
  });

  it('valid percentage does not trigger warning', () => {
    const result = getCommandGuidance('earn remove 50%');
    // This should NOT trigger invalid param (50% is valid)
    // It may return null or an incomplete guidance, but NOT "Invalid percentage"
    if (result) {
      expect(result).not.toContain('Invalid percentage');
    }
  });
});

// ─── Close Missing Side ─────────────────────────────────────────────────────

describe('close missing side', () => {
  it('"close SOL" suggests both sides', () => {
    const result = getCommandGuidance('close SOL');
    expect(result).not.toBeNull();
    expect(result).toContain('Missing position side');
    expect(result).toContain('close SOL long');
    expect(result).toContain('close SOL short');
  });

  it('"close BTC" suggests both sides', () => {
    const result = getCommandGuidance('close BTC');
    expect(result).not.toBeNull();
    expect(result).toContain('Missing position side');
    expect(result).toContain('close BTC long');
    expect(result).toContain('close BTC short');
  });

  it('"close SOL" with positions suggests actual sides', () => {
    const positions = [{ market: 'SOL', side: 'long' }];
    const result = getCommandGuidance('close SOL', positions);
    expect(result).not.toBeNull();
    expect(result).toContain('Missing position side');
    expect(result).toContain('close SOL long');
  });

  it('"close all" does NOT trigger missing side', () => {
    const result = getCommandGuidance('close all');
    // "close all" is a valid command, should not suggest sides
    if (result) {
      expect(result).not.toContain('Missing position side');
    }
  });
});

// ─── Position-Based Suggestions ─────────────────────────────────────────────

describe('position-based suggestions', () => {
  const positions = [
    { market: 'SOL', side: 'long' },
    { market: 'BTC', side: 'short' },
  ];

  it('"close" with positions suggests actual positions', () => {
    const result = getCommandGuidance('close', positions);
    expect(result).not.toBeNull();
    expect(result).toContain('close SOL long');
    expect(result).toContain('close BTC short');
    expect(result).toContain('close-all');
  });

  it('"add" with positions suggests position-specific collateral adds', () => {
    const result = getCommandGuidance('add', positions);
    expect(result).not.toBeNull();
    expect(result).toContain('add $100 to SOL long');
    expect(result).toContain('add $100 to BTC short');
  });

  it('"remove" with positions suggests position-specific removals', () => {
    const result = getCommandGuidance('remove', positions);
    expect(result).not.toBeNull();
    expect(result).toContain('remove $50 from SOL long');
    expect(result).toContain('remove $50 from BTC short');
  });

  it('"set tp" with positions suggests TP for first position', () => {
    const result = getCommandGuidance('set tp', positions);
    expect(result).not.toBeNull();
    expect(result).toContain('set tp SOL long');
  });
});

// ─── Earn Pool Suggestions ──────────────────────────────────────────────────

describe('earn pool suggestions', () => {
  it('"earn add" includes pool names in suggestions', () => {
    const result = getCommandGuidance('earn add');
    expect(result).not.toBeNull();
    expect(result).toContain('crypto');
    expect(result).toContain('governance');
  });

  it('"earn stake" includes pool names in suggestions', () => {
    const result = getCommandGuidance('earn stake');
    expect(result).not.toBeNull();
    expect(result).toContain('governance');
    expect(result).toContain('crypto');
  });

  it('unknown earn subcommand shows earn overview', () => {
    const result = getCommandGuidance('earn xyz');
    expect(result).not.toBeNull();
    expect(result).toContain('Unknown command');
    expect(result).toContain('earn');
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles whitespace-only input', () => {
    expect(getCommandGuidance('   ')).toBeNull();
  });

  it('handles very long input without crashing', () => {
    const result = getCommandGuidance('a'.repeat(500));
    // Should not crash — may return null or guidance
    expect(() => getCommandGuidance('a'.repeat(500))).not.toThrow();
  });

  it('"earn add-liquidity" still works as legacy stem', () => {
    const result = getCommandGuidance('earn add-liquidity');
    expect(result).not.toBeNull();
    expect(result).toContain('Incomplete command');
  });

  it('"earn unstake-flp" still works as legacy stem', () => {
    const result = getCommandGuidance('earn unstake-flp');
    expect(result).not.toBeNull();
    expect(result).toContain('Incomplete command');
  });

  it('"o" (open alias) shows open guidance', () => {
    const result = getCommandGuidance('o');
    expect(result).not.toBeNull();
    expect(result).toContain('open');
  });

  it('"c" (close alias) shows close guidance', () => {
    const result = getCommandGuidance('c');
    expect(result).not.toBeNull();
    expect(result).toContain('close');
  });
});
