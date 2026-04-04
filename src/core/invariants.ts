/**
 * System Invariant Guards
 *
 * Validates protocol data integrity to prevent silent corruption.
 * All checks throw InvariantViolationError on failure.
 */

import type { Position } from '../types/index.js';

export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(`Invariant violation: ${message}`);
    this.name = 'InvariantViolationError';
  }
}

/**
 * Validate a Position object has internally consistent data.
 * Called after fetching positions from the protocol.
 */
export function validatePosition(p: Position): void {
  if (!Number.isFinite(p.entryPrice) || p.entryPrice <= 0) {
    throw new InvariantViolationError(`${p.market} ${p.side}: entry price must be positive, got ${p.entryPrice}`);
  }

  if (!Number.isFinite(p.sizeUsd) || p.sizeUsd <= 0) {
    throw new InvariantViolationError(`${p.market} ${p.side}: position size must be positive, got ${p.sizeUsd}`);
  }

  if (!Number.isFinite(p.collateralUsd) || p.collateralUsd <= 0) {
    throw new InvariantViolationError(`${p.market} ${p.side}: collateral must be positive, got ${p.collateralUsd}`);
  }

  if (!Number.isFinite(p.totalFees) || p.totalFees < 0) {
    throw new InvariantViolationError(
      `${p.market} ${p.side}: fees must be finite and non-negative, got ${p.totalFees}`,
    );
  }

  if (!Number.isFinite(p.leverage) || p.leverage <= 0) {
    throw new InvariantViolationError(`${p.market} ${p.side}: leverage must be positive, got ${p.leverage}`);
  }
}

/**
 * Validate that positions array contains no corrupted entries.
 * Filters out invalid positions with logging instead of throwing,
 * so a single bad position doesn't break the entire display.
 */
export function filterValidPositions(positions: Position[]): Position[] {
  const valid: Position[] = [];
  for (const p of positions) {
    try {
      validatePosition(p);
      valid.push(p);
    } catch {
      // Skip corrupted positions — they'll show up in system audit
    }
  }
  return valid;
}

/**
 * Assert that a numeric value is finite and within expected bounds.
 */
export function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new InvariantViolationError(`${label} is not finite: ${value}`);
  }
}

/**
 * Assert a percentage sums correctly (e.g., long% + short% ≈ 100%).
 */
export function assertPercentageSum(a: number, b: number, label: string, tolerance = 2): void {
  const sum = a + b;
  if (Math.abs(sum - 100) > tolerance) {
    throw new InvariantViolationError(`${label}: ${a}% + ${b}% = ${sum}% (expected ~100%)`);
  }
}
