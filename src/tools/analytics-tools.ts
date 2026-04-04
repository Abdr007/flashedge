import { z } from 'zod';
import { ToolDefinition, ToolResult, MarketOI, DailyVolume, LeaderboardEntry } from '../types/index.js';
import { formatUsd, formatTable, colorPnl, shortAddress } from '../utils/format.js';
import chalk from 'chalk';
import { theme } from '../cli/theme.js';

// ─── Analytics Tools ─────────────────────────────────────────────────────────

export const flashGetVolume: ToolDefinition = {
  name: 'flash_get_volume',
  description: 'Get trading volume data from fstats.io',
  parameters: z.object({
    period: z.enum(['7d', '30d', 'all']).optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    try {
      const { period } = params as { period?: '7d' | '30d' | 'all' };
      const days = period === '7d' ? 7 : period === 'all' ? 365 : 30;
      const volume = await context.dataClient.getVolume(days);

      const recent = volume.dailyVolumes.slice(-7);
      if (recent.length === 0) {
        return { success: true, message: theme.dim('\n  Volume data unavailable.\n') };
      }

      const headers = ['Date', 'Volume', 'Trades', 'Long', 'Short'];
      const rows = recent.map((d: DailyVolume) => [
        d.date,
        formatUsd(d.volumeUsd),
        d.trades.toString(),
        formatUsd(d.longVolume),
        formatUsd(d.shortVolume),
      ]);

      return {
        success: true,
        message: [
          theme.titleBlock(`VOLUME (${volume.period})`),
          '',
          theme.pair('Total', formatUsd(volume.totalVolumeUsd)),
          theme.pair('Trades', volume.trades.toLocaleString()),
          '',
          formatTable(headers, rows),
          '',
          theme.dim(`  Data updated: ${new Date().toLocaleTimeString()}`),
          '',
        ].join('\n'),
        data: { volume },
      };
    } catch {
      return { success: false, message: theme.dim(`\n  Volume data unavailable.\n`) };
    }
  },
};

export const flashGetOpenInterest: ToolDefinition = {
  name: 'flash_get_open_interest',
  description: 'Get open interest data',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    try {
      const oi = await context.dataClient.getOpenInterest();

      if (oi.markets.length === 0) {
        return { success: true, message: theme.dim('\n  Open interest data unavailable.\n') };
      }

      const headers = ['Market', 'Long OI', 'Short OI', 'L Positions', 'S Positions'];
      const rows = oi.markets.map((m: MarketOI) => [
        chalk.bold(m.market),
        formatUsd(m.longOi),
        formatUsd(m.shortOi),
        m.longPositions.toString(),
        m.shortPositions.toString(),
      ]);

      return {
        success: true,
        message: [
          theme.titleBlock('OPEN INTEREST'),
          '',
          formatTable(headers, rows),
          '',
          theme.dim(`  Data updated: ${new Date().toLocaleTimeString()}`),
          '',
        ].join('\n'),
        data: { openInterest: oi },
      };
    } catch {
      return { success: false, message: theme.dim(`\n  Open interest data unavailable.\n`) };
    }
  },
};

export const flashGetLeaderboard: ToolDefinition = {
  name: 'flash_get_leaderboard',
  description: 'Get trader leaderboard',
  parameters: z.object({
    metric: z.enum(['pnl', 'volume']).optional(),
    period: z.number().optional(),
    limit: z.number().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    try {
      const {
        metric: rawMetric,
        period,
        limit: rawLimit,
      } = params as {
        metric?: 'pnl' | 'volume';
        period?: number;
        limit?: number;
      };
      const metric = rawMetric ?? 'pnl';
      const days = period ?? 30;
      const limit = rawLimit ?? 10;

      const entries = await context.dataClient.getLeaderboard(metric, days, limit);

      if (entries.length === 0) {
        return { success: true, message: theme.dim('\n  Leaderboard data unavailable.\n') };
      }

      const headers = ['#', 'Trader', 'PnL', 'Volume', 'Trades', 'Win Rate'];
      const rows = entries.map((e: LeaderboardEntry) => [
        `${e.rank}`,
        shortAddress(e.address),
        colorPnl(e.pnl),
        formatUsd(e.volume),
        e.trades.toString(),
        `${e.winRate.toFixed(0)}%`,
      ]);

      return {
        success: true,
        message: [
          theme.titleBlock(`LEADERBOARD — ${metric.toUpperCase()} (${days}d)`),
          '',
          formatTable(headers, rows),
          '',
        ].join('\n'),
        data: { leaderboard: entries },
      };
    } catch {
      return { success: false, message: theme.dim(`\n  Leaderboard data unavailable.\n`) };
    }
  },
};

export const flashGetFees: ToolDefinition = {
  name: 'flash_get_fees',
  description: 'Get fee data',
  parameters: z.object({
    period: z.number().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    try {
      const { period } = params as { period?: number };
      const days = period ?? 30;
      const fees = await context.dataClient.getFees(days);

      const lines = [
        theme.titleBlock(`PROTOCOL FEES (${fees.period})`),
        '',
        theme.pair('Total Fees', formatUsd(fees.totalFees)),
      ];

      // Fee distribution breakdown (from latest day)
      const totalDistribution = fees.lpShare + fees.tokenShare + fees.teamShare;
      if (totalDistribution > 0) {
        lines.push('');
        lines.push(`  ${theme.section('Fee Distribution (latest day)')}`);
        lines.push(theme.pair('LP Share', formatUsd(fees.lpShare)));
        lines.push(theme.pair('Token Share', formatUsd(fees.tokenShare)));
        lines.push(theme.pair('Team Share', formatUsd(fees.teamShare)));
      }

      // Daily trend (last 7 days if available)
      if (fees.dailyFees.length > 1) {
        const recent = fees.dailyFees.slice(-7);
        const avg = recent.reduce((s, d) => s + d.totalFees, 0) / recent.length;
        lines.push('');
        lines.push(`  ${theme.section('Daily Trend')}`);
        lines.push(theme.pair(`${recent.length}d Avg`, formatUsd(avg)));

        // Show last 7 days
        for (const d of recent) {
          const dateStr = d.date.length >= 10 ? d.date.slice(5, 10) : d.date;
          lines.push(`    ${theme.dim(dateStr)}  ${formatUsd(d.totalFees)}`);
        }
      }

      // Trading fee rate info
      lines.push('');
      lines.push(`  ${theme.section('Trading Fee Rate')}`);
      lines.push(theme.pair('Source', 'On-chain CustodyAccount (per-market)'));
      lines.push(theme.pair('Note', theme.dim('Fees are deducted from collateral at execution')));

      lines.push('');

      return {
        success: true,
        message: lines.join('\n'),
        data: { fees },
      };
    } catch {
      return { success: false, message: theme.dim(`\n  Fee data unavailable.\n`) };
    }
  },
};

export const flashGetTraderProfile: ToolDefinition = {
  name: 'flash_get_trader_profile',
  description: 'Get a trader profile',
  parameters: z.object({
    address: z.string(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { address } = params as { address: string };
    const profile = await context.dataClient.getTraderProfile(address);

    return {
      success: true,
      message: [
        theme.titleBlock(`TRADER: ${shortAddress(profile.address)}`),
        '',
        theme.pair('Total Trades', String(profile.totalTrades)),
        theme.pair('Total Volume', formatUsd(profile.totalVolume)),
        theme.pair('Total PnL', colorPnl(profile.totalPnl)),
        theme.pair('Win Rate', `${profile.winRate.toFixed(1)}%`),
        '',
      ].join('\n'),
      data: { traderProfile: profile },
    };
  },
};

export const allAnalyticsTools: ToolDefinition[] = [
  flashGetVolume,
  flashGetOpenInterest,
  flashGetLeaderboard,
  flashGetFees,
  flashGetTraderProfile,
];
