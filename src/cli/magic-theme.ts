/**
 * Magic-mode visual theme — premium minimalism.
 *
 * Visual language:
 *   - Vertical accent bar (▌) on the LEFT of every card, color-coded:
 *       green   = open position / positive PnL / safe
 *       red     = close / negative PnL / critical risk
 *       cyan    = neutral info / status
 *       yellow  = warning / pending
 *   - Status header in bold caps, right-aligned subtitle (market, side, lev).
 *   - Body rendered as a two-column grid where space allows.
 *   - Footer: sig + URL + latency, separated by sigils.
 *   - Single accent color (cyan), no rainbow gradients.
 */

import chalk from 'chalk';

/** Sigils — used sparingly. */
export const SPARK = chalk.cyan('✦');
export const BOLT = chalk.cyan('⚡');
export const DIAMOND = chalk.cyan('◆');
export const ARROW = chalk.dim('→');
export const DOT = chalk.dim('·');

/** Visible-character length (strips ANSI escapes for width math). */
export function vlen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Pad to exact visible width (handling ANSI). */
function pad(s: string, target: number): string {
  const need = target - vlen(s);
  return need > 0 ? s + ' '.repeat(need) : s;
}

/** Truncate string with ellipsis to fit visible width. */
export function truncate(s: string, max: number): string {
  return vlen(s) <= max ? s : s.slice(0, Math.max(1, max - 1)) + '…';
}

/**
 * Format a tx URL for the footer — truncate the middle so the host + tail
 * are still visible. `https://explorer.solana.com/tx/abc…xyz?cluster=…`
 */
export function compactUrl(url: string, max = 60): string {
  if (url.length <= max) return url;
  // Keep host + path prefix, …, tail
  const head = url.slice(0, Math.floor(max * 0.55));
  const tail = url.slice(-Math.floor(max * 0.35));
  return `${head}…${tail}`;
}

/** Direction label: green LONG / red SHORT, bold. */
export function sideLabel(side: string): string {
  return side === 'short' ? chalk.red.bold('SHORT') : chalk.green.bold('LONG');
}

/** Compact market header: "SOL · LONG · 2x" with bold + colors. */
export function marketHeader(symbol: string, side: string, leverage?: number): string {
  const parts = [chalk.white.bold(symbol.toUpperCase()), sideLabel(side)];
  if (leverage) parts.push(chalk.dim(`${leverage}x`));
  return parts.join(' ' + DOT + ' ');
}

/** Latency pill — green/yellow/red ⚡ + time. */
export function latencyPill(ms: number): string {
  const seconds = ms / 1000;
  const text = seconds < 1 ? `${seconds.toFixed(2)}s` : `${seconds.toFixed(1)}s`;
  if (ms < 500) return `${chalk.green('⚡')} ${chalk.green(text)}`;
  if (ms < 2000) return `${chalk.yellow('⚡')} ${chalk.yellow(text)}`;
  return `${chalk.red('⚡')} ${chalk.red(text)}`;
}

/** Horizontal utilization bar — █ filled, · empty, color-graded by ratio. */
export function bar(value: number, max: number, width = 18): string {
  const ratio = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  const filled = Math.round(ratio * width);
  let color = chalk.green;
  if (ratio > 0.85) color = chalk.red;
  else if (ratio > 0.6) color = chalk.yellow;
  return color('█'.repeat(filled)) + chalk.dim('·'.repeat(width - filled));
}

export type Tone = 'open' | 'close' | 'info' | 'warn' | 'error';
const TONE_COLOR = {
  open: chalk.green,
  close: chalk.cyan,
  info: chalk.cyan,
  warn: chalk.yellow,
  error: chalk.red,
} as const;

export interface KV { label: string; value: string }

export interface CardOpts {
  /** Action verb shown bold in the header — e.g. "POSITION OPENED". */
  status: string;
  /** Right-aligned subtitle (typically marketHeader output). */
  subtitle?: string;
  /** Body rows — rendered in 2 columns when count ≥ 4. */
  rows: KV[];
  /** Optional short-form tx signature. */
  sig?: string;
  /** Optional tx URL — auto-truncated to fit. */
  url?: string;
  /** Latency in ms — renders as a pill in the footer. */
  latencyMs?: number;
  /** Color tone — drives the left accent bar + header color. Default 'info'. */
  tone?: Tone;
}

/** Inner card width (visible). Exterior = inner + 4 (left bar + spaces). */
const INNER = 70;
/** Width of the label column in body rows. */
const LABEL_W = 14;
/** Spacing between left + right columns when rendering in 2-column mode. */
const COL_GAP = 4;

/**
 * Premium card with vertical accent bar, status header, 2-column body,
 * and a sig/url/latency footer.
 *
 *   ▌  POSITION OPENED                              SOL · LONG · 2x
 *   ▌
 *   ▌  Entry           $84.31     Liquidation        $42.23
 *   ▌  Size            $9.99      Distance to liq    50.0%
 *   ▌  Collateral      $5.00      Fee                $0.04
 *   ▌
 *   ▌  ◆  4bMwpk…JmfV   ⚡ 0.34s
 *   ▌     https://explorer.solana.com/tx/abc…xyz
 *
 */
export function renderCard(opts: CardOpts): string {
  const tone = opts.tone ?? 'info';
  const tc = TONE_COLOR[tone];
  const bar = tc('▌');
  const lines: string[] = [];

  const headerLeft = tc.bold(opts.status.toUpperCase());
  const headerRight = opts.subtitle ?? '';
  const headerPad = INNER - vlen(headerLeft) - vlen(headerRight);
  lines.push('');
  lines.push(`  ${bar}  ${headerLeft}${' '.repeat(Math.max(headerPad, 2))}${headerRight}`);
  lines.push(`  ${bar}`);

  // Body — 2 columns when ≥ 4 rows, else single column.
  // Tighter layout: pad LEFT half to a fixed column then concat the right half
  // without trailing whitespace so the row ends at the actual content.
  if (opts.rows.length >= 4) {
    const halfWidth = Math.floor((INNER - COL_GAP) / 2);
    const renderCell = (r: KV | undefined): string => {
      if (!r) return '';
      return chalk.dim(r.label.padEnd(LABEL_W)) + r.value;
    };
    for (let i = 0; i < opts.rows.length; i += 2) {
      const left = renderCell(opts.rows[i]);
      const right = renderCell(opts.rows[i + 1]);
      const leftPadded = pad(left, halfWidth + COL_GAP);
      lines.push(`  ${bar}  ${leftPadded}${right}`);
    }
  } else {
    for (const r of opts.rows) {
      const labelStr = chalk.dim(r.label.padEnd(LABEL_W));
      lines.push(`  ${bar}  ${labelStr}${r.value}`);
    }
  }

  // Footer — sig + latency on one line; URL on its own line below the card
  // (a copy/paste-safe clickable link, never truncated mid-param).
  if (opts.sig || opts.latencyMs !== undefined) {
    lines.push(`  ${bar}`);
    const footerParts: string[] = [];
    if (opts.sig) footerParts.push(`${DIAMOND}  ${chalk.dim(opts.sig)}`);
    if (opts.latencyMs !== undefined) footerParts.push(latencyPill(opts.latencyMs));
    lines.push(`  ${bar}  ${footerParts.join('   ')}`);
  }

  lines.push('');
  if (opts.url) {
    // Print the full URL on its own line outside the card frame so terminal
    // hyperlink parsers (iTerm, Kitty, modern Terminal.app) make it clickable.
    lines.push(`     ${chalk.cyan('→')} ${chalk.dim(opts.url)}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Welcome banner — tight, branded, two lines.
 *
 *   ◆  MAGIC TRADING  v2                  Flash · MagicBlock ER · sub-second
 *   ────────────────────────────────────────────────────────────────────────
 */
export function magicBanner(): string {
  const left = `${DIAMOND}  ${chalk.cyan.bold('MAGIC TRADING')}  ${chalk.dim('v2')}`;
  const right = chalk.dim('Flash · MagicBlock ER · sub-second confirms');
  const padBetween = INNER - vlen(left) - vlen(right);
  return [
    '',
    `  ${left}${' '.repeat(Math.max(padBetween, 4))}${right}`,
    `  ${chalk.dim('━'.repeat(INNER + 4))}`,
    '',
  ].join('\n');
}

/** A clean two-column key/value block (no card frame). For status screens. */
export function kvBlock(rows: KV[]): string {
  const labelW = 16;
  return rows.map((r) => `  ${chalk.dim(r.label.padEnd(labelW))}${r.value}`).join('\n');
}

/** Section divider with optional title — used between groups in dashboard. */
export function divider(title?: string): string {
  if (!title) return chalk.dim('  ' + '─'.repeat(INNER));
  const padded = ` ${title.toUpperCase()} `;
  const remaining = INNER - vlen(padded);
  return `  ${chalk.dim('─'.repeat(2))}${chalk.cyan.bold(padded)}${chalk.dim('─'.repeat(Math.max(remaining - 2, 1)))}`;
}

/** Map a 0–1 distance-to-liq into a colored progress segment. Used in watch. */
export function liqDistanceBar(distance: number, width = 12): string {
  // Higher distance = safer = greener bar fully filled green.
  // Lower distance = more red.
  const ratio = Math.max(0, Math.min(1, distance));
  const filled = Math.round(ratio * width);
  let color = chalk.green;
  if (ratio < 0.15) color = chalk.red;
  else if (ratio < 0.30) color = chalk.yellow;
  return color('█'.repeat(filled)) + chalk.dim('·'.repeat(width - filled));
}

/** @deprecated kept for back-compat only. */
export function gradient(text: string): string {
  return chalk.cyan.bold(text);
}
