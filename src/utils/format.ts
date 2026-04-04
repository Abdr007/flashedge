import chalk from 'chalk';
import { TradeSide, Position, MarketData, ToolResult } from '../types/index.js';
import { theme } from '../cli/theme.js';
import { IS_AGENT } from '../no-dna.js';

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return 'N/A';
  // Normalize negative zero
  const v = Math.abs(value) < 0.005 ? 0 : value;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return 'N/A';
  if (value >= 1000) return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (value >= 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return 'N/A';
  // Normalize negative zero
  const v = Math.abs(value) < 0.005 ? 0 : value;
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

export function colorPnl(value: number): string {
  const formatted = formatUsd(value);
  if (value > 0) return theme.positive(formatted);
  if (value < 0) return theme.negative(formatted);
  return theme.dim(formatted);
}

export function colorPercent(value: number): string {
  const formatted = formatPercent(value);
  if (value > 0) return theme.positive(formatted);
  if (value < 0) return theme.negative(formatted);
  return theme.dim(formatted);
}

export function colorSide(side: TradeSide): string {
  return side === TradeSide.Long ? theme.long('LONG') : theme.short('SHORT');
}

export function formatPosition(pos: Position): string {
  const lines = [
    `  ${chalk.bold(pos.market)} ${colorSide(pos.side)} ${theme.dim(`${pos.leverage.toFixed(1)}x`)}`,
    `    Entry: ${formatPrice(pos.entryPrice)}  Mark: ${formatPrice(pos.markPrice)}`,
    `    Size: ${formatUsd(pos.sizeUsd)}  Collateral: ${formatUsd(pos.collateralUsd)}`,
    `    PnL: ${colorPnl(pos.unrealizedPnl)} (${colorPercent(pos.unrealizedPnlPercent)})`,
    pos.totalFees > 0 ? `    Fees: ${formatUsd(pos.totalFees)}` : '',
    `    Liq: ${formatPrice(pos.liquidationPrice)}`,
  ].filter(Boolean);
  return lines.join('\n');
}

export function formatMarketRow(m: MarketData): string {
  return [
    chalk.bold(m.symbol.padEnd(10)),
    formatPrice(m.price).padEnd(14),
    colorPercent(m.priceChange24h).padEnd(12),
    `OI: ${formatUsd(m.openInterestLong + m.openInterestShort)}`.padEnd(18),
    `Max: ${m.maxLeverage}x`,
  ].join('  ');
}

export function formatToolResult(result: ToolResult): string {
  if (!result.success) {
    return theme.negative(`Error: ${result.message}`);
  }
  return result.message;
}

export function formatTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => stripAnsi(r[i] || '').length)));
  const headerLine = headers.map((h, i) => theme.tableHeader(h.padEnd(colWidths[i]))).join('  ');
  const separator = theme.tableSeparator(colWidths.reduce((a, b) => a + b + 2, -2));
  const bodyLines = rows.map((row) =>
    row
      .map((cell, i) => {
        const stripped = stripAnsi(cell);
        const padding = colWidths[i] - stripped.length;
        return cell + ' '.repeat(Math.max(0, padding));
      })
      .join('  '),
  );
  return [headerLine, separator, ...bodyLines].join('\n');
}

/** Strip ANSI escape sequences for accurate width measurement. */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u001b\[[0-9;]*m/g, '');
}

/** Visible length of a string (excluding ANSI escape codes). */
export function visibleLength(str: string): number {
  return stripAnsi(str).length;
}

/** Pad a string to a target visible width, ignoring ANSI codes. */
export function padVisible(str: string, width: number): string {
  const pad = width - visibleLength(str);
  return pad > 0 ? str + ' '.repeat(pad) : str;
}

/** padStart equivalent that accounts for ANSI codes. */
export function padVisibleStart(str: string, width: number): string {
  const pad = width - visibleLength(str);
  return pad > 0 ? ' '.repeat(pad) + str : str;
}

export function banner(): string {
  if (IS_AGENT) return ''; // NO_DNA: no ASCII art / decorations
  return ['', `  ${theme.accentBold('FLASH AI TERMINAL')}`, `  ${theme.separator(32)}`, ''].join('\n');
}

export function shortAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/**
 * Convert raw Flash SDK error messages into human-readable text.
 * The SDK often returns raw native token amounts (e.g. "need more 103334904 tokens"
 * which is 103.33 USDC at 6 decimals). This function detects common patterns and
 * converts them to USD values.
 */
export function humanizeSdkError(msg: string, collateral?: number, leverage?: number): string {
  // Pattern: "Insufficient Funds need more NNNN tokens"
  const insufficientMatch = msg.match(/[Ii]nsufficient\s+[Ff]unds.*?need\s+more\s+(\d+)\s+tokens?/);
  if (insufficientMatch) {
    const rawAmount = parseInt(insufficientMatch[1], 10);
    if (Number.isFinite(rawAmount) && rawAmount > 0) {
      // USDC uses 6 decimals
      const usdAmount = rawAmount / 1_000_000;
      const parts: string[] = [`Insufficient funds — need ${formatUsd(usdAmount)} more USDC`];
      if (collateral && leverage) {
        const totalRequired = collateral + (collateral * leverage * 8) / 10_000;
        parts.push(
          `(${formatUsd(collateral)} collateral + ~${formatUsd(totalRequired - collateral)} fees at ${leverage}x)`,
        );
      }
      return parts.join(' ');
    }
  }

  // Pattern: generic "need more NNNN" without "tokens" suffix
  const needMoreMatch = msg.match(/need\s+more\s+(\d{6,})/);
  if (needMoreMatch) {
    const rawAmount = parseInt(needMoreMatch[1], 10);
    if (Number.isFinite(rawAmount) && rawAmount > 0) {
      const usdAmount = rawAmount / 1_000_000;
      return msg.replace(needMoreMatch[0], `need ${formatUsd(usdAmount)} more`);
    }
  }

  // Pattern: InsufficientFunds / insufficient funds (generic, not caught above)
  if (/InsufficientFunds|insufficient\s+funds/i.test(msg)) {
    return "Insufficient funds. Check your USDC balance with 'wallet tokens'.";
  }

  // Pattern: 0x1 program error or InsufficientBalance — SOL needed for tx fees
  if (/\b0x1\b|InsufficientBalance/i.test(msg)) {
    return 'Insufficient SOL for transaction fees. Top up your wallet.';
  }

  // Pattern: MarketClosed
  if (/MarketClosed/i.test(msg)) {
    return "Market is currently closed. Check market hours with 'markets'.";
  }

  return msg;
}
