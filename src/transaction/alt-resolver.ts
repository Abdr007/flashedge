/**
 * Address Lookup Table (ALT) Resolver
 *
 * Loads and caches Address Lookup Tables from the Flash SDK.
 * ALTs compress account references from 32 bytes to 1 byte,
 * critical for fitting multi-instruction transactions within
 * the 1232-byte limit.
 *
 * The Flash SDK README shows that EVERY transaction should use ALTs
 * via `perpClient.getOrLoadAddressLookupTable()`.
 */

import { type AddressLookupTableAccount, type TransactionInstruction, type MessageV0 } from '@solana/web3.js';
import type { PoolConfig } from 'flash-sdk';
import { getLogger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ALTDiagnostics {
  tableCount: number;
  totalAddresses: number;
  tablesWithAddresses: number;
  tableDetails: Array<{ key: string; addressCount: number }>;
}

// ─── Cache ──────────────────────────────────────────────────────────────────

interface CachedALT {
  tables: AddressLookupTableAccount[];
  fetchedAt: number;
}

const altCache = new Map<string, CachedALT>();
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

// ─── SDK Client Type ────────────────────────────────────────────────────────

type PerpClientWithALT = {
  getOrLoadAddressLookupTable: (poolConfig: PoolConfig) => Promise<{
    addressLookupTables: AddressLookupTableAccount[];
  }>;
  addressLookupTables?: AddressLookupTableAccount[];
};

// ─── Core Resolver ──────────────────────────────────────────────────────────

/**
 * Resolve Address Lookup Tables for a pool.
 * Uses the SDK's built-in ALT loader with a TTL cache.
 * Validates that returned tables contain actual addresses.
 *
 * @param perpClient  Flash SDK PerpetualsClient instance
 * @param poolConfig  Pool configuration
 * @returns           ALT accounts (empty array on failure — graceful degradation)
 */
export async function resolveALTs(
  perpClient: PerpClientWithALT,
  poolConfig: PoolConfig,
): Promise<AddressLookupTableAccount[]> {
  const logger = getLogger();
  const cacheKey = poolConfig.poolName;

  // Check cache
  const cached = altCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.tables;
  }

  try {
    const { addressLookupTables } = await perpClient.getOrLoadAddressLookupTable(poolConfig);

    // Validate ALT content — tables without addresses are useless
    const validTables = addressLookupTables.filter(
      (t) => t && t.state && t.state.addresses && t.state.addresses.length > 0,
    );

    if (addressLookupTables.length > 0 && validTables.length === 0) {
      logger.info(
        'ALT',
        `${cacheKey}: ${addressLookupTables.length} table(s) loaded but NONE contain addresses — ALTs will have no effect`,
      );
    } else if (validTables.length > 0) {
      const totalAddrs = validTables.reduce((sum, t) => sum + t.state.addresses.length, 0);
      logger.debug('ALT', `${cacheKey}: ${validTables.length} table(s), ${totalAddrs} total addresses`);
    }

    // Cache ALL tables returned by SDK (even empty ones — SDK may populate them later)
    altCache.set(cacheKey, { tables: addressLookupTables, fetchedAt: Date.now() });
    return addressLookupTables;
  } catch (err: unknown) {
    logger.info('ALT', `Failed to load ALTs for ${cacheKey}: ${err}`);

    // Fallback: check if SDK has previously loaded tables on the perpClient instance
    if (perpClient.addressLookupTables && perpClient.addressLookupTables.length > 0) {
      logger.debug(
        'ALT',
        `Using perpClient.addressLookupTables fallback (${perpClient.addressLookupTables.length} tables)`,
      );
      altCache.set(cacheKey, { tables: perpClient.addressLookupTables, fetchedAt: Date.now() });
      return perpClient.addressLookupTables;
    }

    // Graceful degradation — compile without ALTs
    return [];
  }
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

/**
 * Get diagnostic info about cached ALTs for a pool.
 * Used for runtime verification and debugging.
 */
export function getALTDiagnostics(poolName: string): ALTDiagnostics | null {
  const cached = altCache.get(poolName);
  if (!cached) return null;

  const tableDetails = cached.tables.map((t) => ({
    key: t.key.toBase58(),
    addressCount: t.state?.addresses?.length ?? 0,
  }));

  return {
    tableCount: cached.tables.length,
    totalAddresses: tableDetails.reduce((sum, t) => sum + t.addressCount, 0),
    tablesWithAddresses: tableDetails.filter((t) => t.addressCount > 0).length,
    tableDetails,
  };
}

/**
 * Verify that transaction instruction accounts overlap with ALT addresses.
 * Returns the number of accounts that can be compressed via ALT.
 * This is the key check — if overlap is zero, ALTs have no effect.
 */
export function verifyALTAccountOverlap(
  instructions: TransactionInstruction[],
  altAccounts: AddressLookupTableAccount[],
): { totalAccounts: number; compressible: number; compressionRatio: number } {
  if (altAccounts.length === 0 || instructions.length === 0) {
    const totalAccounts = new Set(
      instructions.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((k) => k.pubkey.toBase58())]),
    ).size;
    return { totalAccounts, compressible: 0, compressionRatio: 0 };
  }

  // Collect all unique accounts from instructions
  const txAccountSet = new Set<string>();
  for (const ix of instructions) {
    txAccountSet.add(ix.programId.toBase58());
    for (const key of ix.keys) {
      txAccountSet.add(key.pubkey.toBase58());
    }
  }

  // Collect all addresses in ALTs
  const altAddressSet = new Set<string>();
  for (const alt of altAccounts) {
    if (alt.state?.addresses) {
      for (const addr of alt.state.addresses) {
        altAddressSet.add(addr.toBase58());
      }
    }
  }

  // Count overlap
  let compressible = 0;
  for (const account of txAccountSet) {
    if (altAddressSet.has(account)) {
      compressible++;
    }
  }

  const totalAccounts = txAccountSet.size;
  const compressionRatio = totalAccounts > 0 ? compressible / totalAccounts : 0;

  return { totalAccounts, compressible, compressionRatio };
}

/**
 * Log compilation diagnostics after MessageV0 is compiled.
 * Checks whether ALT lookups were actually used in the compiled message.
 */
export function logMessageALTDiagnostics(message: MessageV0, label: string): void {
  const logger = getLogger();
  const lookups = message.addressTableLookups ?? [];
  const staticCount = message.staticAccountKeys?.length ?? 0;

  if (lookups.length > 0) {
    const totalLookupAccounts = lookups.reduce(
      (sum, l) => sum + l.readonlyIndexes.length + l.writableIndexes.length,
      0,
    );
    logger.debug(
      'ALT',
      `${label}: ${staticCount} static + ${totalLookupAccounts} via ALT (${lookups.length} table(s))`,
    );
  } else {
    logger.debug('ALT', `${label}: ${staticCount} static accounts, no ALT lookups used`);
  }
}

/** Clear the ALT cache (for testing or manual refresh). */
export function clearALTCache(): void {
  altCache.clear();
}

/** Get cache age for a pool (ms since fetch, or -1 if not cached). */
export function getALTCacheAge(poolName: string): number {
  const cached = altCache.get(poolName);
  return cached ? Date.now() - cached.fetchedAt : -1;
}
