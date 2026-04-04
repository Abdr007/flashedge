import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { IFlashClient, Position } from '../types/index.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';
import { getScheduler } from './scheduler.js';
import { TaskPriority } from './runtime-state.js';

// ─── Reconciliation Engine ──────────────────────────────────────────────────
//
// Ensures CLI state matches blockchain state. Fetches authoritative on-chain
// positions and rebuilds the local portfolio view. Runs on:
//   1. CLI startup (after client init)
//   2. Wallet connect/switch
//   3. After confirmed transactions
//   4. Periodic background sync (every 60s)

const RECONCILE_INTERVAL_MS = 60_000;
const RPC_RETRY_DELAY_MS = 400;
const RECONCILE_LOG_DIR = join(homedir(), '.flash', 'logs');
const RECONCILE_LOG_FILE = join(RECONCILE_LOG_DIR, 'reconcile.log');
const RECONCILE_LOG_MAX_BYTES = 2 * 1024 * 1024; // 2MB max before rotation
let reconcileLogWriteCount = 0;

/** Small delay helper */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Append a structured entry to the reconcile log file */
function writeReconcileLog(entry: {
  localCount: number;
  rpcCount: number;
  retryCount?: number;
  retrySucceeded?: boolean;
  action: string;
}): void {
  try {
    if (!existsSync(RECONCILE_LOG_DIR)) {
      mkdirSync(RECONCILE_LOG_DIR, { recursive: true, mode: 0o700 });
    }
    const line =
      `[${new Date().toISOString()}] [RECONCILE] ` +
      `Local positions: ${entry.localCount} | ` +
      `RPC positions: ${entry.rpcCount} | ` +
      `Retry attempted: ${entry.retryCount !== undefined ? 'yes' : 'no'}` +
      (entry.retryCount !== undefined ? ` (got ${entry.retryCount})` : '') +
      (entry.retrySucceeded !== undefined ? ` | Retry resolved: ${entry.retrySucceeded}` : '') +
      ` | Action: ${entry.action}\n`;
    appendFileSync(RECONCILE_LOG_FILE, line, { mode: 0o600 });

    // Rotate log file if too large (check every 50 writes)
    reconcileLogWriteCount++;
    if (reconcileLogWriteCount % 50 === 0) {
      try {
        const stat = statSync(RECONCILE_LOG_FILE);
        if (stat.size > RECONCILE_LOG_MAX_BYTES) {
          const oldPath = RECONCILE_LOG_FILE + '.old';
          renameSync(RECONCILE_LOG_FILE, oldPath);
        }
      } catch {
        // Rotation is best-effort
      }
    }
  } catch {
    // Best-effort — never crash reconciler over log I/O
  }
}

export interface ReconciliationResult {
  /** Whether reconciliation found discrepancies */
  hadDiscrepancy: boolean;
  /** Number of positions from blockchain */
  onChainCount: number;
  /** Positions that appeared on-chain but not in local state */
  added: string[];
  /** Positions that were in local state but not on-chain */
  removed: string[];
  /** Timestamp of reconciliation */
  timestamp: number;
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: StateReconciler | null = null;

export function initReconciler(client: IFlashClient): StateReconciler {
  if (_instance) {
    _instance.stop();
  }
  _instance = new StateReconciler(client);
  return _instance;
}

export function getReconciler(): StateReconciler | null {
  return _instance;
}

// ─── Engine ─────────────────────────────────────────────────────────────────

export class StateReconciler {
  private client: IFlashClient;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastKnownPositions: Map<string, Position> = new Map();
  private lastReconcileAt = 0;
  private _running = false;
  /** Anti-spam: only show one CLI warning per mismatch event */
  private reconcileWarningShown = false;
  /** Count of consecutive cycles where RPC returned fewer positions than local */
  private consecutiveMismatchCycles = 0;
  /** Require multiple consecutive mismatches before removing local positions */
  private static readonly MISMATCH_CYCLES_BEFORE_REMOVAL = 3;

  constructor(client: IFlashClient) {
    this.client = client;
  }

  get running(): boolean {
    return this._running;
  }

  /** Update the client reference (e.g. after wallet reconnect) */
  setClient(client: IFlashClient): void {
    this.client = client;
    // Clear cached state — new wallet means new positions
    this.lastKnownPositions.clear();
    this.reconcileWarningShown = false;
    this.consecutiveMismatchCycles = 0;
  }

  /**
   * Start periodic background reconciliation.
   */
  startPeriodicSync(): void {
    if (this._running) return;
    this._running = true;

    const reconcileFn = (): void => {
      this.reconcile().catch((err) => {
        getLogger().debug('RECONCILER', `Periodic sync error: ${getErrorMessage(err)}`);
      });
    };

    // Use central scheduler if available (LOW priority — suspended in IDLE)
    const scheduler = getScheduler();
    if (scheduler) {
      scheduler.register({
        name: 'state-reconciliation',
        fn: reconcileFn,
        baseIntervalMs: RECONCILE_INTERVAL_MS,
        priority: TaskPriority.LOW,
      });
    } else {
      this.timer = setInterval(reconcileFn, RECONCILE_INTERVAL_MS);
      if (this.timer.unref) this.timer.unref();
    }
  }

  /**
   * Stop periodic background reconciliation.
   */
  stop(): void {
    this._running = false;
    const scheduler = getScheduler();
    if (scheduler) {
      scheduler.unregister('state-reconciliation');
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Perform a single reconciliation pass.
   *
   * Fetches authoritative blockchain positions via the client,
   * compares with the last known local state, and returns
   * what changed.
   */
  async reconcile(): Promise<ReconciliationResult> {
    const logger = getLogger();
    const now = Date.now();

    try {
      // Fetch authoritative state from blockchain
      const onChainPositions = await this.client.getPositions();
      const onChainMap = new Map<string, Position>();

      for (const pos of onChainPositions) {
        // Validate numeric integrity before accepting
        if (
          !Number.isFinite(pos.sizeUsd) ||
          pos.sizeUsd <= 0 ||
          !Number.isFinite(pos.entryPrice) ||
          pos.entryPrice <= 0 ||
          !Number.isFinite(pos.collateralUsd) ||
          pos.collateralUsd <= 0
        ) {
          continue; // Skip corrupt positions
        }
        const key = `${pos.market}:${pos.side}`;
        onChainMap.set(key, pos);
      }

      // Guard against RPC returning fewer positions during transient failures.
      // Step 1: Retry RPC once before assuming mismatch.
      // Step 2: Only show one CLI warning per mismatch event.
      // Step 3: Never remove local positions on a single RPC response.
      if (onChainMap.size < this.lastKnownPositions.size) {
        // ── RPC Retry ──
        await delay(RPC_RETRY_DELAY_MS);
        let _retrySucceeded = false;
        let retryCount = 0;
        try {
          const retryPositions = await this.client.getPositions();
          const retryMap = new Map<string, Position>();
          for (const pos of retryPositions) {
            if (
              !Number.isFinite(pos.sizeUsd) ||
              pos.sizeUsd <= 0 ||
              !Number.isFinite(pos.entryPrice) ||
              pos.entryPrice <= 0 ||
              !Number.isFinite(pos.collateralUsd) ||
              pos.collateralUsd <= 0
            )
              continue;
            retryMap.set(`${pos.market}:${pos.side}`, pos);
          }
          retryCount = retryMap.size;

          if (retryMap.size >= this.lastKnownPositions.size) {
            // Retry resolved the mismatch — use retried data
            _retrySucceeded = true;
            writeReconcileLog({
              localCount: this.lastKnownPositions.size,
              rpcCount: onChainMap.size,
              retryCount,
              retrySucceeded: true,
              action: 'retry_resolved',
            });
            // Reset warning state since things recovered
            this.reconcileWarningShown = false;
            this.consecutiveMismatchCycles = 0;
            this.lastKnownPositions = retryMap;
            this.lastReconcileAt = now;
            return {
              hadDiscrepancy: false,
              onChainCount: retryMap.size,
              added: [],
              removed: [],
              timestamp: now,
            };
          }
        } catch {
          // Retry also failed — preserve local state
        }

        // ── Mismatch persists after retry ──
        this.consecutiveMismatchCycles++;

        // Log to dedicated reconcile log file (always)
        writeReconcileLog({
          localCount: this.lastKnownPositions.size,
          rpcCount: onChainMap.size,
          retryCount,
          retrySucceeded: false,
          action:
            this.consecutiveMismatchCycles >= StateReconciler.MISMATCH_CYCLES_BEFORE_REMOVAL
              ? 'accepting_rpc_state'
              : 'preserving_local_state',
        });

        // Log internally at debug level (never prints to CLI)
        logger.debug(
          'RECONCILE',
          `RPC mismatch: local=${this.lastKnownPositions.size} rpc=${onChainMap.size} ` +
            `retry=${retryCount} cycle=${this.consecutiveMismatchCycles}`,
        );

        // Show one CLI warning per mismatch event (anti-spam)
        if (!this.reconcileWarningShown) {
          logger.warn('RECONCILE', 'Position sync delay detected. Retrying...');
          this.reconcileWarningShown = true;
        }

        // Only accept RPC state after multiple consecutive mismatch cycles
        if (this.consecutiveMismatchCycles < StateReconciler.MISMATCH_CYCLES_BEFORE_REMOVAL) {
          return {
            hadDiscrepancy: false,
            onChainCount: this.lastKnownPositions.size,
            added: [],
            removed: [],
            timestamp: now,
          };
        }
        // Fall through to normal comparison after enough consistent mismatches
        logger.debug(
          'RECONCILE',
          `Accepting RPC state after ${this.consecutiveMismatchCycles} consistent mismatch cycles`,
        );
      } else {
        // RPC matches or exceeds local — reset mismatch tracking
        if (this.reconcileWarningShown) {
          logger.debug('RECONCILE', 'State recovered — RPC matches local');
        }
        this.reconcileWarningShown = false;
        this.consecutiveMismatchCycles = 0;
      }

      // Compare with local state
      const added: string[] = [];
      const removed: string[] = [];

      // Positions on-chain but not locally tracked
      for (const key of onChainMap.keys()) {
        if (!this.lastKnownPositions.has(key)) {
          added.push(key);
        }
      }

      // Positions locally tracked but not on-chain (closed externally or liquidated)
      for (const key of this.lastKnownPositions.keys()) {
        if (!onChainMap.has(key)) {
          removed.push(key);
        }
      }

      const hadDiscrepancy = added.length > 0 || removed.length > 0;

      if (hadDiscrepancy) {
        logger.info('RECONCILE', `State discrepancy: +${added.length} -${removed.length} positions`);
        if (added.length > 0) {
          logger.info('RECONCILE', `New on-chain positions: ${added.join(', ')}`);
        }
        if (removed.length > 0) {
          logger.info('RECONCILE', `Removed positions: ${removed.join(', ')}`);
        }
      }

      // Update local state to match blockchain (blockchain is authoritative)
      this.lastKnownPositions = onChainMap;
      this.lastReconcileAt = now;

      return {
        hadDiscrepancy,
        onChainCount: onChainMap.size,
        added,
        removed,
        timestamp: now,
      };
    } catch (error: unknown) {
      logger.debug('RECONCILE', `Reconciliation failed: ${getErrorMessage(error)}`);
      return {
        hadDiscrepancy: false,
        onChainCount: this.lastKnownPositions.size,
        added: [],
        removed: [],
        timestamp: now,
      };
    }
  }

  /**
   * Verify a specific trade landed on-chain after confirmation.
   * Returns true if the position exists, false if missing.
   */
  async verifyTrade(market: string, side: string): Promise<boolean> {
    const logger = getLogger();
    try {
      const positions = await this.client.getPositions();
      const key = `${market.toUpperCase()}:${side}`;
      const found = positions.some((p) => `${p.market.toUpperCase()}:${p.side}` === key);

      if (!found) {
        logger.warn('RECONCILE', `Trade verification failed: ${key} not found on-chain`);
      }

      // Refresh local state — apply same numeric integrity checks as reconcile()
      const posMap = new Map<string, Position>();
      for (const p of positions) {
        if (
          !Number.isFinite(p.sizeUsd) ||
          p.sizeUsd <= 0 ||
          !Number.isFinite(p.entryPrice) ||
          p.entryPrice <= 0 ||
          !Number.isFinite(p.collateralUsd) ||
          p.collateralUsd <= 0
        ) {
          continue; // Skip corrupt positions
        }
        posMap.set(`${p.market}:${p.side}`, p);
      }
      this.lastKnownPositions = posMap;

      return found;
    } catch (error: unknown) {
      logger.debug('RECONCILE', `Trade verification error: ${getErrorMessage(error)}`);
      return false; // Assume failed if we can't verify
    }
  }

  /**
   * Get the last reconciliation timestamp.
   */
  get lastReconcileTime(): number {
    return this.lastReconcileAt;
  }

  /**
   * Get the current locally-known position count.
   */
  get knownPositionCount(): number {
    return this.lastKnownPositions.size;
  }

  /**
   * Whether the reconciler currently has a pending mismatch.
   * Used by the status bar to show sync state.
   */
  get hasMismatch(): boolean {
    return this.consecutiveMismatchCycles > 0;
  }
}
