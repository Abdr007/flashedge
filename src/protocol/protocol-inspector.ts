import { FStatsClient } from '../data/fstats.js';
import { FLASH_PROGRAM_ID, POOL_NAMES, POOL_MARKETS } from '../config/index.js';
import { formatUsd, formatPrice, shortAddress } from '../utils/format.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';
import { theme } from '../cli/theme.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProtocolSnapshot {
  pools: typeof POOL_NAMES;
  markets: Record<string, string[]>;
  openInterest: { market: string; longOi: number; shortOi: number }[];
  totalLiquidity: number;
  overviewStats: { volumeUsd: number; trades: number; uniqueTraders: number; feesUsd: number } | null;
  timestamp: number;
}

interface _MarketSnapshot {
  market: string;
  pool: string;
  price: number;
  longOi: number;
  shortOi: number;
  longPositions: number;
  shortPositions: number;
  whalePositions: { address: string; sizeUsd: number; side: string }[];
}

const CACHE_TTL_MS = 15_000;

// ─── Protocol Inspector ──────────────────────────────────────────────────────

export class ProtocolInspector {
  private fstats: FStatsClient;
  private cache: ProtocolSnapshot | null = null;

  constructor() {
    this.fstats = new FStatsClient();
  }

  // ─── Protocol Overview ─────────────────────────────────────────────

  async inspectProtocol(): Promise<string> {
    const snap = await this.getSnapshot();
    const lines: string[] = [
      theme.titleBlock('FLASH TRADE PROTOCOL STATE'),
      '',
      `  ${theme.section('Program ID')}`,
      theme.pair('Flash Program', theme.accent(FLASH_PROGRAM_ID)),
      '',
      `  ${theme.section('Pools')}`,
    ];

    const seenPools = new Set<string>();
    for (const pool of snap.pools) {
      if (seenPools.has(pool)) continue; // Skip duplicate pool entries
      seenPools.add(pool);
      const markets = snap.markets[pool];
      lines.push(`    ${theme.accent(pool)} ${theme.dim('→')} ${markets ? markets.join(', ') : 'N/A'}`);
    }

    // Market summary from ProtocolStatsService
    try {
      const { getProtocolStatsService } = await import('../data/protocol-stats.js');
      const pss = getProtocolStatsService(this.fstats);
      const pStats = await pss.getStats();
      lines.push('');
      lines.push(`  ${theme.section('Market Summary')}`);
      lines.push(theme.pair('Active Markets', pStats.activeMarkets.toString()));
      lines.push(theme.pair('Markets With OI', pStats.marketsWithOI.toString()));
      if (pStats.marketsComingSoon > 0) {
        lines.push(theme.pair('Coming Soon', pStats.marketsComingSoon.toString()));
      }
    } catch {
      /* non-critical */
    }

    // Overview stats
    if (snap.overviewStats) {
      lines.push('');
      lines.push(`  ${theme.section('Protocol Stats (30d)')}`);
      lines.push(theme.pair('Volume', formatUsd(snap.overviewStats.volumeUsd)));
      lines.push(theme.pair('Trades', snap.overviewStats.trades.toLocaleString()));
      lines.push(theme.pair('Traders', snap.overviewStats.uniqueTraders.toLocaleString()));
      lines.push(theme.pair('Fees', formatUsd(snap.overviewStats.feesUsd)));
    }

    // Open Interest
    if (snap.openInterest.length > 0) {
      lines.push('');
      lines.push(`  ${theme.section('Open Interest')}`);
      let totalLong = 0;
      let totalShort = 0;
      const sorted = [...snap.openInterest].sort((a, b) => b.longOi + b.shortOi - (a.longOi + a.shortOi));
      for (const m of sorted) {
        const total = m.longOi + m.shortOi;
        if (total <= 0) continue;
        totalLong += m.longOi;
        totalShort += m.shortOi;
        lines.push(`    ${m.market.padEnd(10)} ${formatUsd(total)}`);
      }
      const grandTotal = totalLong + totalShort;
      if (grandTotal > 0) {
        const longPct = ((totalLong / grandTotal) * 100).toFixed(0);
        const shortPct = ((totalShort / grandTotal) * 100).toFixed(0);
        lines.push('');
        lines.push(`  ${theme.section('Long/Short Ratio')}`);
        lines.push(`    ${theme.positive(longPct + '%')} / ${theme.negative(shortPct + '%')}`);
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  // ─── Pool Inspection ───────────────────────────────────────────────

  async inspectPool(poolName: string): Promise<string> {
    const matched = POOL_NAMES.find((p) => p.toLowerCase() === poolName.toLowerCase());
    if (!matched) {
      return theme.negative(`  Unknown pool: ${poolName}. Available: ${POOL_NAMES.join(', ')}`);
    }

    const snap = await this.getSnapshot();
    const markets = POOL_MARKETS[matched] ?? [];

    const lines: string[] = [
      theme.titleBlock(`POOL: ${matched}`),
      '',
      `  ${theme.section('Markets')}`,
      `    ${markets.join(', ')}`,
      '',
    ];

    // OI per market in this pool
    const poolOi = snap.openInterest.filter((m) => markets.some((mk) => mk.toUpperCase() === m.market.toUpperCase()));
    if (poolOi.length > 0) {
      lines.push(`  ${theme.section('Open Interest')}`);
      let poolLong = 0;
      let poolShort = 0;
      for (const m of poolOi) {
        const total = m.longOi + m.shortOi;
        poolLong += m.longOi;
        poolShort += m.shortOi;
        if (total > 0) {
          const lPct = ((m.longOi / total) * 100).toFixed(0);
          const sPct = ((m.shortOi / total) * 100).toFixed(0);
          lines.push(`    ${m.market.padEnd(10)} ${formatUsd(total).padEnd(12)} L:${lPct}% / S:${sPct}%`);
        }
      }
      const poolTotal = poolLong + poolShort;
      if (poolTotal > 0) {
        lines.push('');
        lines.push(
          `  ${theme.dim('Pool L/S:')} ${theme.positive(((poolLong / poolTotal) * 100).toFixed(0) + '%')} / ${theme.negative(((poolShort / poolTotal) * 100).toFixed(0) + '%')}`,
        );
      }
      lines.push('');
    }

    // Whale activity from recent positions
    try {
      const activity = await this.fstats.getRecentActivity(50);
      const poolWhales = activity
        .filter((a) => {
          const sym = (a.market_symbol ?? a.market ?? '').toUpperCase();
          return markets.some((mk) => mk.toUpperCase() === sym) && (a.size_usd ?? 0) >= 10_000;
        })
        .slice(0, 5);

      if (poolWhales.length > 0) {
        lines.push(`  ${theme.section('Recent Whale Activity')}`);
        for (const w of poolWhales) {
          const sym = (w.market_symbol ?? w.market ?? '?').toUpperCase();
          const side = (w.side ?? '?').toUpperCase();
          const size = w.size_usd ?? 0;
          lines.push(`    ${sym} ${side} ${formatUsd(size)}`);
        }
        lines.push('');
      }
    } catch {
      // Non-critical
    }

    return lines.join('\n');
  }

  // ─── Market Inspection ─────────────────────────────────────────────

  async inspectMarket(market: string): Promise<string> {
    const upper = market.toUpperCase();
    let pool = '';
    for (const [p, markets] of Object.entries(POOL_MARKETS)) {
      if (markets.some((m) => m.toUpperCase() === upper)) {
        pool = p;
        break;
      }
    }
    if (!pool) {
      return theme.negative(`  Market not found: ${market}. Use 'markets' to see available markets.`);
    }

    // Market status (virtual vs crypto)
    const { getMarketStatus, getNextSessionOpen, getScheduleDetails } = await import('../data/market-hours.js');
    const mktStatus = getMarketStatus(upper);

    const snap = await this.getSnapshot();
    const oi = snap.openInterest.find((m) => m.market.toUpperCase() === upper);

    let statusDisplay: string;
    if (!mktStatus.isVirtual) {
      statusDisplay = theme.positive('OPEN') + theme.dim(' (24/7)');
    } else if (mktStatus.isOpen) {
      statusDisplay = theme.positive('OPEN');
    } else {
      statusDisplay = theme.negative('CLOSED');
    }

    const lines: string[] = [
      theme.titleBlock(`${upper} MARKET STATE`),
      '',
      theme.pair('Pool', theme.accent(pool)),
      theme.pair('Oracle Source', theme.dim('Pyth')),
      theme.pair('Status', statusDisplay),
    ];

    if (mktStatus.isVirtual) {
      const details = getScheduleDetails(upper);
      if (details) {
        lines.push('');
        lines.push(`  ${theme.section('Trading Hours')}`);
        lines.push(`    ${details.sessionHours}`);
        if (details.dailyBreak) {
          lines.push(`    Daily Break: ${details.dailyBreak}`);
        }
      }

      if (!mktStatus.isOpen) {
        const nextOpen = getNextSessionOpen(upper);
        if (nextOpen) {
          lines.push('');
          lines.push(`  ${theme.section('Next Session')}`);
          lines.push(`    Opens at: ${theme.warning(nextOpen.toUTCString())}`);
        }
      }
    }

    if (oi) {
      const totalOi = oi.longOi + oi.shortOi;
      const lPct = totalOi > 0 ? ((oi.longOi / totalOi) * 100).toFixed(0) : '0';
      const sPct = totalOi > 0 ? ((oi.shortOi / totalOi) * 100).toFixed(0) : '0';
      lines.push('');
      lines.push(`  ${theme.section('Open Interest')}`);
      lines.push(theme.pair('Total', formatUsd(totalOi)));
      lines.push(theme.pair('Long', `${formatUsd(oi.longOi)} (${lPct}%)`));
      lines.push(theme.pair('Short', `${formatUsd(oi.shortOi)} (${sPct}%)`));
    }

    // Largest positions (whale data)
    try {
      const openPositions = await this.fstats.getOpenPositions();
      const marketPositions = openPositions
        .filter((p) => (p.market_symbol ?? p.market ?? '').toUpperCase() === upper)
        .sort((a, b) => (b.size_usd ?? 0) - (a.size_usd ?? 0))
        .slice(0, 5);

      if (marketPositions.length > 0) {
        lines.push('');
        lines.push(`  ${theme.section('Largest Positions')}`);
        for (let i = 0; i < marketPositions.length; i++) {
          const p = marketPositions[i];
          const addr = shortAddress(String(p.address ?? p.owner ?? 'unknown'));
          const side = (p.side ?? '?').toUpperCase();
          const size = p.size_usd ?? 0;
          const price = p.entry_price ?? p.mark_price ?? 0;
          lines.push(
            `    ${i + 1}. ${addr} — ${formatUsd(size)} ${side}${price > 0 ? ` @ ${formatPrice(price)}` : ''}`,
          );
        }
      }
    } catch {
      // Non-critical
    }

    lines.push('');
    return lines.join('\n');
  }

  // ─── Protocol Risk Metrics ─────────────────────────────────────────

  async inspectRiskMetrics(): Promise<string> {
    const snap = await this.getSnapshot();

    const lines: string[] = [theme.titleBlock('PROTOCOL RISK METRICS'), ''];

    // Markets by OI
    const sorted = [...snap.openInterest].sort((a, b) => b.longOi + b.shortOi - (a.longOi + a.shortOi));
    const active = sorted.filter((m) => m.longOi + m.shortOi > 0);

    if (active.length > 0) {
      lines.push(`  ${theme.section('Markets by Open Interest')}`);
      for (const m of active.slice(0, 10)) {
        lines.push(`    ${m.market.padEnd(10)} ${formatUsd(m.longOi + m.shortOi)}`);
      }
      lines.push('');
    }

    // Concentration risk
    const totalOi = active.reduce((s, m) => s + m.longOi + m.shortOi, 0);
    if (totalOi > 0 && active.length > 0) {
      const topMarketOi = active[0].longOi + active[0].shortOi;
      const concentrationPct = ((topMarketOi / totalOi) * 100).toFixed(1);
      lines.push(`  ${theme.section('Concentration')}`);
      lines.push(`    Largest market (${active[0].market}): ${concentrationPct}% of total OI`);
      lines.push(`    Total OI: ${formatUsd(totalOi)}`);
      lines.push('');
    }

    // Long/short imbalance
    const totalLong = active.reduce((s, m) => s + m.longOi, 0);
    const totalShort = active.reduce((s, m) => s + m.shortOi, 0);
    if (totalLong + totalShort > 0) {
      const ratio = totalLong / (totalLong + totalShort);
      const imbalance = Math.abs(ratio - 0.5) * 200; // 0% = balanced, 100% = all one side
      lines.push(`  ${theme.section('Directional Imbalance')}`);
      lines.push(`    Long: ${formatUsd(totalLong)}  Short: ${formatUsd(totalShort)}`);
      lines.push(`    Imbalance: ${imbalance.toFixed(1)}% ${ratio > 0.5 ? 'long-heavy' : 'short-heavy'}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  // ─── Data Fetching with Cache ──────────────────────────────────────

  private async getSnapshot(): Promise<ProtocolSnapshot> {
    if (this.cache && Date.now() - this.cache.timestamp < CACHE_TTL_MS) {
      return this.cache;
    }

    const logger = getLogger();

    let openInterest: ProtocolSnapshot['openInterest'] = [];
    let overviewStats: ProtocolSnapshot['overviewStats'] = null;
    let fetchFailed = false;

    try {
      const oiData = await this.fstats.getOpenInterest();
      openInterest = oiData.markets.map((m) => ({
        market: m.market,
        longOi: m.longOi,
        shortOi: m.shortOi,
      }));
    } catch (e: unknown) {
      logger.debug('PROTOCOL', `OI fetch failed: ${getErrorMessage(e)}`);
      fetchFailed = true;
    }

    try {
      const stats = await this.fstats.getOverviewStats('30d');
      overviewStats = {
        volumeUsd: stats.volumeUsd,
        trades: stats.trades,
        uniqueTraders: stats.uniqueTraders,
        feesUsd: stats.feesUsd,
      };
    } catch (e: unknown) {
      logger.debug('PROTOCOL', `Stats fetch failed: ${getErrorMessage(e)}`);
      fetchFailed = true;
    }

    // If both fetches failed and we have stale cache, return it rather than empty data
    if (fetchFailed && openInterest.length === 0 && !overviewStats && this.cache) {
      logger.debug('PROTOCOL', 'Using stale cache as fallback');
      return this.cache;
    }

    this.cache = {
      pools: POOL_NAMES,
      markets: POOL_MARKETS,
      openInterest,
      totalLiquidity: 0, // Would need on-chain pool data for accurate figure
      overviewStats,
      timestamp: Date.now(),
    };

    return this.cache;
  }
}
