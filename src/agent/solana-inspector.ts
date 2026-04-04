import {
  IFlashClient,
  IDataClient,
  MarketData,
  Position,
  Portfolio,
  OpenInterestData,
  VolumeData,
  OverviewStats,
  RawActivityRecord,
} from '../types/index.js';
import { PriceService } from '../data/prices.js';
import { getLogger } from '../utils/logger.js';

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const MARKET_CACHE_TTL = 30_000; // 30s for market data
const ANALYTICS_CACHE_TTL = 60_000; // 60s for analytics
const MAX_CACHE_ENTRIES = 50; // Prevent unbounded cache growth

/**
 * Cached data aggregator wrapping FlashClient + FStatsClient + PriceService.
 * Provides graceful degradation when data sources fail.
 */
export class SolanaInspector {
  private flashClient: IFlashClient;
  private dataClient: IDataClient;
  private priceService: PriceService;

  private cache = new Map<string, CacheEntry<unknown>>();

  constructor(flashClient: IFlashClient, dataClient: IDataClient) {
    this.flashClient = flashClient;
    this.dataClient = dataClient;
    this.priceService = new PriceService();
  }

  private getCached<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (entry) {
      if (entry.expiry > Date.now()) {
        return entry.data as T;
      }
      // Clean up expired entry
      this.cache.delete(key);
    }
    return null;
  }

  private setCache<T>(key: string, data: T, ttl: number): void {
    // Evict expired entries if cache grows too large
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      const now = Date.now();
      for (const [k, entry] of this.cache) {
        if (entry.expiry <= now) this.cache.delete(k);
      }
      // If still too large after eviction, remove oldest entries
      if (this.cache.size > MAX_CACHE_ENTRIES) {
        const toRemove = this.cache.size - MAX_CACHE_ENTRIES;
        const keys = Array.from(this.cache.keys());
        for (let i = 0; i < toRemove; i++) {
          this.cache.delete(keys[i]);
        }
      }
    }
    this.cache.set(key, { data, expiry: Date.now() + ttl });
  }

  async getMarkets(market?: string): Promise<MarketData[]> {
    const cacheKey = `markets:${market ?? 'all'}`;
    const cached = this.getCached<MarketData[]>(cacheKey);
    if (cached) return cached;

    try {
      const data = await this.flashClient.getMarketData(market);

      // Enrich with fstats OI data when FlashClient returns zeros
      // (Pyth doesn't provide OI — fstats does)
      try {
        const oi = await this.dataClient.getOpenInterest();
        for (const m of data) {
          if (m.openInterestLong === 0 && m.openInterestShort === 0) {
            const oiEntry = oi.markets.find((o) => o.market.toUpperCase() === m.symbol.toUpperCase());
            if (oiEntry) {
              m.openInterestLong = oiEntry.longOi;
              m.openInterestShort = oiEntry.shortOi;
            }
          }
        }
      } catch {
        // OI enrichment is best-effort — market data still valid without it
      }

      // Enrich with 24h price change from Pyth Hermes
      // (FlashClient.getMarketData() returns priceChange24h: 0)
      try {
        const symbols = data.map((m) => m.symbol);
        const pythPrices = await this.priceService.getPrices(symbols);
        for (const m of data) {
          if (m.priceChange24h === 0) {
            const tp = pythPrices.get(m.symbol);
            if (tp && Number.isFinite(tp.priceChange24h)) {
              m.priceChange24h = tp.priceChange24h;
            }
          }
        }
      } catch {
        // priceChange24h enrichment is best-effort
      }

      this.setCache(cacheKey, data, MARKET_CACHE_TTL);
      return data;
    } catch {
      getLogger().warn('INSPECTOR', 'Failed to fetch market data');
      return [];
    }
  }

  async getPositions(): Promise<Position[]> {
    const cached = this.getCached<Position[]>('positions');
    if (cached) return cached;

    try {
      const data = await this.flashClient.getPositions();
      this.setCache('positions', data, MARKET_CACHE_TTL);
      return data;
    } catch {
      getLogger().warn('INSPECTOR', 'Failed to fetch positions');
      return [];
    }
  }

  async getPortfolio(): Promise<Portfolio> {
    const cached = this.getCached<Portfolio>('portfolio');
    if (cached) return cached;

    try {
      const data = await this.flashClient.getPortfolio();
      this.setCache('portfolio', data, MARKET_CACHE_TTL);
      return data;
    } catch {
      getLogger().warn('INSPECTOR', 'Failed to fetch portfolio');
      return {
        walletAddress: 'unknown',
        balance: 0,
        balanceLabel: '$0.00',
        totalCollateralUsd: 0,
        totalUnrealizedPnl: 0,
        totalRealizedPnl: 0,
        totalFees: 0,
        positions: [],
        totalPositionValue: 0,
      };
    }
  }

  async getOpenInterest(): Promise<OpenInterestData> {
    const cached = this.getCached<OpenInterestData>('openInterest');
    if (cached) return cached;

    try {
      const data = await this.dataClient.getOpenInterest();
      this.setCache('openInterest', data, ANALYTICS_CACHE_TTL);
      return data;
    } catch {
      getLogger().warn('INSPECTOR', 'Failed to fetch open interest');
      return { markets: [] };
    }
  }

  async getVolume(): Promise<VolumeData> {
    const cached = this.getCached<VolumeData>('volume');
    if (cached) return cached;

    try {
      const data = await this.dataClient.getVolume();
      this.setCache('volume', data, ANALYTICS_CACHE_TTL);
      return data;
    } catch {
      getLogger().warn('INSPECTOR', 'Failed to fetch volume');
      return { period: '30d', totalVolumeUsd: 0, trades: 0, uniqueTraders: 0, dailyVolumes: [] };
    }
  }

  async getOverviewStats(): Promise<OverviewStats> {
    const cached = this.getCached<OverviewStats>('overviewStats');
    if (cached) return cached;

    try {
      const data = await this.dataClient.getOverviewStats();
      this.setCache('overviewStats', data, ANALYTICS_CACHE_TTL);
      return data;
    } catch {
      getLogger().warn('INSPECTOR', 'Failed to fetch overview stats');
      return {
        volumeUsd: 0,
        volumeChangePct: 0,
        trades: 0,
        tradesChangePct: 0,
        feesUsd: 0,
        poolPnlUsd: 0,
        poolRevenueUsd: 0,
        uniqueTraders: 0,
      };
    }
  }

  async getRecentActivity(limit = 20): Promise<RawActivityRecord[]> {
    const cacheKey = `recentActivity:limit=${limit}`;
    const cached = this.getCached<RawActivityRecord[]>(cacheKey);
    if (cached) return cached;

    try {
      if (this.dataClient.getRecentActivity) {
        const data = await this.dataClient.getRecentActivity(limit);
        this.setCache(cacheKey, data, ANALYTICS_CACHE_TTL);
        return data;
      }
      return [];
    } catch {
      getLogger().warn('INSPECTOR', 'Failed to fetch recent activity');
      return [];
    }
  }

  async getOpenPositions(): Promise<RawActivityRecord[]> {
    const cached = this.getCached<RawActivityRecord[]>('openPositions');
    if (cached) return cached;

    try {
      if (this.dataClient.getOpenPositions) {
        const data = await this.dataClient.getOpenPositions();
        this.setCache('openPositions', data, ANALYTICS_CACHE_TTL);
        return data;
      }
      return [];
    } catch {
      getLogger().warn('INSPECTOR', 'Failed to fetch open positions');
      return [];
    }
  }

  /**
   * Fetch all data sources in parallel with graceful degradation.
   */
  async getFullSnapshot(): Promise<{
    markets: MarketData[];
    positions: Position[];
    portfolio: Portfolio;
    openInterest: OpenInterestData;
    volume: VolumeData;
    overviewStats: OverviewStats;
  }> {
    const results = await Promise.allSettled([
      this.getMarkets(),
      this.getPositions(),
      this.getPortfolio(),
      this.getOpenInterest(),
      this.getVolume(),
      this.getOverviewStats(),
    ]);

    return {
      markets: results[0].status === 'fulfilled' ? results[0].value : [],
      positions: results[1].status === 'fulfilled' ? results[1].value : [],
      portfolio:
        results[2].status === 'fulfilled'
          ? results[2].value
          : {
              walletAddress: 'unknown',
              balance: 0,
              balanceLabel: '$0.00',
              totalCollateralUsd: 0,
              totalUnrealizedPnl: 0,
              totalRealizedPnl: 0,
              totalFees: 0,
              positions: [],
              totalPositionValue: 0,
            },
      openInterest: results[3].status === 'fulfilled' ? results[3].value : { markets: [] },
      volume:
        results[4].status === 'fulfilled'
          ? results[4].value
          : {
              period: '30d',
              totalVolumeUsd: 0,
              trades: 0,
              uniqueTraders: 0,
              dailyVolumes: [],
            },
      overviewStats:
        results[5].status === 'fulfilled'
          ? results[5].value
          : {
              volumeUsd: 0,
              volumeChangePct: 0,
              trades: 0,
              tradesChangePct: 0,
              feesUsd: 0,
              poolPnlUsd: 0,
              poolRevenueUsd: 0,
              uniqueTraders: 0,
            },
    };
  }
}
