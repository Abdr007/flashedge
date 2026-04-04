import chalk from 'chalk';
import { ActionType, ToolContext, ToolResult, ParsedIntent } from '../types/index.js';
import { getLogger } from '../utils/logger.js';

// ─── Structured Error Codes ─────────────────────────────────────────────────

export enum ErrorCode {
  WALLET_DISCONNECTED = 'ERR_WALLET_DISCONNECTED',
  WALLET_READ_ONLY = 'ERR_WALLET_READ_ONLY',
  POOL_NOT_FOUND = 'ERR_POOL_NOT_FOUND',
  INVALID_AMOUNT = 'ERR_INVALID_AMOUNT',
  INVALID_PERCENTAGE = 'ERR_INVALID_PERCENTAGE',
  INVALID_MARKET = 'ERR_INVALID_MARKET',
  INSUFFICIENT_BALANCE = 'ERR_INSUFFICIENT_BALANCE',
  SIMULATION_FAILED = 'ERR_SIMULATION_FAILED',
  RPC_UNAVAILABLE = 'ERR_RPC_UNAVAILABLE',
  RATE_LIMITED = 'ERR_RATE_LIMITED',
  UNKNOWN_COMMAND = 'ERR_UNKNOWN_COMMAND',
}

// ─── Trading Actions ─────────────────────────────────────────────────────────

const TRADING_ACTIONS = new Set<ActionType>([
  ActionType.OpenPosition,
  ActionType.ClosePosition,
  ActionType.AddCollateral,
  ActionType.RemoveCollateral,
  ActionType.CloseAll,
  ActionType.Swap,
  ActionType.LimitOrder,
  ActionType.CancelOrder,
  ActionType.EditLimitOrder,
  ActionType.SetTpSl,
  ActionType.RemoveTpSl,
  ActionType.EarnAddLiquidity,
  ActionType.EarnRemoveLiquidity,
  ActionType.EarnStake,
  ActionType.EarnUnstake,
  ActionType.EarnClaimRewards,
]);

const READ_ONLY_ALLOWED = new Set<ActionType>([
  ActionType.GetPositions,
  ActionType.GetMarketData,
  ActionType.GetPortfolio,
  ActionType.GetVolume,
  ActionType.GetOpenInterest,
  ActionType.GetLeaderboard,
  ActionType.GetTraderProfile,
  ActionType.GetFees,
  ActionType.FlashMarkets,
  ActionType.Help,
  ActionType.Analyze,
  ActionType.RiskReport,
  ActionType.Dashboard,
  ActionType.WhaleActivity,

  ActionType.PortfolioState,
  ActionType.PortfolioExposure,
  ActionType.PortfolioRebalance,
  ActionType.WalletStatus,
  ActionType.WalletAddress,
  ActionType.WalletBalance,
  ActionType.WalletTokens,
  ActionType.WalletList,
  ActionType.WalletConnect,
  ActionType.WalletImport,
  ActionType.WalletUse,
  ActionType.WalletRemove,
  ActionType.WalletDisconnect,
  ActionType.LiquidationMap,
  ActionType.FundingDashboard,
  ActionType.LiquidityDepth,
  ActionType.ProtocolHealth,
  ActionType.InspectProtocol,
  ActionType.InspectPool,
  ActionType.InspectMarket,
  // Diagnostics
  ActionType.SystemStatus,
  ActionType.RpcStatus,
  ActionType.RpcTest,
  ActionType.TxInspect,
  ActionType.ProtocolStatus,
  // Trade journal
  ActionType.TradeHistory,
  ActionType.MarketMonitor,
  // Dry run (preview only, no signing)
  ActionType.DryRun,
]);

/**
 * Middleware result — either pass (continue pipeline) or block (return error).
 */
interface MiddlewareResult {
  pass: boolean;
  blocked?: ToolResult;
}

type Middleware = (intent: ParsedIntent, context: ToolContext) => MiddlewareResult | Promise<MiddlewareResult>;

// ─── Middleware Definitions ──────────────────────────────────────────────────

/**
 * Attempt to restore the wallet session from the WalletStore.
 * Called when the walletManager reports isConnected=false (e.g. after idle timeout).
 * Returns true if restoration succeeded.
 */
async function tryRestoreWalletSession(context: ToolContext): Promise<boolean> {
  const wm = context.walletManager;
  if (!wm) return false;

  try {
    // Try to reload the last-used wallet from the wallet store
    const { WalletStore } = await import('../wallet/wallet-store.js');
    const { getLastWallet } = await import('../wallet/session.js');
    const store = new WalletStore();

    // Priority: last session wallet → default wallet → single wallet
    const lastWallet = getLastWallet();
    const defaultWallet = store.getDefault();
    const wallets = store.listWallets();

    const target = lastWallet ?? defaultWallet ?? (wallets.length === 1 ? wallets[0] : null);
    if (!target || !wallets.includes(target)) return false;

    const walletPath = store.getWalletPath(target);
    const result = wm.loadFromFile(walletPath);

    if (result && wm.isConnected) {
      context.walletAddress = result.address;
      context.walletName = target;
      const logger = getLogger();
      logger.info('WALLET', `Session restored: ${target} (${result.address.slice(0, 8)}...)`);
      return true;
    }
  } catch {
    // Restoration failed — proceed to block
  }
  return false;
}

/**
 * Wallet middleware: block trading commands when no wallet is connected (live mode).
 * Attempts automatic session restoration before blocking.
 */
async function walletMiddleware(intent: ParsedIntent, context: ToolContext): Promise<MiddlewareResult> {
  if (context.simulationMode) return { pass: true };
  if (!TRADING_ACTIONS.has(intent.action)) return { pass: true };

  const wm = context.walletManager;
  if (wm?.isConnected) return { pass: true };

  // Wallet not connected — attempt automatic restoration from stored wallets
  if (wm && (await tryRestoreWalletSession(context))) {
    // Restoration succeeded — print a notice and continue
    process.stdout.write(chalk.yellow('  Wallet session restored.\n'));
    return { pass: true };
  }

  return {
    pass: false,
    blocked: {
      success: false,
      message: [
        '',
        chalk.red('  Trade blocked: no wallet connected.'),
        chalk.dim('  Use "wallet import", "wallet use", or "wallet connect" first.'),
        '',
      ].join('\n'),
    },
  };
}

/**
 * Read-only middleware: block non-read commands when in read-only mode.
 */
function readOnlyMiddleware(intent: ParsedIntent, context: ToolContext): MiddlewareResult {
  if (context.simulationMode) return { pass: true };

  const wm = context.walletManager;
  if (!wm || wm.isConnected) return { pass: true }; // either no wallet concern or fully connected

  // Read-only mode: only has address but no keypair
  if (wm.isReadOnly && TRADING_ACTIONS.has(intent.action)) {
    return {
      pass: false,
      blocked: {
        success: false,
        message: [
          '',
          chalk.yellow('  READ-ONLY MODE'),
          chalk.dim('  Viewing is allowed but trading requires a full wallet connection.'),
          chalk.dim('  Use "wallet import" or "wallet connect" to enable trading.'),
          '',
        ].join('\n'),
      },
    };
  }

  return { pass: true };
}

/**
 * Logging middleware: log every command execution.
 */
function loggingMiddleware(intent: ParsedIntent, context: ToolContext): MiddlewareResult {
  const logger = getLogger();
  logger.debug('MIDDLEWARE', `Command: ${intent.action}`, {
    wallet: context.walletAddress,
    mode: context.simulationMode ? 'simulation' : 'live',
  });
  return { pass: true };
}

// ─── Middleware Pipeline ─────────────────────────────────────────────────────

const MIDDLEWARE_CHAIN: Middleware[] = [loggingMiddleware, walletMiddleware, readOnlyMiddleware];

/**
 * Run all middleware checks before executing a command.
 * Returns null if all middleware pass, or a ToolResult if blocked.
 */
export async function runMiddleware(intent: ParsedIntent, context: ToolContext): Promise<ToolResult | null> {
  for (const mw of MIDDLEWARE_CHAIN) {
    const result = await mw(intent, context);
    if (!result.pass && result.blocked) {
      return result.blocked;
    }
  }
  return null;
}

/**
 * Check if an action is allowed in read-only mode.
 */
export function isReadOnlyAllowed(action: ActionType): boolean {
  return READ_ONLY_ALLOWED.has(action);
}

/**
 * Check if an action is a trading action.
 */
export function isTradingAction(action: ActionType): boolean {
  return TRADING_ACTIONS.has(action);
}
