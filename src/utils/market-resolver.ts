/**
 * Centralized market alias resolution.
 *
 * ALL commands that accept a market name must call resolveMarket()
 * before performing any lookup. This ensures aliases like "crude oil",
 * "oil", "gold", "yen" etc. resolve consistently everywhere.
 *
 * The canonical market list comes from config/index.ts (POOL_MARKETS),
 * which is sourced from the Flash SDK pool configuration.
 */

import { getAllMarkets, getPoolForMarket } from '../config/index.js';
import { getAllAliases } from '../markets/index.js';
import { getLogger } from './logger.js';

// ─── Alias Dictionary ───────────────────────────────────────────────────────
// Loaded dynamically from Market Registry (SDK source of truth).
// Registry provides auto-generated aliases; this layer merges them with
// any custom overrides. New SDK markets get aliases automatically.

let _cachedAliases: Record<string, string> | null = null;

function getMarketAliasMap(): Record<string, string> {
  if (_cachedAliases) return _cachedAliases;
  _cachedAliases = getAllAliases();
  return _cachedAliases;
}

/** Force refresh alias cache (e.g., after SDK update). */
export function refreshAliasCache(): void {
  _cachedAliases = null;
}

/**
 * Resolve a user-provided market string to a canonical Flash Trade symbol.
 *
 * Resolution order:
 *   1. Exact match against canonical market list (case-insensitive)
 *   2. Exact alias match (preserves spaces for multi-word like "crude oil")
 *   3. Space-collapsed alias match ("crude oil" → "crudeoil")
 *   4. Fallback: uppercase with spaces removed
 *
 * @returns Canonical uppercase market symbol (e.g. "CRUDEOIL", "SOL")
 */
export function resolveMarket(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  const upper = trimmed.toUpperCase();
  const lower = trimmed.toLowerCase();
  const collapsed = upper.replace(/\s+/g, '');

  // Strip common suffixes: "-perp", "-perpetual", "perp", "perpetual"
  const stripped = lower.replace(/[-\s]?perp(?:etual)?$/i, '').trim();
  if (stripped && stripped !== lower) {
    const resolved = resolveMarket(stripped);
    if (resolved && getAllMarkets().includes(resolved)) return resolved;
  }

  // 1. Direct match against canonical market list
  const allMarkets = getAllMarkets();
  if (allMarkets.includes(upper)) return upper;
  if (allMarkets.includes(collapsed)) return collapsed;

  // 2. Exact alias match (handles multi-word like "crude oil")
  if (getMarketAliasMap()[lower]) return getMarketAliasMap()[lower];

  // 3. Space-collapsed alias match
  const collapsedLower = lower.replace(/\s+/g, '');
  if (getMarketAliasMap()[collapsedLower]) return getMarketAliasMap()[collapsedLower];

  // 4. Fallback: return collapsed uppercase
  return collapsed;
}

/**
 * Resolve a market alias AND verify it exists in the protocol.
 * @returns The canonical symbol, or null if not a valid market.
 */
export function resolveAndValidateMarket(input: string): string | null {
  const resolved = resolveMarket(input);
  if (!resolved) {
    getLogger().debug('MARKET', `Market symbol rejected (empty): "${input}"`);
    return null;
  }
  if (!getPoolForMarket(resolved)) {
    getLogger().debug('MARKET', `Unknown market symbol rejected: "${input}" (resolved: "${resolved}")`);
    return null;
  }
  return resolved;
}

/**
 * Check if a resolved market symbol is valid (exists in protocol config).
 */
export function isValidMarket(symbol: string): boolean {
  return getPoolForMarket(symbol) !== null;
}

/**
 * Get all known aliases for display/documentation purposes.
 */
export function getMarketAliases(): ReadonlyMap<string, string> {
  return new Map(Object.entries(getMarketAliasMap()));
}

/**
 * Normalize asset aliases in a free-text string.
 * Replaces known alias words with their canonical lowercase symbol.
 * Used by the interpreter for pre-processing natural language input.
 *
 * IMPORTANT: This handles multi-word aliases ("crude oil" → "crudeoil")
 * by processing them BEFORE single-word aliases.
 */
export function normalizeAssetText(text: string): string {
  let result = text;

  const aliasMap = getMarketAliasMap();

  // Process multi-word aliases first (longest match first)
  const multiWord = Object.entries(aliasMap)
    .filter(([alias]) => alias.includes(' '))
    .sort((a, b) => b[0].length - a[0].length);

  for (const [alias, symbol] of multiWord) {
    result = result.replace(new RegExp(escapeRegex(alias), 'gi'), symbol.toLowerCase());
  }

  // Then single-word aliases
  for (const [alias, symbol] of Object.entries(aliasMap)) {
    if (alias.includes(' ')) continue; // already handled
    result = result.replace(new RegExp(`\\b${escapeRegex(alias)}\\b`, 'gi'), symbol.toLowerCase());
  }

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
