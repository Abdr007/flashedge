/**
 * Flash SDK type interfaces — replaces unsafe `as unknown` casts in flash-client.ts.
 *
 * These types model the runtime shape of Flash SDK objects that are not fully
 * typed in the published SDK package. They are derived from inspecting the SDK
 * source and actual runtime values.
 *
 * Update these if the Flash SDK changes its internal structures.
 */

import { PublicKey } from '@solana/web3.js';
import { Side } from 'flash-sdk';
import BN from 'bn.js';

/** Runtime shape of PoolConfig.markets entries */
export interface SdkMarketEntry {
  marketAccount: PublicKey;
  targetMint: PublicKey;
  collateralMint: PublicKey;
  side: typeof Side.Long | typeof Side.Short;
}

/** Runtime shape of raw position data from getUserPositions */
export interface SdkRawPosition {
  pubkey: PublicKey;
  market: PublicKey;
  side: typeof Side.Long | typeof Side.Short;
  sizeAmount?: BN;
  collateralAmount?: BN;
  entryPrice?: { price: BN; exponent: BN };
  liquidationPrice?: { price: BN; exponent: BN };
  cumulativeInterestSnapshot?: BN;
  lockedAmount?: BN;
  collateralAmount2?: BN;
  openTime?: BN;
  updateTime?: BN;
  unrealizedLossUsd?: BN;
  unrealizedProfitUsd?: BN;
  sizeUsd?: BN;
  borrowSizeUsd?: BN;
  unsettledFeesUsd?: BN;
  cumulativeLockFeeSnapshot?: BN;
}

/** Runtime shape of position data with sizeAmount field */
export interface SdkPositionData {
  sizeAmount: BN;
}

/** Runtime shape of PoolConfig extended fields (LP tokens, earn) */
export interface SdkPoolConfigExt {
  compoundingLpTokenSymbol?: string;
  stakedLpTokenSymbol?: string;
  compoundingTokenMint?: PublicKey;
  stakedLpTokenMint?: PublicKey;
  lpTokenMint?: PublicKey;
  stakeFarmAddress?: PublicKey;
  farmLpTokenAccount?: PublicKey;
  farmRewardTokenAccount?: PublicKey;
  farmRewardTokenMint?: PublicKey;
}

/**
 * Cast PoolConfig.markets to typed array.
 * Centralizes the single unsafe cast so flash-client.ts stays clean.
 */
export function getTypedMarkets(poolConfig: { markets: unknown }): SdkMarketEntry[] {
  return poolConfig.markets as SdkMarketEntry[];
}
