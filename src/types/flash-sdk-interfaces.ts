/**
 * Local type definitions for Flash SDK internal objects.
 *
 * The Flash SDK does not export TypeScript types for many internal structures
 * (custody pricing, pool config arrays, etc.). These interfaces allow
 * type-safe access without `as any` casts.
 *
 * These are structural types — they describe the shape we actually use,
 * not the full SDK object. Update as needed when new SDK fields are accessed.
 */

import type { PublicKey, Connection, Keypair } from '@solana/web3.js';
import type { PerpetualsClient, PoolConfig } from 'flash-sdk';

// ─── BN-like numeric type (Anchor / bn.js) ─────────────────────────────────

/** Minimal interface for BN-like values returned by the SDK. */
export interface BNLike {
  toNumber(): number;
  toString(): string;
}

// ─── Flash SDK PoolConfig array element types ───────────────────────────────

/** Element of PoolConfig.custodies[] */
export interface PoolCustodyConfig {
  custodyAccount: PublicKey;
  symbol: string;
}

/** Element of PoolConfig.tokens[] */
export interface PoolTokenConfig {
  symbol: string;
  mintKey: PublicKey;
}

/** Element of PoolConfig.markets[] */
export interface PoolMarketConfig {
  marketAccount: PublicKey;
  targetMint: PublicKey;
  side: unknown; // Flash SDK Side enum — compared with === only
}

// ─── CustodyAccount pricing fields ─────────────────────────────────────────

/** CustodyAccount.pricing — fields not in the SDK's exported type. */
export interface CustodyPricing {
  maintenanceMargin?: BNLike | number;
  maxLeverage?: BNLike | number;
}

/** Extended CustodyAccount with pricing field. */
export interface CustodyAccountWithPricing {
  fees: {
    openPosition: BNLike;
    closePosition: BNLike;
  };
  pricing?: CustodyPricing;
}

// ─── FlashClient internal properties ────────────────────────────────────────

/**
 * Internal properties of FlashClient not exposed on IFlashClient.
 * These exist on the concrete FlashClient class but aren't in the interface.
 */
export interface FlashClientInternals {
  perpClient: PerpetualsClient;
  poolConfig: PoolConfig;
  connection: Connection;
  wallet: Keypair;
  clearReferralCache?: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK transaction send with variable argument types
  sendTx: (instructions: any[], additionalSigners: any[], poolConfig: PoolConfig) => Promise<string>;
}

// ─── Interpreter context ────────────────────────────────────────────────────

/** CommandContext exposed on AIInterpreter / OfflineInterpreter (private). */
export interface InterpreterContext {
  lastMarket?: string;
  lastSide?: unknown;
  lastLeverage?: number;
  lastCollateral?: number;
  lastAction?: unknown;
  updatedAt: number;
}

/** Interpreter with accessible context (for intent scoring). */
export interface InterpreterWithContext {
  context: InterpreterContext;
}

// ─── Raw SDK position fields ────────────────────────────────────────────────

/** Raw on-chain position data (from perpClient.program.account.position). */
export interface RawPositionAccount {
  market?: PublicKey & { equals?(other: PublicKey): boolean };
  entryPrice?: {
    price: BNLike;
    exponent: BNLike;
  };
  collateralUsd?: BNLike;
  [key: string]: unknown;
}

// ─── SQLite database interface ──────────────────────────────────────────────

/** Minimal better-sqlite3 Database interface (for dynamic import). */
export interface BetterSqliteDatabase {
  pragma(pragma: string): void;
  exec(sql: string): void;
  prepare(sql: string): BetterSqliteStatement;
  close(): void;
}

/** Minimal better-sqlite3 Statement interface. */
export interface BetterSqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

/** better-sqlite3 module constructor. */
export interface BetterSqliteConstructor {
  new (filename: string): BetterSqliteDatabase;
  (filename: string): BetterSqliteDatabase;
}
