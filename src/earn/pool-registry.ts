/**
 * Flash Trade Pool Registry
 *
 * Dynamic registry of all liquidity pools sourced from the Flash SDK.
 * Provides pool metadata, aliases, token mappings, and live data fetching.
 *
 * Excludes RWA pool (closing).
 */

import { PoolConfig } from 'flash-sdk';
import { PublicKey } from '@solana/web3.js';

// ─── Pool Metadata ──────────────────────────────────────────────────────────

export interface PoolInfo {
  /** Protocol pool ID (e.g. "Crypto.1") */
  poolId: string;
  /** Human-readable display name */
  displayName: string;
  /** CLI aliases (first is primary) */
  aliases: string[];
  /** FLP token symbol (e.g. "FLP.1") */
  flpSymbol: string;
  /** sFLP token symbol (e.g. "sFLP.1") */
  sflpSymbol: string;
  /** FLP compounding token mint */
  flpMint: PublicKey;
  /** sFLP staked token mint */
  sflpMint: PublicKey;
  /** LP token decimals */
  lpDecimals: number;
  /** Pool assets (market tokens, excluding collateral) */
  assets: string[];
  /** Fee share to LPs (0.7 = 70%) */
  feeShare: number;
  /** SDK PoolConfig reference */
  poolConfig: PoolConfig;
}

// ─── Static Pool Definitions ────────────────────────────────────────────────
// Order matches Flash UI. RWA excluded.

const POOL_DEFS: Array<{
  poolId: string;
  displayName: string;
  aliases: string[];
  feeShare: number;
  skipTokens: string[];
}> = [
  {
    poolId: 'Crypto.1',
    displayName: 'Crypto Pool',
    aliases: ['crypto', 'main', 'bluechip'],
    feeShare: 0.7,
    skipTokens: ['USDC', 'USDT', 'WSOL'],
  },
  {
    poolId: 'Virtual.1',
    displayName: 'Gold Pool',
    aliases: ['gold', 'virtual', 'forex', 'commodities'],
    feeShare: 0.7,
    skipTokens: ['USDC', 'USDT'],
  },
  {
    poolId: 'Governance.1',
    displayName: 'DeFi Pool',
    aliases: ['defi', 'governance', 'gov'],
    feeShare: 0.7,
    skipTokens: ['USDC', 'USDT'],
  },
  {
    poolId: 'Community.1',
    displayName: 'Meme Pool',
    aliases: ['meme', 'community'],
    feeShare: 0.8,
    skipTokens: ['USDC', 'USDT'],
  },
  { poolId: 'Community.2', displayName: 'WIF Pool', aliases: ['wif'], feeShare: 0.8, skipTokens: ['USDC', 'USDT'] },
  { poolId: 'Ore.1', displayName: 'Ore Pool', aliases: ['ore'], feeShare: 0.9, skipTokens: ['USDC', 'USDT'] },
  {
    poolId: 'Trump.1',
    displayName: 'FART Pool',
    aliases: ['fart', 'fartcoin', 'trump'],
    feeShare: 0.8,
    skipTokens: ['USDC', 'USDT'],
  },
];

// ─── Registry ───────────────────────────────────────────────────────────────

let _registry: PoolInfo[] | null = null;

/** Build the pool registry from Flash SDK PoolConfig. */
export function getPoolRegistry(): PoolInfo[] {
  if (_registry) return _registry;

  const pools: PoolInfo[] = [];
  for (const def of POOL_DEFS) {
    try {
      const pc = PoolConfig.fromIdsByName(def.poolId, 'mainnet-beta');
      const assets = (pc.tokens || [])
        .map((t: { symbol: string }) => t.symbol)
        .filter((s: string) => !def.skipTokens.includes(s));

      pools.push({
        poolId: def.poolId,
        displayName: def.displayName,
        aliases: def.aliases,
        flpSymbol: pc.compoundingLpTokenSymbol || `FLP`,
        sflpSymbol: pc.stakedLpTokenSymbol || `sFLP`,
        flpMint: pc.compoundingTokenMint,
        sflpMint: pc.stakedLpTokenMint,
        lpDecimals: pc.lpDecimals,
        assets,
        feeShare: def.feeShare,
        poolConfig: pc,
      });
    } catch {
      // Pool not loadable — skip
    }
  }

  _registry = pools;
  return pools;
}

/** Resolve a pool alias to a PoolInfo. Case-insensitive. */
export function resolvePool(alias: string): PoolInfo | null {
  const lower = alias.toLowerCase().trim();
  const registry = getPoolRegistry();
  for (const pool of registry) {
    if (pool.poolId.toLowerCase() === lower) return pool;
    if (pool.displayName.toLowerCase() === lower) return pool;
    for (const a of pool.aliases) {
      if (a === lower) return pool;
    }
  }
  return null;
}

/** Resolve a token mint to pool name + token type (FLP/sFLP). */
export function resolveTokenMint(mint: string): { pool: PoolInfo; type: 'FLP' | 'sFLP' } | null {
  const registry = getPoolRegistry();
  for (const pool of registry) {
    if (pool.flpMint.toBase58() === mint) return { pool, type: 'FLP' };
    if (pool.sflpMint.toBase58() === mint) return { pool, type: 'sFLP' };
  }
  return null;
}

/** Get all pool aliases for autocomplete. */
export function getAllPoolAliases(): string[] {
  return getPoolRegistry().flatMap((p) => p.aliases);
}

/** Force refresh the registry cache. */
export function refreshPoolRegistry(): void {
  _registry = null;
}
