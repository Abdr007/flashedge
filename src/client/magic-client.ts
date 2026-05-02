/**
 * MagicTradeClient — wraps `@flash_trade/magic-trade-client` for FlashEdge.
 *
 * Network defaults:
 *   - mainnet-beta: Pool.0 on program FTv2…hrzV (the same on-chain program as
 *     L1 Flash Trade), delegated to MagicBlock's ER at flashtrade.magicblock.app.
 *   - devnet: Pool.1 on the standalone FMT program (FMTgs…txvj).
 *
 * Two transports the user must understand:
 *   - L1 (mainchain): init UDL, init basket, delegate basket, deposits, session
 *     create/revoke. Uses `sendAndConfirmTransaction` against the L1 RPC.
 *   - ER: openPosition, closePosition, add/removeCollateral, increase/decrease,
 *     execute-orders. Uses the SDK's `sendErTransaction` with skipConfirm:true
 *     for sub-50ms keystroke→signature latency.
 *
 * Signing security: every instruction array passes through
 * `validateInstructionPrograms()` (whitelist) and `signing-guard.ts`
 * (caps + rate limit + audit log) before being signed. Same gates as live mode.
 */

import {
  MagicTradePerpetualsClient,
  PoolConfig,
  Side,
  type MarketConfig,
  MAGIC_TRADE_IDL,
} from '@flash_trade/magic-trade-client';
import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
  Signer,
  type Cluster,
} from '@solana/web3.js';
import BN from 'bn.js';
import { readFileSync } from 'fs';

import {
  IFlashClient,
  TradeSide,
  Position,
  MarketData,
  Portfolio,
  OpenPositionResult,
  ClosePositionResult,
  CollateralResult,
} from '../types/index.js';
import { validateInstructionPrograms } from './flash-client.js';
import { getSigningGuard } from '../security/signing-guard.js';
import { getLogger } from '../utils/logger.js';

const log = getLogger();

/** USD values are 6dp on-chain (matches mainnet convention). */
const USD_DECIMALS = 6;
const USD_POWER = 10 ** USD_DECIMALS;

/** Soft cap on simultaneous trade locks per session. */
const MAX_ACTIVE_TRADES = 32;
/** Recent-trade signature dedupe TTL. */
const RECENT_TRADE_TTL_MS = 60_000;

/**
 * Thrown when an SDK-side op isn't yet exposed via the FlashEdge wrapper.
 * Currently only triggers for orderbook ops that aren't required for v1.
 */
export class NotImplementedInMagicMode extends Error {
  constructor(opName: string) {
    super(`[magic-mode] ${opName} not yet wired in FlashEdge wrapper.`);
    this.name = 'NotImplementedInMagicMode';
  }
}

export interface MagicTradeClientOptions {
  /** Owner wallet — pays L1 fees, signs init/delegate/deposit/createSession. */
  wallet: Keypair;
  /** L1 RPC connection (mainnet-beta or devnet, must match `network`). */
  l1Connection: Connection;
  /** Cluster the pool lives on. */
  network: 'mainnet-beta' | 'devnet';
  /** PoolConfig name (e.g. 'Pool.0' for mainnet). */
  poolName: string;
  /** ER router endpoint URL. */
  erEndpoint: string;
  /** Override `poolConfig.programId` (rare — only for non-default deploys). */
  programIdOverride?: string;
  /** Compute-unit price (microlamports) for L1 txs. ER txs use the protocol max. */
  prioritizationFee?: number;
  /**
   * When true (default), ER trade ixs return the signature immediately after
   * submission and poll for confirmation in the background. Set false to wait
   * synchronously for ER commit (slower but caller knows trade landed).
   */
  fastConfirm?: boolean;
}

/**
 * Snapshot of the active session, returned to callers so they can persist it.
 */
export interface ActiveSessionInfo {
  sessionPubkey: string;
  expiresAt: number; // unix seconds
}

export class MagicTradeClient implements IFlashClient {
  readonly walletAddress: string;
  readonly poolConfig: PoolConfig;
  readonly programId: PublicKey;
  readonly network: 'mainnet-beta' | 'devnet';

  readonly basketPda: PublicKey;
  readonly userDepositLedgerPda: PublicKey;

  private readonly wallet: Keypair;
  private readonly l1Connection: Connection;
  private readonly sdk: MagicTradePerpetualsClient;
  private readonly erEndpoint: string;

  /** When true, ER trade ixs use skipConfirm and return immediately. */
  private readonly fastConfirm: boolean;

  /**
   * Most-recent previewOpen quote, cached so openPosition can skip the
   * duplicate `getOpenPositionQuote` simulate (~100ms saved on the hot path).
   * Keyed by `${target}:${side}:${collateral}:${leverage}:${collateralToken}`;
   * cache-hit only when the same key is re-requested within 5s.
   */
  private lastQuoteCache: {
    key: string;
    quote: {
      collateralAmount: BN;
      sizeAmount: BN;
      entryPrice: { price: BN; exponent: number };
      liquidationPrice: { price: BN; exponent: number };
      sizeUsd: BN;
      collateralUsd: BN;
      entryFeeUsd: BN;
      swapRequired: boolean;
    };
    ts: number;
  } | null = null;

  /**
   * Pre-warmed ER blockhash. Refreshed every 400ms in the background so trade
   * ixs can skip the RPC roundtrip (~30-80ms per tx) for `getLatestBlockhash`.
   * The SDK's `sendErTransactionLegacy` calls `conn.getLatestBlockhash()` —
   * we monkey-patch it on the ER connection so the cached value is returned.
   */
  private blockhashCache: { blockhash: string; lastValidBlockHeight: number; fetchedAt: number } | null = null;
  private blockhashTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly BLOCKHASH_REFRESH_MS = 400;
  private static readonly BLOCKHASH_MAX_AGE_MS = 1000;

  /** Per-market mutex (key: `MARKET:SIDE`). */
  private readonly activeTrades = new Set<string>();

  /** Recent tx signature cache for idempotent retry. Key: `OP:MARKET:SIDE`. */
  private readonly recentTrades = new Map<string, { sig: string; ts: number }>();

  constructor(opts: MagicTradeClientOptions) {
    this.wallet = opts.wallet;
    this.walletAddress = opts.wallet.publicKey.toBase58();
    this.l1Connection = opts.l1Connection;
    this.erEndpoint = opts.erEndpoint;
    this.network = opts.network;
    this.fastConfirm = opts.fastConfirm ?? true;

    const cluster: Cluster = opts.network === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
    try {
      this.poolConfig = PoolConfig.fromIdsByName(opts.poolName, cluster);
    } catch (err) {
      throw new Error(
        `[magic-mode] Pool '${opts.poolName}' not found in @flash_trade/magic-trade-client PoolConfig for cluster '${cluster}'. ` +
          `Set MAGIC_NETWORK + MAGIC_POOL_NAME to a published pool, or update the SDK.`,
        { cause: err },
      );
    }
    if (!this.poolConfig.isMagicBlock) {
      throw new Error(
        `[magic-mode] Pool '${opts.poolName}' on '${cluster}' is not a Magic-Block pool ` +
          `(isMagicBlock=false). Mainnet uses 'Pool.0', devnet uses 'Pool.1'.`,
      );
    }

    this.programId = opts.programIdOverride
      ? new PublicKey(opts.programIdOverride)
      : new PublicKey(this.poolConfig.programId);

    // Build the L1 anchor provider — the SDK uses this for mainchain ixs and
    // internally constructs an ER provider from `erEndpoint`.
    const WalletCtor = (anchor as unknown as { Wallet: new (kp: Keypair) => unknown }).Wallet;
    const anchorWallet = new WalletCtor(this.wallet) as anchor.Wallet;
    const provider = new AnchorProvider(this.l1Connection, anchorWallet, {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });

    this.sdk = new MagicTradePerpetualsClient(
      provider,
      MAGIC_TRADE_IDL,
      this.programId,
      {
        prioritizationFee: opts.prioritizationFee ?? 0,
        useExternalOracle: false,
      },
      opts.erEndpoint,
    );

    const owner = this.wallet.publicKey;
    this.basketPda = PublicKey.findProgramAddressSync(
      [Buffer.from('basket'), owner.toBuffer()],
      this.programId,
    )[0];
    this.userDepositLedgerPda = PublicKey.findProgramAddressSync(
      [Buffer.from('user_deposit_ledger'), owner.toBuffer()],
      this.programId,
    )[0];

    log.info(
      'magic-client',
      `init network=${cluster} pool=${opts.poolName} program=${this.programId.toBase58().slice(0, 8)}… er=${opts.erEndpoint}`,
    );

    // Pre-warm ER blockhash so trade ixs skip the RPC roundtrip on the hot path.
    this.installBlockhashWarmer();
  }

  /** Stop the background blockhash warmer — call on shutdown to avoid leaking timers. */
  shutdown(): void {
    if (this.blockhashTimer) {
      clearInterval(this.blockhashTimer);
      this.blockhashTimer = null;
    }
  }

  // ─── IFlashClient: reads ───────────────────────────────────────────────────

  getBalance(): number {
    // Sync signature inherited from IFlashClient — real balance is async via getPortfolio.
    return 0;
  }

  async getPortfolio(): Promise<Portfolio> {
    const owner = this.wallet.publicKey;

    const [basket, ledger] = await Promise.all([
      // Basket reads from ER (live state), UDL from L1 (where deposits are written).
      this.erAccounts.fetchBasket(owner).catch(() => null),
      this.sdk.accounts.fetchUserDepositLedger(owner).catch(() => null),
    ]);

    const positions = basket ? await this.buildPositionsFromBasket(basket as { positions: Array<{ market: PublicKey; position: unknown }> | null }) : [];

    let totalCollateralUsd = 0;
    let totalUnrealizedPnl = 0;
    for (const p of positions) {
      totalCollateralUsd += p.collateralUsd;
      totalUnrealizedPnl += p.unrealizedPnl;
    }

    const deposits = (ledger?.deposits ?? []) as Array<{ amount: BN; mint: PublicKey }>;
    const balanceUsd = deposits.reduce((acc, d) => {
      const tok = this.tokenForMintOrNull(d.mint);
      if (!tok) return acc;
      // Stable mints map 1:1 to USD; non-stable would need oracle conversion (P2 follow-up).
      return tok.isStable ? acc + Number(d.amount) / 10 ** tok.decimals : acc;
    }, 0);

    return {
      walletAddress: this.walletAddress,
      balance: balanceUsd,
      balanceLabel: 'USDC',
      totalCollateralUsd,
      totalUnrealizedPnl,
      totalRealizedPnl: 0,
      totalFees: 0,
      positions,
      totalPositionValue: positions.reduce((acc, p) => acc + p.sizeUsd, 0),
    };
  }

  async getPositions(): Promise<Position[]> {
    const portfolio = await this.getPortfolio();
    return portfolio.positions;
  }

  async getMarketData(market?: string): Promise<MarketData[]> {
    const filter = market ? market.toUpperCase() : null;

    // Pull all custody accounts in one batch — gives us OI per custody.
    const custodyAccts = await this.sdk.accounts.fetchAllCustodies(this.poolConfig.poolId).catch(() => []);
    const oiByCustody = new Map<string, { long: number; short: number }>();
    for (const c of custodyAccts) {
      const sym = this.poolConfig.custodies.find((cc) => cc.custodyAccount.equals(c.publicKey))?.symbol;
      if (!sym) continue;
      const collective = (c as unknown as { assets?: { collateral?: BN; locked?: BN; owned?: BN } }).assets;
      // collateral=long-OI, locked=short-OI per the on-chain `Assets` shape.
      oiByCustody.set(sym, {
        long: collective?.collateral ? Number(collective.collateral) / USD_POWER : 0,
        short: collective?.locked ? Number(collective.locked) / USD_POWER : 0,
      });
    }

    // Live oracle prices — fetch in parallel via SDK simulate. Skipped when caller
    // doesn't filter to a specific symbol (full table refresh would be 27 simulates).
    const priceMap = new Map<string, number>();
    if (filter) {
      const cfg = this.poolConfig.custodies.find((c) => c.symbol === filter);
      if (cfg) {
        const px = await this.fetchOraclePrice(cfg.symbol, undefined, TradeSide.Long).catch(() => 0);
        priceMap.set(cfg.symbol, px);
      }
    }

    const out: MarketData[] = [];
    for (const m of this.poolConfig.markets) {
      const target = this.poolConfig.custodies.find((c) => c.custodyAccount.equals(m.targetCustody));
      if (!target) continue;
      if (filter && target.symbol !== filter) continue;
      if (out.some((o) => o.symbol === target.symbol)) continue;
      const oi = oiByCustody.get(target.symbol) ?? { long: 0, short: 0 };
      out.push({
        symbol: target.symbol,
        price: priceMap.get(target.symbol) ?? 0,
        priceChange24h: 0, // 24h delta is sourced from CoinGecko in live mode
        openInterestLong: oi.long,
        openInterestShort: oi.short,
        maxLeverage: m.maxLev,
        fundingRate: 0,
      });
    }
    return out;
  }

  /**
   * Get the current oracle/entry price for a target symbol using the SDK's
   * typed `getEntryPriceAndFee` view. Pass a size of 1 base unit so fees ≈ 0
   * and the returned `entry_price` is effectively the spot oracle price.
   *
   * Why not `sdk.getOraclePrice`? It returns just the raw ix and the IDL
   * doesn't declare a typed `returns` field, so the SDK's ViewHelper.decodeLogs
   * errors with "View expected return type". `getEntryPriceAndFee` is fully
   * typed — same simulate cost (~50-100ms) and we get a fee estimate too.
   */
  async fetchOraclePrice(targetSymbol: string, lockSymbol?: string, side: TradeSide = TradeSide.Long): Promise<number> {
    const lock = lockSymbol ?? this.resolveMarket(targetSymbol, side).lockSymbol;
    const sdkSide = side === TradeSide.Long ? Side.Long : Side.Short;
    const result = await this.sdk.getEntryPriceAndFee(
      targetSymbol,
      lock,
      sdkSide,
      this.poolConfig,
      new BN(1),
    );
    return priceToNumber(result.entryPrice as { price: BN; exponent: number });
  }

  /**
   * Preview an open without signing. Returns the same numbers the trade card
   * will show: entry, liq, size, collateral, fee, swap-required flag. Used
   * for the Y/N confirm prompt so the user sees exactly what they're about to
   * sign before any tx hits chain.
   */
  async previewOpen(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
    collateralToken?: string,
  ): Promise<{
    targetSymbol: string;
    lockSymbol: string;
    collateralSymbol: string;
    entryPrice: number;
    liquidationPrice: number;
    sizeUsd: number;
    collateralUsd: number;
    feeUsd: number;
    swapRequired: boolean;
  }> {
    const targetSymbol = market.toUpperCase();
    const collateralSymbol = (collateralToken ?? 'USDC').toUpperCase();
    const sdkSide = side === TradeSide.Long ? Side.Long : Side.Short;
    const { lockSymbol } = this.resolveMarket(targetSymbol, side);
    const collateralCustody = this.poolConfig.getCustodyFromSymbol(collateralSymbol);
    const collateralRaw = new BN(Math.floor(collateralAmount * 10 ** collateralCustody.decimals));
    const leverageBps = new BN(Math.round(leverage * 10_000));

    const quote = await this.sdk.getOpenPositionQuote(
      targetSymbol,
      lockSymbol,
      sdkSide,
      this.poolConfig,
      collateralRaw,
      leverageBps,
      collateralSymbol,
      null,
      null,
      null,
      this.basketPda,
    );

    // Stash the quote so a subsequent openPosition() call with matching params
    // can reuse it (skips a ~100ms simulate on the hot path).
    this.lastQuoteCache = {
      key: this.quoteKey(targetSymbol, side, collateralAmount, leverage, collateralSymbol),
      quote: {
        collateralAmount: quote.collateralAmount as BN,
        sizeAmount: quote.sizeAmount as BN,
        entryPrice: quote.entryPrice as { price: BN; exponent: number },
        liquidationPrice: quote.liquidationPrice as { price: BN; exponent: number },
        sizeUsd: quote.sizeUsd as BN,
        collateralUsd: quote.collateralUsd as BN,
        entryFeeUsd: quote.entryFeeUsd as BN,
        swapRequired: Boolean(quote.swapRequired),
      },
      ts: Date.now(),
    };

    return {
      targetSymbol,
      lockSymbol,
      collateralSymbol,
      entryPrice: priceToNumber(quote.entryPrice as { price: BN; exponent: number }),
      liquidationPrice: priceToNumber(quote.liquidationPrice as { price: BN; exponent: number }),
      sizeUsd: Number((quote.sizeUsd as BN).toString()) / USD_POWER,
      collateralUsd: Number((quote.collateralUsd as BN).toString()) / USD_POWER,
      feeUsd: Number((quote.entryFeeUsd as BN).toString()) / USD_POWER,
      swapRequired: Boolean(quote.swapRequired),
    };
  }

  private quoteKey(target: string, side: TradeSide, coll: number, lev: number, payTok: string): string {
    return `${target.toUpperCase()}:${side}:${coll}:${lev}:${payTok.toUpperCase()}`;
  }

  // ─── IFlashClient: trades ──────────────────────────────────────────────────

  async openPosition(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
    collateralToken?: string,
  ): Promise<OpenPositionResult> {
    const targetSymbol = market.toUpperCase();
    const collateralSymbol = (collateralToken ?? 'USDC').toUpperCase();
    const sdkSide = side === 'long' ? Side.Long : Side.Short;
    const { lockSymbol } = this.resolveMarket(targetSymbol, side);

    // Signing-guard pre-checks (mirror live-mode behaviour).
    const guard = getSigningGuard();
    const sizeUsd = collateralAmount * leverage;
    const limit = guard.checkTradeLimits({ collateral: collateralAmount, leverage, sizeUsd, market: targetSymbol });
    if (!limit.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'open',
        market: targetSymbol,
        side,
        collateral: collateralAmount,
        leverage,
        sizeUsd,
        walletAddress: this.walletAddress,
        result: 'rejected',
        reason: limit.reason,
      });
      throw new Error(limit.reason);
    }
    const rate = guard.checkRateLimit();
    if (!rate.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'open',
        market: targetSymbol,
        side,
        walletAddress: this.walletAddress,
        result: 'rate_limited',
        reason: rate.reason,
      });
      throw new Error(rate.reason);
    }

    const lockKey = `${targetSymbol}:${side}`;
    this.acquireTradeLock(lockKey);
    try {
      // Idempotent retry — if same (op, market, side) was just signed, reuse the sig.
      const cacheKey = `open:${lockKey}:${collateralAmount}:${leverage}`;
      const cached = this.checkRecentTrade(cacheKey);
      if (cached) {
        log.info('magic-client', `openPosition cache-hit ${cacheKey} → ${cached}`);
        return { txSignature: cached, entryPrice: 0, liquidationPrice: 0, sizeUsd };
      }

      // Auto-settle was here but it added ~200-1500ms to every open and
      // settle is currently broken on-chain anyway. Skipped on the hot path.
      // If a trade fails with InsufficientAvailableBalance the user gets a
      // clear error and can run `magic settle` manually (or just deposit more).

      const collateralCustody = this.poolConfig.getCustodyFromSymbol(collateralSymbol);
      const collateralRaw = new BN(Math.floor(collateralAmount * 10 ** collateralCustody.decimals));
      const leverageBps = new BN(Math.round(leverage * 10_000));

      // Mirror the official Flash UI's pattern:
      //   - Always plain openPosition (no swapAndOpenPosition — the program handles
      //     cross-token via the receivingCustody account internally).
      //   - getOpenPositionQuote takes the LOCK symbol as `collateralSymbol` (for
      //     its market lookup) and the user's pay token as `receivingSymbol`.
      //   - openPosition takes (target, lock, collateral=user-pay-token).
      //
      // Reuse the previewOpen quote if it's <5s old and matches our params —
      // saves ~100ms on the hot path after the user's y/n confirm.
      const quoteCacheKey = this.quoteKey(targetSymbol, side, collateralAmount, leverage, collateralSymbol);
      const cachedQuote = this.lastQuoteCache;
      const quote = (cachedQuote && cachedQuote.key === quoteCacheKey && Date.now() - cachedQuote.ts < 5000)
        ? cachedQuote.quote
        : (await this.sdk.getOpenPositionQuote(
            targetSymbol,
            lockSymbol,
            sdkSide,
            this.poolConfig,
            collateralRaw,
            leverageBps,
            collateralSymbol,
            null,
            null,
            null,
            this.basketPda,
          )) as unknown as NonNullable<typeof cachedQuote>['quote'];
      const collateralRawForIx = quote.collateralAmount as BN;
      const sizeRawForIx = quote.sizeAmount as BN;
      const entryPriceForReturn = priceToNumber(quote.entryPrice as { price: BN; exponent: number });
      const liqPriceForReturn = priceToNumber(quote.liquidationPrice as { price: BN; exponent: number });

      const result = await this.sdk.openPosition(
        targetSymbol,
        lockSymbol,
        collateralSymbol,
        sdkSide,
        this.poolConfig,
        collateralRawForIx,
        sizeRawForIx,
      );

      const sig = await this.sendErIxs(result.instructions, result.additionalSigners, 'magic.openPosition');
      this.recordRecentTrade(cacheKey, sig);
      guard.recordSigning();
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'open',
        market: targetSymbol,
        side,
        collateral: collateralAmount,
        leverage,
        sizeUsd,
        walletAddress: this.walletAddress,
        result: 'confirmed',
      });

      // Use the SDK's canonical sizeUsd (fees baked in) so card matches preview.
      const canonicalSizeUsd = Number((quote.sizeUsd as BN).toString()) / USD_POWER;
      return {
        txSignature: sig,
        entryPrice: entryPriceForReturn,
        liquidationPrice: liqPriceForReturn,
        sizeUsd: canonicalSizeUsd,
      };
    } catch (err) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'open',
        market: targetSymbol,
        side,
        collateral: collateralAmount,
        leverage,
        walletAddress: this.walletAddress,
        result: 'failed',
        reason: (err as Error).message,
      });
      throw err;
    } finally {
      this.releaseTradeLock(lockKey);
    }
  }

  async closePosition(
    market: string,
    side: TradeSide,
    receiveToken?: string,
    _closePercent?: number,
    _closeAmount?: number,
  ): Promise<ClosePositionResult> {
    const targetSymbol = market.toUpperCase();
    const sdkSide = side === 'long' ? Side.Long : Side.Short;
    const { lockSymbol } = this.resolveMarket(targetSymbol, side);
    // User defaults to USDC payout; can override with receiveToken.
    const receivingSymbol = receiveToken?.toUpperCase() ?? 'USDC';

    const guard = getSigningGuard();
    const rate = guard.checkRateLimit();
    if (!rate.allowed) throw new Error(rate.reason);

    const lockKey = `${targetSymbol}:${side}`;
    this.acquireTradeLock(lockKey);
    try {
      const cacheKey = `close:${lockKey}`;
      const cached = this.checkRecentTrade(cacheKey);
      if (cached) {
        log.info('magic-client', `closePosition cache-hit ${cacheKey} → ${cached}`);
        return { txSignature: cached, exitPrice: 0, pnl: 0 };
      }

      // SDK arg order: (target, lockSymbol, side, pool, receivingSymbol). The
      // 2nd arg is used by `findMarketConfig(target, lockSymbol, side)` — must
      // be the market's lock custody, NOT the user's payout token.
      const result = await this.sdk.closePosition(
        targetSymbol,
        lockSymbol,
        sdkSide,
        this.poolConfig,
        receivingSymbol,
      );

      const sig = await this.sendErIxs(result.instructions, result.additionalSigners, 'magic.closePosition');
      this.recordRecentTrade(cacheKey, sig);
      guard.recordSigning();
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'close',
        market: targetSymbol,
        side,
        walletAddress: this.walletAddress,
        result: 'confirmed',
      });

      return { txSignature: sig, exitPrice: 0, pnl: 0 };
    } finally {
      this.releaseTradeLock(lockKey);
    }
  }

  async addCollateral(market: string, side: TradeSide, amount: number): Promise<CollateralResult> {
    const targetSymbol = market.toUpperCase();
    const sdkSide = side === 'long' ? Side.Long : Side.Short;
    const { lockSymbol } = this.resolveMarket(targetSymbol, side);
    const depositingSymbol = 'USDC'; // user adds collateral in USDC; SDK swaps to lock if needed
    const depositCustody = this.poolConfig.getCustodyFromSymbol(depositingSymbol);
    const amountRaw = new BN(Math.floor(amount * 10 ** depositCustody.decimals));

    const guard = getSigningGuard();
    const rate = guard.checkRateLimit();
    if (!rate.allowed) throw new Error(rate.reason);

    const lockKey = `${targetSymbol}:${side}`;
    this.acquireTradeLock(lockKey);
    try {
      const cacheKey = `add:${lockKey}:${amount}`;
      const cached = this.checkRecentTrade(cacheKey);
      if (cached) return { txSignature: cached };

      const result = await this.sdk.addCollateral(
        targetSymbol,
        lockSymbol,
        sdkSide,
        this.poolConfig,
        amountRaw,
        depositingSymbol,
      );
      const sig = await this.sendErIxs(result.instructions, result.additionalSigners, 'magic.addCollateral');
      this.recordRecentTrade(cacheKey, sig);
      guard.recordSigning();
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'add_collateral',
        market: targetSymbol,
        side,
        collateral: amount,
        walletAddress: this.walletAddress,
        result: 'confirmed',
      });
      return { txSignature: sig };
    } finally {
      this.releaseTradeLock(lockKey);
    }
  }

  async removeCollateral(market: string, side: TradeSide, amount: number): Promise<CollateralResult> {
    const targetSymbol = market.toUpperCase();
    const sdkSide = side === 'long' ? Side.Long : Side.Short;
    const { lockSymbol } = this.resolveMarket(targetSymbol, side);
    const dispensingSymbol = 'USDC'; // payout in USDC by default
    // remove takes USD-denominated delta (6dp).
    const amountUsd = new BN(Math.floor(amount * USD_POWER));

    const guard = getSigningGuard();
    const rate = guard.checkRateLimit();
    if (!rate.allowed) throw new Error(rate.reason);

    const lockKey = `${targetSymbol}:${side}`;
    this.acquireTradeLock(lockKey);
    try {
      const cacheKey = `remove:${lockKey}:${amount}`;
      const cached = this.checkRecentTrade(cacheKey);
      if (cached) return { txSignature: cached };

      const result = await this.sdk.removeCollateral(
        targetSymbol,
        lockSymbol,
        sdkSide,
        this.poolConfig,
        amountUsd,
        dispensingSymbol,
      );
      const sig = await this.sendErIxs(result.instructions, result.additionalSigners, 'magic.removeCollateral');
      this.recordRecentTrade(cacheKey, sig);
      guard.recordSigning();
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'remove_collateral',
        market: targetSymbol,
        side,
        collateral: amount,
        walletAddress: this.walletAddress,
        result: 'confirmed',
      });
      return { txSignature: sig };
    } finally {
      this.releaseTradeLock(lockKey);
    }
  }

  // ─── L1 setup (basket / UDL / delegate / deposit) ─────────────────────────

  async initializeUserDepositLedger(): Promise<string | 'already_initialised'> {
    const existing = await this.sdk.accounts.fetchUserDepositLedger(this.wallet.publicKey).catch(() => null);
    if (existing) return 'already_initialised';
    const result = await this.sdk.initializeUserDepositLedger();
    return this.sendL1Ixs(result.instructions, result.additionalSigners, 'magic.initUDL');
  }

  async initializeBasket(): Promise<string | 'already_initialised'> {
    const existing = await this.sdk.accounts.fetchBasket(this.wallet.publicKey).catch(() => null);
    if (existing) return 'already_initialised';
    const result = await this.sdk.initializeBasket();
    return this.sendL1Ixs(result.instructions, result.additionalSigners, 'magic.initBasket');
  }

  async delegateBasket(commitFrequencySec = 300): Promise<string> {
    // The validator key for delegation is provided by the ER router. We use a
    // sensible default — the SDK's delegateBasket accepts a DelegateConfig.
    const validatorKey = await this.fetchClosestValidatorKey();
    const result = await this.sdk.delegateBasket(this.wallet.publicKey, {
      commitFrequency: commitFrequencySec,
      validatorKey,
    });
    return this.sendL1Ixs(result.instructions, result.additionalSigners, 'magic.delegateBasket');
  }

  async depositDirect(tokenMint: PublicKey, amountRaw: bigint): Promise<string> {
    const result = await this.sdk.depositDirect(tokenMint, new BN(amountRaw.toString()));
    return this.sendL1Ixs(result.instructions, result.additionalSigners, 'magic.depositDirect');
  }

  /**
   * Read the ER's view of the basket (where openPosition actually executes).
   * L1's basket is the latest committed snapshot — the ER state is "live" and
   * what the program checks at trade time.
   */
  private get erAccounts(): { fetchBasket: (owner: PublicKey) => Promise<unknown>; fetchUserDepositLedger: (owner: PublicKey) => Promise<unknown> } {
    const sdkAny = this.sdk as unknown as {
      erAccounts: { fetchBasket: (owner: PublicKey) => Promise<unknown>; fetchUserDepositLedger: (owner: PublicKey) => Promise<unknown> } | null;
      accounts: { fetchBasket: (owner: PublicKey) => Promise<unknown>; fetchUserDepositLedger: (owner: PublicKey) => Promise<unknown> };
    };
    return sdkAny.erAccounts ?? sdkAny.accounts;
  }

  /**
   * Settle a custody's pending credits/debits — TWO-STEP flow:
   *   1. L1: requestCustodySettlementWithAction
   *      Creates the settlementReceipt PDA and commits ER state to L1.
   *   2. ER: processCustodySettlementEr
   *      Reads the receipt and drains matched debit/credit pairs from the
   *      basket into UDL deposits.
   *
   * Doing only step 2 fails with `AccountDiscriminatorNotFound` because the
   * settlementReceipt doesn't exist yet — that's why my earlier single-step
   * implementation always failed with InvalidWritableAccount.
   *
   * Returns the ER signature (the one that actually drains the balance).
   */
  async settleCustody(custodySymbol: string): Promise<string> {
    // Step 1 — L1: create the settlementReceipt + commit ER state
    const validatorKey = await this.fetchClosestValidatorKey().catch(() => this.wallet.publicKey);
    const requestResult = await this.sdk.requestCustodySettlementWithAction(custodySymbol, this.poolConfig, {
      commitFrequency: 300,
      validatorKey,
    });
    await this.sendL1Ixs(requestResult.instructions, requestResult.additionalSigners, `magic.settleRequest.${custodySymbol}`);

    // Step 2 — ER: process the receipt, drain the basket
    const processResult = await this.sdk.processCustodySettlementEr(custodySymbol, this.poolConfig);
    return this.sendErIxs(processResult.instructions, processResult.additionalSigners, `magic.settleProcess.${custodySymbol}`);
  }

  /**
   * Settle all custodies that currently have pending credits/debits in the
   * user's basket. Returns one signature per settled custody.
   */
  async settleAll(): Promise<Array<{ symbol: string; sig: string | null; err?: string }>> {
    // Read from ER — the basket on L1 is the last-committed snapshot, not live state.
    const basket = (await this.erAccounts.fetchBasket(this.wallet.publicKey).catch(() => null)) as
      | { debits?: Array<{ mint: PublicKey; amount: BN }>; pendingCredits?: Array<{ mint: PublicKey; amount: BN }> }
      | null;
    const symbols = new Set<string>();
    for (const e of basket?.debits ?? []) {
      const sym = this.poolConfig.custodies.find((c) => c.mintKey.equals(e.mint))?.symbol;
      if (sym) symbols.add(sym);
    }
    for (const e of basket?.pendingCredits ?? []) {
      const sym = this.poolConfig.custodies.find((c) => c.mintKey.equals(e.mint))?.symbol;
      if (sym) symbols.add(sym);
    }
    const out: Array<{ symbol: string; sig: string | null; err?: string }> = [];
    for (const sym of symbols) {
      try {
        const sig = await this.settleCustody(sym);
        out.push({ symbol: sym, sig });
      } catch (err) {
        out.push({ symbol: sym, sig: null, err: (err as Error).message });
      }
    }
    return out;
  }

  /**
   * Compute the user's actual available balance per token from the on-chain
   * basket + UDL — same formula the program uses at line 175 of openPosition:
   *   available = deposits − debits + pendingCredits
   */
  async getAvailableBalances(): Promise<Map<string, { available: number; deposits: number; debits: number; pendingCredits: number; decimals: number }>> {
    const owner = this.wallet.publicKey;
    // Read basket from ER (it's where openPosition checks state); UDL stays on L1.
    const [basket, udl] = await Promise.all([
      this.erAccounts.fetchBasket(owner).catch(() => null) as Promise<{ debits?: Array<{ mint: PublicKey; amount: BN }>; pendingCredits?: Array<{ mint: PublicKey; amount: BN }> } | null>,
      this.sdk.accounts.fetchUserDepositLedger(owner).catch(() => null) as Promise<{ deposits?: Array<{ mint: PublicKey; amount: BN }> } | null>,
    ]);
    const map = new Map<string, { available: number; deposits: number; debits: number; pendingCredits: number; decimals: number }>();
    for (const cust of this.poolConfig.custodies) {
      const decimals = cust.decimals;
      const dep = (udl?.deposits ?? []).find((d) => d.mint.equals(cust.mintKey))?.amount;
      const deb = (basket?.debits ?? []).find((d) => d.mint.equals(cust.mintKey))?.amount;
      const cred = (basket?.pendingCredits ?? []).find((d) => d.mint.equals(cust.mintKey))?.amount;
      const depN = dep ? Number(dep.toString()) / 10 ** decimals : 0;
      const debN = deb ? Number(deb.toString()) / 10 ** decimals : 0;
      const credN = cred ? Number(cred.toString()) / 10 ** decimals : 0;
      const available = depN - debN + credN;
      if (depN === 0 && debN === 0 && credN === 0) continue;
      map.set(cust.symbol, { available, deposits: depN, debits: debN, pendingCredits: credN, decimals });
    }
    return map;
  }

  /**
   * Withdraw collateral from the vault — two-step process bundled here:
   *   1. Request: marks the withdrawal in the UDL + ER, commits state to L1.
   *   2. Settle:  releases the tokens from the platform vault back to user's ATA.
   * Returns both signatures.
   */
  async withdraw(
    tokenMint: PublicKey,
    amountRaw: bigint,
  ): Promise<{ requestSig: string; settleSig: string }> {
    const validatorKey = await this.fetchClosestValidatorKey().catch(() => this.wallet.publicKey);
    const reqResult = await this.sdk.requestWithdrawalWithAction(
      tokenMint,
      new BN(amountRaw.toString()),
      { commitFrequency: 300, validatorKey },
      this.poolConfig,
      true, // requestCustodySettlementWithAction — bundle settlement request inline
    );
    const requestSig = await this.sendL1Ixs(reqResult.instructions, reqResult.additionalSigners, 'magic.requestWithdraw');

    const settleResult = await this.sdk.executeWithdrawalBaseChain(tokenMint, this.poolConfig, true);
    const settleSig = await this.sendL1Ixs(settleResult.instructions, settleResult.additionalSigners, 'magic.executeWithdraw');

    return { requestSig, settleSig };
  }

  // ─── Inspection helpers ────────────────────────────────────────────────────

  async preflight(stableMint?: PublicKey): Promise<{
    walletAddress: string;
    l1SolBalance: number;
    udlInitialised: boolean;
    basketInitialised: boolean;
    basketDelegated: boolean;
    stableAtaExists: boolean | null;
    stableAtaBalance: string | null;
    depositCount: number;
    network: string;
    poolName: string;
  }> {
    const owner = this.wallet.publicKey;
    const [l1Lamports, udl, basket, delegated] = await Promise.all([
      this.l1Connection.getBalance(owner).catch(() => 0),
      this.sdk.accounts.fetchUserDepositLedger(owner).catch(() => null),
      this.sdk.accounts.fetchBasket(owner).catch(() => null),
      this.checkBasketDelegated(),
    ]);

    let stableAtaExists: boolean | null = null;
    let stableAtaBalance: string | null = null;
    if (stableMint) {
      try {
        const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
        const ata = getAssociatedTokenAddressSync(stableMint, owner);
        const info = await this.l1Connection.getParsedAccountInfo(ata);
        if (info.value) {
          stableAtaExists = true;
          const parsed = (info.value.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed;
          stableAtaBalance = parsed?.info?.tokenAmount?.amount ?? null;
        } else {
          stableAtaExists = false;
        }
      } catch {
        stableAtaExists = null;
      }
    }

    return {
      walletAddress: owner.toBase58(),
      l1SolBalance: l1Lamports / LAMPORTS_PER_SOL,
      udlInitialised: udl !== null,
      basketInitialised: basket !== null,
      basketDelegated: delegated,
      stableAtaExists,
      stableAtaBalance,
      depositCount: Array.isArray(udl?.deposits) ? (udl.deposits as unknown[]).length : 0,
      network: this.network,
      poolName: this.poolConfig.poolName,
    };
  }

  async getDelegationStatus(): Promise<{ basketDelegated: boolean }> {
    return { basketDelegated: await this.checkBasketDelegated() };
  }

  /** List all magic-block pools the SDK knows about (across clusters). */
  listPoolConfigsAvailable(): Array<{ poolName: string; cluster: string; isActive: boolean }> {
    // Delegate to SDK's bundled JSON — we don't enumerate on-chain because
    // we already have the canonical list.
    const json = JSON.parse(
      readFileSync(
        new URL('../../node_modules/@flash_trade/magic-trade-client/dist/PoolConfig.json', import.meta.url),
        'utf8',
      ),
    ) as { pools: Array<{ poolName: string; cluster: string; isMagicBlock?: boolean }> };
    return json.pools
      .filter((p) => p.isMagicBlock)
      .map((p) => ({ poolName: p.poolName, cluster: p.cluster, isActive: p.poolName === this.poolConfig.poolName }));
  }

  listPools(): Array<{ pubkey: string; id: number }> {
    return [{ pubkey: this.poolConfig.poolAddress.toBase58(), id: this.poolConfig.poolId }];
  }

  listMarkets(): Array<{ pubkey: string; targetCustody: string; lockCustody: string; symbol: string; side: string; maxLev: number }> {
    return this.poolConfig.markets.map((m) => {
      const targetSymbol = this.poolConfig.custodies.find((c) => c.custodyAccount.equals(m.targetCustody))?.symbol ?? '?';
      return {
        pubkey: m.marketAccount.toBase58(),
        targetCustody: m.targetCustody.toBase58(),
        lockCustody: m.collateralCustody.toBase58(),
        symbol: targetSymbol,
        side: typeof m.side === 'string' ? m.side : Object.keys(m.side as object)[0],
        maxLev: m.maxLev,
      };
    });
  }

  listCustodies(): Array<{ pubkey: string; mint: string; decimals: number; isStable: boolean; symbol: string }> {
    return this.poolConfig.custodies.map((c) => ({
      pubkey: c.custodyAccount.toBase58(),
      mint: c.mintKey.toBase58(),
      decimals: c.decimals,
      isStable: c.isStable,
      symbol: c.symbol,
    }));
  }

  async fetchPlatform(): Promise<unknown> {
    return this.sdk.accounts.fetchPlatform().catch(() => null);
  }

  async fetchBasket(): Promise<unknown> {
    return this.erAccounts.fetchBasket(this.wallet.publicKey).catch(() => null);
  }

  async fetchUserDepositLedger(): Promise<unknown> {
    return this.sdk.accounts.fetchUserDepositLedger(this.wallet.publicKey).catch(() => null);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async sendErIxs(
    ixs: TransactionInstruction[],
    additionalSigners: Signer[],
    context: string,
  ): Promise<string> {
    validateInstructionPrograms(ixs, context);
    if (!this.verifyOwnerKeypair()) {
      throw new Error('[magic-mode] owner keypair integrity check failed — refusing to sign');
    }

    // Owner-signed ER trades for now. Session keys aren't usable here yet —
    // session_token PDAs live on L1 and the ER can't see them, so passing one
    // into openPosition triggers `Custom(3012) AccountNotInitialized`.
    // Reading the keypair from disk is sub-ms, so this is still fast.
    const signers: Keypair[] = [this.wallet];
    for (const s of additionalSigners) {
      if ((s as Keypair).secretKey) signers.push(s as Keypair);
    }

    if (this.fastConfirm) {
      // Submit-and-return: ~30-50ms perceived latency. Background poll surfaces
      // any failure asynchronously via the logger (and signing-guard audit log).
      const sig = await this.sdk.sendErTransaction(ixs, signers, {
        skipConfirm: true,
      });
      this.pollErTxBackground(sig, context);
      return sig;
    }

    const result = await this.sdk.sendAndConfirmErTransaction(ixs, signers, {
      pollTimeoutMs: 10_000,
      pollIntervalMs: 500,
    });
    return result.signature;
  }

  /**
   * Background ER signature watcher — fires once 2s after submission to check
   * status. If confirmed, logs success; if failed/missing, logs the error so
   * the user (or audit log tail) can see something went wrong despite the fast
   * return.
   */
  private pollErTxBackground(sig: string, context: string): void {
    const erConn = (this.sdk as unknown as { erConnection: Connection | null }).erConnection;
    if (!erConn) return;
    setTimeout(async () => {
      try {
        const status = await erConn.getSignatureStatus(sig);
        const value = status?.value;
        if (!value) {
          log.warn('magic-client', `[${context}] ${sig} not found 2s after submit — may still be propagating`);
          return;
        }
        if (value.err) {
          log.error('magic-client', `[${context}] ${sig} on-chain error: ${JSON.stringify(value.err)}`);
        } else {
          log.info('magic-client', `[${context}] ${sig} confirmed at slot ${value.slot ?? '?'}`);
        }
      } catch (err) {
        log.warn('magic-client', `[${context}] background status poll failed for ${sig}: ${(err as Error).message}`);
      }
    }, 2000).unref?.();
  }

  private async sendL1Ixs(
    ixs: TransactionInstruction[],
    additionalSigners: Signer[],
    context: string,
  ): Promise<string> {
    validateInstructionPrograms(ixs, context);
    if (!this.verifyOwnerKeypair()) {
      throw new Error('[magic-mode] owner keypair integrity check failed — refusing to sign');
    }
    const tx = new Transaction();
    for (const ix of ixs) tx.add(ix);
    const signers: Signer[] = [this.wallet, ...additionalSigners];
    // Public mainnet RPCs reject `simulateTransaction` ("preflight check is not supported"),
    // so skip preflight on mainnet. Devnet RPCs allow it; keep it on for cheaper feedback.
    return sendAndConfirmTransaction(this.l1Connection, tx, signers, {
      commitment: 'confirmed',
      skipPreflight: this.network === 'mainnet-beta',
    });
  }

  /**
   * Install a background blockhash refresher on the SDK's ER connection.
   * The SDK calls `erConn.getLatestBlockhash()` once per ER tx; by pre-warming
   * we cut ~30-80ms off every trade. Falls back to live fetch if cache is stale.
   */
  private installBlockhashWarmer(): void {
    const erConn = (this.sdk as unknown as { erConnection: Connection | null }).erConnection;
    if (!erConn) return;

    const refresh = async () => {
      try {
        const bh = await erConn.getLatestBlockhash('confirmed');
        this.blockhashCache = { ...bh, fetchedAt: Date.now() };
      } catch {
        // Stale cache will be detected by maxAge guard; safe to swallow.
      }
    };

    // Wrap the connection's getLatestBlockhash to return the cached value when fresh.
    const originalGet = erConn.getLatestBlockhash.bind(erConn);
    (erConn as unknown as { getLatestBlockhash: typeof erConn.getLatestBlockhash }).getLatestBlockhash = async (
      ...args: Parameters<typeof originalGet>
    ) => {
      const cache = this.blockhashCache;
      if (cache && Date.now() - cache.fetchedAt < MagicTradeClient.BLOCKHASH_MAX_AGE_MS) {
        return { blockhash: cache.blockhash, lastValidBlockHeight: cache.lastValidBlockHeight };
      }
      const fresh = await originalGet(...args);
      this.blockhashCache = { ...fresh, fetchedAt: Date.now() };
      return fresh;
    };

    // Kick off background refresher.
    void refresh();
    this.blockhashTimer = setInterval(refresh, MagicTradeClient.BLOCKHASH_REFRESH_MS);
    this.blockhashTimer.unref?.();
  }

  /** Quick keypair sanity — secretKey not zeroed, pubkey matches. */
  private verifyOwnerKeypair(): boolean {
    const sk = this.wallet.secretKey;
    if (!sk || sk.length !== 64) return false;
    let zero = true;
    for (let i = 0; i < sk.length; i++) {
      if (sk[i] !== 0) {
        zero = false;
        break;
      }
    }
    if (zero) return false;
    return this.wallet.publicKey.toBase58() === this.walletAddress;
  }

  private acquireTradeLock(key: string): void {
    if (this.activeTrades.has(key)) {
      throw new Error(`[magic-mode] trade already in progress for ${key}`);
    }
    if (this.activeTrades.size >= MAX_ACTIVE_TRADES) {
      throw new Error('[magic-mode] too many concurrent trades — wait for inflight to settle');
    }
    this.activeTrades.add(key);
  }

  private releaseTradeLock(key: string): void {
    this.activeTrades.delete(key);
  }

  private checkRecentTrade(cacheKey: string): string | null {
    const now = Date.now();
    for (const [k, v] of this.recentTrades) {
      if (now - v.ts > RECENT_TRADE_TTL_MS) this.recentTrades.delete(k);
    }
    const hit = this.recentTrades.get(cacheKey);
    return hit && now - hit.ts < RECENT_TRADE_TTL_MS ? hit.sig : null;
  }

  private recordRecentTrade(cacheKey: string, sig: string): void {
    this.recentTrades.set(cacheKey, { sig, ts: Date.now() });
  }

  /**
   * For pools where the lock custody isn't always USDC (correlated markets),
   * resolve the lockSymbol from PoolConfig. Most mainnet markets lock against
   * USDC; some (like SOL/BTC native-collateral variants) lock against the
   * target token itself.
   */
  private resolveMarket(targetSymbol: string, side: TradeSide): { lockSymbol: string; market: MarketConfig } {
    const target = this.poolConfig.getCustodyFromSymbol(targetSymbol);
    const sdkSide = side === 'long' ? Side.Long : Side.Short;
    // Prefer the USDC-lock market if one exists for this target+side.
    const usdc = this.poolConfig.custodies.find((c) => c.symbol === 'USDC');
    if (usdc) {
      const usdcMarket = this.poolConfig.getMarketConfig(target.custodyAccount, usdc.custodyAccount, sdkSide);
      if (usdcMarket) return { lockSymbol: 'USDC', market: usdcMarket };
    }
    // Fall back to native-collateral market.
    const nativeMarket = this.poolConfig.getMarketConfig(target.custodyAccount, target.custodyAccount, sdkSide);
    if (nativeMarket) return { lockSymbol: targetSymbol, market: nativeMarket };
    throw new Error(`[magic-mode] no market for ${targetSymbol} ${side} in pool ${this.poolConfig.poolName}`);
  }

  private tokenForMintOrNull(mint: PublicKey): { symbol: string; decimals: number; isStable: boolean } | null {
    try {
      return this.poolConfig.getTokenFromMintPk(mint);
    } catch {
      return null;
    }
  }

  /** Use Anchor's account-not-owned-by-program signal to check delegation. */
  private async checkBasketDelegated(): Promise<boolean> {
    try {
      const info = await this.l1Connection.getAccountInfo(this.basketPda);
      if (!info) return false;
      // When delegated to MagicBlock's ER, the account owner becomes the delegation program.
      return info.owner.toBase58() !== this.programId.toBase58();
    } catch {
      return false;
    }
  }

  /** Delegation needs an ER validator pubkey; `flashtrade.magicblock.app` exposes one. */
  private async fetchClosestValidatorKey(): Promise<PublicKey> {
    try {
      const res = await fetch(this.erEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getValidatorIdentity' }),
      });
      const json = (await res.json()) as { result?: { identity?: string } };
      if (json.result?.identity) return new PublicKey(json.result.identity);
    } catch {
      // fall through
    }
    // Fallback — well-known delegation program identity used as default validator.
    // Caller can override by calling sdk.delegateBasket directly with their own DelegateConfig.
    throw new Error('[magic-mode] could not fetch ER validator identity from router; supply a validatorKey explicitly');
  }

  /** Build positions array from Basket account, fetching real PnL/markPrice/liqPrice via SDK views. */
  private async buildPositionsFromBasket(basket: { positions: Array<{ market: PublicKey; position: unknown }> | null }): Promise<Position[]> {
    const list = (basket?.positions ?? []) as Array<{
      market: PublicKey;
      position: {
        openTime: BN;
        entryPrice: { price: BN; exponent: number };
        sizeUsd: BN;
        collateralUsd: BN;
        unsettledFeesUsd: BN;
      };
    }>;
    if (list.length === 0) return [];

    // Resolve target symbol + side per market once.
    const enriched = list.map((pm) => {
      const market = this.poolConfig.markets.find((m) => m.marketAccount.equals(pm.market));
      const targetCustody = market
        ? this.poolConfig.custodies.find((c) => c.custodyAccount.equals(market.targetCustody))
        : undefined;
      const lockCustody = market
        ? this.poolConfig.custodies.find((c) => c.custodyAccount.equals(market.collateralCustody))
        : undefined;
      const targetSymbol = targetCustody?.symbol ?? '?';
      const lockSymbol = lockCustody?.symbol ?? 'USDC';
      const sideStr =
        market && typeof market.side === 'string'
          ? market.side
          : market
            ? (Object.keys(market.side as object)[0] as TradeSide)
            : 'long';
      const sdkSide = sideStr === 'short' ? Side.Short : Side.Long;
      return { pm, market, targetSymbol, lockSymbol, sideStr: sideStr as TradeSide, sdkSide };
    });

    // Parallelize: per position fetch (markPrice, PnL, liqPrice) via SDK views.
    // Each is a single ER simulate — typically 50-100ms — so N positions takes ≈ max(per-call) with parallelism.
    const owner = this.wallet.publicKey;
    const livePerPos = await Promise.all(
      enriched.map(async (e) => {
        const tasks = [
          this.fetchOraclePrice(e.targetSymbol, e.lockSymbol, e.sideStr).catch(() => 0),
          this.sdk.getPnl(owner, e.targetSymbol, e.lockSymbol, e.sdkSide, this.poolConfig).catch(() => null),
          this.sdk.getLiquidationPrice(owner, e.targetSymbol, e.lockSymbol, e.sdkSide, this.poolConfig).catch(() => null),
        ] as const;
        const [markPrice, pnl, liqPrice] = await Promise.all(tasks);
        return { markPrice, pnl, liqPrice };
      }),
    );

    return enriched.map((e, i) => {
      const p = e.pm.position;
      const entryPrice = priceToNumber(p.entryPrice);
      const sizeUsd = Number(p.sizeUsd) / USD_POWER;
      const collateralUsd = Number(p.collateralUsd) / USD_POWER;
      const leverage = collateralUsd > 0 ? sizeUsd / collateralUsd : 0;

      const live = livePerPos[i];
      const markPrice = live.markPrice || entryPrice;
      const liquidationPrice = live.liqPrice ? priceToNumber(live.liqPrice as { price: BN; exponent: number }) : 0;

      // ProfitAndLoss: { profit: u64, loss: u64 } — both 6dp USD.
      let unrealizedPnl = 0;
      const pnlData = live.pnl as { profit?: BN; loss?: BN } | null;
      if (pnlData) {
        const profit = pnlData.profit ? Number(pnlData.profit) / USD_POWER : 0;
        const loss = pnlData.loss ? Number(pnlData.loss) / USD_POWER : 0;
        unrealizedPnl = profit - loss;
      }
      const unrealizedPnlPercent = collateralUsd > 0 ? (unrealizedPnl / collateralUsd) * 100 : 0;

      return {
        pubkey: e.pm.market.toBase58(),
        market: e.targetSymbol,
        side: e.sideStr,
        entryPrice,
        currentPrice: markPrice,
        markPrice,
        sizeUsd,
        collateralUsd,
        leverage,
        unrealizedPnl,
        unrealizedPnlPercent,
        liquidationPrice,
        openFee: 0,
        totalFees: Number(p.unsettledFeesUsd ?? new BN(0)) / USD_POWER,
        fundingRate: 0,
        timestamp: Number(p.openTime ?? new BN(0)) * 1000,
      };
    });
  }
}

/** ContractOraclePrice → JS number (price × 10^exponent). */
function priceToNumber(p: { price: BN; exponent: number } | undefined): number {
  if (!p) return 0;
  return Number(p.price) * Math.pow(10, p.exponent);
}
