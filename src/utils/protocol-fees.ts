/**
 * Protocol Fee & Margin Utilities
 *
 * Provides fee rate, maintenance margin, and max leverage resolution
 * from CustodyAccount via Flash SDK.
 *
 * All fee and margin calculations in the CLI (preview, simulation, execution)
 * must use this module for consistency.
 *
 * Data sources:
 *   Fees:              CustodyAccount.fees.openPosition / RATE_POWER
 *   Fees:              CustodyAccount.fees.closePosition / RATE_POWER
 *   MaxLeverage:       CustodyAccount.pricing.maxLeverage / BPS_POWER
 *   MaintenanceMargin: 1 / maxLeverage (derived from pricing config)
 *
 * Fallback: SDK defaults (only if on-chain fetch fails)
 *
 * Cache invalidation: slot-based — entries expire when Solana slot advances
 * beyond the slot at cache time + SLOT_STALE_THRESHOLD.
 */

const RATE_POWER = 1_000_000_000; // Flash SDK RATE_DECIMALS = 9
const BPS_POWER = 10_000; // Flash SDK BPS_DECIMALS = 4

/**
 * Thrown when CustodyAccount returns invalid or corrupted protocol parameters.
 * Callers should display a clear CLI message and abort — never silently fallback.
 */
export class ProtocolParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolParameterError';
  }
}

export interface ProtocolFeeRates {
  openFeeRate: number; // e.g. 0.00051 = 0.051% (SOL)
  closeFeeRate: number; // e.g. 0.00051 = 0.051% (SOL)
  maintenanceMarginRate: number; // e.g. 0.001 = 0.1% — derived as 1/maxLeverage
  maxLeverage: number; // e.g. 1000 — from custody.pricing.maxLeverage / BPS_POWER
  source: 'on-chain' | 'sdk-default';
}

// Cache: market -> { rates, cachedAtSlot }
interface CacheEntry {
  rates: ProtocolFeeRates;
  cachedAtSlot: number;
}
const feeCache = new Map<string, CacheEntry>();

/** Cache is stale after slot advances this many slots beyond cached slot.
 *  ~150 slots ≈ 60s at Solana's ~400ms slot time. */
const SLOT_STALE_THRESHOLD = 150;
/** Fallback TTL: if we can't get current slot, expire after 60s */
const FALLBACK_TTL_MS = 60_000;
/** Track last known slot + timestamp for fallback expiry */
let lastKnownSlot = 0;
let lastSlotFetchTime = 0;

/**
 * Get the current Solana slot for cache invalidation.
 * Uses RpcManager if available, otherwise returns 0 (triggers time-based fallback).
 */
async function getCurrentSlot(): Promise<number> {
  try {
    const { getRpcManagerInstance } = await import('../network/rpc-manager.js');
    const mgr = getRpcManagerInstance();
    if (mgr) {
      const slot = await mgr.connection.getSlot('confirmed');
      if (Number.isFinite(slot) && slot > 0) {
        lastKnownSlot = slot;
        lastSlotFetchTime = Date.now();
        return slot;
      }
    }
  } catch {
    // Slot fetch failed — use fallback
  }
  return 0;
}

/**
 * Check if a cache entry is still fresh.
 * Primary: slot-based (stale after SLOT_STALE_THRESHOLD slots).
 * Fallback: time-based (60s TTL) when slot unavailable.
 */
function isCacheFresh(entry: CacheEntry, currentSlot: number): boolean {
  if (currentSlot > 0 && entry.cachedAtSlot > 0) {
    return currentSlot - entry.cachedAtSlot < SLOT_STALE_THRESHOLD;
  }
  // Fallback: time-based using last slot fetch time
  if (lastSlotFetchTime > 0) {
    return Date.now() - lastSlotFetchTime < FALLBACK_TTL_MS;
  }
  // No slot info at all — treat as stale
  return false;
}

/**
 * Fetch fee rates, max leverage, and maintenance margin from CustodyAccount.
 *
 * Margin derivation (matches Flash protocol):
 *   maxLeverage = custody.pricing.maxLeverage / BPS_POWER
 *   maintenanceMarginRate = 1 / maxLeverage
 *
 * @param market - Market symbol (e.g. 'SOL')
 * @param perpClient - Flash SDK PerpetualsClient (or null for default)
 * @returns ProtocolFeeRates with source annotation
 */
export async function getProtocolFeeRates(market: string, perpClient: unknown | null): Promise<ProtocolFeeRates> {
  const upper = market.toUpperCase();

  // Check cache with slot-based invalidation
  const cached = feeCache.get(upper);
  if (cached) {
    const currentSlot = await getCurrentSlot();
    if (isCacheFresh(cached, currentSlot)) {
      return cached.rates;
    }
  }

  // Attempt on-chain fetch
  if (perpClient) {
    try {
      const { PoolConfig, CustodyAccount } = await import('flash-sdk');
      const { getPoolForMarket } = await import('../config/index.js');
      const poolName = getPoolForMarket(upper);
      if (poolName) {
        const pc = PoolConfig.fromIdsByName(poolName, 'mainnet-beta');
        const custodies = pc.custodies as unknown as Array<Record<string, unknown> & { symbol: string }>;
        const custody = custodies.find((c) => c.symbol.toUpperCase() === upper);
        if (custody) {
          const client = perpClient as unknown as {
            program: { account: { custody: { fetch: (key: unknown) => Promise<unknown> } } };
          };
          const custodyKey = custody.custodyAccount as Parameters<typeof CustodyAccount.from>[0];
          const rawData = await client.program.account.custody.fetch(custodyKey);
          // Must wrap with CustodyAccount.from() to get proper field structure
          const custodyAcct = CustodyAccount.from(custodyKey, rawData as Parameters<typeof CustodyAccount.from>[1]);
          const openFeeRaw = parseFloat(custodyAcct.fees.openPosition.toString());
          const closeFeeRaw = parseFloat(custodyAcct.fees.closePosition.toString());

          // ── Fee rate validation ──
          const openFeeRate = openFeeRaw / RATE_POWER;
          const closeFeeRate = closeFeeRaw / RATE_POWER;

          if (!Number.isFinite(openFeeRate) || openFeeRate < 0) {
            throw new ProtocolParameterError(`Invalid openFeeRate from CustodyAccount for ${upper}: raw=${openFeeRaw}`);
          }
          if (!Number.isFinite(closeFeeRate) || closeFeeRate < 0) {
            throw new ProtocolParameterError(
              `Invalid closeFeeRate from CustodyAccount for ${upper}: raw=${closeFeeRaw}`,
            );
          }

          // ── Max leverage validation ──
          const rawMaxLev = (custodyAcct as unknown as Record<string, Record<string, unknown>>).pricing
            ?.maxLeverage as unknown;
          const maxLevRaw =
            typeof rawMaxLev === 'object' && rawMaxLev !== null && 'toNumber' in rawMaxLev
              ? (rawMaxLev as { toNumber: () => number }).toNumber()
              : typeof rawMaxLev === 'number'
                ? rawMaxLev
                : 0;

          const maxLeverage = maxLevRaw / BPS_POWER;

          if (!Number.isFinite(maxLeverage) || maxLeverage <= 0) {
            throw new ProtocolParameterError(`Invalid maxLeverage from CustodyAccount for ${upper}: raw=${maxLevRaw}`);
          }

          // ── Maintenance margin validation ──
          const maintenanceMarginRate = 1 / maxLeverage;

          if (!Number.isFinite(maintenanceMarginRate) || maintenanceMarginRate <= 0) {
            throw new ProtocolParameterError(`Invalid maintenanceMarginRate derived for ${upper}: 1/${maxLeverage}`);
          }

          // ── Protocol invariant checks ──
          if (maintenanceMarginRate >= 1) {
            throw new ProtocolParameterError(`Protocol invariant violation: maintenance margin ≥ 100% for ${upper}`);
          }
          if (openFeeRate > 0.1 || closeFeeRate > 0.1) {
            throw new ProtocolParameterError(
              `Protocol invariant violation: unusually high fee rate for ${upper} (open=${openFeeRate}, close=${closeFeeRate})`,
            );
          }

          const rates: ProtocolFeeRates = {
            openFeeRate,
            closeFeeRate,
            maintenanceMarginRate,
            maxLeverage,
            source: 'on-chain',
          };

          const cacheSlot = lastKnownSlot > 0 ? lastKnownSlot : 0;
          feeCache.set(upper, { rates, cachedAtSlot: cacheSlot });

          // Bound cache size
          if (feeCache.size > 50) {
            const oldest = feeCache.keys().next().value;
            if (oldest) feeCache.delete(oldest);
          }

          return rates;
        }
      }
    } catch (err) {
      // Protocol parameter errors must not be silently swallowed
      if (err instanceof ProtocolParameterError) throw err;

      // Network/RPC failure — return stale cached on-chain data if available
      const stale = feeCache.get(upper);
      if (stale && stale.rates.source === 'on-chain') {
        try {
          const { getLogger } = await import('../utils/logger.js');
          getLogger().warn(
            'FEES',
            `RPC fetch failed for ${upper}, using cached on-chain rates (slot ${stale.cachedAtSlot}): ${err instanceof Error ? err.message : 'unknown'}`,
          );
        } catch {
          /* logger not available — continue silently */
        }
        return stale.rates;
      }

      // No cached on-chain data — fall through to SDK defaults with warning
      try {
        const { getLogger } = await import('../utils/logger.js');
        getLogger().warn(
          'FEES',
          `RPC fetch failed for ${upper}, using SDK defaults: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      } catch {
        /* logger not available — continue silently */
      }
    }
  }

  // No perpClient available (simulation mode) or RPC fetch failed — use conservative defaults
  // clearly marked as non-authoritative
  const defaultRates: ProtocolFeeRates = {
    openFeeRate: 0.0008,
    closeFeeRate: 0.0008,
    maintenanceMarginRate: 0.01,
    maxLeverage: 100,
    source: 'sdk-default',
  };
  feeCache.set(upper, { rates: defaultRates, cachedAtSlot: 0 });
  return defaultRates;
}

/**
 * Calculate fee in USD for a given position size and fee rate.
 */
export function calcFeeUsd(sizeUsd: number, feeRate: number): number {
  if (!Number.isFinite(sizeUsd) || !Number.isFinite(feeRate) || sizeUsd <= 0 || feeRate <= 0) {
    return 0;
  }
  return sizeUsd * feeRate;
}

/**
 * Sweep expired entries from the fee cache.
 * Called by the maintenance module to prevent stale entries from accumulating.
 */
export function sweepExpiredCache(): void {
  if (feeCache.size === 0) return;
  const now = Date.now();
  // If we have no slot info, use time-based expiry
  for (const [key, entry] of feeCache) {
    if (entry.cachedAtSlot === 0 && lastSlotFetchTime > 0 && now - lastSlotFetchTime > FALLBACK_TTL_MS * 2) {
      feeCache.delete(key);
    }
  }
}

/** RATE_POWER and BPS_POWER exported for direct CustodyAccount parsing */
export { RATE_POWER, BPS_POWER };
