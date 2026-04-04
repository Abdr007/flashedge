import { ActionType, ParsedIntent, ToolContext, ToolDefinition, ToolResult } from '../types/index.js';
import { ToolRegistry } from './registry.js';
import { allFlashTools } from './flash-tools.js';

import { allSwapTools } from './swap-tools.js';
import { allEarnTools } from './earn-tools.js';
import { allEngineTools } from './engine-tools.js';
import { allFafTools } from './faf-tools.js';
import { profilingSummaryTool } from '../observability/profiler.js';
import { runMiddleware } from '../core/execution-middleware.js';
import { theme } from '../cli/theme.js';
import { getCommandsByCategory } from '../cli/command-registry.js';

/**
 * ToolEngine maps parsed intents to tool invocations.
 * Maps parsed intents to tool invocations: intent → tool name → execute.
 */
export class ToolEngine {
  private registry: ToolRegistry;
  private context: ToolContext;

  constructor(context: ToolContext) {
    this.context = context;
    this.registry = new ToolRegistry();

    for (const tool of allFlashTools) {
      this.registry.register(tool);
    }

    for (const tool of allSwapTools) {
      this.registry.register(tool);
    }
    for (const tool of allEarnTools) {
      this.registry.register(tool);
    }
    for (const tool of allEngineTools) {
      this.registry.register(tool);
    }
    for (const tool of allFafTools) {
      this.registry.register(tool);
    }
    this.registry.register(profilingSummaryTool);
    // Lock core tools — plugins cannot override them
    this.registry.lockCore();
  }

  /**
   * Register an additional tool at runtime (e.g. from plugins).
   */
  registerTool(tool: ToolDefinition): void {
    this.registry.register(tool);
  }

  /**
   * Route a parsed intent to the appropriate tool and execute it.
   */
  async dispatch(intent: ParsedIntent): Promise<ToolResult> {
    // Run execution middleware pipeline
    const middlewareBlock = await runMiddleware(intent, this.context);
    if (middlewareBlock) return middlewareBlock;

    const mapping = this.getToolMapping(intent);
    if (!mapping) {
      return this.handleHelp();
    }

    const { toolName, params } = mapping;
    return this.registry.execute(toolName, params, this.context);
  }

  private getToolMapping(intent: ParsedIntent): { toolName: string; params: Record<string, unknown> } | null {
    switch (intent.action) {
      case ActionType.OpenPosition:
        return {
          toolName: 'flash_open_position',
          params: {
            market: intent.market,
            side: intent.side,
            collateral: intent.collateral,
            leverage: intent.leverage,
            collateral_token: intent.collateral_token,
            takeProfit: intent.takeProfit,
            stopLoss: intent.stopLoss,
          },
        };

      case ActionType.ClosePosition:
        return {
          toolName: 'flash_close_position',
          params: {
            market: intent.market,
            side: intent.side,
            closePercent: intent.closePercent,
            closeAmount: intent.closeAmount,
          },
        };

      case ActionType.AddCollateral:
        return {
          toolName: 'flash_add_collateral',
          params: {
            market: intent.market,
            side: intent.side,
            amount: intent.amount,
          },
        };

      case ActionType.RemoveCollateral:
        return {
          toolName: 'flash_remove_collateral',
          params: {
            market: intent.market,
            side: intent.side,
            amount: intent.amount,
          },
        };

      case ActionType.GetPositions:
        return { toolName: 'flash_get_positions', params: {} };

      case ActionType.GetMarketData:
        return {
          toolName: 'flash_get_market_data',
          params: { market: intent.market },
        };

      case ActionType.GetPortfolio:
        return { toolName: 'flash_get_portfolio', params: {} };

      case ActionType.GetVolume:
        return {
          toolName: 'flash_get_volume',
          params: { period: intent.period },
        };

      case ActionType.GetOpenInterest:
        return { toolName: 'flash_get_open_interest', params: {} };

      case ActionType.GetLeaderboard:
        return {
          toolName: 'flash_get_leaderboard',
          params: {
            metric: intent.metric,
            period: intent.period,
            limit: intent.limit,
          },
        };

      case ActionType.GetTraderProfile:
        return {
          toolName: 'flash_get_trader_profile',
          params: { address: intent.address },
        };

      case ActionType.GetFees:
        return {
          toolName: 'flash_get_fees',
          params: { period: intent.period },
        };

      case ActionType.WalletConnect:
        return {
          toolName: 'wallet_connect',
          params: { path: intent.path },
        };

      case ActionType.WalletImport:
        return {
          toolName: 'wallet_import',
          params: { name: intent.name, path: intent.path },
        };

      case ActionType.WalletList:
        return { toolName: 'wallet_list', params: {} };

      case ActionType.WalletUse:
        return {
          toolName: 'wallet_use',
          params: { name: intent.name },
        };

      case ActionType.WalletRemove:
        return {
          toolName: 'wallet_remove',
          params: { name: intent.name },
        };

      case ActionType.WalletDisconnect:
        return { toolName: 'wallet_disconnect', params: {} };

      case ActionType.WalletStatus:
        return { toolName: 'wallet_status', params: {} };

      case ActionType.WalletAddress:
        return { toolName: 'wallet_address', params: {} };

      case ActionType.WalletBalance:
        return { toolName: 'wallet_balance', params: {} };

      case ActionType.WalletTokens:
        return { toolName: 'wallet_tokens', params: {} };

      case ActionType.FlashMarkets:
        return { toolName: 'flash_markets_list', params: {} };

      case ActionType.Help:
        return null;

      // Analysis tools (formerly in agent-tools, now handled by protocol-tools)
      case ActionType.Analyze:
        return { toolName: 'inspect_market', params: { market: intent.market } };

      case ActionType.RiskReport:
        return { toolName: 'portfolio_exposure', params: {} };

      case ActionType.Dashboard:
        return { toolName: 'system_status', params: {} };

      case ActionType.WhaleActivity:
        return { toolName: 'protocol_health', params: {} };

      // Portfolio Intelligence
      case ActionType.PortfolioState:
        return { toolName: 'portfolio_state', params: {} };

      case ActionType.PortfolioExposure:
        return { toolName: 'portfolio_exposure', params: {} };

      case ActionType.PortfolioRebalance:
        return { toolName: 'portfolio_rebalance', params: {} };

      // Market Observability
      case ActionType.LiquidationMap:
        return { toolName: 'liquidation_map', params: { market: intent.market } };

      case ActionType.FundingDashboard:
        return { toolName: 'funding_dashboard', params: { market: intent.market } };

      case ActionType.LiquidityDepth:
        return { toolName: 'liquidity_depth', params: { market: intent.market } };

      case ActionType.ProtocolHealth:
        return { toolName: 'protocol_health', params: {} };

      // Protocol Inspector
      case ActionType.InspectProtocol:
        return { toolName: 'inspect_protocol', params: {} };

      case ActionType.InspectPool:
        return { toolName: 'inspect_pool', params: { pool: intent.pool } };

      case ActionType.InspectMarket:
        return { toolName: 'inspect_market', params: { market: intent.market } };

      // System Diagnostics
      case ActionType.SystemStatus:
        return { toolName: 'system_status', params: {} };

      case ActionType.SystemAudit:
        return { toolName: 'system_audit', params: {} };

      case ActionType.RpcStatus:
        return { toolName: 'rpc_status', params: {} };

      case ActionType.RpcTest:
        return { toolName: 'rpc_test', params: {} };

      case ActionType.RpcList:
        return { toolName: 'rpc_list', params: {} };

      case ActionType.ProtocolStatus:
        return { toolName: 'protocol_status', params: {} };

      case ActionType.TxInspect:
        return { toolName: 'tx_inspect', params: { signature: intent.signature } };

      case ActionType.TxDebug:
        return { toolName: 'tx_debug', params: { signature: intent.signature, showState: intent.showState } };

      case ActionType.TxMetrics:
        return { toolName: 'tx_metrics', params: {} };

      case ActionType.TradeHistory:
        return { toolName: 'trade_history', params: {} };

      case ActionType.SetTpSl:
        return {
          toolName: 'set_tp_sl',
          params: { market: intent.market, side: intent.side, type: intent.type, price: intent.price },
        };

      case ActionType.RemoveTpSl:
        return {
          toolName: 'remove_tp_sl',
          params: { market: intent.market, side: intent.side, type: intent.type },
        };

      case ActionType.TpSlStatus:
        return { toolName: 'tp_sl_status', params: {} };

      case ActionType.LimitOrder:
        return {
          toolName: 'limit_order_place',
          params: {
            market: intent.market,
            side: intent.side,
            leverage: intent.leverage,
            collateral: intent.collateral,
            limitPrice: intent.limitPrice,
          },
        };

      case ActionType.CancelOrder:
        return {
          toolName: 'limit_order_cancel',
          params: { orderId: intent.orderId, market: intent.market, side: intent.side },
        };

      case ActionType.ListOrders:
        return { toolName: 'limit_order_list', params: {} };

      case ActionType.EditLimitOrder:
        return {
          toolName: 'limit_order_edit',
          params: { orderId: intent.orderId, market: intent.market, side: intent.side, limitPrice: intent.limitPrice },
        };

      // ── Close All ──
      case ActionType.CloseAll:
        return { toolName: 'flash_close_all', params: {} };

      // ── Swap ──
      case ActionType.Swap:
        return {
          toolName: 'flash_swap',
          params: { inputToken: intent.inputToken, outputToken: intent.outputToken, amount: intent.amount },
        };

      // ── Earn ──
      case ActionType.EarnAddLiquidity:
        return {
          toolName: 'earn_add_liquidity',
          params: { token: intent.token ?? 'USDC', amount: intent.amount, pool: intent.pool },
        };

      case ActionType.EarnRemoveLiquidity:
        return {
          toolName: 'earn_remove_liquidity',
          params: { token: intent.token ?? 'USDC', percent: intent.percent ?? 100, pool: intent.pool },
        };

      case ActionType.EarnStake:
        return {
          toolName: 'earn_stake',
          params: { amount: intent.amount, pool: intent.pool },
        };

      case ActionType.EarnUnstake:
        return {
          toolName: 'earn_unstake',
          params: { percent: intent.percent ?? 100, pool: intent.pool },
        };

      case ActionType.EarnClaimRewards:
        return { toolName: 'earn_claim_rewards', params: { pool: intent.pool } };

      case ActionType.EarnStatus:
        return { toolName: 'earn_status', params: {} };

      case ActionType.EarnInfo:
        return { toolName: 'earn_info', params: { pool: intent.pool } };

      case ActionType.EarnPositions:
        return { toolName: 'earn_positions', params: {} };

      case ActionType.EarnBest:
        return { toolName: 'earn_best', params: {} };

      case ActionType.EarnSimulate:
        return { toolName: 'earn_simulate', params: { pool: intent.pool, amount: intent.amount } };

      case ActionType.EarnDashboard:
        return { toolName: 'earn_dashboard', params: {} };

      case ActionType.EarnPnl:
        return { toolName: 'earn_pnl', params: {} };

      case ActionType.EarnDemand:
        return { toolName: 'earn_demand', params: {} };

      case ActionType.EarnRotate:
        return { toolName: 'earn_rotate', params: {} };

      case ActionType.EarnIntegrations:
        return { toolName: 'earn_integrations', params: {} };

      case ActionType.EarnHistory:
        return { toolName: 'earn_history', params: { pool: intent.pool } };

      // ── FAF Token ──
      case ActionType.FafStatus:
        return { toolName: 'faf_status', params: {} };

      case ActionType.FafStake:
        return { toolName: 'faf_stake', params: { amount: intent.amount } };

      case ActionType.FafUnstake:
        return { toolName: 'faf_unstake', params: { amount: intent.amount } };

      case ActionType.FafClaim:
        return { toolName: 'faf_claim', params: { type: (intent as Record<string, unknown>).type ?? 'all' } };

      case ActionType.FafTier:
        return { toolName: 'faf_tier', params: {} };

      case ActionType.FafRewards:
        return { toolName: 'faf_rewards', params: {} };

      case ActionType.FafReferral:
        return { toolName: 'faf_referral', params: {} };

      case ActionType.FafPoints:
        return { toolName: 'faf_points', params: {} };

      case ActionType.FafUnstakeRequests:
        return { toolName: 'faf_unstake_requests', params: {} };

      case ActionType.FafCancelUnstake:
        return { toolName: 'faf_cancel_unstake', params: { requestId: (intent as Record<string, unknown>).requestId } };

      case ActionType.EngineStatus:
        return { toolName: 'engine_status', params: {} };

      case ActionType.EngineBenchmark:
        return { toolName: 'engine_benchmark', params: {} };

      default:
        return null;
    }
  }

  private handleHelp(): ToolResult {
    const cmd = theme.command;
    const dim = theme.dim;
    const sec = theme.section;

    const COL_WIDTH = 32;

    const lines = [
      '',
      `  ${theme.accentBold('FLASH TERMINAL')}  ${dim('— Command Reference')}`,
      `  ${theme.separator(52)}`,
      '',
    ];

    const categories = getCommandsByCategory();
    for (const [category, entries] of categories) {
      if (entries.length === 0) continue;
      lines.push(`  ${sec(category)}`);
      for (const entry of entries) {
        const label = entry.helpFormat || entry.name;
        const padded = label.padEnd(COL_WIDTH);
        lines.push(`    ${cmd(padded)}${entry.description}`);
      }
      lines.push('');
    }

    lines.push(`  ${theme.separator(52)}`);
    lines.push(`  ${cmd('help'.padEnd(COL_WIDTH))}Show this reference`);
    lines.push(`  ${cmd('help <command>'.padEnd(COL_WIDTH))}Detailed usage for a command`);
    lines.push(`  ${cmd('exit'.padEnd(COL_WIDTH))}Close the terminal`);
    lines.push('');
    lines.push(`  ${dim('Natural language is also supported.')}`);
    lines.push(`  ${dim('Example: "what\'s the price of SOL?" or "show me BTC analysis"')}`);
    lines.push('');

    return { success: true, message: lines.join('\n') };
  }
}
