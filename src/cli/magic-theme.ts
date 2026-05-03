/**
 * Magic-mode visual theme — gradient text, double-bordered cards,
 * sparkle accents. Used by the trade-card renderers and welcome banner.
 *
 * Self-contained: no external deps beyond chalk so it works in any TTY
 * that supports basic ANSI colors. Falls back gracefully on dumb terminals.
 */

import chalk from 'chalk';

/** Gradient stops cycling through cyan → magenta → blue → cyan. */
const GRADIENT = [
  chalk.cyan,
  chalk.cyanBright,
  chalk.magentaBright,
  chalk.magenta,
  chalk.blueBright,
  chalk.blue,
];

/** Apply a gradient across a string by character. */
export function gradient(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const color = GRADIENT[i % GRADIENT.length];
    out += ch === ' ' ? ch : color(ch);
  }
  return out;
}

/** Sparkles + lightning motifs — fixed-width so layout stays stable. */
export const SPARK = chalk.cyanBright('✦');
export const BOLT = chalk.yellowBright('⚡');
export const DIAMOND = chalk.magentaBright('◆');
export const ARROW = chalk.dim('→');
export const DOT = chalk.dim('·');

/** Box-drawing characters for the magic card style. */
const BOX = {
  tl: '╭',
  tr: '╮',
  bl: '╰',
  br: '╯',
  h: '─',
  v: '│',
  ml: '├',
  mr: '┤',
} as const;

/** Visible-character length (strips ANSI escapes for width math). */
function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Pad to exact visible width (handling ANSI). */
function padVisible(s: string, target: number): string {
  const need = target - visibleLen(s);
  return need > 0 ? s + ' '.repeat(need) : s;
}

export interface CardLine {
  /** Row label (left column). */
  label: string;
  /** Row value (right column). Pre-colored. */
  value: string;
}

export interface CardOpts {
  /** Header text — pre-styled (caller picks color). */
  title: string;
  /** Optional sub-line under the title (e.g. tx sig). */
  subtitle?: string;
  /** Body rows. */
  rows: CardLine[];
  /** Inner content width. Default 40. */
  width?: number;
  /** Border color. Default chalk.cyanBright. */
  border?: (s: string) => string;
}

/**
 * Render a trade-card-style box.
 *
 * ╭─ ✦ Position Opened ─────────────────╮
 * │  Market           SOL long 2x       │
 * │  Entry            $84.20            │
 * │  Size             $20.00            │
 * ╰──────────────────────────────────────╯
 */
export function renderCard(opts: CardOpts): string {
  const width = opts.width ?? 42;
  const border = opts.border ?? chalk.cyanBright;
  const lines: string[] = [];

  // Top border with title inline
  const titlePad = ` ${opts.title} `;
  const titleVisible = visibleLen(titlePad);
  const remaining = width - titleVisible - 2;
  const leftDashes = 2;
  const rightDashes = Math.max(remaining - leftDashes, 1);
  lines.push(
    border(BOX.tl + BOX.h.repeat(leftDashes)) +
      titlePad +
      border(BOX.h.repeat(rightDashes) + BOX.tr),
  );

  if (opts.subtitle) {
    const sub = `  ${opts.subtitle}`;
    lines.push(border(BOX.v) + padVisible(sub, width) + border(BOX.v));
  }

  // Body rows: "  label    value" with label left-padded to 14 cols
  for (const row of opts.rows) {
    const label = chalk.dim(row.label.padEnd(14));
    const content = `  ${label}${row.value}`;
    lines.push(border(BOX.v) + padVisible(content, width) + border(BOX.v));
  }

  // Bottom border
  lines.push(border(BOX.bl + BOX.h.repeat(width) + BOX.br));
  return lines.join('\n');
}

/**
 * Color-bar utilization renderer. Shows a horizontal bar with `value/max` filled.
 * Used for vault locked-vs-deposit and liq-distance indicators.
 *
 * Returns: [▰▰▰▰▱▱▱▱▱▱] 40%
 */
export function bar(value: number, max: number, width = 12): string {
  const ratio = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  const filled = Math.round(ratio * width);
  const bars = '▰'.repeat(filled) + '▱'.repeat(width - filled);
  let color = chalk.green;
  if (ratio > 0.85) color = chalk.red;
  else if (ratio > 0.6) color = chalk.yellow;
  const pct = (ratio * 100).toFixed(0).padStart(3) + '%';
  return color(bars) + ' ' + chalk.dim(pct);
}

/** Centered welcome banner — gradient MAGIC TRADING wordmark + tagline. */
export function magicBanner(): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${SPARK}  ${gradient('M A G I C   T R A D I N G')}  ${SPARK}`);
  lines.push(`     ${chalk.dim('Flash Magic Trade · MagicBlock ER · sub-second confirms')}`);
  lines.push('');
  return lines.join('\n');
}

/** Latency pill — colored ⚡ + time formatted with subtle border. */
export function latencyPill(ms: number): string {
  const seconds = ms / 1000;
  const text = seconds < 1 ? `${seconds.toFixed(2)}s` : `${seconds.toFixed(1)}s`;
  if (ms < 500) return `${chalk.green('⚡')} ${chalk.green(text)}`;
  if (ms < 2000) return `${chalk.yellow('⚡')} ${chalk.yellow(text)}`;
  return `${chalk.red('⚡')} ${chalk.red(text)}`;
}
