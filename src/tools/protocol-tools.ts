import { z } from 'zod';
import { ToolDefinition, ToolContext, ToolResult, MarketOI } from '../types/index.js';
import { formatUsd, formatPrice, formatPercent, formatTable, padVisible, padVisibleStart } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import { getProtocolFeeRates } from '../utils/protocol-fees.js';
import { DATA_STALENESS_WARNING_SECONDS } from '../core/risk-config.js';
import chalk from 'chalk';
import { theme } from '../cli/theme.js';
import { resolveMarket } from '../utils/market-resolver.js';

// ─── Protocol Inspector Commands ────────────────────────────────────────────

export const inspectProtocol: ToolDefinition = {
  name: 'inspect_protocol',
  description: 'Inspect Flash Trade protocol state',
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    const { ProtocolInspector } = await import('../protocol/protocol-inspector.js');
    const inspector = new ProtocolInspector();
    const msg = await inspector.inspectProtocol();
    return { success: true, message: msg };
  },
};

export const inspectPool: ToolDefinition = {
  name: 'inspect_pool',
  description: 'Inspect a specific Flash Trade pool',
  parameters: z.object({ pool: z.string().optional() }),
  execute: async (params): Promise<ToolResult> => {
    const { pool } = params as { pool?: string };
    if (!pool) {
      return { success: false, message: chalk.red('  Usage: inspect pool <pool_name>  (e.g. inspect pool Crypto.1)') };
    }
    const { ProtocolInspector } = await import('../protocol/protocol-inspector.js');
    const inspector = new ProtocolInspector();
    const msg = await inspector.inspectPool(pool);
    return { success: true, message: msg };
  },
};

export const inspectMarketTool: ToolDefinition = {
  name: 'inspect_market',
  description: 'Deep-inspect a specific market',
  parameters: z.object({ market: z.string().optional() }),
  execute: async (params): Promise<ToolResult> => {
    const { market: rawMarket } = params as { market?: string };
    if (!rawMarket) {
      return { success: false, message: chalk.red('  Usage: inspect market <asset>  (e.g. inspect market SOL)') };
    }
    const market = resolveMarket(rawMarket);
    const { ProtocolInspector } = await import('../protocol/protocol-inspector.js');
    const inspector = new ProtocolInspector();
    const msg = await inspector.inspectMarket(market);
    return { success: true, message: msg };
  },
};

// ─── System Diagnostics Tools ───────────────────────────────────────────────

export const systemStatusTool: ToolDefinition = {
  name: 'system_status',
  description: 'Display system health overview',
  parameters: z.object({}),
  execute: async (_params, _context): Promise<ToolResult> => {
    const { getSystemDiagnostics } = await import('../system/system-diagnostics.js');
    const diag = getSystemDiagnostics();
    if (!diag) {
      return { success: true, message: chalk.dim('  System diagnostics not initialized.') };
    }
    const msg = await diag.systemStatus();
    return { success: true, message: msg };
  },
};

export const protocolStatusTool: ToolDefinition = {
  name: 'protocol_status',
  description: 'Show protocol connection status overview',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const lines: string[] = [
      theme.titleBlock('PROTOCOL STATUS'),
      '',
    ];

    // 1. Program ID
    try {
      const { PoolConfig } = await import('flash-sdk');
      const pc = PoolConfig.fromIdsByName('Crypto.1', 'mainnet-beta');
      lines.push(`  Program ID:    ${chalk.cyan(pc.programId.toString())}`);
    } catch {
      lines.push(`  Program ID:    ${chalk.dim('unavailable')}`);
    }

    // 2. RPC Slot
    try {
      const { getRpcManagerInstance } = await import('../network/rpc-manager.js');
      const mgr = getRpcManagerInstance();
      if (mgr) {
        const slot = mgr.activeSlot > 0 ? mgr.activeSlot : await mgr.connection.getSlot('confirmed');
        lines.push(`  RPC Slot:      ${chalk.green(slot.toLocaleString())}`);
        const active = mgr.activeEndpoint;
        lines.push(`  Active RPC:    ${chalk.cyan(active.label)}`);
        const latency = mgr.activeLatencyMs;
        lines.push(`  RPC Latency:   ${latency >= 0 ? chalk.green(`${latency}ms`) : chalk.dim('N/A')}`);
        const lag = mgr.activeSlotLag;
        lines.push(
          `  Slot Lag:      ${lag === 0 ? chalk.green('0') : lag > 0 ? chalk.yellow(String(lag)) : chalk.dim('N/A')}`,
        );
      } else {
        lines.push(`  RPC Slot:      ${chalk.dim('not connected')}`);
      }
    } catch {
      lines.push(`  RPC Slot:      ${chalk.red('error')}`);
    }

    // 3. Oracle Health — ping Pyth Hermes with latency measurement
    try {
      const oracleStart = performance.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const resp = await fetch(
        'https://hermes.pyth.network/api/latest_vaas?ids[]=0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
        {
          signal: controller.signal,
        },
      );
      clearTimeout(timer);
      const oracleMs = Math.round(performance.now() - oracleStart);
      lines.push(`  Oracle Health: ${resp.ok ? chalk.green(`OK (${oracleMs}ms)`) : chalk.red(`HTTP ${resp.status}`)}`);
    } catch {
      lines.push(`  Oracle Health: ${chalk.red('unreachable')}`);
    }

    // 4. SDK Connection
    const simMode = context?.simulationMode ?? true;
    if (simMode) {
      lines.push(`  SDK:           ${chalk.yellow('Simulation mode (no live SDK)')}`);
    } else {
      try {
        const perpClient = (context?.flashClient as unknown as Record<string, unknown>)?.perpClient;
        if (perpClient) {
          lines.push(`  SDK:           ${chalk.green('Connected')}`);
        } else {
          lines.push(`  SDK:           ${chalk.red('No perpClient')}`);
        }
      } catch {
        lines.push(`  SDK:           ${chalk.red('Error')}`);
      }
    }

    // 5. Active Markets (tradeable markets only — consistent with protocol health)
    try {
      const { getProtocolStatsService } = await import('../data/protocol-stats.js');
      const pss = getProtocolStatsService(context.dataClient);
      const stats = await pss.getStats();
      lines.push(`  Markets:       ${chalk.bold(String(stats.activeMarkets))} active`);
    } catch {
      lines.push(`  Markets:       ${chalk.dim('unavailable')}`);
    }

    // 6. Wallet status
    const walletAddr = context?.walletAddress;
    if (walletAddr && walletAddr !== 'unknown') {
      lines.push(`  Wallet:        ${chalk.cyan(walletAddr.slice(0, 4) + '...' + walletAddr.slice(-4))}`);
    } else {
      lines.push(`  Wallet:        ${chalk.dim('not connected')}`);
    }

    // 7. Mode
    lines.push(`  Mode:          ${simMode ? chalk.yellow('Simulation') : chalk.red('Live Trading')}`);

    lines.push('');
    return { success: true, message: lines.join('\n') };
  },
};

export const rpcStatusTool: ToolDefinition = {
  name: 'rpc_status',
  description: 'Show active RPC connection info',
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    const { getRpcManagerInstance } = await import('../network/rpc-manager.js');
    const mgr = getRpcManagerInstance();
    if (!mgr) {
      return { success: true, message: chalk.dim('  RPC manager not initialized.') };
    }
    const latency = await mgr.measureLatency();
    const msg = mgr.formatStatus(latency);
    return { success: true, message: msg };
  },
};

export const rpcTestTool: ToolDefinition = {
  name: 'rpc_test',
  description: 'Test all configured RPC endpoints',
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    const { getSystemDiagnostics } = await import('../system/system-diagnostics.js');
    const diag = getSystemDiagnostics();
    if (!diag) {
      return { success: true, message: chalk.dim('  System diagnostics not initialized.') };
    }
    const msg = await diag.rpcTest();
    return { success: true, message: msg };
  },
};

export const rpcListTool: ToolDefinition = {
  name: 'rpc_list',
  description: 'List all configured RPC endpoints',
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    const { getRpcManagerInstance } = await import('../network/rpc-manager.js');
    const mgr = getRpcManagerInstance();
    if (!mgr) {
      return { success: true, message: chalk.dim('  RPC manager not initialized.') };
    }
    const endpoints = mgr.getEndpoints();
    const active = mgr.activeEndpoint;
    const lines: string[] = [theme.titleBlock('RPC ENDPOINTS'), ''];
    for (const ep of endpoints) {
      const isActive = ep.url === active.url;
      const marker = isActive ? chalk.green(' ● ') : chalk.dim(' ○ ');
      const label = isActive ? chalk.green(ep.label) : ep.label;
      const latency = mgr.getEndpointLatency(ep.url);
      const latStr = latency > 0 ? chalk.dim(` (${latency}ms)`) : '';
      lines.push(`  ${marker} ${label}${latStr}`);
      const maskedUrl = ep.url.replace(/([?&])(api[-_]?key|key|token|secret)=([^&]+)/gi, (_, prefix, param) => `${prefix}${param}=${'*'.repeat(8)}`);
      lines.push(chalk.dim(`      ${maskedUrl}`));
    }
    lines.push('');
    lines.push(chalk.dim('  Commands: rpc set <url> | rpc add <url> | rpc remove <url>'));
    lines.push('');
    return { success: true, message: lines.join('\n') };
  },
};

export const txInspectTool: ToolDefinition = {
  name: 'tx_inspect',
  description: 'Inspect a transaction by signature',
  parameters: z.object({ signature: z.string().optional() }),
  execute: async (params): Promise<ToolResult> => {
    const { signature } = params as { signature?: string };
    if (!signature) {
      return { success: false, message: chalk.red('  Usage: tx inspect <signature>') };
    }
    const { getSystemDiagnostics } = await import('../system/system-diagnostics.js');
    const diag = getSystemDiagnostics();
    if (!diag) {
      return { success: true, message: chalk.dim('  System diagnostics not initialized.') };
    }
    const msg = await diag.txInspect(signature);
    return { success: true, message: msg };
  },
};

export const txDebugTool: ToolDefinition = {
  name: 'tx_debug',
  description: 'Debug a transaction with protocol-level inspection',
  parameters: z.object({ signature: z.string().optional(), showState: z.boolean().optional() }),
  execute: async (params): Promise<ToolResult> => {
    const { signature, showState } = params as { signature?: string; showState?: boolean };
    if (!signature) {
      return { success: false, message: chalk.red('  Usage: tx debug <signature> [--state]') };
    }
    const { getSystemDiagnostics } = await import('../system/system-diagnostics.js');
    const diag = getSystemDiagnostics();
    if (!diag) {
      return { success: true, message: chalk.dim('  System diagnostics not initialized.') };
    }
    const msg = await diag.txDebug(signature, showState ?? false);
    return { success: true, message: msg };
  },
};

// ─── Trade History / Journal ──────────────────────────────────────────────────

// ─── Trade Lifecycle Aggregation ─────────────────────────────────────────────

interface AggregatedTrade {
  timestamp: number;
  market: string;
  side: string;
  leverage: number;
  entryPrice: number;
  exitPrice?: number;
  sizeUsd: number;
  collateral: number;
  pnl?: number;
  closed: boolean;
  closeReason?: string;
}

/**
 * Aggregate raw trade events into lifecycle trade records.
 * Events are processed chronologically; OPEN creates a record,
 * ADD/REMOVE_COLLATERAL adjusts it, CLOSE finalizes it.
 */
function aggregateTradeEvents(
  events: Array<{
    action: string;
    market: string;
    side: string;
    leverage?: number;
    collateral?: number;
    collateralUsd?: number;
    sizeUsd?: number;
    entryPrice?: number;
    exitPrice?: number;
    price?: number;
    pnl?: number;
    closeReason?: string;
    timestamp: number;
  }>,
): AggregatedTrade[] {
  const active = new Map<string, AggregatedTrade>();
  const completed: AggregatedTrade[] = [];

  // Process in chronological order
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);

  for (const ev of sorted) {
    const market = (ev.market ?? '').toUpperCase();
    const side = (ev.side ?? '').toLowerCase();
    const key = `${market}-${side}`;

    if (ev.action === 'open') {
      // If there's already an active trade for this key, push it as-is (orphaned open)
      const existing = active.get(key);
      if (existing) completed.push(existing);

      active.set(key, {
        timestamp: ev.timestamp,
        market,
        side,
        leverage: ev.leverage ?? (ev.collateralUsd && ev.sizeUsd ? ev.sizeUsd / ev.collateralUsd : 0),
        entryPrice: ev.entryPrice ?? ev.price ?? 0,
        sizeUsd: ev.sizeUsd ?? 0,
        collateral: ev.collateral ?? ev.collateralUsd ?? 0,
        closed: false,
      });
    } else if (ev.action === 'add_collateral') {
      const trade = active.get(key);
      if (trade) {
        trade.collateral += ev.collateral ?? ev.collateralUsd ?? 0;
        if (trade.collateral > 0) trade.leverage = trade.sizeUsd / trade.collateral;
      }
    } else if (ev.action === 'remove_collateral') {
      const trade = active.get(key);
      if (trade) {
        trade.collateral -= ev.collateral ?? ev.collateralUsd ?? 0;
        if (trade.collateral > 0) trade.leverage = trade.sizeUsd / trade.collateral;
      }
    } else if (ev.action === 'close') {
      const trade = active.get(key);
      if (trade) {
        trade.exitPrice = ev.exitPrice ?? ev.price;
        trade.pnl = ev.pnl;
        trade.closeReason = ev.closeReason;
        trade.closed = true;
        completed.push(trade);
        active.delete(key);
      } else {
        // Close without matching open (position opened before session)
        completed.push({
          timestamp: ev.timestamp,
          market,
          side,
          leverage: 0,
          entryPrice: ev.entryPrice ?? 0,
          exitPrice: ev.exitPrice ?? ev.price,
          sizeUsd: ev.sizeUsd ?? 0,
          collateral: ev.collateral ?? ev.collateralUsd ?? 0,
          pnl: ev.pnl,
          closeReason: ev.closeReason,
          closed: true,
        });
      }
    }
  }

  // Remaining active trades (still open)
  for (const trade of active.values()) {
    completed.push(trade);
  }

  // Sort by open timestamp (most recent first for display)
  return completed.sort((a, b) => b.timestamp - a.timestamp);
}

/** Render aggregated trade rows into formatted table lines. */
function renderAggregatedRows(trades: AggregatedTrade[]): string[] {
  const rows: string[] = [];
  for (const t of trades) {
    const time = new Date(t.timestamp).toLocaleTimeString('en-US', { hour12: false });
    const market = padVisible(t.market, 5);
    const side = padVisible(t.side === 'long' ? theme.long('LONG') : theme.short('SHORT'), 5);
    const lev = padVisible(t.leverage > 0 ? `${Math.round(t.leverage)}x` : theme.dim('—'), 4);
    const entryStr = padVisibleStart(t.entryPrice > 0 ? `$${formatPrice(t.entryPrice)}` : theme.dim('—'), 10);
    const exitStr = padVisibleStart(t.exitPrice !== undefined ? `$${formatPrice(t.exitPrice)}` : theme.dim('—'), 10);
    const sizeStr = padVisibleStart(t.sizeUsd > 0 ? formatUsd(t.sizeUsd) : theme.dim('—'), 8);
    const coll = padVisibleStart(t.collateral > 0 ? formatUsd(t.collateral) : theme.dim('—'), 8);
    const pnlStr =
      t.pnl !== undefined
        ? padVisibleStart(t.pnl >= 0 ? theme.positive(`+${formatUsd(t.pnl)}`) : theme.negative(formatUsd(t.pnl)), 8)
        : padVisibleStart(theme.dim('—'), 8);
    const reason = t.closeReason
      ? t.closeReason === 'TAKE_PROFIT'
        ? theme.positive('TP')
        : t.closeReason === 'STOP_LOSS'
          ? theme.negative('SL')
          : t.closeReason
      : '';

    rows.push(
      `  ${time}  ${market}  ${side}  ${lev}  ${entryStr}  ${exitStr}  ${sizeStr}  ${coll}  ${pnlStr}  ${reason}`,
    );
  }
  return rows;
}

export const tradeHistoryTool: ToolDefinition = {
  name: 'trade_history',
  description: 'Show recent trade history',
  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const client = context.flashClient;

    // In simulation mode, use the SimulatedFlashClient's full history
    if (client.getTradeHistory) {
      const trades = client.getTradeHistory();
      if (trades.length === 0) {
        return {
          success: true,
          message: [
            '',
            chalk.dim('  No trades recorded yet.'),
            chalk.dim('  Execute a trade and it will appear here.'),
            '',
          ].join('\n'),
        };
      }

      const aggregated = aggregateTradeEvents(trades);
      const recent = aggregated.slice(0, 20);
      const lines: string[] = [
        theme.titleBlock('TRADE HISTORY'),
        '',
        theme.dim('  Time       Market  Side   Lev    Entry       Exit       Size     Collateral  PnL     Reason'),
        `  ${theme.separator(104)}`,
        ...renderAggregatedRows(recent),
        '',
        theme.dim(`  Showing ${recent.length} of ${aggregated.length} trade(s)`),
        '',
      ];

      return { success: true, message: lines.join('\n') };
    }

    // Live mode: show session trades (trades executed in this terminal session)
    const sessionTrades = context.sessionTrades ?? [];
    if (sessionTrades.length === 0) {
      return {
        success: true,
        message: [
          '',
          theme.section('  Trade History'),
          theme.dim('  ─'.repeat(30)),
          '',
          theme.dim('  No trades executed in this session.'),
          '',
          theme.dim('  For full history, view on a Solana explorer:'),
          theme.dim('    • Solscan — https://solscan.io'),
          theme.dim('    • Solana FM — https://solana.fm'),
          '',
        ].join('\n'),
      };
    }

    const aggregated = aggregateTradeEvents(sessionTrades);
    const recent = aggregated.slice(0, 20);
    const lines: string[] = [
      theme.titleBlock('SESSION TRADE HISTORY'),
      '',
      theme.dim('  Time      Market  Side   Lev       Entry        Exit      Size      Coll       PnL'),
      `  ${theme.separator(88)}`,
      ...renderAggregatedRows(recent),
      '',
      theme.dim(`  ${recent.length} trade(s) this session`),
      theme.dim('  Full history: https://solscan.io'),
      '',
    ];

    return { success: true, message: lines.join('\n') };
  },
};

// ─── Liquidation Map ────────────────────────────────────────────────────────

export const liquidationMapTool: ToolDefinition = {
  name: 'liquidation_map',
  description: 'Display liquidation risk data: OI by leverage band and whale position analysis',
  parameters: z.object({
    market: z.string().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    try {
      const marketFilter = params.market ? resolveMarket(String(params.market)) : undefined;
      const [markets, oiData, whalePositions] = await Promise.all([
        context.flashClient.getMarketData(marketFilter),
        context.dataClient.getOpenInterest(),
        context.dataClient.getOpenPositions?.() ?? Promise.resolve([]),
      ]);

      if (markets.length === 0) {
        return { success: false, message: theme.negative(`\n  Market ${marketFilter ?? 'data'} not found.\n`) };
      }

      const targetMarkets = marketFilter
        ? markets.filter((m) => m.symbol.toUpperCase() === marketFilter)
        : markets.slice(0, 3);

      if (targetMarkets.length === 0) {
        return { success: false, message: theme.negative(`\n  Market ${marketFilter} not found.\n`) };
      }

      const lines: string[] = [];

      for (const mkt of targetMarkets) {
        const price = mkt.price;
        if (!Number.isFinite(price) || price <= 0) continue;

        const oi = oiData.markets.find((m) => m.market.toUpperCase() === mkt.symbol.toUpperCase());
        const longOi = oi?.longOi ?? mkt.openInterestLong;
        const shortOi = oi?.shortOi ?? mkt.openInterestShort;
        const totalOi = longOi + shortOi;

        lines.push(theme.titleBlock(`LIQUIDATION RISK — ${mkt.symbol}`));
        lines.push('');
        lines.push(theme.pair('Current Price', formatPrice(price)));
        lines.push(theme.pair('Total OI', formatUsd(totalOi)));
        lines.push(theme.pair('Long OI', formatUsd(longOi)));
        lines.push(theme.pair('Short OI', formatUsd(shortOi)));
        lines.push('');

        // ── Liquidation price levels by leverage ──
        // Show WHERE liquidation would occur for each leverage tier
        // This is mathematical fact, not estimated distribution
        lines.push(`  ${theme.section('Liquidation Price by Leverage')}`);
        lines.push(theme.dim('  If a position was opened at current price:'));
        lines.push('');

        const leverageBands = [2, 3, 5, 10, 20, 50, 100];
        const levHeaders = ['Leverage', 'Long Liq Price', 'Short Liq Price', 'Distance'];
        const levRows = leverageBands.map((lev) => {
          const longLiq = price * (1 - 1 / lev);
          const shortLiq = price * (1 + 1 / lev);
          const distPct = (1 / lev) * 100;
          return [`${lev}x`, formatPrice(longLiq), formatPrice(shortLiq), `${distPct.toFixed(1)}%`];
        });
        lines.push(formatTable(levHeaders, levRows));
        lines.push('');

        // ── Whale positions with known data ──
        const mktWhales = whalePositions
          .filter((w) => {
            const sym = (w.market_symbol ?? w.market ?? '').toUpperCase();
            return sym === mkt.symbol.toUpperCase() && Number.isFinite(w.size_usd) && (w.size_usd ?? 0) > 0;
          })
          .sort((a, b) => (Number(b.size_usd) || 0) - (Number(a.size_usd) || 0));

        if (mktWhales.length > 0) {
          lines.push(`  ${theme.section('Whale Positions')}`);
          lines.push('');

          const whaleHeaders = ['Side', 'Size', 'Entry Price', 'Dist from Current'];
          const whaleRows = mktWhales.slice(0, 10).map((w) => {
            const side = String(w.side ?? '?').toUpperCase();
            const size = Number(w.size_usd ?? 0);
            const entry = Number(w.entry_price ?? w.mark_price ?? 0);
            const dist = entry > 0 ? ((price - entry) / entry) * 100 : 0;
            const sideColor = side === 'LONG' ? theme.positive(side.padEnd(6)) : theme.negative(side.padEnd(6));
            return [
              sideColor,
              formatUsd(size),
              entry > 0 ? formatPrice(entry) : theme.dim('N/A'),
              Number.isFinite(dist) ? formatPercent(dist) : theme.dim('N/A'),
            ];
          });
          lines.push(formatTable(whaleHeaders, whaleRows));
          lines.push('');
        }

        // OI imbalance summary
        if (totalOi > 0) {
          const longPct = (longOi / totalOi) * 100;
          const imbalance = Math.abs(longPct - 50);
          if (imbalance > 10) {
            const direction = longPct > 50 ? 'long-heavy' : 'short-heavy';
            lines.push(
              chalk.yellow(
                `  OI is ${direction} (${longPct.toFixed(0)}/${(100 - longPct).toFixed(0)}) — cascading liquidations more likely on the heavy side.`,
              ),
            );
            lines.push('');
          }
        }
      }

      lines.push(theme.dim('  Source: Pyth Hermes (price) | fstats (OI, whale positions)'));
      lines.push('');

      return { success: true, message: lines.join('\n') };
    } catch (error: unknown) {
      return { success: false, message: theme.dim(`\n  Liquidation data unavailable: ${getErrorMessage(error)}\n`) };
    }
  },
};

// ─── Funding Rate Dashboard ─────────────────────────────────────────────────

export const fundingDashboardTool: ToolDefinition = {
  name: 'funding_dashboard',
  description: 'Display OI imbalance and fee accrual data for markets',
  parameters: z.object({
    market: z.string().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    try {
      const marketFilter = params.market ? resolveMarket(String(params.market)) : undefined;
      const markets = await context.flashClient.getMarketData(marketFilter);

      if (markets.length === 0) {
        return { success: false, message: theme.negative(`\n  Market ${marketFilter ?? 'data'} not found.\n`) };
      }

      // Enrich with real OI data from fstats (getMarketData returns zero OI)
      const oiData = await context.dataClient.getOpenInterest().catch(() => ({ markets: [] as MarketOI[] }));
      for (const mkt of markets) {
        const oiEntry = oiData.markets.find((m) => m.market?.toUpperCase()?.includes(mkt.symbol.toUpperCase()));
        if (oiEntry) {
          mkt.openInterestLong = oiEntry.longOi ?? 0;
          mkt.openInterestShort = oiEntry.shortOi ?? 0;
        }
      }

      const targetMarkets = marketFilter
        ? markets.filter((m) => m.symbol.toUpperCase() === marketFilter)
        : markets.filter((m) => m.openInterestLong + m.openInterestShort > 0);

      if (targetMarkets.length === 0) {
        return {
          success: false,
          message: theme.negative(`\n  No market data available${marketFilter ? ` for ${marketFilter}` : ''}.\n`),
        };
      }

      const lines: string[] = [];

      if (marketFilter && targetMarkets.length === 1) {
        // Single-market detailed view
        const mkt = targetMarkets[0];
        const totalOi = mkt.openInterestLong + mkt.openInterestShort;
        const longPct = totalOi > 0 ? (mkt.openInterestLong / totalOi) * 100 : 50;
        const shortPct = totalOi > 0 ? (mkt.openInterestShort / totalOi) * 100 : 50;
        const imbalance = longPct - shortPct;

        lines.push(theme.titleBlock(`OI & FEE DASHBOARD — ${mkt.symbol}`));
        lines.push('');
        lines.push(theme.pair('Current Price', formatPrice(mkt.price)));
        lines.push('');
        lines.push(`  ${theme.section('Open Interest')}`);
        lines.push(theme.pair('Total OI', formatUsd(totalOi)));
        lines.push(theme.pair('Long OI', `${formatUsd(mkt.openInterestLong)}  (${longPct.toFixed(0)}%)`));
        lines.push(theme.pair('Short OI', `${formatUsd(mkt.openInterestShort)}  (${shortPct.toFixed(0)}%)`));

        if (Math.abs(imbalance) > 5) {
          const direction = imbalance > 0 ? 'long-heavy' : 'short-heavy';
          const color = imbalance > 0 ? theme.positive : theme.negative;
          lines.push(theme.pair('Imbalance', color(`${Math.abs(imbalance).toFixed(1)}% ${direction}`)));
        } else {
          lines.push(theme.pair('Imbalance', theme.dim('balanced')));
        }

        // Fee accrual from positions (if user has positions in this market)
        lines.push('');
        lines.push(`  ${theme.section('Fee Structure')}`);
        lines.push(theme.dim('  Flash Trade uses borrow/lock fees, not periodic funding rates.'));
        lines.push(theme.dim('  Fees accrue as unsettledFeesUsd on each position.'));

        // Try to show actual fee rates from CustodyAccount
        try {
          const { PoolConfig } = await import('flash-sdk');
          const { getPoolForMarket: gp } = await import('../config/index.js');
          const poolName = gp(mkt.symbol);
          if (poolName) {
            const pc = PoolConfig.fromIdsByName(poolName, 'mainnet-beta');
            const custodies = pc.custodies as Array<{ custodyAccount: unknown; symbol: string }>;
            const custody = custodies.find((c) => c.symbol.toUpperCase() === mkt.symbol.toUpperCase());
            if (custody) {
              const perpClient = (context.flashClient as unknown as Record<string, unknown>).perpClient as
                | Record<string, unknown>
                | undefined;
              if (perpClient) {
                const RATE_POWER = 1_000_000_000;
                const program = (perpClient as Record<string, unknown>).program as Record<string, unknown>;
                const acct = (program.account as Record<string, unknown>).custody as Record<string, unknown>;
                const custodyAcct = await (acct.fetch as (addr: unknown) => Promise<Record<string, unknown>>)(
                  custody.custodyAccount,
                );
                const fees = custodyAcct.fees as Record<string, unknown>;
                const openFee = (parseFloat(String(fees.openPosition)) / RATE_POWER) * 100;
                const closeFee = (parseFloat(String(fees.closePosition)) / RATE_POWER) * 100;
                lines.push('');
                lines.push(theme.pair('Open Fee', `${openFee.toFixed(4)}%`));
                lines.push(theme.pair('Close Fee', `${closeFee.toFixed(4)}%`));
              }
            }
          }
        } catch {
          // Fee rate fetch is best-effort
        }

        lines.push('');
        lines.push(theme.dim('  Source: fstats (OI) | Flash SDK (fee rates)'));
        lines.push('');
      } else {
        // Multi-market overview
        lines.push(theme.titleBlock('OI IMBALANCE'));
        lines.push('');

        // Sort by total OI descending
        const sorted = [...targetMarkets].sort(
          (a, b) => b.openInterestLong + b.openInterestShort - (a.openInterestLong + a.openInterestShort),
        );

        const headers = ['Market', 'Long OI', 'Short OI', 'Total OI', 'L/S Ratio', 'Bias'];
        const rows = sorted.map((m) => {
          const totalOi = m.openInterestLong + m.openInterestShort;
          const longPct = totalOi > 0 ? (m.openInterestLong / totalOi) * 100 : 50;
          const ratio = totalOi > 0 ? `${longPct.toFixed(0)}/${(100 - longPct).toFixed(0)}` : 'N/A';
          const imbalance = longPct - 50;
          let bias = theme.dim('balanced');
          if (imbalance > 10) bias = theme.positive('LONG');
          else if (imbalance < -10) bias = theme.negative('SHORT');
          return [
            chalk.bold(m.symbol),
            formatUsd(m.openInterestLong),
            formatUsd(m.openInterestShort),
            formatUsd(totalOi),
            ratio,
            bias,
          ];
        });

        lines.push(formatTable(headers, rows));
        lines.push('');
        lines.push(theme.dim('  Flash Trade uses borrow/lock fees, not periodic funding rates.'));
        lines.push(theme.dim('  Source: fstats (OI data)'));
        lines.push('');
      }

      return { success: true, message: lines.join('\n') };
    } catch (error: unknown) {
      return { success: false, message: theme.dim(`\n  Market data unavailable: ${getErrorMessage(error)}\n`) };
    }
  },
};

// ─── Liquidity Depth Viewer ─────────────────────────────────────────────────

export const liquidityDepthTool: ToolDefinition = {
  name: 'liquidity_depth',
  description: 'Show liquidity distribution around the current price for a market',
  parameters: z.object({
    market: z.string().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    try {
      const marketFilter = params.market ? resolveMarket(String(params.market)) : undefined;
      const [markets, oiData] = await Promise.all([
        context.flashClient.getMarketData(marketFilter),
        context.dataClient.getOpenInterest(),
      ]);

      if (markets.length === 0) {
        return { success: false, message: theme.negative(`\n  Market ${marketFilter ?? 'data'} not found.\n`) };
      }

      const targetMarkets = marketFilter
        ? markets.filter((m) => m.symbol.toUpperCase() === marketFilter)
        : markets.slice(0, 3);

      if (targetMarkets.length === 0) {
        return { success: false, message: theme.negative(`\n  Market ${marketFilter} not found.\n`) };
      }

      const lines: string[] = [];

      for (const mkt of targetMarkets) {
        const price = mkt.price;
        if (!Number.isFinite(price) || price <= 0) continue;

        const oi = oiData.markets.find((m) => m.market.toUpperCase() === mkt.symbol.toUpperCase());
        const longOi = oi?.longOi ?? mkt.openInterestLong;
        const shortOi = oi?.shortOi ?? mkt.openInterestShort;
        const totalOi = longOi + shortOi;
        const longPct = totalOi > 0 ? (longOi / totalOi) * 100 : 50;
        const shortPct = totalOi > 0 ? 100 - longPct : 50;

        lines.push(theme.titleBlock(`LIQUIDITY OVERVIEW — ${mkt.symbol}`));
        lines.push('');
        lines.push(theme.pair('Price', formatPrice(price)));
        lines.push(theme.pair('Open Interest', formatUsd(totalOi)));
        lines.push(theme.pair('  Long OI', `${formatUsd(longOi)} (${longPct.toFixed(1)}%)`));
        lines.push(theme.pair('  Short OI', `${formatUsd(shortOi)} (${shortPct.toFixed(1)}%)`));
        lines.push(theme.pair('Long / Short', `${longPct.toFixed(0)} / ${shortPct.toFixed(0)}`));
        lines.push('');
        lines.push(theme.dim('  Orderbook depth unavailable for this perpetual market.'));
        lines.push(theme.dim('  Flash Trade uses pool-based liquidity, not an orderbook.'));
        lines.push('');
      }

      return { success: true, message: lines.join('\n') };
    } catch (error: unknown) {
      return { success: false, message: theme.dim(`\n  Depth data unavailable: ${getErrorMessage(error)}\n`) };
    }
  },
};

// ─── Protocol Health ────────────────────────────────────────────────────────

export const protocolHealthTool: ToolDefinition = {
  name: 'protocol_health',
  description: 'Display overall Flash protocol health metrics',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    try {
      const { getProtocolStatsService } = await import('../data/protocol-stats.js');
      const pss = getProtocolStatsService(context.dataClient);
      const stats = await pss.getStats();

      // RPC latency
      let rpcLatency = 'N/A';
      let blockHeight = 'N/A';
      try {
        const { getRpcManagerInstance } = await import('../network/rpc-manager.js');
        const rpcMgr = getRpcManagerInstance();
        if (rpcMgr) {
          const lat = rpcMgr.activeLatencyMs;
          rpcLatency = lat >= 0 ? `${lat}ms` : 'N/A';
          const slot = rpcMgr.activeSlot > 0 ? rpcMgr.activeSlot : await rpcMgr.connection.getSlot('confirmed');
          if (Number.isFinite(slot)) blockHeight = slot.toLocaleString();
        }
      } catch {
        /* non-critical */
      }

      // Top markets by OI
      const top5 = stats.marketsByOI.filter((m) => m.total > 0).slice(0, 5);

      const dataAge = pss.getDataAge();
      const freshnessStr =
        dataAge >= 0
          ? dataAge > DATA_STALENESS_WARNING_SECONDS
            ? chalk.yellow(`  ⚠ Data updated: ${dataAge}s ago — protocol data may be stale`)
            : theme.dim(`  Data updated: ${dataAge}s ago`)
          : '';

      const lines: string[] = [
        theme.titleBlock('FLASH PROTOCOL HEALTH'),
        '',
        `  ${theme.section('Protocol Overview')}`,
        theme.pair('Active Markets', stats.activeMarkets.toString()),
        theme.pair('Open Interest', formatUsd(stats.totalOpenInterest)),
        theme.pair(
          'Long/Short Ratio',
          `${theme.positive(stats.longPct + '%')} / ${theme.negative(stats.shortPct + '%')}`,
        ),
        '',
      ];

      // 30d stats
      if (stats.volume30d > 0 || stats.trades30d > 0) {
        lines.push(`  ${theme.section('Activity (30d)')}`);
        lines.push(theme.pair('Volume', formatUsd(stats.volume30d)));
        lines.push(theme.pair('Trades', stats.trades30d.toLocaleString()));
        lines.push(theme.pair('Unique Traders', stats.traders30d.toLocaleString()));
        lines.push(theme.pair('Fees Collected', formatUsd(stats.fees30d)));
        lines.push('');
      }

      // Top markets
      if (top5.length > 0) {
        lines.push(`  ${theme.section('Top Markets by OI')}`);
        for (const m of top5) {
          const pct = stats.totalOpenInterest > 0 ? ((m.total / stats.totalOpenInterest) * 100).toFixed(1) : '0';
          lines.push(`    ${m.market.padEnd(10)} ${formatUsd(m.total).padEnd(14)} ${theme.dim(`(${pct}%)`)}`);
        }
        lines.push('');
      }

      // Infrastructure
      lines.push(`  ${theme.section('Infrastructure')}`);
      lines.push(theme.pair('RPC Latency', rpcLatency));
      lines.push(theme.pair('Block Height', blockHeight));
      lines.push('');
      if (freshnessStr) lines.push(freshnessStr);
      lines.push('');

      return { success: true, message: lines.join('\n') };
    } catch (error: unknown) {
      return {
        success: false,
        message: theme.dim(`\n  Protocol health data unavailable: ${getErrorMessage(error)}\n`),
      };
    }
  },
};

// ─── system_audit ────────────────────────────────────────────────────────────

export const systemAuditTool: ToolDefinition = {
  name: 'system_audit',
  description: 'Verify protocol data integrity across all subsystems',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const lines: string[] = [theme.titleBlock('SYSTEM AUDIT'), ''];

    let passCount = 0;
    let failCount = 0;

    const pass = (msg: string) => {
      passCount++;
      lines.push(theme.positive(`  ✔ ${msg}`));
    };
    const fail = (msg: string) => {
      failCount++;
      lines.push(theme.negative(`  ✘ ${msg}`));
    };

    // 1. Fee engine vs on-chain custody
    lines.push(`  ${theme.section('Fee Engine')}`);
    const testMarkets = ['SOL', 'BTC', 'ETH'];
    for (const market of testMarkets) {
      try {
        const rates = await getProtocolFeeRates(
          market,
          context.simulationMode
            ? null
            : ((context.flashClient as unknown as Record<string, unknown>).perpClient ?? null),
        );
        if (rates.source === 'on-chain') {
          pass(
            `${market}: on-chain (open=${(rates.openFeeRate * 100).toFixed(4)}%, close=${(rates.closeFeeRate * 100).toFixed(4)}%)`,
          );
        } else {
          fail(`${market}: using sdk-default fallback (not on-chain)`);
        }
      } catch (e) {
        fail(`${market}: ${getErrorMessage(e)}`);
      }
    }
    lines.push('');

    // 2. Protocol statistics consistency
    lines.push(`  ${theme.section('Protocol Statistics')}`);
    try {
      const { getProtocolStatsService } = await import('../data/protocol-stats.js');
      const pss = getProtocolStatsService(context.dataClient);
      const stats = await pss.getStats();
      if (stats.activeMarkets > 0) {
        pass(`Active markets: ${stats.activeMarkets}`);
      } else {
        fail('No active markets detected');
      }
      if (stats.totalOpenInterest > 0) {
        pass(`Total OI: ${formatUsd(stats.totalOpenInterest)}`);
      } else {
        fail('No open interest data');
      }
      const lsSum = stats.longPct + stats.shortPct;
      if (lsSum >= 99 && lsSum <= 101) {
        pass(`Long/Short split: ${stats.longPct}%/${stats.shortPct}% (sums to ${lsSum}%)`);
      } else {
        fail(`Long/Short split doesn't sum to 100: ${lsSum}%`);
      }
    } catch (e) {
      fail(`Stats service: ${getErrorMessage(e)}`);
    }
    lines.push('');

    // 3. Cache synchronization
    lines.push(`  ${theme.section('Cache Sync')}`);
    try {
      const { getProtocolStatsService } = await import('../data/protocol-stats.js');
      const pss = getProtocolStatsService(context.dataClient);
      const dataAge = pss.getDataAge();
      if (dataAge >= 0 && dataAge < 30) {
        pass(`Protocol stats cache age: ${dataAge}s`);
      } else if (dataAge >= 30) {
        fail(`Protocol stats cache stale: ${dataAge}s`);
      } else {
        pass('Protocol stats not yet cached (will fetch on demand)');
      }
    } catch {
      fail('Cache check failed');
    }
    lines.push('');

    // 4. Position data integrity
    lines.push(`  ${theme.section('Position Data')}`);
    try {
      const positions = await context.flashClient.getPositions();
      if (positions.length === 0) {
        pass('No open positions (nothing to validate)');
      } else {
        let posValid = true;
        for (const p of positions) {
          if (!Number.isFinite(p.entryPrice) || p.entryPrice <= 0) {
            fail(`${p.market}: invalid entry price ${p.entryPrice}`);
            posValid = false;
          }
          if (!Number.isFinite(p.sizeUsd) || p.sizeUsd <= 0) {
            fail(`${p.market}: invalid size ${p.sizeUsd}`);
            posValid = false;
          }
          if (!Number.isFinite(p.collateralUsd) || p.collateralUsd <= 0) {
            fail(`${p.market}: invalid collateral ${p.collateralUsd}`);
            posValid = false;
          }
          if (p.totalFees < 0) {
            fail(`${p.market}: negative fees ${p.totalFees}`);
            posValid = false;
          }
        }
        if (posValid) {
          pass(`All ${positions.length} position(s) pass integrity checks`);
        }
      }
    } catch (e) {
      fail(`Position fetch: ${getErrorMessage(e)}`);
    }
    lines.push('');

    // 5. Custody parsing
    lines.push(`  ${theme.section('Custody Accounts')}`);
    try {
      const { RATE_POWER, BPS_POWER } = await import('../utils/protocol-fees.js');
      if (RATE_POWER === 1_000_000_000 && BPS_POWER === 10_000) {
        pass('RATE_POWER=1e9, BPS_POWER=10000 — matches Flash SDK');
      } else {
        fail(`Constant mismatch: RATE_POWER=${RATE_POWER}, BPS_POWER=${BPS_POWER}`);
      }
    } catch {
      fail('Could not verify custody constants');
    }
    lines.push('');

    // Summary
    lines.push(`  ${theme.separator(40)}`);
    lines.push('');
    lines.push(
      `  ${theme.dim('Pass:')} ${theme.positive(String(passCount))}  ${theme.dim('Fail:')} ${failCount > 0 ? theme.negative(String(failCount)) : theme.dim('0')}`,
    );
    lines.push('');

    if (failCount === 0) {
      lines.push(theme.positive('  All systems verified.'));
    } else {
      lines.push(theme.warning(`  ${failCount} check(s) failed. Review details above.`));
    }
    lines.push('');

    return { success: failCount === 0, message: lines.join('\n') };
  },
};

// ─── tx_metrics ──────────────────────────────────────────────────────────────

export const txMetricsTool: ToolDefinition = {
  name: 'tx_metrics',
  description: 'Show ultra-TX engine performance metrics',
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    const { getUltraTxEngine } = await import('../core/ultra-tx-engine.js');
    const engine = getUltraTxEngine();
    if (!engine) {
      return { success: false, message: 'Ultra-TX engine not initialized (simulation mode or no wallet connected).' };
    }

    const s = engine.getMetricsSummary();
    if (s.totalTxs === 0) {
      return {
        success: true,
        message: theme.titleBlock('TX ENGINE METRICS') + '\n\n  No transactions recorded yet.\n',
      };
    }

    const w = 26; // label width for alignment
    const lines = [
      theme.titleBlock('TX ENGINE METRICS'),
      '',
      theme.pair('Transactions', String(s.totalTxs), w),
      theme.pair('Avg Total Latency', `${s.avgTotalLatencyMs}ms`, w),
      theme.pair('Avg Confirm Time', `${s.avgConfirmLatencyMs}ms`, w),
      theme.pair('P50 Confirm', `${s.p50ConfirmMs}ms`, w),
      theme.pair('P95 Confirm', `${s.p95ConfirmMs}ms`, w),
      theme.pair(
        'Avg Blockhash Fetch',
        s.avgBlockhashLatencyMs === 0 ? 'pre-cached' : `${s.avgBlockhashLatencyMs}ms`,
        w,
      ),
      theme.pair('Avg Build Time', `${s.avgBuildTimeMs}ms`, w),
      theme.pair('WS Confirmation', `${s.wsConfirmPct}%`, w),
      theme.pair('Avg Broadcast Endpoints', `${s.avgBroadcastCount}`, w),
      theme.pair('Avg Rebroadcasts', `${s.avgRebroadcastCount}`, w),
      '',
      theme.titleBlock('LEADER ROUTING'),
      '',
      theme.pair('Routing Mode', s.leaderRoutedPct > 0 || s.tpuForwardedPct > 0 ? 'Leader Aware' : 'Standard', w),
      theme.pair('Leader Routed', `${s.leaderRoutedPct}%`, w),
      theme.pair('TPU Forwarded', `${s.tpuForwardedPct}%`, w),
      theme.pair('Avg Slot Delay', s.avgSlotDelay > 0 ? `${s.avgSlotDelay} slots` : 'n/a', w),
      theme.pair(
        'Fastest Endpoint',
        s.fastestEndpoint
          ? s.fastestEndpoint
              .replace(/[?&](api[-_]?key|token|secret|auth)=[^&]*/gi, '')
              .replace(/\/v2\/[a-zA-Z0-9_-]{10,}/, '/v2/***')
          : 'n/a',
        w,
      ),
      '',
    ];

    return { success: true, message: lines.join('\n') };
  },
};

export const allProtocolTools: ToolDefinition[] = [
  inspectProtocol,
  inspectPool,
  inspectMarketTool,
  systemStatusTool,
  protocolStatusTool,
  rpcStatusTool,
  rpcTestTool,
  rpcListTool,
  txInspectTool,
  txDebugTool,
  tradeHistoryTool,
  liquidationMapTool,
  fundingDashboardTool,
  liquidityDepthTool,
  protocolHealthTool,
  systemAuditTool,
  txMetricsTool,
];
