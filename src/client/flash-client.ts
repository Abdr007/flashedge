/* eslint-disable max-lines -- Flash SDK client; transaction pipeline requires co-located methods */
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  Signer,
  ComputeBudgetProgram,
  VersionedTransaction,
  MessageV0,
  LAMPORTS_PER_SOL,
  type AddressLookupTableAccount,
} from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import BN from 'bn.js';
import {
  PerpetualsClient,
  PoolConfig,
  CustodyAccount,
  PositionAccount,
  Side,
  Privilege,
  Token,
  uiDecimalsToNative,
  BN_ZERO,
  OraclePrice,
  ContractOraclePrice,
  createBackupOracleInstruction,
} from 'flash-sdk';
import {
  Position,
  TradeSide,
  FlashConfig,
  MarketData,
  Portfolio,
  IFlashClient,
  OpenPositionResult,
  ClosePositionResult,
  CollateralResult,
  DryRunPreview,
  PlaceLimitOrderResult,
  PlaceTriggerOrderResult,
  CancelOrderResult,
  OnChainOrder,
  getLeverageLimits,
} from '../types/index.js';
import { PythHttpClient, getPythProgramKeyForCluster, PriceData } from '@pythnetwork/client';
import { getPoolForMarket, isTradeablePool, POOL_NAMES, getMaxLeverage } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage, withRetry } from '../utils/retry.js';
import type { WalletManager } from '../wallet/walletManager.js';
import { getRpcManagerInstance } from '../network/rpc-manager.js';
import { getUltraTxEngine, initUltraTxEngine } from '../core/ultra-tx-engine.js';
import { initStateCache, getStateCache } from '../core/state-cache.js';
import { initStateSnapshot } from '../core/state-snapshot.js';
import { initTpuClient, getTpuClient } from '../network/tpu-client.js';
import { getLeaderRouter } from '../core/leader-router.js';

import {
  createBatch,
  appendToBatch,
  isBatchWithinLimit,
  batchSummary,
  type SdkResult,
} from '../transaction/instruction-aggregator.js';
import { resolveALTs, verifyALTAccountOverlap, logMessageALTDiagnostics } from '../transaction/alt-resolver.js';
import { buildATAIdempotentIxs } from '../transaction/ata-resolver.js';
import { getTypedMarkets, type SdkPositionData, type SdkPoolConfigExt } from '../types/sdk-types.js';

// ─── SDK Console Suppression ─────────────────────────────────────────────────
// The Flash SDK has debug console.log statements in its published build.
// Suppress them during SDK calls to keep terminal output clean.

async function quietSdk<T>(fn: () => Promise<T>): Promise<T> {
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    const first = typeof args[0] === 'string' ? args[0] : '';
    if (
      first.includes('close position') ||
      first.includes('SDK logs') ||
      first.includes('volitlity fee') ||
      first.includes('assetsUsd') ||
      first.includes('collateralSymbol === SOL') ||
      first.includes('inputSymbol === SOL') ||
      first.includes('maxWithdrawableAmount') ||
      first.includes('collateralAmountReceived') ||
      first.includes('exceeding to') ||
      first.includes('profitLoss') ||
      first.includes('THIS cannot') ||
      first.includes('No account info found')
    ) {
      return;
    }
    origLog.apply(console, args);
  };
  try {
    return await fn();
  } finally {
    console.log = origLog;
  }
}

// ─── Pyth Price Service ──────────────────────────────────────────────────────

interface LiveTokenPrice {
  price: OraclePrice;
  emaPrice: OraclePrice;
  uiPrice: number;
  timestamp: number;
}

const MAX_PYTH_CACHE_ENTRIES = 50;

class PythPriceService {
  private pythClient: PythHttpClient;
  private cache: Map<string, { data: LiveTokenPrice; expiry: number }> = new Map();
  private cacheTtlMs = 5_000;

  // Circuit breaker: stop hammering Pyth after consecutive failures
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private static readonly CB_THRESHOLD = 3;         // open circuit after 3 consecutive failures
  private static readonly CB_COOLDOWN_MS = 30_000;   // stay open for 30s before half-open retry
  private static readonly CB_MAX_COOLDOWN_MS = 120_000; // max 2 min cooldown after repeated trips

  constructor(pythnetUrl: string) {
    // Validate Pythnet URL: must be HTTPS (or localhost for dev)
    try {
      const parsed = new URL(pythnetUrl);
      const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
        throw new Error(`Pythnet URL must use HTTPS: ${pythnetUrl}`);
      }
      if (parsed.username || parsed.password) {
        throw new Error('Pythnet URL must not contain embedded credentials');
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('Pythnet')) throw e;
      throw new Error(`Invalid Pythnet URL: ${pythnetUrl}`, { cause: e });
    }
    const conn = new Connection(pythnetUrl, {
      commitment: 'confirmed',
      fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(30_000) }),
    });
    this.pythClient = new PythHttpClient(conn, getPythProgramKeyForCluster('pythnet'));
  }

  async getPrices(tokens: { symbol: string; pythTicker: string }[]): Promise<Map<string, LiveTokenPrice>> {
    const priceMap = new Map<string, LiveTokenPrice>();
    const now = Date.now();
    const logger = getLogger();
    const uncached: typeof tokens = [];

    for (const token of tokens) {
      const cached = this.cache.get(token.symbol);
      if (cached && cached.expiry > now) {
        priceMap.set(token.symbol, cached.data);
      } else {
        uncached.push(token);
      }
    }

    if (uncached.length === 0) return priceMap;

    // ─── Circuit Breaker ─────────────────────────────────────────────────
    // When Pyth is down, stop hammering it. Return stale cache instead.
    if (now < this.circuitOpenUntil) {
      logger.debug('PRICE', `Pyth circuit breaker open — returning ${priceMap.size} cached prices (retry in ${Math.round((this.circuitOpenUntil - now) / 1000)}s)`);
      return priceMap; // return whatever was cached above
    }

    // Evict expired entries if cache is too large
    if (this.cache.size >= MAX_PYTH_CACHE_ENTRIES) {
      for (const [k, entry] of this.cache) {
        if (entry.expiry <= now) this.cache.delete(k);
      }
      if (this.cache.size >= MAX_PYTH_CACHE_ENTRIES) {
        const oldest = Array.from(this.cache.keys()).slice(0, 10);
        for (const k of oldest) this.cache.delete(k);
      }
    }

    let pythData;
    try {
      pythData = await withRetry(() => this.pythClient.getData(), 'pyth-prices', { maxAttempts: 2 });
      // Success — reset circuit breaker
      this.consecutiveFailures = 0;
      this.circuitOpenUntil = 0;
    } catch (err) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= PythPriceService.CB_THRESHOLD) {
        // Exponential cooldown: 30s, 60s, 120s (capped)
        const backoffMultiplier = Math.min(2 ** (this.consecutiveFailures - PythPriceService.CB_THRESHOLD), 4);
        const cooldown = Math.min(
          PythPriceService.CB_COOLDOWN_MS * backoffMultiplier,
          PythPriceService.CB_MAX_COOLDOWN_MS,
        );
        this.circuitOpenUntil = now + cooldown;
        logger.warn('PRICE', `Pyth circuit breaker OPEN — ${this.consecutiveFailures} consecutive failures, cooldown ${Math.round(cooldown / 1000)}s`);
      }
      throw err; // let caller handle (they already catch)
    }

    for (const token of uncached) {
      const priceData: PriceData | undefined = pythData.productPrice.get(token.pythTicker);
      if (!priceData) {
        logger.info('PRICE', `No Pyth data for ${token.symbol} (${token.pythTicker})`);
        continue;
      }

      const priceComponent = priceData.aggregate.priceComponent;
      const emaPriceComponent = priceData.emaPrice.valueComponent;
      // confidence from Pyth can be a float — convert to integer at the oracle's exponent scale
      const rawConfidence = priceData.confidence ?? 0;
      const confidenceInt =
        typeof rawConfidence === 'number'
          ? Math.round(rawConfidence * Math.pow(10, Math.abs(priceData.exponent)))
          : rawConfidence;
      const rawEmaConfidence = priceData.emaConfidence?.valueComponent ?? 0;

      const price = new OraclePrice({
        price: new BN(priceComponent.toString()),
        exponent: new BN(priceData.exponent.toString()),
        confidence: new BN(confidenceInt.toString()),
        timestamp: new BN(priceData.timestamp.toString()),
      });

      const emaPrice = new OraclePrice({
        price: new BN(emaPriceComponent.toString()),
        exponent: new BN(priceData.exponent.toString()),
        confidence: new BN(rawEmaConfidence.toString()),
        timestamp: new BN(priceData.timestamp.toString()),
      });

      const uiPrice = priceData.aggregate.price ?? 0;
      // Reject zero or negative prices from oracle — prevents trades at invalid prices
      if (!Number.isFinite(uiPrice) || uiPrice <= 0) {
        logger.info('PRICE', `Invalid oracle price for ${token.symbol}: ${uiPrice} — skipping`);
        continue;
      }

      // [H-1] Oracle staleness check — reject prices older than 30 seconds
      const oracleTimestamp = priceData.timestamp ? Number(priceData.timestamp) * 1000 : 0;
      const priceAgeMs = now - oracleTimestamp;
      const MAX_ORACLE_AGE_MS = 30_000;
      if (oracleTimestamp > 0 && priceAgeMs > MAX_ORACLE_AGE_MS) {
        logger.warn('PRICE', `Oracle price for ${token.symbol} is ${Math.round(priceAgeMs / 1000)}s stale — skipping`);
        continue;
      }

      // [H-2] Confidence interval check — reject wide-spread prices (>2% uncertainty)
      const absPrice = Math.abs(priceData.aggregate.price || 1);
      const confidenceRatio = (priceData.confidence ?? 0) / absPrice;
      const MAX_CONFIDENCE_RATIO = 0.02;
      if (confidenceRatio > MAX_CONFIDENCE_RATIO) {
        logger.warn(
          'PRICE',
          `Oracle confidence for ${token.symbol} too wide: ${(confidenceRatio * 100).toFixed(1)}% — skipping`,
        );
        continue;
      }

      const tokenPrice: LiveTokenPrice = {
        price,
        emaPrice,
        uiPrice,
        timestamp: oracleTimestamp || now,
      };

      priceMap.set(token.symbol, tokenPrice);
      this.cache.set(token.symbol, { data: tokenPrice, expiry: now + this.cacheTtlMs });
    }

    return priceMap;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toSdkSide(side: TradeSide): typeof Side.Long | typeof Side.Short {
  return side === TradeSide.Long ? Side.Long : Side.Short;
}

// Minimum SOL balance required to cover transaction fees
const MIN_SOL_FOR_FEES = 0.01;

// Flash perpetual pools use USDC as the default collateral token
const DEFAULT_COLLATERAL_TOKEN = 'USDC';

// Well-known USDC mint on Solana mainnet
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

/**
 * Scrub sensitive data (API keys, private keys) from strings before logging.
 */
function scrubSensitive(msg: string): string {
  // Mask anything that looks like an API key or base58 private key in query params
  return msg.replace(/api[_-]?key=[^&\s]+/gi, 'api_key=***');
}

/**
 * Map raw Solana program error codes to human-readable messages.
 * Flash Trade uses Anchor-style Custom error codes. Known codes:
 *   3012 — Market closed / oracle stale (virtual markets outside trading hours)
 */
function mapProgramError(rawError: string): string {
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
  // Extract custom error code for other program errors
  const customMatch = rawError.match(/Custom\(?(\d+)\)?/i);
  if (customMatch) {
    return `Trade rejected by Flash protocol (error ${customMatch[1]}). The transaction did not execute.`;
  }
  // Fallback: include raw error for debugging
  const logger = getLogger();
  logger.warn('TX', `Program rejection (raw): ${scrubSensitive(rawError)}`);
  return `Transaction rejected by program: ${rawError.slice(0, 200)}`;
}

/**
 * Check if an error message indicates a network-level failure (not a program error).
 * Network errors are candidates for RPC failover; program errors are not.
 */
function isNetworkError(msg: string): boolean {
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

// ─── Program ID Whitelist ──────────────────────────────────────────────────
//
// Only transactions interacting with these known programs are allowed.
// Any instruction targeting an unknown program ID is rejected before signing.

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const SYSVAR_RENT = 'SysvarRent111111111111111111111111111111111';
const SYSVAR_CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const SYSVAR_INSTRUCTIONS = 'Sysvar1nstructions1111111111111111111111111';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const EVENT_AUTHORITY = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp18C'; // Flash event CPI
const ED25519_PROGRAM = 'Ed25519SigVerify111111111111111111111111111'; // Ed25519 signature verification (backup oracle)

// Flash Trade program IDs are loaded dynamically from PoolConfig.
// [M-4] Base set of allowed system programs — immutable.
// Flash-specific IDs are added per-client instance via frozenAllowedProgramIds.
const BASE_ALLOWED_PROGRAM_IDS = Object.freeze(
  new Set<string>([
    SYSTEM_PROGRAM,
    TOKEN_PROGRAM,
    TOKEN_2022_PROGRAM,
    ATA_PROGRAM,
    COMPUTE_BUDGET_PROGRAM,
    SYSVAR_RENT,
    SYSVAR_CLOCK,
    SYSVAR_INSTRUCTIONS,
    MEMO_PROGRAM,
    EVENT_AUTHORITY,
    ED25519_PROGRAM,
  ]),
);

// Active program whitelist — updated by FlashClient constructor and getPoolConfigForMarket().
// Starts with base system programs; Flash-specific IDs added per pool.
// Only one FlashClient instance exists at a time; the reference is safe.
let ALLOWED_PROGRAM_IDS: ReadonlySet<string> = BASE_ALLOWED_PROGRAM_IDS;

/**
 * Validate that every instruction in a transaction targets an approved program.
 * Throws if any instruction uses an unknown program ID.
 */
function validateInstructionPrograms(instructions: TransactionInstruction[], context: string): void {
  for (let i = 0; i < instructions.length; i++) {
    const progId = instructions[i].programId.toBase58();
    if (!ALLOWED_PROGRAM_IDS.has(progId)) {
      throw new Error(
        `Transaction rejected: instruction ${i} targets unknown program ${progId} (${context}). ` +
          `Only approved Flash Trade and Solana system programs are allowed.`,
      );
    }
  }
}

// ─── FlashClient ─────────────────────────────────────────────────────────────

export class FlashClient implements IFlashClient {
  private connection: Connection;
  private wallet: Keypair;
  private provider: AnchorProvider;
  private perpClient: PerpetualsClient;
  private poolConfig: PoolConfig;
  private priceService: PythPriceService;
  private config: FlashConfig;
  private walletMgr: WalletManager;
  private cachedSolBalance = 0;

  /** [M-4] Instance-level allowed program IDs */
  private allowedPrograms: Set<string>;

  /** Per-market mutex to prevent concurrent transactions on the same market/side */
  private activeTrades = new Set<string>();

  /** Cached referral params for trade calls */
  private referralParams: {
    privilege: typeof Privilege.Referral;
    tokenStakeAccount: PublicKey;
    userReferralAccount: PublicKey;
  } | null = null;


  /** Pre-cached blockhash — refreshed every 5s to avoid blocking on getLatestBlockhash during trade */
  private cachedBlockhash: { blockhash: string; lastValidBlockHeight: number; fetchedAt: number } | null = null;
  private blockhashTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly BLOCKHASH_REFRESH_MS = 5_000;
  private static readonly BLOCKHASH_MAX_AGE_MS = 10_000;

  constructor(connection: Connection, walletManager: WalletManager, config: FlashConfig) {
    this.config = config;
    this.connection = connection;
    this.walletMgr = walletManager;

    const keypair = walletManager.getKeypair();
    if (!keypair) {
      throw new Error('No wallet connected. Use "wallet connect <path>" or ensure ~/.config/solana/id.json exists.');
    }
    this.wallet = keypair;

    const walletAdapter = new Wallet(this.wallet);
    this.provider = new AnchorProvider(this.connection, walletAdapter, {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });

    try {
      this.poolConfig = PoolConfig.fromIdsByName(config.defaultPool, config.network);
    } catch {
      throw new Error(
        `Unknown pool: ${config.defaultPool}. ` +
          `Valid pools: Crypto.1, Virtual.1, Governance.1, Community.1, Community.2, Trump.1, Ore.1`,
      );
    }

    // Match prioritizationFee with config to avoid conflict with manual CU instructions
    this.perpClient = new PerpetualsClient(
      this.provider,
      this.poolConfig.programId,
      this.poolConfig.perpComposibilityProgramId,
      this.poolConfig.fbNftRewardProgramId,
      this.poolConfig.rewardDistributionProgram.programId,
      { prioritizationFee: config.computeUnitPrice },
      false, // useExtOracleAccount — internal oracles used for current SDK version
    );

    // [M-4] Build allowed program set from pool config
    // Not frozen: getPoolConfigForMarket() adds IDs when cross-pool trades occur
    const instanceAllowed = new Set<string>(BASE_ALLOWED_PROGRAM_IDS);
    instanceAllowed.add(this.poolConfig.programId.toBase58());
    if (this.poolConfig.perpComposibilityProgramId) {
      instanceAllowed.add(this.poolConfig.perpComposibilityProgramId.toBase58());
    }
    if (this.poolConfig.fbNftRewardProgramId) {
      instanceAllowed.add(this.poolConfig.fbNftRewardProgramId.toBase58());
    }
    if (this.poolConfig.rewardDistributionProgram?.programId) {
      instanceAllowed.add(this.poolConfig.rewardDistributionProgram.programId.toBase58());
    }
    this.allowedPrograms = instanceAllowed;
    // Update module-level reference for validateInstructionPrograms
    ALLOWED_PROGRAM_IDS = instanceAllowed;

    this.priceService = new PythPriceService(config.pythnetUrl);

    // Initialize state prewarming cache (3s background refresh)
    initStateCache(this.connection);

    // Initialize state snapshot service (30s periodic snapshots)
    initStateSnapshot();

    // Initialize TPU direct forwarding client (gated by FLASH_LEADER_ROUTING)
    if (config.leaderRouting) {
      initTpuClient(this.connection);
    }

    // Initialize ultra-low latency execution engine (handles its own blockhash refresh at 300ms)
    initUltraTxEngine(this.connection, this.wallet, {
      computeUnitPrice: config.computeUnitPrice,
      computeUnitLimit: config.computeUnitLimit,
      dynamicPriorityFee: true,
      multiBroadcast: true,
      wsConfirmation: true,
      tpuForwarding: config.leaderRouting,
      dynamicCompute: config.dynamicCompute,
      computeBufferPercent: config.computeBufferPercent,
      rebroadcastIntervalMs: config.rebroadcastIntervalMs,
    });

    // Start legacy blockhash pre-cache only if engine init failed
    // (engine handles its own refresh; running both wastes RPC quota)
    if (!getUltraTxEngine()) {
      this.startBlockhashRefresh();
    }
  }

  /**
   * Start background blockhash refresh (every 5s).
   * Ensures sendTx() can use a recent blockhash without a blocking RPC call.
   */
  private startBlockhashRefresh(): void {
    // Initial fetch (non-blocking — sendTx will fetch on-demand if cache is empty)
    this.refreshBlockhash().catch(() => {});
    this.blockhashTimer = setInterval(() => {
      this.refreshBlockhash().catch(() => {});
    }, FlashClient.BLOCKHASH_REFRESH_MS);
    this.blockhashTimer.unref();
  }

  private async refreshBlockhash(): Promise<void> {
    try {
      const result = await this.connection.getLatestBlockhash('confirmed');
      this.cachedBlockhash = {
        blockhash: result.blockhash,
        lastValidBlockHeight: result.lastValidBlockHeight,
        fetchedAt: Date.now(),
      };
    } catch {
      // Non-critical — sendTx will fetch on-demand if cache is stale
    }
  }

  /**
   * Get a recent blockhash — uses pre-cached value if fresh, otherwise fetches on-demand.
   * Returns the blockhash and the age of the cache entry (for timeout adjustment).
   */
  private async getBlockhash(
    conn: Connection,
  ): Promise<{ blockhash: string; lastValidBlockHeight: number; fetchLatencyMs: number }> {
    const cached = this.cachedBlockhash;
    if (cached && Date.now() - cached.fetchedAt < FlashClient.BLOCKHASH_MAX_AGE_MS) {
      return { blockhash: cached.blockhash, lastValidBlockHeight: cached.lastValidBlockHeight, fetchLatencyMs: 0 };
    }
    // Cache miss or stale — fetch on-demand
    const start = Date.now();
    const result = await conn.getLatestBlockhash('confirmed');
    const fetchLatencyMs = Date.now() - start;
    this.cachedBlockhash = {
      blockhash: result.blockhash,
      lastValidBlockHeight: result.lastValidBlockHeight,
      fetchedAt: Date.now(),
    };
    return { blockhash: result.blockhash, lastValidBlockHeight: result.lastValidBlockHeight, fetchLatencyMs };
  }

  /** Stop background blockhash refresh (called on shutdown) */
  stopBlockhashRefresh(): void {
    if (this.blockhashTimer) {
      clearInterval(this.blockhashTimer);
      this.blockhashTimer = null;
    }
    // Shut down ultra-tx engine
    const txEngine = getUltraTxEngine();
    if (txEngine) txEngine.shutdown();
  }

  get walletAddress(): string {
    return this.wallet.publicKey.toBase58();
  }

  /**
   * Replace the active RPC connection (called by RpcManager on failover).
   * Safe to call mid-session — in-flight sendTx() calls capture their own
   * local `conn` reference at the start of each attempt, so swapping
   * this.connection here does not disrupt confirmation polling.
   * The new connection takes effect on the next attempt or next trade.
   *
   * Builds the new provider and perpClient BEFORE swapping references —
   * this ensures concurrent reads of this.perpClient never see a partially
   * constructed state (e.g. new connection but old provider).
   */
  replaceConnection(connection: Connection): void {
    // Build replacements BEFORE swapping — prevents mid-trade reads from
    // seeing inconsistent state (new connection + old perpClient)
    const walletAdapter = new Wallet(this.wallet);
    const newProvider = new AnchorProvider(connection, walletAdapter, {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });
    const newPerpClient = new PerpetualsClient(
      newProvider,
      this.poolConfig.programId,
      this.poolConfig.perpComposibilityProgramId,
      this.poolConfig.fbNftRewardProgramId,
      this.poolConfig.rewardDistributionProgram.programId,
      { prioritizationFee: this.config.computeUnitPrice },
      false, // useExtOracleAccount
    );
    // Swap all references together — minimizes the window where concurrent
    // reads could see mismatched connection/provider/perpClient
    this.connection = connection;
    this.provider = newProvider;
    this.perpClient = newPerpClient;
    // Propagate connection change to ultra-tx engine, state cache, and wallet manager
    const txEngine = getUltraTxEngine();
    if (txEngine) txEngine.updateConnection(connection);
    const stateCache = getStateCache();
    if (stateCache) stateCache.updateConnection(connection);
    const tpuClient = getTpuClient();
    if (tpuClient) tpuClient.updateConnection(connection);
    this.walletMgr.setConnection(connection);
    getLogger().info('CLIENT', 'Connection replaced (RPC failover)');
  }

  // ─── Pre-Trade Validation ─────────────────────────────────────────────────

  private async ensureSufficientSol(): Promise<void> {
    const lamports = await withRetry(() => this.connection.getBalance(this.wallet.publicKey), 'sol-balance-check', {
      maxAttempts: 2,
    });
    this.cachedSolBalance = lamports / LAMPORTS_PER_SOL;
    if (this.cachedSolBalance < MIN_SOL_FOR_FEES) {
      throw new Error(
        `Insufficient SOL for transaction fees. Balance: ${this.cachedSolBalance.toFixed(4)} SOL. ` +
          `Minimum required: ${MIN_SOL_FOR_FEES} SOL.`,
      );
    }
  }

  private validateLeverage(market: string, leverage: number): void {
    const limits = getLeverageLimits(market);
    if (leverage < limits.min) {
      throw new Error(`Minimum leverage for ${market}: ${limits.min}x`);
    }
    if (leverage > limits.max) {
      throw new Error(`Maximum leverage for ${market}: ${limits.max}x`);
    }
  }

  // ─── Referral Params ─────────────────────────────────────────────────────

  /**
   * Resolve referral parameters for trade calls.
   * If a referrer is configured, derives the referrer's tokenStakeAccount PDA
   * and the user's referral PDA. Caches result for subsequent calls.
   * Returns null if no referrer is set or derivation fails.
   */
  /** Whether we've already checked the referral PDA on-chain (one-time) */
  private referralChecked = false;

  private getReferralParams(): {
    privilege: typeof Privilege.Referral;
    tokenStakeAccount: PublicKey;
    userReferralAccount: PublicKey;
  } | null {
    if (this.referralParams) return this.referralParams;
    if (!this.config.referrerAddress) return null;
    // If we already checked and it was invalid, don't retry
    if (this.referralChecked) return null;

    try {
      const referrerPk = new PublicKey(this.config.referrerAddress);
      const userPk = this.wallet.publicKey;
      const programId = this.poolConfig.programId;

      // Referrer's tokenStakeAccount PDA: ["token_stake", referrer_pubkey]
      const [referrerStakeAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from('token_stake'), referrerPk.toBuffer()],
        programId,
      );

      // User's referral account PDA: ["referral", user_pubkey]
      const [userReferralAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from('referral'), userPk.toBuffer()],
        programId,
      );

      this.referralParams = {
        privilege: Privilege.Referral,
        tokenStakeAccount: referrerStakeAccount,
        userReferralAccount,
      };

      const logger = getLogger();
      logger.info(
        'REFERRAL',
        `Referral active: referrer=${referrerPk.toBase58().slice(0, 8)}... stakeAcct=${referrerStakeAccount.toBase58().slice(0, 8)}... referralPDA=${userReferralAccount.toBase58().slice(0, 8)}...`,
      );

      return this.referralParams;
    } catch (err: unknown) {
      const logger = getLogger();
      logger.info('REFERRAL', `Failed to resolve referral params: ${getErrorMessage(err)}`);
      this.referralChecked = true;
      return null;
    }
  }

  /**
   * Async referral validation — checks that referral PDA exists on-chain.
   * Called once before the first trade. If PDA doesn't exist, auto-creates it
   * silently so every CLI user is automatically referred.
   */
  async validateReferralOnChain(): Promise<void> {
    if (this.referralChecked) return;
    this.referralChecked = true;

    const params = this.getReferralParams();
    if (!params) return;

    const logger = getLogger();
    try {
      const acctInfo = await this.connection.getAccountInfo(params.userReferralAccount);
      if (!acctInfo) {
        logger.info('REFERRAL', 'User referral PDA not found on-chain. Auto-creating...');
        await this.autoCreateReferralAccount(params.userReferralAccount);
      } else {
        // PDA exists — verify it's linked to the correct referrer
        // The referral account data contains the referrer's token stake account
        // at a known offset. If it doesn't match, warn the user.
        try {
          const expectedReferrer = new PublicKey(this.config.referrerAddress!);
          const [expectedStake] = PublicKey.findProgramAddressSync(
            [Buffer.from('token_stake'), expectedReferrer.toBuffer()],
            this.poolConfig.programId,
          );
          // Referral account layout: 8 bytes discriminator, then referrer stake account (32 bytes)
          if (acctInfo.data.length >= 40) {
            const storedStake = new PublicKey(acctInfo.data.subarray(8, 40));
            if (!storedStake.equals(expectedStake)) {
              logger.warn(
                'REFERRAL',
                `Referral PDA exists but is linked to wrong referrer. ` +
                `Expected ${expectedStake.toBase58().slice(0, 8)}... but found ${storedStake.toBase58().slice(0, 8)}... ` +
                `This user's referral cannot be updated on-chain. Contact Flash Trade support.`,
              );
            } else {
              logger.info('REFERRAL', 'Referral PDA verified — correctly linked to configured referrer.');
            }
          }
        } catch {
          // Best-effort verification — don't block trading
        }
      }
    } catch {
      // RPC failure — keep referral params, let the trade attempt decide
      logger.info('REFERRAL', 'Could not verify referral PDA on-chain (RPC error). Will attempt with referral.');
    }
  }

  /**
   * Silently create the user's on-chain referral account.
   * Called automatically before the first trade if the PDA doesn't exist.
   */
  private async autoCreateReferralAccount(referralPDA: PublicKey): Promise<void> {
    const logger = getLogger();
    try {
      const userPk = this.wallet.publicKey;
      const programId = this.poolConfig.programId;

      // Ensure the USER's token stake account exists (required by addReferral)
      const [userTokenStakeAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from('token_stake'), userPk.toBuffer()],
        programId,
      );

      const stakeAcctInfo = await this.connection.getAccountInfo(userTokenStakeAccount);
      if (!stakeAcctInfo) {
        logger.info('REFERRAL', 'Creating user token stake account for referral setup...');
        const depositResult = await this.perpClient.depositTokenStake(userPk, userPk, BN_ZERO, this.poolConfig);
        await this.sendTx(depositResult.instructions, depositResult.additionalSigners, this.poolConfig);
      }

      // Derive the REFERRER's token stake account — this links the user to the referrer on-chain
      const referrerPk = new PublicKey(this.config.referrerAddress!);
      const [referrerTokenStakeAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from('token_stake'), referrerPk.toBuffer()],
        programId,
      );

      // Create the referral link: associates user's referral PDA with the referrer's stake account
      const result = await this.perpClient.addReferral(referrerTokenStakeAccount, referralPDA);
      await this.sendTx(result.instructions, result.additionalSigners, this.poolConfig);

      logger.info('REFERRAL', `Referral account created: ${referralPDA.toBase58().slice(0, 8)}...`);
    } catch (err: unknown) {
      // Non-fatal — trade can still proceed without referral
      logger.info('REFERRAL', `Auto-create referral failed: ${getErrorMessage(err)}. Falling back to no referral.`);
      this.referralParams = null;
    }
  }

  /** Clear cached referral params (e.g. on wallet switch) */
  clearReferralCache(): void {
    this.referralParams = null;
    this.referralChecked = false;
  }

  // ─── Pool Management ──────────────────────────────────────────────────────

  private getPoolConfigForMarket(market: string): PoolConfig {
    const poolName = getPoolForMarket(market);
    if (!poolName) throw new Error(`Unknown market: ${market}`);
    // Check if pool is tradeable (SDK supports it)
    if (!isTradeablePool(poolName)) {
      throw new Error(
        `${market} (${poolName}) is not yet available for trading. The pool exists in the protocol config but the SDK doesn't support it yet. Check for flash-sdk updates.`,
      );
    }
    if (poolName !== this.poolConfig.poolName) {
      const pc = PoolConfig.fromIdsByName(poolName, this.config.network);
      // Register this pool's program IDs in the instance whitelist
      this.allowedPrograms.add(pc.programId.toBase58());
      if (pc.perpComposibilityProgramId) this.allowedPrograms.add(pc.perpComposibilityProgramId.toBase58());
      if (pc.fbNftRewardProgramId) this.allowedPrograms.add(pc.fbNftRewardProgramId.toBase58());
      if (pc.rewardDistributionProgram?.programId)
        this.allowedPrograms.add(pc.rewardDistributionProgram.programId.toBase58());
      ALLOWED_PROGRAM_IDS = this.allowedPrograms;
      return pc;
    }
    return this.poolConfig;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async getPriceMap(poolConfig: PoolConfig): Promise<Map<string, LiveTokenPrice>> {
    const tokens = (poolConfig.tokens as Array<{ symbol: string; pythTicker: string }>).map((t) => ({
      symbol: t.symbol,
      pythTicker: t.pythTicker,
    }));
    const priceMap = await this.priceService.getPrices(tokens);

    // Fallback: for any token missing from Pyth, read on-chain internal oracle (Lazer).
    // Virtual markets (NATGAS, etc.) may only have Lazer oracles without traditional Pyth feeds.
    const custodies = poolConfig.custodies as Array<{
      symbol: string;
      intOracleAccount: PublicKey;
      isVirtual?: boolean;
    }>;
    for (const custody of custodies) {
      if (priceMap.has(custody.symbol)) continue; // already have price
      if (['USDC', 'WSOL'].includes(custody.symbol)) continue;
      if (!custody.intOracleAccount) continue;
      try {
        const info = await this.connection.getAccountInfo(custody.intOracleAccount);
        if (!info || info.data.length < 28) continue;
        const rawPrice = info.data.readBigInt64LE(8);
        const exponent = info.data.readInt32LE(16);
        const uiPrice = Number(rawPrice) * Math.pow(10, exponent);
        if (!Number.isFinite(uiPrice) || uiPrice <= 0) continue;
        const oraclePrice = new OraclePrice({
          price: new BN(rawPrice.toString()),
          exponent: new BN(exponent.toString()),
          confidence: new BN(info.data.readBigUInt64LE(20).toString()),
          timestamp: new BN(Math.floor(Date.now() / 1000).toString()),
        });
        priceMap.set(custody.symbol, { price: oraclePrice, emaPrice: oraclePrice, uiPrice, timestamp: Date.now() });
        getLogger().info('PRICE', `${custody.symbol}: on-chain oracle $${uiPrice.toFixed(4)}`);
      } catch (err) {
        getLogger().debug('PRICE', `${custody.symbol}: internal oracle read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return priceMap;
  }

  private findToken(poolConfig: PoolConfig, symbol: string) {
    const tokens = poolConfig.tokens as Array<{
      symbol: string;
      mintKey: PublicKey;
      decimals: number;
      pythTicker: string;
    }>;
    const token = tokens.find((t) => t.symbol === symbol);
    if (!token) throw new Error(`Token ${symbol} not found in pool`);
    return token;
  }

  /**
   * Resolve a token symbol from its mint address within the pool.
   * Used to determine a position's actual collateral token.
   */
  private resolveTokenSymbol(poolConfig: PoolConfig, mint: PublicKey): string {
    const tokens = poolConfig.tokens as Array<{ symbol: string; mintKey: PublicKey }>;
    const token = tokens.find((t) => t.mintKey.equals(mint));
    if (!token) throw new Error(`Token with mint ${mint.toBase58()} not found in pool`);
    return token.symbol;
  }

  private findCustody(poolConfig: PoolConfig, symbol: string) {
    const custodies = poolConfig.custodies as Array<{ symbol: string; custodyAccount: PublicKey }>;
    const custody = custodies.find((c) => c.symbol === symbol);
    if (!custody) throw new Error(`Custody for ${symbol} not found`);
    return custody;
  }

  private async findUserPosition(
    poolConfig: PoolConfig,
    market: string,
    side: TradeSide,
  ): Promise<{
    position: { pubkey: PublicKey; market: PublicKey };
    marketConfig: {
      marketAccount: PublicKey;
      targetMint: PublicKey;
      collateralMint: PublicKey;
      side: typeof Side.Long | typeof Side.Short;
    };
  }> {
    const sdkSide = toSdkSide(side);
    const positions = await this.perpClient.getUserPositions(this.wallet.publicKey, poolConfig);
    const token = this.findToken(poolConfig, market);
    const markets = getTypedMarkets(poolConfig);

    const marketConfig = markets.find((m) => m.targetMint.equals(token.mintKey) && m.side === sdkSide);
    if (!marketConfig) throw new Error(`Market config for ${market} ${side} not found`);

    const position = (positions as Array<{ pubkey: PublicKey; market: PublicKey }>).find((p) =>
      p.market.equals(marketConfig.marketAccount),
    );
    if (!position) throw new Error(`No open ${side} position on ${market}`);

    return { position, marketConfig };
  }

  /**
   * Check if a signature is already confirmed on-chain.
   * Used to prevent false failure reports when simulation disagrees with actual state.
   */
  private async isSignatureConfirmed(signature: string): Promise<boolean> {
    try {
      const { value } = await this.connection.getSignatureStatuses([signature]);
      const status = value?.[0];
      if (status?.err) return false;
      return status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized';
    } catch {
      return false;
    }
  }

  /**
   * Send a transaction with up to 3 attempts.
   * Each attempt gets a fresh blockhash and re-signs via the SDK.
   * Program errors (from simulation) are thrown immediately without retrying.
   * Before each retry, checks if the previous attempt's tx landed late
   * to prevent duplicate collateral operations.
   */
  private async sendTx(
    instructions: TransactionInstruction[],
    additionalSigners: Signer[],
    poolConfig: PoolConfig,
    addressLookupTableAccounts?: AddressLookupTableAccount[],
    computeUnitLimitOverride?: number,
  ): Promise<string> {
    const logger = getLogger();

    // Pre-signing safety: verify keypair is still valid (not zeroed/disconnected)
    if (!this.walletMgr.verifyKeypairIntegrity()) {
      throw new Error('Wallet keypair is invalid or disconnected. Reconnect your wallet before signing.');
    }

    // ── Instruction Validation ──
    // Validate ALL instructions target approved programs BEFORE any signing attempt.
    // This is the critical security gate — if any instruction targets an unknown program,
    // the transaction is rejected immediately.
    validateInstructionPrograms(instructions, 'sendTx');

    // Freeze the instruction array to prevent mutation after validation.
    // Any attempt to push/splice instructions after this point will throw.
    const validatedInstructions = Object.freeze([...instructions]);

    // ── Resolve ALTs if not provided ──
    // Flash SDK requires ALTs for all transactions (compresses account refs 32→1 byte).
    // Auto-resolve from pool config when caller doesn't provide them.
    let altAccounts = addressLookupTableAccounts;
    if (!altAccounts) {
      try {
        altAccounts = await resolveALTs(this.perpClient, poolConfig);
      } catch {
        altAccounts = [];
      }
    }

    // ── ALT diagnostics (first attempt only, debug level) ──
    if (altAccounts.length > 0) {
      const overlap = verifyALTAccountOverlap(instructions, altAccounts);
      if (overlap.compressible > 0) {
        logger.debug(
          'ALT',
          `TX accounts: ${overlap.totalAccounts}, compressible via ALT: ${overlap.compressible} (${(overlap.compressionRatio * 100).toFixed(0)}%)`,
        );
      } else {
        logger.debug(
          'ALT',
          `TX has ${overlap.totalAccounts} accounts but 0 overlap with ALT — tables will have no effect`,
        );
      }
    }

    // ── Dynamic CU limit scaling ──
    // Base: 220k CU (observed usage: 104–112k). If instructions > 4 (e.g. TP/SL
    // attached), add 30k headroom. Never exceed 600k. Explicit overrides take precedence.
    const dynamicCuLimit =
      computeUnitLimitOverride ??
      (instructions.length > 4
        ? Math.min(this.config.computeUnitLimit + 30_000, 600_000)
        : this.config.computeUnitLimit);

    // ── Route through Ultra-TX Engine when available ──
    const txEngine = getUltraTxEngine();
    if (txEngine) {
      const result = await txEngine.submitTransaction(
        [...validatedInstructions],
        additionalSigners,
        altAccounts,
        dynamicCuLimit,
      );
      logger.info(
        'CLIENT',
        `Ultra-TX: ${result.signature} (${result.metrics.totalLatencyMs}ms, ${result.metrics.confirmedViaWs ? 'WS' : 'HTTP'}, ${result.broadcastEndpoints} endpoints)`,
      );
      // Reset session idle timer on successful trade
      this.walletMgr.resetIdleTimer();
      // Invalidate balance cache — balances changed after trade
      this.walletMgr.clearBalanceCache();
      return result.signature;
    }

    const maxAttempts = 3;
    // CU overflow fallback: 220k → 260k if simulation detects ComputeBudgetExceeded
    const CU_OVERFLOW_BUMP = 260_000;
    let effectiveCuLimit = dynamicCuLimit;
    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.computeUnitPrice });

    let lastError = '';
    let lastSignature = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Capture connection at start of attempt — use this reference for the ENTIRE
      // attempt (send + confirm loop). If a background failover swaps this.connection
      // mid-poll, the captured reference keeps polling the RPC that actually received
      // the transaction, preventing false timeouts and duplicate submissions.
      const conn = this.connection;

      // Before retrying, check if the PREVIOUS attempt's tx landed late.
      // This prevents duplicate collateral additions/removals where the program
      // has no built-in dedup (unlike openPosition which rejects duplicates).
      if (attempt > 1 && lastSignature) {
        try {
          const confirmed = await this.isSignatureConfirmed(lastSignature);
          if (confirmed) {
            process.stdout.write('                              \r');
            logger.info('CLIENT', `Previous tx confirmed (late detection before retry): ${lastSignature}`);
            return lastSignature;
          }
        } catch {
          // Best-effort — proceed with retry if check fails
        }
      }

      if (attempt === 1) {
        process.stdout.write('  Sending transaction...   \r');
      } else {
        process.stdout.write(`  Retry ${attempt}/${maxAttempts} (fresh blockhash)...\r`);
        logger.info('CLIENT', `Retry attempt ${attempt}/${maxAttempts}`);
      }

      try {
        // Use pre-cached blockhash when available (0ms latency vs ~200-500ms RPC call).
        // On retries, always fetch fresh to avoid using a near-expiry blockhash.
        const { blockhash, fetchLatencyMs: bhLatency } =
          attempt === 1
            ? await this.getBlockhash(conn)
            : await (async () => {
                const start = Date.now();
                const result = await conn.getLatestBlockhash('confirmed');
                return {
                  blockhash: result.blockhash,
                  lastValidBlockHeight: result.lastValidBlockHeight,
                  fetchLatencyMs: Date.now() - start,
                };
              })();
        if (bhLatency > 10_000) {
          logger.info('CLIENT', `Blockhash fetch took ${(bhLatency / 1000).toFixed(1)}s — confirmation window reduced`);
        }
        // [L-10] Reduce confirmation timeout when blockhash fetch was slow to avoid expiry
        const timeoutMs = 45_000;
        const effectiveTimeoutMs = bhLatency > 5_000 ? Math.max(timeoutMs - bhLatency, 20_000) : timeoutMs;
        // Build compute budget instructions (may change on CU overflow retry)
        const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: effectiveCuLimit });
        // Ed25519 signature verification instructions (e.g. backup oracle) must appear
        // BEFORE compute budget instructions — the on-chain program reads ixSysvar
        // and expects Ed25519 at a low index.
        const ed25519Ixs = validatedInstructions.filter((ix) => ix.programId.toBase58() === ED25519_PROGRAM);
        const nonEd25519Ixs = validatedInstructions.filter((ix) => ix.programId.toBase58() !== ED25519_PROGRAM);
        const allIxs = [...ed25519Ixs, cuLimitIx, cuPriceIx, ...nonEd25519Ixs];
        const message = MessageV0.compile({
          payerKey: this.wallet.publicKey,
          instructions: allIxs,
          recentBlockhash: blockhash,
          addressLookupTableAccounts: altAccounts ?? [],
        });

        // Log transaction assembly diagnostics on first attempt
        if (attempt === 1) {
          const txSize = new VersionedTransaction(message).serialize().length;
          const altLookups = message.addressTableLookups ?? [];
          const altLookupCount = altLookups.reduce(
            (sum, l) => sum + l.readonlyIndexes.length + l.writableIndexes.length,
            0,
          );
          logger.info(
            'TX',
            `Size: ${txSize}b | ALT: ${altLookups.length > 0 ? `${altLookups.length} table(s), ${altLookupCount} accounts` : 'none'} | Static: ${message.staticAccountKeys.length} | CU: ${effectiveCuLimit} | Fee: ${this.config.computeUnitPrice} µL | IXs: ${allIxs.length}`,
          );
          logMessageALTDiagnostics(message, 'sendTx');
        }

        const vtx = new VersionedTransaction(message);
        vtx.sign([this.wallet, ...additionalSigners]);

        // Pre-send simulation on first attempt to catch program errors early.
        // Also extracts unitsConsumed for dynamic CU optimization.
        // Subsequent retries skip simulation since the blockhash changes.
        let simUnitsConsumed: number | null = null;
        if (attempt === 1) {
          try {
            const simResult = await conn.simulateTransaction(vtx, {
              sigVerify: false,
              replaceRecentBlockhash: true,
            });
            if (simResult.value.err) {
              const simErr = JSON.stringify(simResult.value.err);

              // Compute budget exceeded — bump CU limit and retry immediately
              if (simErr.includes('ComputationalBudgetExceeded') || simErr.includes('ProgramFailedToComplete')) {
                if (effectiveCuLimit < CU_OVERFLOW_BUMP) {
                  logger.info(
                    'CLIENT',
                    `Compute budget exceeded at ${effectiveCuLimit} CU — retrying with ${CU_OVERFLOW_BUMP} CU`,
                  );
                  effectiveCuLimit = CU_OVERFLOW_BUMP;
                  continue; // Rebuild tx with higher CU limit
                }
              }

              // Program errors (InstructionError) are terminal — don't retry
              if (simErr.includes('InstructionError') || simErr.includes('Custom')) {
                throw new Error(mapProgramError(simErr));
              }
              logger.info('CLIENT', `Pre-send simulation warning: ${simErr}`);
            } else {
              // Successful simulation — extract CU usage for dynamic optimization
              simUnitsConsumed = simResult.value.unitsConsumed ?? null;
            }
          } catch (simError: unknown) {
            const simMsg = getErrorMessage(simError);
            // Re-throw program errors (from mapProgramError) and simulation failures
            if (
              simMsg.includes('simulation failed') ||
              simMsg.includes('Trade rejected') ||
              simMsg.includes('Transaction rejected')
            )
              throw simError;
            // Non-critical simulation failures (RPC timeout etc) — proceed with send
            logger.debug('CLIENT', `Pre-send simulation skipped: ${scrubSensitive(simMsg)}`);
          }
        }

        // ── Dynamic CU optimization ──
        // If simulation succeeded and dynamic compute is enabled, tighten the CU
        // limit to unitsConsumed * (1 + buffer%). This reduces priority fees by
        // only paying for compute actually used + safety headroom.
        // Rebuilds tx with the tighter limit — no additional RPC call.
        if (simUnitsConsumed && simUnitsConsumed > 0 && this.config.dynamicCompute !== false) {
          const bufferPct = this.config.computeBufferPercent ?? 20;
          const rawLimit = Math.ceil((simUnitsConsumed * (1 + bufferPct / 100)) / 10_000) * 10_000;
          // Safety clamp: never below 120k (floor) or above configured limit
          const dynamicLimit = Math.max(120_000, Math.min(rawLimit, effectiveCuLimit));
          // Only tighten — never exceed the configured limit (safety ceiling)
          if (dynamicLimit < effectiveCuLimit && dynamicLimit >= simUnitsConsumed) {
            logger.debug(
              'CLIENT',
              `Dynamic CU: ${simUnitsConsumed} used → ${dynamicLimit} limit (was ${effectiveCuLimit})`,
            );
            effectiveCuLimit = dynamicLimit;
            // Rebuild transaction with tighter CU limit (no extra RPC call)
            const tightCuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: effectiveCuLimit });
            const tightIxs = [tightCuLimitIx, cuPriceIx, ...validatedInstructions];
            const tightMessage = MessageV0.compile({
              payerKey: this.wallet.publicKey,
              instructions: tightIxs,
              recentBlockhash: blockhash,
              addressLookupTableAccounts: altAccounts ?? [],
            });
            const tightVtx = new VersionedTransaction(tightMessage);
            tightVtx.sign([this.wallet, ...additionalSigners]);
            const tightBytes = Buffer.from(tightVtx.serialize());

            const signatureStr = await conn.sendRawTransaction(tightBytes, {
              skipPreflight: true,
              maxRetries: 3,
            });
            lastSignature = signatureStr;
            const feeEstimate = Math.floor((effectiveCuLimit * this.config.computeUnitPrice) / 1_000_000);
            logger.info(
              'CLIENT',
              `Tx sent (dynamic CU): ${signatureStr} | CU: ${simUnitsConsumed}→${effectiveCuLimit} | Fee: ~${feeEstimate} lamports`,
            );

            // Skip to confirmation polling (jump past the normal sendRawTransaction)
            // We need to inline the confirmation here to avoid restructuring the entire loop
            process.stdout.write('  Awaiting confirmation... \r');
            const confirmStart = Date.now();
            for (let i = 0; Date.now() - confirmStart < effectiveTimeoutMs; i++) {
              await new Promise((r) => setTimeout(r, 2_000));
              const { value } = await conn.getSignatureStatuses([signatureStr]);
              const status = value?.[0];
              if (status?.err) {
                throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
              }
              if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
                process.stdout.write('                              \r');
                logger.info('CLIENT', `Tx confirmed: ${signatureStr}`);
                this.walletMgr.resetIdleTimer();
                this.walletMgr.clearBalanceCache();
                return signatureStr;
              }
              if (i % 2 === 0) {
                conn.sendRawTransaction(tightBytes, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
              }
            }
            // Dynamic CU tx timed out — fall through to normal retry logic
            lastError = `Dynamic CU tx not confirmed within ${effectiveTimeoutMs / 1000}s`;
            logger.warn('CLIENT', `Dynamic CU attempt timed out — will retry with standard flow`);
            continue;
          }
        }

        const txBytes = Buffer.from(vtx.serialize());

        const signatureStr = await conn.sendRawTransaction(txBytes, {
          skipPreflight: true,
          maxRetries: 3,
        });
        lastSignature = signatureStr;
        logger.info('CLIENT', `Tx sent: ${signatureStr} (${txBytes.length} bytes, attempt ${attempt})`);

        // Poll for confirmation with periodic resends
        // Uses the same `conn` that sent the transaction — never switches mid-poll.
        process.stdout.write('  Awaiting confirmation... \r');
        const start = Date.now();
        const pollTimeoutMs = effectiveTimeoutMs;
        for (let i = 0; Date.now() - start < pollTimeoutMs; i++) {
          await new Promise((r) => setTimeout(r, 2_000));
          const { value } = await conn.getSignatureStatuses([signatureStr]);
          const status = value?.[0];
          if (status?.err) {
            throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
          }
          if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
            process.stdout.write('                              \r');
            logger.info('CLIENT', `Tx confirmed: ${signatureStr}`);
            // [H-3] Reset session idle timer on successful trade
            this.walletMgr.resetIdleTimer();
            // Invalidate balance cache — balances changed after trade
            this.walletMgr.clearBalanceCache();
            return signatureStr;
          }
          // Resend every other poll to improve delivery
          if (i % 2 === 0) {
            conn.sendRawTransaction(txBytes, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
          }
        }

        // Before declaring timeout, do one final status check using the SAME
        // connection that sent the tx. The tx may have landed between the last
        // poll and now. This prevents duplicate submissions.
        try {
          const { value: finalValue } = await conn.getSignatureStatuses([signatureStr]);
          const finalStatus = finalValue?.[0];
          if (
            finalStatus &&
            !finalStatus.err &&
            (finalStatus.confirmationStatus === 'confirmed' || finalStatus.confirmationStatus === 'finalized')
          ) {
            process.stdout.write('                              \r');
            logger.info('CLIENT', `Tx confirmed (late detection): ${signatureStr}`);
            this.walletMgr.clearBalanceCache();
            return signatureStr;
          }
        } catch {
          // Final check is best-effort — if it fails we proceed to retry
        }

        lastError = `Not confirmed within ${timeoutMs / 1000}s`;
        logger.warn('CLIENT', `Attempt ${attempt} timed out — ${lastError}`);
      } catch (e: unknown) {
        const eMsg = getErrorMessage(e);
        if (eMsg.includes('failed on-chain')) {
          process.stdout.write('                              \r');
          throw e;
        }
        lastError = eMsg;
        logger.warn('CLIENT', `Attempt ${attempt} failed: ${scrubSensitive(eMsg)}`);

        // On network-level failures, attempt RPC failover before next retry.
        // Uses force=true to bypass cooldown — explicit trade failures warrant
        // immediate failover regardless of the background monitor's cooldown.
        if (attempt < maxAttempts && isNetworkError(eMsg)) {
          const rpcMgr = getRpcManagerInstance();
          if (rpcMgr && rpcMgr.fallbackCount > 0) {
            logger.info('CLIENT', 'Network error detected — attempting RPC failover before retry');
            rpcMgr.recordResult(false);
            const didFailover = await rpcMgr.failover(true);
            if (didFailover) {
              // replaceConnection is called via the onConnectionChange callback.
              // Next iteration captures the new this.connection via `const conn = this.connection`.
              logger.info('CLIENT', `Switched to ${rpcMgr.activeEndpoint.label} — retrying`);
            }
          }
        }
      }
    }

    process.stdout.write('                              \r');
    throw new Error(
      `Transaction failed after ${maxAttempts} attempts.\n` +
        `  Last error: ${lastError}\n` +
        (lastSignature ? `  Last signature: ${lastSignature}\n  Check https://solscan.io/tx/${lastSignature}` : ''),
    );
  }

  // ─── Trade Mutex ──────────────────────────────────────────────────────────

  private acquireTradeLock(market: string, side: TradeSide): void {
    const key = `${market}:${side}`;
    if (this.activeTrades.has(key)) {
      throw new Error(`A ${side} trade on ${market} is already in progress. Wait for it to complete.`);
    }
    this.activeTrades.add(key);
    getLeaderRouter()?.setActiveTrading(true);
  }

  private releaseTradeLock(market: string, side: TradeSide): void {
    this.activeTrades.delete(`${market}:${side}`);
    // Only restore polling when ALL trade locks are released
    if (this.activeTrades.size === 0) {
      getLeaderRouter()?.setActiveTrading(false);
    }
  }

  // ─── Recent Trade Cache ──────────────────────────────────────────────────


  // ─── Open Position ────────────────────────────────────────────────────────

  async openPosition(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
    collateralToken?: string,
  ): Promise<OpenPositionResult> {
    const logger = getLogger();

    // Validate referral PDA exists on-chain (one-time, before first trade)
    await this.validateReferralOnChain();

    // Pre-trade validation (synchronous checks before locking)
    this.validateLeverage(market, leverage);
    const sideStr = side === TradeSide.Long ? 'long' : 'short';
    if (collateralAmount < 10) {
      throw new Error(
        `Minimum collateral is $10 (got $${collateralAmount}).\n` + `  Try: open ${leverage}x ${sideStr} ${market} $10`,
      );
    }

    // Acquire trade lock BEFORE any async operations to prevent interleaving
    this.acquireTradeLock(market, side);
    try {
      // ── Parallel pre-trade validation ──
      // Run SOL fee check and USDC balance check concurrently.
      // These are independent RPC calls that previously ran sequentially (~600-1500ms total).
      const poolConfig = this.getPoolConfigForMarket(market);
      const inputSymbol = collateralToken ?? DEFAULT_COLLATERAL_TOKEN;
      const sdkSide = toSdkSide(side);

      const [, , priceMap] = await Promise.all([
        // 1. SOL fee check
        this.ensureSufficientSol(),

        // 2. USDC balance check
        (async () => {
          // USDC balance check
          if (inputSymbol === 'USDC') {
            try {
              const balances = await this.walletMgr.getTokenBalances();
              const usdcBalance = balances.tokens.find((t) => t.symbol === 'USDC')?.amount ?? 0;
              if (usdcBalance < collateralAmount) {
                throw new Error(
                  `Insufficient USDC collateral.\n` +
                    `  Required: $${collateralAmount.toFixed(2)}\n` +
                    `  Available: $${usdcBalance.toFixed(2)}\n` +
                    `  Deposit USDC to trade on Flash Trade.`,
                );
              }
            } catch (e: unknown) {
              const eMsg = getErrorMessage(e);
              if (eMsg.includes('Insufficient USDC')) throw e;
              logger.info('CLIENT', `USDC balance check skipped (RPC error): ${scrubSensitive(eMsg)}`);
            }
          }

          // Note: no duplicate position check — Flash Trade protocol allows
          // increasing position size by opening additional same-side trades.
          // The protocol merges them into a single position with recalculated
          // weighted entry price.
        })(),

        // 3. Price map fetch (runs concurrently with validation checks)
        this.getPriceMap(poolConfig),
      ]);

      const targetToken = this.findToken(poolConfig, market);
      const collateralSymbol = collateralToken ?? DEFAULT_COLLATERAL_TOKEN;
      const inputToken = this.findToken(poolConfig, collateralSymbol);

      logger.info('TRADE', 'Trade Request', {
        market,
        side,
        collateralToken: inputToken.symbol,
        collateralAmount,
        leverage,
        size: collateralAmount * leverage,
      });
      const targetPrice = priceMap.get(targetToken.symbol);
      const inputPrice = priceMap.get(inputToken.symbol);
      if (!targetPrice) throw new Error(`Oracle unavailable for ${targetToken.symbol}. Try again later.`);
      if (!inputPrice) throw new Error(`Oracle unavailable for ${inputToken.symbol}. Try again later.`);

      const priceAfterSlippage = this.perpClient.getPriceAfterSlippage(
        true,
        new BN(this.config.defaultSlippageBps),
        targetPrice.price,
        sdkSide,
      );

      const collateralNative = uiDecimalsToNative(collateralAmount.toString(), inputToken.decimals);
      const inputCustody = this.findCustody(poolConfig, inputToken.symbol);
      const outputCustody = this.findCustody(poolConfig, targetToken.symbol);

      const custodyAccounts = await withRetry(
        () =>
          this.perpClient.program.account.custody.fetchMultiple([
            inputCustody.custodyAccount,
            outputCustody.custodyAccount,
          ]),
        'custody-fetch',
        { maxAttempts: 2 },
      );

      if (!custodyAccounts[0] || !custodyAccounts[1]) {
        throw new Error('Failed to fetch custody accounts from chain');
      }

      const sizeAmount = this.perpClient.getSizeAmountFromLeverageAndCollateral(
        collateralNative,
        leverage.toString(),
        targetToken as unknown as Token,
        inputToken as unknown as Token,
        sdkSide,
        targetPrice.price,
        targetPrice.emaPrice,
        CustodyAccount.from(outputCustody.custodyAccount, custodyAccounts[1]),
        inputPrice.price,
        inputPrice.emaPrice,
        CustodyAccount.from(inputCustody.custodyAccount, custodyAccounts[0]),
        BN_ZERO,
      );

      // ── Determine the correct collateral token for this market+side ──
      // The on-chain market PDA is derived from (targetCustody, collateralCustody, side).
      // For non-virtual tokens (JUP, JTO, RAY, HYPE): long collateral = self, short collateral = USDC
      // For virtual tokens (PYTH, KMNO, MET): long collateral = JUP, short collateral = USDC
      // We MUST look this up from poolConfig.markets rather than assuming collateral = target.
      const poolMarkets = getTypedMarkets(poolConfig);
      const matchedMarket = poolMarkets.find((m) => m.targetMint.equals(targetToken.mintKey) && m.side === sdkSide);
      let marketCollateralSymbol: string;
      if (matchedMarket) {
        marketCollateralSymbol = this.resolveTokenSymbol(poolConfig, matchedMarket.collateralMint);
      } else {
        // Fallback: assume collateral = target (works for standard markets)
        logger.info('TRADE', `No market config found for ${market}/${sideStr}, assuming collateral = target`);
        marketCollateralSymbol = targetToken.symbol;
      }

      logger.debug(
        'TRADE',
        `Instruction routing: market=${market} side=${sideStr} ` +
          `inputToken=${inputToken.symbol} marketCollateral=${marketCollateralSymbol}`,
      );

      // ── Check if a position already exists → use increaseSize instead of openPosition ──
      // Flash Trade protocol rejects openPosition when a same-market same-side position exists.
      // In that case, use increaseSize to merge into the existing position.
      let existingPositionPubkey: PublicKey | null = null;
      try {
        const { position } = await this.findUserPosition(poolConfig, market, side);
        existingPositionPubkey = position.pubkey;
        logger.info('TRADE', `Existing ${sideStr} position found on ${market} — will increaseSize`);
      } catch {
        // No existing position — will open new
      }

      const ref = this.getReferralParams();
      const privilege = ref?.privilege ?? Privilege.None;
      const stakeAcct = ref?.tokenStakeAccount;
      const refAcct = ref?.userReferralAccount;

      let result: { instructions: TransactionInstruction[]; additionalSigners: Signer[] };
      if (existingPositionPubkey) {
        // Increase existing position size
        logger.debug(
          'TRADE',
          `Using increaseSize(${targetToken.symbol}, ${marketCollateralSymbol}, ${existingPositionPubkey.toBase58()})`,
        );
        result = await quietSdk(() =>
          this.perpClient.increaseSize(
            targetToken.symbol,
            marketCollateralSymbol,
            existingPositionPubkey!,
            sdkSide,
            poolConfig,
            priceAfterSlippage,
            sizeAmount,
            privilege,
            stakeAcct,
            refAcct,
          ),
        );
      } else if (inputToken.symbol === marketCollateralSymbol) {
        // User's input token matches the market's collateral custody → direct open
        logger.debug('TRADE', `Using openPosition(${targetToken.symbol}, ${marketCollateralSymbol})`);
        result = await quietSdk(() =>
          this.perpClient.openPosition(
            targetToken.symbol,
            marketCollateralSymbol,
            priceAfterSlippage,
            collateralNative,
            sizeAmount,
            sdkSide,
            poolConfig,
            privilege,
            stakeAcct,
            refAcct,
          ),
        );
      } else {
        // User's input token differs from market collateral → swap first
        logger.debug(
          'TRADE',
          `Using swapAndOpen(${targetToken.symbol}, ${marketCollateralSymbol}, ${inputToken.symbol})`,
        );
        result = await quietSdk(() =>
          this.perpClient.swapAndOpen(
            targetToken.symbol,
            marketCollateralSymbol,
            inputToken.symbol,
            collateralNative,
            priceAfterSlippage,
            sizeAmount,
            sdkSide,
            poolConfig,
            privilege,
            stakeAcct,
            refAcct,
          ),
        );
      }

      // Prepend ATA createIdempotent only for direct openPosition/increaseSize.
      // swapAndOpen manages its own intermediate token accounts internally —
      // prepending ATA for the target token causes IllegalOwner errors because
      // the SDK expects to set up the account itself.
      const isSwapAndOpen = inputToken.symbol !== marketCollateralSymbol && !existingPositionPubkey;
      let allInstructions: TransactionInstruction[];
      if (isSwapAndOpen) {
        // swapAndOpen handles ATA internally — don't prepend
        allInstructions = [...result.instructions];
      } else {
        // Direct open/increaseSize — prepend ATA for target token (matches website)
        const ataIxs = buildATAIdempotentIxs(this.wallet.publicKey, [targetToken.mintKey]);
        allInstructions = [...ataIxs, ...result.instructions];
      }

      // swapAndOpen does more work (swap + open in one ix) → needs higher CU
      // Force 420k minimum for swapAndOpen regardless of config (matches Flash UI)
      const cuOverride = isSwapAndOpen ? Math.max(this.config.computeUnitLimit, 420_000) : undefined;

      const txSignature = await this.sendTx(
        allInstructions,
        result.additionalSigners,
        poolConfig,
        undefined,
        cuOverride,
      );


      // Compute SDK-exact liquidation price for the return value
      let openLiqPrice = 0;
      try {
        const targetCustodyAcct = CustodyAccount.from(outputCustody.custodyAccount, custodyAccounts[1]);
        const openSizeUsd = targetPrice.price.getAssetAmountUsd(sizeAmount, targetToken.decimals);
        const openCollateralUsd = inputPrice.price.getAssetAmountUsd(collateralNative, inputToken.decimals);
        const liqResult = this.perpClient.getLiquidationPriceWithOrder(
          openCollateralUsd,
          sizeAmount,
          openSizeUsd,
          targetToken.decimals,
          targetPrice.price,
          sdkSide,
          targetCustodyAcct,
        );
        const liqUi = parseFloat(liqResult.toUiPrice(8));
        if (Number.isFinite(liqUi) && liqUi > 0) openLiqPrice = liqUi;

        // ── Protocol divergence check ──
        // Compare CLI formula against SDK result to detect math drift.
        // Reuses existing data — no extra RPC calls.
        if (openLiqPrice > 0) {
          try {
            const { computeSimulationLiquidationPrice, checkLiquidationDivergence } =
              await import('../utils/protocol-liq.js');
            const { getProtocolFeeRates } = await import('../utils/protocol-fees.js');
            const feeRates = await getProtocolFeeRates(market, this.perpClient);
            const sizeUsd = collateralAmount * leverage;
            const cliLiq = computeSimulationLiquidationPrice(
              targetPrice.uiPrice,
              sizeUsd,
              collateralAmount,
              side,
              feeRates.maintenanceMarginRate,
              feeRates.closeFeeRate,
            );
            if (cliLiq > 0) {
              await checkLiquidationDivergence(
                cliLiq,
                this.perpClient,
                targetPrice.price,
                BN_ZERO,
                sdkSide,
                targetCustodyAcct,
                null,
                market,
              );
            }
          } catch (divErr: unknown) {
            const divMsg = getErrorMessage(divErr);
            if (divMsg.includes('Protocol divergence exceeds')) throw divErr;
            logger.debug('DIVERGENCE', `Check skipped: ${divMsg}`);
          }
        }
      } catch (liqErr: unknown) {
        const liqMsg = getErrorMessage(liqErr);
        if (liqMsg.includes('Protocol divergence exceeds')) throw liqErr;
        // Non-critical: liquidation price is display-only
      }

      logger.trade('OPEN', {
        market,
        side,
        collateral: collateralAmount,
        leverage,
        price: targetPrice.uiPrice,
        tx: txSignature,
      });

      return {
        txSignature,
        entryPrice: targetPrice.uiPrice,
        liquidationPrice: openLiqPrice,
        sizeUsd: collateralAmount * leverage,
      };
    } finally {
      this.releaseTradeLock(market, side);
    }
  }

  // ─── Close Position ───────────────────────────────────────────────────────

  async closePosition(
    market: string,
    side: TradeSide,
    receiveToken?: string,
    closePercent?: number,
    closeAmount?: number,
  ): Promise<ClosePositionResult> {
    const logger = getLogger();



    this.acquireTradeLock(market, side);
    try {
      const poolConfig = this.getPoolConfigForMarket(market);
      const sdkSide = toSdkSide(side);
      const sideStr = side === TradeSide.Long ? 'long' : 'short';

      const targetToken = this.findToken(poolConfig, market);
      const receivingToken = receiveToken
        ? this.findToken(poolConfig, receiveToken)
        : this.findToken(poolConfig, DEFAULT_COLLATERAL_TOKEN);

      // Parallel: SOL check + price fetch
      const [, priceMap] = await Promise.all([this.ensureSufficientSol(), this.getPriceMap(poolConfig)]);
      const targetPrice = priceMap.get(targetToken.symbol);
      if (!targetPrice) throw new Error(`Oracle unavailable for ${targetToken.symbol}. Try again later.`);

      const priceAfterSlippage = this.perpClient.getPriceAfterSlippage(
        false,
        new BN(this.config.defaultSlippageBps),
        targetPrice.price,
        sdkSide,
      );

      // ── Determine the correct collateral token for this market+side ──
      const poolMarkets = getTypedMarkets(poolConfig);
      const matchedMarket = poolMarkets.find((m) => m.targetMint.equals(targetToken.mintKey) && m.side === sdkSide);
      let marketCollateralSymbol: string;
      if (matchedMarket) {
        marketCollateralSymbol = this.resolveTokenSymbol(poolConfig, matchedMarket.collateralMint);
      } else {
        logger.info('TRADE', `No market config found for ${market}/${sideStr}, assuming collateral = target`);
        marketCollateralSymbol = targetToken.symbol;
      }

      // ── Determine if this is a partial or full close ──
      const isPartial = (closePercent !== undefined && closePercent < 100) || closeAmount !== undefined;

      // Fetch position data for PnL computation and partial close sizing
      let positionSizeUsd = 0;
      let pnl = 0;
      const existingPositions = await this.getPositions();
      const pos = existingPositions.find((p) => p.market?.toUpperCase() === market.toUpperCase() && p.side === side);
      if (pos && pos.entryPrice > 0 && pos.sizeUsd > 0) {
        positionSizeUsd = pos.sizeUsd;
        const priceDelta = targetPrice.uiPrice - pos.entryPrice;
        const pnlMult = side === TradeSide.Long ? 1 : -1;
        pnl = (priceDelta / pos.entryPrice) * pos.sizeUsd * pnlMult;
        if (!Number.isFinite(pnl)) pnl = 0;
      }

      // Compute the USD amount to close and validate
      let closeSizeUsd = positionSizeUsd; // default: full close
      if (closePercent !== undefined && closePercent < 100) {
        closeSizeUsd = positionSizeUsd * (closePercent / 100);
      } else if (closeAmount !== undefined) {
        if (closeAmount > positionSizeUsd) {
          throw new Error(
            `Close amount $${closeAmount.toFixed(2)} exceeds position size $${positionSizeUsd.toFixed(2)}`,
          );
        }
        closeSizeUsd = closeAmount;
      }

      // If remaining size would be negligibly small (< $0.50), close entirely
      const remainingAfterClose = positionSizeUsd - closeSizeUsd;
      const shouldFullClose = !isPartial || remainingAfterClose < 0.5 || closeSizeUsd >= positionSizeUsd;

      // Scale PnL proportionally for partial close
      if (isPartial && !shouldFullClose && positionSizeUsd > 0) {
        pnl = pnl * (closeSizeUsd / positionSizeUsd);
        if (!Number.isFinite(pnl)) pnl = 0;
      }

      logger.debug(
        'TRADE',
        `Close routing: market=${market} side=${sideStr} ` +
          `partial=${isPartial} fullClose=${shouldFullClose} closeSizeUsd=${closeSizeUsd.toFixed(2)} ` +
          `receiveToken=${receivingToken.symbol} marketCollateral=${marketCollateralSymbol}`,
      );

      const ref = this.getReferralParams();
      const privilege = ref?.privilege ?? Privilege.None;
      const stakeAcct = ref?.tokenStakeAccount;
      const refAcct = ref?.userReferralAccount;

      let result: { instructions: TransactionInstruction[]; additionalSigners: Signer[] };

      if (shouldFullClose) {
        // ── Full close ──
        // Always close to the market's collateral token first.
        // closeAndSwap can fail with IllegalOwner on pools where collateral != USDC
        // (e.g., Governance.1 PYTH LONG uses JUP collateral).
        logger.debug('TRADE', `Using closePosition(${targetToken.symbol}, ${marketCollateralSymbol})`);
        result = await quietSdk(() =>
          this.perpClient.closePosition(
            targetToken.symbol,
            marketCollateralSymbol,
            priceAfterSlippage,
            sdkSide,
            poolConfig,
            privilege,
            stakeAcct,
            refAcct,
          ),
        );
      } else {
        // ── Partial close via decreaseSize ──
        const { position } = await this.findUserPosition(poolConfig, market, side);
        const positionData = await this.perpClient.program.account.position.fetch(position.pubkey);
        const posData = positionData as SdkPositionData;
        if (!posData.sizeAmount || posData.sizeAmount.isZero()) {
          throw new Error(`No open ${side} position on ${market} to partially close`);
        }

        // Compute sizeDelta in native token units proportional to closePercent/closeAmount
        let sizeDelta: BN;
        if (closePercent !== undefined) {
          // Scale native sizeAmount by percentage
          sizeDelta = posData.sizeAmount.mul(new BN(Math.round(closePercent * 100))).div(new BN(10000));
        } else {
          // Scale native sizeAmount by USD ratio
          const ratio = closeSizeUsd / positionSizeUsd;
          sizeDelta = posData.sizeAmount.mul(new BN(Math.round(ratio * 10000))).div(new BN(10000));
        }

        if (sizeDelta.isZero()) {
          throw new Error('Computed close size is too small');
        }

        logger.debug(
          'TRADE',
          `Using decreaseSize(${targetToken.symbol}, ${marketCollateralSymbol}, sizeDelta=${sizeDelta.toString()})`,
        );
        result = await quietSdk(() =>
          this.perpClient.decreaseSize(
            targetToken.symbol,
            marketCollateralSymbol,
            sdkSide,
            position.pubkey,
            poolConfig,
            priceAfterSlippage,
            sizeDelta,
            privilege,
            stakeAcct,
            refAcct,
          ),
        );
      }

      // ── ATA handling ──
      // The SDK's closePosition already manages ATA creation internally
      // (createAssociatedTokenAccountInstruction for the collateral token).
      // Prepending our own ATA instructions can cause IllegalOwner errors
      // on non-standard pools (e.g., Governance.1 PYTH LONG with JUP collateral).
      const ataIxs: TransactionInstruction[] = [];

      // ── Append cancel_all_trigger_orders on full close (matches website) ──
      // Website always cancels remaining trigger orders (TP/SL) when closing a position.
      let cancelIxs: TransactionInstruction[] = [];
      let cancelSigners: Signer[] = [];
      if (shouldFullClose) {
        try {
          const cancelResult = await this.perpClient.cancelAllTriggerOrders(
            targetToken.symbol,
            marketCollateralSymbol,
            sdkSide,
            poolConfig,
          );
          cancelIxs = cancelResult.instructions;
          cancelSigners = cancelResult.additionalSigners;
        } catch {
          // Non-critical — position may have no trigger orders
        }
      }

      // Assemble: ATA ixs → close ixs → cancel ixs
      const allCloseIxs = [...ataIxs, ...result.instructions, ...cancelIxs];
      const allSigners = [...result.additionalSigners, ...cancelSigners];

      // CU limit handled by dynamic scaling in sendTx (420k base, +30k if >4 instructions)
      const txSignature = await this.sendTx(allCloseIxs, allSigners, poolConfig);


      const closeAction = shouldFullClose ? 'CLOSE' : 'PARTIAL_CLOSE';
      logger.trade(closeAction, {
        market,
        side,
        price: targetPrice.uiPrice,
        pnl,
        closeSizeUsd: shouldFullClose ? positionSizeUsd : closeSizeUsd,
        tx: txSignature,
      });

      return {
        txSignature,
        exitPrice: targetPrice.uiPrice,
        pnl,
        isPartial: isPartial && !shouldFullClose,
        closedSizeUsd: shouldFullClose ? positionSizeUsd : closeSizeUsd,
        remainingSizeUsd: shouldFullClose ? 0 : remainingAfterClose,
      };
    } finally {
      this.releaseTradeLock(market, side);
    }
  }

  // ─── Collateral Management ────────────────────────────────────────────────

  async addCollateral(market: string, side: TradeSide, amount: number): Promise<CollateralResult> {


    this.acquireTradeLock(market, side);
    try {
      const poolConfig = this.getPoolConfigForMarket(market);
      // Parallel: SOL check + position lookup
      const [, { position, marketConfig }] = await Promise.all([
        this.ensureSufficientSol(),
        this.findUserPosition(poolConfig, market, side),
      ]);

      // Resolve position's actual collateral token from its collateralMint
      const collateralSymbol = this.resolveTokenSymbol(poolConfig, marketConfig.collateralMint);
      const inputToken = this.findToken(poolConfig, DEFAULT_COLLATERAL_TOKEN);
      const amountNative = uiDecimalsToNative(amount.toString(), inputToken.decimals);

      let result: { instructions: TransactionInstruction[]; additionalSigners: Signer[] };

      if (inputToken.symbol === collateralSymbol) {
        // Input matches position collateral — direct addCollateral
        result = await this.perpClient.addCollateral(
          amountNative,
          market,
          collateralSymbol,
          toSdkSide(side),
          position.pubkey,
          poolConfig,
        );
      } else {
        // Position collateral differs from input (e.g. position uses SOL, input is USDC)
        // Use swapAndAddCollateral to swap input into position's collateral token
        result = await this.perpClient.swapAndAddCollateral(
          market,
          inputToken.symbol,
          collateralSymbol,
          amountNative,
          toSdkSide(side),
          position.pubkey,
          poolConfig,
        );
      }

      const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

      getLogger().trade('ADD_COLLATERAL', { market, side, amount, collateralSymbol, tx: txSignature });
      return { txSignature };
    } finally {
      this.releaseTradeLock(market, side);
    }
  }

  async removeCollateral(market: string, side: TradeSide, amount: number): Promise<CollateralResult> {


    this.acquireTradeLock(market, side);
    try {
      const poolConfig = this.getPoolConfigForMarket(market);
      // Parallel: SOL check + position lookup
      const [, { position, marketConfig }] = await Promise.all([
        this.ensureSufficientSol(),
        this.findUserPosition(poolConfig, market, side),
      ]);

      // Resolve position's actual collateral token from its collateralMint
      const collateralSymbol = this.resolveTokenSymbol(poolConfig, marketConfig.collateralMint);
      const outputToken = this.findToken(poolConfig, DEFAULT_COLLATERAL_TOKEN);
      // removeCollateral uses USD amount (collateralDeltaUsd), so always 6 decimals
      const amountNative = uiDecimalsToNative(amount.toString(), 6);

      let result: { instructions: TransactionInstruction[]; additionalSigners: Signer[] };

      if (outputToken.symbol === collateralSymbol) {
        // Position collateral matches desired output — direct removeCollateral
        result = await this.perpClient.removeCollateral(
          amountNative,
          market,
          collateralSymbol,
          toSdkSide(side),
          position.pubkey,
          poolConfig,
        );
      } else {
        // Position collateral differs from desired output (e.g. collateral is SOL, want USDC)
        // Use removeCollateralAndSwap to withdraw and swap to output token
        result = await this.perpClient.removeCollateralAndSwap(
          market,
          collateralSymbol,
          outputToken.symbol,
          amountNative,
          toSdkSide(side),
          poolConfig,
        );
      }

      const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

      getLogger().trade('REMOVE_COLLATERAL', { market, side, amount, collateralSymbol, tx: txSignature });
      return { txSignature };
    } finally {
      this.releaseTradeLock(market, side);
    }
  }

  // ─── Dry Run / Transaction Preview ─────────────────────────────────────

  /**
   * Build a transaction preview without signing or sending.
   * Compiles the transaction, runs Solana simulation, and returns details.
   * SAFETY: No signing or sending occurs. The transaction is compiled and simulated only.
   */
  async previewOpenPosition(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
    collateralToken?: string,
  ): Promise<DryRunPreview> {
    const logger = getLogger();

    this.validateLeverage(market, leverage);
    if (collateralAmount < 10) {
      throw new Error(`Minimum collateral is $10 (got $${collateralAmount}).`);
    }

    const poolConfig = this.getPoolConfigForMarket(market);
    const sdkSide = toSdkSide(side);
    const targetToken = this.findToken(poolConfig, market);
    const collateralSymbol = collateralToken ?? DEFAULT_COLLATERAL_TOKEN;
    const inputToken = this.findToken(poolConfig, collateralSymbol);

    const priceMap = await this.getPriceMap(poolConfig);
    const targetPrice = priceMap.get(targetToken.symbol);
    const inputPrice = priceMap.get(inputToken.symbol);
    if (!targetPrice) throw new Error(`Oracle unavailable for ${targetToken.symbol}.`);
    if (!inputPrice) throw new Error(`Oracle unavailable for ${inputToken.symbol}.`);

    const priceAfterSlippage = this.perpClient.getPriceAfterSlippage(
      true,
      new BN(this.config.defaultSlippageBps),
      targetPrice.price,
      sdkSide,
    );

    const collateralNative = uiDecimalsToNative(collateralAmount.toString(), inputToken.decimals);
    const inputCustody = this.findCustody(poolConfig, inputToken.symbol);
    const outputCustody = this.findCustody(poolConfig, targetToken.symbol);

    const custodyAccounts = await withRetry(
      () =>
        this.perpClient.program.account.custody.fetchMultiple([
          inputCustody.custodyAccount,
          outputCustody.custodyAccount,
        ]),
      'custody-fetch-preview',
      { maxAttempts: 2 },
    );

    if (!custodyAccounts[0] || !custodyAccounts[1]) {
      throw new Error('Failed to fetch custody accounts from chain');
    }

    const sizeAmount = this.perpClient.getSizeAmountFromLeverageAndCollateral(
      collateralNative,
      leverage.toString(),
      targetToken as unknown as Token,
      inputToken as unknown as Token,
      sdkSide,
      targetPrice.price,
      targetPrice.emaPrice,
      CustodyAccount.from(outputCustody.custodyAccount, custodyAccounts[1]),
      inputPrice.price,
      inputPrice.emaPrice,
      CustodyAccount.from(inputCustody.custodyAccount, custodyAccounts[0]),
      BN_ZERO,
    );

    // ── Determine the correct collateral token for this market+side ──
    const poolMarkets = getTypedMarkets(poolConfig);
    const matchedMarket = poolMarkets.find((m) => m.targetMint.equals(targetToken.mintKey) && m.side === sdkSide);
    const marketCollateralSymbol = matchedMarket
      ? this.resolveTokenSymbol(poolConfig, matchedMarket.collateralMint)
      : targetToken.symbol;

    const ref = this.getReferralParams();
    const privilege = ref?.privilege ?? Privilege.None;
    const stakeAcct = ref?.tokenStakeAccount;
    const refAcct = ref?.userReferralAccount;

    let result: { instructions: TransactionInstruction[]; additionalSigners: Signer[] };
    if (inputToken.symbol === marketCollateralSymbol) {
      result = await this.perpClient.openPosition(
        targetToken.symbol,
        marketCollateralSymbol,
        priceAfterSlippage,
        collateralNative,
        sizeAmount,
        sdkSide,
        poolConfig,
        privilege,
        stakeAcct,
        refAcct,
      );
    } else {
      result = await this.perpClient.swapAndOpen(
        targetToken.symbol,
        marketCollateralSymbol,
        inputToken.symbol,
        collateralNative,
        priceAfterSlippage,
        sizeAmount,
        sdkSide,
        poolConfig,
        privilege,
        stakeAcct,
        refAcct,
      );
    }

    // Validate instructions target approved programs (even in preview)
    validateInstructionPrograms(result.instructions, 'dryrun');

    // Build the transaction WITHOUT signing
    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.computeUnitLimit });
    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.computeUnitPrice });
    const allIxs = [cuLimitIx, cuPriceIx, ...result.instructions];

    // Resolve ALTs for accurate size preview
    let previewALTs: AddressLookupTableAccount[] = [];
    try {
      previewALTs = await resolveALTs(this.perpClient, poolConfig);
    } catch {
      /* non-critical for preview */
    }

    const { blockhash } = await this.getBlockhash(this.connection);
    const message = MessageV0.compile({
      payerKey: this.wallet.publicKey,
      instructions: allIxs,
      recentBlockhash: blockhash,
      addressLookupTableAccounts: previewALTs,
    });
    const vtx = new VersionedTransaction(message);
    // DO NOT sign — this is a preview only
    const txBytes = Buffer.from(vtx.serialize());

    // Collect unique accounts from all instructions
    const accountSet = new Set<string>();
    for (const ix of allIxs) {
      accountSet.add(ix.programId.toBase58());
      for (const key of ix.keys) {
        accountSet.add(key.pubkey.toBase58());
      }
    }

    // Liquidation price — use SDK's exact protocol math
    const targetCustodyAcct = CustodyAccount.from(outputCustody.custodyAccount, custodyAccounts[1]);
    const sizeUsd = targetPrice.price.getAssetAmountUsd(sizeAmount, targetToken.decimals);
    const collateralUsd = inputPrice.price.getAssetAmountUsd(collateralNative, inputToken.decimals);
    let liqPrice = 0;
    try {
      const liqOraclePrice = this.perpClient.getLiquidationPriceWithOrder(
        collateralUsd,
        sizeAmount,
        sizeUsd,
        targetToken.decimals,
        targetPrice.price,
        sdkSide,
        targetCustodyAcct,
      );
      liqPrice = parseFloat(liqOraclePrice.toUiPrice(8));
      if (!Number.isFinite(liqPrice) || liqPrice < 0) liqPrice = 0;
    } catch {
      // Fallback: SDK call failed, use 0 rather than approximate
    }

    const preview: DryRunPreview = {
      market,
      side,
      collateral: collateralAmount,
      leverage,
      positionSize: collateralAmount * leverage,
      entryPrice: targetPrice.uiPrice,
      liquidationPrice: liqPrice,
      estimatedFee: (() => {
        try {
          const RATE_POWER = 1_000_000_000;
          const openFeeBps = parseFloat(targetCustodyAcct.fees.openPosition.toString()) / RATE_POWER;
          return collateralAmount * leverage * openFeeBps;
        } catch {
          return 0; // SDK fee unavailable
        }
      })(),
      programId: poolConfig.programId.toBase58(),
      accountCount: accountSet.size,
      instructionCount: allIxs.length,
      estimatedComputeUnits: this.config.computeUnitLimit,
      transactionSize: txBytes.length,
    };

    // Run Solana simulation (RPC simulateTransaction)
    try {
      // Sign for simulation only (required by simulateTransaction)
      const simVtx = new VersionedTransaction(message);
      simVtx.sign([this.wallet, ...result.additionalSigners]);

      const simResult = await this.connection.simulateTransaction(simVtx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });

      preview.simulationSuccess = !simResult.value.err;
      preview.simulationLogs = simResult.value.logs ?? [];
      preview.simulationUnitsConsumed = simResult.value.unitsConsumed ?? 0;
      if (simResult.value.err) {
        preview.simulationError = JSON.stringify(simResult.value.err);
      }
    } catch (e: unknown) {
      preview.simulationSuccess = false;
      preview.simulationError = getErrorMessage(e);
      logger.debug('DRYRUN', `Simulation failed: ${getErrorMessage(e)}`);
    }

    logger.info('DRYRUN', `Preview built for ${market} ${side} ${leverage}x $${collateralAmount}`);
    return preview;
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  async getPositions(): Promise<Position[]> {
    // Query ALL tradeable pools in parallel — not just the default pool.
    // Users may have positions across Crypto.1, Governance.1, Virtual.1, etc.
    const seen = new Set<string>();
    const uniquePools = POOL_NAMES.filter((name) => {
      if (seen.has(name) || !isTradeablePool(name)) return false;
      seen.add(name);
      return true;
    });

    const results = await Promise.allSettled(
      uniquePools.map(async (poolName) => {
        const positions: Position[] = [];
        await this.getPositionsForPool(poolName, positions);
        return positions;
      }),
    );

    const allPositions: Position[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allPositions.push(...result.value);
      }
    }
    return allPositions;
  }

  private async getPositionsForPool(poolName: string, positions: Position[]): Promise<void> {
    const poolConfig =
      poolName === this.poolConfig.poolName ? this.poolConfig : PoolConfig.fromIdsByName(poolName, this.config.network);

    const rawPositions = await this.perpClient.getUserPositions(this.wallet.publicKey, poolConfig);
    if (rawPositions.length === 0) return;

    const priceMap = await this.getPriceMap(poolConfig);
    const markets = getTypedMarkets(poolConfig);
    const tokens = poolConfig.tokens as Array<{ symbol: string; mintKey: PublicKey; decimals: number }>;
    const custodies = poolConfig.custodies as Array<{ custodyAccount: PublicKey; symbol: string }>;

    // Batch-fetch all custody accounts for SDK liquidation math
    const custodyKeys = custodies.map((c) => c.custodyAccount);
    const custodyAccountMap = new Map<string, CustodyAccount>();
    try {
      const custodyData = await this.perpClient.program.account.custody.fetchMultiple(custodyKeys);
      for (let i = 0; i < custodies.length; i++) {
        const cd = custodyData[i];
        if (cd) {
          custodyAccountMap.set(
            custodies[i].symbol,
            CustodyAccount.from(custodyKeys[i], cd as Parameters<typeof CustodyAccount.from>[1]),
          );
        }
      }
    } catch {
      getLogger().debug('CLIENT', `Custody fetch for ${poolName} failed, liq prices may be unavailable`);
    }

    for (const raw of rawPositions as unknown as Array<{
      pubkey: PublicKey;
      market: PublicKey;
      entryPrice?: { price: BN; exponent: number } | BN;
      sizeUsd?: BN;
      collateralUsd?: BN;
      openTime?: BN;
      unsettledFeesUsd?: BN;
      sizeAmount?: BN;
      sizeDecimals?: number;
      collateralDecimals?: number;
    }>) {
      try {
        const marketConfig = markets.find((m) => m.marketAccount.equals(raw.market));
        if (!marketConfig) continue;

        const targetToken = tokens.find((t) => t.mintKey.equals(marketConfig.targetMint));
        if (!targetToken) continue;

        const tokenPrice = priceMap.get(targetToken.symbol);
        if (!tokenPrice) continue;

        // Entry price is a ContractOraclePrice { price: BN, exponent: number }
        const rawEntryField = raw.entryPrice;
        let parsedEntry = 0;
        if (
          rawEntryField &&
          typeof rawEntryField === 'object' &&
          'price' in rawEntryField &&
          'exponent' in rawEntryField
        ) {
          parsedEntry = parseFloat(rawEntryField.price.toString()) * Math.pow(10, rawEntryField.exponent);
        } else if (rawEntryField && BN.isBN(rawEntryField)) {
          const oracleExp = Number(tokenPrice.price.exponent.toString());
          parsedEntry = parseFloat(rawEntryField.toString()) * Math.pow(10, oracleExp);
        }

        // USD values in Flash Trade always use 6 decimal precision (USD_DECIMALS),
        // NOT the token's native decimals (sizeDecimals/collateralDecimals are TOKEN decimals).
        const USD_DECIMALS = 6;
        const parsedSize = raw.sizeUsd ? parseFloat(raw.sizeUsd.toString()) / Math.pow(10, USD_DECIMALS) : 0;
        const parsedCollateral = raw.collateralUsd
          ? parseFloat(raw.collateralUsd.toString()) / Math.pow(10, USD_DECIMALS)
          : 0;
        const parsedCurrentPrice = tokenPrice.uiPrice;

        // NaN/Infinity guard
        const entryPrice = Number.isFinite(parsedEntry) ? parsedEntry : 0;
        const sizeUsd = Number.isFinite(parsedSize) ? parsedSize : 0;
        const collateralUsd = Number.isFinite(parsedCollateral) ? parsedCollateral : 0;
        const currentPrice = Number.isFinite(parsedCurrentPrice) ? parsedCurrentPrice : 0;

        if (entryPrice <= 0 || sizeUsd <= 0 || collateralUsd <= 0) {
          getLogger().warn(
            'CLIENT',
            `Skipping position with invalid values: entry=${entryPrice} size=${sizeUsd} collateral=${collateralUsd}`,
          );
          continue;
        }

        const rawLeverage = sizeUsd / collateralUsd;
        const leverage = Number.isFinite(rawLeverage) ? rawLeverage : 0;
        const side = marketConfig.side === Side.Long ? TradeSide.Long : TradeSide.Short;
        const priceDelta = currentPrice - entryPrice;
        const pnlMult = side === TradeSide.Long ? 1 : -1;
        const unrealizedPnl = (priceDelta / entryPrice) * sizeUsd * pnlMult;
        const safeUnrealizedPnl = Number.isFinite(unrealizedPnl) ? unrealizedPnl : 0;

        // SDK liquidation price — uses the same math as the Flash Trade protocol
        let liquidationPrice = 0;
        const targetCustodyAcct = custodyAccountMap.get(targetToken.symbol);
        if (
          targetCustodyAcct &&
          raw.entryPrice &&
          typeof raw.entryPrice === 'object' &&
          'price' in raw.entryPrice &&
          'exponent' in raw.entryPrice
        ) {
          try {
            const entryOraclePrice = OraclePrice.from({
              price: raw.entryPrice.price,
              exponent: new BN(raw.entryPrice.exponent),
              confidence: BN_ZERO,
              timestamp: BN_ZERO,
            });
            const unsettledFees = raw.unsettledFeesUsd ?? BN_ZERO;
            // Cast raw decoded position data to PositionAccount for SDK liquidation math
            const posAcct = PositionAccount.from(
              raw.pubkey,
              raw as unknown as ConstructorParameters<typeof PositionAccount>[1],
            );
            const liqOraclePrice = this.perpClient.getLiquidationPriceContractHelper(
              entryOraclePrice,
              unsettledFees,
              marketConfig.side,
              targetCustodyAcct,
              posAcct,
            );
            const liqUi = parseFloat(liqOraclePrice.toUiPrice(8));
            if (Number.isFinite(liqUi) && liqUi > 0) {
              liquidationPrice = liqUi;
            }
          } catch {
            // Fall back to 0 if SDK calculation fails
          }
        }

        // Accumulated fees from protocol (unsettledFeesUsd is in USD with 6 decimals)
        const rawFees = raw.unsettledFeesUsd
          ? parseFloat(raw.unsettledFeesUsd.toString()) / Math.pow(10, USD_DECIMALS)
          : 0;
        const totalFees = Number.isFinite(rawFees) ? rawFees : 0;

        const rawPnlPct = collateralUsd > 0 ? (safeUnrealizedPnl / collateralUsd) * 100 : 0;

        positions.push({
          pubkey: raw.pubkey.toBase58(),
          market: targetToken.symbol,
          side,
          entryPrice,
          currentPrice,
          markPrice: currentPrice,
          sizeUsd,
          collateralUsd,
          leverage,
          unrealizedPnl: safeUnrealizedPnl,
          unrealizedPnlPercent: Number.isFinite(rawPnlPct) ? rawPnlPct : 0,
          liquidationPrice,
          openFee: 0,
          totalFees,
          fundingRate: 0, // Flash Trade uses lock fees (included in unsettledFeesUsd), not periodic funding rates
          timestamp: raw.openTime ? Number(raw.openTime.toString()) : Date.now() / 1000,
        });
      } catch (error: unknown) {
        getLogger().warn('CLIENT', `Failed to parse position: ${getErrorMessage(error)}`);
      }
    }
  }

  async getMarketData(market?: string): Promise<MarketData[]> {
    // If a specific market is requested and it's not in the default pool, find its pool
    const poolConfigs: PoolConfig[] = [];
    if (market) {
      const poolName = getPoolForMarket(market);
      if (poolName && isTradeablePool(poolName)) {
        poolConfigs.push(
          poolName === this.poolConfig.poolName
            ? this.poolConfig
            : PoolConfig.fromIdsByName(poolName, this.config.network),
        );
      } else {
        // Fallback to default pool
        poolConfigs.push(this.poolConfig);
      }
    } else {
      // No filter — query all tradeable pools in parallel
      const seen = new Set<string>();
      for (const name of POOL_NAMES) {
        if (seen.has(name) || !isTradeablePool(name)) continue;
        seen.add(name);
        try {
          poolConfigs.push(
            name === this.poolConfig.poolName ? this.poolConfig : PoolConfig.fromIdsByName(name, this.config.network),
          );
        } catch {
          /* skip unloadable pools */
        }
      }
    }

    const results: MarketData[] = [];
    const seenSymbols = new Set<string>();

    await Promise.all(
      poolConfigs.map(async (pc) => {
        try {
          const priceMap = await this.getPriceMap(pc);
          const tokens = pc.tokens as Array<{ symbol: string }>;

          for (const token of tokens) {
            if (market && token.symbol !== market) continue;
            if (seenSymbols.has(token.symbol)) continue;
            if (!priceMap.has(token.symbol)) continue;

            seenSymbols.add(token.symbol);
            const tp = priceMap.get(token.symbol)!;
            results.push({
              symbol: token.symbol,
              price: tp.uiPrice,
              priceChange24h: 0,
              openInterestLong: 0,
              openInterestShort: 0,
              maxLeverage: getMaxLeverage(token.symbol, false),
              fundingRate: 0, // Flash Trade uses lock fees, not periodic funding rates
            });
          }
        } catch {
          /* skip pools with price fetch failures */
        }
      }),
    );

    return results;
  }

  async getPortfolio(): Promise<Portfolio> {
    const [solBalance, usdcBalance, positions] = await withRetry(
      () =>
        Promise.all([this.connection.getBalance(this.wallet.publicKey), this.getUsdcBalance(), this.getPositions()]),
      'portfolio-fetch',
      { maxAttempts: 2 },
    );

    const solBal = solBalance / LAMPORTS_PER_SOL;
    this.cachedSolBalance = solBal;

    return {
      walletAddress: this.wallet.publicKey.toBase58(),
      balance: solBal,
      balanceLabel: `SOL: ${solBal.toFixed(4)} | USDC: ${usdcBalance.toFixed(2)}`,
      totalCollateralUsd: positions.reduce((s, p) => s + p.collateralUsd, 0),
      totalUnrealizedPnl: positions.reduce((s, p) => s + p.unrealizedPnl, 0),
      totalRealizedPnl: 0,
      totalFees: positions.reduce((s, p) => s + p.totalFees, 0),
      positions,
      totalPositionValue: positions.reduce((s, p) => s + p.sizeUsd, 0),
      usdcBalance,
    };
  }

  private async getUsdcBalance(): Promise<number> {
    try {
      const accounts = await withRetry(
        () => this.connection.getParsedTokenAccountsByOwner(this.wallet.publicKey, { mint: USDC_MINT }),
        'usdc-balance',
        { maxAttempts: 2 },
      );
      if (accounts.value.length === 0) return 0;
      const info = accounts.value[0].account.data.parsed?.info;
      return info?.tokenAmount?.uiAmount ?? 0;
    } catch (error: unknown) {
      getLogger().warn('CLIENT', `USDC balance fetch failed: ${getErrorMessage(error)}`);
      return 0;
    }
  }

  getBalance(): number {
    return this.cachedSolBalance;
  }

  /** Get the user's token balance for a given mint as BN (native units).
   *  Tries classic SPL Token first, then Token2022 (sFLP tokens may use Token2022). */
  private async getTokenBalance(mint: PublicKey): Promise<BN> {
    try {
      const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
      const accounts = await this.connection.getTokenAccountsByOwner(this.wallet.publicKey, {
        mint,
        programId: TOKEN_PROGRAM_ID,
      });
      if (accounts.value.length > 0) {
        const data = accounts.value[0].account.data;
        // SPL token account: amount is at offset 64, 8 bytes little-endian
        const amount = data.readBigUInt64LE(64);
        return new BN(amount.toString());
      }

      // Fallback: try Token2022 program (sFLP tokens may use this program)
      const token2022ProgramId = new PublicKey(TOKEN_2022_PROGRAM);
      const accounts2022 = await this.connection.getTokenAccountsByOwner(this.wallet.publicKey, {
        mint,
        programId: token2022ProgramId,
      });
      if (accounts2022.value.length > 0) {
        const data = accounts2022.value[0].account.data;
        const amount = data.readBigUInt64LE(64);
        return new BN(amount.toString());
      }

      return BN_ZERO;
    } catch {
      return BN_ZERO;
    }
  }

  // ─── On-Chain Order Methods ──────────────────────────────────────────────

  /**
   * Convert a UI price to ContractOraclePrice using the SDK's OraclePrice class.
   * Uses Pyth-standard exponent -8 to match on-chain oracle format.
   */
  private toContractOraclePrice(uiPrice: number): ContractOraclePrice {
    const ORACLE_EXPONENT = -8;
    const scaledPrice = new BN(Math.round(uiPrice * Math.pow(10, Math.abs(ORACLE_EXPONENT))));
    const oraclePrice = new OraclePrice({
      price: scaledPrice,
      exponent: new BN(ORACLE_EXPONENT),
      confidence: BN_ZERO,
      timestamp: BN_ZERO,
    });
    return oraclePrice.toContractOraclePrice();
  }

  /** Zero price for optional TP/SL fields — uses Pyth-standard exponent -8 */
  private zeroContractPrice(): ContractOraclePrice {
    return { price: BN_ZERO, exponent: -8 };
  }

  /**
   * Resolve the market's collateral symbol and receiveSymbol from poolConfig.markets.
   * For longs, collateral is often the target token itself (SOL, BTC) or a base token (JUP for virtual).
   * For shorts, collateral is USDC.
   * receiveSymbol = USDC for shorts or the market's collateral for longs.
   */
  private resolveOrderTokens(poolConfig: PoolConfig, market: string, sdkSide: typeof Side.Long | typeof Side.Short) {
    const targetToken = this.findToken(poolConfig, market);
    const poolMarkets = getTypedMarkets(poolConfig);
    const matchedMarket = poolMarkets.find((m) => m.targetMint.equals(targetToken.mintKey) && m.side === sdkSide);
    let collateralSymbol: string;
    if (matchedMarket) {
      collateralSymbol = this.resolveTokenSymbol(poolConfig, matchedMarket.collateralMint);
    } else {
      collateralSymbol = targetToken.symbol;
    }
    return { targetSymbol: targetToken.symbol, collateralSymbol, targetToken };
  }

  /**
   * Fetch backup oracle price update instruction from Flash Trade API.
   * This must be prepended before limit/edit order instructions to satisfy
   * the on-chain oracle freshness constraint.
   * Returns instructions array (empty on failure — caller decides fallback).
   */
  private async fetchBackupOracleIxs(poolConfig: PoolConfig): Promise<TransactionInstruction[]> {
    const logger = getLogger();
    try {
      const poolAddress = poolConfig.poolAddress.toBase58();
      const ixs = await createBackupOracleInstruction(poolAddress, true);
      if (ixs.length > 0) {
        logger.info(
          'ORACLE',
          `Fetched ${ixs.length} backup oracle instruction(s) for pool ${poolAddress.slice(0, 8)}… (${ixs[0].data.length} bytes)`,
        );
        // Whitelist any program IDs used by the oracle instructions (e.g. Ed25519SigVerify)
        for (const ix of ixs) {
          const progId = ix.programId.toBase58();
          if (!this.allowedPrograms.has(progId)) {
            (this.allowedPrograms as Set<string>).add(progId);
            logger.info('ORACLE', `Whitelisted oracle program: ${progId}`);
          }
        }
      } else {
        logger.warn('ORACLE', `Backup oracle returned 0 instructions for pool ${poolAddress.slice(0, 8)}…`);
      }
      return ixs;
    } catch (err: unknown) {
      logger.warn('ORACLE', `Backup oracle fetch failed: ${getErrorMessage(err)}`);
      return [];
    }
  }

  async placeLimitOrder(
    market: string,
    side: TradeSide,
    collateral: number,
    leverage: number,
    limitPrice: number,
    stopLoss?: number,
    takeProfit?: number,
  ): Promise<PlaceLimitOrderResult> {
    const logger = getLogger();
    this.validateLeverage(market, leverage);

    if (collateral < 10) {
      throw new Error(`Minimum collateral is $10 (got $${collateral})`);
    }

    this.acquireTradeLock(market, side);
    try {
      const poolConfig = this.getPoolConfigForMarket(market);
      const sdkSide = toSdkSide(side);
      const { targetSymbol, collateralSymbol, targetToken } = this.resolveOrderTokens(poolConfig, market, sdkSide);

      // Reserve = what user deposits (USDC)
      // Receive = what user gets back on cancellation (USDC)
      // Collateral = market's native collateral (SOL for SOL-LONG) — must match market PDA
      const reserveSymbol = DEFAULT_COLLATERAL_TOKEN;
      const receiveSymbol = DEFAULT_COLLATERAL_TOKEN;

      // Kick off backup oracle fetch early (runs in parallel with price/custody fetches)
      const oracleIxsPromise = this.fetchBackupOracleIxs(poolConfig);

      // Get price map and custody for size calculation
      const priceMap = await this.getPriceMap(poolConfig);
      const inputToken = this.findToken(poolConfig, reserveSymbol);
      const targetPrice = priceMap.get(targetSymbol);
      const inputPrice = priceMap.get(inputToken.symbol);
      if (!targetPrice) throw new Error(`Oracle unavailable for ${targetSymbol}`);
      if (!inputPrice) throw new Error(`Oracle unavailable for ${inputToken.symbol}`);

      const inputCustody = this.findCustody(poolConfig, inputToken.symbol);
      const outputCustody = this.findCustody(poolConfig, targetSymbol);
      const custodyAccounts = await withRetry(
        () =>
          this.perpClient.program.account.custody.fetchMultiple([
            inputCustody.custodyAccount,
            outputCustody.custodyAccount,
          ]),
        'custody-fetch',
        { maxAttempts: 2 },
      );
      if (!custodyAccounts[0] || !custodyAccounts[1]) {
        throw new Error('Failed to fetch custody accounts from chain');
      }

      const collateralNative = uiDecimalsToNative(collateral.toString(), inputToken.decimals);

      // For limit orders, calculate size at the LIMIT price, not the current oracle price.
      // The protocol validates that sizeAmount * limitPrice matches the collateral * leverage.
      // Using the current price would produce a size mismatch at the limit price.
      const limitExponent = targetPrice.price.exponent;
      const limitPriceScaled = new BN(Math.round(limitPrice * Math.pow(10, Math.abs(limitExponent.toNumber()))));
      const limitOraclePrice = new OraclePrice({
        price: limitPriceScaled,
        exponent: limitExponent,
        confidence: BN_ZERO,
        timestamp: new BN(Math.floor(Date.now() / 1000)),
      });

      const sizeAmount = this.perpClient.getSizeAmountFromLeverageAndCollateral(
        collateralNative,
        leverage.toString(),
        targetToken as unknown as Token,
        inputToken as unknown as Token,
        sdkSide,
        limitOraclePrice,
        limitOraclePrice,
        CustodyAccount.from(outputCustody.custodyAccount, custodyAccounts[1]),
        inputPrice.price,
        inputPrice.emaPrice,
        CustodyAccount.from(inputCustody.custodyAccount, custodyAccounts[0]),
        BN_ZERO,
      );

      const limitPriceContract = this.toContractOraclePrice(limitPrice);
      const slPrice = stopLoss ? this.toContractOraclePrice(stopLoss) : this.zeroContractPrice();
      const tpPrice = takeProfit ? this.toContractOraclePrice(takeProfit) : this.zeroContractPrice();

      logger.info(
        'CLIENT',
        `Limit order: target=${targetSymbol} collateral=${collateralSymbol} reserve=${reserveSymbol} receive=${receiveSymbol} side=${sdkSide === Side.Long ? 'Long' : 'Short'} price=${limitPrice} collateralNative=${collateralNative.toString()} sizeAmount=${sizeAmount.toString()}`,
      );

      const result = await this.perpClient.placeLimitOrder(
        targetSymbol,
        collateralSymbol,
        reserveSymbol,
        receiveSymbol,
        sdkSide,
        limitPriceContract,
        collateralNative,
        sizeAmount,
        slPrice,
        tpPrice,
        poolConfig,
      );

      // Prepend backup oracle instruction — required for on-chain oracle freshness constraint.
      // The oracle update must appear before the limit order instruction in the transaction.
      // Oracle + Ed25519 verification is CU-heavy; use 450k (SDK recommended).
      const oracleIxs = await oracleIxsPromise;
      const allInstructions = [...oracleIxs, ...result.instructions];
      const cuOverride = oracleIxs.length > 0 ? 450_000 : undefined;

      let txSignature: string;
      try {
        txSignature = await this.sendTx(allInstructions, result.additionalSigners, poolConfig, undefined, cuOverride);
      } catch (err: unknown) {
        const errMsg = getErrorMessage(err);
        // Oracle staleness — ConstraintRaw (0x7d3) means oracle data expired before TX landed
        if (errMsg.includes('ConstraintRaw') || errMsg.includes('0x7d3')) {
          logger.warn('ORACLE', `Limit order failed with stale oracle — retrying with fresh data`);
          const freshOracleIxs = await this.fetchBackupOracleIxs(poolConfig);
          const retryInstructions = [...freshOracleIxs, ...result.instructions];
          const retryCu = freshOracleIxs.length > 0 ? 450_000 : undefined;
          txSignature = await this.sendTx(retryInstructions, result.additionalSigners, poolConfig, undefined, retryCu);
        } else {
          throw err;
        }
      }

      logger.trade('LIMIT_ORDER', {
        market,
        side,
        collateral,
        leverage,
        limitPrice,
        tx: txSignature,
      });

      return {
        txSignature,
        market: market.toUpperCase(),
        side,
        limitPrice,
        collateral,
        leverage,
        sizeUsd: collateral * leverage,
      };
    } finally {
      this.releaseTradeLock(market, side);
    }
  }

  async placeTriggerOrder(
    market: string,
    side: TradeSide,
    triggerPrice: number,
    isStopLoss: boolean,
  ): Promise<PlaceTriggerOrderResult> {
    const logger = getLogger();

    this.acquireTradeLock(market, side);
    try {
      const poolConfig = this.getPoolConfigForMarket(market);
      const sdkSide = toSdkSide(side);
      const { targetSymbol, collateralSymbol } = this.resolveOrderTokens(poolConfig, market, sdkSide);
      const receiveSymbol = DEFAULT_COLLATERAL_TOKEN;

      // Get the existing position to determine size
      const { position } = await this.findUserPosition(poolConfig, market, side);
      const positionData = await this.perpClient.program.account.position.fetch(position.pubkey);
      const posData = positionData as SdkPositionData;
      if (!posData.sizeAmount || posData.sizeAmount.isZero()) {
        throw new Error(`No open ${side} position on ${market} to set ${isStopLoss ? 'stop-loss' : 'take-profit'} on`);
      }

      const triggerPriceContract = this.toContractOraclePrice(triggerPrice);

      const result = await this.perpClient.placeTriggerOrder(
        targetSymbol,
        collateralSymbol,
        receiveSymbol,
        sdkSide,
        triggerPriceContract,
        posData.sizeAmount,
        isStopLoss,
        poolConfig,
      );

      const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

      logger.trade(isStopLoss ? 'SET_SL' : 'SET_TP', {
        market,
        side,
        triggerPrice,
        tx: txSignature,
      });

      return {
        txSignature,
        market: market.toUpperCase(),
        side,
        triggerPrice,
        isStopLoss,
      };
    } finally {
      this.releaseTradeLock(market, side);
    }
  }

  /**
   * Build trigger order instructions WITHOUT sending a transaction.
   * Used by openPositionAtomic() to batch open + TP/SL into one tx.
   */
  private async buildTriggerOrderInstructions(
    market: string,
    side: TradeSide,
    triggerPrice: number,
    isStopLoss: boolean,
    sizeAmount: BN,
    poolConfig: PoolConfig,
  ): Promise<SdkResult> {
    const sdkSide = toSdkSide(side);
    const { targetSymbol, collateralSymbol } = this.resolveOrderTokens(poolConfig, market, sdkSide);
    const receiveSymbol = DEFAULT_COLLATERAL_TOKEN;
    const triggerPriceContract = this.toContractOraclePrice(triggerPrice);

    return this.perpClient.placeTriggerOrder(
      targetSymbol,
      collateralSymbol,
      receiveSymbol,
      sdkSide,
      triggerPriceContract,
      sizeAmount,
      isStopLoss,
      poolConfig,
    );
  }

  /**
   * Open a position with optional TP/SL in a SINGLE atomic transaction.
   * All instructions (open + take-profit + stop-loss) are batched together,
   * producing one Solscan transaction entry.
   *
   * Falls back to sequential transactions if the batch exceeds size limits.
   */
  async openPositionAtomic(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
    collateralToken?: string,
    takeProfit?: number,
    stopLoss?: number,
  ): Promise<OpenPositionResult & { triggerOrdersIncluded?: boolean }> {
    const logger = getLogger();
    const hasTriggers = takeProfit !== undefined || stopLoss !== undefined;

    // If no TP/SL, delegate to standard openPosition
    if (!hasTriggers) {
      return this.openPosition(market, side, collateralAmount, leverage, collateralToken);
    }

    // Pre-trade validation
    this.validateLeverage(market, leverage);
    const sideStr = side === TradeSide.Long ? 'long' : 'short';
    if (collateralAmount < 10) {
      throw new Error(
        `Minimum collateral is $10 (got $${collateralAmount}).\n` + `  Try: open ${leverage}x ${sideStr} ${market} $10`,
      );
    }



    this.acquireTradeLock(market, side);
    try {
      const poolConfig = this.getPoolConfigForMarket(market);
      const inputSymbol = collateralToken ?? DEFAULT_COLLATERAL_TOKEN;
      const sdkSide = toSdkSide(side);

      const [, , priceMap] = await Promise.all([
        this.ensureSufficientSol(),
        (async () => {
          if (inputSymbol === 'USDC') {
            try {
              const balances = await this.walletMgr.getTokenBalances();
              const usdcBalance = balances.tokens.find((t) => t.symbol === 'USDC')?.amount ?? 0;
              if (usdcBalance < collateralAmount) {
                throw new Error(
                  `Insufficient USDC collateral.\n` +
                    `  Required: $${collateralAmount.toFixed(2)}\n` +
                    `  Available: $${usdcBalance.toFixed(2)}\n` +
                    `  Deposit USDC to trade on Flash Trade.`,
                );
              }
            } catch (e: unknown) {
              const eMsg = getErrorMessage(e);
              if (eMsg.includes('Insufficient USDC')) throw e;
              logger.info('CLIENT', `USDC balance check skipped: ${scrubSensitive(eMsg)}`);
            }
          }
        })(),
        this.getPriceMap(poolConfig),
      ]);

      const targetToken = this.findToken(poolConfig, market);
      const collateralSymbol = collateralToken ?? DEFAULT_COLLATERAL_TOKEN;
      const inputToken = this.findToken(poolConfig, collateralSymbol);

      const targetPrice = priceMap.get(targetToken.symbol);
      const inputPrice = priceMap.get(inputToken.symbol);
      if (!targetPrice) throw new Error(`Oracle unavailable for ${targetToken.symbol}. Try again later.`);
      if (!inputPrice) throw new Error(`Oracle unavailable for ${inputToken.symbol}. Try again later.`);

      const priceAfterSlippage = this.perpClient.getPriceAfterSlippage(
        true,
        new BN(this.config.defaultSlippageBps),
        targetPrice.price,
        sdkSide,
      );

      const collateralNative = uiDecimalsToNative(collateralAmount.toString(), inputToken.decimals);
      const inputCustody = this.findCustody(poolConfig, inputToken.symbol);
      const outputCustody = this.findCustody(poolConfig, targetToken.symbol);

      const custodyAccounts = await withRetry(
        () =>
          this.perpClient.program.account.custody.fetchMultiple([
            inputCustody.custodyAccount,
            outputCustody.custodyAccount,
          ]),
        'custody-fetch',
        { maxAttempts: 2 },
      );
      if (!custodyAccounts[0] || !custodyAccounts[1]) {
        throw new Error('Failed to fetch custody accounts from chain');
      }

      const sizeAmount = this.perpClient.getSizeAmountFromLeverageAndCollateral(
        collateralNative,
        leverage.toString(),
        targetToken as unknown as Token,
        inputToken as unknown as Token,
        sdkSide,
        targetPrice.price,
        targetPrice.emaPrice,
        CustodyAccount.from(outputCustody.custodyAccount, custodyAccounts[1]),
        inputPrice.price,
        inputPrice.emaPrice,
        CustodyAccount.from(inputCustody.custodyAccount, custodyAccounts[0]),
        BN_ZERO,
      );

      // Resolve market collateral
      const poolMarkets = getTypedMarkets(poolConfig);
      const matchedMarket = poolMarkets.find((m) => m.targetMint.equals(targetToken.mintKey) && m.side === sdkSide);
      const marketCollateralSymbol = matchedMarket
        ? this.resolveTokenSymbol(poolConfig, matchedMarket.collateralMint)
        : targetToken.symbol;

      // Check for existing position
      let existingPositionPubkey: PublicKey | null = null;
      try {
        const { position } = await this.findUserPosition(poolConfig, market, side);
        existingPositionPubkey = position.pubkey;
      } catch {
        // No existing position
      }

      // ── Build open position instructions ──
      const ref = this.getReferralParams();
      const privilege = ref?.privilege ?? Privilege.None;
      const stakeAcct = ref?.tokenStakeAccount;
      const refAcct = ref?.userReferralAccount;

      let openResult: SdkResult;
      if (existingPositionPubkey) {
        openResult = await this.perpClient.increaseSize(
          targetToken.symbol,
          marketCollateralSymbol,
          existingPositionPubkey,
          sdkSide,
          poolConfig,
          priceAfterSlippage,
          sizeAmount,
          privilege,
          stakeAcct,
          refAcct,
        );
      } else if (inputToken.symbol === marketCollateralSymbol) {
        openResult = await this.perpClient.openPosition(
          targetToken.symbol,
          marketCollateralSymbol,
          priceAfterSlippage,
          collateralNative,
          sizeAmount,
          sdkSide,
          poolConfig,
          privilege,
          stakeAcct,
          refAcct,
        );
      } else {
        openResult = await this.perpClient.swapAndOpen(
          targetToken.symbol,
          marketCollateralSymbol,
          inputToken.symbol,
          collateralNative,
          priceAfterSlippage,
          sizeAmount,
          sdkSide,
          poolConfig,
          privilege,
          stakeAcct,
          refAcct,
        );
      }

      // ── Build trigger order instructions ──
      let tpResult: SdkResult | null = null;
      let slResult: SdkResult | null = null;

      if (takeProfit !== undefined && !existingPositionPubkey) {
        try {
          tpResult = await this.buildTriggerOrderInstructions(market, side, takeProfit, false, sizeAmount, poolConfig);
        } catch (err: unknown) {
          logger.info('CLIENT', `Failed to build TP instructions: ${getErrorMessage(err)}`);
        }
      }

      if (stopLoss !== undefined && !existingPositionPubkey) {
        try {
          slResult = await this.buildTriggerOrderInstructions(market, side, stopLoss, true, sizeAmount, poolConfig);
        } catch (err: unknown) {
          logger.info('CLIENT', `Failed to build SL instructions: ${getErrorMessage(err)}`);
        }
      }

      // ── Aggregate instructions ──
      const batch = createBatch();
      appendToBatch(batch, openResult, 'open');
      if (tpResult) appendToBatch(batch, tpResult, 'tp');
      if (slResult) appendToBatch(batch, slResult, 'sl');

      // ── Resolve ALTs for size optimization ──
      let altAccounts: AddressLookupTableAccount[] = [];
      try {
        altAccounts = await resolveALTs(this.perpClient, poolConfig);
      } catch {
        // Continue without ALTs
      }

      // ── Ensure target token ATA exists (matches Flash Trade website) ──
      // Website always includes createAssociatedTokenAccountIdempotent for the
      // target token before swap_and_open. The idempotent variant is a no-op if
      // the ATA already exists, so no RPC check needed.
      {
        const ataIxs = buildATAIdempotentIxs(this.wallet.publicKey, [targetToken.mintKey]);
        if (ataIxs.length > 0) {
          // Prepend ATA creation before all other instructions
          batch.instructions.unshift(...ataIxs);
        }
      }

      // ── Check if batch fits in one transaction ──
      let triggerOrdersIncluded = false;
      let txSignature: string;

      if ((tpResult || slResult) && isBatchWithinLimit(batch, this.wallet.publicKey, altAccounts)) {
        // Atomic: all instructions in one transaction
        logger.info('TRADE', `Atomic tx: ${batchSummary(batch)}`);
        txSignature = await this.sendTx(batch.instructions, batch.additionalSigners, poolConfig, altAccounts);
        triggerOrdersIncluded = true;
      } else if (tpResult || slResult) {
        // Fallback: open first, then TP/SL separately
        logger.info('TRADE', `Batch too large — splitting open + TP/SL into separate txs`);
        txSignature = await this.sendTx(openResult.instructions, openResult.additionalSigners, poolConfig, altAccounts);

        // Send TP/SL as separate transaction(s) after open confirms
        if (tpResult) {
          try {
            await this.sendTx(tpResult.instructions, tpResult.additionalSigners, poolConfig, altAccounts);
          } catch {
            /* TP is non-critical */
          }
        }
        if (slResult) {
          try {
            await this.sendTx(slResult.instructions, slResult.additionalSigners, poolConfig, altAccounts);
          } catch {
            /* SL is non-critical */
          }
        }
      } else {
        // Just the open position
        txSignature = await this.sendTx(openResult.instructions, openResult.additionalSigners, poolConfig, altAccounts);
      }



      // Compute liquidation price
      let openLiqPrice = 0;
      try {
        const _targetCustodyAcct = CustodyAccount.from(outputCustody.custodyAccount, custodyAccounts[1]);
        const openSizeUsd = targetPrice.price.getAssetAmountUsd(sizeAmount, targetToken.decimals);
        const openCollateralUsd = inputPrice.price.getAssetAmountUsd(collateralNative, inputToken.decimals);
        const liqResult = this.perpClient.getLiquidationPriceWithOrder(
          openCollateralUsd,
          sizeAmount,
          openSizeUsd,
          targetToken.decimals,
          targetPrice.price,
          sdkSide,
          _targetCustodyAcct,
        );
        const liqUi = parseFloat(liqResult.toUiPrice(8));
        if (Number.isFinite(liqUi) && liqUi > 0) openLiqPrice = liqUi;
      } catch {
        // Non-critical
      }

      const entryPrice = targetPrice.price.toUiPrice(8);

      return {
        txSignature,
        entryPrice: parseFloat(entryPrice),
        liquidationPrice: openLiqPrice,
        sizeUsd: collateralAmount * leverage,
        triggerOrdersIncluded,
      };
    } finally {
      this.releaseTradeLock(market, side);
    }
  }

  async cancelTriggerOrder(
    market: string,
    side: TradeSide,
    orderId: number,
    isStopLoss: boolean,
  ): Promise<CancelOrderResult> {
    const logger = getLogger();

    const poolConfig = this.getPoolConfigForMarket(market);
    const sdkSide = toSdkSide(side);
    const { targetSymbol, collateralSymbol } = this.resolveOrderTokens(poolConfig, market, sdkSide);

    const result = await this.perpClient.cancelTriggerOrder(
      targetSymbol,
      collateralSymbol,
      sdkSide,
      orderId,
      isStopLoss,
      poolConfig,
    );

    const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

    logger.trade(isStopLoss ? 'CANCEL_SL' : 'CANCEL_TP', {
      market,
      side,
      orderId,
      tx: txSignature,
    });

    return { txSignature };
  }

  async cancelAllTriggerOrders(market: string, side: TradeSide): Promise<CancelOrderResult> {
    const logger = getLogger();

    const poolConfig = this.getPoolConfigForMarket(market);
    const sdkSide = toSdkSide(side);
    const { targetSymbol, collateralSymbol } = this.resolveOrderTokens(poolConfig, market, sdkSide);

    const result = await this.perpClient.cancelAllTriggerOrders(targetSymbol, collateralSymbol, sdkSide, poolConfig);

    const txSignature = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

    logger.trade('CANCEL_ALL_TRIGGERS', { market, side, tx: txSignature });

    return { txSignature };
  }

  async cancelLimitOrder(market: string, side: TradeSide, orderId: number): Promise<CancelOrderResult> {
    const logger = getLogger();

    const poolConfig = this.getPoolConfigForMarket(market);
    const sdkSide = toSdkSide(side);
    const { collateralSymbol } = this.resolveOrderTokens(poolConfig, market, sdkSide);
    const reserveSymbol = DEFAULT_COLLATERAL_TOKEN;
    const receiveSymbol = DEFAULT_COLLATERAL_TOKEN;

    // Use editLimitOrder with zero size to cancel (or use program.methods directly)
    // The SDK doesn't expose cancelLimitOrder directly, but the Anchor program does.
    // We'll use the program.methods approach since CancelLimitOrderParams exists.
    try {
      const targetToken = this.findToken(poolConfig, market);
      const collateralToken = this.findToken(poolConfig, collateralSymbol);
      const reserveToken = this.findToken(poolConfig, reserveSymbol);
      const receiveToken = this.findToken(poolConfig, receiveSymbol);

      // Fetch oracle update in parallel with SDK instruction build
      const oracleIxsPromise = this.fetchBackupOracleIxs(poolConfig);

      // Edit with zero size effectively cancels
      const result = await this.perpClient.editLimitOrder(
        targetToken.symbol,
        collateralToken.symbol,
        reserveToken.symbol,
        receiveToken.symbol,
        sdkSide,
        orderId,
        this.zeroContractPrice(),
        BN_ZERO,
        this.zeroContractPrice(),
        this.zeroContractPrice(),
        poolConfig,
      );

      const oracleIxs = await oracleIxsPromise;
      const cuOverride = oracleIxs.length > 0 ? 450_000 : undefined;
      const txSignature = await this.sendTx(
        [...oracleIxs, ...result.instructions],
        result.additionalSigners,
        poolConfig,
        undefined,
        cuOverride,
      );
      logger.trade('CANCEL_LIMIT', { market, side, orderId, tx: txSignature });
      return { txSignature };
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      logger.warn('CLIENT', `cancelLimitOrder via editLimitOrder failed: ${msg}`);
      throw new Error(`Failed to cancel limit order #${orderId}: ${msg}`, { cause: err });
    }
  }

  async editLimitOrder(
    market: string,
    side: TradeSide,
    orderId: number,
    newLimitPrice: number,
  ): Promise<CancelOrderResult> {
    const logger = getLogger();

    const poolConfig = this.getPoolConfigForMarket(market);
    const sdkSide = toSdkSide(side);
    const { targetSymbol, collateralSymbol } = this.resolveOrderTokens(poolConfig, market, sdkSide);
    const reserveSymbol = DEFAULT_COLLATERAL_TOKEN;
    const receiveSymbol = DEFAULT_COLLATERAL_TOKEN;

    // Fetch current order and oracle update in parallel
    const oracleIxsPromise = this.fetchBackupOracleIxs(poolConfig);
    const orders = await this.perpClient.getUserOrderAccounts(this.wallet.publicKey, poolConfig);
    const targetToken = this.findToken(poolConfig, market);
    const matchedOrder = orders.find((o) => {
      const poolMarkets = getTypedMarkets(poolConfig);
      const marketConfig = poolMarkets.find((m) => m.targetMint.equals(targetToken.mintKey) && m.side === sdkSide);
      return marketConfig && o.market.equals(marketConfig.marketAccount);
    });
    if (!matchedOrder) throw new Error(`No order account found for ${market} ${side}`);
    if (orderId >= matchedOrder.limitOrders.length) {
      throw new Error(`Limit order #${orderId} not found (${matchedOrder.limitOrders.length} orders exist)`);
    }
    const existingOrder = matchedOrder.limitOrders[orderId];

    const result = await this.perpClient.editLimitOrder(
      targetSymbol,
      collateralSymbol,
      reserveSymbol,
      receiveSymbol,
      sdkSide,
      orderId,
      this.toContractOraclePrice(newLimitPrice),
      existingOrder.sizeAmount,
      existingOrder.stopLossPrice,
      existingOrder.takeProfitPrice,
      poolConfig,
    );

    const oracleIxs = await oracleIxsPromise;
    const cuOverride = oracleIxs.length > 0 ? 450_000 : undefined;
    const txSignature = await this.sendTx(
      [...oracleIxs, ...result.instructions],
      result.additionalSigners,
      poolConfig,
      undefined,
      cuOverride,
    );

    logger.trade('EDIT_LIMIT', { market, side, orderId, newLimitPrice, tx: txSignature });

    return { txSignature };
  }

  async getUserOrders(): Promise<OnChainOrder[]> {
    const logger = getLogger();
    const result: OnChainOrder[] = [];

    // Iterate all pools to find orders
    for (const poolName of POOL_NAMES) {
      if (!isTradeablePool(poolName)) continue;
      try {
        const pc = PoolConfig.fromIdsByName(poolName, this.config.network);
        const orderAccounts = await this.perpClient.getUserOrderAccounts(this.wallet.publicKey, pc);

        for (const oa of orderAccounts) {
          if (!oa.isActive) continue;

          // Resolve market symbol from the market account
          const poolMarkets = getTypedMarkets(pc);
          const matchedMarket = poolMarkets.find((m) => m.marketAccount.equals(oa.market));
          if (!matchedMarket) continue;

          const tokens = pc.tokens as Array<{ symbol: string; mintKey: PublicKey }>;
          const targetToken = tokens.find((t) => t.mintKey.equals(matchedMarket.targetMint));
          if (!targetToken) continue;

          const marketSymbol = targetToken.symbol;
          const sideVal = matchedMarket.side === Side.Long ? TradeSide.Long : TradeSide.Short;

          // Limit orders
          for (let i = 0; i < oa.limitOrders.length; i++) {
            const lo = oa.limitOrders[i];
            if (lo.reserveAmount.isZero() && lo.sizeAmount.isZero()) continue;
            const price = this.contractPriceToUi(lo.limitPrice);
            if (price <= 0) continue;
            result.push({
              market: marketSymbol,
              side: sideVal,
              type: 'limit',
              orderId: i,
              price,
            });
          }

          // Take profit orders
          for (let i = 0; i < oa.takeProfitOrders.length; i++) {
            const tp = oa.takeProfitOrders[i];
            if (tp.triggerSize.isZero()) continue;
            const price = this.contractPriceToUi(tp.triggerPrice);
            if (price <= 0) continue;
            result.push({
              market: marketSymbol,
              side: sideVal,
              type: 'take_profit',
              orderId: i,
              price,
            });
          }

          // Stop loss orders
          for (let i = 0; i < oa.stopLossOrders.length; i++) {
            const sl = oa.stopLossOrders[i];
            if (sl.triggerSize.isZero()) continue;
            const price = this.contractPriceToUi(sl.triggerPrice);
            if (price <= 0) continue;
            result.push({
              market: marketSymbol,
              side: sideVal,
              type: 'stop_loss',
              orderId: i,
              price,
            });
          }
        }
      } catch (err: unknown) {
        logger.debug('CLIENT', `Order fetch for pool ${poolName} failed: ${getErrorMessage(err)}`);
      }
    }

    return result;
  }

  private contractPriceToUi(cp: ContractOraclePrice): number {
    if (!cp || cp.price.isZero()) return 0;
    const price = cp.price.toNumber() * Math.pow(10, cp.exponent);
    return Number.isFinite(price) ? price : 0;
  }

  // ─── Swap ──────────────────────────────────────────────────────────────────

  /**
   * Find a pool config that contains a given token symbol.
   * Falls back to the default pool. Unlike getPoolConfigForMarket() which looks
   * up perp markets, this searches pool token lists for swap/earn operations.
   */
  private getPoolConfigForToken(tokenSymbol: string): PoolConfig {
    // First check default pool
    const tokens = this.poolConfig.tokens as Array<{ symbol: string }>;
    if (tokens.some((t) => t.symbol === tokenSymbol)) {
      return this.poolConfig;
    }
    // Try all known pools
    for (const poolName of POOL_NAMES) {
      if (!isTradeablePool(poolName)) continue;
      try {
        const pc = PoolConfig.fromIdsByName(poolName, this.config.network);
        const poolTokens = pc.tokens as Array<{ symbol: string }>;
        if (poolTokens.some((t) => t.symbol === tokenSymbol)) {
          return pc;
        }
      } catch {
        // Pool not loadable
      }
    }
    throw new Error(`Token ${tokenSymbol} not found in any pool`);
  }

  async swap(inputToken: string, outputToken: string, amountIn: number, minAmountOut?: number) {
    const logger = getLogger();
    // Find a pool containing both tokens — try input token's pool first
    const poolConfig = this.getPoolConfigForToken(inputToken);

    const inToken = this.findToken(poolConfig, inputToken);
    const outToken = this.findToken(poolConfig, outputToken);

    const nativeAmountIn = uiDecimalsToNative(amountIn.toString(), inToken.decimals);
    const minOut = minAmountOut ? uiDecimalsToNative(minAmountOut.toString(), outToken.decimals) : BN_ZERO; // 0 = accept any amount (slippage handled by pool)

    logger.info('CLIENT', `Swap ${amountIn} ${inputToken} → ${outputToken}`);

    const result = await this.perpClient.swap(inToken.symbol, outToken.symbol, nativeAmountIn, minOut, poolConfig);

    const sig = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

    return {
      txSignature: sig,
      inputToken,
      outputToken,
      amountIn,
      amountOut: amountIn, // exact output not known until confirmed
      price: 1, // placeholder — actual rate comes from on-chain
    };
  }

  // ─── Earn (LP & Staking) ───────────────────────────────────────────────────

  /**
   * Resolve a PoolConfig by pool name. Falls back to default pool if not specified.
   */
  private resolvePoolConfig(poolName?: string): PoolConfig {
    if (!poolName) return this.poolConfig;
    if (poolName === this.poolConfig.poolName) return this.poolConfig;
    if (!isTradeablePool(poolName)) {
      throw new Error(`Pool "${poolName}" is not available. Use "earn status" to see available pools.`);
    }
    const pc = PoolConfig.fromIdsByName(poolName, this.config.network);
    // Register program IDs
    this.allowedPrograms.add(pc.programId.toBase58());
    if (pc.perpComposibilityProgramId) this.allowedPrograms.add(pc.perpComposibilityProgramId.toBase58());
    if (pc.fbNftRewardProgramId) this.allowedPrograms.add(pc.fbNftRewardProgramId.toBase58());
    if (pc.rewardDistributionProgram?.programId)
      this.allowedPrograms.add(pc.rewardDistributionProgram.programId.toBase58());
    ALLOWED_PROGRAM_IDS = this.allowedPrograms;
    return pc;
  }

  async addLiquidity(tokenSymbol: string, amountUsd: number, pool?: string) {
    const logger = getLogger();
    const poolConfig = pool ? this.resolvePoolConfig(pool) : this.getPoolConfigForToken(tokenSymbol);
    const token = this.findToken(poolConfig, tokenSymbol);

    const nativeAmount = uiDecimalsToNative(amountUsd.toString(), token.decimals);
    const flpSymbol = (poolConfig as unknown as SdkPoolConfigExt).compoundingLpTokenSymbol || 'FLP';

    logger.info('CLIENT', `Add liquidity: ${amountUsd} ${tokenSymbol} → ${poolConfig.poolName} (${flpSymbol})`);

    const rewardTokenMint = poolConfig.compoundingTokenMint;
    const result = await this.perpClient.addCompoundingLiquidity(
      nativeAmount,
      BN_ZERO, // minCompoundingAmountOut — accept any LP tokens
      token.symbol,
      rewardTokenMint,
      poolConfig,
    );

    const sig = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

    return {
      txSignature: sig,
      action: 'add_liquidity',
      amount: amountUsd,
      token: tokenSymbol,
      message: `Added ${amountUsd} ${tokenSymbol} liquidity to ${poolConfig.poolName} → ${flpSymbol}`,
    };
  }

  async removeLiquidity(tokenSymbol: string, percent: number, pool?: string) {
    const logger = getLogger();
    const poolConfig = pool ? this.resolvePoolConfig(pool) : this.getPoolConfigForToken(tokenSymbol);
    const token = this.findToken(poolConfig, tokenSymbol);
    const flpSymbol = (poolConfig as unknown as SdkPoolConfigExt).compoundingLpTokenSymbol || 'FLP';

    logger.info('CLIENT', `Remove liquidity: ${percent}% from ${poolConfig.poolName} (${flpSymbol})`);

    // Get user's FLP token balance to calculate withdrawal amount
    // Check both compounding FLP and raw staked LP (from withdrawStake recovery)
    const flpMint = poolConfig.compoundingTokenMint;
    let flpBalance = await this.getTokenBalance(flpMint);
    let useRawLp = false;
    if (flpBalance.isZero()) {
      // Check for raw LP tokens (left over from unstake → withdrawStake)
      const rawLpMint = poolConfig.stakedLpTokenMint;
      flpBalance = await this.getTokenBalance(rawLpMint);
      if (flpBalance.isZero()) {
        throw new Error(`No ${flpSymbol} tokens found in wallet. Add liquidity first.`);
      }
      useRawLp = true;
      logger.info('CLIENT', `Found raw LP tokens (${rawLpMint.toBase58().slice(0, 8)}...) from previous unstake`);
    }

    const withdrawAmount = flpBalance.mul(new BN(percent)).div(new BN(100));
    if (withdrawAmount.isZero()) {
      throw new Error(`${percent}% of ${flpSymbol} balance rounds to zero.`);
    }

    logger.debug(
      'CLIENT',
      `FLP balance: ${flpBalance.toString()}, withdrawing: ${withdrawAmount.toString()} (${percent}%), rawLp=${useRawLp}`,
    );

    let result: { instructions: TransactionInstruction[]; additionalSigners: Signer[] };
    if (useRawLp) {
      // Raw LP tokens from withdrawStake — use removeLiquidity (needs ALTs for large tx)
      result = await quietSdk(() =>
        this.perpClient.removeLiquidity('USDC', withdrawAmount, BN_ZERO, poolConfig, true, true),
      );
    } else {
      // Compounding FLP tokens — use removeCompoundingLiquidity
      result = await quietSdk(() =>
        this.perpClient.removeCompoundingLiquidity(withdrawAmount, BN_ZERO, token.symbol, flpMint, poolConfig),
      );
    }

    const sig = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

    return {
      txSignature: sig,
      action: 'remove_liquidity',
      token: tokenSymbol,
      message: `Removed ${percent}% of ${flpSymbol} from ${poolConfig.poolName} → ${tokenSymbol}`,
    };
  }

  async stakeFLP(amountUsd: number, pool?: string) {
    const logger = getLogger();
    const poolConfig = this.resolvePoolConfig(pool);
    const sflpSymbol = (poolConfig as unknown as SdkPoolConfigExt).stakedLpTokenSymbol || 'sFLP';

    // Use addLiquidityAndStake: deposits USDC → mints LP → stakes → sFLP in one tx.
    // This is the correct flow — depositStake alone requires raw LP tokens
    // which users don't have (addCompoundingLiquidity gives compounding FLP, not raw LP).
    const nativeAmount = uiDecimalsToNative(amountUsd.toString(), 6); // USDC = 6 decimals

    logger.info('CLIENT', `Add liquidity + stake: $${amountUsd} USDC → ${sflpSymbol} (${poolConfig.poolName})`);

    const result = await this.perpClient.addLiquidityAndStake(
      'USDC',
      nativeAmount,
      BN_ZERO, // minLpAmountOut — accept any LP tokens
      poolConfig,
    );

    const sig = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

    return {
      txSignature: sig,
      action: 'stake',
      amount: amountUsd,
      message: `Staked $${amountUsd} USDC → ${sflpSymbol} (${poolConfig.poolName})`,
    };
  }

  async unstakeFLP(percent: number, pool?: string) {
    const logger = getLogger();
    const poolConfig = this.resolvePoolConfig(pool);
    const pcExt = poolConfig as unknown as SdkPoolConfigExt;
    const sflpSymbol = pcExt.stakedLpTokenSymbol || 'sFLP';

    // Read staked balance from FlpStakeAccount PDA (not a regular token account)
    const [flpStakePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('stake'), this.wallet.publicKey.toBuffer(), poolConfig.poolAddress.toBuffer()],
      poolConfig.programId,
    );
    const stakeAccountInfo = await this.connection.getAccountInfo(flpStakePda);
    if (!stakeAccountInfo) {
      throw new Error(`No ${sflpSymbol} position found. Use "earn stake" to deposit first.`);
    }
    const decoded = this.perpClient.program.coder.accounts.decode('flpStake', stakeAccountInfo.data) as {
      stakeStats: { activeAmount: BN; pendingActivation: BN; pendingDeactivation: BN; deactivatedAmount: BN };
    };
    const activeAmount = decoded.stakeStats.activeAmount;
    const pendingActivation = decoded.stakeStats.pendingActivation;
    const deactivatedAmount = decoded.stakeStats.deactivatedAmount;
    const totalStaked = activeAmount.add(pendingActivation);

    // If tokens are already deactivated (from a previous partial unstake), withdraw + convert them
    if (totalStaked.isZero() && !deactivatedAmount.isZero()) {
      logger.info(
        'CLIENT',
        `Found ${deactivatedAmount.toString()} deactivated ${sflpSymbol} — withdrawing and converting to USDC`,
      );
      const withdrawResult = await quietSdk(() => this.perpClient.withdrawStake(poolConfig, false, true, true));
      const sig1 = await this.sendTx(withdrawResult.instructions, withdrawResult.additionalSigners, poolConfig);
      try {
        const removeResult = await quietSdk(() =>
          this.perpClient.removeLiquidity('USDC', deactivatedAmount, BN_ZERO, poolConfig, true, true),
        );
        const sig2 = await this.sendTx(removeResult.instructions, removeResult.additionalSigners, poolConfig);
        return { txSignature: sig2, action: 'unstake', message: `Recovered deactivated ${sflpSymbol} → USDC` };
      } catch {
        return {
          txSignature: sig1,
          action: 'unstake',
          message: `Withdrew deactivated LP tokens. Use "earn withdraw" to convert to USDC.`,
        };
      }
    }

    if (totalStaked.isZero()) {
      throw new Error(`No ${sflpSymbol} tokens staked. Stake FLP first.`);
    }

    const unstakeAmount = totalStaked.mul(new BN(percent)).div(new BN(100));
    if (unstakeAmount.isZero()) {
      throw new Error(`${percent}% of ${sflpSymbol} balance rounds to zero.`);
    }

    logger.info(
      'CLIENT',
      `Unstake ${sflpSymbol}: ${unstakeAmount.toString()} native (${percent}%), active=${activeAmount.toString()}, pending=${pendingActivation.toString()}`,
    );

    // If there's pending activation, refresh stake first to activate it
    const preInstructions: TransactionInstruction[] = [];
    if (!pendingActivation.isZero()) {
      try {
        const refreshIx = await this.perpClient.refreshStakeWithTokenStake(
          'USDC',
          poolConfig,
          flpStakePda,
          this.wallet.publicKey,
        );
        preInstructions.push(refreshIx);
        logger.info('CLIENT', `Prepending refreshStake to activate ${pendingActivation.toString()} pending sFLP`);
      } catch {
        logger.warn('CLIENT', 'refreshStake failed — proceeding with active amount only');
      }
    }

    // Full unstake flow (3 steps, matches Flash Trade website):
    // 1. unstakeInstant → moves stake to "deactivated" state
    // 2. withdrawStake → extracts deactivated LP tokens to wallet
    // 3. removeLiquidity → burns LP tokens → USDC

    // Step 1+2: unstake + withdraw in one transaction
    const unstakeResult = await quietSdk(() => this.perpClient.unstakeInstant('USDC', unstakeAmount, poolConfig));
    const withdrawResult = await quietSdk(() => this.perpClient.withdrawStake(poolConfig, false, true, true));

    const tx1Ixs = [...preInstructions, ...unstakeResult.instructions, ...withdrawResult.instructions];
    const tx1Signers = [...unstakeResult.additionalSigners, ...withdrawResult.additionalSigners];
    const sig1 = await this.sendTx(tx1Ixs, tx1Signers, poolConfig);
    logger.info('CLIENT', `Unstake + withdraw tx: ${sig1}`);

    // Step 3: burn LP tokens → USDC (separate tx — too large to combine with ALTs)
    try {
      const removeResult = await quietSdk(() =>
        this.perpClient.removeLiquidity('USDC', unstakeAmount, BN_ZERO, poolConfig, true, true),
      );
      const sig2 = await this.sendTx(removeResult.instructions, removeResult.additionalSigners, poolConfig);
      logger.info('CLIENT', `Remove liquidity tx: ${sig2}`);

      return {
        txSignature: sig2,
        action: 'unstake',
        message: `Unstaked ${percent}% of ${sflpSymbol} → USDC (${poolConfig.poolName})`,
      };
    } catch (removeErr: unknown) {
      // If removeLiquidity fails, funds are safe as LP tokens in wallet.
      // User can manually run "earn withdraw" to convert LP → USDC.
      logger.warn('CLIENT', `Unstake succeeded but LP→USDC conversion failed: ${getErrorMessage(removeErr)}`);
      return {
        txSignature: sig1,
        action: 'unstake',
        message: `Unstaked ${percent}% of ${sflpSymbol}. LP tokens in wallet — use "earn withdraw" to convert to USDC.`,
      };
    }
  }

  async claimRewards(pool?: string) {
    const logger = getLogger();
    const poolConfig = this.resolvePoolConfig(pool);
    const pcExt = poolConfig as unknown as SdkPoolConfigExt;
    const sflpSymbol = pcExt.stakedLpTokenSymbol || 'sFLP';

    // Check if user has staked LP via FlpStakeAccount PDA
    const [flpStakePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('stake'), this.wallet.publicKey.toBuffer(), poolConfig.poolAddress.toBuffer()],
      poolConfig.programId,
    );
    const stakeAccountInfo = await this.connection.getAccountInfo(flpStakePda);
    if (!stakeAccountInfo) {
      throw new Error(`No ${sflpSymbol} position found for ${poolConfig.poolName}. Use "earn stake" to deposit first.`);
    }

    logger.info('CLIENT', `Claim rewards from ${poolConfig.poolName}`);

    const result = await this.perpClient.collectStakeFees('USDC', poolConfig);

    const sig = await this.sendTx(result.instructions, result.additionalSigners, poolConfig);

    return {
      txSignature: sig,
      action: 'claim_rewards',
      message: `Claimed staking rewards from ${poolConfig.poolName}`,
    };
  }
}
