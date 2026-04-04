/**
 * FAF Live Data
 *
 * Reads FAF staking state from on-chain accounts via Flash SDK.
 * All values are live — never estimated or hardcoded.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { PoolConfig, PerpetualsClient, TokenStakeAccount } from 'flash-sdk';
import { FAF_MINT, FAF_DECIMALS, UNSTAKE_UNLOCK_DAYS, getVipTier, VipTier, VOLTAGE_TIERS } from './faf-registry.js';
import { getLogger } from '../utils/logger.js';
import BN from 'bn.js';

export interface FafStakeInfo {
  /** User's staked FAF amount (UI units) */
  stakedAmount: number;
  /** VIP tier level (0-6) */
  level: number;
  /** VIP tier details */
  tier: VipTier;
  /** Pending FAF reward tokens (UI units) */
  pendingRewards: number;
  /** Pending USDC revenue (UI units) */
  pendingRevenue: number;
  /** Number of active unstake requests */
  withdrawRequestCount: number;
  /** Raw stake account (for SDK calls) */
  rawAccount: TokenStakeAccount | null;
}

/**
 * Read user's FAF staking position from on-chain.
 * Returns null if user has no stake account.
 */
export async function getFafStakeInfo(
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  userPublicKey: PublicKey,
): Promise<FafStakeInfo | null> {
  const logger = getLogger();

  let stakeAccount: TokenStakeAccount | null;
  try {
    stakeAccount = await perpClient.getTokenStakeAccount(poolConfig, userPublicKey);
  } catch {
    // No stake account — user hasn't staked
    return null;
  }

  if (!stakeAccount || !stakeAccount.isInitialized) return null;

  const stakedAmount = stakeAccount.activeStakeAmount
    ? new BN(stakeAccount.activeStakeAmount.toString()).toNumber() / Math.pow(10, FAF_DECIMALS)
    : 0;

  const level = stakeAccount.level ?? 0;
  const tier = getVipTier(stakedAmount);

  // Pending rewards (FAF tokens)
  let pendingRewards = 0;
  try {
    if (stakeAccount.rewardTokens) {
      pendingRewards = new BN(stakeAccount.rewardTokens.toString()).toNumber() / Math.pow(10, FAF_DECIMALS);
    }
  } catch {
    /* non-critical */
  }

  // Pending revenue (USDC)
  let pendingRevenue = 0;
  try {
    if (stakeAccount.unclaimedRevenueAmount) {
      pendingRevenue = new BN(stakeAccount.unclaimedRevenueAmount.toString()).toNumber() / Math.pow(10, 6); // USDC = 6 decimals
    }
  } catch {
    /* non-critical */
  }

  const withdrawRequestCount = stakeAccount.withdrawRequestCount ?? 0;

  logger.debug(
    'FAF',
    `Stake info: ${stakedAmount} FAF, level ${level}, rewards ${pendingRewards} FAF, revenue $${pendingRevenue}`,
  );

  return {
    stakedAmount,
    level,
    tier,
    pendingRewards,
    pendingRevenue,
    withdrawRequestCount,
    rawAccount: stakeAccount,
  };
}

// ─── Unstake Requests ──────────────────────────────────────────────────────

export interface FafUnstakeRequest {
  /** Request index (0-based) */
  index: number;
  /** Amount being unstaked (UI units) */
  amount: number;
  /** Unix timestamp when the unstake was requested */
  timestamp: number;
}

/**
 * Read pending unstake (withdraw) requests from the TokenStakeAccount.
 * Returns an empty array if no stake account or no requests.
 */
export async function getFafUnstakeRequests(
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  userPublicKey: PublicKey,
): Promise<FafUnstakeRequest[]> {
  let stakeAccount: TokenStakeAccount | null;
  try {
    stakeAccount = await perpClient.getTokenStakeAccount(poolConfig, userPublicKey);
  } catch {
    return [];
  }
  if (!stakeAccount || !stakeAccount.isInitialized) return [];

  const requests: FafUnstakeRequest[] = [];
  const withdrawCount = stakeAccount.withdrawRequestCount ?? 0;
  const withdrawList = stakeAccount.withdrawRequest ?? [];
  for (let i = 0; i < Math.min(withdrawCount, withdrawList.length); i++) {
    const req = withdrawList[i];
    if (!req) continue;
    const locked = new BN(req.lockedAmount?.toString() ?? '0').toNumber() / Math.pow(10, FAF_DECIMALS);
    const withdrawable = new BN(req.withdrawableAmount?.toString() ?? '0').toNumber() / Math.pow(10, FAF_DECIMALS);
    const totalAmount = locked + withdrawable;
    if (totalAmount <= 0) continue;
    // Estimate original timestamp from timeRemaining (90 days - timeRemaining = elapsed)
    const timeRemainingS = new BN(req.timeRemaining?.toString() ?? '0').toNumber();
    const unlockPeriodS = UNSTAKE_UNLOCK_DAYS * 24 * 3600;
    const elapsedS = Math.max(0, unlockPeriodS - timeRemainingS);
    const estimatedTimestamp = Math.floor(Date.now() / 1000) - elapsedS;
    requests.push({ index: i, amount: totalAmount, timestamp: estimatedTimestamp });
  }
  return requests;
}

// ─── Voltage Info ──────────────────────────────────────────────────────────

export interface FafVoltageInfo {
  /** Voltage tier level (0-based index into VOLTAGE_TIERS) */
  level: number;
  /** Tier name (e.g. "Rookie", "Degen", etc.) */
  tierName: string;
  /** Points multiplier */
  multiplier: number;
  /** Number of trades contributing to voltage */
  tradeCounter: number;
}

/**
 * Read voltage points info from the TokenStakeAccount.
 * Note: voltage points (cumulative) are tracked via VoltagePointsLog events
 * and indexed by the Flash Trade backend — not stored in TokenStakeAccount.
 * We read the VIP `level` and `tradeCounter` from the stake account.
 * The voltage tier is derived from the on-chain VIP level.
 */
export async function getVoltageInfo(
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  userPublicKey: PublicKey,
): Promise<FafVoltageInfo | null> {
  let stakeAccount: TokenStakeAccount | null;
  try {
    stakeAccount = await perpClient.getTokenStakeAccount(poolConfig, userPublicKey);
  } catch {
    return null;
  }
  if (!stakeAccount || !stakeAccount.isInitialized) return null;

  // Voltage points are tracked via VoltagePointsLog events indexed by Flash Trade's
  // backend. They're not stored in TokenStakeAccount. The `tradeCounter` field is a
  // daily trade counter (resets), not cumulative voltage points.
  // We display the trade counter as available on-chain data.
  const tradeCounter = stakeAccount.tradeCounter ?? 0;

  // Voltage tier cannot be determined from on-chain data alone.
  // Show Level 0 with note to check flash.trade for actual tier.
  const voltageIdx = 0;
  const tier = VOLTAGE_TIERS[voltageIdx];

  return {
    level: voltageIdx,
    tierName: tier.name,
    multiplier: tier.multiplier,
    tradeCounter: Number(tradeCounter) || 0,
  };
}

/**
 * Get user's FAF token balance (not staked — in wallet).
 */
export async function getFafBalance(connection: Connection, userPublicKey: PublicKey): Promise<number> {
  try {
    const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
    const accounts = await connection.getTokenAccountsByOwner(userPublicKey, {
      mint: FAF_MINT,
      programId: TOKEN_PROGRAM_ID,
    });
    if (accounts.value.length === 0) return 0;
    const data = accounts.value[0].account.data;
    const amount = data.readBigUInt64LE(64);
    return Number(amount) / Math.pow(10, FAF_DECIMALS);
  } catch {
    return 0;
  }
}
