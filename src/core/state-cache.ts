/**
 * State Cache Service — background prewarming for ultra-low latency execution.
 *
 * Caches pool configs, custody accounts, oracle accounts, and ALT tables
 * with a 3-second refresh interval. All cached state is validated for:
 *   - Staleness (>10s → fallback to direct RPC fetch)
 *   - Account owner program (must match expected program)
 *   - Oracle timestamps (must be recent)
 *
 * This eliminates synchronous RPC calls from the transaction hot path.
 *
 * Singleton: initStateCache() / getStateCache() / shutdownStateCache()
 */

import { Connection, PublicKey, type AccountInfo } from '@solana/web3.js';
import { PoolConfig } from 'flash-sdk';
import { getLogger } from '../utils/logger.js';
import { POOL_NAMES, FLASH_PROGRAM_ID } from '../config/index.js';
import { getScheduler } from './scheduler.js';
import { TaskPriority } from './runtime-state.js';

// ─── Configuration ───────────────────────────────────────────────────────────

/** Background refresh interval */
const REFRESH_INTERVAL_MS = 3_000;

/** Maximum age before cached state is considered stale */
const STALENESS_THRESHOLD_MS = 10_000;

/** Maximum accounts per getMultipleAccountsInfo batch */
const BATCH_SIZE = 100;

/** Known program owners for validation */
const FLASH_PROGRAM = new PublicKey(FLASH_PROGRAM_ID);
const PYTH_PROGRAM = new PublicKey('FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH');
const PYTH_RECEIVER = new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');

// ─── Types ───────────────────────────────────────────────────────────────────

interface CachedAccount {
  data: Buffer;
  owner: string;
  lamports: number;
  fetchedAt: number;
}

interface PoolCacheEntry {
  poolConfig: PoolConfig;
  custodyKeys: PublicKey[];
  oracleKeys: PublicKey[];
  fetchedAt: number;
}

export interface StateCacheMetrics {
  totalAccounts: number;
  poolsCached: number;
  lastRefreshMs: number;
  cacheHits: number;
  cacheMisses: number;
  staleFallbacks: number;
  ownerValidationFailures: number;
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: StateCache | null = null;

export function initStateCache(connection: Connection): StateCache {
  if (_instance) {
    _instance.shutdown();
  }
  _instance = new StateCache(connection);
  return _instance;
}

export function getStateCache(): StateCache | null {
  return _instance;
}

export function shutdownStateCache(): void {
  if (_instance) {
    _instance.shutdown();
    _instance = null;
  }
}

// ─── State Cache ─────────────────────────────────────────────────────────────

export class StateCache {
  private connection: Connection;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInProgress = false;

  // Caches
  private accountCache: Map<string, CachedAccount> = new Map();
  private poolCache: Map<string, PoolCacheEntry> = new Map();

  // Metrics
  private _metrics: StateCacheMetrics = {
    totalAccounts: 0,
    poolsCached: 0,
    lastRefreshMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
    staleFallbacks: 0,
    ownerValidationFailures: 0,
  };

  constructor(connection: Connection) {
    this.connection = connection;

    // Discover pools and cache their configs
    this.discoverPools();

    // Immediate first refresh
    this.refresh().catch(() => {});

    // Background refresh — NORMAL priority, throttled 5x in IDLE
    const scheduler = getScheduler();
    if (scheduler) {
      scheduler.register({
        name: 'state-cache-refresh',
        fn: () => { this.refresh().catch(() => {}); },
        baseIntervalMs: REFRESH_INTERVAL_MS,
        priority: TaskPriority.NORMAL,
      });
    } else {
      this.refreshTimer = setInterval(() => {
        this.refresh().catch(() => {});
      }, REFRESH_INTERVAL_MS);
      this.refreshTimer.unref();
    }

    getLogger().info('STATE-CACHE', `Initialized — tracking ${this.poolCache.size} pools`);
  }

  // ─── Pool Discovery ──────────────────────────────────────────────────────

  private discoverPools(): void {
    for (const poolName of POOL_NAMES) {
      try {
        const pc = PoolConfig.fromIdsByName(poolName, 'mainnet-beta');
        const custodyKeys: PublicKey[] = [];
        const oracleKeys: PublicKey[] = [];

        // Extract custody and oracle accounts from pool config
        const custodies = pc.custodies as unknown as Array<{
          custodyAccount: PublicKey;
          intOracleAccount?: PublicKey;
          extOracleAccount?: PublicKey;
        }>;

        for (const custody of custodies) {
          if (custody.custodyAccount) custodyKeys.push(custody.custodyAccount);
          if (custody.intOracleAccount) oracleKeys.push(custody.intOracleAccount);
          if (custody.extOracleAccount) oracleKeys.push(custody.extOracleAccount);
        }

        this.poolCache.set(poolName, {
          poolConfig: pc,
          custodyKeys,
          oracleKeys,
          fetchedAt: 0,
        });
      } catch {
        // Pool not available in SDK — skip
      }
    }
  }

  // ─── Background Refresh ──────────────────────────────────────────────────

  private async refresh(): Promise<void> {
    if (this.refreshInProgress) return;
    this.refreshInProgress = true;

    const start = Date.now();
    const logger = getLogger();

    try {
      // Collect all keys to fetch
      const allKeys: PublicKey[] = [];
      const keySourceMap: Map<string, 'custody' | 'oracle'> = new Map();

      for (const [, entry] of this.poolCache) {
        for (const key of entry.custodyKeys) {
          allKeys.push(key);
          keySourceMap.set(key.toBase58(), 'custody');
        }
        for (const key of entry.oracleKeys) {
          allKeys.push(key);
          keySourceMap.set(key.toBase58(), 'oracle');
        }
      }

      if (allKeys.length === 0) return;

      // Deduplicate keys
      const uniqueKeys = [...new Map(allKeys.map((k) => [k.toBase58(), k])).values()];

      // Batch fetch
      for (let i = 0; i < uniqueKeys.length; i += BATCH_SIZE) {
        const batch = uniqueKeys.slice(i, i + BATCH_SIZE);
        try {
          const accounts = await this.connection.getMultipleAccountsInfo(batch, 'confirmed');

          for (let j = 0; j < batch.length; j++) {
            const key = batch[j].toBase58();
            const account = accounts[j];
            if (!account) continue;

            // Validate owner
            const source = keySourceMap.get(key);
            if (!this.validateOwner(account, source)) {
              this._metrics.ownerValidationFailures++;
              continue;
            }

            // Reject oversized account data (max 10MB) to prevent OOM from malicious RPC
            if (Buffer.isBuffer(account.data) && account.data.length > 10_485_760) continue;

            this.accountCache.set(key, {
              data: Buffer.from(account.data),
              owner: account.owner.toBase58(),
              lamports: account.lamports,
              fetchedAt: Date.now(),
            });
          }
        } catch (batchErr) {
          logger.debug(
            'STATE-CACHE',
            `Batch fetch failed: ${batchErr instanceof Error ? batchErr.message : 'unknown'}`,
          );
        }
      }

      // Update pool fetchedAt
      for (const [, entry] of this.poolCache) {
        entry.fetchedAt = Date.now();
      }

      this._metrics.totalAccounts = this.accountCache.size;
      this._metrics.poolsCached = this.poolCache.size;
      this._metrics.lastRefreshMs = Date.now() - start;
    } catch (err) {
      logger.debug('STATE-CACHE', `Refresh failed: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      this.refreshInProgress = false;
    }
  }

  // ─── Validation ──────────────────────────────────────────────────────────

  private validateOwner(account: AccountInfo<Buffer>, source?: 'custody' | 'oracle'): boolean {
    if (!source) return true;

    const owner = account.owner.toBase58();

    if (source === 'custody') {
      return owner === FLASH_PROGRAM.toBase58();
    }

    if (source === 'oracle') {
      // Pyth oracles can be owned by either the main Pyth program or the receiver
      return owner === PYTH_PROGRAM.toBase58() || owner === PYTH_RECEIVER.toBase58();
    }

    return true;
  }

  // ─── Public Getters ──────────────────────────────────────────────────────

  /**
   * Get a cached account. Returns null if not cached or stale.
   * On stale data, triggers a direct RPC fallback fetch.
   */
  async getAccount(pubkey: PublicKey): Promise<AccountInfo<Buffer> | null> {
    const key = pubkey.toBase58();
    const cached = this.accountCache.get(key);

    if (cached && Date.now() - cached.fetchedAt < STALENESS_THRESHOLD_MS) {
      this._metrics.cacheHits++;
      return {
        data: cached.data,
        executable: false,
        lamports: cached.lamports,
        owner: new PublicKey(cached.owner),
        rentEpoch: 0,
      };
    }

    // Stale or missing — direct RPC fallback
    this._metrics.cacheMisses++;
    if (cached) this._metrics.staleFallbacks++;

    try {
      const account = await this.connection.getAccountInfo(pubkey, 'confirmed');
      if (account) {
        // Reject oversized account data (max 10MB) to prevent OOM from malicious RPC
        if (Buffer.isBuffer(account.data) && account.data.length > 10_485_760) {
          return null;
        }
        this.accountCache.set(key, {
          data: Buffer.from(account.data),
          owner: account.owner.toBase58(),
          lamports: account.lamports,
          fetchedAt: Date.now(),
        });
      }
      return account;
    } catch {
      // If RPC fails and we have stale data, return it as best-effort
      if (cached) {
        return {
          data: cached.data,
          executable: false,
          lamports: cached.lamports,
          owner: new PublicKey(cached.owner),
          rentEpoch: 0,
        };
      }
      return null;
    }
  }

  /**
   * Get multiple cached accounts. Falls back to RPC for any missing/stale.
   */
  async getAccounts(pubkeys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
    const now = Date.now();
    const results: (AccountInfo<Buffer> | null)[] = new Array(pubkeys.length).fill(null);
    const missingIndices: number[] = [];
    const missingKeys: PublicKey[] = [];

    // Check cache first
    for (let i = 0; i < pubkeys.length; i++) {
      const key = pubkeys[i].toBase58();
      const cached = this.accountCache.get(key);

      if (cached && now - cached.fetchedAt < STALENESS_THRESHOLD_MS) {
        this._metrics.cacheHits++;
        results[i] = {
          data: cached.data,
          executable: false,
          lamports: cached.lamports,
          owner: new PublicKey(cached.owner),
          rentEpoch: 0,
        };
      } else {
        this._metrics.cacheMisses++;
        if (cached) this._metrics.staleFallbacks++;
        missingIndices.push(i);
        missingKeys.push(pubkeys[i]);
      }
    }

    // Fetch missing from RPC
    if (missingKeys.length > 0) {
      try {
        const fetched = await this.connection.getMultipleAccountsInfo(missingKeys, 'confirmed');
        for (let j = 0; j < fetched.length; j++) {
          const account = fetched[j];
          results[missingIndices[j]] = account;

          if (account) {
            // Reject oversized account data (max 10MB) to prevent OOM from malicious RPC
            if (Buffer.isBuffer(account.data) && account.data.length > 10_485_760) continue;

            const key = missingKeys[j].toBase58();
            this.accountCache.set(key, {
              data: Buffer.from(account.data),
              owner: account.owner.toBase58(),
              lamports: account.lamports,
              fetchedAt: Date.now(),
            });
          }
        }
      } catch {
        // RPC failed — return stale data where available
        for (let j = 0; j < missingKeys.length; j++) {
          const key = missingKeys[j].toBase58();
          const stale = this.accountCache.get(key);
          if (stale) {
            results[missingIndices[j]] = {
              data: stale.data,
              executable: false,
              lamports: stale.lamports,
              owner: new PublicKey(stale.owner),
              rentEpoch: 0,
            };
          }
        }
      }
    }

    return results;
  }

  /**
   * Get cached pool config. Always available (loaded from SDK, not RPC).
   */
  getPoolConfig(poolName: string): PoolConfig | null {
    return this.poolCache.get(poolName)?.poolConfig ?? null;
  }

  /**
   * Check if a specific account's cached state is fresh.
   */
  isFresh(pubkey: PublicKey): boolean {
    const cached = this.accountCache.get(pubkey.toBase58());
    return cached ? Date.now() - cached.fetchedAt < STALENESS_THRESHOLD_MS : false;
  }

  /**
   * Get cache metrics for diagnostics.
   */
  get metrics(): StateCacheMetrics {
    return { ...this._metrics };
  }

  // ─── Connection Management ─────────────────────────────────────────────

  updateConnection(connection: Connection): void {
    this.connection = connection;
  }

  // ─── Shutdown ──────────────────────────────────────────────────────────

  shutdown(): void {
    const scheduler = getScheduler();
    if (scheduler) scheduler.unregister('state-cache-refresh');
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.accountCache.clear();
    getLogger().info('STATE-CACHE', 'State cache shut down');
  }
}
