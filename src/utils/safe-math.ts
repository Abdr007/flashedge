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
