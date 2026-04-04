/**
 * Maintenance — Background housekeeping for long-running terminal sessions.
 *
 * Consolidates periodic tasks:
 *   - Cache sweep (every 5 minutes)
 *   - Memory monitoring (every 5 minutes)
 *   - Oracle freshness check (every 10 seconds)
 *
 * All timers use .unref() so they don't prevent Node from exiting.
 * Each tick is wrapped in try/catch — maintenance never crashes the terminal.
 */

import { getLogger } from '../utils/logger.js';
import { getScheduler } from '../core/scheduler.js';
import { TaskPriority } from '../core/runtime-state.js';

const CACHE_SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes
const MEMORY_CHECK_INTERVAL_MS = 5 * 60_000; // 5 minutes
const ORACLE_CHECK_INTERVAL_MS = 10_000; // 10 seconds
// Realistic for flash-sdk + Solana: baseline ~500-800MB with all pools loaded
const RSS_WARNING_THRESHOLD = 1.8 * 1024 * 1024 * 1024;  // 1.8 GB
const RSS_CRITICAL_THRESHOLD = 2.5 * 1024 * 1024 * 1024;  // 2.5 GB

export interface MaintenanceHandle {
  stop(): void;
}

export function startMaintenance(): MaintenanceHandle {
  const logger = getLogger();
  const timers: ReturnType<typeof setInterval>[] = [];
  const scheduler = getScheduler();

  // ── Cache Sweep (every 5 min) — LOW priority, suspended in IDLE ──────
  const cacheSweepFn = (): void => {
    try {
      try { sweepFeeCacheSync(); } catch { /* non-critical */ }
      try { sweepPriceHistorySync(); } catch { /* non-critical */ }
      logger.debug('MAINTENANCE', 'Cache sweep completed');
    } catch { /* maintenance must never crash */ }
  };

  if (scheduler) {
    scheduler.register({ name: 'maint-cache-sweep', fn: cacheSweepFn, baseIntervalMs: CACHE_SWEEP_INTERVAL_MS, priority: TaskPriority.LOW });
  } else {
    const t = setInterval(cacheSweepFn, CACHE_SWEEP_INTERVAL_MS);
    t.unref();
    timers.push(t);
  }

  // ── Memory Monitoring (every 5 min) — NORMAL priority, throttled in IDLE ──
  const memoryFn = async (): Promise<void> => {
    try {
      const mem = process.memoryUsage();
      const rssMB = Math.round(mem.rss / (1024 * 1024));
      const heapMB = Math.round(mem.heapUsed / (1024 * 1024));

      if (mem.rss > RSS_CRITICAL_THRESHOLD) {
        logger.warn('MEMORY', `RSS ${rssMB}MB exceeds critical threshold — attempting relief`);
        try {
          const { getStateCache } = await import('../core/state-cache.js');
          const cache = getStateCache();
          if (cache) {
            (cache as unknown as { accountCache: Map<string, unknown> }).accountCache?.clear();
            logger.info('MEMORY', 'Cleared state-cache account buffers');
          }
        } catch { /* non-critical */ }
        if (typeof global.gc === 'function') {
          global.gc();
          logger.info('MEMORY', 'Manual GC triggered');
        }
      } else if (mem.rss > RSS_WARNING_THRESHOLD) {
        logger.warn('MEMORY', `RSS ${rssMB}MB exceeds warning threshold (heap: ${heapMB}MB)`);
      } else {
        logger.debug('MEMORY', `RSS ${rssMB}MB, heap ${heapMB}MB`);
      }
    } catch { /* maintenance must never crash */ }
  };

  if (scheduler) {
    scheduler.register({ name: 'maint-memory-check', fn: memoryFn, baseIntervalMs: MEMORY_CHECK_INTERVAL_MS, priority: TaskPriority.NORMAL });
  } else {
    const t = setInterval(memoryFn, MEMORY_CHECK_INTERVAL_MS);
    t.unref();
    timers.push(t);
  }

  // ── Oracle Freshness (every 10s) — NORMAL priority, throttled in IDLE ──
  let lastOracleOk = true;
  const oracleFn = async (): Promise<void> => {
    try {
      const { PriceService } = await import('../data/prices.js');
      const svc = new PriceService();
      const sol = await svc.getPrice('SOL');
      if (sol) {
        const ageMs = Date.now() - sol.timestamp;
        if (ageMs > 30_000) {
          if (lastOracleOk) {
            logger.warn('ORACLE', `SOL price is ${Math.round(ageMs / 1000)}s stale`);
            lastOracleOk = false;
          }
        } else {
          if (!lastOracleOk) {
            logger.info('ORACLE', 'Oracle freshness recovered');
          }
          lastOracleOk = true;
        }
      }
    } catch { /* Oracle check is best-effort */ }
  };

  if (scheduler) {
    scheduler.register({ name: 'maint-oracle-freshness', fn: oracleFn, baseIntervalMs: ORACLE_CHECK_INTERVAL_MS, priority: TaskPriority.NORMAL });
  } else {
    const t = setInterval(oracleFn, ORACLE_CHECK_INTERVAL_MS);
    t.unref();
    timers.push(t);
  }

  logger.info('MAINTENANCE', 'Background maintenance started (cache sweep: 5m, memory: 5m, oracle: 10s)');

  return {
    stop() {
      for (const t of timers) {
        clearInterval(t);
      }
      timers.length = 0;
      // Unregister from scheduler if registered
      if (scheduler) {
        scheduler.unregister('maint-cache-sweep');
        scheduler.unregister('maint-memory-check');
        scheduler.unregister('maint-oracle-freshness');
      }
      logger.info('MAINTENANCE', 'Background maintenance stopped');
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Sweep expired entries from the protocol fee cache (sync, no imports needed). */
function sweepFeeCacheSync(): void {
  // Dynamic import to avoid circular deps
  import('../utils/protocol-fees.js')
    .then((mod) => {
      if (typeof mod.sweepExpiredCache === 'function') {
        mod.sweepExpiredCache();
      }
    })
    .catch(() => {});
}

/** Trim price history to keep only 24h of data per symbol, bounded. */
function sweepPriceHistorySync(): void {
  import('../data/prices.js')
    .then((mod) => {
      // PriceService already trims history on recordPriceHistory(), but
      // this explicit sweep handles idle periods where no prices are fetched.
      const svc = new mod.PriceService();
      svc.flushHistory();
    })
    .catch(() => {});
}
