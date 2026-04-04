/**
 * Tests for trade helper utilities extracted from flash-tools.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyRisk,
  colorRisk,
  validateLiveTradeContext,
  buildLiveTradeWarnings,
  withTimeout,
} from '../src/tools/trade-helpers.js';

describe('classifyRisk', () => {
  it('returns LOW for distance > 60%', () => {
    expect(classifyRisk(61)).toBe('LOW');
    expect(classifyRisk(100)).toBe('LOW');
  });

  it('returns MEDIUM for distance 31-60%', () => {
    expect(classifyRisk(31)).toBe('MEDIUM');
    expect(classifyRisk(60)).toBe('MEDIUM');
  });

  it('returns HIGH for distance <= 30%', () => {
    expect(classifyRisk(30)).toBe('HIGH');
    expect(classifyRisk(5)).toBe('HIGH');
    expect(classifyRisk(0)).toBe('HIGH');
  });
});

describe('colorRisk', () => {
  it('returns a string for each level', () => {
    expect(typeof colorRisk('LOW')).toBe('string');
    expect(typeof colorRisk('MEDIUM')).toBe('string');
    expect(typeof colorRisk('HIGH')).toBe('string');
  });

  it('contains the risk level text', () => {
    expect(colorRisk('LOW')).toContain('LOW');
    expect(colorRisk('MEDIUM')).toContain('MEDIUM');
    expect(colorRisk('HIGH')).toContain('HIGH');
  });
});

describe('validateLiveTradeContext', () => {
  it('returns null for simulation mode', () => {
    const ctx = { simulationMode: true } as any;
    expect(validateLiveTradeContext(ctx)).toBeNull();
  });

  it('returns error when no wallet in live mode', () => {
    const ctx = { simulationMode: false, walletManager: null } as any;
    expect(validateLiveTradeContext(ctx)).toContain('No wallet connected');
  });

  it('returns error when wallet not connected', () => {
    const ctx = { simulationMode: false, walletManager: { isConnected: false } } as any;
    expect(validateLiveTradeContext(ctx)).toContain('No wallet connected');
  });

  it('returns null when wallet is connected', () => {
    const ctx = { simulationMode: false, walletManager: { isConnected: true } } as any;
    expect(validateLiveTradeContext(ctx)).toBeNull();
  });
});

describe('buildLiveTradeWarnings', () => {
  it('warns on high leverage', () => {
    const warnings = buildLiveTradeWarnings('SOL', 25);
    expect(warnings.some(w => w.includes('liquidation risk'))).toBe(true);
  });

  it('warns on extreme leverage', () => {
    const warnings = buildLiveTradeWarnings('SOL', 50);
    expect(warnings.some(w => w.includes('Extreme leverage'))).toBe(true);
  });

  it('warns on large collateral', () => {
    const warnings = buildLiveTradeWarnings('SOL', 5, 2000);
    expect(warnings.some(w => w.includes('Large collateral'))).toBe(true);
  });

  it('no warnings for conservative trade', () => {
    const warnings = buildLiveTradeWarnings('SOL', 3, 50);
    expect(warnings.length).toBe(0);
  });

  it('warns on tight liquidation distance', () => {
    const warnings = buildLiveTradeWarnings('SOL', 50);
    expect(warnings.some(w => w.includes('Liquidation within'))).toBe(true);
  });
});

describe('withTimeout', () => {
  it('returns promise result if fast', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 0);
    expect(result).toBe(42);
  });

  it('returns fallback if promise is slow', async () => {
    const slow = new Promise<number>(resolve => setTimeout(() => resolve(42), 5000));
    const result = await withTimeout(slow, 50, -1);
    expect(result).toBe(-1);
  });
});
