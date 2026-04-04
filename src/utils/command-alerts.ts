/**
 * Command Alert & Warning System
 *
 * Generates structured alerts when users enter incorrect or unsafe commands.
 * All alert text is pre-formatted for terminal display (chalk-colored).
 */
import chalk from 'chalk';
import { getAllMarkets } from '../config/index.js';

// ─── Alert Types ─────────────────────────────────────────────────────────────

export interface CommandAlert {
  type: 'syntax' | 'unknown' | 'safety' | 'parameter' | 'market';
  message: string;
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function alertHeader(msg: string): string {
  return chalk.yellow(`  ⚠ ${msg}`);
}

function usageLine(format: string): string {
  return `    ${chalk.cyan(format)}`;
}

function exampleLine(example: string): string {
  return chalk.dim(`    ${example}`);
}

// ─── Syntax Alerts ───────────────────────────────────────────────────────────

export function openSyntaxAlert(): CommandAlert {
  return {
    type: 'syntax',
    message: [
      '',
      alertHeader('Invalid open command syntax'),
      '',
      chalk.bold('  Correct usage:'),
      usageLine('open <leverage>x <long|short> <market> $<collateral>'),
      '',
      chalk.bold('  Examples:'),
      exampleLine('open 2x long SOL $100'),
      exampleLine('open 5x short BTC $500'),
      exampleLine('open 3x long ETH $50 tp $2500 sl $1900'),
      '',
    ].join('\n'),
  };
}

export function closeSyntaxAlert(): CommandAlert {
  return {
    type: 'syntax',
    message: [
      '',
      alertHeader('Invalid close command syntax'),
      '',
      chalk.bold('  Correct usage:'),
      usageLine('close <market> <long|short>'),
      usageLine('close <market> <long|short> <percent>%'),
      usageLine('close <market> <long|short> $<amount>'),
      '',
      chalk.bold('  Examples:'),
      exampleLine('close SOL long'),
      exampleLine('close SOL long 50%'),
      exampleLine('close BTC short $200'),
      '',
    ].join('\n'),
  };
}

export function addCollateralSyntaxAlert(): CommandAlert {
  return {
    type: 'syntax',
    message: [
      '',
      alertHeader('Invalid add collateral syntax'),
      '',
      chalk.bold('  Correct usage:'),
      usageLine('add $<amount> to <market> <long|short>'),
      '',
      chalk.bold('  Examples:'),
      exampleLine('add $100 to SOL long'),
      exampleLine('add $50 to BTC short'),
      '',
    ].join('\n'),
  };
}

export function removeCollateralSyntaxAlert(): CommandAlert {
  return {
    type: 'syntax',
    message: [
      '',
      alertHeader('Invalid remove collateral syntax'),
      '',
      chalk.bold('  Correct usage:'),
      usageLine('remove $<amount> from <market> <long|short>'),
      '',
      chalk.bold('  Examples:'),
      exampleLine('remove $100 from SOL long'),
      exampleLine('remove $50 from BTC short'),
      '',
    ].join('\n'),
  };
}

export function setTpSlSyntaxAlert(): CommandAlert {
  return {
    type: 'syntax',
    message: [
      '',
      alertHeader('Invalid TP/SL syntax'),
      '',
      chalk.bold('  Correct usage:'),
      usageLine('set tp <market> <long|short> $<price>'),
      usageLine('set sl <market> <long|short> $<price>'),
      '',
      chalk.bold('  Examples:'),
      exampleLine('set tp SOL long $95'),
      exampleLine('set sl BTC long $60000'),
      exampleLine('set tp ETH short $1800'),
      '',
    ].join('\n'),
  };
}

export function limitOrderSyntaxAlert(): CommandAlert {
  return {
    type: 'syntax',
    message: [
      '',
      alertHeader('Invalid limit order syntax'),
      '',
      chalk.bold('  Correct usage:'),
      usageLine('limit <long|short> <market> <leverage>x $<collateral> @ $<price>'),
      '',
      chalk.bold('  Examples:'),
      exampleLine('limit long SOL 2x $100 @ $82'),
      exampleLine('limit short BTC 3x $200 at $72000'),
      '',
    ].join('\n'),
  };
}

// ─── Parameter Alerts ────────────────────────────────────────────────────────

export function invalidLeverageAlert(value: number): CommandAlert {
  return {
    type: 'parameter',
    message: ['', alertHeader(`Invalid leverage: ${value}x`), chalk.dim('  Allowed range: 1.1x – 1000x (enable degen mode for higher limits)'), ''].join('\n'),
  };
}

export function invalidCollateralAlert(value: number): CommandAlert {
  return {
    type: 'parameter',
    message: [
      '',
      alertHeader(`Invalid collateral: $${value}`),
      chalk.dim('  Collateral must be a positive number.'),
      '',
    ].join('\n'),
  };
}

export function invalidPercentageAlert(value: number): CommandAlert {
  return {
    type: 'parameter',
    message: [
      '',
      alertHeader(`Invalid percentage: ${value}%`),
      chalk.dim('  Percentage must be between 1% and 100%.'),
      '',
    ].join('\n'),
  };
}

export function invalidPriceAlert(value: number): CommandAlert {
  return {
    type: 'parameter',
    message: ['', alertHeader(`Invalid price: $${value}`), chalk.dim('  Price must be a positive number.'), ''].join(
      '\n',
    ),
  };
}

// ─── Market Alerts ───────────────────────────────────────────────────────────

export function unknownMarketAlert(market: string): CommandAlert {
  const allMarkets = getAllMarkets();
  return {
    type: 'market',
    message: [
      '',
      alertHeader(`Unknown market: ${market}`),
      '',
      chalk.dim(`  Available markets: ${allMarkets.slice(0, 15).join(', ')}${allMarkets.length > 15 ? '...' : ''}`),
      chalk.dim(`  Run ${chalk.bold('markets')} to see all.`),
      '',
    ].join('\n'),
  };
}

// ─── Unknown Command Alert ──────────────────────────────────────────────────

export function unknownCommandAlert(input: string): CommandAlert {
  return {
    type: 'unknown',
    message: [
      '',
      alertHeader(`Unknown command: ${input}`),
      '',
      chalk.dim(`  Run ${chalk.bold('help')} to view supported commands.`),
      '',
    ].join('\n'),
  };
}

// ─── Command-Aware Validation ────────────────────────────────────────────────

/**
 * Detect if a malformed command looks like it was intended as a specific action.
 * Returns an alert with corrected syntax, or null if no match.
 */
export function detectMalformedCommand(input: string): CommandAlert | null {
  const lower = input.toLowerCase().replace(/\s+/g, ' ').trim();

  // Looks like an open command but malformed
  if (/^(?:open|buy|enter|o)\b/.test(lower) && lower !== 'open' && lower !== 'open interest' && lower !== 'oi') {
    // Has some tokens but regex didn't match — show syntax help
    const tokens = lower.split(' ');
    if (tokens.length >= 2) {
      // Check for missing leverage
      const hasLeverage = tokens.some((t) => /^\d+(?:\.\d+)?x?$/.test(t) && t !== tokens[0]);
      const hasSide = tokens.some((t) => t === 'long' || t === 'short');
      const hasAmount = tokens.some((t) => /^\$?\d+(?:\.\d+)?$/.test(t));

      if (!hasLeverage || !hasSide || !hasAmount) {
        return openSyntaxAlert();
      }
    }
    return openSyntaxAlert();
  }

  // Looks like a close command but malformed
  if (/^(?:close|exit|sell|c)\b/.test(lower) && lower !== 'close' && lower !== 'c') {
    const tokens = lower.split(' ');
    if (tokens.length >= 2) {
      return closeSyntaxAlert();
    }
  }

  // Looks like add collateral but malformed
  if (/^add\b/.test(lower) && lower !== 'add') {
    if (!/\b(long|short)\b/.test(lower) || !/\$?\d/.test(lower)) {
      return addCollateralSyntaxAlert();
    }
  }

  // Looks like remove but malformed (not "remove tp/sl")
  if (/^remove\b/.test(lower) && lower !== 'remove' && !/^remove\s+(tp|sl)\b/.test(lower)) {
    if (!/\b(long|short)\b/.test(lower) || !/\$?\d/.test(lower)) {
      return removeCollateralSyntaxAlert();
    }
  }

  return null;
}
