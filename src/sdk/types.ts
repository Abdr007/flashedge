/**
 * Flash SDK — Type Definitions
 *
 * Strict types for all SDK operations. These mirror the v1 JSON contract
 * returned by `flash exec --format json`.
 *
 * Rules:
 * - Numbers are always `number` (never strings)
 * - Timestamps are ISO-8601 strings
 * - Enums use string literals
 */

// ─── Core Response ───────────────────────────────────────────────────────────

/** Standard JSON response from every command. */
export interface FlashResponse<T = Record<string, unknown>> {
  success: boolean;
  command: string;
  timestamp: string;
  version: string;
  data: T;
  error: FlashErrorInfo | null;
}

/** Structured error in a failed response. */
export interface FlashErrorInfo {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

// ─── Trading ─────────────────────────────────────────────────────────────────

export type TradeSide = 'long' | 'short';

export interface Position {
  market: string;
  side: TradeSide;
  leverage: number;
  sizeUsd: number;
  collateralUsd: number;
  entryPrice: number;
  markPrice?: number;
  pnl?: number;
  pnlPercent?: number;
  liquidationPrice?: number;
  openFee?: number;
  totalFees?: number;
  fundingRate?: number;
  timestamp?: number;
}

export interface PositionsData {
  positions: Position[];
}

export interface OpenParams {
  market: string;
  side: TradeSide;
  collateral: number;
  leverage: number;
  /** Take-profit price */
  tp?: number;
  /** Stop-loss price */
  sl?: number;
}

export interface CloseParams {
  market: string;
  side: TradeSide;
  /** Percentage to close (1-100). Defaults to 100 (full close). */
  percent?: number;
}

export interface AddCollateralParams {
  market: string;
  side: TradeSide;
  amount: number;
}

export interface RemoveCollateralParams {
  market: string;
  side: TradeSide;
  amount: number;
}

export interface LimitOrderParams {
  market: string;
  side: TradeSide;
  leverage: number;
  collateral: number;
  /** Trigger price */
  price: number;
}

export interface TradeResult {
  market?: string;
  side?: string;
  leverage?: number;
  collateral?: number;
  sizeUsd?: number;
  entryPrice?: number;
  tx_signature?: string;
  action_required?: 'confirmation';
  prompt?: string;
}

// ─── Portfolio ───────────────────────────────────────────────────────────────

export interface Portfolio {
  totalValue?: number;
  totalPnl?: number;
  totalPnlPercent?: number;
  totalRealizedPnl?: number;
  totalFees?: number;
  usdcBalance?: number;
  positions?: Position[];
  [key: string]: unknown;
}

// ─── Market Data ─────────────────────────────────────────────────────────────

export interface MarketInfo {
  market: string;
  pool?: string;
  maxLeverage?: number;
  [key: string]: unknown;
}

export interface MarketsData {
  markets: MarketInfo[];
}

export interface VolumeEntry {
  market: string;
  volume_24h: number;
  [key: string]: unknown;
}

export interface VolumeData {
  total_volume_24h?: number;
  markets?: VolumeEntry[];
  [key: string]: unknown;
}

export interface OpenInterestData {
  total_oi?: number;
  markets?: Array<{
    market: string;
    long_oi: number;
    short_oi: number;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

// ─── Wallet ──────────────────────────────────────────────────────────────────

export interface WalletBalance {
  sol?: number;
  usdc?: number;
  address?: string;
  [key: string]: unknown;
}

export interface WalletTokens {
  tokens?: Array<{
    mint: string;
    symbol?: string;
    balance: number;
    uiBalance: number;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

// ─── Earn / LP ───────────────────────────────────────────────────────────────

export interface EarnPool {
  name: string;
  tvl?: number;
  apy?: number;
  [key: string]: unknown;
}

export interface EarnData {
  pools?: EarnPool[];
  [key: string]: unknown;
}

export interface EarnActionParams {
  /** Pool name (e.g. 'crypto', 'stables') */
  pool: string;
  /** Amount in USD/tokens */
  amount: number;
}

// ─── FAF Token ───────────────────────────────────────────────────────────────

export interface FafStatus {
  wallet_balance_faf?: number;
  staked_faf?: number;
  vip_level?: string;
  [key: string]: unknown;
}

export interface FafStakeParams {
  amount: number;
}

// ─── System ──────────────────────────────────────────────────────────────────

export interface HealthData {
  report: string;
  [key: string]: unknown;
}

export interface MetricsData {
  commandCount?: number;
  errorCount?: number;
  avgLatencyMs?: number;
  peakLatencyMs?: number;
  uptime?: string;
  [key: string]: unknown;
}

// ─── SDK Configuration ───────────────────────────────────────────────────────

export interface FlashSDKOptions {
  /** Path to the flash CLI binary. Defaults to 'flash'. */
  binPath?: string;
  /** Command execution timeout in milliseconds. Defaults to 15000. */
  timeout?: number;
  /** Max retries for transient failures. Defaults to 1. */
  maxRetries?: number;
  /** Environment variables to pass to the CLI process. */
  env?: Record<string, string>;
  /** Working directory for the CLI process. */
  cwd?: string;
}

// ─── Watch / Event Loop ──────────────────────────────────────────────────────

export interface WatchOptions {
  /** Polling interval in milliseconds. Defaults to 5000. */
  interval?: number;
  /** Only emit when data changes. Defaults to true. */
  deduplicate?: boolean;
  /** Maximum number of iterations (0 = unlimited). Defaults to 0. */
  maxIterations?: number;
}

export interface WatchHandle {
  /** Stop the watch loop. */
  stop(): void;
  /** True if the watch loop is running. */
  readonly running: boolean;
}
