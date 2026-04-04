/**
 * Behavior-locking tests for fee calculation utilities.
 */

import { describe, it, expect } from 'vitest';
import { calcFeeUsd } from '../src/utils/protocol-fees.js';

describe('calcFeeUsd', () => {
  it('calculates fee as sizeUsd * feeRate', () => {
    expect(calcFeeUsd(500, 0.0008)).toBeCloseTo(0.40, 4);
  });

  it('returns 0 for zero size', () => {
    expect(calcFeeUsd(0, 0.0008)).toBe(0);
  });

  it('returns 0 for zero fee rate', () => {
    expect(calcFeeUsd(500, 0)).toBe(0);
  });

  it('returns 0 for negative size', () => {
    expect(calcFeeUsd(-500, 0.0008)).toBe(0);
  });

  it('returns 0 for NaN size', () => {
    expect(calcFeeUsd(NaN, 0.0008)).toBe(0);
  });

  it('returns 0 for Infinity fee rate', () => {
    expect(calcFeeUsd(500, Infinity)).toBe(0);
  });

  it('handles large position sizes correctly', () => {
    // $10M position at 0.051% fee = $5,100
    expect(calcFeeUsd(10_000_000, 0.00051)).toBeCloseTo(5100, 0);
  });

  it('handles small position sizes correctly', () => {
    // $10 position at 0.08% fee = $0.008
    expect(calcFeeUsd(10, 0.0008)).toBeCloseTo(0.008, 6);
  });
});
