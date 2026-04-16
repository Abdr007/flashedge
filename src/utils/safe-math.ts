/**
 * Safe numeric helpers for defensive arithmetic.
 */

/**
 * Returns a finite number or the fallback.
 * Guards against NaN, Infinity, -Infinity, undefined, null, and non-numeric types.
 */
export function safeNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fallback;
}

/** Safe division — returns fallback on divide-by-zero or non-finite result. */
export function safeDivide(a: number, b: number, fallback = 0): number {
  if (b === 0 || !Number.isFinite(a) || !Number.isFinite(b)) return fallback;
  const result = a / b;
  return Number.isFinite(result) ? result : fallback;
}

/** Safe percentage — returns fallback when whole is zero or inputs are non-finite. */
export function safePercent(part: number, whole: number, fallback = 0): number {
  return safeDivide(part, whole, fallback) * 100;
}
