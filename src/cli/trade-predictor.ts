/**
 * Trade Predictor
 *
 * Generates command suggestions based on trade history.
 * Used by the autocomplete system to suggest likely next commands.
 *
 * Stores recent commands in ~/.flash/history-stats.json (top 20 patterns).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const STATS_FILE = join(homedir(), '.flash', 'history-stats.json');
const MAX_PATTERNS = 20;

interface CommandPattern {
  command: string;
  count: number;
  lastUsed: number;
}

let _cache: CommandPattern[] | null = null;

function loadPatterns(): CommandPattern[] {
  if (_cache) return _cache;
  try {
    if (!existsSync(STATS_FILE)) {
      _cache = [];
      return _cache;
    }
    const raw = JSON.parse(readFileSync(STATS_FILE, 'utf8'));
    if (!Array.isArray(raw)) {
      _cache = [];
      return _cache;
    }
    _cache = raw as CommandPattern[];
    return _cache;
  } catch {
    _cache = [];
    return _cache;
  }
}

function savePatterns(patterns: CommandPattern[]): void {
  try {
    const dir = join(homedir(), '.flash');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(STATS_FILE, JSON.stringify(patterns, null, 2), { mode: 0o600 });
    _cache = patterns;
  } catch {
    /* best-effort */
  }
}

/**
 * Record a successful trade command for prediction.
 * Only records open_position commands (the primary use case for prediction).
 */
export function recordTradeCommand(command: string): void {
  // Normalize: lowercase, collapse whitespace, strip $ signs
  const normalized = command.toLowerCase().replace(/\$/g, '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 100) return;

  // Only track trade-like commands (must contain a market + side + number)
  if (!/\b(long|short)\b/.test(normalized) || !/\d/.test(normalized)) return;

  const patterns = loadPatterns();
  const existing = patterns.find((p) => p.command === normalized);
  if (existing) {
    existing.count++;
    existing.lastUsed = Date.now();
  } else {
    patterns.push({ command: normalized, count: 1, lastUsed: Date.now() });
  }

  // Keep top N by score (count * recency)
  patterns.sort((a, b) => {
    const scoreA = a.count * (1 + Math.max(0, 1 - (Date.now() - a.lastUsed) / 86_400_000));
    const scoreB = b.count * (1 + Math.max(0, 1 - (Date.now() - b.lastUsed) / 86_400_000));
    return scoreB - scoreA;
  });
  if (patterns.length > MAX_PATTERNS) patterns.length = MAX_PATTERNS;

  savePatterns(patterns);
}

/**
 * Get predictions for a partial command.
 * Returns up to 3 suggestions matching the prefix.
 */
export function getPredictions(prefix: string, maxResults = 3): string[] {
  const lower = prefix.toLowerCase().trim();
  if (!lower) return [];

  const patterns = loadPatterns();
  return patterns
    .filter((p) => p.command.startsWith(lower) && p.command !== lower)
    .slice(0, maxResults)
    .map((p) => p.command);
}

/**
 * Get the user's most common leverage for a market.
 */
export function getPreferredLeverage(market: string): number | null {
  const lower = market.toLowerCase();
  const patterns = loadPatterns();
  const levCounts: Record<number, number> = {};

  for (const p of patterns) {
    if (!p.command.includes(lower)) continue;
    const levMatch = p.command.match(/(\d+(?:\.\d+)?)\s*x/);
    if (levMatch) {
      const lev = parseFloat(levMatch[1]);
      levCounts[lev] = (levCounts[lev] || 0) + p.count;
    }
  }

  const entries = Object.entries(levCounts);
  if (entries.length === 0) return null;
  entries.sort((a, b) => (b[1] as number) - (a[1] as number));
  return parseFloat(entries[0][0]);
}

export function clearPredictorCache(): void {
  _cache = null;
}
