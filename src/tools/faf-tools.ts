/**
 * FAF Token Tools
 *
 * CLI tools for FAF governance staking, revenue claiming,
 * VIP tier management, and referral system.
 */

import { z } from 'zod';
import { ToolDefinition, ToolResult, ToolContext } from '../types/index.js';
import { formatUsd } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import chalk from 'chalk';
import { theme } from '../cli/theme.js';
import { IS_AGENT } from '../no-dna.js';
import {
  VIP_TIERS,
  VOLTAGE_TIERS,
  getVipTier,
  getNextTier,
  formatFaf,
  FAF_DECIMALS,
  UNSTAKE_UNLOCK_DAYS,
} from '../token/faf-registry.js';
import { getFafStakeInfo, getFafBalance, getFafUnstakeRequests, getVoltageInfo } from '../token/faf-data.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getStakeContext(context: ToolContext) {
  const wm = context.walletManager;
  if (!wm?.isConnected) return { error: chalk.dim('  No wallet connected.') };

  const client = context.flashClient as unknown as import('../types/flash-sdk-interfaces.js').FlashClientInternals;
  if (!client?.perpClient || !client?.poolConfig) {
    return { error: chalk.dim('  FAF staking requires a live trading connection.') };
  }

  const { PublicKey } = await import('@solana/web3.js');
  const userPk = new PublicKey(context.walletAddress);

  return {
    client,
    perpClient: client.perpClient,
    poolConfig: client.poolConfig,
    userPk,
    wm,
    connection: client.connection,
  };
}

// ─── faf status (dashboard) ─────────────────────────────────────────────────

export const fafStatusTool: ToolDefinition = {
  name: 'faf_status',
  description: 'FAF staking dashboard — stake, rewards, VIP tier',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const ctx = await getStakeContext(context);
    if ('error' in ctx) return { success: true, message: ctx.error as string };

    const { perpClient, poolConfig, userPk, connection } = ctx;

    const stakeInfo = await getFafStakeInfo(perpClient, poolConfig, userPk);
    const walletBalance = await getFafBalance(connection, userPk);

    if (IS_AGENT) {
      return {
        success: true,
        message: JSON.stringify({
          action: 'faf_status',
          wallet_balance_faf: walletBalance,
          staked_faf: stakeInfo?.stakedAmount ?? 0,
          vip_level: stakeInfo?.level ?? 0,
          fee_discount: stakeInfo?.tier.feeDiscount ?? 0,
          pending_rewards_faf: stakeInfo?.pendingRewards ?? 0,
          pending_revenue_usdc: stakeInfo?.pendingRevenue ?? 0,
          withdraw_requests: stakeInfo?.withdrawRequestCount ?? 0,
        }),
      };
    }

    const lines = ['', `  ${theme.accentBold('FAF STAKING DASHBOARD')}`, `  ${theme.separator(50)}`, ''];

    if (!stakeInfo || stakeInfo.stakedAmount === 0) {
      lines.push(theme.pair('Wallet FAF', walletBalance > 0 ? formatFaf(walletBalance) : '0 FAF'));
      lines.push(theme.pair('Staked', '0 FAF'));
      lines.push(theme.pair('VIP Tier', 'Level 0 (no discount)'));
      lines.push('');
      lines.push(chalk.dim('  Stake FAF to earn 50% protocol revenue + fee discounts.'));
      lines.push(chalk.dim('  Use "faf stake <amount>" to start.'));
    } else {
      const tier = stakeInfo.tier;
      const nextTier = getNextTier(stakeInfo.level);

      lines.push(theme.pair('Wallet FAF', formatFaf(walletBalance)));
      lines.push(theme.pair('Staked', chalk.green(formatFaf(stakeInfo.stakedAmount))));
      lines.push(theme.pair('VIP Tier', `Level ${stakeInfo.level} (${tier.feeDiscount}% fee discount)`));
      lines.push('');

      if (stakeInfo.pendingRewards > 0) {
        lines.push(theme.pair('FAF Rewards', chalk.green(formatFaf(stakeInfo.pendingRewards))));
      }
      if (stakeInfo.pendingRevenue > 0) {
        lines.push(theme.pair('USDC Revenue', chalk.green(formatUsd(stakeInfo.pendingRevenue))));
      }
      if (stakeInfo.pendingRewards === 0 && stakeInfo.pendingRevenue === 0) {
        lines.push(theme.pair('Pending', chalk.dim('No claimable rewards')));
      }

      if (stakeInfo.withdrawRequestCount > 0) {
        lines.push('');
        lines.push(
          theme.pair(
            'Unstake Requests',
            `${stakeInfo.withdrawRequestCount} active (${UNSTAKE_UNLOCK_DAYS}-day unlock)`,
          ),
        );
      }

      if (nextTier) {
        const needed = nextTier.fafRequired - stakeInfo.stakedAmount;
        lines.push('');
        lines.push(
          chalk.dim(
            `  Next tier: Level ${nextTier.level} (stake ${formatFaf(needed)} more → ${nextTier.feeDiscount}% discount)`,
          ),
        );
      }
    }

    lines.push('');
    return { success: true, message: lines.join('\n') };
  },
};

// ─── faf stake ──────────────────────────────────────────────────────────────

export const fafStakeTool: ToolDefinition = {
  name: 'faf_stake',
  description: 'Stake FAF tokens for revenue sharing + VIP tier',
  parameters: z.object({
    amount: z.number().positive(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { amount } = params as { amount: number };
    const ctx = await getStakeContext(context);
    if ('error' in ctx) return { success: false, message: ctx.error as string };

    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: chalk.red('  Amount must be a positive number.') };
    }

    const { client, perpClient, poolConfig, userPk, connection } = ctx;
    const balance = await getFafBalance(connection, userPk);
    if (balance < amount) {
      return {
        success: false,
        message: chalk.red(`  Insufficient FAF: have ${formatFaf(balance)}, need ${formatFaf(amount)}`),
      };
    }

    try {
      const nativeAmount = BigInt(Math.floor(amount * Math.pow(10, FAF_DECIMALS)));
      const BN = (await import('bn.js')).default;
      const result = await perpClient.depositTokenStake(userPk, userPk, new BN(nativeAmount.toString()), poolConfig);
      const sig = await client.sendTx(result.instructions, result.additionalSigners, poolConfig);

      const remainingWallet = balance - amount;
      const stakeInfo = await getFafStakeInfo(perpClient, poolConfig, userPk).catch(() => null);
      const totalStaked = stakeInfo?.stakedAmount ?? amount;
      const newTier = getVipTier(totalStaked);
      const lines = [
        '',
        `  ${theme.accentBold('FAF STAKED')}`,
        '',
        theme.pair('Staked', formatFaf(amount)),
        theme.pair('Wallet FAF', `${formatFaf(Math.max(0, remainingWallet))} (remaining)`),
        theme.pair('Total Staked', formatFaf(totalStaked)),
        theme.pair('VIP Tier', `Level ${newTier.level} (${newTier.feeDiscount}% discount)`),
        '',
        `  ${chalk.dim('Tx:')} ${sig}`,
        '',
      ];
      return { success: true, message: lines.join('\n'), txSignature: sig };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  FAF stake failed: ${getErrorMessage(err)}`) };
    }
  },
};

// ─── faf unstake ────────────────────────────────────────────────────────────

export const fafUnstakeTool: ToolDefinition = {
  name: 'faf_unstake',
  description: 'Request FAF unstake (90-day linear unlock)',
  parameters: z.object({
    amount: z.number().positive(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { amount } = params as { amount: number };
    const ctx = await getStakeContext(context);
    if ('error' in ctx) return { success: false, message: ctx.error as string };

    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: chalk.red('  Amount must be a positive number.') };
    }

    const { client, perpClient, poolConfig, userPk } = ctx;

    try {
      const nativeAmount = BigInt(Math.floor(amount * Math.pow(10, FAF_DECIMALS)));
      const BN = (await import('bn.js')).default;
      const stakeInfoBefore = await getFafStakeInfo(perpClient, poolConfig, userPk).catch(() => null);
      const stakedBefore = stakeInfoBefore?.stakedAmount ?? 0;

      const result = await perpClient.unstakeTokenRequest(userPk, new BN(nativeAmount.toString()), poolConfig);
      const sig = await client.sendTx(result.instructions, result.additionalSigners, poolConfig);

      const remainingStaked = Math.max(0, stakedBefore - amount);
      const lines = [
        '',
        `  ${theme.accentBold('UNSTAKE REQUESTED')}`,
        '',
        theme.pair('Unstaking', formatFaf(amount)),
        theme.pair('Remaining Staked', formatFaf(remainingStaked)),
        theme.pair('Unlock', `Linear over ${UNSTAKE_UNLOCK_DAYS} days`),
        '',
        chalk.dim('  You continue earning revenue until tokens fully unlock.'),
        '',
        `  ${chalk.dim('Tx:')} ${sig}`,
        '',
      ];
      return { success: true, message: lines.join('\n'), txSignature: sig };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  FAF unstake request failed: ${getErrorMessage(err)}`) };
    }
  },
};

// ─── faf claim ──────────────────────────────────────────────────────────────

export const fafClaimTool: ToolDefinition = {
  name: 'faf_claim',
  description: 'Claim FAF rewards and/or USDC revenue',
  parameters: z.object({
    type: z.enum(['all', 'rewards', 'revenue', 'rebate']).default('all'),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { type } = params as { type: string };
    const ctx = await getStakeContext(context);
    if ('error' in ctx) return { success: false, message: ctx.error as string };

    const { client, perpClient, poolConfig, userPk } = ctx;
    const claimed: string[] = [];
    const sigs: string[] = [];

    try {
      // Claim FAF rewards
      if (type === 'all' || type === 'rewards') {
        try {
          const result = await perpClient.collectTokenReward(userPk, poolConfig);
          const sig = await client.sendTx(result.instructions, result.additionalSigners, poolConfig);
          claimed.push('FAF rewards');
          sigs.push(sig);
        } catch (e: unknown) {
          if (type === 'rewards') throw e;
          // Non-critical if claiming all — may not have rewards
        }
      }

      // Claim USDC revenue
      if (type === 'all' || type === 'revenue') {
        try {
          const result = await perpClient.collectRevenue(userPk, 'USDC', poolConfig);
          const sig = await client.sendTx(result.instructions, result.additionalSigners, poolConfig);
          claimed.push('USDC revenue');
          sigs.push(sig);
        } catch (e: unknown) {
          if (type === 'revenue') throw e;
        }
      }

      // Claim referral rebates
      if (type === 'all' || type === 'rebate') {
        try {
          const result = await perpClient.collectRebate(userPk, 'USDC', poolConfig);
          const sig = await client.sendTx(result.instructions, result.additionalSigners, poolConfig);
          claimed.push('referral rebates');
          sigs.push(sig);
        } catch (e: unknown) {
          if (type === 'rebate') throw e;
        }
      }

      if (claimed.length === 0) {
        return { success: true, message: chalk.dim('  No claimable rewards found.') };
      }

      const lines = ['', `  ${theme.accentBold('REWARDS CLAIMED')}`, '', theme.pair('Claimed', claimed.join(', ')), ''];
      for (const sig of sigs) {
        lines.push(`  ${chalk.dim('Tx:')} ${sig}`);
      }
      lines.push('');
      return { success: true, message: lines.join('\n'), txSignature: sigs[0] };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  FAF reward claim failed: ${getErrorMessage(err)}`) };
    }
  },
};

// ─── faf tier ───────────────────────────────────────────────────────────────

export const fafTierTool: ToolDefinition = {
  name: 'faf_tier',
  description: 'Show VIP tier levels and benefits',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    // Try to get user's current tier
    let currentLevel = 0;
    try {
      const ctx = await getStakeContext(context);
      if (!('error' in ctx)) {
        const info = await getFafStakeInfo(ctx.perpClient, ctx.poolConfig, ctx.userPk);
        if (info) currentLevel = info.level;
      }
    } catch {
      /* non-critical */
    }

    if (IS_AGENT) {
      return {
        success: true,
        message: JSON.stringify({
          action: 'faf_tier',
          current_level: currentLevel,
          tiers: VIP_TIERS.map((t) => ({
            level: t.level,
            faf_required: t.fafRequired,
            fee_discount: t.feeDiscount,
            referral_rebate: t.referralRebate,
          })),
        }),
      };
    }

    const lines = [
      '',
      `  ${theme.accentBold('VIP TIER LEVELS')}`,
      `  ${theme.separator(65)}`,
      '',
      `  ${'Level'.padEnd(10)} ${'FAF Required'.padEnd(14)} ${'Fee Disc.'.padEnd(12)} ${'Referral'.padEnd(12)} ${'Spot LO'.padEnd(10)} DCA`,
      `  ${theme.separator(65)}`,
    ];

    for (const tier of VIP_TIERS) {
      const marker = tier.level === currentLevel ? chalk.green(' ←') : '';
      const faf = tier.fafRequired === 0 ? '0' : formatFaf(tier.fafRequired);
      lines.push(
        `  ${`Level ${tier.level}`.padEnd(10)} ${faf.padEnd(14)} ${(tier.feeDiscount + '%').padEnd(12)} ${(tier.referralRebate + '%').padEnd(12)} ${(tier.spotLoDiscount + '%').padEnd(10)} ${tier.dcaDiscount}%${marker}`,
      );
    }

    lines.push('');
    lines.push(chalk.dim('  Stake FAF to unlock fee discounts and higher referral rebates.'));
    lines.push('');
    return { success: true, message: lines.join('\n') };
  },
};

// ─── faf rewards ────────────────────────────────────────────────────────────

export const fafRewardsTool: ToolDefinition = {
  name: 'faf_rewards',
  description: 'Show pending FAF rewards and USDC revenue',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const ctx = await getStakeContext(context);
    if ('error' in ctx) return { success: true, message: ctx.error as string };

    const { perpClient, poolConfig, userPk } = ctx;
    const info = await getFafStakeInfo(perpClient, poolConfig, userPk);

    if (!info) {
      return { success: true, message: chalk.dim('  No FAF staking position found. Use "faf stake" to start.') };
    }

    if (IS_AGENT) {
      return {
        success: true,
        message: JSON.stringify({
          action: 'faf_rewards',
          pending_faf: info.pendingRewards,
          pending_usdc: info.pendingRevenue,
        }),
      };
    }

    const lines = [
      '',
      `  ${theme.accentBold('PENDING REWARDS')}`,
      `  ${theme.separator(40)}`,
      '',
      theme.pair(
        'FAF Rewards',
        info.pendingRewards > 0 ? chalk.green(formatFaf(info.pendingRewards)) : chalk.dim('0 FAF'),
      ),
      theme.pair(
        'USDC Revenue',
        info.pendingRevenue > 0 ? chalk.green(formatUsd(info.pendingRevenue)) : chalk.dim('$0.00'),
      ),
      '',
    ];

    if (info.pendingRewards > 0 || info.pendingRevenue > 0) {
      lines.push(chalk.dim('  Use "faf claim" to collect all rewards.'));
      lines.push('');
    }

    return { success: true, message: lines.join('\n') };
  },
};

// ─── faf referral ──────────────────────────────────────────────────────────

export const fafReferralTool: ToolDefinition = {
  name: 'faf_referral',
  description: 'Show referral status, referral PDA, referrer, and claimable rebates',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const ctx = await getStakeContext(context);
    if ('error' in ctx) return { success: true, message: ctx.error as string };

    const { perpClient, poolConfig, userPk } = ctx;
    const info = await getFafStakeInfo(perpClient, poolConfig, userPk);

    const { PublicKey } = await import('@solana/web3.js');
    const programId = poolConfig.programId;

    // Derive user's referral PDA
    const [referralPDA] = PublicKey.findProgramAddressSync([Buffer.from('referral'), userPk.toBuffer()], programId);

    // Check if referral account exists on-chain
    let referralExists = false;
    try {
      const acctInfo = await perpClient.provider.connection.getAccountInfo(referralPDA);
      referralExists = acctInfo !== null;
    } catch {
      /* non-critical */
    }

    // Read claimable rebate from raw account
    let claimableRebateUsd = 0;
    try {
      const raw = info?.rawAccount as Record<string, unknown> | undefined;
      if (raw?.claimableRebateUsd) {
        const BN = (await import('bn.js')).default;
        claimableRebateUsd = new BN(String(raw.claimableRebateUsd)).toNumber() / Math.pow(10, 6);
      }
    } catch {
      /* non-critical */
    }

    const tier = info?.tier;
    const rebateRate = tier?.referralRebate ?? 2;
    const referrerAddr = context.config?.referrerAddress;

    if (IS_AGENT) {
      return {
        success: true,
        message: JSON.stringify({
          action: 'faf_referral',
          referral_pda: referralPDA.toBase58(),
          referral_active: referralExists,
          referrer_address: referrerAddr ?? null,
          claimable_rebate_usd: claimableRebateUsd,
          referral_rebate_rate: rebateRate,
          vip_level: info?.level ?? 0,
        }),
      };
    }

    const lines = [
      '',
      `  ${theme.accentBold('REFERRAL STATUS')}`,
      `  ${theme.separator(50)}`,
      '',
      theme.pair('Referral PDA', referralPDA.toBase58()),
      theme.pair(
        'Account Active',
        referralExists ? chalk.green('Yes') : chalk.yellow('No — auto-created on first trade'),
      ),
      theme.pair('Rebate Rate', `${rebateRate}%`),
      theme.pair('VIP Level', `${info?.level ?? 0}`),
      theme.pair(
        'Claimable Rebates',
        claimableRebateUsd > 0 ? chalk.green(formatUsd(claimableRebateUsd)) : chalk.dim('$0.00'),
      ),
    ];

    if (referrerAddr) {
      lines.push(theme.pair('Referrer', referrerAddr));
    }

    lines.push('');

    if (claimableRebateUsd > 0) {
      lines.push(chalk.dim('  Use "faf claim rebate" to collect referral rebates.'));
      lines.push('');
    }

    return { success: true, message: lines.join('\n') };
  },
};


// ─── faf points (voltage) ──────────────────────────────────────────────────

export const fafPointsTool: ToolDefinition = {
  name: 'faf_points',
  description: 'Show voltage points tier and trade counter',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const ctx = await getStakeContext(context);
    if ('error' in ctx) return { success: true, message: ctx.error as string };

    const { perpClient, poolConfig, userPk } = ctx;
    const voltage = await getVoltageInfo(perpClient, poolConfig, userPk);

    if (!voltage) {
      return {
        success: true,
        message: chalk.dim('  No staking position found. Stake FAF to start earning voltage points.'),
      };
    }

    if (IS_AGENT) {
      return {
        success: true,
        message: JSON.stringify({
          action: 'faf_points',
          tier_name: voltage.tierName,
          multiplier: voltage.multiplier,
          trade_counter: voltage.tradeCounter,
          level: voltage.level,
        }),
      };
    }

    const lines = [
      '',
      `  ${theme.accentBold('VOLTAGE POINTS')}`,
      `  ${theme.separator(40)}`,
      '',
      theme.pair('Trade Counter', `${voltage.tradeCounter} (daily)`),
      '',
      chalk.dim("  Voltage tier and points are tracked by Flash Trade's"),
      chalk.dim('  backend and not available via on-chain data.'),
      chalk.dim('  Check https://flash.trade for your current tier.'),
      '',
    ];

    // Show tier reference table
    lines.push(`  ${'Tier'.padEnd(16)} Multiplier`);
    lines.push(`  ${theme.separator(30)}`);
    for (const vt of VOLTAGE_TIERS) {
      lines.push(`  ${vt.name.padEnd(16)} ${vt.multiplier}x`);
    }
    lines.push('');

    return { success: true, message: lines.join('\n') };
  },
};

// ─── faf unstake requests ──────────────────────────────────────────────────

export const fafUnstakeRequestsTool: ToolDefinition = {
  name: 'faf_unstake_requests',
  description: 'Show pending unstake requests and progress',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const ctx = await getStakeContext(context);
    if ('error' in ctx) return { success: true, message: ctx.error as string };

    const { perpClient, poolConfig, userPk } = ctx;
    const requests = await getFafUnstakeRequests(perpClient, poolConfig, userPk);

    if (requests.length === 0) {
      return { success: true, message: chalk.dim('  No pending unstake requests.') };
    }

    const unlockMs = UNSTAKE_UNLOCK_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();

    if (IS_AGENT) {
      return {
        success: true,
        message: JSON.stringify({
          action: 'faf_unstake_requests',
          requests: requests.map((r) => ({
            index: r.index,
            amount: r.amount,
            start_timestamp: r.timestamp,
            end_timestamp: r.timestamp * 1000 + unlockMs,
            progress_pct: Math.min(100, ((now - r.timestamp * 1000) / unlockMs) * 100),
          })),
        }),
      };
    }

    const lines = [
      '',
      `  ${theme.accentBold('PENDING UNSTAKE REQUESTS')}`,
      `  ${theme.separator(60)}`,
      '',
      `  ${'#'.padEnd(5)} ${'Amount'.padEnd(16)} ${'Started'.padEnd(14)} ${'Est. Complete'.padEnd(14)} Progress`,
      `  ${theme.separator(60)}`,
    ];

    for (const req of requests) {
      const startMs = req.timestamp * 1000;
      const endMs = startMs + unlockMs;
      const elapsed = now - startMs;
      const progress = Math.min(100, Math.max(0, (elapsed / unlockMs) * 100));

      const startDate = new Date(startMs).toLocaleDateString();
      const endDate = new Date(endMs).toLocaleDateString();
      const progressStr = progress >= 100 ? chalk.green('READY') : `${progress.toFixed(1)}%`;

      lines.push(
        `  ${String(req.index).padEnd(5)} ${formatFaf(req.amount).padEnd(16)} ${startDate.padEnd(14)} ${endDate.padEnd(14)} ${progressStr}`,
      );
    }

    lines.push('');
    lines.push(chalk.dim(`  Unstake period: ${UNSTAKE_UNLOCK_DAYS} days linear unlock.`));
    lines.push(chalk.dim('  Use "faf cancel <index>" to cancel a request.'));
    lines.push('');

    return { success: true, message: lines.join('\n') };
  },
};

// ─── faf cancel unstake ────────────────────────────────────────────────────

export const fafCancelUnstakeTool: ToolDefinition = {
  name: 'faf_cancel_unstake',
  description: 'Cancel a pending unstake request by index',
  parameters: z.object({
    requestId: z.number().min(0).describe('Index of the unstake request to cancel'),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { requestId } = params as { requestId: number };
    const ctx = await getStakeContext(context);
    if ('error' in ctx) return { success: false, message: ctx.error as string };

    if (!Number.isFinite(requestId) || requestId < 0) {
      return { success: false, message: chalk.red('  Request index must be a non-negative number.') };
    }

    const { client, perpClient, poolConfig, userPk } = ctx;

    // Validate the request exists
    const requests = await getFafUnstakeRequests(perpClient, poolConfig, userPk);
    const target = requests.find((r) => r.index === requestId);
    if (!target) {
      return {
        success: false,
        message: chalk.red(`  No unstake request found at index ${requestId}. Use "faf requests" to list.`),
      };
    }

    try {
      const result = await perpClient.cancelUnstakeTokenRequest(userPk, requestId, poolConfig);
      const sig = await client.sendTx(result.instructions, result.additionalSigners, poolConfig);

      const lines = [
        '',
        `  ${theme.accentBold('UNSTAKE REQUEST CANCELLED')}`,
        '',
        theme.pair('Request #', String(requestId)),
        theme.pair('Amount', formatFaf(target.amount)),
        '',
        chalk.dim('  Tokens returned to staked balance.'),
        '',
        `  ${chalk.dim('Tx:')} ${sig}`,
        '',
      ];
      return { success: true, message: lines.join('\n'), txSignature: sig };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  FAF cancel unstake failed: ${getErrorMessage(err)}`) };
    }
  },
};

// ─── Export All ──────────────────────────────────────────────────────────────

export const allFafTools: ToolDefinition[] = [
  fafStatusTool,
  fafStakeTool,
  fafUnstakeTool,
  fafClaimTool,
  fafTierTool,
  fafRewardsTool,
  fafReferralTool,
  fafPointsTool,
  fafUnstakeRequestsTool,
  fafCancelUnstakeTool,
];
