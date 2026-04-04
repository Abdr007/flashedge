import { POOL_MARKETS } from '../config/index.js';
import { theme } from './theme.js';
import { getAutocompleteCommands } from './command-registry.js';

import { loadAliases } from './learned-aliases.js';
import { getPredictions } from './trade-predictor.js';
import { loadTemplates } from './trade-templates.js';

// ─── CLI Autocomplete & Suggestion Engine ────────────────────────────────────
//
// Deterministic command completion for the Flash Terminal.
//
// Design constraints:
//   • No RPC calls — uses only static command list + cached data
//   • Never executes commands — only completes/suggests text
//   • Lightweight — runs synchronously in the readline completer callback
//   • Safe — does not interfere with status bar, watch, or monitor modes

// ─── Command List (derived from registry) ────────────────────────────────────

const COMMANDS: string[] = getAutocompleteCommands();

/** All market symbols from POOL_MARKETS (uppercase) */
const ALL_MARKETS: string[] = [
  ...new Set(
    Object.values(POOL_MARKETS)
      .flat()
      .map((s) => s.toUpperCase()),
  ),
];

/** Pool names for 'inspect pool' completion */
const POOL_NAMES: string[] = Object.keys(POOL_MARKETS);

// ─── Usage Examples ──────────────────────────────────────────────────────────

const USAGE_EXAMPLES: Record<string, string[]> = {
  open: ['open 5x long SOL $500', 'open 3x short ETH $200', 'open 10x long BTC $1000'],
  close: ['close SOL long', 'close ETH short'],
  add: ['add $100 to SOL long', 'add $50 to BTC short'],
  remove: ['remove $100 from SOL long', 'remove $50 from BTC short'],
  analyze: ['analyze SOL', 'analyze BTC', 'analyze ETH'],
  dryrun: ['dryrun open 5x long SOL $500', 'dryrun close ETH short'],
  monitor: [],
  'inspect pool': [...POOL_NAMES.map((p) => `inspect pool ${p}`)],
  'inspect market': ['inspect market SOL', 'inspect market BTC', 'inspect market ETH'],
};

// ─── Completer Function ──────────────────────────────────────────────────────

/**
 * readline-compatible completer.
 * Returns [completions, line] for TAB completion.
 */
export function completer(line: string): [string[], string] {
  const trimmed = line.trimStart();
  const lower = trimmed.toLowerCase();

  // 1. Market name completion within trade commands
  const marketMatch = matchMarketContext(lower, trimmed);
  if (marketMatch) return marketMatch;

  // 2. Pool name completion for 'inspect pool'
  if (lower.startsWith('inspect pool ')) {
    const partial = trimmed.slice('inspect pool '.length).trim();
    const matches = POOL_NAMES.filter((p) => p.toLowerCase().startsWith(partial.toLowerCase()));
    if (matches.length > 0) {
      return [matches.map((m) => `inspect pool ${m}`), trimmed];
    }
    return [[], trimmed];
  }

  // 3. Market completion for 'inspect market'
  if (lower.startsWith('inspect market ')) {
    const partial = trimmed.slice('inspect market '.length).trim().toUpperCase();
    const matches = ALL_MARKETS.filter((m) => m.startsWith(partial));
    if (matches.length > 0) {
      return [matches.map((m) => `inspect market ${m}`), trimmed];
    }
    return [[], trimmed];
  }

  // 4. Trade history predictions (for partial trade commands)
  if (/\b(long|short)\b/.test(lower) || /^[ls]\s/.test(lower)) {
    try {
      const predictions = getPredictions(lower);
      if (predictions.length > 0) {
        return [predictions, trimmed];
      }
    } catch {
      /* non-critical */
    }
  }

  // 5. Template + learned alias prefix matching
  try {
    const aliases = loadAliases();
    const templates = loadTemplates();
    const allShortcuts = { ...aliases, ...templates };
    const shortcutMatches = Object.keys(allShortcuts).filter((a) => a.startsWith(lower));
    if (shortcutMatches.length > 0) {
      return [shortcutMatches, trimmed];
    }
  } catch {
    /* non-critical */
  }

  // 6. Command prefix matching
  const matches = COMMANDS.filter((cmd) => cmd.startsWith(lower));

  if (matches.length > 0) {
    return [matches, trimmed];
  }

  // 7. Fuzzy fallback — find commands containing the typed text
  const fuzzy = COMMANDS.filter((cmd) => cmd.includes(lower));
  return [fuzzy, trimmed];
}

// ─── Market Context Matching ─────────────────────────────────────────────────

/**
 * Detect when the user is in a trade command and typing a market name.
 * Patterns: open Nx long/short <MARKET>, close <MARKET>, analyze <MARKET>
 */
function matchMarketContext(lower: string, original: string): [string[], string] | null {
  // "open 5x long s" → suggest SOL
  const openMatch = lower.match(/^open\s+\d+x\s+(long|short)\s+(\S*)$/);
  if (openMatch) {
    const partial = openMatch[2].toUpperCase();
    const prefix = original.slice(0, original.length - openMatch[2].length);
    const matches = ALL_MARKETS.filter((m) => m.startsWith(partial));
    return [matches.map((m) => prefix + m), original];
  }

  // "close s" → suggest SOL
  const closeMatch = lower.match(/^close\s+(\S*)$/);
  if (closeMatch) {
    const partial = closeMatch[1].toUpperCase();
    const prefix = original.slice(0, original.length - closeMatch[1].length);
    const matches = ALL_MARKETS.filter((m) => m.startsWith(partial));
    if (matches.length > 0) {
      return [matches.map((m) => prefix + m), original];
    }
  }

  // "analyze s" → suggest SOL
  const analyzeMatch = lower.match(/^analyze\s+(\S*)$/);
  if (analyzeMatch) {
    const partial = analyzeMatch[1].toUpperCase();
    const prefix = original.slice(0, original.length - analyzeMatch[1].length);
    const matches = ALL_MARKETS.filter((m) => m.startsWith(partial));
    if (matches.length > 0) {
      return [matches.map((m) => prefix + m), original];
    }
  }

  // "add $100 to s" → suggest SOL
  const addMatch = lower.match(/^add\s+\$\d+\s+to\s+(\S*)$/);
  if (addMatch) {
    const partial = addMatch[1].toUpperCase();
    const prefix = original.slice(0, original.length - addMatch[1].length);
    const matches = ALL_MARKETS.filter((m) => m.startsWith(partial));
    if (matches.length > 0) {
      return [matches.map((m) => prefix + m), original];
    }
  }

  // "remove $100 from s" → suggest SOL
  const removeMatch = lower.match(/^remove\s+\$\d+\s+from\s+(\S*)$/);
  if (removeMatch) {
    const partial = removeMatch[1].toUpperCase();
    const prefix = original.slice(0, original.length - removeMatch[1].length);
    const matches = ALL_MARKETS.filter((m) => m.startsWith(partial));
    if (matches.length > 0) {
      return [matches.map((m) => prefix + m), original];
    }
  }

  // "position debug s" → suggest market
  const posDebugMatch = lower.match(/^pos(?:ition)?\s+debug\s+(\S*)$/);
  if (posDebugMatch) {
    const partial = posDebugMatch[1].toUpperCase();
    const prefix = original.slice(0, original.length - posDebugMatch[1].length);
    const matches = ALL_MARKETS.filter((m) => m.startsWith(partial));
    if (matches.length > 0) {
      return [matches.map((m) => prefix + m), original];
    }
  }

  // "liquidations s", "funding s", "depth s" → suggest market
  const observabilityMatch = lower.match(/^(liquidations?|funding|depth)\s+(\S*)$/);
  if (observabilityMatch) {
    const partial = observabilityMatch[2].toUpperCase();
    const prefix = original.slice(0, original.length - observabilityMatch[2].length);
    const matches = ALL_MARKETS.filter((m) => m.startsWith(partial));
    if (matches.length > 0) {
      return [matches.map((m) => prefix + m), original];
    }
  }

  // "inspect s" (bare inspect + partial market) → suggest market
  const inspectMatch = lower.match(/^inspect\s+(\S+)$/);
  if (inspectMatch && !['protocol', 'pool', 'market'].includes(inspectMatch[1])) {
    const partial = inspectMatch[1].toUpperCase();
    const prefix = original.slice(0, original.length - inspectMatch[1].length);
    const matches = ALL_MARKETS.filter((m) => m.startsWith(partial));
    if (matches.length > 0) {
      return [matches.map((m) => prefix + m), original];
    }
  }

  return null;
}

// ─── Suggestion Engine ───────────────────────────────────────────────────────

/**
 * Build context-aware suggestions for an invalid or incomplete command.
 * Uses open positions to generate relevant examples.
 * Returns formatted suggestion text, or null if no suggestions.
 */
export function getSuggestions(
  input: string,
  positions?: { market: string; side: string; sizeUsd: number }[],
): string | null {
  const lower = input.toLowerCase().trim();
  if (!lower) return null;

  // Position-aware suggestions take priority for trade commands
  if (positions && positions.length > 0) {
    const positionSuggestions = getPositionAwareSuggestions(lower, positions);
    if (positionSuggestions) return positionSuggestions;
  }

  // Static usage examples for exact command stems
  for (const [cmd, examples] of Object.entries(USAGE_EXAMPLES)) {
    if (lower === cmd) {
      return formatSuggestions(examples);
    }
  }

  // "Did you mean?" for close-but-not-exact matches
  const didYouMean = findDidYouMean(lower);
  if (didYouMean) return didYouMean;

  return null;
}

/**
 * Generate suggestions based on the user's open positions.
 */
function getPositionAwareSuggestions(
  lower: string,
  positions: { market: string; side: string; sizeUsd: number }[],
): string | null {
  if (lower === 'close' && positions.length > 0) {
    const examples = positions.slice(0, 3).map((p) => `close ${p.market} ${p.side.toLowerCase()}`);
    return formatSuggestions(examples);
  }

  if (lower === 'add' && positions.length > 0) {
    const examples = positions.slice(0, 3).map((p) => `add $50 to ${p.market} ${p.side.toLowerCase()}`);
    return formatSuggestions(examples);
  }

  if (lower === 'remove' && positions.length > 0) {
    const examples = positions.slice(0, 3).map((p) => `remove $50 from ${p.market} ${p.side.toLowerCase()}`);
    return formatSuggestions(examples);
  }

  return null;
}

/**
 * Find close matches for a mistyped command using edit distance.
 */
function findDidYouMean(input: string): string | null {
  // Only try for inputs that look like commands (no special chars except hyphen/space)
  if (/[^a-z0-9\s-]/.test(input)) {
    // Strip non-alpha and try matching
    const cleaned = input.replace(/[^a-z0-9\s-]/g, '').trim();
    if (cleaned) {
      const exact = COMMANDS.find((c) => c === cleaned);
      if (exact) {
        return formatDidYouMean([exact]);
      }
    }
  }

  // Find commands within edit distance 2
  const close = COMMANDS.filter((cmd) => {
    if (Math.abs(cmd.length - input.length) > 2) return false;
    return editDistance(input, cmd) <= 2;
  });

  if (close.length > 0 && close.length <= 3) {
    return formatDidYouMean(close);
  }

  // Prefix match fallback
  const prefixed = COMMANDS.filter((cmd) => cmd.startsWith(input.slice(0, 3)));
  if (prefixed.length > 0 && prefixed.length <= 5) {
    return formatDidYouMean(prefixed);
  }

  return null;
}

/**
 * Levenshtein edit distance (bounded — bails early for large distances).
 */
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

// ─── Formatting Helpers ──────────────────────────────────────────────────────

function formatSuggestions(examples: string[]): string {
  const lines = ['', `  ${theme.section('Suggestions')}`, ...examples.map((e) => `    ${theme.command(e)}`), ''];
  return lines.join('\n');
}

function formatDidYouMean(matches: string[]): string {
  const lines = ['', `  ${theme.section('Did you mean?')}`, ...matches.map((m) => `    ${theme.command(m)}`), ''];
  return lines.join('\n');
}
