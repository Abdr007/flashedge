import { z } from 'zod';
import { ToolDefinition, ToolResult } from '../types/index.js';
import { formatUsd } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import chalk from 'chalk';
import { theme } from '../cli/theme.js';
import { getPoolRegistry, resolvePool, resolveTokenMint } from '../earn/pool-registry.js';
import { getPoolMetrics, getPoolMetric } from '../earn/pool-data.js';
import { recordEarnAction, getEarnJournal } from '../earn/earn-journal.js';
import { IS_AGENT } from '../no-dna.js';

const NOT_AVAILABLE_MSG = chalk.yellow(
  '  Earn features are not available in simulation mode. Connect a wallet for live LP/staking.',
);

function poolNotFound(name: string): ToolResult {
  const pools = getPoolRegistry();
  const lines = ['', chalk.red(`  Unknown pool: "${name}"`), '', chalk.dim('  Available pools:'), ''];
  for (const p of pools) {
    lines.push(`    ${chalk.cyan(p.aliases[0].padEnd(12))} ${p.displayName}`);
  }
  lines.push('');
  return { success: false, message: lines.join('\n') };
}

// ─── earn pools ─────────────────────────────────────────────────────────────

export const earnPoolsTool: ToolDefinition = {
  name: 'earn_status',
  description: 'View all pools with live yield metrics',
  parameters: z.object({}),
  execute: async (_params, _context): Promise<ToolResult> => {
    const registry = getPoolRegistry();
    const metrics = await getPoolMetrics();

    if (IS_AGENT) {
      const poolData = registry.map((p) => {
        const m = metrics.get(p.poolId);
        return {
          pool_id: p.poolId,
          display_name: p.displayName,
          alias: p.aliases[0],
          flp: p.flpSymbol,
          sflp: p.sflpSymbol,
          assets: p.assets,
          fee_share: p.feeShare,
          tvl: m?.tvl ?? 0,
          apy_7d: m?.apy7d ?? 0,
          apr_7d: m?.apr7d ?? 0,
          flp_price: m?.flpPrice ?? 0,
          sflp_price: m?.sflpPrice ?? 0,
        };
      });
      return { success: true, message: JSON.stringify({ action: 'earn_pools', pools: poolData }) };
    }

    const lines = [
      '',
      `  ${theme.accentBold('FLASH LIQUIDITY POOLS')}`,
      '',
      `  ${'Pool'.padEnd(12)} ${'TVL'.padEnd(10)} ${'FLP'.padEnd(10)} ${'sFLP'.padEnd(10)} ${'Est. APY'.padEnd(12)} ${'Fee %'.padEnd(8)} Assets`,
      `  ${theme.separator(72)}`,
    ];

    for (const pool of registry) {
      const m = metrics.get(pool.poolId);
      const tvl = m?.tvl ? (m.tvl >= 1e6 ? `$${(m.tvl / 1e6).toFixed(1)}M` : `$${(m.tvl / 1e3).toFixed(0)}K`) : '-';
      const flp = m?.flpPrice ? `$${m.flpPrice.toFixed(3)}` : '-';
      const sflp = m?.sflpPrice ? `$${m.sflpPrice.toFixed(3)}` : '-';
      const apy = m?.apy7d ? `~${m.apy7d.toFixed(1)}%` : '-';
      const fee = `${(pool.feeShare * 100).toFixed(0)}%`;
      const assets = pool.assets.slice(0, 3).join(' ');
      lines.push(
        `  ${chalk.cyan(pool.aliases[0].padEnd(12))} ${tvl.padEnd(10)} ${chalk.green(flp.padEnd(10))} ${sflp.padEnd(10)} ${chalk.green(apy.padEnd(12))} ${fee.padEnd(8)} ${chalk.dim(assets)}`,
      );
    }

    lines.push('');
    lines.push(`  ${theme.section('Commands')}`);
    lines.push('');
    lines.push(`    ${chalk.cyan('earn info <pool>')}            Pool details`);
    lines.push(`    ${chalk.cyan('earn deposit <pool> <$>')}     Mint FLP (auto-compound)`);
    lines.push(`    ${chalk.cyan('earn withdraw <pool> <%>')}    Burn FLP → USDC`);
    lines.push(`    ${chalk.cyan('earn stake <pool> <$>')}       Mint sFLP (USDC rewards)`);
    lines.push(`    ${chalk.cyan('earn unstake <pool> <%>')}     Burn sFLP → USDC`);
    lines.push(`    ${chalk.cyan('earn claim <pool>')}           Claim sFLP rewards`);
    lines.push(`    ${chalk.cyan('earn positions')}              Your active positions`);
    lines.push('');

    return { success: true, message: lines.join('\n') };
  },
};

// ─── earn info <pool> ───────────────────────────────────────────────────────

export const earnInfoTool: ToolDefinition = {
  name: 'earn_info',
  description: 'View detailed pool information',
  parameters: z.object({
    pool: z.string().max(30).optional(),
  }),
  execute: async (params, _context): Promise<ToolResult> => {
    const { pool: poolAlias } = params as { pool?: string };
    const poolName = poolAlias ?? 'crypto';
    const pool = resolvePool(poolName);
    if (!pool) return poolNotFound(poolName);

    const m = await getPoolMetric(pool.poolId);

    if (IS_AGENT) {
      return {
        success: true,
        message: JSON.stringify({
          action: 'earn_info',
          pool_id: pool.poolId,
          display_name: pool.displayName,
          assets: pool.assets,
          fee_share: pool.feeShare,
          flp: pool.flpSymbol,
          sflp: pool.sflpSymbol,
          tvl: m?.tvl ?? 0,
          apy_7d: m?.apy7d ?? 0,
          apr_7d: m?.apr7d ?? 0,
          flp_price: m?.flpPrice ?? 0,
          sflp_price: m?.sflpPrice ?? 0,
        }),
      };
    }

    const lines = [
      '',
      `  ${theme.accentBold(pool.displayName)}`,
      `  ${theme.separator(40)}`,
      '',
      theme.pair('Pool ID', pool.poolId),
      theme.pair('Fee Share', `${(pool.feeShare * 100).toFixed(0)}%`),
      '',
      theme.pair('FLP Token', `${pool.flpSymbol}${m?.flpPrice ? ` ($${m.flpPrice.toFixed(3)})` : ''}`),
      theme.pair('sFLP Token', `${pool.sflpSymbol}${m?.sflpPrice ? ` ($${m.sflpPrice.toFixed(3)})` : ''}`),
      '',
    ];

    if (m) {
      if (m.tvl > 0) lines.push(theme.pair('TVL', formatUsd(m.tvl)));
      if (m.weeklyLpFees > 0) lines.push(theme.pair('7D LP Fees', chalk.green(formatUsd(m.weeklyLpFees))));
      if (m.totalVolume > 0) lines.push(theme.pair('Total Volume', formatUsd(m.totalVolume)));
      if (m.totalFees > 0) lines.push(theme.pair('Total Fees', formatUsd(m.totalFees)));
      if (m.totalTrades > 0) lines.push(theme.pair('Total Trades', m.totalTrades.toLocaleString()));
      if (m.apy7d > 0) lines.push(theme.pair('Est. APY', chalk.green(`~${m.apy7d.toFixed(1)}%`)));
      lines.push('');
    }

    lines.push(`  ${theme.dim('Assets:')} ${pool.assets.join(', ')}`);
    lines.push('');
    lines.push(`  ${theme.dim('FLP = auto-compound (fees grow token value)')}`);
    lines.push(`  ${theme.dim('sFLP = staked (fees paid in USDC hourly)')}`);
    lines.push('');

    return { success: true, message: lines.join('\n') };
  },
};

// ─── earn deposit (FLP) ─────────────────────────────────────────────────────

export const earnAddLiquidityTool: ToolDefinition = {
  name: 'earn_add_liquidity',
  description: 'Deposit USDC → mint FLP (auto-compounding)',
  parameters: z.object({
    token: z.string().max(20).default('USDC'),
    amount: z.number().positive(),
    pool: z.string().max(30).optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { amount, pool: poolAlias } = params as { token: string; amount: number; pool?: string };
    const client = context.flashClient;
    if (!client.addLiquidity) return { success: false, message: NOT_AVAILABLE_MSG };

    let poolName = poolAlias ?? 'Crypto.1';

    // Auto-route: "earn best 500" → deposit into top-ranked pool
    if (poolName === '__best__') {
      try {
        const { rankPools } = await import('../earn/yield-analytics.js');
        const ranked = await rankPools();
        if (ranked.length > 0) {
          poolName = ranked[0].pool.poolId;
        } else {
          poolName = 'Crypto.1'; // fallback
        }
      } catch {
        poolName = 'Crypto.1';
      }
    }

    const pool = resolvePool(poolName);
    if (!pool) return poolNotFound(poolName);

    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: chalk.red('  Amount must be a positive number.') };
    }

    // Fetch FLP price for deposit preview
    const m = await getPoolMetric(pool.poolId);
    const flpPrice = m?.flpPrice ?? 0;
    const flpEstimate = flpPrice > 0 ? amount / flpPrice : 0;

    const previewLines = [
      '',
      `  ${theme.accentBold('DEPOSIT PREVIEW')}`,
      `  ${theme.separator(35)}`,
      theme.pair('Pool', pool.displayName),
      theme.pair('Deposit', formatUsd(amount) + ' USDC'),
    ];
    if (flpPrice > 0) {
      previewLines.push(theme.pair('FLP Price', `$${flpPrice.toFixed(3)}`));
      previewLines.push(theme.pair('Est. Receive', `~${flpEstimate.toFixed(2)} ${pool.flpSymbol} (auto-compound)`));
    }
    if (m?.apy7d) {
      previewLines.push(theme.pair('Est. APY', chalk.green(`~${m.apy7d.toFixed(1)}%`)));
      const yearlyReturn = (amount * m.apy7d) / 100;
      if (Number.isFinite(yearlyReturn) && yearlyReturn > 0) {
        previewLines.push(
          theme.pair('Est. Yearly Return', chalk.green(`~${formatUsd(yearlyReturn)} (at current APY)`)),
        );
      }
    }
    previewLines.push('');

    return {
      success: true,
      message: previewLines.join('\n'),
      requiresConfirmation: true,
      confirmationPrompt: 'Type "yes" to sign or "no" to cancel',
      data: {
        executeAction: async (): Promise<ToolResult> => {
          try {
            const result = await client.addLiquidity!('USDC', amount, pool.poolId);
            recordEarnAction({
              pool: pool.poolId,
              action: 'deposit',
              amountUsd: amount,
              timestamp: Date.now(),
              txSignature: result.txSignature,
            });
            const lines = [
              '',
              `  ${theme.accentBold('DEPOSIT CONFIRMED')}`,
              '',
              theme.pair('Pool', pool.displayName),
              theme.pair('Deposited', formatUsd(amount) + ' USDC'),
              theme.pair('Received', pool.flpSymbol + ' (auto-compound)'),
              '',
              `  ${chalk.dim('Tx:')} ${result.txSignature}`,
              '',
            ];
            return { success: true, message: lines.join('\n'), txSignature: result.txSignature };
          } catch (err: unknown) {
            return { success: false, message: chalk.red(`  Deposit failed: ${getErrorMessage(err)}`) };
          }
        },
      },
    };
  },
};

// ─── earn withdraw (FLP) ────────────────────────────────────────────────────

export const earnRemoveLiquidityTool: ToolDefinition = {
  name: 'earn_remove_liquidity',
  description: 'Burn FLP → receive USDC',
  parameters: z.object({
    token: z.string().max(20).default('USDC'),
    percent: z.number().min(1).max(100),
    pool: z.string().max(30).optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { percent, pool: poolAlias } = params as { token: string; percent: number; pool?: string };
    const client = context.flashClient;
    if (!client.removeLiquidity) return { success: false, message: NOT_AVAILABLE_MSG };

    if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
      return { success: false, message: chalk.red('  Percentage must be between 1 and 100.') };
    }

    const poolName = poolAlias ?? 'Crypto.1';
    const pool = resolvePool(poolName);
    if (!pool) return poolNotFound(poolName);

    // Estimate withdrawal value from FLP balance × FLP price × (percent/100)
    const m = await getPoolMetric(pool.poolId);

    try {
      const result = await client.removeLiquidity('USDC', percent, pool.poolId);
      // Estimate withdrawn USD from FLP price and percent
      if (m?.flpPrice && m.flpPrice > 0) {
        // Get current position value from token balances
        let positionValue = 0;
        const wm = context.walletManager;
        if (wm && wm.isConnected) {
          try {
            const tokenData = await wm.getTokenBalances();
            if (tokenData) {
              for (const token of tokenData.tokens) {
                const resolved = resolveTokenMint(token.mint);
                if (resolved && resolved.pool.poolId === pool.poolId && resolved.type === 'FLP') {
                  // Balance already reduced by withdraw — estimate pre-withdraw balance
                  const preWithdrawBalance = token.amount / (1 - percent / 100);
                  positionValue = preWithdrawBalance * m.flpPrice;
                  break;
                }
              }
            }
          } catch {
            /* non-critical */
          }
        }
        const estimatedWithdraw = positionValue > 0 ? positionValue * (percent / 100) : 0;
        if (estimatedWithdraw > 0) {
          recordEarnAction({
            pool: pool.poolId,
            action: 'withdraw',
            amountUsd: estimatedWithdraw,
            timestamp: Date.now(),
            txSignature: result.txSignature,
          });
        }
      }
      const lines = [
        '',
        `  ${theme.accentBold('WITHDRAWAL CONFIRMED')}`,
        '',
        theme.pair('Pool', pool.displayName),
        theme.pair('Withdrawn', `${percent}% of ${pool.flpSymbol}`),
        theme.pair('Received', 'USDC'),
        '',
        `  ${chalk.dim('Tx:')} ${result.txSignature}`,
        '',
      ];
      return { success: true, message: lines.join('\n'), txSignature: result.txSignature };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  Withdrawal failed: ${getErrorMessage(err)}`) };
    }
  },
};

// ─── earn stake (sFLP) ──────────────────────────────────────────────────────

export const earnStakeTool: ToolDefinition = {
  name: 'earn_stake',
  description: 'Deposit USDC → mint sFLP (USDC rewards)',
  parameters: z.object({
    amount: z.number().positive(),
    pool: z.string().max(30).optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { amount, pool: poolAlias } = params as { amount: number; pool?: string };
    const client = context.flashClient;
    if (!client.stakeFLP) return { success: false, message: NOT_AVAILABLE_MSG };

    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: chalk.red('  Amount must be a positive number.') };
    }

    const poolName = poolAlias ?? 'Crypto.1';
    const pool = resolvePool(poolName);
    if (!pool) return poolNotFound(poolName);

    try {
      const result = await client.stakeFLP(amount, pool.poolId);
      // Stake is an sFLP operation — not a USDC in/out flow, so don't record in PnL journal
      const lines = [
        '',
        `  ${theme.accentBold('STAKE CONFIRMED')}`,
        '',
        theme.pair('Pool', pool.displayName),
        theme.pair('Staked', formatUsd(amount) + ' USDC'),
        theme.pair('Received', pool.sflpSymbol + ' (USDC rewards)'),
        '',
        `  ${chalk.dim('Tx:')} ${result.txSignature}`,
        '',
      ];
      return { success: true, message: lines.join('\n'), txSignature: result.txSignature };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  Stake failed: ${getErrorMessage(err)}`) };
    }
  },
};

// ─── earn unstake (sFLP) ────────────────────────────────────────────────────

export const earnUnstakeTool: ToolDefinition = {
  name: 'earn_unstake',
  description: 'Burn sFLP → receive USDC',
  parameters: z.object({
    percent: z.number().min(1).max(100),
    pool: z.string().max(30).optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { percent, pool: poolAlias } = params as { percent: number; pool?: string };
    const client = context.flashClient;
    if (!client.unstakeFLP) return { success: false, message: NOT_AVAILABLE_MSG };

    if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
      return { success: false, message: chalk.red('  Percentage must be between 1 and 100.') };
    }

    const poolName = poolAlias ?? 'Crypto.1';
    const pool = resolvePool(poolName);
    if (!pool) return poolNotFound(poolName);

    try {
      const result = await client.unstakeFLP(percent, pool.poolId);
      // Unstake is an sFLP operation — not a USDC in/out flow, so don't record in PnL journal
      const lines = [
        '',
        `  ${theme.accentBold('UNSTAKE CONFIRMED')}`,
        '',
        theme.pair('Pool', pool.displayName),
        theme.pair('Unstaked', `${percent}% of ${pool.sflpSymbol}`),
        theme.pair('Received', 'USDC'),
        '',
        `  ${chalk.dim('Tx:')} ${result.txSignature}`,
        '',
      ];
      return { success: true, message: lines.join('\n'), txSignature: result.txSignature };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  Unstake failed: ${getErrorMessage(err)}`) };
    }
  },
};

// ─── earn claim ─────────────────────────────────────────────────────────────

export const earnClaimRewardsTool: ToolDefinition = {
  name: 'earn_claim_rewards',
  description: 'Claim pending sFLP rewards (USDC)',
  parameters: z.object({
    pool: z.string().max(30).optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { pool: poolAlias } = params as { pool?: string };
    const client = context.flashClient;
    if (!client.claimRewards) return { success: false, message: NOT_AVAILABLE_MSG };

    const poolName = poolAlias ?? 'Crypto.1';
    const pool = resolvePool(poolName);
    if (!pool) return poolNotFound(poolName);

    const previewLines = [
      '',
      `  ${theme.accentBold('CLAIM REWARDS')}`,
      `  ${theme.separator(35)}`,
      theme.pair('Pool', pool.displayName),
      theme.pair('Action', 'Claim sFLP staking rewards'),
      '',
    ];

    return {
      success: true,
      message: previewLines.join('\n'),
      requiresConfirmation: true,
      confirmationPrompt: 'Type "yes" to sign or "no" to cancel',
      data: {
        executeAction: async (): Promise<ToolResult> => {
          try {
            const result = await client.claimRewards!(pool.poolId);
            const lines = [
              '',
              `  ${theme.accentBold('REWARDS CLAIMED')}`,
              '',
              theme.pair('Pool', pool.displayName),
              theme.pair('Received', 'USDC rewards'),
              '',
              `  ${chalk.dim('Tx:')} ${result.txSignature}`,
              '',
            ];
            return { success: true, message: lines.join('\n'), txSignature: result.txSignature };
          } catch (err: unknown) {
            return { success: false, message: chalk.red(`  Claim failed: ${getErrorMessage(err)}`) };
          }
        },
      },
    };
  },
};

// ─── earn positions ─────────────────────────────────────────────────────────

export const earnPositionsTool: ToolDefinition = {
  name: 'earn_positions',
  description: 'View your active liquidity positions',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const wm = context.walletManager;
    if (!wm || !wm.isConnected) {
      return { success: true, message: chalk.dim('  No wallet connected.') };
    }

    const _registry = getPoolRegistry();
    const metrics = await getPoolMetrics();

    // Get all token balances
    let tokenData: { sol: number; tokens: Array<{ mint: string; amount: number }> } | null;
    try {
      tokenData = await wm.getTokenBalances();
    } catch {
      return { success: false, message: chalk.red('  Failed to fetch token balances.') };
    }

    if (!tokenData) {
      return { success: true, message: chalk.dim('  No token data available.') };
    }

    const positions: Array<{ pool: string; type: string; balance: number; value: number; rewards: string }> = [];

    // Check token accounts for FLP (compounding) positions
    for (const token of tokenData.tokens) {
      const resolved = resolveTokenMint(token.mint);
      if (!resolved) continue;

      const { pool, type } = resolved;
      const m = metrics.get(pool.poolId);
      const price = type === 'FLP' ? (m?.flpPrice ?? 0) : (m?.sflpPrice ?? 0);
      const value = token.amount * price;

      if (token.amount > 0.001) {
        positions.push({
          pool: pool.aliases[0],
          type,
          balance: token.amount,
          value,
          rewards: type === 'sFLP' ? 'USDC hourly' : 'auto-compound',
        });
      }
    }

    // Check FlpStakeAccount PDAs for sFLP (staked) positions
    // sFLP is stored in program PDAs, not as regular token accounts
    try {
      const { PublicKey } = await import('@solana/web3.js');
      const { BN } = await import('bn.js');
      const flashClient =
        context.flashClient as unknown as import('../types/flash-sdk-interfaces.js').FlashClientInternals;
      if (flashClient?.perpClient?.program?.coder && flashClient?.connection) {
        const registry = getPoolRegistry();
        const walletPk = new PublicKey(context.walletAddress);
        for (const pool of registry) {
          try {
            const [pda] = PublicKey.findProgramAddressSync(
              [Buffer.from('stake'), walletPk.toBuffer(), pool.poolConfig.poolAddress.toBuffer()],
              pool.poolConfig.programId,
            );
            const info = await flashClient.connection.getAccountInfo(pda);
            if (!info) continue;
            const decoded = flashClient.perpClient.program.coder.accounts.decode('flpStake', info.data) as {
              stakeStats: { activeAmount: { toString(): string }; pendingActivation: { toString(): string } };
            };
            const active = new BN(decoded.stakeStats.activeAmount.toString());
            const pending = new BN(decoded.stakeStats.pendingActivation.toString());
            const total = active.add(pending).toNumber() / Math.pow(10, pool.lpDecimals);
            if (total > 0.001) {
              const m = metrics.get(pool.poolId);
              const price = m?.sflpPrice ?? 0;
              positions.push({
                pool: pool.aliases[0],
                type: 'sFLP',
                balance: total,
                value: total * price,
                rewards: 'USDC hourly',
              });
            }
          } catch {
            /* skip pool on error */
          }
        }
      }
    } catch {
      /* non-critical — staking PDA check failed */
    }

    if (positions.length === 0) {
      return {
        success: true,
        message: [
          '',
          chalk.dim('  No active earn positions.'),
          chalk.dim('  Use "earn deposit <pool> <amount>" to start earning.'),
          '',
        ].join('\n'),
      };
    }

    if (IS_AGENT) {
      return { success: true, message: JSON.stringify({ action: 'earn_positions', positions }) };
    }

    const lines = [
      '',
      `  ${theme.accentBold('YOUR EARN POSITIONS')}`,
      '',
      `  ${'Pool'.padEnd(12)} ${'Type'.padEnd(8)} ${'Balance'.padEnd(14)} ${'Value'.padEnd(12)} Rewards`,
      `  ${theme.separator(60)}`,
    ];

    for (const pos of positions) {
      lines.push(
        `  ${chalk.cyan(pos.pool.padEnd(12))} ${pos.type.padEnd(8)} ${pos.balance.toFixed(4).padEnd(14)} ${formatUsd(pos.value).padEnd(12)} ${chalk.dim(pos.rewards)}`,
      );
    }

    lines.push('');
    return { success: true, message: lines.join('\n') };
  },
};

// ─── earn best (pool ranking) ───────────────────────────────────────────────

export const earnBestTool: ToolDefinition = {
  name: 'earn_best',
  description: 'Rank pools by yield with risk assessment',
  parameters: z.object({}),
  execute: async (_params, _context): Promise<ToolResult> => {
    const { rankPools } = await import('../earn/yield-analytics.js');
    const ranked = await rankPools();

    if (ranked.length === 0) {
      return { success: false, message: chalk.dim('  Unable to fetch pool metrics.') };
    }

    if (IS_AGENT) {
      return {
        success: true,
        message: JSON.stringify({
          action: 'earn_best',
          pools: ranked.map((r, i) => ({
            rank: i + 1,
            pool: r.pool.aliases[0],
            pool_id: r.pool.poolId,
            apy: r.metrics.apy7d,
            tvl: r.metrics.tvl,
            risk: r.risk,
            score: r.score,
          })),
        }),
      };
    }

    const riskColor = (r: string) => {
      if (r === 'Low') return chalk.green(r);
      if (r === 'Medium') return chalk.yellow(r);
      if (r === 'High') return chalk.red(r);
      return chalk.bgRed.white(` ${r} `);
    };

    const lines = ['', `  ${theme.accentBold('TOP YIELD POOLS')}`, `  ${theme.separator(50)}`, ''];

    for (let i = 0; i < ranked.length; i++) {
      const r = ranked[i];
      const apy = r.metrics.apy7d > 0 ? `~${r.metrics.apy7d.toFixed(1)}%` : '-';
      lines.push(`  ${chalk.bold(`${i + 1}.`)} ${chalk.cyan(r.pool.displayName)}`);
      lines.push(`     Est. APY: ${chalk.green(apy)}   TVL: ${formatUsd(r.metrics.tvl)}   Risk: ${riskColor(r.risk)}`);
      lines.push(
        `     FLP: $${r.metrics.flpPrice.toFixed(3)}   Fee Share: ${(r.pool.feeShare * 100).toFixed(0)}%   Assets: ${r.pool.assets.slice(0, 3).join(', ')}`,
      );
      lines.push('');
    }

    return { success: true, message: lines.join('\n') };
  },
};

// ─── earn simulate ──────────────────────────────────────────────────────────

export const earnSimulateTool: ToolDefinition = {
  name: 'earn_simulate',
  description: 'Project yield returns for a deposit',
  parameters: z.object({
    pool: z.string().max(30).optional(),
    amount: z.number().positive(),
  }),
  execute: async (params, _context): Promise<ToolResult> => {
    const { pool: poolAlias, amount } = params as { pool?: string; amount: number };

    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: chalk.red('  Amount must be a positive number.') };
    }

    const poolName = poolAlias ?? 'Crypto.1';
    const pool = resolvePool(poolName);
    if (!pool) return poolNotFound(poolName);

    const m = await getPoolMetric(pool.poolId);
    if (!m) {
      return { success: false, message: chalk.dim('  Pool data unavailable. Try again later.') };
    }

    if (m.apy7d === 0) {
      return { success: true, message: chalk.dim('  Yield data unavailable. Try again later.') };
    }

    const { simulateYield } = await import('../earn/yield-analytics.js');
    const proj = simulateYield(amount, m.apy7d);

    if (IS_AGENT) {
      return {
        success: true,
        message: JSON.stringify({
          action: 'earn_simulate',
          pool: pool.aliases[0],
          pool_id: pool.poolId,
          ...proj,
        }),
      };
    }

    const lines = [
      '',
      `  ${theme.accentBold(`${pool.displayName} — Yield Projection`)}`,
      `  ${theme.separator(45)}`,
      '',
      theme.pair('Deposit', formatUsd(amount)),
      theme.pair('Est. APY', chalk.green(`~${m.apy7d.toFixed(2)}%`)),
      theme.pair('FLP Price', `$${m.flpPrice.toFixed(3)}`),
      theme.pair('Pool TVL', formatUsd(m.tvl)),
      '',
      `  ${theme.section('Estimated Returns')}`,
      '',
      theme.pair('Daily Return', chalk.green(`~+${formatUsd(proj.days7 / 7)}`)),
      theme.pair('Weekly Return', chalk.green(`~+${formatUsd(proj.days7)}`)),
      theme.pair('Monthly Return', chalk.green(`~+${formatUsd(proj.days30)}`)),
      theme.pair('Yearly Return', chalk.green(`~+${formatUsd(proj.days365)}`)),
      theme.pair('Projected Value (1yr)', chalk.green(formatUsd(amount + proj.days365))),
      '',
      chalk.dim('  * Based on 7-day trading volume and on-chain fee rates.'),
    ];
    if (m.apy7d > 500) {
      lines.push(chalk.dim('  * APY is volatile. Actual returns may differ significantly.'));
    }
    lines.push('');

    return { success: true, message: lines.join('\n') };
  },
};

// ─── earn dashboard ─────────────────────────────────────────────────────────

export const earnDashboardTool: ToolDefinition = {
  name: 'earn_dashboard',
  description: 'Liquidity portfolio overview with all positions',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const wm = context.walletManager;
    if (!wm || !wm.isConnected) {
      return { success: true, message: chalk.dim('  No wallet connected.') };
    }

    const _registry = getPoolRegistry();
    const metrics = await getPoolMetrics();

    let tokenData: { sol: number; tokens: Array<{ mint: string; amount: number }> } | null;
    try {
      tokenData = await wm.getTokenBalances();
    } catch {
      return { success: false, message: chalk.red('  Failed to fetch balances.') };
    }
    if (!tokenData) return { success: true, message: chalk.dim('  No token data.') };

    let totalValue = 0;
    const positions: Array<{ pool: string; type: string; value: number; apy: number }> = [];

    for (const token of tokenData.tokens) {
      const resolved = resolveTokenMint(token.mint);
      if (!resolved || token.amount < 0.001) continue;
      const { pool, type } = resolved;
      const m = metrics.get(pool.poolId);
      const price = type === 'FLP' ? (m?.flpPrice ?? 0) : (m?.sflpPrice ?? 0);
      const value = token.amount * price;
      totalValue += value;
      positions.push({
        pool: pool.aliases[0],
        type,
        value,
        apy: type === 'FLP' ? (m?.apy7d ?? 0) : (m?.apr7d ?? 0),
      });
    }

    if (IS_AGENT) {
      return {
        success: true,
        message: JSON.stringify({
          action: 'earn_dashboard',
          total_value: totalValue,
          positions,
        }),
      };
    }

    const lines = [
      '',
      `  ${theme.accentBold('FLASH EARN PORTFOLIO')}`,
      `  ${theme.separator(45)}`,
      '',
      theme.pair('Total Value', totalValue > 0 ? chalk.green(formatUsd(totalValue)) : formatUsd(0)),
      '',
    ];

    if (positions.length === 0) {
      lines.push(chalk.dim('  No active positions.'));
      lines.push(chalk.dim('  Use "earn deposit <pool> <amount>" to start earning.'));
    } else {
      lines.push(`  ${'Pool'.padEnd(12)} ${'Type'.padEnd(8)} ${'Value'.padEnd(12)} APY`);
      lines.push(`  ${theme.separator(45)}`);
      for (const pos of positions) {
        lines.push(
          `  ${chalk.cyan(pos.pool.padEnd(12))} ${pos.type.padEnd(8)} ${formatUsd(pos.value).padEnd(12)} ${chalk.green(pos.apy.toFixed(1) + '%')}`,
        );
      }
    }

    lines.push('');
    return { success: true, message: lines.join('\n') };
  },
};

// ─── earn pnl ───────────────────────────────────────────────────────────────

export const earnPnlTool: ToolDefinition = {
  name: 'earn_pnl',
  description: 'Track liquidity profit & loss',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const wm = context.walletManager;
    if (!wm || !wm.isConnected) return { success: true, message: chalk.dim('  No wallet connected.') };

    const _registry = getPoolRegistry();
    const metrics = await getPoolMetrics();

    let tokenData: { sol: number; tokens: Array<{ mint: string; amount: number }> } | null;
    try {
      tokenData = await wm.getTokenBalances();
    } catch {
      return { success: false, message: chalk.red('  Failed to fetch balances.') };
    }
    if (!tokenData) return { success: true, message: chalk.dim('  No token data.') };

    let totalValue = 0;
    const positions: Array<{ pool: string; type: string; tokens: number; value: number; price: number }> = [];

    for (const token of tokenData.tokens) {
      const resolved = resolveTokenMint(token.mint);
      if (!resolved || token.amount < 0.001) continue;
      const { pool, type } = resolved;
      const m = metrics.get(pool.poolId);
      const price = type === 'FLP' ? (m?.flpPrice ?? 0) : (m?.sflpPrice ?? 0);
      const value = token.amount * price;
      totalValue += value;
      positions.push({ pool: pool.aliases[0], type, tokens: token.amount, value, price });
    }

    // Journal-based PnL: sum deposits/withdrawals per pool
    const journal = getEarnJournal();
    const poolTotals = new Map<string, { deposited: number; withdrawn: number }>();
    for (const entry of journal) {
      const t = poolTotals.get(entry.pool) ?? { deposited: 0, withdrawn: 0 };
      if (entry.action === 'deposit') {
        t.deposited += entry.amountUsd;
      } else if (entry.action === 'withdraw') {
        t.withdrawn += entry.amountUsd;
      }
      poolTotals.set(entry.pool, t);
    }

    let totalDeposited = 0;
    let totalWithdrawn = 0;
    for (const t of poolTotals.values()) {
      totalDeposited += t.deposited;
      totalWithdrawn += t.withdrawn;
    }
    // PnL = current_value + total_withdrawn - total_deposited
    const pnl = totalValue + totalWithdrawn - totalDeposited;
    const hasJournal = journal.length > 0;

    if (IS_AGENT) {
      return {
        success: true,
        message: JSON.stringify({
          action: 'earn_pnl',
          total_value: totalValue,
          total_deposited: totalDeposited,
          total_withdrawn: totalWithdrawn,
          pnl,
          positions,
        }),
      };
    }

    const lines = [
      '',
      `  ${theme.accentBold('EARN PERFORMANCE')}`,
      `  ${theme.separator(55)}`,
      '',
      theme.pair('Current Value', totalValue > 0 ? chalk.green(formatUsd(totalValue)) : formatUsd(0)),
    ];

    if (hasJournal) {
      lines.push(theme.pair('Total Deposited', formatUsd(totalDeposited)));
      if (totalWithdrawn > 0) lines.push(theme.pair('Total Withdrawn', formatUsd(totalWithdrawn)));
      const pnlStr = pnl >= 0 ? chalk.green(`+${formatUsd(pnl)}`) : chalk.red(formatUsd(pnl));
      lines.push(theme.pair('PnL', pnlStr));
    }

    lines.push('');

    if (positions.length === 0) {
      lines.push(chalk.dim('  No active positions.'));
    } else {
      lines.push(`  ${'Pool'.padEnd(12)} ${'Type'.padEnd(8)} ${'Tokens'.padEnd(12)} ${'Value'.padEnd(12)} Price`);
      lines.push(`  ${theme.separator(55)}`);
      for (const pos of positions) {
        lines.push(
          `  ${chalk.cyan(pos.pool.padEnd(12))} ${pos.type.padEnd(8)} ${pos.tokens.toFixed(2).padEnd(12)} ${formatUsd(pos.value).padEnd(12)} $${pos.price.toFixed(3)}`,
        );
      }
    }

    if (!hasJournal) {
      lines.push('');
      lines.push(chalk.dim('  * No deposit history yet. PnL will be tracked after your first deposit.'));
    }

    lines.push('');
    return { success: true, message: lines.join('\n') };
  },
};

// ─── earn demand ────────────────────────────────────────────────────────────

export const earnDemandTool: ToolDefinition = {
  name: 'earn_demand',
  description: 'Analyze liquidity demand across pools',
  parameters: z.object({}),
  execute: async (_params, _context): Promise<ToolResult> => {
    const _registry = getPoolRegistry();
    const _metrics = await getPoolMetrics();
    const { rankPools } = await import('../earn/yield-analytics.js');
    const ranked = await rankPools();

    if (IS_AGENT) {
      return {
        success: true,
        message: JSON.stringify({
          action: 'earn_demand',
          pools: ranked.map((r) => ({
            pool: r.pool.aliases[0],
            apy: r.metrics.apy7d,
            apr: r.metrics.apr7d,
            tvl: r.metrics.tvl,
            fee_share: r.pool.feeShare,
            risk: r.risk,
          })),
        }),
      };
    }

    // Higher APY relative to TVL = higher demand per dollar of liquidity
    const lines = [
      '',
      `  ${theme.accentBold('LIQUIDITY DEMAND ANALYSIS')}`,
      `  ${theme.separator(55)}`,
      '',
      `  ${chalk.dim('Higher APY/TVL ratio indicates stronger demand for liquidity.')}`,
      '',
      `  ${'Pool'.padEnd(12)} ${'APY'.padEnd(10)} ${'TVL'.padEnd(12)} ${'Fee Share'.padEnd(12)} ${'Demand'}`,
      `  ${theme.separator(55)}`,
    ];

    for (const r of ranked) {
      // Demand signal: APY/TVL ratio (higher = more demand per liquidity)
      const demandRatio = r.metrics.tvl > 0 ? r.metrics.apy7d / (r.metrics.tvl / 1_000_000) : 0;
      let demand = 'Low';
      if (demandRatio > 100) demand = 'Very High';
      else if (demandRatio > 30) demand = 'High';
      else if (demandRatio > 10) demand = 'Medium';

      const demandColor =
        demand === 'Very High'
          ? chalk.green(demand)
          : demand === 'High'
            ? chalk.green(demand)
            : demand === 'Medium'
              ? chalk.yellow(demand)
              : chalk.dim(demand);

      lines.push(
        `  ${chalk.cyan(r.pool.aliases[0].padEnd(12))} ${(r.metrics.apy7d.toFixed(1) + '%').padEnd(10)} ${formatUsd(r.metrics.tvl).padEnd(12)} ${((r.pool.feeShare * 100).toFixed(0) + '%').padEnd(12)} ${demandColor}`,
      );
    }

    lines.push('');
    lines.push(chalk.dim('  Pools with high demand and high fee share = best LP opportunity.'));
    lines.push('');
    return { success: true, message: lines.join('\n') };
  },
};

// ─── earn rotate ────────────────────────────────────────────────────────────

export const earnRotateTool: ToolDefinition = {
  name: 'earn_rotate',
  description: 'Analyze and suggest liquidity rotation',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const wm = context.walletManager;
    if (!wm || !wm.isConnected) return { success: true, message: chalk.dim('  No wallet connected.') };

    const _registry = getPoolRegistry();
    const metrics = await getPoolMetrics();
    const { rankPools } = await import('../earn/yield-analytics.js');
    const ranked = await rankPools();

    let tokenData: { sol: number; tokens: Array<{ mint: string; amount: number }> } | null;
    try {
      tokenData = await wm.getTokenBalances();
    } catch {
      return { success: false, message: chalk.red('  Failed to fetch balances.') };
    }
    if (!tokenData) return { success: true, message: chalk.dim('  No token data.') };

    // Find current positions
    const currentPositions: Array<{ pool: string; poolId: string; type: string; value: number; apy: number }> = [];
    for (const token of tokenData.tokens) {
      const resolved = resolveTokenMint(token.mint);
      if (!resolved || token.amount < 0.001) continue;
      const { pool, type } = resolved;
      const m = metrics.get(pool.poolId);
      const price = type === 'FLP' ? (m?.flpPrice ?? 0) : (m?.sflpPrice ?? 0);
      currentPositions.push({
        pool: pool.aliases[0],
        poolId: pool.poolId,
        type,
        value: token.amount * price,
        apy: type === 'FLP' ? (m?.apy7d ?? 0) : (m?.apr7d ?? 0),
      });
    }

    if (currentPositions.length === 0) {
      return { success: true, message: chalk.dim('  No active positions to rotate. Use "earn deposit" first.') };
    }

    // Find best pool by APY
    const bestPool = ranked[0];

    if (IS_AGENT) {
      return {
        success: true,
        message: JSON.stringify({
          action: 'earn_rotate',
          current_positions: currentPositions,
          best_pool: { pool: bestPool.pool.aliases[0], apy: bestPool.metrics.apy7d, risk: bestPool.risk },
        }),
      };
    }

    const lines = [
      '',
      `  ${theme.accentBold('LIQUIDITY ROTATION ANALYSIS')}`,
      `  ${theme.separator(50)}`,
      '',
      `  ${theme.section('Current Positions')}`,
      '',
    ];

    for (const pos of currentPositions) {
      lines.push(
        `  ${chalk.cyan(pos.pool.padEnd(12))} ${pos.type.padEnd(8)} ${formatUsd(pos.value).padEnd(12)} APY: ${pos.apy.toFixed(1)}%`,
      );
    }

    // Find rotation opportunities
    lines.push('');
    lines.push(`  ${theme.section('Rotation Opportunities')}`);
    lines.push('');

    let hasOpportunity = false;
    for (const pos of currentPositions) {
      if (bestPool.pool.poolId !== pos.poolId && bestPool.metrics.apy7d > pos.apy * 1.2) {
        hasOpportunity = true;
        lines.push(
          `  ${chalk.yellow('→')} ${chalk.bold(pos.pool)} (${pos.apy.toFixed(1)}%) → ${chalk.green(bestPool.pool.aliases[0])} (${bestPool.metrics.apy7d.toFixed(1)}%)`,
        );
        lines.push(
          chalk.dim(`    +${(bestPool.metrics.apy7d - pos.apy).toFixed(1)}% higher yield | Risk: ${bestPool.risk}`),
        );
        lines.push('');
        lines.push(
          chalk.dim(
            `    To rotate: earn withdraw 100% ${pos.pool} && earn deposit $${pos.value.toFixed(0)} ${bestPool.pool.aliases[0]}`,
          ),
        );
        lines.push('');
      }
    }

    if (!hasOpportunity) {
      lines.push(chalk.green('  Your current allocation looks optimal. No rotation needed.'));
    }

    lines.push('');
    return { success: true, message: lines.join('\n') };
  },
};

// ─── earn integrations ──────────────────────────────────────────────────────

export const earnIntegrationsTool: ToolDefinition = {
  name: 'earn_integrations',
  description: 'FLP integration partners (Loopscale, Carrot, RateX, Kamino)',
  parameters: z.object({}),
  execute: async (_params, _context): Promise<ToolResult> => {
    const { FLP_INTEGRATIONS } = await import('../earn/earn-integrations.js');

    if (IS_AGENT) {
      return {
        success: true,
        message: JSON.stringify({ action: 'earn_integrations', integrations: FLP_INTEGRATIONS }),
      };
    }

    const lines = [
      '',
      `  ${theme.accentBold('FLP INTEGRATIONS')}`,
      `  ${theme.dim('Earn higher APY, hedge or trade yield')}`,
      `  ${theme.separator(55)}`,
      '',
    ];

    for (let i = 0; i < FLP_INTEGRATIONS.length; i++) {
      const p = FLP_INTEGRATIONS[i];
      lines.push(`  ${chalk.bold(`${i + 1}.`)} ${chalk.cyan(p.name)}`);
      lines.push(`     ${p.description}`);
      lines.push(`     ${chalk.dim(p.supportedToken + ' · ' + p.detail)}`);
      lines.push('');
    }

    return { success: true, message: lines.join('\n') };
  },
};

// ─── earn history ───────────────────────────────────────────────────────────

export const earnHistoryTool: ToolDefinition = {
  name: 'earn_history',
  description: 'Historical APY data for a pool',
  parameters: z.object({
    pool: z.string().max(30).optional(),
  }),
  execute: async (params, _context): Promise<ToolResult> => {
    const { pool: poolAlias } = params as { pool?: string };
    const poolName = poolAlias ?? 'crypto';
    const pool = resolvePool(poolName);
    if (!pool) return poolNotFound(poolName);

    // Fetch from fstats historical endpoint
    try {
      const res = await fetch(`https://fstats.io/api/v1/pool-apy-history?pool=${encodeURIComponent(pool.poolId)}`, {
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        return { success: true, message: chalk.dim('  Historical APY data unavailable for this endpoint.') };
      }

      const data = (await res.json()) as Array<{ date: string; apy: number }>;
      if (!Array.isArray(data) || data.length === 0) {
        return { success: true, message: chalk.dim('  Historical data unavailable.') };
      }

      if (IS_AGENT) {
        return { success: true, message: JSON.stringify({ action: 'earn_history', pool: pool.aliases[0], data }) };
      }

      const lines = ['', `  ${theme.accentBold(`${pool.displayName} — APY History`)}`, `  ${theme.separator(40)}`, ''];

      // Show last 10 data points
      const recent = data.slice(-10);
      for (const point of recent) {
        lines.push(`  ${chalk.dim(point.date)}  ${chalk.green(point.apy.toFixed(1) + '%')}`);
      }

      lines.push('');
      return { success: true, message: lines.join('\n') };
    } catch {
      return { success: true, message: chalk.dim('  Historical data unavailable.') };
    }
  },
};

// ─── Export All ──────────────────────────────────────────────────────────────

export const allEarnTools: ToolDefinition[] = [
  earnPoolsTool,
  earnInfoTool,
  earnAddLiquidityTool,
  earnRemoveLiquidityTool,
  earnStakeTool,
  earnUnstakeTool,
  earnClaimRewardsTool,
  earnPositionsTool,
  earnBestTool,
  earnSimulateTool,
  earnDashboardTool,
  earnPnlTool,
  earnDemandTool,
  earnRotateTool,
  earnIntegrationsTool,
  earnHistoryTool,
];
