/**
 * Market Registry — SDK-driven single source of truth for ALL Flash Trade markets.
 *
 * Reads PoolConfig.json from flash-sdk and extracts:
 *   - Every tradeable market symbol
 *   - Pyth oracle feed IDs
 *   - Market classification (crypto, equity, forex, commodity, index)
 *   - Correlation cluster assignments
 *   - Default slippage estimates
 *   - Alias mappings
 *   - Sizing multipliers per market type
 *
 * NO HARDCODED MARKET LISTS. SDK = single source of truth.
 * When flash-sdk updates, `npm update flash-sdk` picks up new markets automatically.
 */

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { getLogger } from '../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export enum MarketType {
  CRYPTO = 'CRYPTO',
  EQUITY = 'EQUITY',
  INDEX = 'INDEX',
  FOREX = 'FOREX',
  COMMODITY = 'COMMODITY',
  UNKNOWN = 'UNKNOWN',
}

export interface MarketMeta {
  symbol: string;
  poolName: string;
  pythFeedId: string;
  pythTicker: string;
  decimals: number;
  isVirtual: boolean;
  type: MarketType;
  cluster: string;
  group: string;
  defaultSlippageBps: number;
  aliases: string[];
  /** Sizing multiplier for agent: 1.0=full, 0.5=half, 0.3=cautious */
  sizingMultiplier: number;
}

export interface RegistryStats {
  totalMarkets: number;
  byType: Record<string, number>;
  byPool: Record<string, number>;
  byCluster: Record<string, number>;
}

// ─── SDK JSON Shape ──────────────────────────────────────────────────────────

interface SdkToken {
  symbol: string;
  mintKey: string;
  decimals: number;
  isStable: boolean;
  isVirtual: boolean;
  pythTicker: string;
  pythPriceId: string;
}

interface SdkMarket {
  targetMint: string;
  maxLev: number;
  degenMinLev: number;
  degenMaxLev: number;
}

interface SdkPool {
  poolName: string;
  cluster: string;
  isDeprecated: boolean;
  tokens: SdkToken[];
  markets: SdkMarket[];
}

interface SdkConfig {
  pools: SdkPool[];
}

// ─── Skip Tokens (collateral/LP, not tradeable markets) ─────────────────────

const SKIP_TOKENS = new Set(['USDC', 'USDT', 'WSOL', 'XAUT', 'JITOSOL']);
const SKIP_POOL_PREFIXES = ['devnet.', 'Remora.'];

// ─── Classification Engine ───────────────────────────────────────────────────

function classifyMarket(symbol: string, pythTicker: string, poolName: string): MarketType {
  const ticker = pythTicker.toLowerCase();

  // Equity detection from Pyth ticker
  if (ticker.startsWith('equity.')) {
    // SPY is an index fund, but trades as equity on Flash
    return symbol === 'SPY' ? MarketType.INDEX : MarketType.EQUITY;
  }

  // Forex detection
  if (ticker.startsWith('fx.')) return MarketType.FOREX;

  // Commodity detection
  if (ticker.startsWith('metal.')) return MarketType.COMMODITY;
  if (ticker.startsWith('commodities.')) return MarketType.COMMODITY;

  // Crypto is the default for Crypto.* tickers
  if (ticker.startsWith('crypto.')) return MarketType.CRYPTO;

  // Pool-name heuristics for edge cases
  if (poolName.startsWith('Equity')) return MarketType.EQUITY;
  if (poolName.startsWith('Virtual')) {
    // Virtual.1 contains metals, forex, commodities
    if (['XAU', 'XAG'].includes(symbol)) return MarketType.COMMODITY;
    if (['EUR', 'GBP', 'USDJPY', 'USDCNH'].includes(symbol)) return MarketType.FOREX;
    if (['CRUDEOIL', 'NATGAS'].includes(symbol)) return MarketType.COMMODITY;
  }

  return MarketType.UNKNOWN;
}

// ─── Cluster Assignment ──────────────────────────────────────────────────────
// Clusters group correlated assets for risk management.
// Assigned based on market type + pool membership.

function assignCluster(symbol: string, type: MarketType, poolName: string): string {
  switch (type) {
    case MarketType.INDEX:
      return 'us_equities'; // SPY groups with equities
    case MarketType.EQUITY:
      return 'us_equities';
    case MarketType.FOREX:
      return 'forex';
    case MarketType.COMMODITY:
      if (symbol === 'XAU' || symbol === 'XAG') return 'precious_metals';
      return 'commodities';
    case MarketType.CRYPTO:
      break;
    default:
      return `standalone_${symbol}`;
  }

  // Crypto sub-clusters based on pool
  if (poolName === 'Crypto.1') {
    if (['BTC'].includes(symbol)) return 'btc_major';
    if (['ETH'].includes(symbol)) return 'eth_major';
    return 'sol_ecosystem'; // SOL, ZEC, BNB live in Crypto.1
  }
  if (poolName === 'Governance.1') return 'defi_governance';
  if (poolName === 'Community.1' || poolName === 'Community.2') return 'meme_community';
  if (poolName === 'Trump.1') return 'meme_community';
  if (poolName === 'Ore.1') return 'standalone_ORE';

  return `standalone_${symbol}`;
}

// ─── Asset Group Assignment ──────────────────────────────────────────────────
// Groups are broader categories for portfolio concentration checks.

function assignGroup(symbol: string, type: MarketType, poolName: string): string {
  switch (type) {
    case MarketType.INDEX:
    case MarketType.EQUITY:
      return 'equities';
    case MarketType.FOREX:
      return 'forex';
    case MarketType.COMMODITY:
      if (symbol === 'XAU' || symbol === 'XAG') return 'precious_metals';
      return 'commodities';
    case MarketType.CRYPTO:
      break;
    default:
      return 'standalone';
  }

  // Crypto sub-groups
  if (['SOL', 'BTC', 'ETH'].includes(symbol)) return 'major_crypto';
  if (poolName === 'Governance.1') return 'alt_defi';
  if (poolName === 'Community.1' || poolName === 'Community.2' || poolName === 'Trump.1') return 'meme';
  return 'standalone';
}

// ─── Slippage Defaults ───────────────────────────────────────────────────────
// Based on typical liquidity per market type and asset.

function assignSlippageBps(symbol: string, type: MarketType, poolName: string): number {
  // Major crypto — deep liquidity
  if (symbol === 'BTC') return 3;
  if (symbol === 'ETH') return 4;
  if (symbol === 'SOL') return 6;

  // By type
  switch (type) {
    case MarketType.INDEX:
      return 4; // SPY
    case MarketType.EQUITY:
      return 8; // stocks — moderate liquidity
    case MarketType.FOREX:
      return 5; // forex — deep liquidity
    case MarketType.COMMODITY:
      if (symbol === 'XAU') return 5;
      if (symbol === 'XAG') return 8;
      return 10; // crude oil etc.
    case MarketType.CRYPTO:
      break;
    default:
      return 15; // unknown — conservative
  }

  // Crypto by pool
  if (poolName === 'Governance.1') return 12; // alt DeFi
  if (poolName === 'Community.1' || poolName === 'Community.2') return 18; // meme
  if (poolName === 'Trump.1') return 20; // meme
  if (poolName === 'Ore.1') return 15;
  return 10; // crypto fallback
}

// ─── Sizing Multiplier ──────────────────────────────────────────────────────
// Agent uses this to scale position sizes by market type.

function assignSizingMultiplier(type: MarketType): number {
  switch (type) {
    case MarketType.CRYPTO:
      return 1.0;
    case MarketType.EQUITY:
    case MarketType.INDEX:
      return 0.5;
    case MarketType.FOREX:
    case MarketType.COMMODITY:
      return 0.7;
    case MarketType.UNKNOWN:
      return 0.3;
  }
}

// ─── Alias Generation ────────────────────────────────────────────────────────
// Auto-generate common aliases. Custom aliases preserved separately.

const KNOWN_ALIASES: Record<string, string[]> = {
  SOL: ['solana'],
  BTC: ['bitcoin'],
  ETH: ['ethereum', 'ether'],
  BNB: ['binance'],
  ZEC: ['zcash'],
  JTO: ['jito'],
  JUP: ['jupiter'],
  RAY: ['raydium'],
  KMNO: ['kamino'],
  MET: ['metaplex'],
  PYTH: ['pyth'],
  BONK: ['bonk'],
  WIF: ['wif', 'dogwifhat'],
  PENGU: ['penguin', 'pengu'],
  PUMP: ['pumpfun', 'pump'],
  FARTCOIN: ['fartcoin', 'fart'],
  ORE: ['ore'],
  HYPE: ['hyperliquid', 'hype'],
  XAU: ['gold'],
  XAG: ['silver'],
  CRUDEOIL: ['crude', 'oil', 'crude oil', 'crudeoil'],
  NATGAS: ['natural gas', 'nat gas', 'gas'],
  EUR: ['euro'],
  GBP: ['pound', 'sterling'],
  USDJPY: ['yen'],
  USDCNH: ['yuan'],
  SPY: ['sp500', 's&p', 's&p500', 'sp 500'],
  NVDA: ['nvidia'],
  TSLA: ['tesla'],
  AAPL: ['apple'],
  AMD: ['amd'],
  AMZN: ['amazon'],
  PLTR: ['palantir'],
};

function getAliases(symbol: string): string[] {
  return KNOWN_ALIASES[symbol] ?? [];
}

// ─── Registry Builder ────────────────────────────────────────────────────────

let _registry: Map<string, MarketMeta> | null = null;
let _reverseAliases: Map<string, string> | null = null;
let _clusterMap: Map<string, string[]> | null = null;
let _groupMap: Map<string, string[]> | null = null;
let _pythFeedMap: Map<string, string> | null = null;

function buildRegistry(): Map<string, MarketMeta> {
  const registry = new Map<string, MarketMeta>();

  try {
    const require = createRequire(import.meta.url);
    const configPath = require.resolve('flash-sdk/dist/PoolConfig.json');
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as SdkConfig;

    const seen = new Set<string>();

    for (const pool of raw.pools) {
      // Skip devnet, deprecated, non-tradeable pools
      if (pool.cluster !== 'mainnet-beta') continue;
      if (pool.isDeprecated) continue;
      if (SKIP_POOL_PREFIXES.some((p) => pool.poolName.startsWith(p))) continue;
      if (seen.has(pool.poolName)) continue; // Deduplicate
      seen.add(pool.poolName);

      // Build mint → token lookup for this pool
      const mintToToken = new Map<string, SdkToken>();
      for (const token of pool.tokens) {
        mintToToken.set(token.mintKey, token);
      }

      // Extract tradeable markets from market configs
      const tradeableTokenMints = new Set<string>();
      for (const market of pool.markets) {
        tradeableTokenMints.add(market.targetMint);
      }

      for (const token of pool.tokens) {
        const sym = token.symbol.toUpperCase();
        if (SKIP_TOKENS.has(sym)) continue;
        if (registry.has(sym)) continue; // First pool wins (dedup across pools)

        // Only include tokens that have actual markets (long/short pairs)
        if (!tradeableTokenMints.has(token.mintKey)) continue;

        const type = classifyMarket(sym, token.pythTicker, pool.poolName);
        const cluster = assignCluster(sym, type, pool.poolName);
        const group = assignGroup(sym, type, pool.poolName);

        registry.set(sym, {
          symbol: sym,
          poolName: pool.poolName,
          pythFeedId: token.pythPriceId,
          pythTicker: token.pythTicker,
          decimals: token.decimals,
          isVirtual: token.isVirtual,
          type,
          cluster,
          group,
          defaultSlippageBps: assignSlippageBps(sym, type, pool.poolName),
          aliases: getAliases(sym),
          sizingMultiplier: assignSizingMultiplier(type),
        });
      }
    }
  } catch (error) {
    getLogger().warn('REGISTRY', `Failed to build market registry from SDK: ${error}`);
  }

  return registry;
}

function ensureRegistry(): Map<string, MarketMeta> {
  if (!_registry) {
    _registry = buildRegistry();
    // Build derived maps
    _reverseAliases = new Map();
    _clusterMap = new Map();
    _groupMap = new Map();
    _pythFeedMap = new Map();

    for (const [sym, meta] of _registry) {
      // Reverse alias lookup
      for (const alias of meta.aliases) {
        _reverseAliases.set(alias.toLowerCase(), sym);
      }

      // Cluster map
      const clusterMembers = _clusterMap.get(meta.cluster) ?? [];
      clusterMembers.push(sym);
      _clusterMap.set(meta.cluster, clusterMembers);

      // Group map
      const groupMembers = _groupMap.get(meta.group) ?? [];
      groupMembers.push(sym);
      _groupMap.set(meta.group, groupMembers);

      // Pyth feed map
      if (meta.pythFeedId) {
        _pythFeedMap.set(sym, meta.pythFeedId);
      }
    }
  }
  return _registry;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Get metadata for a single market. Returns undefined if not in SDK. */
export function getMarketMeta(symbol: string): MarketMeta | undefined {
  return ensureRegistry().get(symbol.toUpperCase());
}

/** Get ALL market metadata entries. */
export function getAllMarketMeta(): MarketMeta[] {
  return Array.from(ensureRegistry().values());
}

/** Get all registered market symbols. */
export function getRegisteredSymbols(): string[] {
  return Array.from(ensureRegistry().keys());
}

/** Get Pyth feed ID for a symbol. Returns undefined if not found. */
export function getPythFeedIdFromRegistry(symbol: string): string | undefined {
  ensureRegistry();
  return _pythFeedMap!.get(symbol.toUpperCase());
}

/** Get ALL Pyth feed IDs as a Record (drop-in replacement for hardcoded map). */
export function getAllPythFeedIds(): Record<string, string> {
  ensureRegistry();
  const result: Record<string, string> = {};
  for (const [sym, feedId] of _pythFeedMap!) {
    result[sym] = feedId;
  }
  return result;
}

/** Resolve an alias to a canonical symbol. Returns undefined if not an alias. */
export function resolveAlias(alias: string): string | undefined {
  ensureRegistry();
  return _reverseAliases!.get(alias.toLowerCase());
}

/** Get all aliases as a Record<lowercase_alias, SYMBOL>. */
export function getAllAliases(): Record<string, string> {
  ensureRegistry();
  const result: Record<string, string> = {};
  for (const [alias, sym] of _reverseAliases!) {
    result[alias] = sym;
  }
  return result;
}

/** Get cluster assignment for a market. Returns standalone if unknown. */
export function getMarketCluster(symbol: string): string {
  const meta = getMarketMeta(symbol);
  return meta?.cluster ?? `standalone_${symbol.toUpperCase()}`;
}

/** Get all clusters as Record<cluster_name, symbols[]>. */
export function getAllClusters(): Record<string, string[]> {
  ensureRegistry();
  const result: Record<string, string[]> = {};
  for (const [cluster, members] of _clusterMap!) {
    result[cluster] = [...members];
  }
  return result;
}

/** Get asset group for a market. Returns 'standalone' if unknown. */
export function getMarketGroup(symbol: string): string {
  const meta = getMarketMeta(symbol);
  return meta?.group ?? 'standalone';
}

/** Get all groups as Record<group_name, symbols[]>. */
export function getAllGroups(): Record<string, string[]> {
  ensureRegistry();
  const result: Record<string, string[]> = {};
  for (const [group, members] of _groupMap!) {
    result[group] = [...members];
  }
  return result;
}

/** Get default slippage BPS for a market. Returns 15 for unknown. */
export function getDefaultSlippageBps(symbol: string): number {
  return getMarketMeta(symbol)?.defaultSlippageBps ?? 15;
}

/** Get sizing multiplier for agent. Returns 0.3 for unknown markets. */
export function getSizingMultiplier(symbol: string): number {
  return getMarketMeta(symbol)?.sizingMultiplier ?? 0.3;
}

/** Get market type. Returns UNKNOWN if not in registry. */
export function getMarketType(symbol: string): MarketType {
  return getMarketMeta(symbol)?.type ?? MarketType.UNKNOWN;
}

/** Get markets by type. */
export function getMarketsByType(type: MarketType): string[] {
  return getAllMarketMeta()
    .filter((m) => m.type === type)
    .map((m) => m.symbol);
}

/** Get markets by cluster. */
export function getMarketsByCluster(cluster: string): string[] {
  ensureRegistry();
  return _clusterMap!.get(cluster) ?? [];
}

/** Get registry stats for diagnostics. */
export function getRegistryStats(): RegistryStats {
  const all = getAllMarketMeta();
  const byType: Record<string, number> = {};
  const byPool: Record<string, number> = {};
  const byCluster: Record<string, number> = {};

  for (const m of all) {
    byType[m.type] = (byType[m.type] ?? 0) + 1;
    byPool[m.poolName] = (byPool[m.poolName] ?? 0) + 1;
    byCluster[m.cluster] = (byCluster[m.cluster] ?? 0) + 1;
  }

  return { totalMarkets: all.length, byType, byPool, byCluster };
}

/** Force rebuild the registry (e.g., after SDK update at runtime). */
export function refreshRegistry(): void {
  _registry = null;
  _reverseAliases = null;
  _clusterMap = null;
  _groupMap = null;
  _pythFeedMap = null;
}
