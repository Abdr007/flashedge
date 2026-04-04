import {
  OverviewStats,
  VolumeData,
  DailyVolume,
  OpenInterestData,
  MarketOI,
  LeaderboardEntry,
  TraderProfile,
  FeeData,
  IDataClient,
  RawActivityRecord,
} from '../types/index.js';
import { FSTATS_BASE_URL, POOL_NAMES } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';
import { getServiceBreaker } from '../core/circuit-breaker-service.js';

/** Whitelist of valid pool names for API queries. Loaded from SDK config. */
const VALID_POOLS = new Set(POOL_NAMES);

const FETCH_TIMEOUT_MS = 10_000;

interface RawOverviewStats {
  volume_usd?: number;
  volume_change_pct?: number;
  trades?: number;
  trades_change_pct?: number;
  fees_usd?: number;
  pool_pnl_usd?: number;
  pool_revenue_usd?: number;
  unique_traders?: number;
}

interface RawDailyVolume {
  date: string;
  volume_usd?: number;
  trades?: number;
  long_volume?: number;
  short_volume?: number;
  liquidation_volume?: number;
}

interface RawMarketOI {
  market_symbol?: string;
  market?: string;
  long_oi?: number;
  long_open_interest?: number;
  short_oi?: number;
  short_open_interest?: number;
  long_positions?: number;
  short_positions?: number;
}

interface RawLeaderboardEntry {
  address?: string;
  owner?: string;
  pnl?: number;
  net_pnl?: number;
  gross_pnl?: number;
  volume?: number;
  total_volume?: number;
  total_volume_usd?: number;
  trades?: number;
  total_trades?: number;
  num_trades?: number;
  win_rate?: number;
  rank?: number;
}

interface RawTraderProfile {
  address?: string;
  total_trades?: number;
  total_volume?: number;
  total_pnl?: number;
  net_pnl?: number;
  win_rate?: number;
  markets?: Record<string, { trades: number; volume: number; pnl: number }>;
}

interface RawDailyFee {
  date: string;
  total_fees?: number;
  lp_share?: number;
  token_share?: number;
  team_share?: number;
}

// RawOpenPosition is now a subset of the exported RawActivityRecord type.
// We alias it here for backward compatibility with existing parsing logic.
type RawOpenPosition = RawActivityRecord;

/**
 * Safe fetch with timeout and JSON validation.
 * Returns null on failure instead of throwing.
 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB max response body

async function safeFetchJson<T>(path: string): Promise<T | null> {
  const cb = getServiceBreaker('fstats', { failureThreshold: 5, cooldownMs: 30_000, maxCooldownMs: 120_000, cooldownMultiplier: 2 });
  if (!cb.allowRequest()) {
    return null; // Circuit open — skip
  }

  const url = `${FSTATS_BASE_URL}${path}`;
  const logger = getLogger();
  logger.api(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      if (res.status === 429) {
        // Exponential backoff on rate limit
        const retryAfter = parseInt(res.headers.get('retry-after') ?? '0', 10);
        const delay = retryAfter > 0 ? retryAfter * 1000 : 2000;
        logger.info('ANALYTICS', `fstats rate limited (429), backing off ${delay}ms for ${path}`);
        await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 8000)));
        // Single retry after backoff
        try {
          const retryRes = await fetch(url, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { Accept: 'application/json' },
          });
          if (retryRes.ok) {
            const retryText = await retryRes.text();
            if (retryText.length <= MAX_RESPONSE_BYTES) {
              return JSON.parse(retryText) as T;
            }
          }
        } catch {
          // Retry failed — fall through to return null
        }
      }
      cb.recordFailure();
      logger.info('ANALYTICS', `fstats ${res.status}: ${res.statusText} for ${path}`);
      return null;
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
      logger.info('ANALYTICS', `fstats returned non-JSON for ${path}: ${contentType}`);
      return null;
    }
    // Guard against oversized responses (OOM protection)
    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
      logger.info('ANALYTICS', `fstats response too large for ${path}: ${contentLength} bytes`);
      return null;
    }
    // Stream response body with incremental size check to prevent OOM
    // even when content-length header is missing or spoofed
    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        logger.info('ANALYTICS', `fstats response body too large for ${path}: ${text.length} bytes`);
        return null;
      }
      return JSON.parse(text) as T;
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        reader.cancel();
        logger.info(
          'ANALYTICS',
          `fstats response body too large for ${path}: >${MAX_RESPONSE_BYTES} bytes (streaming abort)`,
        );
        return null;
      }
      chunks.push(value);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    const result = JSON.parse(text) as T;
    cb.recordSuccess();
    return result;
  } catch (error: unknown) {
    cb.recordFailure();
    logger.info('ANALYTICS', `fstats fetch failed for ${path}: ${getErrorMessage(error)}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Safely extract an array from an API response.
 * Handles cases where API returns an object with a data field, or a non-array.
 */
function safeArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    // Handle common API wrapper patterns: { data: [...] }, { markets: [...] }, etc.
    for (const key of ['data', 'markets', 'items', 'results', 'entries', 'leaderboard']) {
      if (key in obj && Array.isArray(obj[key])) return obj[key] as T[];
    }
  }
  return [];
}

export class FStatsClient implements IDataClient {
  async getOverviewStats(period: '7d' | '30d' | 'all' = '30d'): Promise<OverviewStats> {
    const raw = await safeFetchJson<RawOverviewStats>(`/overview/stats?period=${encodeURIComponent(period)}`);
    return {
      volumeUsd: raw?.volume_usd ?? 0,
      volumeChangePct: raw?.volume_change_pct ?? 0,
      trades: raw?.trades ?? 0,
      tradesChangePct: raw?.trades_change_pct ?? 0,
      feesUsd: raw?.fees_usd ?? 0,
      poolPnlUsd: raw?.pool_pnl_usd ?? 0,
      poolRevenueUsd: raw?.pool_revenue_usd ?? 0,
      uniqueTraders: raw?.unique_traders ?? 0,
    };
  }

  async getRecentActivity(limit = 20): Promise<RawOpenPosition[]> {
    limit = Math.max(1, Math.min(limit, 100));
    const raw = await safeFetchJson<unknown>(`/overview/activity?limit=${encodeURIComponent(String(limit))}`);
    return safeArray<RawOpenPosition>(raw);
  }

  async getVolume(days = 30, pool?: string): Promise<VolumeData> {
    days = Math.max(1, Math.min(days, 365));
    if (pool && !VALID_POOLS.has(pool)) {
      const logger = getLogger();
      logger.warn('ANALYTICS', `Invalid pool parameter rejected: "${pool}"`);
      pool = undefined; // Fall back to all pools
    }
    const poolParam = pool ? `&pool=${encodeURIComponent(pool)}` : '';
    const raw = await safeFetchJson<unknown>(`/volume/daily?days=${encodeURIComponent(String(days))}${poolParam}`);
    const daily = safeArray<RawDailyVolume>(raw);
    const dailyVolumes: DailyVolume[] = daily.map((d) => ({
      date: d.date ?? '',
      volumeUsd: d.volume_usd ?? 0,
      trades: d.trades ?? 0,
      longVolume: d.long_volume ?? 0,
      shortVolume: d.short_volume ?? 0,
      liquidationVolume: d.liquidation_volume ?? 0,
    }));
    const totalVolumeUsd = dailyVolumes.reduce((sum, d) => sum + d.volumeUsd, 0);
    const totalTrades = dailyVolumes.reduce((sum, d) => sum + d.trades, 0);
    return {
      period: `${days}d`,
      totalVolumeUsd,
      trades: totalTrades,
      uniqueTraders: 0,
      dailyVolumes,
    };
  }

  async getOpenInterest(): Promise<OpenInterestData> {
    const raw = await safeFetchJson<unknown>('/positions/open-interest');
    const entries = safeArray<RawMarketOI>(raw);
    const markets: MarketOI[] = entries.map((m) => ({
      market: m.market_symbol ?? m.market ?? '',
      longOi: m.long_oi ?? m.long_open_interest ?? 0,
      shortOi: m.short_oi ?? m.short_open_interest ?? 0,
      longPositions: m.long_positions ?? 0,
      shortPositions: m.short_positions ?? 0,
    }));
    return { markets };
  }

  async getOpenPositions(): Promise<RawOpenPosition[]> {
    const raw = await safeFetchJson<unknown>('/positions/open');
    return safeArray<RawOpenPosition>(raw);
  }

  async getFees(days = 30): Promise<FeeData> {
    days = Math.max(1, Math.min(days, 365));
    const raw = await safeFetchJson<unknown>(`/fees/daily?days=${encodeURIComponent(String(days))}`);
    const daily = safeArray<RawDailyFee>(raw);
    const dailyFees = daily.map((d) => ({
      date: d.date ?? '',
      totalFees: d.total_fees ?? 0,
    }));
    const totalFees = dailyFees.reduce((sum, d) => sum + d.totalFees, 0);
    const lastEntry = daily[daily.length - 1];
    return {
      period: `${days}d`,
      totalFees,
      lpShare: lastEntry?.lp_share ?? 0,
      tokenShare: lastEntry?.token_share ?? 0,
      teamShare: lastEntry?.team_share ?? 0,
      dailyFees,
    };
  }

  async getLeaderboard(metric: 'pnl' | 'volume' = 'pnl', days = 30, limit = 10): Promise<LeaderboardEntry[]> {
    // Clamp parameters to prevent abuse via unbounded query params
    days = Math.max(1, Math.min(days, 365));
    limit = Math.max(1, Math.min(limit, 100));
    const raw = await safeFetchJson<unknown>(
      `/leaderboards/${encodeURIComponent(metric)}?days=${encodeURIComponent(String(days))}&limit=${encodeURIComponent(String(limit))}`,
    );
    const entries = safeArray<RawLeaderboardEntry>(raw);
    return entries.map((entry, i) => ({
      rank: entry.rank ?? i + 1,
      address: entry.address ?? entry.owner ?? '',
      pnl: entry.pnl ?? entry.net_pnl ?? 0,
      volume: entry.volume ?? entry.total_volume ?? entry.total_volume_usd ?? 0,
      trades: entry.trades ?? entry.total_trades ?? entry.num_trades ?? 0,
      winRate: entry.win_rate ?? 0,
    }));
  }

  async getTraderProfile(address: string): Promise<TraderProfile> {
    const raw = await safeFetchJson<RawTraderProfile>(`/traders/${encodeURIComponent(address)}`);
    return {
      address: raw?.address ?? address,
      totalTrades: raw?.total_trades ?? 0,
      totalVolume: raw?.total_volume ?? 0,
      totalPnl: raw?.total_pnl ?? raw?.net_pnl ?? 0,
      winRate: raw?.win_rate ?? 0,
      markets: raw?.markets ?? {},
    };
  }
}
