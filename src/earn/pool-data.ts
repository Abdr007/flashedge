/**
 * Pool Live Data
 *
 * Primary source: Flash Trade official API (api.prod.flash.trade/earn-page/data)
 * - Pre-calculated APY/APR per pool (matches Flash Trade Earn page exactly)
 * - FLP/sFLP prices, AUM
 *
 * Secondary source: fstats.io /pools
 * - Total volume, total fees, total trades (not in official API)
 *
 * Fallback: fstats.io /fees/daily + /volume/daily (volume-weighted fee APY)
 * - Used only when official API is unavailable
 */

import { Connection } from '@solana/web3.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getPoolRegistry } from './pool-registry.js';
import { FSTATS_BASE_URL } from '../config/index.js';
import { getLogger } from '../utils/logger.js';

const FLASH_EARN_API = 'https://api.prod.flash.trade/earn-page/data';

// ─── Flash Trade Official API Types ─────────────────────────────────────────

interface FlashEarnPool {
  poolAddress: string;
  aum: string;
  flpTokenSymbol: string;
  sflpTokenSymbol: string;
  flpDailyApy: number | null;
  flpWeeklyApy: number | null;
  sflpWeeklyApr: number | null;
  sflpDailyApr: number | null;
  flpPrice: string;
  sFlpPrice: string;
}

interface FlashEarnResponse {
  pools: FlashEarnPool[];
  lastUpdated: number;
}

// ─── FLP Price Snapshots ─────────────────────────────────────────────────────
// Store FLP prices over time to compute APY from actual price growth.
// FLP price compounds ALL revenue (trading fees, borrow fees, liquidation PnL).

interface FlpSnapshot {
  timestamp: number;
  prices: Record<string, number>; // poolId → flpPrice
}

const SNAPSHOT_FILE = join(homedir(), '.flash', 'flp-snapshots.json');
const SNAPSHOT_INTERVAL_MS = 3600_000; // Save at most once per hour
const MAX_SNAPSHOTS = 168; // 7 days of hourly snapshots

function loadSnapshots(): FlpSnapshot[] {
  try {
    if (!existsSync(SNAPSHOT_FILE)) return [];
    const data = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveSnapshots(snapshots: FlpSnapshot[]): void {
  try {
    const dir = join(homedir(), '.flash');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshots), { mode: 0o600 });
  } catch {
    /* non-critical */
  }
}

function recordFlpPrices(prices: Record<string, number>): void {
  const snapshots = loadSnapshots();
  const now = Date.now();

  // Don't save more than once per hour
  if (snapshots.length > 0 && now - snapshots[snapshots.length - 1].timestamp < SNAPSHOT_INTERVAL_MS) {
    return;
  }

  snapshots.push({ timestamp: now, prices });

  // Keep only the last MAX_SNAPSHOTS entries
  while (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();

  saveSnapshots(snapshots);
}

const MAX_APY = 1000; // Cap APY — anything higher is unreliable data

const CACHE_TTL_MS = 30_000;

export interface PoolMetrics {
  poolId: string;
  tvl: number;
  apy7d: number;
  apr7d: number;
  flpPrice: number;
  sflpPrice: number;
  totalVolume: number;
  totalFees: number;
  totalTrades: number;
  feeShareLp: number;
  weeklyLpFees: number;
  /** FLP daily APY (compounding) — from official API */
  flpDailyApy: number;
  /** sFLP daily APR (non-compounding) — from official API */
  sflpDailyApr: number;
  /** sFLP weekly APR (non-compounding) — from official API */
  sflpWeeklyApr: number;
}

interface CachedMetrics {
  data: Map<string, PoolMetrics>;
  fetchedAt: number;
}

let _cache: CachedMetrics | null = null;
let _rpcConnection: Connection | null = null;

/** Set the RPC connection for on-chain queries. */
export function setPoolDataConnection(conn: Connection): void {
  _rpcConnection = conn;
}

/** Fetch official APY/price data from Flash Trade API. */
async function fetchOfficialEarnData(logger: ReturnType<typeof getLogger>): Promise<Map<string, FlashEarnPool> | null> {
  try {
    const res = await fetch(FLASH_EARN_API, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const json = (await res.json()) as FlashEarnResponse;
    if (!json.pools || !Array.isArray(json.pools)) return null;

    const map = new Map<string, FlashEarnPool>();
    for (const p of json.pools) {
      if (p.flpTokenSymbol) map.set(p.flpTokenSymbol, p);
    }
    logger.debug('EARN', `Official API: ${map.size} pools loaded`);
    return map;
  } catch {
    logger.debug('EARN', 'Official Flash Trade earn API unavailable');
    return null;
  }
}

/** Fetch supplementary data (volume, fees, trades) from fstats. */
async function fetchFstatsPoolData(logger: ReturnType<typeof getLogger>): Promise<
  Record<string, { flp: number; sflp: number; vol: number; fees: number; trades: number; lpShare: number }>
> {
  const poolPrices: Record<
    string,
    { flp: number; sflp: number; vol: number; fees: number; trades: number; lpShare: number }
  > = {};
  try {
    const res = await fetch(`${FSTATS_BASE_URL}/pools`, { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const json = (await res.json()) as {
        pools?: Array<{
          name?: string;
          lp_price_compounding?: number;
          lp_price_regular?: number;
          total_volume_usd?: number;
          total_fees_usd?: number;
          total_trades?: number;
          fee_split?: { lp?: number };
        }>;
      };
      if (json.pools) {
        for (const p of json.pools) {
          if (!p.name || p.name.startsWith('Remora')) continue;
          poolPrices[p.name] = {
            flp: p.lp_price_compounding ?? 0,
            sflp: p.lp_price_regular ?? 0,
            vol: p.total_volume_usd ?? 0,
            fees: p.total_fees_usd ?? 0,
            trades: p.total_trades ?? 0,
            lpShare: p.fee_split?.lp ?? 70,
          };
        }
      }
    }
  } catch {
    logger.debug('EARN', 'fstats /pools unavailable');
  }
  return poolPrices;
}

/** Fallback: compute APY from fstats fee distribution when official API is down. */
async function computeFallbackApy(
  registry: ReturnType<typeof getPoolRegistry>,
  poolPrices: Record<string, { vol: number; fees: number }>,
  tvlByPool: Record<string, number>,
  logger: ReturnType<typeof getLogger>,
): Promise<Record<string, number>> {
  const weeklyFeesByPool: Record<string, number> = {};
  try {
    let protocolWeeklyLpFees = 0;
    const feesRes = await fetch(`${FSTATS_BASE_URL}/fees/daily?days=7`, { signal: AbortSignal.timeout(5000) });
    if (feesRes.ok) {
      const feesJson = (await feesRes.json()) as { data?: Array<{ lp_share?: number }> } | Array<{ lp_share?: number }>;
      const feesDays = Array.isArray(feesJson) ? feesJson : (feesJson.data ?? []);
      protocolWeeklyLpFees = feesDays.reduce((sum, d) => sum + (d.lp_share ?? 0), 0);
    }

    if (protocolWeeklyLpFees > 0) {
      const poolVolumes: Record<string, number> = {};
      let totalWeeklyVolume = 0;

      await Promise.all(
        registry.map(async (pool) => {
          try {
            const res = await fetch(`${FSTATS_BASE_URL}/volume/daily?days=7&pool=${encodeURIComponent(pool.poolId)}`, {
              signal: AbortSignal.timeout(4000),
            });
            if (!res.ok) return;
            const json = (await res.json()) as
              | { data?: Array<{ volume_usd?: number }> }
              | Array<{ volume_usd?: number }>;
            const days = Array.isArray(json) ? json : (json.data ?? []);
            const vol = days.reduce((sum, d) => sum + (d.volume_usd ?? 0), 0);
            if (vol > 0) {
              poolVolumes[pool.poolId] = vol;
              totalWeeklyVolume += vol;
            }
          } catch {
            /* non-critical */
          }
        }),
      );

      if (totalWeeklyVolume > 0) {
        const weights: Record<string, number> = {};
        let totalWeight = 0;
        for (const pool of registry) {
          const vol = poolVolumes[pool.poolId] ?? 0;
          if (vol <= 0) continue;
          const prices = poolPrices[pool.poolId];
          const feeRate = (prices?.vol ?? 0) > 0 && (prices?.fees ?? 0) > 0 ? prices.fees / prices.vol : 0.0007;
          const w = vol * feeRate;
          weights[pool.poolId] = w;
          totalWeight += w;
        }
        for (const pool of registry) {
          const w = weights[pool.poolId] ?? 0;
          if (w > 0 && totalWeight > 0) {
            const weeklyFees = protocolWeeklyLpFees * (w / totalWeight);
            const tvl = tvlByPool[pool.poolId] ?? 0;
            if (tvl > 0) {
              weeklyFeesByPool[pool.poolId] = Math.min((weeklyFees / tvl) * 52 * 100, MAX_APY);
            }
          }
        }
        logger.debug('EARN', `Fallback APY: protocol 7D LP fees $${protocolWeeklyLpFees.toFixed(0)}`);
      }
    }
  } catch {
    logger.debug('EARN', 'Fallback fee distribution failed');
  }
  return weeklyFeesByPool;
}

/** Fetch pool metrics with TVL and APY. */
export async function getPoolMetrics(): Promise<Map<string, PoolMetrics>> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.data;
  }

  const logger = getLogger();
  const metrics = new Map<string, PoolMetrics>();
  const registry = getPoolRegistry();

  // Step 1: Fetch official Flash Trade API + fstats in parallel
  const [officialData, fstatsData] = await Promise.all([
    fetchOfficialEarnData(logger),
    fetchFstatsPoolData(logger),
  ]);

  const hasOfficialData = officialData !== null && officialData.size > 0;

  // Step 2: Record FLP price snapshots (from whichever source is available)
  const currentFlpPrices: Record<string, number> = {};
  for (const pool of registry) {
    const official = officialData?.get(pool.flpSymbol);
    const flp = official ? parseFloat(official.flpPrice) : (fstatsData[pool.poolId]?.flp ?? 0);
    if (Number.isFinite(flp) && flp > 0) currentFlpPrices[pool.poolId] = flp;
  }
  recordFlpPrices(currentFlpPrices);

  // Step 3: Fetch TVL from RPC (only needed when official API has no AUM)
  const conn = _rpcConnection;
  const tvlByPool: Record<string, number> = {};
  if (conn && !hasOfficialData) {
    const supplyPromises = registry.map(async (pool) => {
      const flpPrice = fstatsData[pool.poolId]?.flp ?? 0;
      const sflpPrice = fstatsData[pool.poolId]?.sflp ?? 0;
      if (flpPrice <= 0) return;
      try {
        const [flpSupply, sflpSupply] = await Promise.all([
          conn.getTokenSupply(pool.flpMint).then((s) => s.value.uiAmount ?? 0).catch(() => 0),
          conn.getTokenSupply(pool.sflpMint).then((s) => s.value.uiAmount ?? 0).catch(() => 0),
        ]);
        tvlByPool[pool.poolId] = flpSupply * flpPrice + sflpSupply * sflpPrice;
      } catch {
        /* non-critical */
      }
    });
    await Promise.all(supplyPromises);
  }

  // Step 4: Compute fallback APY only if official API failed
  const fallbackApy = hasOfficialData ? {} : await computeFallbackApy(registry, fstatsData, tvlByPool, logger);

  // Step 5: Build metrics per pool
  for (const pool of registry) {
    const official = officialData?.get(pool.flpSymbol);
    const fstats = fstatsData[pool.poolId];

    // Prices: prefer official API, fallback to fstats
    const flpPrice = official ? parseFloat(official.flpPrice) || 0 : (fstats?.flp ?? 0);
    const sflpPrice = official ? parseFloat(official.sFlpPrice) || 0 : (fstats?.sflp ?? 0);

    // TVL: prefer official AUM, fallback to RPC-computed
    const tvl = official ? parseFloat(official.aum) || 0 : (tvlByPool[pool.poolId] ?? 0);

    // APY/APR: prefer official, fallback to fee-distribution estimate
    const flpWeeklyApy = official?.flpWeeklyApy ?? null;
    const sflpWeeklyApr = official?.sflpWeeklyApr ?? null;
    const apy7d = typeof flpWeeklyApy === 'number' && Number.isFinite(flpWeeklyApy)
      ? Math.min(flpWeeklyApy, MAX_APY)
      : (fallbackApy[pool.poolId] ?? 0);
    const apr7d = typeof sflpWeeklyApr === 'number' && Number.isFinite(sflpWeeklyApr)
      ? Math.min(sflpWeeklyApr, MAX_APY)
      : apy7d;

    const source = hasOfficialData ? 'official' : 'fallback';
    logger.debug('EARN', `${pool.poolId}: APY ${apy7d.toFixed(1)}% (${source})`);

    metrics.set(pool.poolId, {
      poolId: pool.poolId,
      tvl,
      apy7d: Math.round(apy7d * 100) / 100,
      apr7d: Math.round(apr7d * 100) / 100,
      flpPrice,
      sflpPrice,
      totalVolume: fstats?.vol ?? 0,
      totalFees: fstats?.fees ?? 0,
      totalTrades: fstats?.trades ?? 0,
      feeShareLp: fstats?.lpShare ?? pool.feeShare * 100,
      weeklyLpFees: 0, // no longer estimated; official APY is authoritative
      flpDailyApy: Number.isFinite(official?.flpDailyApy) ? (official?.flpDailyApy ?? 0) : 0,
      sflpDailyApr: Number.isFinite(official?.sflpDailyApr) ? (official?.sflpDailyApr ?? 0) : 0,
      sflpWeeklyApr: Number.isFinite(sflpWeeklyApr) ? (sflpWeeklyApr ?? 0) : 0,
    });
  }

  _cache = { data: metrics, fetchedAt: Date.now() };
  return metrics;
}

export async function getPoolMetric(poolId: string): Promise<PoolMetrics | null> {
  const all = await getPoolMetrics();
  return all.get(poolId) ?? null;
}

export function clearPoolMetricsCache(): void {
  _cache = null;
}
