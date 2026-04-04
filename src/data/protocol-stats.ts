/**
 * ProtocolStatsService — Single source of truth for protocol statistics.
 *
 * All commands that display protocol metrics (dashboard, protocol health,
 * protocol status, inspect protocol, doctor) MUST read from this service
 * to guarantee consistent counts across the CLI.
 *
 * Design:
 *   - Singleton instance, lazily initialized
 *   - Caches stats for 15 seconds (same as protocol-inspector)
 *   - Thread-safe refresh (deduplicates concurrent fetches)
 *   - Falls back to stale cache on API failure
 */

import type { IDataClient } from '../types/index.js';
import { POOL_MARKETS, isTradeablePool } from '../config/index.js';
import { PROTOCOL_CACHE_TTL_MS } from '../core/risk-config.js';

const CACHE_TTL_MS = PROTOCOL_CACHE_TTL_MS;

export interface ProtocolStats {
  /** All markets registered across pools (includes coming soon) */
  totalMarkets: number;
  /** Markets where the SDK can actually execute trades */
  activeMarkets: number;
  /** Markets currently holding open interest */
  marketsWithOI: number;
  /** Markets listed but not yet tradeable */
  marketsComingSoon: number;
  /** Total open interest (long + short) across all markets */
  totalOpenInterest: number;
  /** Total long OI */
  totalLongOI: number;
  /** Total short OI */
  totalShortOI: number;
  /** Long percentage (0-100) */
  longPct: number;
  /** Short percentage (0-100) */
  shortPct: number;
  /** 30d volume from fstats */
  volume30d: number;
  /** 30d unique traders */
  traders30d: number;
  /** 30d trade count */
  trades30d: number;
  /** 30d fees collected */
  fees30d: number;
  /** Markets sorted by OI descending */
  marketsByOI: { market: string; longOi: number; shortOi: number; total: number }[];
  /** Timestamp when stats were fetched */
  fetchedAt: number;
}

let _instance: ProtocolStatsService | null = null;

export function getProtocolStatsService(fstats: IDataClient): ProtocolStatsService {
  if (!_instance) {
    _instance = new ProtocolStatsService(fstats);
  }
  return _instance;
}

export class ProtocolStatsService {
  private fstats: IDataClient;
  private cache: ProtocolStats | null = null;
  private inflight: Promise<ProtocolStats> | null = null;

  constructor(fstats: IDataClient) {
    this.fstats = fstats;
  }

  /** Get cached stats or refresh if stale. */
  async getStats(): Promise<ProtocolStats> {
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache;
    }
    // Deduplicate concurrent fetches
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  /** How many seconds ago the data was fetched */
  getDataAge(): number {
    if (!this.cache) return -1;
    return Math.round((Date.now() - this.cache.fetchedAt) / 1000);
  }

  private async refresh(): Promise<ProtocolStats> {
    try {
      const [oiData, overviewStats] = await Promise.all([
        this.fstats.getOpenInterest(),
        this.fstats.getOverviewStats('30d'),
      ]);

      // Count market categories
      const allMarkets = new Set(
        Object.values(POOL_MARKETS)
          .flat()
          .map((m) => m.toUpperCase()),
      );
      const tradeableMarkets = new Set<string>();
      for (const [pool, markets] of Object.entries(POOL_MARKETS)) {
        if (isTradeablePool(pool)) {
          for (const m of markets) tradeableMarkets.add(m.toUpperCase());
        }
      }

      // OI aggregation
      let totalLongOI = 0;
      let totalShortOI = 0;
      const oiMarkets = new Set<string>();
      const marketsByOI: ProtocolStats['marketsByOI'] = [];

      for (const m of oiData.markets) {
        const longOi = m.longOi ?? 0;
        const shortOi = m.shortOi ?? 0;
        const total = longOi + shortOi;
        totalLongOI += longOi;
        totalShortOI += shortOi;
        if (total > 0) oiMarkets.add(m.market.toUpperCase());
        marketsByOI.push({ market: m.market, longOi, shortOi, total });
      }
      marketsByOI.sort((a, b) => b.total - a.total);

      const totalOI = totalLongOI + totalShortOI;

      const stats: ProtocolStats = {
        totalMarkets: allMarkets.size,
        activeMarkets: tradeableMarkets.size,
        marketsWithOI: oiMarkets.size,
        marketsComingSoon: allMarkets.size - tradeableMarkets.size,
        totalOpenInterest: totalOI,
        totalLongOI,
        totalShortOI,
        longPct: totalOI > 0 ? Math.round((totalLongOI / totalOI) * 100) : 50,
        shortPct: totalOI > 0 ? Math.round((totalShortOI / totalOI) * 100) : 50,
        volume30d: overviewStats?.volumeUsd ?? 0,
        traders30d: overviewStats?.uniqueTraders ?? 0,
        trades30d: overviewStats?.trades ?? 0,
        fees30d: overviewStats?.feesUsd ?? 0,
        marketsByOI,
        fetchedAt: Date.now(),
      };

      this.cache = stats;
      return stats;
    } catch {
      // Fall back to stale cache
      if (this.cache) return this.cache;
      // Return empty stats as last resort — cache it to prevent thundering herd
      // of retries when the API is down
      const fallback: ProtocolStats = {
        totalMarkets: 0,
        activeMarkets: 0,
        marketsWithOI: 0,
        marketsComingSoon: 0,
        totalOpenInterest: 0,
        totalLongOI: 0,
        totalShortOI: 0,
        longPct: 50,
        shortPct: 50,
        volume30d: 0,
        traders30d: 0,
        trades30d: 0,
        fees30d: 0,
        marketsByOI: [],
        fetchedAt: Date.now(),
      };
      this.cache = fallback;
      return fallback;
    }
  }
}
