import chalk from 'chalk';
import { OfflineInterpreter } from '../ai/interpreter.js';
import { ActionType, ParsedIntent, DryRunPreview, TradeSide, IFlashClient, FlashConfig } from '../types/index.js';
import { resolveMarket } from '../utils/market-resolver.js';
import { humanizeSdkError } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import { buildFastDispatch } from './command-registry.js';

const COMMAND_TIMEOUT_MS = 120_000;

/** Single-token fast dispatch — derived from command registry */
const FAST_DISPATCH = buildFastDispatch() as Record<string, ParsedIntent>;

/** Timeout wrapper for async operations */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Command timed out after ${ms / 1000}s: ${label}`)), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Alias for backward compat — delegates to centralized resolver */
function resolveMarketAlias(input: string): string {
  return resolveMarket(input);
}

export interface DryRunDeps {
  interpreter: OfflineInterpreter;
  flashClient: IFlashClient;
  config: FlashConfig;
}

/**
 * Normalize natural language dryrun input into structured command.
 * Accepts patterns like:
 *   "sol long 5x $100"  "btc short 3x 200 dollars"  "open sol long 10x for $50"
 * Normalizes to: "open <leverage>x <side> <asset> $<amount>"
 */
export function normalizeDryRunCommand(raw: string): string {
  const lower = raw.toLowerCase().trim();

  // Strip leading "open" if present — we'll re-add it
  const stripped = lower.replace(/^open\s+/, '');

  // Extract components using flexible regex
  // Side: long or short
  const sideMatch = stripped.match(/\b(long|short)\b/);
  // Leverage: NNx or NNX
  const levMatch = stripped.match(/\b(\d+(?:\.\d+)?)\s*x\b/i);
  // Amount: $NN, NN dollars, NN bucks, for NN, or bare number at end
  const amountMatch =
    stripped.match(/\$\s*(\d+(?:\.\d+)?)/) ||
    stripped.match(/(\d+(?:\.\d+)?)\s*(?:dollars?|bucks?|usd)\b/) ||
    stripped.match(/(?:for|with)\s+\$?\s*(\d+(?:\.\d+)?)/) ||
    stripped.match(/\b(\d+(?:\.\d+)?)\s*$/);
  // Asset: first word that isn't a known keyword
  const keywords = new Set([
    'open',
    'long',
    'short',
    'for',
    'with',
    'lev',
    'leverage',
    'dollars',
    'dollar',
    'bucks',
    'buck',
    'usd',
    'x',
  ]);
  const words = stripped.split(/\s+/);
  let asset = '';
  for (const w of words) {
    const clean = w.replace(/[^a-z0-9]/gi, '');
    if (!clean) continue;
    if (keywords.has(clean)) continue;
    if (/^\d/.test(clean)) continue; // skip numbers
    if (/^\$/.test(w)) continue; // skip dollar amounts
    asset = clean;
    break;
  }

  // If we have all components, build structured command
  if (sideMatch && asset) {
    const side = sideMatch[1];
    const lev = levMatch ? levMatch[1] : '1';
    const amount = amountMatch ? amountMatch[1] : '';

    if (amount) {
      return `open ${lev}x ${side} ${asset.toUpperCase()} $${amount}`;
    }
  }

  // Fallback: prepend "open" if missing action keyword
  const actionKeywords = ['open', 'close', 'add', 'remove', 'long', 'short'];
  const hasAction = actionKeywords.some((k) => lower.startsWith(k));
  return hasAction ? raw : `open ${raw}`;
}

/** Render a dry-run transaction preview. */
export function renderDryRunPreview(preview: DryRunPreview): void {
  const sideColor = preview.side === TradeSide.Long ? chalk.green : chalk.red;
  const sideStr = preview.side === TradeSide.Long ? 'LONG' : 'SHORT';

  console.log('');
  console.log(chalk.bold.cyan('  TRANSACTION PREVIEW (DRY RUN)'));
  console.log(chalk.dim('  ────────────────────────────────────────'));
  console.log('');

  // Trade parameters
  console.log(chalk.bold('  Trade Parameters'));
  console.log(`    Market:         ${chalk.bold(preview.market)}`);
  console.log(`    Side:           ${sideColor(sideStr)}`);
  console.log(`    Collateral:     ${chalk.bold('$' + preview.collateral.toFixed(2))}`);
  console.log(`    Leverage:       ${chalk.bold(preview.leverage + 'x')}`);
  console.log(`    Position Size:  ${chalk.bold('$' + preview.positionSize.toFixed(2))}`);
  console.log('');
  console.log(`    Entry Price:    $${preview.entryPrice.toFixed(preview.entryPrice < 1 ? 6 : 2)}`);
  console.log(
    `    Liq. Price:     ${chalk.red('$' + preview.liquidationPrice.toFixed(preview.liquidationPrice < 1 ? 6 : 2))}`,
  );
  console.log(`    Est. Fee:       $${preview.estimatedFee.toFixed(4)}`);

  // Solana transaction info (live mode only)
  if (preview.programId) {
    console.log('');
    console.log(chalk.dim('  ────────────────────────────────────────'));
    console.log(chalk.bold('  Solana Transaction'));
    console.log(`    Program:        ${chalk.dim(preview.programId)}`);
    console.log(`    Accounts:       ${preview.accountCount}`);
    console.log(`    Instructions:   ${preview.instructionCount}`);
    console.log(`    Tx Size:        ${preview.transactionSize} bytes`);
    console.log(`    CU Budget:      ${preview.estimatedComputeUnits?.toLocaleString()}`);
  }

  // Simulation results
  if (preview.simulationSuccess !== undefined) {
    console.log('');
    console.log(chalk.dim('  ────────────────────────────────────────'));
    console.log(chalk.bold('  Simulation Result'));

    if (preview.simulationSuccess) {
      console.log(`    Status:         ${chalk.green('SUCCESS')}`);
      if (preview.simulationUnitsConsumed) {
        console.log(`    CU Consumed:    ${preview.simulationUnitsConsumed.toLocaleString()}`);
      }
    } else {
      console.log(`    Status:         ${chalk.red('FAILED')}`);
      if (preview.simulationError) {
        // Map raw Solana errors to human-readable explanations
        const rawErr = preview.simulationError;
        const isInvalidArg = rawErr.includes('InvalidArgument') || rawErr.includes('invalid program argument');
        if (isInvalidArg) {
          console.log(`    Error:          ${chalk.red('Protocol rejected parameters')}`);
          console.log('');
          console.log(chalk.dim('  Possible causes:'));
          console.log(chalk.dim('    • Leverage exceeds market limit'));
          console.log(chalk.dim('    • Insufficient pool liquidity'));
          console.log(chalk.dim('    • Position size exceeds protocol limits'));
          console.log(chalk.dim('    • Duplicate position on same market/side'));
        } else {
          console.log(`    Error:          ${chalk.red(humanizeSdkError(rawErr))}`);
        }
      }
    }

    // Show program logs (truncated)
    if (preview.simulationLogs && preview.simulationLogs.length > 0) {
      console.log('');
      console.log(chalk.bold('  Program Logs'));
      const maxLogs = 15;
      const logs = preview.simulationLogs.slice(0, maxLogs);
      for (const log of logs) {
        // Highlight program invocations and errors
        if (log.includes('invoke')) {
          console.log(`    ${chalk.cyan(log)}`);
        } else if (log.includes('error') || log.includes('Error') || log.includes('failed')) {
          console.log(`    ${chalk.red(log)}`);
        } else if (log.includes('success')) {
          console.log(`    ${chalk.green(log)}`);
        } else {
          console.log(`    ${chalk.dim(log)}`);
        }
      }
      if (preview.simulationLogs.length > maxLogs) {
        console.log(chalk.dim(`    ... ${preview.simulationLogs.length - maxLogs} more log lines`));
      }
    }
  }

  console.log('');
  console.log(chalk.dim('  ────────────────────────────────────────'));
  console.log(chalk.yellow.bold('  No transaction was signed or sent.'));
  console.log('');
}

/**
 * Handle dry-run commands.
 * Parses the inner command, builds a transaction preview, and displays it.
 * SAFETY: No transaction is ever signed or sent.
 */
export async function handleDryRun(deps: DryRunDeps, innerCommand: string): Promise<void> {
  // Pre-normalize natural language patterns into structured format:
  //   "sol long 5x $100"           → "open 5x long SOL $100"
  //   "sol short 3x 200"           → "open 3x short SOL $200"
  //   "open sol long 10x for $50"  → "open 10x long SOL $50"
  //   "btc short 5x 100 dollars"   → "open 5x short BTC $100"
  const normalizedCommand = normalizeDryRunCommand(innerCommand);

  // Parse the inner command using the interpreter
  process.stdout.write(chalk.dim('  Parsing inner command...\r'));
  let innerIntent: ParsedIntent;
  try {
    innerIntent = await withTimeout(
      deps.interpreter.parseIntent(normalizedCommand),
      COMMAND_TIMEOUT_MS,
      'dryrun-parse',
    );
    process.stdout.write('                           \r');
  } catch (error: unknown) {
    console.log(chalk.red(`  Failed to parse inner command: ${getErrorMessage(error)}`));
    return;
  }

  // Only trade actions are supported for dry-run
  if (innerIntent.action !== ActionType.OpenPosition) {
    // Surface validation alerts (e.g., invalid leverage, unknown market)
    // instead of showing the generic usage message
    const alert = (innerIntent as Record<string, unknown>)._alert as { message?: string } | undefined;
    if (alert?.message) {
      console.log(alert.message);
      return;
    }

    console.log('');
    console.log(chalk.yellow('  Dry run currently supports open position commands only.'));
    console.log('');
    console.log(chalk.dim('  Usage:'));
    console.log(chalk.dim('    dryrun open 2x long SOL $10'));
    console.log(chalk.dim('    dryrun open 5x short BTC $100'));
    console.log(chalk.dim('    dryrun sol long 5x $100'));
    console.log(chalk.dim('    dryrun btc short 3x 200 dollars'));
    console.log('');
    return;
  }
  const { market, side, collateral, leverage, collateral_token } = innerIntent;

  // Check if virtual market is currently open before building preview
  const { getMarketStatus, formatMarketClosedMessage } = await import('../data/market-hours.js');
  const mktStatus = getMarketStatus(market);
  if (!mktStatus.isOpen) {
    console.log(chalk.yellow(formatMarketClosedMessage(market)));
    return;
  }

  process.stdout.write(chalk.dim('  Building transaction preview...\r'));

  try {
    if (!deps.flashClient.previewOpenPosition) {
      console.log(chalk.red('  Dry run not available for this client.'));
      return;
    }

    const preview = await withTimeout(
      deps.flashClient.previewOpenPosition(market, side, collateral, leverage, collateral_token),
      COMMAND_TIMEOUT_MS,
      'dryrun-preview',
    );
    process.stdout.write('                                   \r');
    renderDryRunPreview(preview);
  } catch (error: unknown) {
    process.stdout.write('                                   \r');
    const errMsg = getErrorMessage(error);
    const humanized = humanizeSdkError(errMsg, collateral, leverage);
    console.log(chalk.red(`  Dry run failed: ${humanized}`));
  }
}

/**
 * Resolve a raw command string into a ParsedIntent.
 * Reuses FAST_DISPATCH, inspect routing, and the AI interpreter.
 * Used by watch mode and dry-run to parse commands without executing them.
 */
export async function resolveIntent(deps: DryRunDeps, input: string): Promise<ParsedIntent> {
  const lower = input.toLowerCase();
  const fastIntent = FAST_DISPATCH[lower];

  if (fastIntent) return fastIntent;

  // Analytics commands with market argument — ensure alias resolution
  if (lower.startsWith('analyze ') || lower.startsWith('analyse ')) {
    const prefix = lower.startsWith('analyze ') ? 'analyze ' : 'analyse ';
    const market = resolveMarketAlias(input.slice(prefix.length).trim());
    return { action: ActionType.Analyze, market } as ParsedIntent;
  }
  if (lower.startsWith('liquidations ') || lower.startsWith('liquidation ')) {
    const prefix = lower.startsWith('liquidations ') ? 'liquidations ' : 'liquidation ';
    const market = resolveMarketAlias(input.slice(prefix.length).trim());
    return { action: ActionType.LiquidationMap, market } as ParsedIntent;
  }
  if (lower.startsWith('funding ')) {
    const market = resolveMarketAlias(input.slice('funding '.length).trim());
    return { action: ActionType.FundingDashboard, market } as ParsedIntent;
  }
  if (lower.startsWith('depth ')) {
    const market = resolveMarketAlias(input.slice('depth '.length).trim());
    return { action: ActionType.LiquidityDepth, market } as ParsedIntent;
  }

  if (lower.startsWith('inspect pool ')) {
    const pool = input.slice('inspect pool '.length).trim();
    return { action: ActionType.InspectPool, pool } as ParsedIntent;
  }

  if (
    lower.startsWith('inspect market ') ||
    (lower.startsWith('inspect ') &&
      !lower.startsWith('inspect pool ') &&
      !lower.startsWith('inspect protocol') &&
      lower !== 'inspect')
  ) {
    const prefix = lower.startsWith('inspect market ') ? 'inspect market ' : 'inspect ';
    const rawMarket = input.slice(prefix.length).trim();
    const market = resolveMarketAlias(rawMarket);
    return { action: ActionType.InspectMarket, market } as ParsedIntent;
  }

  // Fall through to interpreter
  return deps.interpreter.parseIntent(input);
}
