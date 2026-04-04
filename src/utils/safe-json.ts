/**
 * Safe JSON parsing — prevents crashes from malformed JSON files.
 *
 * Used for all user-editable config/state files that could become
 * corrupted (power loss, concurrent writes, manual edits).
 */

import { getLogger } from './logger.js';

/**
 * Parse a JSON string safely, returning a fallback on failure.
 * Logs a warning when parsing fails so corruption is visible in logs.
 */
export function safeJsonParse<T>(content: string, fallback: T, context?: string): T {
  try {
    const parsed = JSON.parse(content);
    return parsed as T;
  } catch (err: unknown) {
    const logger = getLogger();
    const where = context ? ` (${context})` : '';
    const detail = err instanceof Error ? err.message : 'unknown error';
    logger.warn('CONFIG', `Malformed JSON${where}: ${detail} — using fallback`);
    return fallback;
  }
}
