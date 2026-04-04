import { getLogger } from './logger.js';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000,
};

// ─── Global Retry Budget ─────────────────────────────────────────────────────
//
// Prevents retry storms during outages. All retry callers share a single budget.
// When the budget is exhausted, retries fail immediately (fail-fast).
// Budget refills over time.

const BUDGET_WINDOW_MS = 60_000;  // 1-minute sliding window
const MAX_RETRIES_PER_WINDOW = 50; // Max retries across all modules per window
const retryTimestamps: number[] = [];

// ─── Error Log Throttle ──────────────────────────────────────────────────────
// Prevent the same label from flooding the console with identical error messages.
// After the first error, suppress duplicates for THROTTLE_WINDOW_MS, then log a
// summary count.
const THROTTLE_WINDOW_MS = 30_000; // 30s window
const errorThrottle = new Map<string, { firstAt: number; count: number; lastLogged: number }>();

/**
 * Check if a retry is allowed within the global budget.
 * Returns true if the retry should proceed, false if budget is exhausted.
 */
function consumeRetryBudget(): boolean {
  const now = Date.now();
  // Evict expired entries
  while (retryTimestamps.length > 0 && retryTimestamps[0] < now - BUDGET_WINDOW_MS) {
    retryTimestamps.shift();
  }
  if (retryTimestamps.length >= MAX_RETRIES_PER_WINDOW) {
    return false; // Budget exhausted — fail fast
  }
  retryTimestamps.push(now);
  return true;
}

/** Get current retry budget usage (for diagnostics). */
export function getRetryBudgetUsage(): { used: number; max: number; exhausted: boolean } {
  const now = Date.now();
  while (retryTimestamps.length > 0 && retryTimestamps[0] < now - BUDGET_WINDOW_MS) {
    retryTimestamps.shift();
  }
  return {
    used: retryTimestamps.length,
    max: MAX_RETRIES_PER_WINDOW,
    exhausted: retryTimestamps.length >= MAX_RETRIES_PER_WINDOW,
  };
}

/**
 * Extract a rate-limit delay from a 429 error, if present.
 * Checks for Retry-After header value embedded in the error message,
 * or common RPC provider rate-limit patterns.
 * Returns delay in ms, or 0 if not a rate-limit error.
 */
function extractRateLimitDelay(error: Error): number {
  const msg = error.message ?? '';

  // Check for "429" in the error message (HTTP status or fetch error)
  if (
    !msg.includes('429') &&
    !msg.toLowerCase().includes('rate limit') &&
    !msg.toLowerCase().includes('too many requests')
  ) {
    return 0;
  }

  // Try to extract Retry-After seconds from error message
  const retryAfterMatch = msg.match(/[Rr]etry-?[Aa]fter[:\s]+(\d+)/);
  if (retryAfterMatch) {
    const seconds = parseInt(retryAfterMatch[1], 10);
    if (Number.isFinite(seconds) && seconds > 0 && seconds <= 300) {
      return seconds * 1000;
    }
  }

  // Default rate-limit backoff: 2 seconds
  return 2000;
}

export async function withRetry<T>(fn: () => Promise<T>, label: string, opts: Partial<RetryOptions> = {}): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = { ...DEFAULT_RETRY, ...opts };
  const logger = getLogger();

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        // Check global retry budget — fail fast during outages
        if (!consumeRetryBudget()) {
          logger.warn('RETRY', `${label} retry budget exhausted (${MAX_RETRIES_PER_WINDOW} retries in ${BUDGET_WINDOW_MS / 1000}s) — failing fast`);
          break;
        }

        // Check for HTTP 429 rate limiting
        const rateLimitDelay = extractRateLimitDelay(lastError);
        let delay: number;

        if (rateLimitDelay > 0) {
          // Use rate-limit specific delay, clamped to maxDelayMs
          delay = Math.min(rateLimitDelay, maxDelayMs);
          logger.info(
            'RETRY',
            `${label} rate limited (429), waiting ${Math.round(delay)}ms before retry ${attempt + 1}/${maxAttempts}`,
          );
        } else {
          // Standard exponential backoff with jitter, clamped to maxDelayMs
          const exponential = baseDelayMs * 2 ** (attempt - 1);
          const jitter = Math.random() * baseDelayMs * 0.5;
          delay = Math.min(exponential + jitter, maxDelayMs);
          logger.info(
            'RETRY',
            `${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${Math.round(delay)}ms`,
            {
              error: lastError.message,
            },
          );
        }

        // ADAPTIVE: multiply delay when system is degraded
        try {
          const { getHealth } = await import('../system/health.js');
          const mult = getHealth()?.getDegradationParams().retryDelayMultiplier ?? 1.0;
          if (mult > 1.0) delay = Math.min(delay * mult, maxDelayMs * 4);
        } catch { /* health not initialized */ }

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // Throttle repeated error logs for the same label
  const now = Date.now();
  const throttle = errorThrottle.get(label);
  if (throttle && now - throttle.firstAt < THROTTLE_WINDOW_MS) {
    throttle.count++;
    // Log summary every 10 suppressed errors, or after 15s silence
    if (throttle.count % 10 === 0 || now - throttle.lastLogged > 15_000) {
      logger.error('RETRY', `${label} failed after ${maxAttempts} attempts (${throttle.count} failures in ${Math.round((now - throttle.firstAt) / 1000)}s)`, {
        error: lastError?.message ?? 'unknown',
      });
      throttle.lastLogged = now;
    }
  } else {
    // First error or window expired — log immediately and start new window
    errorThrottle.set(label, { firstAt: now, count: 1, lastLogged: now });
    logger.error('RETRY', `${label} failed after ${maxAttempts} attempts`, {
      error: lastError?.message ?? 'unknown',
    });
    // Clean up old throttle entries
    for (const [k, v] of errorThrottle) {
      if (now - v.firstAt > THROTTLE_WINDOW_MS * 2) errorThrottle.delete(k);
    }
  }
  throw lastError;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
