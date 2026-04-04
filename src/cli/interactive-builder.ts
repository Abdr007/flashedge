/**
 * Interactive Trade Builder
 *
 * Guides users through trade construction when commands are incomplete.
 * Prompts for missing parameters one at a time, validates inline,
 * and returns a complete ParsedIntent.
 *
 * Triggered when the parser detects an incomplete but recognizable trade command.
 */

import chalk from 'chalk';
import { ActionType, TradeSide, ParsedIntent } from '../types/index.js';
import { getMaxLeverage } from '../config/index.js';
import { getAllMarkets, getPoolForMarket } from '../config/index.js';
import { resolveMarket } from '../utils/market-resolver.js';
import { getPreferredLeverage } from './trade-predictor.js';
import { theme } from './theme.js';
import { IS_AGENT } from '../no-dna.js';

export interface PartialTrade {
  market?: string;
  side?: TradeSide;
  leverage?: number;
  collateral?: number;
  takeProfit?: number;
  stopLoss?: number;
}

/**
 * Detect if input is a partial trade command (has side or market but missing params).
 * Returns a PartialTrade with whatever was parsed, or null if not a trade command.
 */
export function detectPartialTrade(input: string): PartialTrade | null {
  const lower = input.toLowerCase().trim();
  const tokens = lower.split(/\s+/);
  if (tokens.length === 0 || tokens.length > 4) return null;

  const partial: PartialTrade = {};

  // Detect side
  for (const t of tokens) {
    if (t === 'long' || t === 'buy' || t === 'l') {
      partial.side = TradeSide.Long;
      break;
    }
    if (t === 'short' || t === 'sell' || t === 's') {
      partial.side = TradeSide.Short;
      break;
    }
  }

  // Detect market
  for (const t of tokens) {
    if (['long', 'short', 'buy', 'sell', 'open', 'enter', 'l', 's'].includes(t)) continue;
    const resolved = resolveMarket(t);
    if (getAllMarkets().includes(resolved)) {
      partial.market = resolved;
      break;
    }
  }

  // Detect leverage
  for (const t of tokens) {
    const levMatch = t.match(/^(\d+(?:\.\d+)?)x$/);
    if (levMatch) {
      partial.leverage = parseFloat(levMatch[1]);
      break;
    }
  }

  // Detect collateral
  for (const t of tokens) {
    if (/^\$?\d+(?:\.\d+)?$/.test(t) && !t.endsWith('x')) {
      const num = parseFloat(t.replace('$', ''));
      if (num > 0 && num !== partial.leverage) {
        partial.collateral = num;
        break;
      }
    }
  }

  // Must have a side to be a partial trade (market alone could be a price query)
  if (!partial.side) return null;
  // Must be missing at least one required param
  if (partial.side && partial.market && partial.leverage && partial.collateral) return null;

  return partial;
}

/**
 * Build an interactive trade prompt.
 * Asks the user for missing parameters one at a time.
 *
 * @param ask - readline question function from terminal
 * @param partial - the partially parsed trade
 * @param degenMode - whether degen leverage limits apply
 * @returns Complete ParsedIntent, or null if user cancels
 */
export async function buildTradeInteractively(
  ask: (prompt: string) => Promise<string>,
  partial: PartialTrade,
  degenMode = false,
): Promise<ParsedIntent | null> {
  // NO_DNA: never prompt — return null
  if (IS_AGENT) return null;

  console.log('');
  console.log(theme.section('  Trade Builder'));
  console.log('');

  // 1. Market
  let market = partial.market;
  if (!market) {
    const answer = (await ask(`  ${chalk.dim('Market')} ${chalk.yellow('>')} `)).trim();
    if (!answer || answer.toLowerCase() === 'cancel' || answer.toLowerCase() === 'q') return null;
    market = resolveMarket(answer);
    if (!getAllMarkets().includes(market)) {
      console.log(chalk.red(`  Unknown market: ${answer}`));
      return null;
    }
  }

  // 2. Side
  let side = partial.side;
  if (!side) {
    const answer = (
      await ask(`  ${chalk.dim('Side')} (${chalk.green('long')}/${chalk.red('short')}) ${chalk.yellow('>')} `)
    )
      .trim()
      .toLowerCase();
    if (answer === 'long' || answer === 'l') side = TradeSide.Long;
    else if (answer === 'short' || answer === 's') side = TradeSide.Short;
    else if (!answer || answer === 'cancel' || answer === 'q') return null;
    else {
      console.log(chalk.red('  Must be "long" or "short"'));
      return null;
    }
  }

  // 3. Leverage
  let leverage = partial.leverage;
  const maxLev = getMaxLeverage(market, degenMode);
  const preferred = getPreferredLeverage(market);
  if (!leverage) {
    const defaultStr = preferred ? `${preferred}x` : '2x';
    const answer = (
      await ask(`  ${chalk.dim('Leverage')} (max ${maxLev}x, default ${defaultStr}) ${chalk.yellow('>')} `)
    ).trim();
    if (!answer) {
      leverage = preferred ?? 2;
    } else if (answer === 'cancel' || answer === 'q') {
      return null;
    } else {
      leverage = parseFloat(answer.replace(/x$/i, ''));
      if (!Number.isFinite(leverage) || leverage < 1.1) {
        console.log(chalk.red('  Invalid leverage'));
        return null;
      }
    }
  }

  // Validate leverage
  if (leverage > maxLev) {
    console.log(chalk.red(`  Maximum leverage for ${market}: ${maxLev}x (got ${leverage}x)`));
    return null;
  }

  // 4. Collateral
  let collateral = partial.collateral;
  if (!collateral) {
    const answer = (await ask(`  ${chalk.dim('Collateral (USD)')} ${chalk.yellow('>')} `)).trim();
    if (!answer || answer === 'cancel' || answer === 'q') return null;
    collateral = parseFloat(answer.replace(/^\$/, ''));
    if (!Number.isFinite(collateral) || collateral <= 0) {
      console.log(chalk.red('  Invalid amount'));
      return null;
    }
  }

  // Show summary
  const sizeUsd = collateral * leverage;
  console.log('');
  console.log(
    `  ${theme.dim('Market:')}     ${chalk.bold(market)} ${side === TradeSide.Long ? chalk.green('LONG') : chalk.red('SHORT')}`,
  );
  console.log(`  ${theme.dim('Leverage:')}   ${leverage}x`);
  console.log(`  ${theme.dim('Collateral:')} $${collateral}`);
  console.log(`  ${theme.dim('Size:')}       $${sizeUsd.toFixed(2)}`);
  console.log('');

  return {
    action: ActionType.OpenPosition,
    market,
    side,
    leverage,
    collateral,
  } as ParsedIntent;
}

/**
 * Validate a trade parameter inline and return a warning message, or null if valid.
 */
export function validateTradeParam(
  field: 'leverage' | 'collateral' | 'market',
  value: string | number,
  market?: string,
  degenMode = false,
): string | null {
  if (field === 'leverage') {
    const lev = typeof value === 'number' ? value : parseFloat(String(value).replace(/x$/i, ''));
    if (!Number.isFinite(lev) || lev < 1.1) return 'Leverage must be at least 1.1x';
    if (market) {
      const maxLev = getMaxLeverage(market, degenMode);
      if (lev > maxLev) return `Maximum leverage for ${market}: ${maxLev}x`;
    }
    return null;
  }

  if (field === 'collateral') {
    const amt = typeof value === 'number' ? value : parseFloat(String(value).replace(/^\$/, ''));
    if (!Number.isFinite(amt) || amt <= 0) return 'Collateral must be a positive number';
    if (amt < 0.01) return 'Minimum collateral: $0.01';
    return null;
  }

  if (field === 'market') {
    const resolved = resolveMarket(String(value));
    if (!getAllMarkets().includes(resolved)) return `Unknown market: ${value}`;
    if (!getPoolForMarket(resolved)) return `Market ${resolved} is not tradeable`;
    return null;
  }

  return null;
}
