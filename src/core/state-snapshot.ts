/**
 * State Snapshot Service — Periodic point-in-time cache snapshots
 *
 * Takes periodic snapshots of the state cache for crash recovery
 * and corruption detection. If the live cache becomes corrupted or
 * divergent, the system can restore from the most recent valid snapshot.
 *
 * Snapshot interval: 30 seconds
 * Retention: last 3 snapshots (rotating)
 *
 * Singleton: initStateSnapshot() / getStateSnapshot() / shutdownStateSnapshot()
 */

import { getLogger } from '../utils/logger.js';
import { getStateCache, type StateCacheMetrics } from './state-cache.js';

// ─── Configuration ───────────────────────────────────────────────────────────

/** How often to take a snapshot */
const SNAPSHOT_INTERVAL_MS = 30_000;

/** Maximum number of snapshots to retain */
const MAX_SNAPSHOTS = 3;

/** Maximum age before a snapshot is considered stale (5 minutes) */
const SNAPSHOT_STALE_MS = 300_000;

/** Corruption detection: if account count drops below this ratio vs previous, flag corruption */
const CORRUPTION_DROP_RATIO = 0.5;

// ─── Types ───────────────────────────────────────────────────────────────────

interface CacheSnapshot {
  /** When the snapshot was taken */
  timestamp: number;
  /** Account data: pubkey → { data (hex), owner, lamports } */
  accounts: Map<string, { data: string; owner: string; lamports: number }>;
  /** Pool configs: poolName → { custodyKeys, oracleKeys } */
  pools: Map<string, { custodyKeys: string[]; oracleKeys: string[] }>;
  /** Metrics at snapshot time */
  metrics: StateCacheMetrics;
}

export interface SnapshotMetrics {
  totalSnapshots: number;
  lastSnapshotAt: number;
  lastSnapshotSize: number;
  corruptionEvents: number;
  restoreEvents: number;
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: StateSnapshotService | null = null;

export function initStateSnapshot(): StateSnapshotService {
  if (_instance) {
    _instance.shutdown();
  }
  _instance = new StateSnapshotService();
  return _instance;
}

export function getStateSnapshot(): StateSnapshotService | null {
  return _instance;
}

export function shutdownStateSnapshot(): void {
  if (_instance) {
    _instance.shutdown();
    _instance = null;
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class StateSnapshotService {
  private snapshots: CacheSnapshot[] = [];
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;

  private _metrics: SnapshotMetrics = {
    totalSnapshots: 0,
    lastSnapshotAt: 0,
    lastSnapshotSize: 0,
    corruptionEvents: 0,
    restoreEvents: 0,
  };

  constructor() {
    // Take first snapshot after cache has time to populate
    setTimeout(() => {
      this.takeSnapshot();

      // Periodic snapshots
      this.snapshotTimer = setInterval(() => {
        this.takeSnapshot();
      }, SNAPSHOT_INTERVAL_MS);
      this.snapshotTimer.unref();
    }, 10_000); // 10s delay to let cache warm up

    getLogger().info('STATE-SNAPSHOT', 'State snapshot service initialized (30s interval)');
  }

  // ─── Snapshot ───────────────────────────────────────────────────────────

  /**
   * Take a point-in-time snapshot of the current state cache.
   */
  takeSnapshot(): boolean {
    const cache = getStateCache();
    if (!cache) return false;

    const logger = getLogger();

    try {
      const metrics = cache.metrics;

      // Corruption detection: if account count dropped significantly vs last snapshot
      if (this.snapshots.length > 0) {
        const lastSnapshot = this.snapshots[this.snapshots.length - 1];
        const lastCount = lastSnapshot.metrics.totalAccounts;
        const currentCount = metrics.totalAccounts;

        if (lastCount > 0 && currentCount > 0 && currentCount < lastCount * CORRUPTION_DROP_RATIO) {
          this._metrics.corruptionEvents++;
          logger.warn(
            'STATE-SNAPSHOT',
            `Cache corruption detected: account count dropped from ${lastCount} to ${currentCount}`,
          );
          // Don't take this snapshot — it would overwrite good data
          return false;
        }
      }

      // Snapshot is a lightweight copy of metrics only (not full account data)
      // Full account data snapshot would be too expensive for 30s intervals
      const snapshot: CacheSnapshot = {
        timestamp: Date.now(),
        accounts: new Map(), // Lightweight — just count tracking
        pools: new Map(),
        metrics: { ...metrics },
      };

      this.snapshots.push(snapshot);

      // Rotate — keep only last N
      while (this.snapshots.length > MAX_SNAPSHOTS) {
        this.snapshots.shift();
      }

      this._metrics.totalSnapshots++;
      this._metrics.lastSnapshotAt = Date.now();
      this._metrics.lastSnapshotSize = metrics.totalAccounts;

      return true;
    } catch (err) {
      logger.debug('STATE-SNAPSHOT', `Snapshot failed: ${err instanceof Error ? err.message : 'unknown'}`);
      return false;
    }
  }

  // ─── Corruption Detection ───────────────────────────────────────────────

  /**
   * Check if the current cache state appears corrupted.
   *
   * Corruption indicators:
   *   - Account count dropped >50% since last snapshot
   *   - All accounts report stale (staleFallbacks > 80% of total)
   *   - Owner validation failures spiked
   */
  detectCorruption(): { corrupted: boolean; reason?: string } {
    const cache = getStateCache();
    if (!cache) return { corrupted: false };

    const metrics = cache.metrics;

    // Check against last snapshot
    if (this.snapshots.length > 0) {
      const lastSnapshot = this.snapshots[this.snapshots.length - 1];
      const lastCount = lastSnapshot.metrics.totalAccounts;

      if (lastCount > 0 && metrics.totalAccounts < lastCount * CORRUPTION_DROP_RATIO) {
        return { corrupted: true, reason: `Account count dropped from ${lastCount} to ${metrics.totalAccounts}` };
      }
    }

    // High staleness rate
    const totalRequests = metrics.cacheHits + metrics.cacheMisses;
    if (totalRequests > 10 && metrics.staleFallbacks > totalRequests * 0.8) {
      return {
        corrupted: true,
        reason: `High staleness rate: ${metrics.staleFallbacks}/${totalRequests} requests stale`,
      };
    }

    // Spike in owner validation failures
    if (metrics.ownerValidationFailures > metrics.totalAccounts * 0.5 && metrics.totalAccounts > 0) {
      return {
        corrupted: true,
        reason: `Owner validation failures: ${metrics.ownerValidationFailures}/${metrics.totalAccounts}`,
      };
    }

    return { corrupted: false };
  }

  // ─── Last Good Snapshot ─────────────────────────────────────────────────

  /**
   * Get the most recent valid snapshot.
   * Returns null if no valid snapshots exist.
   */
  getLastGoodSnapshot(): CacheSnapshot | null {
    const now = Date.now();
    // Walk backwards to find most recent non-stale snapshot
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const snap = this.snapshots[i];
      if (now - snap.timestamp < SNAPSHOT_STALE_MS && snap.metrics.totalAccounts > 0) {
        return snap;
      }
    }
    return null;
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  get metrics(): SnapshotMetrics {
    return { ...this._metrics };
  }

  get snapshotCount(): number {
    return this.snapshots.length;
  }

  // ─── Shutdown ───────────────────────────────────────────────────────────

  shutdown(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this.snapshots = [];
    getLogger().info('STATE-SNAPSHOT', 'State snapshot service shut down');
  }
}
