/**
 * Intelligent CLI Guidance System
 *
 * Provides context-aware help when users enter unknown, incomplete,
 * or incorrectly parameterized commands. Consolidates fuzzy matching,
 * position-aware suggestions, and parameter validation into one module.
 *
 * Design constraints:
 *   - Display-only — never executes commands or modifies state
 *   - No RPC calls — uses only static data + optional pre-fetched positions
 *   - Deterministic — same input always produces same output
 */

import chalk from 'chalk';
import { theme } from '../cli/theme.js';
import { COMMAND_REGISTRY, type CommandEntry } from '../cli/command-registry.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GuidanceResult {
  /** Header line (e.g. "Unknown command", "Incomplete command") */
  header: string;
  /** Suggested commands with descriptions */
  suggestions: string[];
  /** Optional footer hint */
  footer?: string;
}

// ─── Core API ───────────────────────────────────────────────────────────────

/**
 * Main entry point. Analyzes user input and returns formatted guidance text,
 * or null if no guidance applies (i.e. valid command).
 */
export function getCommandGuidance(input: string, positions?: { market: string; side: string }[]): string | null {
  const lower = input.toLowerCase().trim();
  if (!lower) return null;

  // 1. Incomplete commands — recognized stem but missing parameters
  const incomplete = matchIncompleteCommand(lower, positions);
  if (incomplete) return formatGuidance(incomplete);

  // 2. Invalid parameters — recognized command with bad values
  const paramError = matchInvalidParameters(lower);
  if (paramError) return formatGuidance(paramError);

  // 3. Close without side — special case
  const closeMissingSide = matchCloseMissingSide(lower, positions);
  if (closeMissingSide) return formatGuidance(closeMissingSide);

  // 4. Unknown command — fuzzy match against known commands
  const fuzzy = matchFuzzyCommand(lower);
  if (fuzzy) return formatGuidance(fuzzy);

  return null;
}

// ─── Incomplete Command Matchers ────────────────────────────────────────────

function matchIncompleteCommand(lower: string, positions?: { market: string; side: string }[]): GuidanceResult | null {
  // "earn add" without amount
  if (/^earn\s+add(?:[- ]?liquidity)?$/.test(lower)) {
    return {
      header: 'Incomplete command',
      suggestions: ['earn add $100 crypto', 'earn add $50 governance', 'earn add $200 virtual'],
    };
  }

  // "earn remove" without percent
  if (/^earn\s+remove(?:[- ]?liquidity)?$/.test(lower)) {
    return {
      header: 'Incomplete command',
      suggestions: ['earn remove 50% crypto', 'earn remove 25% governance', 'earn remove 100% virtual'],
    };
  }

  // "earn stake" without amount
  if (/^earn\s+stake(?:[- ]?flp)?$/.test(lower)) {
    return {
      header: 'Incomplete command',
      suggestions: ['earn stake $200 governance', 'earn stake $100 crypto', 'earn stake $500 virtual'],
    };
  }

  // "earn unstake" without percent
  if (/^earn\s+unstake(?:[- ]?flp)?$/.test(lower)) {
    return {
      header: 'Incomplete command',
      suggestions: ['earn unstake 50% governance', 'earn unstake 25% crypto', 'earn unstake 100% virtual'],
    };
  }

  // "swap" without tokens
  if (lower === 'swap') {
    return {
      header: 'Incomplete command',
      suggestions: ['swap 10 SOL to USDC', 'swap $50 USDC to SOL', 'swap SOL USDC $10'],
    };
  }

  // "set tp" or "set sl" without params
  if (/^set\s+(tp|sl)$/.test(lower)) {
    const type = lower.includes('tp') ? 'tp' : 'sl';
    const label = type === 'tp' ? 'take-profit' : 'stop-loss';
    if (positions && positions.length > 0) {
      const p = positions[0];
      return {
        header: `Incomplete ${label} command`,
        suggestions: [`set ${type} ${p.market} ${p.side.toLowerCase()} $${type === 'tp' ? '100' : '80'}`],
      };
    }
    return {
      header: `Incomplete ${label} command`,
      suggestions: [
        `set ${type} SOL long $${type === 'tp' ? '100' : '80'}`,
        `set ${type} BTC short $${type === 'tp' ? '75000' : '60000'}`,
      ],
    };
  }

  // "close" without market/side
  if (lower === 'close' || lower === 'c') {
    if (positions && positions.length > 0) {
      const suggestions = positions.slice(0, 4).map((p) => `close ${p.market} ${p.side.toLowerCase()}`);
      if (positions.length > 1) suggestions.push('close-all');
      return { header: 'Which position?', suggestions };
    }
    return {
      header: 'Incomplete command',
      suggestions: ['close SOL long', 'close BTC short', 'close SOL long 50%', 'close-all'],
    };
  }

  // "open" without params
  if (lower === 'open' || lower === 'o') {
    return {
      header: 'Incomplete command',
      suggestions: ['open 5x long SOL $500', 'open 3x short BTC $200', 'open 10x long ETH $1000'],
    };
  }

  // "add" without params
  if (lower === 'add') {
    if (positions && positions.length > 0) {
      return {
        header: 'Incomplete command',
        suggestions: positions.slice(0, 3).map((p) => `add $100 to ${p.market} ${p.side.toLowerCase()}`),
      };
    }
    return {
      header: 'Incomplete command',
      suggestions: ['add $100 to SOL long', 'add $50 to BTC short'],
    };
  }

  // "remove" without params
  if (lower === 'remove') {
    if (positions && positions.length > 0) {
      return {
        header: 'Incomplete command',
        suggestions: positions.slice(0, 3).map((p) => `remove $50 from ${p.market} ${p.side.toLowerCase()}`),
      };
    }
    return {
      header: 'Incomplete command',
      suggestions: ['remove $100 from SOL long', 'remove $50 from BTC short'],
    };
  }

  // "limit" without params
  if (lower === 'limit') {
    return {
      header: 'Incomplete command',
      suggestions: ['limit long SOL 2x $100 @ $82', 'limit short BTC 3x $200 at $72000'],
    };
  }

  // "analyze" without market
  if (lower === 'analyze') {
    return {
      header: 'Incomplete command',
      suggestions: ['analyze SOL', 'analyze BTC', 'analyze ETH'],
    };
  }

  // "dryrun" or "dry-run" without command
  if (lower === 'dryrun' || lower === 'dry-run') {
    return {
      header: 'Incomplete command',
      suggestions: ['dryrun open 5x long SOL $500', 'dryrun close SOL long'],
    };
  }

  return null;
}

// ─── Invalid Parameter Matchers ─────────────────────────────────────────────

function matchInvalidParameters(lower: string): GuidanceResult | null {
  // "earn remove 200%" — percentage out of range
  const earnPercentMatch = lower.match(/^earn\s+(?:remove|unstake)(?:[- ]?(?:liquidity|flp))?\s+(\d+)\s*%/);
  if (earnPercentMatch) {
    const pct = parseInt(earnPercentMatch[1], 10);
    if (pct < 1 || pct > 100) {
      return {
        header: 'Invalid percentage',
        suggestions: [],
        footer: 'Value must be between 1% and 100%.',
      };
    }
  }

  // "close SOL long 150%" — close percentage out of range
  const closePercentMatch = lower.match(/^close\s+\S+\s+(?:long|short)\s+(\d+)\s*%/);
  if (closePercentMatch) {
    const pct = parseInt(closePercentMatch[1], 10);
    if (pct < 1 || pct > 100) {
      return {
        header: 'Invalid percentage',
        suggestions: [],
        footer: 'Close percentage must be between 1% and 100%.',
      };
    }
  }

  // "open 0x long SOL $100" or "open 200x long SOL $100"
  const openLevMatch = lower.match(/^open\s+(\d+(?:\.\d+)?)x?\s/);
  if (openLevMatch) {
    const lev = parseFloat(openLevMatch[1]);
    if (lev < 1.1 || lev > 100) {
      return {
        header: `Invalid leverage: ${lev}x`,
        suggestions: ['open 2x long SOL $100', 'open 5x short BTC $500'],
        footer: 'Leverage must be between 1.1x and 100x.',
      };
    }
  }

  // "open 5x long SOL $0"
  const openAmtMatch = lower.match(/^open\s+\d+(?:\.\d+)?x?\s+(?:long|short)\s+\S+\s+\$(\d+(?:\.\d+)?)/);
  if (openAmtMatch) {
    const amt = parseFloat(openAmtMatch[1]);
    if (amt <= 0) {
      return {
        header: 'Invalid collateral',
        suggestions: [],
        footer: 'Collateral must be a positive number.',
      };
    }
  }

  return null;
}

// ─── Close Without Side ─────────────────────────────────────────────────────

function matchCloseMissingSide(lower: string, positions?: { market: string; side: string }[]): GuidanceResult | null {
  // "close SOL" — market without side
  const closeMarketOnly = lower.match(/^close\s+([a-z]+)$/i);
  if (closeMarketOnly) {
    const market = closeMarketOnly[1].toUpperCase();
    // Don't match "close all" or "close-all"
    if (market === 'ALL') return null;

    // Check if user has positions in this market
    if (positions && positions.length > 0) {
      const marketPositions = positions.filter((p) => p.market.toUpperCase() === market);
      if (marketPositions.length > 0) {
        return {
          header: 'Missing position side',
          suggestions: marketPositions.map((p) => `close ${p.market} ${p.side.toLowerCase()}`),
        };
      }
    }

    return {
      header: 'Missing position side',
      suggestions: [`close ${market} long`, `close ${market} short`],
    };
  }

  return null;
}

// ─── Fuzzy Command Matching ─────────────────────────────────────────────────

function matchFuzzyCommand(lower: string): GuidanceResult | null {
  // Extract the first word as the command stem
  const stem = lower.split(/\s+/)[0];

  // Exact prefix matches in registry
  const prefixMatches = findPrefixMatches(lower);
  if (prefixMatches.length > 0 && prefixMatches.length <= 5) {
    return {
      header: 'Unknown command',
      suggestions: prefixMatches.map((e) => e.helpFormat || e.name),
      footer: "Run 'help' to see all commands.",
    };
  }

  // Edit distance matches
  const closeMatches = findEditDistanceMatches(stem);
  if (closeMatches.length > 0 && closeMatches.length <= 5) {
    return {
      header: 'Unknown command',
      suggestions: closeMatches.map((e) => e.helpFormat || e.name),
      footer: "Run 'help' to see all commands.",
    };
  }

  // Earn-specific typo matching
  if (stem === 'earn') {
    return matchEarnFuzzy(lower);
  }

  return null;
}

/** Find registry entries whose name starts with the input */
function findPrefixMatches(lower: string): CommandEntry[] {
  return COMMAND_REGISTRY.filter((e) => {
    if (e.hidden) return false;
    if (e.name.startsWith(lower)) return true;
    if (e.aliases?.some((a) => a.startsWith(lower))) return true;
    return false;
  });
}

/** Find registry entries within edit distance 2 of the input stem */
function findEditDistanceMatches(stem: string): CommandEntry[] {
  return COMMAND_REGISTRY.filter((e) => {
    if (e.hidden) return false;
    const names = [e.name, ...(e.aliases || [])];
    return names.some((n) => {
      const first = n.split(/\s+/)[0];
      return editDistance(stem, first) <= 2 && editDistance(stem, first) > 0;
    });
  });
}

/** Match earn sub-commands that don't resolve */
function matchEarnFuzzy(lower: string): GuidanceResult {
  const tokens = lower.split(/\s+/);
  const sub = tokens[1] || '';

  // Known earn subcommands
  const knownSubs = ['add', 'remove', 'stake', 'unstake', 'claim', 'status'];
  const close = knownSubs.filter((s) => editDistance(sub, s) <= 2);

  if (close.length > 0) {
    const suggestions = close.map((s) => {
      switch (s) {
        case 'add':
          return 'earn add $100 crypto';
        case 'remove':
          return 'earn remove 50% crypto';
        case 'stake':
          return 'earn stake $200 governance';
        case 'unstake':
          return 'earn unstake 25% governance';
        case 'claim':
          return 'earn claim';
        case 'status':
          return 'earn';
        default:
          return `earn ${s}`;
      }
    });
    return { header: 'Unknown command', suggestions, footer: "Run 'help' to see all commands." };
  }

  return {
    header: 'Unknown command',
    suggestions: ['earn add $100 crypto', 'earn remove 50% crypto', 'earn stake $200 governance', 'earn claim'],
    footer: "Run 'earn' to see all pools and commands.",
  };
}

// ─── Categorized Help ───────────────────────────────────────────────────────

/**
 * Returns the full categorized help output.
 * Used by the `help` command for a professional reference display.
 */
export function getCategorizedHelp(): string {
  const lines: string[] = [
    '',
    `  ${theme.accentBold('FLASH TERMINAL')}  ${theme.dim('— Command Reference')}`,
    `  ${theme.separator(52)}`,
    '',
  ];

  const COL = 36;

  // ── Trading ─────────────────────────────
  lines.push(`  ${theme.section('Trading')}`);
  lines.push(`    ${theme.command('open 5x long SOL $500'.padEnd(COL))}Open a leveraged position`);
  lines.push(`    ${theme.command('close SOL long'.padEnd(COL))}Close a position`);
  lines.push(`    ${theme.command('close SOL long 50%'.padEnd(COL))}Partial close`);
  lines.push(`    ${theme.command('close-all'.padEnd(COL))}Close all positions`);
  lines.push(`    ${theme.command('add $200 to SOL long'.padEnd(COL))}Add collateral`);
  lines.push(`    ${theme.command('remove $100 from ETH long'.padEnd(COL))}Remove collateral`);
  lines.push('');

  // ── Risk ────────────────────────────────
  lines.push(`  ${theme.section('Risk')}`);
  lines.push(`    ${theme.command('set tp SOL long $100'.padEnd(COL))}Set take-profit`);
  lines.push(`    ${theme.command('set sl SOL long $80'.padEnd(COL))}Set stop-loss`);
  lines.push(`    ${theme.command('limit long SOL 2x $100 @ $82'.padEnd(COL))}Limit order`);
  lines.push('');

  // ── Earn ────────────────────────────────
  lines.push(`  ${theme.section('Earn')}`);
  lines.push(`    ${theme.command('earn add $100 crypto'.padEnd(COL))}Add liquidity`);
  lines.push(`    ${theme.command('earn remove 50% crypto'.padEnd(COL))}Remove liquidity`);
  lines.push(`    ${theme.command('earn stake $200 governance'.padEnd(COL))}Stake FLP`);
  lines.push(`    ${theme.command('earn unstake 25% governance'.padEnd(COL))}Unstake FLP`);
  lines.push(`    ${theme.command('earn claim'.padEnd(COL))}Claim rewards`);
  lines.push(`    ${theme.command('earn'.padEnd(COL))}View pools & commands`);
  lines.push('');

  // ── Utilities ───────────────────────────
  lines.push(`  ${theme.section('Utilities')}`);
  lines.push(`    ${theme.command('swap SOL USDC $10'.padEnd(COL))}Swap tokens`);
  lines.push(`    ${theme.command('wallet balance'.padEnd(COL))}Wallet balance`);
  lines.push(`    ${theme.command('positions'.padEnd(COL))}View positions`);
  lines.push(`    ${theme.command('portfolio'.padEnd(COL))}Portfolio overview`);
  lines.push(`    ${theme.command('markets'.padEnd(COL))}Available markets`);
  lines.push(`    ${theme.command('monitor'.padEnd(COL))}Live market monitor`);
  lines.push(`    ${theme.command('dashboard'.padEnd(COL))}Full dashboard`);
  lines.push(`    ${theme.command('analyze SOL'.padEnd(COL))}Deep market analysis`);
  lines.push('');

  lines.push(`  ${theme.separator(52)}`);
  lines.push(`  ${theme.command('help'.padEnd(COL))}Show this reference`);
  lines.push(`  ${theme.command('exit'.padEnd(COL))}Close the terminal`);
  lines.push('');

  return lines.join('\n');
}

// ─── Formatting ─────────────────────────────────────────────────────────────

function formatGuidance(result: GuidanceResult): string {
  const lines = ['', chalk.yellow(`  \u26A0 ${result.header}`), ''];

  if (result.suggestions.length > 0) {
    lines.push(`  ${theme.section('Try')}`);
    for (const s of result.suggestions) {
      lines.push(`    ${theme.command(s)}`);
    }
    lines.push('');
  }

  if (result.footer) {
    lines.push(`  ${theme.dim(result.footer)}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Edit Distance ──────────────────────────────────────────────────────────

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const maxDist = 3;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }

  return prev[b.length];
}
