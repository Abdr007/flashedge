/**
 * Safe environment variable parsing — prevents NaN from malformed env values.
 *
 * All numeric env vars should use these helpers instead of raw parseInt/parseFloat.
 */

import { getLogger } from './logger.js';

/**
 * Parse a numeric environment variable safely.
 * Returns the fallback if the value is missing, empty, or not a valid number.
 * Logs a warning when an invalid value is encountered.
 */
export function safeEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    const logger = getLogger();
    logger.warn('CONFIG', `Invalid numeric env var ${name}="${raw}" — using default ${fallback}`);
    return fallback;
  }

  return parsed;
}

/**
 * Parse a positive numeric environment variable safely.
 * Returns the fallback if the value is missing, empty, not a valid number, or <= 0.
 */
export function safeEnvPositive(name: string, fallback: number): number {
  const value = safeEnvNumber(name, fallback);
  if (value <= 0) return fallback;
  return value;
}
