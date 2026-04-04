/**
 * Learned Alias System
 *
 * Stores user-defined command aliases in ~/.flash/aliases.json.
 * Aliases are expanded at parse time before any pattern matching.
 *
 * Usage:
 *   alias lsol = long sol
 *   alias sb = short btc
 *   aliases              (list all)
 *   unalias lsol         (remove)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const ALIAS_FILE = join(homedir(), '.flash', 'aliases.json');
const MAX_ALIASES = 200;

let _cache: Record<string, string> | null = null;

/** Load aliases from disk (cached after first load). */
export function loadAliases(): Record<string, string> {
  if (_cache) return _cache;
  try {
    if (!existsSync(ALIAS_FILE)) {
      _cache = {};
      return _cache;
    }
    const raw = JSON.parse(readFileSync(ALIAS_FILE, 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      _cache = {};
      return _cache;
    }
    _cache = raw as Record<string, string>;
    return _cache;
  } catch {
    _cache = {};
    return _cache;
  }
}

/** Save aliases to disk. */
function saveAliases(aliases: Record<string, string>): void {
  try {
    const dir = join(homedir(), '.flash');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(ALIAS_FILE, JSON.stringify(aliases, null, 2), { mode: 0o600 });
    _cache = aliases;
  } catch {
    // Best-effort — don't crash on write failure
  }
}

const RESERVED = new Set([
  'help', 'portfolio', 'positions', 'balance', 'wallet', 'markets',
  'close', 'open', 'long', 'short', 'dryrun', 'exit', 'quit',
  'dashboard', 'scan', 'analyze', 'risk', 'monitor', 'history',
  'trades', 'volume', 'funding', 'depth', 'inspect', 'earn',
  'degen', 'config', 'status', 'fees',
]);

/** Set a custom alias. */
export function setAlias(shortcut: string, expansion: string): boolean {
  const aliases = loadAliases();
  if (Object.keys(aliases).length >= MAX_ALIASES && !(shortcut in aliases)) {
    return false; // Too many aliases
  }
  const key = shortcut.toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(key)) return false;
  if (key.length > 50) return false;
  if (RESERVED.has(key)) return false;
  aliases[key] = expansion;
  saveAliases(aliases);
  return true;
}

/** Remove a custom alias. */
export function removeAlias(shortcut: string): boolean {
  const aliases = loadAliases();
  const key = shortcut.toLowerCase();
  if (!(key in aliases)) return false;
  delete aliases[key];
  saveAliases(aliases);
  return true;
}

/** Expand a learned alias if it matches the first token(s) of input. */
export function expandLearnedAlias(input: string): string {
  const aliases = loadAliases();
  const lower = input.toLowerCase();

  // Try matching longest alias first (multi-word aliases)
  const sorted = Object.entries(aliases).sort((a, b) => b[0].length - a[0].length);
  for (const [shortcut, expansion] of sorted) {
    if (lower === shortcut || lower.startsWith(shortcut + ' ')) {
      const rest = input.slice(shortcut.length);
      return expansion + rest;
    }
  }
  return input;
}

/** Get all aliases for display. */
export function getAllAliases(): Record<string, string> {
  return { ...loadAliases() };
}

/** Clear the in-memory cache (for testing). */
export function clearCache(): void {
  _cache = null;
}
