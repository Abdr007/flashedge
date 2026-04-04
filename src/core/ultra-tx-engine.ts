/**
 * Ultra-Low Latency Solana Execution Engine
 *
 * The ONLY component responsible for sending transactions to the Solana network.
 * All trading commands route through this engine for maximum speed and reliability.
 *
 * Architecture:
 *   1. Blockhash Pipeline — 2s refresh, pre-cached, zero-latency access
 *   2. Prebuilt Transactions — sign-ready tx built before user confirms
 *   3. Dynamic Compute Priority — scales with network congestion
 *   4. Multi-Endpoint Broadcast — parallel submission to all healthy RPCs
 *   5. WebSocket Confirmation — instant confirmation via subscription
 *   6. Transaction Rebroadcast — periodic resend until confirmed
 *   7. Latency Metrics — full pipeline timing for diagnostics
 *   8. Failover Resilience — automatic endpoint rotation on failure
 */

import {
  Connection,
  Keypair,
  TransactionInstruction,
  Signer,
  ComputeBudgetProgram,
  VersionedTransaction,
  MessageV0,
  type AddressLookupTableAccount,
} from '@solana/web3.js';
import { getLogger } from '../utils/logger.js';
import { getMetrics } from '../observability/metrics.js';
import { getScheduler } from './scheduler.js';
import { TaskPriority } from './runtime-state.js';

// Ed25519 program ID — oracle signature verification instructions must be ordered before CU budget
const ED25519_PROGRAM_ID = 'Ed25519SigVerify111111111111111111111111111';

/** Reorder instructions: Ed25519 first (for oracle), then CU budget, then the rest. */
function buildOrderedIxs(
  cuLimitIx: TransactionInstruction,
  cuPriceIx: TransactionInstruction,
  instructions: readonly TransactionInstruction[],
): TransactionInstruction[] {
  const ed25519 = instructions.filter((ix) => ix.programId.toBase58() === ED25519_PROGRAM_ID);
  const rest = instructions.filter((ix) => ix.programId.toBase58() !== ED25519_PROGRAM_ID);
  return [...ed25519, cuLimitIx, cuPriceIx, ...rest];
}
import { getRpcManagerInstance } from '../network/rpc-manager.js';
import { getErrorMessage } from '../utils/retry.js';
import { getLeaderRouter, initLeaderRouter, shutdownLeaderRouter } from './leader-router.js';
import { getTpuClient } from '../network/tpu-client.js';

// ─── Configuration ───────────────────────────────────────────────────────────

/** Blockhash refresh interval — 2s balances freshness vs RPC rate limits */
const BLOCKHASH_REFRESH_MS = 2_000;

/** Maximum age before a cached blockhash is considered stale */
const BLOCKHASH_MAX_AGE_MS = 5_000;

/** Fork protection: reject blockhash if slot drops by more than this amount */
const BLOCKHASH_FORK_SLOT_DROP = 5;

/** Confirmation timeout per attempt */
const CONFIRM_TIMEOUT_MS = 45_000;

/** Default rebroadcast interval during confirmation wait */
const DEFAULT_REBROADCAST_INTERVAL_MS = 800;

/** HTTP poll interval (fallback when WS is slow) */
const POLL_INTERVAL_MS = 3_000;

/** Maximum transaction attempts before failure */
const MAX_ATTEMPTS = 3;

/** Priority fee ceiling (microLamports) — cap to prevent overpay */
const PRIORITY_FEE_CEILING = 500_000;

/** Compute unit limit for Flash Trade transactions (matches website) */
const DEFAULT_CU_LIMIT = 220_000;

/** Priority fee cache TTL — 5s refresh for responsive congestion tracking */
const PRIORITY_FEE_CACHE_MS = 5_000;

/** Congestion detection: uplift % when >50% of recent fees exceed baseline */
const CONGESTION_UPLIFT_PCT = 0.2;

/** Broadcast quorum: minimum endpoints that must accept for success */
const BROADCAST_QUORUM = 2;

/** Maximum number of metrics entries to retain */
const MAX_METRICS_ENTRIES = 100;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TxEngineConfig {
  /** Base compute unit price (microLamports) */
  computeUnitPrice: number;
  /** Compute unit limit */
  computeUnitLimit: number;
  /** Enable dynamic priority fee scaling */
  dynamicPriorityFee: boolean;
  /** Enable multi-endpoint broadcast */
  multiBroadcast: boolean;
  /** Enable WebSocket confirmation */
  wsConfirmation: boolean;
  /** Enable TPU direct forwarding (best-effort, parallel with RPC) */
  tpuForwarding: boolean;
  /** Require broadcast quorum (>=2 endpoints accept) before confirming */
  requireQuorum: boolean;
  /** Enable dynamic compute unit limit based on simulation */
  dynamicCompute?: boolean;
  /** Safety buffer percent for dynamic CU limit */
  computeBufferPercent?: number;
  /** Rebroadcast interval in ms (default: 800) */
  rebroadcastIntervalMs?: number;
}

export interface TxSubmitResult {
  signature: string;
  confirmationTimeMs: number;
  attempts: number;
  broadcastEndpoints: number;
  metrics: TxMetrics;
}

export interface TxMetrics {
  /** Time to acquire blockhash (0 if pre-cached) */
  blockhashLatencyMs: number;
  /** Time to build + sign the transaction (legacy aggregate) */
  buildTimeMs: number;
  /** Time to compile MessageV0 */
  compileTimeMs: number;
  /** Time to sign the transaction */
  signTimeMs: number;
  /** Time from first broadcast to first endpoint acceptance */
  broadcastTimeMs: number;
  /** Time from first broadcast to confirmation */
  confirmLatencyMs: number;
  /** Total end-to-end time */
  totalLatencyMs: number;
  /** Number of endpoints that received the broadcast */
  broadcastCount: number;
  /** Number of rebroadcasts sent */
  rebroadcastCount: number;
  /** Whether WS confirmation was used (vs HTTP polling) */
  confirmedViaWs: boolean;
  /** Priority fee used (microLamports) */
  priorityFee: number;
  /** Which attempt succeeded (1-based) */
  successAttempt: number;
  /** Whether leader-aware routing was used for initial broadcast */
  leaderRouted: boolean;
  /** Slot at which the tx was submitted */
  submittedAtSlot: number;
  /** Time from submit call to broadcast completion */
  submissionLatencyMs: number;
  /** Whether TPU direct forwarding was used */
  tpuForwarded: boolean;
  /** RPC endpoint(s) used for broadcast */
  rpcEndpointsUsed: number;
}

interface CachedBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
  fetchedAt: number;
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: UltraTxEngine | null = null;

export function getUltraTxEngine(): UltraTxEngine | null {
  return _instance;
}

export function initUltraTxEngine(
  primaryConnection: Connection,
  wallet: Keypair,
  config: Partial<TxEngineConfig> = {},
): UltraTxEngine {
  if (_instance) {
    _instance.shutdown();
  }
  _instance = new UltraTxEngine(primaryConnection, wallet, config);
  return _instance;
}

export function shutdownUltraTxEngine(): void {
  if (_instance) {
    _instance.shutdown();
    _instance = null;
  }
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export class UltraTxEngine {
  private primaryConnection: Connection;
  private wallet: Keypair;
  private config: TxEngineConfig;

  // Blockhash pipeline
  private cachedBlockhash: CachedBlockhash | null = null;
  private blockhashTimer: ReturnType<typeof setInterval> | null = null;
  private blockhashInflight: Promise<CachedBlockhash> | null = null;

  // Priority fee pipeline
  private cachedPriorityFee: { fee: number; fetchedAt: number } | null = null;
  private priorityFeeInflight: Promise<number> | null = null;

  // Broadcast connections (all healthy endpoints)
  private broadcastConnections: Connection[] = [];
  private broadcastRefreshTimer: ReturnType<typeof setInterval> | null = null;

  // Concurrency guard — prevents parallel submitTransaction calls from racing
  private submitInProgress = false;

  // Metrics
  private metricsHistory: TxMetrics[] = [];

  constructor(primaryConnection: Connection, wallet: Keypair, config: Partial<TxEngineConfig> = {}) {
    this.primaryConnection = primaryConnection;
    this.wallet = wallet;
    this.config = {
      computeUnitPrice: config.computeUnitPrice ?? 100_000,
      computeUnitLimit: config.computeUnitLimit ?? DEFAULT_CU_LIMIT,
      dynamicPriorityFee: config.dynamicPriorityFee ?? true,
      multiBroadcast: config.multiBroadcast ?? true,
      wsConfirmation: config.wsConfirmation ?? true,
      tpuForwarding: config.tpuForwarding ?? true,
      requireQuorum: config.requireQuorum ?? false, // Opt-in — needs multiple endpoints
    };

    this.startBlockhashPipeline();
    this.refreshBroadcastConnections();

    // Refresh broadcast connections every 30s — LOW priority, suspended in IDLE
    const scheduler = getScheduler();
    if (scheduler) {
      scheduler.register({
        name: 'tx-broadcast-refresh',
        fn: () => this.refreshBroadcastConnections(),
        baseIntervalMs: 30_000,
        priority: TaskPriority.LOW,
      });
    } else {
      this.broadcastRefreshTimer = setInterval(() => {
        this.refreshBroadcastConnections();
      }, 30_000);
      this.broadcastRefreshTimer.unref();
    }

    // Initialize leader-aware routing (can be disabled via FLASH_LEADER_ROUTING=0)
    if (this.config.tpuForwarding || this.config.multiBroadcast) {
      initLeaderRouter(primaryConnection);
      getLogger().info('TX-ENGINE', 'Ultra-low latency execution engine initialized (leader-aware)');
    } else {
      getLogger().info('TX-ENGINE', 'Ultra-low latency execution engine initialized (standard routing)');
    }
  }

  // ─── Blockhash Pipeline ──────────────────────────────────────────────────

  private startBlockhashPipeline(): void {
    // Immediate first fetch
    this.refreshBlockhash().catch(() => {});

    // Blockhash refresh — NORMAL priority, throttled in IDLE (no trades happening)
    const sched = getScheduler();
    if (sched) {
      sched.register({
        name: 'tx-blockhash-refresh',
        fn: () => { this.refreshBlockhash().catch(() => {}); },
        baseIntervalMs: BLOCKHASH_REFRESH_MS,
        priority: TaskPriority.NORMAL,
      });
    } else {
      this.blockhashTimer = setInterval(() => {
        this.refreshBlockhash().catch(() => {});
      }, BLOCKHASH_REFRESH_MS);
      this.blockhashTimer.unref();
    }
  }

  private async refreshBlockhash(): Promise<CachedBlockhash> {
    // Deduplicate concurrent fetches
    if (this.blockhashInflight) return this.blockhashInflight;

    this.blockhashInflight = (async () => {
      try {
        const result = await this.primaryConnection.getLatestBlockhash('confirmed');

        // Fork protection: reject if block height drops significantly
        // (indicates RPC returned stale data or a fork occurred)
        if (
          this.cachedBlockhash &&
          result.lastValidBlockHeight < this.cachedBlockhash.lastValidBlockHeight - BLOCKHASH_FORK_SLOT_DROP
        ) {
          getLogger().warn(
            'TX-ENGINE',
            `Blockhash fork detected: height dropped from ${this.cachedBlockhash.lastValidBlockHeight} to ${result.lastValidBlockHeight}`,
          );
          // Keep the existing (newer) blockhash
          return this.cachedBlockhash;
        }

        const cached: CachedBlockhash = {
          blockhash: result.blockhash,
          lastValidBlockHeight: result.lastValidBlockHeight,
          fetchedAt: Date.now(),
        };
        this.cachedBlockhash = cached;
        return cached;
      } finally {
        this.blockhashInflight = null;
      }
    })();

    return this.blockhashInflight;
  }

  /**
   * Get a fresh blockhash — uses pre-cached value if within age limit,
   * otherwise fetches on-demand. Returns fetch latency for metrics.
   */
  private async getBlockhash(forceRefresh = false): Promise<{ blockhash: CachedBlockhash; fetchLatencyMs: number }> {
    if (!forceRefresh && this.cachedBlockhash && Date.now() - this.cachedBlockhash.fetchedAt < BLOCKHASH_MAX_AGE_MS) {
      return { blockhash: this.cachedBlockhash, fetchLatencyMs: 0 };
    }

    const start = Date.now();
    const result = await this.refreshBlockhash();
    return { blockhash: result, fetchLatencyMs: Date.now() - start };
  }

  // ─── Dynamic Priority Fee ────────────────────────────────────────────────

  /**
   * Compute optimal priority fee based on recent network fees.
   * Uses getRecentPrioritizationFees() to sample the network,
   * then targets the 75th percentile for fast inclusion.
   */
  private async getDynamicPriorityFee(): Promise<number> {
    if (!this.config.dynamicPriorityFee) {
      return this.config.computeUnitPrice;
    }

    // Return cached if fresh
    if (this.cachedPriorityFee && Date.now() - this.cachedPriorityFee.fetchedAt < PRIORITY_FEE_CACHE_MS) {
      return this.cachedPriorityFee.fee;
    }

    // Deduplicate concurrent fetches
    if (this.priorityFeeInflight) return this.priorityFeeInflight;

    this.priorityFeeInflight = (async () => {
      try {
        const fees = await this.primaryConnection.getRecentPrioritizationFees();

        if (!fees || fees.length === 0) {
          // Cache the fallback to prevent repeated failing RPC calls
          this.cachedPriorityFee = { fee: this.config.computeUnitPrice, fetchedAt: Date.now() };
          return this.config.computeUnitPrice;
        }

        // Sort by fee, take the 75th percentile
        const sorted = fees
          .map((f) => f.prioritizationFee)
          .filter((f) => f > 0)
          .sort((a, b) => a - b);

        if (sorted.length === 0) {
          this.cachedPriorityFee = { fee: this.config.computeUnitPrice, fetchedAt: Date.now() };
          return this.config.computeUnitPrice;
        }

        const p75Index = Math.min(Math.floor(sorted.length * 0.75), sorted.length - 1);
        const p75Fee = sorted[p75Index];

        // Congestion detection: if >50% of non-zero fees exceed our baseline, apply uplift
        const baseline = this.config.computeUnitPrice;
        const aboveBaseline = sorted.filter((f) => f > baseline).length;
        const congested = aboveBaseline > sorted.length * 0.5;

        // Clamp between floor and ceiling, with congestion uplift
        let fee = Math.max(baseline, Math.min(p75Fee, PRIORITY_FEE_CEILING));
        if (congested) {
          fee = Math.min(Math.round(fee * (1 + CONGESTION_UPLIFT_PCT)), PRIORITY_FEE_CEILING);
        }

        this.cachedPriorityFee = { fee, fetchedAt: Date.now() };
        return fee;
      } catch {
        // Cache the fallback to prevent hot loop of failing RPC calls
        this.cachedPriorityFee = { fee: this.config.computeUnitPrice, fetchedAt: Date.now() };
        return this.config.computeUnitPrice;
      } finally {
        this.priorityFeeInflight = null;
      }
    })();

    return this.priorityFeeInflight;
  }

  // ─── Multi-Endpoint Broadcast ────────────────────────────────────────────

  /**
   * Build broadcast connection list from all healthy RPC endpoints.
   * Uses slot consensus to exclude endpoints that are divergent (>3 slots off median).
   * The primary connection is always included.
   */
  private refreshBroadcastConnections(): void {
    const rpcMgr = getRpcManagerInstance();
    if (!rpcMgr || !this.config.multiBroadcast) {
      this.broadcastConnections = [this.primaryConnection];
      return;
    }

    // Use slot-consensus-filtered connections when available
    const consensusConnections = rpcMgr.getConsensusHealthyConnections();
    if (consensusConnections.length > 0) {
      this.broadcastConnections = consensusConnections;
      return;
    }

    // Fallback: all endpoints
    const connections: Connection[] = [this.primaryConnection];
    const activeUrl = rpcMgr.activeEndpoint.url;
    const allEndpoints = rpcMgr.getEndpoints();

    for (const ep of allEndpoints) {
      if (ep.url !== activeUrl) {
        try {
          const conn = new Connection(ep.url, {
            commitment: 'confirmed',
            disableRetryOnRateLimit: true,
            fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(30_000) }),
          });
          connections.push(conn);
        } catch {
          // Skip invalid endpoints
        }
      }
    }

    this.broadcastConnections = connections;
  }

  /**
   * Broadcast a serialized transaction to all healthy endpoints.
   *
   * Uses leader-aware routing when available:
   *   1. Leader-preferred endpoint receives the tx first (lowest latency)
   *   2. Remaining endpoints receive the tx in parallel immediately after
   *
   * Falls back to parallel broadcast if leader routing is unavailable.
   * Returns the number of endpoints that accepted the broadcast.
   */
  private async broadcastToAll(
    txBytes: Buffer,
  ): Promise<{ signature: string; broadcastCount: number; leaderRouted: boolean }> {
    const router = getLeaderRouter();
    let leaderRouted = false;
    let connections = this.broadcastConnections;

    // Apply leader-aware ordering if available
    if (router) {
      const order = router.getBroadcastOrder(this.primaryConnection, this.broadcastConnections);
      connections = order.connections;
      leaderRouted = order.leaderRouted;
    }

    // Leader-first broadcast: send to the preferred endpoint first,
    // then immediately fan out to the rest in parallel
    let signature = '';
    let broadcastCount = 0;

    const metrics = getMetrics();

    if (leaderRouted && connections.length > 1) {
      // Send to leader-preferred endpoint first
      try {
        const t0 = Date.now();
        signature = await connections[0].sendRawTransaction(txBytes, {
          skipPreflight: true,
          maxRetries: 0,
        });
        metrics.record('tx_broadcast_latency_ms', Date.now() - t0);
        broadcastCount = 1;
      } catch {
        // Leader endpoint failed — will try all remaining
      }

      // Fan out to remaining endpoints in parallel (non-blocking)
      const remaining = connections.slice(1);
      const remainingResults = await Promise.allSettled(
        remaining.map((conn) => {
          const t0 = Date.now();
          return conn
            .sendRawTransaction(txBytes, {
              skipPreflight: true,
              maxRetries: 0,
            })
            .then((sig) => {
              metrics.record('tx_broadcast_latency_ms', Date.now() - t0);
              return sig;
            });
        }),
      );

      for (const result of remainingResults) {
        if (result.status === 'fulfilled') {
          if (!signature) signature = result.value;
          broadcastCount++;
        }
      }
    } else {
      // Standard parallel broadcast (no leader data)
      const results = await Promise.allSettled(
        connections.map((conn) => {
          const t0 = Date.now();
          return conn
            .sendRawTransaction(txBytes, {
              skipPreflight: true,
              maxRetries: 0,
            })
            .then((sig) => {
              metrics.record('tx_broadcast_latency_ms', Date.now() - t0);
              return sig;
            });
        }),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (!signature) signature = result.value;
          broadcastCount++;
        }
      }
    }

    if (!signature) {
      const firstError = `All ${connections.length} broadcast endpoints failed`;
      throw new Error(firstError);
    }

    return { signature, broadcastCount, leaderRouted };
  }

  // ─── WebSocket Confirmation ──────────────────────────────────────────────

  /**
   * Wait for transaction confirmation using WebSocket subscription with
   * HTTP polling fallback. The first confirmation source wins.
   */
  private async waitForConfirmation(
    signature: string,
    txBytes: Buffer,
    conn: Connection,
    timeoutMs: number,
  ): Promise<{ confirmedViaWs: boolean; rebroadcastCount: number }> {
    const logger = getLogger();
    let _confirmedViaWs = false;
    let rebroadcastCount = 0;
    let wsSubscriptionId: number | undefined;

    return new Promise<{ confirmedViaWs: boolean; rebroadcastCount: number }>((resolve, reject) => {
      let settled = false;

      const cleanup = (viaWs: boolean) => {
        settled = true;
        clearInterval(pollTimer);
        clearInterval(rebroadcastTimer);
        clearTimeout(timeoutTimer);
        // Unsubscribe WebSocket — only if confirmation came via polling (not WS).
        // onSignature is a one-shot subscription that auto-removes after firing,
        // so calling removeSignatureListener after WS delivery triggers a spurious warning.
        if (wsSubscriptionId !== undefined && !viaWs) {
          try {
            conn.removeSignatureListener(wsSubscriptionId).catch(() => {});
          } catch {
            // Already cleaned up
          }
        }
      };

      const onConfirmed = (viaWs: boolean) => {
        if (settled) return;
        cleanup(viaWs);
        resolve({ confirmedViaWs: viaWs, rebroadcastCount });
      };

      const onError = (err: Error) => {
        if (settled) return;
        cleanup(false);
        reject(err);
      };

      // ── WebSocket Confirmation ──
      if (this.config.wsConfirmation) {
        try {
          // Assign to a local first, then to outer variable — ensures cleanup
          // can find it even if the callback fires synchronously
          const subId = conn.onSignature(
            signature,
            (result) => {
              if (result.err) {
                onError(new Error(`Transaction failed on-chain: ${JSON.stringify(result.err)}`));
              } else {
                _confirmedViaWs = true;
                onConfirmed(true);
              }
            },
            'confirmed',
          );
          wsSubscriptionId = subId;
        } catch {
          // WS subscription failed — rely on polling
          logger.debug('TX-ENGINE', 'WebSocket subscription failed — using HTTP polling only');
        }
      }

      // ── HTTP Polling (fallback + parallel) ──
      const pollTimer = setInterval(async () => {
        if (settled) return;
        try {
          const { value } = await conn.getSignatureStatuses([signature]);
          const status = value?.[0];
          if (status?.err) {
            onError(new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`));
            return;
          }
          if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
            onConfirmed(false);
          }
        } catch {
          // Poll failure — will retry next interval
        }
      }, POLL_INTERVAL_MS);

      // ── Rebroadcast Engine ──
      // Re-evaluate leader routing on each cycle for optimal delivery
      const rebroadcastTargets = [...this.broadcastConnections];
      const rebroadcastTimer = setInterval(() => {
        if (settled) return;
        rebroadcastCount++;

        // Re-evaluate leader ordering each cycle — leader changes every ~400ms
        const router = getLeaderRouter();
        let targets = rebroadcastTargets;
        if (router) {
          const order = router.getBroadcastOrder(conn, rebroadcastTargets);
          targets = order.connections;
        }

        for (const broadcastConn of targets) {
          broadcastConn
            .sendRawTransaction(txBytes, {
              skipPreflight: true,
              maxRetries: 0,
            })
            .catch(() => {});
        }
      }, this.config.rebroadcastIntervalMs ?? DEFAULT_REBROADCAST_INTERVAL_MS);

      // ── Timeout ──
      const timeoutTimer = setTimeout(() => {
        if (settled) return;
        // One final status check before declaring timeout
        conn
          .getSignatureStatuses([signature])
          .then(({ value }) => {
            const status = value?.[0];
            if (
              status &&
              !status.err &&
              (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
            ) {
              onConfirmed(false);
            } else {
              onError(new Error(`Not confirmed within ${timeoutMs / 1000}s`));
            }
          })
          .catch(() => {
            onError(new Error(`Not confirmed within ${timeoutMs / 1000}s`));
          });
      }, timeoutMs);
    });
  }

  // ─── Pre-Send Simulation ─────────────────────────────────────────────────

  /**
   * Simulate transaction before broadcast. Catches program errors early
   * to avoid wasting time on doomed transactions.
   */
  /**
   * Simulate a transaction and return compute units consumed (if available).
   * Throws on terminal program errors. Returns null on non-critical failures.
   */
  private async simulateTransaction(vtx: VersionedTransaction, conn: Connection): Promise<number | null> {
    try {
      const simResult = await conn.simulateTransaction(vtx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });

      if (simResult.value.err) {
        const simErr = JSON.stringify(simResult.value.err);
        getLogger().warn('TX-ENGINE', `Simulation error: ${simErr}`);
        if (simResult.value.logs) {
          const programLogs = simResult.value.logs.filter(
            (l: string) => l.includes('Error') || l.includes('failed') || l.includes('custom program error'),
          );
          if (programLogs.length > 0) {
            getLogger().warn('TX-ENGINE', `Program logs: ${programLogs.join(' | ')}`);
          }
        }
        // Program errors are terminal — don't retry
        if (simErr.includes('InstructionError') || simErr.includes('Custom')) {
          throw new Error(this.mapProgramError(simErr));
        }
        getLogger().info('TX-ENGINE', `Pre-send simulation warning: ${simErr}`);
        return null;
      }

      return simResult.value.unitsConsumed ?? null;
    } catch (simError: unknown) {
      const simMsg = getErrorMessage(simError);
      // Re-throw program errors
      if (
        simMsg.includes('simulation failed') ||
        simMsg.includes('Trade rejected') ||
        simMsg.includes('Transaction rejected')
      ) {
        throw simError;
      }
      // Non-critical simulation failures (RPC timeout etc) — proceed with send
      getLogger().debug('TX-ENGINE', `Pre-send simulation skipped: ${simMsg}`);
      return null;
    }
  }

  // ─── Core Submit ─────────────────────────────────────────────────────────

  /**
   * Submit a transaction with ultra-low latency optimizations.
   *
   * Pipeline:
   *   1. Get pre-cached blockhash (0ms if warm)
   *   2. Compute dynamic priority fee
   *   3. Build + sign transaction
   *   4. Simulate on first attempt
   *   5. Multi-endpoint broadcast
   *   6. WebSocket + HTTP polling confirmation
   *   7. Rebroadcast every 2s until confirmed
   *   8. Retry with fresh blockhash on timeout
   */
  async submitTransaction(
    instructions: TransactionInstruction[],
    additionalSigners: Signer[] = [],
    addressLookupTableAccounts?: AddressLookupTableAccount[],
    computeUnitLimitOverride?: number,
  ): Promise<TxSubmitResult> {
    // Concurrency guard — only one submitTransaction at a time
    if (this.submitInProgress) {
      throw new Error('Another transaction is already in progress. Wait for it to complete.');
    }
    this.submitInProgress = true;

    try {
      return await this._submitTransactionInner(
        instructions,
        additionalSigners,
        addressLookupTableAccounts,
        computeUnitLimitOverride,
      );
    } finally {
      this.submitInProgress = false;
    }
  }

  private async _submitTransactionInner(
    instructions: TransactionInstruction[],
    additionalSigners: Signer[],
    addressLookupTableAccounts?: AddressLookupTableAccount[],
    computeUnitLimitOverride?: number,
  ): Promise<TxSubmitResult> {
    const logger = getLogger();
    const pipelineStart = Date.now();
    let lastError = '';
    let lastSignature = '';
    let totalBroadcastCount = 0;

    // Metrics accumulators
    let blockhashLatencyMs = 0;
    let buildTimeMs = 0;
    let compileTimeMs = 0;
    let signTimeMs = 0;
    let broadcastTimeMs = 0;
    let confirmLatencyMs: number;
    let rebroadcastCount = 0;
    let confirmedViaWs: boolean;
    let priorityFee = this.config.computeUnitPrice;
    let leaderRouted = false;
    let submittedAtSlot = 0;
    let submissionLatencyMs = 0;
    const tpuForwarded = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const conn = this.primaryConnection;

      // Check if previous attempt's tx landed late
      if (attempt > 1 && lastSignature) {
        try {
          const { value } = await conn.getSignatureStatuses([lastSignature]);
          const status = value?.[0];
          if (
            status &&
            !status.err &&
            (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
          ) {
            logger.info('TX-ENGINE', `Previous tx confirmed (late detection): ${lastSignature}`);
            const metrics = this.buildMetrics({
              blockhashLatencyMs,
              buildTimeMs,
              compileTimeMs,
              signTimeMs,
              broadcastTimeMs,
              confirmLatencyMs: Date.now() - pipelineStart - buildTimeMs - blockhashLatencyMs,
              totalLatencyMs: Date.now() - pipelineStart,
              broadcastCount: totalBroadcastCount,
              rebroadcastCount,
              confirmedViaWs: false,
              priorityFee,
              successAttempt: attempt - 1,
              leaderRouted,
              submittedAtSlot,
              submissionLatencyMs,
              tpuForwarded,
              rpcEndpointsUsed: totalBroadcastCount,
            });
            return {
              signature: lastSignature,
              confirmationTimeMs: Date.now() - pipelineStart,
              attempts: attempt - 1,
              broadcastEndpoints: totalBroadcastCount,
              metrics,
            };
          }
        } catch {
          // Best-effort — proceed with retry
        }
      }

      if (attempt === 1) {
        process.stdout.write('  Sending transaction...   \r');
      } else {
        process.stdout.write(`  Retry ${attempt}/${MAX_ATTEMPTS} (fresh blockhash)...\r`);
        logger.info('TX-ENGINE', `Retry attempt ${attempt}/${MAX_ATTEMPTS}`);
      }

      try {
        // ── Step 1: Blockhash ──
        const forceRefresh = attempt > 1;
        const { blockhash: bh, fetchLatencyMs: bhLatency } = await this.getBlockhash(forceRefresh);
        blockhashLatencyMs = bhLatency;

        // ── Step 2: Priority Fee ──
        const buildStart = Date.now();
        priorityFee = await this.getDynamicPriorityFee();

        // ── Step 3: Build + Sign (granular timing) ──
        const effectiveCuLimit = computeUnitLimitOverride ?? this.config.computeUnitLimit;
        const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: effectiveCuLimit });
        const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee });

        const allIxs = buildOrderedIxs(cuLimitIx, cuPriceIx, instructions);

        const compileStart = Date.now();
        const message = MessageV0.compile({
          payerKey: this.wallet.publicKey,
          instructions: allIxs,
          recentBlockhash: bh.blockhash,
          addressLookupTableAccounts: addressLookupTableAccounts ?? [],
        });
        compileTimeMs = Date.now() - compileStart;

        const signStart = Date.now();
        const vtx = new VersionedTransaction(message);
        vtx.sign([this.wallet, ...additionalSigners]);
        signTimeMs = Date.now() - signStart;

        buildTimeMs = Date.now() - buildStart;

        // ── Transaction assembly diagnostics (first attempt only) ──
        if (attempt === 1) {
          const txSize = vtx.serialize().length;
          const altLookups = message.addressTableLookups ?? [];
          const altLookupCount = altLookups.reduce(
            (sum, l) => sum + l.readonlyIndexes.length + l.writableIndexes.length,
            0,
          );
          logger.info(
            'TX',
            `Size: ${txSize}b | ALT: ${altLookups.length > 0 ? `${altLookups.length} table(s), ${altLookupCount} accounts` : 'none'} | Static: ${message.staticAccountKeys.length} | CU: ${effectiveCuLimit} | Fee: ${priorityFee} µL | IXs: ${allIxs.length}`,
          );
        }

        // ── Step 4: Simulate (first attempt only) ──
        let simUnitsConsumed: number | null = null;
        if (attempt === 1) {
          simUnitsConsumed = await this.simulateTransaction(vtx, conn);
        }

        // ── Step 4b: Dynamic CU optimization ──
        // If simulation succeeded and dynamic compute is enabled, tighten the CU
        // limit to unitsConsumed * (1 + buffer%). Rebuilds tx locally — no extra RPC call.
        let finalVtx = vtx;
        if (simUnitsConsumed && simUnitsConsumed > 0 && this.config.dynamicCompute !== false) {
          const bufferPct = this.config.computeBufferPercent ?? 20;
          const rawLimit = Math.ceil((simUnitsConsumed * (1 + bufferPct / 100)) / 10_000) * 10_000;
          // Safety clamp: never below 120k (floor) or above configured limit
          const dynamicLimit = Math.max(120_000, Math.min(rawLimit, effectiveCuLimit));
          if (dynamicLimit < effectiveCuLimit && dynamicLimit >= simUnitsConsumed) {
            getLogger().debug(
              'TX-ENGINE',
              `Dynamic CU: ${simUnitsConsumed} used → ${dynamicLimit} limit (was ${effectiveCuLimit})`,
            );
            const tightCuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: dynamicLimit });
            const tightCuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee });
            const tightIxs = [tightCuLimitIx, tightCuPriceIx, ...instructions];
            const tightMsg = MessageV0.compile({
              payerKey: this.wallet.publicKey,
              instructions: tightIxs,
              recentBlockhash: bh.blockhash,
              addressLookupTableAccounts: addressLookupTableAccounts ?? [],
            });
            finalVtx = new VersionedTransaction(tightMsg);
            finalVtx.sign([this.wallet, ...additionalSigners]);
          }
        }

        // ── Step 5: Multi-Endpoint Broadcast ──
        const txBytes = Buffer.from(finalVtx.serialize());
        const confirmStart = Date.now();

        // ── Partition Guard ──
        const rpcMgr = getRpcManagerInstance();
        if (rpcMgr?.partitionDetected) {
          logger.warn('TX-ENGINE', 'Network partition detected — pausing broadcast');
          // Wait up to 5s for partition to clear
          let partitionCleared = false;
          for (let wait = 0; wait < 5; wait++) {
            await new Promise((r) => setTimeout(r, 1_000));
            rpcMgr.detectPartition();
            if (!rpcMgr.partitionDetected) {
              partitionCleared = true;
              break;
            }
          }
          if (!partitionCleared) {
            logger.warn('TX-ENGINE', 'Partition persists — proceeding with broadcast (best-effort)');
          }
        }

        process.stdout.write('  Broadcasting...          \r');

        // Record slot at broadcast time for inclusion tracking
        const router = getLeaderRouter();
        submittedAtSlot = router?.getCurrentSlot() ?? 0;

        let signature: string;
        let broadcastCount: number;
        let tpuForwarded = false;
        const broadcastStart = Date.now();

        // ── TPU Direct Forwarding (fire-and-forget, parallel with RPC) ──
        if (this.config.tpuForwarding) {
          const tpuClient = getTpuClient();
          if (tpuClient?.isOperational) {
            // Non-blocking — don't await, just fire
            tpuClient
              .forwardToUpcomingLeaders(txBytes)
              .then((result) => {
                if (result.attempted) tpuForwarded = true;
              })
              .catch(() => {}); // TPU is best-effort
          }
        }

        // ── RPC Broadcast ──
        if (this.config.multiBroadcast && this.broadcastConnections.length > 1) {
          const result = await this.broadcastToAll(txBytes);
          signature = result.signature;
          broadcastCount = result.broadcastCount;
          leaderRouted = result.leaderRouted;

          // ── Broadcast Quorum Check ──
          if (
            this.config.requireQuorum &&
            broadcastCount < BROADCAST_QUORUM &&
            this.broadcastConnections.length >= BROADCAST_QUORUM
          ) {
            logger.warn('TX-ENGINE', `Broadcast quorum not met: ${broadcastCount}/${BROADCAST_QUORUM} — retrying`);
            // One retry attempt for quorum
            const retry = await this.broadcastToAll(txBytes).catch(() => null);
            if (retry && retry.broadcastCount > broadcastCount) {
              broadcastCount = retry.broadcastCount;
            }
          }
        } else {
          signature = await conn.sendRawTransaction(txBytes, {
            skipPreflight: true,
            maxRetries: 0,
          });
          broadcastCount = 1;
        }
        broadcastTimeMs = Date.now() - broadcastStart;
        submissionLatencyMs = Date.now() - pipelineStart;

        lastSignature = signature;
        totalBroadcastCount = broadcastCount;
        logger.info(
          'TX-ENGINE',
          `Tx broadcast: ${signature} (${txBytes.length}B, ${broadcastCount} endpoints, attempt ${attempt}, priority ${priorityFee}µL${leaderRouted ? ', leader-routed' : ''})`,
        );

        // ── Step 6: Wait for Confirmation ──
        // Reduce timeout if blockhash fetch was slow
        const effectiveTimeout =
          bhLatency > 5_000 ? Math.max(CONFIRM_TIMEOUT_MS - bhLatency, 20_000) : CONFIRM_TIMEOUT_MS;

        process.stdout.write('  Awaiting confirmation... \r');

        const confirmResult = await this.waitForConfirmation(signature, txBytes, conn, effectiveTimeout);

        confirmLatencyMs = Date.now() - confirmStart;
        rebroadcastCount = confirmResult.rebroadcastCount;
        confirmedViaWs = confirmResult.confirmedViaWs;

        // Success!
        process.stdout.write('                              \r');
        logger.info(
          'TX-ENGINE',
          `Tx confirmed: ${signature} (${confirmLatencyMs}ms, ${confirmedViaWs ? 'WS' : 'HTTP'}, ${rebroadcastCount} rebroadcasts)`,
        );

        const metrics = this.buildMetrics({
          blockhashLatencyMs,
          buildTimeMs,
          compileTimeMs,
          signTimeMs,
          broadcastTimeMs,
          confirmLatencyMs,
          totalLatencyMs: Date.now() - pipelineStart,
          broadcastCount: totalBroadcastCount,
          rebroadcastCount,
          confirmedViaWs,
          priorityFee,
          successAttempt: attempt,
          leaderRouted,
          submittedAtSlot,
          submissionLatencyMs,
          tpuForwarded,
          rpcEndpointsUsed: totalBroadcastCount,
        });

        return {
          signature,
          confirmationTimeMs: Date.now() - pipelineStart,
          attempts: attempt,
          broadcastEndpoints: broadcastCount,
          metrics,
        };
      } catch (e: unknown) {
        const eMsg = getErrorMessage(e);

        // Program errors are terminal — don't retry
        if (
          eMsg.includes('failed on-chain') ||
          eMsg.includes('Trade rejected') ||
          eMsg.includes('Transaction rejected')
        ) {
          process.stdout.write('                              \r');
          throw e;
        }

        lastError = eMsg;
        logger.warn('TX-ENGINE', `Attempt ${attempt} failed: ${eMsg}`);

        // On network errors, trigger RPC failover before next retry.
        // Note: we do NOT update primaryConnection here — that's done by
        // FlashClient.replaceConnection() via the RpcManager callback,
        // which calls txEngine.updateConnection(). This prevents desync
        // between engine and FlashClient connection state.
        if (attempt < MAX_ATTEMPTS && this.isNetworkError(eMsg)) {
          const rpcMgr = getRpcManagerInstance();
          if (rpcMgr && rpcMgr.fallbackCount > 0) {
            logger.info('TX-ENGINE', 'Network error — attempting RPC failover before retry');
            rpcMgr.recordResult(false);
            const didFailover = await rpcMgr.failover(true);
            if (didFailover) {
              // Connection is updated via the RpcManager's onConnectionChange callback
              // which calls FlashClient.replaceConnection() → txEngine.updateConnection()
              logger.info('TX-ENGINE', `Switched to ${rpcMgr.activeEndpoint.label}`);
            }
          }
        }
      }
    }

    process.stdout.write('                              \r');
    throw new Error(
      `Transaction failed after ${MAX_ATTEMPTS} attempts.\n` +
        `  Last error: ${lastError}\n` +
        (lastSignature ? `  Last signature: ${lastSignature}\n  Check https://solscan.io/tx/${lastSignature}` : ''),
    );
  }

  // ─── Async Submit (fire-and-confirm-in-background) ───────────────────────

  /**
   * Submit a transaction and return immediately after broadcast.
   * Confirmation happens in the background via a callback.
   *
   * Returns the signature immediately — caller can proceed without waiting.
   * The onConfirmed callback fires when confirmation arrives (or on error).
   */
  async submitTransactionAsync(
    instructions: TransactionInstruction[],
    additionalSigners: Signer[] = [],
    onConfirmed?: (result: { signature: string; confirmed: boolean; error?: string }) => void,
    addressLookupTableAccounts?: AddressLookupTableAccount[],
    computeUnitLimitOverride?: number,
  ): Promise<string> {
    const logger = getLogger();

    // Get blockhash + priority fee
    const { blockhash: bh } = await this.getBlockhash();
    const priorityFee = await this.getDynamicPriorityFee();

    // Build + sign
    const effectiveCuLimit = computeUnitLimitOverride ?? this.config.computeUnitLimit;
    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: effectiveCuLimit });
    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee });

    const allIxs = buildOrderedIxs(cuLimitIx, cuPriceIx, instructions);
    const message = MessageV0.compile({
      payerKey: this.wallet.publicKey,
      instructions: allIxs,
      recentBlockhash: bh.blockhash,
      addressLookupTableAccounts: addressLookupTableAccounts ?? [],
    });
    const vtx = new VersionedTransaction(message);
    vtx.sign([this.wallet, ...additionalSigners]);
    const txBytes = Buffer.from(vtx.serialize());

    // Broadcast
    let signature: string;
    if (this.config.multiBroadcast && this.broadcastConnections.length > 1) {
      const result = await this.broadcastToAll(txBytes);
      signature = result.signature;
    } else {
      signature = await this.primaryConnection.sendRawTransaction(txBytes, {
        skipPreflight: true,
        maxRetries: 0,
      });
    }

    logger.info('TX-ENGINE', `Async broadcast: ${signature}`);

    // Background confirmation — fire-and-forget
    if (onConfirmed) {
      this.waitForConfirmation(signature, txBytes, this.primaryConnection, CONFIRM_TIMEOUT_MS)
        .then(() => {
          onConfirmed({ signature, confirmed: true });
        })
        .catch((err: unknown) => {
          onConfirmed({ signature, confirmed: false, error: getErrorMessage(err) });
        });
    }

    return signature;
  }

  // ─── Prebuilt Transaction ────────────────────────────────────────────────

  /**
   * Prebuilt transaction: build and sign a transaction without submitting.
   * Returns a ready-to-submit closure for instant execution after user confirms.
   */
  async prebuildTransaction(
    instructions: TransactionInstruction[],
    additionalSigners: Signer[] = [],
    addressLookupTableAccounts?: AddressLookupTableAccount[],
    computeUnitLimitOverride?: number,
  ): Promise<{
    submit: () => Promise<TxSubmitResult>;
    blockhashAge: () => number;
    isExpired: () => boolean;
  }> {
    const { blockhash: bh } = await this.getBlockhash();
    const priorityFee = await this.getDynamicPriorityFee();

    const effectiveCuLimit = computeUnitLimitOverride ?? this.config.computeUnitLimit;
    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: effectiveCuLimit });
    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee });

    const allIxs = buildOrderedIxs(cuLimitIx, cuPriceIx, instructions);
    const message = MessageV0.compile({
      payerKey: this.wallet.publicKey,
      instructions: allIxs,
      recentBlockhash: bh.blockhash,
      addressLookupTableAccounts: addressLookupTableAccounts ?? [],
    });
    const vtx = new VersionedTransaction(message);
    vtx.sign([this.wallet, ...additionalSigners]);

    const txBytes = Buffer.from(vtx.serialize());
    const builtAt = Date.now();

    return {
      blockhashAge: () => Date.now() - builtAt,
      isExpired: () => Date.now() - builtAt > 30_000, // ~60 slots ≈ 24s + margin
      submit: async () => {
        // If the prebuilt tx is too old, rebuild with fresh blockhash
        if (Date.now() - builtAt > 30_000) {
          getLogger().info('TX-ENGINE', 'Prebuilt tx expired — rebuilding with fresh blockhash');
          return this.submitTransaction(instructions, additionalSigners, addressLookupTableAccounts);
        }

        // Concurrency guard — same as submitTransaction
        if (this.submitInProgress) {
          throw new Error('Another transaction is already in progress. Wait for it to complete.');
        }
        this.submitInProgress = true;

        try {
          const pipelineStart = Date.now();

          // Record slot at broadcast time for inclusion tracking
          const router = getLeaderRouter();
          const submittedAtSlot = router?.getCurrentSlot() ?? 0;

          // Direct broadcast — no simulation needed (was already validated when building)
          let signature: string;
          let broadcastCount: number;
          let leaderRouted = false;

          if (this.config.multiBroadcast && this.broadcastConnections.length > 1) {
            const result = await this.broadcastToAll(txBytes);
            signature = result.signature;
            broadcastCount = result.broadcastCount;
            leaderRouted = result.leaderRouted;
          } else {
            signature = await this.primaryConnection.sendRawTransaction(txBytes, {
              skipPreflight: true,
              maxRetries: 0,
            });
            broadcastCount = 1;
          }

          const confirmResult = await this.waitForConfirmation(
            signature,
            txBytes,
            this.primaryConnection,
            CONFIRM_TIMEOUT_MS,
          );

          const totalLatencyMs = Date.now() - pipelineStart;

          const metrics = this.buildMetrics({
            blockhashLatencyMs: 0,
            buildTimeMs: 0,
            compileTimeMs: 0,
            signTimeMs: 0,
            broadcastTimeMs: 0,
            confirmLatencyMs: totalLatencyMs,
            totalLatencyMs,
            broadcastCount,
            rebroadcastCount: confirmResult.rebroadcastCount,
            confirmedViaWs: confirmResult.confirmedViaWs,
            priorityFee,
            successAttempt: 1,
            leaderRouted,
            submittedAtSlot,
            submissionLatencyMs: 0,
            tpuForwarded: false,
            rpcEndpointsUsed: broadcastCount,
          });

          return {
            signature,
            confirmationTimeMs: totalLatencyMs,
            attempts: 1,
            broadcastEndpoints: broadcastCount,
            metrics,
          };
        } finally {
          this.submitInProgress = false;
        }
      },
    };
  }

  // ─── Account State Prefetch ──────────────────────────────────────────────

  /**
   * Prefetch account data that will be needed for transaction building.
   * Warms the RPC node's cache for faster subsequent reads.
   */
  async prefetchAccounts(accounts: string[]): Promise<void> {
    if (accounts.length === 0) return;

    const { PublicKey } = await import('@solana/web3.js');
    const pubkeys = accounts.map((a) => new PublicKey(a));

    // Fire-and-forget — just warm the cache
    this.primaryConnection.getMultipleAccountsInfo(pubkeys, 'confirmed').catch(() => {});
  }

  // ─── Metrics ─────────────────────────────────────────────────────────────

  private buildMetrics(raw: TxMetrics): TxMetrics {
    this.metricsHistory.push(raw);
    if (this.metricsHistory.length > MAX_METRICS_ENTRIES) {
      this.metricsHistory.shift();
    }
    return raw;
  }

  /**
   * Get latency statistics from recent transactions.
   */
  getMetricsSummary(): {
    totalTxs: number;
    avgTotalLatencyMs: number;
    avgConfirmLatencyMs: number;
    avgBlockhashLatencyMs: number;
    avgBuildTimeMs: number;
    avgCompileTimeMs: number;
    avgSignTimeMs: number;
    avgBroadcastTimeMs: number;
    avgSubmissionLatencyMs: number;
    p50ConfirmMs: number;
    p95ConfirmMs: number;
    wsConfirmPct: number;
    avgBroadcastCount: number;
    avgRebroadcastCount: number;
    leaderRoutedPct: number;
    tpuForwardedPct: number;
    avgSlotDelay: number;
    fastestEndpoint: string | null;
  } {
    const h = this.metricsHistory;
    if (h.length === 0) {
      return {
        totalTxs: 0,
        avgTotalLatencyMs: 0,
        avgConfirmLatencyMs: 0,
        avgBlockhashLatencyMs: 0,
        avgBuildTimeMs: 0,
        avgCompileTimeMs: 0,
        avgSignTimeMs: 0,
        avgBroadcastTimeMs: 0,
        avgSubmissionLatencyMs: 0,
        p50ConfirmMs: 0,
        p95ConfirmMs: 0,
        wsConfirmPct: 0,
        avgBroadcastCount: 0,
        avgRebroadcastCount: 0,
        leaderRoutedPct: 0,
        tpuForwardedPct: 0,
        avgSlotDelay: 0,
        fastestEndpoint: null,
      };
    }

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const percentile = (arr: number[], p: number) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
      return sorted[idx];
    };

    const confirmTimes = h.map((m) => m.confirmLatencyMs);
    const wsCount = h.filter((m) => m.confirmedViaWs).length;
    const leaderCount = h.filter((m) => m.leaderRouted).length;

    // Get leader router metrics
    const router = getLeaderRouter();
    const routerMetrics = router?.getMetrics();

    return {
      totalTxs: h.length,
      avgTotalLatencyMs: Math.round(avg(h.map((m) => m.totalLatencyMs))),
      avgConfirmLatencyMs: Math.round(avg(confirmTimes)),
      avgBlockhashLatencyMs: Math.round(avg(h.map((m) => m.blockhashLatencyMs))),
      avgBuildTimeMs: Math.round(avg(h.map((m) => m.buildTimeMs))),
      avgCompileTimeMs: Math.round(avg(h.map((m) => m.compileTimeMs))),
      avgSignTimeMs: Math.round(avg(h.map((m) => m.signTimeMs))),
      avgBroadcastTimeMs: Math.round(avg(h.map((m) => m.broadcastTimeMs))),
      avgSubmissionLatencyMs: Math.round(avg(h.map((m) => m.submissionLatencyMs))),
      p50ConfirmMs: Math.round(percentile(confirmTimes, 0.5)),
      p95ConfirmMs: Math.round(percentile(confirmTimes, 0.95)),
      wsConfirmPct: Math.round((wsCount / h.length) * 100),
      avgBroadcastCount: Math.round(avg(h.map((m) => m.broadcastCount)) * 10) / 10,
      avgRebroadcastCount: Math.round(avg(h.map((m) => m.rebroadcastCount)) * 10) / 10,
      leaderRoutedPct: Math.round((leaderCount / h.length) * 100),
      tpuForwardedPct: Math.round((h.filter((m) => m.tpuForwarded).length / h.length) * 100),
      avgSlotDelay: routerMetrics?.avgSlotDelay ?? 0,
      fastestEndpoint: routerMetrics?.fastestEndpoint ?? null,
    };
  }

  /** Get raw metrics history */
  getMetricsHistory(): readonly TxMetrics[] {
    return this.metricsHistory;
  }

  // ─── Connection Management ───────────────────────────────────────────────

  /**
   * Update the primary connection (called on RPC failover).
   */
  updateConnection(connection: Connection): void {
    this.primaryConnection = connection;
    // Invalidate cached blockhash — new RPC may have different view of slot height
    this.cachedBlockhash = null;
    this.refreshBroadcastConnections();
    getLeaderRouter()?.updateConnection(connection);
  }

  /**
   * Update the wallet keypair (called on wallet switch).
   */
  updateWallet(wallet: Keypair): void {
    this.wallet = wallet;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private isNetworkError(msg: string): boolean {
    const lower = msg.toLowerCase();
    return (
      lower.includes('timeout') ||
      lower.includes('econnrefused') ||
      lower.includes('econnreset') ||
      lower.includes('enotfound') ||
      lower.includes('fetch failed') ||
      lower.includes('network request failed') ||
      lower.includes('socket hang up') ||
      lower.includes('429') ||
      lower.includes('503') ||
      lower.includes('502')
    );
  }

  private mapProgramError(rawError: string): string {
    if (rawError.includes('Custom(3012)') || rawError.includes('"Custom":3012')) {
      return [
        'Trade rejected by Flash protocol.',
        '',
        '  Possible reasons:',
        '  • Market is currently closed (virtual markets follow real-world trading sessions)',
        '  • Oracle price is stale or unavailable',
        '  • Insufficient pool liquidity',
        '  • Position below minimum size',
        '',
        '  If this is a commodity or FX market, try again during trading hours.',
      ].join('\n');
    }
    const customMatch = rawError.match(/Custom\(?(\d+)\)?/i);
    if (customMatch) {
      return `Trade rejected by Flash protocol (error ${customMatch[1]}). The transaction did not execute.`;
    }
    return `Transaction rejected by program: ${rawError.slice(0, 300)}`;
  }

  // ─── Shutdown ────────────────────────────────────────────────────────────

  shutdown(): void {
    const scheduler = getScheduler();
    if (scheduler) {
      scheduler.unregister('tx-blockhash-refresh');
      scheduler.unregister('tx-broadcast-refresh');
    }
    if (this.blockhashTimer) {
      clearInterval(this.blockhashTimer);
      this.blockhashTimer = null;
    }
    if (this.broadcastRefreshTimer) {
      clearInterval(this.broadcastRefreshTimer);
      this.broadcastRefreshTimer = null;
    }
    this.broadcastConnections = [];
    shutdownLeaderRouter();
    getLogger().info('TX-ENGINE', 'Ultra-low latency execution engine shut down');
  }
}
