/**
 * API Health Guard — Optimized for minimum latency
 *
 * Pre-execution gate that validates Flash API availability.
 *
 * LATENCY OPTIMIZATION:
 *   - When cache is HEALTHY and FRESH → return immediately (0ms blocking)
 *   - When cache is HEALTHY but STALE → return immediately + trigger background refresh
 *   - When cache is UNHEALTHY or MISSING → block and perform full check
 *
 * This means the health check adds 0ms latency to the hot path
 * in the common case (API is healthy, cache is warm).
 *
 * Background refresh runs async and never blocks the caller.
 * If background refresh fails, the cache is invalidated so the
 * NEXT execution will perform a blocking check.
 */

import { getFlashApiClient } from '../data/flash-api.js';
import { healthCheckFailed, ExecutionError } from './execution-error.js';
import { getLogger } from '../utils/logger.js';

// ─── Configuration ──────────────────────────────────────────────────────────

const MAX_HEALTH_LATENCY_MS = 5_000;
const HEALTH_CACHE_TTL_MS = 10_000;      // 10s — considered "fresh" (return immediately)
const HEALTH_STALE_TTL_MS = 30_000;      // 30s — "stale but usable" (return + bg refresh)

// ─── Cache ──────────────────────────────────────────────────────────────────

interface HealthStatus {
  healthy: boolean;
  latencyMs: number;
  checkedAt: number;
  pools: number;
  markets: number;
  positions: number;
}

let _cachedHealth: HealthStatus | null = null;
let _backgroundRefreshInFlight = false;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Validate Flash API health before execution.
 *
 * FAST PATH (0ms blocking):
 *   Cache is healthy and within HEALTH_CACHE_TTL_MS → return cached immediately.
 *
 * STALE PATH (0ms blocking + async refresh):
 *   Cache is healthy but older than TTL (< STALE_TTL) → return cached,
 *   trigger non-blocking background refresh.
 *
 * COLD PATH (blocking):
 *   No cache, or cache is unhealthy → perform full blocking check.
 */
export async function checkApiHealth(): Promise<HealthStatus> {
  const now = Date.now();

  if (_cachedHealth && _cachedHealth.healthy) {
    const age = now - _cachedHealth.checkedAt;

    // FAST PATH: fresh cache — zero blocking
    if (age < HEALTH_CACHE_TTL_MS) {
      return _cachedHealth;
    }

    // STALE PATH: usable cache — return immediately, refresh in background
    if (age < HEALTH_STALE_TTL_MS) {
      _triggerBackgroundRefresh();
      return _cachedHealth;
    }
  }

  // COLD PATH: must block and check
  return _performHealthCheck();
}

/** Clear cached health status (used in testing or after network changes). */
export function clearHealthCache(): void {
  _cachedHealth = null;
}

/**
 * Non-blocking health check — returns status without throwing.
 * Used for diagnostics and monitoring, not as an execution gate.
 */
export async function getApiHealthStatus(): Promise<HealthStatus & { error?: string }> {
  try {
    return await checkApiHealth();
  } catch (err) {
    return {
      healthy: false,
      latencyMs: 0,
      checkedAt: Date.now(),
      pools: 0,
      markets: 0,
      positions: 0,
      error: err instanceof Error ? err.message : 'Unknown',
    };
  }
}

// ─── Internal ───────────────────────────────────────────────────────────────

/** Full blocking health check. Called on cold path only. */
async function _performHealthCheck(): Promise<HealthStatus> {
  const logger = getLogger();
  const start = Date.now();

  try {
    const healthData = await getFlashApiClient().getHealth();
    const latencyMs = Date.now() - start;

    if (!healthData) {
      throw healthCheckFailed('No response from Flash API health endpoint', latencyMs);
    }
    if (healthData.status !== 'ok') {
      throw healthCheckFailed(`API reports degraded status: ${healthData.status}`, latencyMs);
    }
    if (latencyMs > MAX_HEALTH_LATENCY_MS) {
      throw healthCheckFailed(`API latency ${latencyMs}ms exceeds threshold ${MAX_HEALTH_LATENCY_MS}ms`, latencyMs);
    }

    const accounts = healthData.accounts;
    if (
      !accounts ||
      typeof accounts.pools !== 'number' || accounts.pools === 0 ||
      typeof accounts.markets !== 'number' || accounts.markets === 0
    ) {
      throw healthCheckFailed('API reports zero/invalid pools or markets — data not initialized', latencyMs);
    }

    const status: HealthStatus = {
      healthy: true,
      latencyMs,
      checkedAt: Date.now(),
      pools: accounts.pools,
      markets: accounts.markets,
      positions: accounts.positions,
    };

    _cachedHealth = status;
    logger.debug('HEALTH', `Flash API healthy: ${latencyMs}ms, ${accounts.pools} pools, ${accounts.markets} markets`);
    return status;
  } catch (err) {
    _cachedHealth = null;
    if (err instanceof ExecutionError) {
      logger.warn('HEALTH', err.message);
      throw err;
    }
    const latencyMs = Date.now() - start;
    const reason = err instanceof Error ? err.message : 'Unknown error';
    logger.warn('HEALTH', `Health check failed: ${reason} (${latencyMs}ms)`);
    throw healthCheckFailed(reason, latencyMs);
  }
}

/** Fire-and-forget background health refresh. Never blocks caller. */
function _triggerBackgroundRefresh(): void {
  if (_backgroundRefreshInFlight) return; // Only one in-flight at a time
  _backgroundRefreshInFlight = true;

  _performHealthCheck()
    .catch(() => {
      // Background refresh failed — cache will be invalidated by _performHealthCheck.
      // Next execution will hit cold path.
    })
    .finally(() => {
      _backgroundRefreshInFlight = false;
    });
}
