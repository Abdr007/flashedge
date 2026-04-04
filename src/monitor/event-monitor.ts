/**
 * Event-Driven Monitoring Engine
 *
 * Professional market/position/liquidation/protocol monitoring with threshold-based
 * change detection. Only emits events when meaningful state changes occur.
 *
 * Data sources: Pyth Hermes (prices), fstats API (OI, whales), Flash SDK (positions),
 * Solana RPC (latency, slots). No synthetic signals.
 */

import chalk from 'chalk';
import { theme } from '../cli/theme.js';
import { formatUsd, formatPrice, formatPercent } from '../utils/format.js';
import { PriceService, TokenPrice } from '../data/prices.js';
import { FStatsClient } from '../data/fstats.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';
import { IFlashClient, Position, TradeSide, MarketOI, RawActivityRecord } from '../types/index.js';

// ─── Thresholds ──────────────────────────────────────────────────────────────

const PRICE_CHANGE_THRESHOLD_PCT = 0.5; // 0.5% price move
const OI_CHANGE_THRESHOLD_PCT = 5; // 5% OI change
const OI_CHANGE_THRESHOLD_USD = 10_000; // or $10k absolute
const FUNDING_FLIP_THRESHOLD = 0.001; // funding rate sign change threshold
const WHALE_SIZE_THRESHOLD_USD = 50_000; // $50k+ = whale position
const PNL_CHANGE_THRESHOLD_USD = 5; // $5 PnL change
const LIQ_DISTANCE_CHANGE_PCT = 2; // 2% liquidation distance change
const RPC_LATENCY_SPIKE_MS = 300; // 300ms = latency spike
const ORACLE_DELAY_THRESHOLD_S = 10; // 10s oracle lag

const POLL_INTERVAL_MS = 7_000; // 7 seconds between polls
const MAX_EVENTS_PER_CYCLE = 15; // prevent output flood

// ─── Event Types ─────────────────────────────────────────────────────────────

export type MonitorType = 'market' | 'position' | 'liquidations' | 'protocol';

interface MonitorEvent {
  type: 'price' | 'oi' | 'funding' | 'whale' | 'pnl' | 'liquidation' | 'rpc' | 'oracle' | 'info';
  severity: 'info' | 'warning' | 'critical';
  message: string;
}

// ─── State Snapshots ─────────────────────────────────────────────────────────

interface MarketSnapshot {
  price: number;
  totalOi: number;
  longOi: number;
  shortOi: number;
  fundingRate: number;
  timestamp: number;
}

interface PositionSnapshot {
  pnl: number;
  liqDistance: number; // 0..1
  collateralUsd: number;
  fundingAccumulated: number;
  markPrice: number;
}

interface ProtocolSnapshot {
  rpcLatencyMs: number;
  totalOi: number;
  oiByMarket: Map<string, number>;
  timestamp: number;
}

// ─── Monitor Engine ──────────────────────────────────────────────────────────

export class EventMonitor {
  private priceSvc = new PriceService();
  private fstats = new FStatsClient();
  private running = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  private refreshInProgress = false;

  // Previous state for delta detection
  private prevMarket: Map<string, MarketSnapshot> = new Map();
  private prevPosition: Map<string, PositionSnapshot> = new Map();
  private prevProtocol: ProtocolSnapshot | null = null;
  private knownWhaleKeys: Set<string> = new Set();

  // Cycle counter for periodic status
  private cycleCount = 0;

  constructor(
    private client: IFlashClient,
    private monitorType: MonitorType,
    private market?: string, // uppercase symbol for market/position/liquidation monitors
  ) {}

  async start(onExit: () => void): Promise<void> {
    this.running = true;
    this.cycleCount = 0;

    // Print header
    this.printHeader();

    // Initial data fetch + render (guarded against overlap with first interval tick)
    this.refreshInProgress = true;
    try {
      await this.tick();
    } catch (err) {
      getLogger().debug('MONITOR', `Initial tick failed: ${getErrorMessage(err)}`);
    } finally {
      this.refreshInProgress = false;
    }

    // Polling loop
    this.interval = setInterval(async () => {
      if (!this.running || this.refreshInProgress) return;
      this.refreshInProgress = true;
      try {
        await this.tick();
      } catch (err) {
        getLogger().debug('MONITOR', `Tick failed: ${getErrorMessage(err)}`);
      } finally {
        this.refreshInProgress = false;
      }
    }, POLL_INTERVAL_MS);
    if (this.interval.unref) this.interval.unref();

    // Keypress handler for exit
    await new Promise<void>((resolve) => {
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();

      const onKey = (data: Buffer) => {
        const key = data.toString();
        if (key === 'q' || key === 'Q' || key === '\x03') {
          // q or Ctrl+C
          stdin.removeListener('data', onKey);
          this.stop();

          // Drain remaining stdin bytes before restoring readline
          const drain = () => {
            /* discard */
          };
          stdin.on('data', drain);
          setTimeout(() => {
            stdin.removeListener('data', drain);
            if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
            resolve();
            onExit();
          }, 50);
        }
      };

      stdin.on('data', onKey);
    });
  }

  stop(): void {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    // Release all cached state to prevent memory leaks
    this.prevMarket.clear();
    this.prevPosition.clear();
    this.prevProtocol = null;
    this.knownWhaleKeys.clear();
  }

  // ─── Tick Dispatcher ─────────────────────────────────────────────────

  private async tick(): Promise<void> {
    // Skip ticks when system is in CRITICAL state — reduce load during resource pressure
    try {
      const { getHealth } = await import('../system/health.js');
      const health = getHealth();
      if (health?.state === 'CRITICAL') {
        return; // pause event monitoring entirely during CRITICAL
      }
    } catch { /* health not initialized */ }

    this.cycleCount++;
    const events: MonitorEvent[] = [];

    switch (this.monitorType) {
      case 'market':
        await this.tickMarket(events);
        break;
      case 'position':
        await this.tickPosition(events);
        break;
      case 'liquidations':
        await this.tickLiquidations(events);
        break;
      case 'protocol':
        await this.tickProtocol(events);
        break;
    }

    // Emit events
    if (events.length > 0) {
      const capped = events.slice(0, MAX_EVENTS_PER_CYCLE);
      for (const ev of capped) {
        this.printEvent(ev);
      }
    }

    // Periodic heartbeat — show we're still alive
    if (this.cycleCount % 9 === 0 && events.length === 0) {
      // ~63s
      const now = new Date().toLocaleTimeString();
      console.log(theme.dim(`  ${now}  No significant changes detected`));
    }
  }

  // ─── Market Monitor ──────────────────────────────────────────────────

  private async tickMarket(events: MonitorEvent[]): Promise<void> {
    const sym = this.market!;
    const [priceMap, oiData, whaleData] = await Promise.all([
      this.priceSvc.getPrices([sym]).catch(() => new Map<string, TokenPrice>()),
      this.fstats.getOpenInterest().catch(() => ({ markets: [] as MarketOI[] })),
      this.fstats.getOpenPositions().catch(() => [] as RawActivityRecord[]),
    ]);

    const tp = priceMap.get(sym);
    if (!tp) {
      if (this.cycleCount === 1) {
        events.push({ type: 'info', severity: 'warning', message: `No price data available for ${sym}` });
      }
      return;
    }

    // Aggregate OI across all pool entries matching this symbol
    // fstats may return multiple entries per symbol (one per pool), e.g. "SOL-PERP"
    let longOi = 0;
    let shortOi = 0;
    for (const m of oiData.markets) {
      if (m.market.toUpperCase().includes(sym)) {
        longOi += m.longOi ?? 0;
        shortOi += m.shortOi ?? 0;
      }
    }
    const totalOi = longOi + shortOi;

    // Get funding rate from client
    let fundingRate = 0;
    try {
      const markets = await this.client.getMarketData(sym);
      const md = markets.find((m) => m.symbol.toUpperCase() === sym);
      if (md) fundingRate = md.fundingRate;
    } catch {
      /* ignore */
    }

    const current: MarketSnapshot = {
      price: tp.price,
      totalOi,
      longOi,
      shortOi,
      fundingRate,
      timestamp: Date.now(),
    };

    const prev = this.prevMarket.get(sym);

    if (!prev) {
      // First tick — show current state summary
      events.push({
        type: 'info',
        severity: 'info',
        message: `${chalk.bold(sym)} at ${formatPrice(tp.price)}  OI: ${formatUsd(totalOi)}  Funding: ${formatPercent(fundingRate * 100)}`,
      });
      if (totalOi > 0) {
        const longPct = Math.round((longOi / totalOi) * 100);
        events.push({
          type: 'info',
          severity: 'info',
          message: `Long/Short: ${longPct}/${100 - longPct}`,
        });
      }
    } else {
      // ── Price Movement ──
      if (prev.price > 0) {
        const pricePctChange = ((current.price - prev.price) / prev.price) * 100;
        if (Math.abs(pricePctChange) >= PRICE_CHANGE_THRESHOLD_PCT) {
          const dir = pricePctChange > 0 ? '+' : '';
          const severity = Math.abs(pricePctChange) >= 3 ? 'warning' : 'info';
          events.push({
            type: 'price',
            severity,
            message: `Price move: ${dir}${pricePctChange.toFixed(2)}% (${formatPrice(prev.price)} → ${formatPrice(current.price)})`,
          });
        }
      }

      // ── Open Interest Delta ──
      // Reject >50% swings in a single tick — indicates stale/partial API data, not real activity
      if (prev.totalOi > 0 && current.totalOi > 0) {
        const oiDelta = current.totalOi - prev.totalOi;
        const oiPctChange = (oiDelta / prev.totalOi) * 100;
        if (
          Math.abs(oiPctChange) < 50 &&
          (Math.abs(oiPctChange) >= OI_CHANGE_THRESHOLD_PCT || Math.abs(oiDelta) >= OI_CHANGE_THRESHOLD_USD)
        ) {
          const dir = oiDelta > 0 ? '+' : '';
          const severity = Math.abs(oiPctChange) >= 20 ? 'warning' : 'info';
          events.push({
            type: 'oi',
            severity,
            message: `Open Interest: ${dir}${formatUsd(oiDelta)} (${dir}${oiPctChange.toFixed(1)}%)`,
          });
        }
      }

      // ── Funding Rate Flip ──
      if (prev.fundingRate !== 0 || current.fundingRate !== 0) {
        const prevSign = Math.sign(prev.fundingRate);
        const currSign = Math.sign(current.fundingRate);
        if (prevSign !== currSign && currSign !== 0 && Math.abs(current.fundingRate) > FUNDING_FLIP_THRESHOLD) {
          const direction = current.fundingRate > 0 ? 'positive' : 'negative';
          events.push({
            type: 'funding',
            severity: 'warning',
            message: `Funding flipped ${direction} (${formatPercent(current.fundingRate * 100)})`,
          });
        }
      }
    }

    // ── Whale Activity ──
    const marketWhales = whaleData.filter((w) => {
      const wSym = (w.market_symbol ?? w.market ?? '').toUpperCase();
      const size = w.size_usd ?? 0;
      return wSym.includes(sym) && size >= WHALE_SIZE_THRESHOLD_USD;
    });

    for (const w of marketWhales) {
      const key = `${w.market_symbol}:${w.side}:${w.size_usd}:${w.entry_price}`;
      if (!this.knownWhaleKeys.has(key)) {
        this.knownWhaleKeys.add(key);
        // Only report after first tick (skip initial state dump)
        if (prev) {
          const side = (w.side ?? 'unknown').toUpperCase();
          events.push({
            type: 'whale',
            severity: 'warning',
            message: `Whale ${side.toLowerCase()} opened (${formatUsd(w.size_usd ?? 0)})`,
          });
        }
      }
    }

    // Bound known whale keys to prevent unbounded growth
    if (this.knownWhaleKeys.size > 500) {
      const keys = Array.from(this.knownWhaleKeys);
      for (let i = 0; i < 200; i++) this.knownWhaleKeys.delete(keys[i]);
    }

    this.prevMarket.set(sym, current);
  }

  // ─── Position Monitor ────────────────────────────────────────────────

  private async tickPosition(events: MonitorEvent[]): Promise<void> {
    const sym = this.market!;
    let positions: Position[];

    try {
      positions = await this.client.getPositions();
    } catch {
      if (this.cycleCount === 1) {
        events.push({ type: 'info', severity: 'warning', message: 'Unable to fetch positions' });
      }
      return;
    }

    const pos = positions.find((p) => p.market.toUpperCase() === sym);
    if (!pos) {
      if (this.cycleCount === 1) {
        events.push({ type: 'info', severity: 'info', message: `No open position on ${sym}` });
      }
      return;
    }

    const liqDistance = pos.entryPrice > 0 ? Math.abs(pos.markPrice - pos.liquidationPrice) / pos.entryPrice : 0;

    const current: PositionSnapshot = {
      pnl: pos.unrealizedPnl,
      liqDistance,
      collateralUsd: pos.collateralUsd,
      fundingAccumulated: pos.totalFees,
      markPrice: pos.markPrice,
    };

    const posKey = `${sym}:${pos.side}`;
    const prev = this.prevPosition.get(posKey);

    if (!prev) {
      // First tick — show position summary
      const side = pos.side === TradeSide.Long ? theme.long('LONG') : theme.short('SHORT');
      events.push({
        type: 'info',
        severity: 'info',
        message: `${chalk.bold(sym)} ${side} ${pos.leverage.toFixed(1)}x  Entry: ${formatPrice(pos.entryPrice)}  Mark: ${formatPrice(pos.markPrice)}`,
      });
      events.push({
        type: 'info',
        severity: 'info',
        message: `Size: ${formatUsd(pos.sizeUsd)}  Collateral: ${formatUsd(pos.collateralUsd)}  PnL: ${formatUsd(pos.unrealizedPnl)}`,
      });
      events.push({
        type: 'info',
        severity: liqDistance < 0.15 ? 'critical' : liqDistance < 0.3 ? 'warning' : 'info',
        message: `Distance to liquidation: ${(liqDistance * 100).toFixed(1)}%  Liq price: ${formatPrice(pos.liquidationPrice)}`,
      });
    } else {
      // ── PnL Change ──
      const pnlDelta = current.pnl - prev.pnl;
      if (Math.abs(pnlDelta) >= PNL_CHANGE_THRESHOLD_USD) {
        const dir = pnlDelta > 0 ? '+' : '';
        events.push({
          type: 'pnl',
          severity: 'info',
          message: `PnL change: ${dir}${formatUsd(pnlDelta)} (total: ${formatUsd(current.pnl)})`,
        });
      }

      // ── Liquidation Distance Change ──
      const liqDelta = (current.liqDistance - prev.liqDistance) * 100;
      if (Math.abs(liqDelta) >= LIQ_DISTANCE_CHANGE_PCT) {
        const severity = current.liqDistance < 0.15 ? 'critical' : current.liqDistance < 0.3 ? 'warning' : 'info';
        const dir = liqDelta > 0 ? 'improved' : 'worsened';
        events.push({
          type: 'liquidation',
          severity,
          message: `Distance to liquidation ${dir}: ${(current.liqDistance * 100).toFixed(1)}% (${liqDelta > 0 ? '+' : ''}${liqDelta.toFixed(1)}pp)`,
        });
      }

      // ── Funding Impact ──
      const fundingDelta = current.fundingAccumulated - prev.fundingAccumulated;
      if (Math.abs(fundingDelta) >= 0.01) {
        events.push({
          type: 'funding',
          severity: 'info',
          message: `Funding impact: ${fundingDelta > 0 ? '+' : ''}${formatUsd(fundingDelta)}`,
        });
      }
    }

    this.prevPosition.set(posKey, current);
  }

  // ─── Liquidation Monitor ─────────────────────────────────────────────

  private async tickLiquidations(events: MonitorEvent[]): Promise<void> {
    const sym = this.market!;

    const [priceMap, positions] = await Promise.all([
      this.priceSvc.getPrices([sym]).catch(() => new Map<string, TokenPrice>()),
      this.fstats.getOpenPositions().catch(() => [] as RawActivityRecord[]),
    ]);

    const tp = priceMap.get(sym);
    if (!tp) return;

    const currentPrice = tp.price;

    // Analyze open positions for liquidation clusters
    const marketPositions = positions.filter((p) => {
      const pSym = (p.market_symbol ?? p.market ?? '').toUpperCase();
      return pSym.includes(sym) && (p.size_usd ?? 0) > 0;
    });

    if (marketPositions.length === 0) {
      if (this.cycleCount === 1) {
        events.push({
          type: 'info',
          severity: 'info',
          message: `Monitoring liquidations for ${chalk.bold(sym)} at ${formatPrice(currentPrice)}`,
        });
        events.push({ type: 'info', severity: 'info', message: 'No large liquidation clusters detected.' });
      }
      return;
    }

    // Analyze real position data — sizes, counts, weighted entry prices
    // No fabricated liquidation price estimates
    interface PositionCluster {
      side: string;
      avgEntry: number; // size-weighted average entry price (real data)
      totalSize: number; // total position size in USD
      count: number; // number of positions
      distancePct: number; // distance from current price to avg entry (real data)
    }

    const clusters: PositionCluster[] = [];

    const longPositions = marketPositions.filter((p) => (p.side ?? '').toLowerCase() === 'long');
    const shortPositions = marketPositions.filter((p) => (p.side ?? '').toLowerCase() === 'short');

    // Long position cluster — real data only
    if (longPositions.length > 0) {
      const totalLongSize = longPositions.reduce((sum, p) => sum + (p.size_usd ?? 0), 0);
      const weightedEntry =
        totalLongSize > 0
          ? longPositions.reduce((sum, p) => {
              const entry = p.entry_price ?? currentPrice;
              const size = p.size_usd ?? 0;
              return sum + entry * size;
            }, 0) / totalLongSize
          : currentPrice;

      // Distance from current price to average entry — this is real, observable data
      const distancePct = currentPrice > 0 ? ((currentPrice - weightedEntry) / currentPrice) * 100 : 0;

      if (totalLongSize >= WHALE_SIZE_THRESHOLD_USD) {
        clusters.push({
          side: 'LONG',
          avgEntry: weightedEntry,
          totalSize: totalLongSize,
          count: longPositions.length,
          distancePct,
        });
      }
    }

    // Short position cluster — real data only
    if (shortPositions.length > 0) {
      const totalShortSize = shortPositions.reduce((sum, p) => sum + (p.size_usd ?? 0), 0);
      const weightedEntry =
        totalShortSize > 0
          ? shortPositions.reduce((sum, p) => {
              const entry = p.entry_price ?? currentPrice;
              const size = p.size_usd ?? 0;
              return sum + entry * size;
            }, 0) / totalShortSize
          : currentPrice;

      const distancePct = currentPrice > 0 ? ((weightedEntry - currentPrice) / currentPrice) * 100 : 0;

      if (totalShortSize >= WHALE_SIZE_THRESHOLD_USD) {
        clusters.push({
          side: 'SHORT',
          avgEntry: weightedEntry,
          totalSize: totalShortSize,
          count: shortPositions.length,
          distancePct,
        });
      }
    }

    if (this.cycleCount === 1) {
      events.push({
        type: 'info',
        severity: 'info',
        message: `${chalk.bold(sym)} at ${formatPrice(currentPrice)} — tracking ${marketPositions.length} positions`,
      });
    }

    for (const cluster of clusters) {
      // Severity based on how close current price is to average entry (tighter = more positions in profit/loss)
      const absDist = Math.abs(cluster.distancePct);
      const severity: MonitorEvent['severity'] = absDist < 2 ? 'warning' : 'info';
      const sideLabel = cluster.side.toLowerCase();
      const distDir = cluster.distancePct >= 0 ? '+' : '';

      if (this.cycleCount === 1 || severity !== 'info') {
        events.push({
          type: 'liquidation',
          severity,
          message: `${cluster.side} position cluster — Avg Entry: ${formatPrice(cluster.avgEntry)} (${distDir}${cluster.distancePct.toFixed(1)}% from price) — ${formatUsd(cluster.totalSize)} across ${cluster.count} ${sideLabel} positions`,
        });
      }
    }
  }

  // ─── Protocol Monitor ────────────────────────────────────────────────

  private async tickProtocol(events: MonitorEvent[]): Promise<void> {
    // Gather protocol-wide data
    const [oiData, rpcLatency] = await Promise.all([
      this.fstats.getOpenInterest().catch(() => ({ markets: [] as MarketOI[] })),
      this.getRpcLatency(),
    ]);

    let totalOi = 0;
    const oiByMarket = new Map<string, number>();
    for (const m of oiData.markets) {
      const sym = m.market.toUpperCase();
      const mOi = (m.longOi ?? 0) + (m.shortOi ?? 0);
      oiByMarket.set(sym, mOi);
      totalOi += mOi;
    }

    // Check oracle freshness
    let oracleDelayS = 0;
    try {
      const prices = await this.priceSvc.getPrices(['SOL']);
      const solPrice = prices.get('SOL');
      if (solPrice) {
        oracleDelayS = (Date.now() - solPrice.timestamp) / 1000;
      }
    } catch {
      /* ignore */
    }

    const current: ProtocolSnapshot = {
      rpcLatencyMs: rpcLatency,
      totalOi,
      oiByMarket,
      timestamp: Date.now(),
    };

    if (!this.prevProtocol) {
      // First tick — show protocol summary
      events.push({
        type: 'info',
        severity: 'info',
        message: `Protocol OI: ${formatUsd(totalOi)}  Markets: ${oiData.markets.length}  RPC: ${rpcLatency >= 0 ? `${rpcLatency}ms` : 'unknown'}`,
      });
    } else {
      // ── RPC Latency Spike ──
      if (
        rpcLatency > RPC_LATENCY_SPIKE_MS &&
        (this.prevProtocol.rpcLatencyMs <= RPC_LATENCY_SPIKE_MS || this.prevProtocol.rpcLatencyMs < 0)
      ) {
        events.push({
          type: 'rpc',
          severity: 'warning',
          message: `RPC latency spike: ${rpcLatency}ms`,
        });
      }

      // ── Oracle Delay ──
      if (oracleDelayS > ORACLE_DELAY_THRESHOLD_S) {
        events.push({
          type: 'oracle',
          severity: 'warning',
          message: `Oracle delay detected: Pyth update lag ${oracleDelayS.toFixed(1)}s`,
        });
      }

      // ── OI Spikes per Market ──
      for (const [mkt, currentMktOi] of oiByMarket) {
        const prevMktOi = this.prevProtocol.oiByMarket.get(mkt) ?? 0;
        if (prevMktOi > 0) {
          const oiDelta = currentMktOi - prevMktOi;
          const oiPct = (oiDelta / prevMktOi) * 100;
          if (Math.abs(oiDelta) >= OI_CHANGE_THRESHOLD_USD && Math.abs(oiPct) >= OI_CHANGE_THRESHOLD_PCT) {
            const dir = oiDelta > 0 ? '+' : '';
            events.push({
              type: 'oi',
              severity: Math.abs(oiPct) >= 20 ? 'warning' : 'info',
              message: `OI spike in ${mkt}: ${dir}${formatUsd(oiDelta)} (${dir}${oiPct.toFixed(1)}%)`,
            });
          }
        }
      }

      // ── Total OI Change ──
      if (this.prevProtocol.totalOi > 0) {
        const totalDelta = totalOi - this.prevProtocol.totalOi;
        const totalPct = (totalDelta / this.prevProtocol.totalOi) * 100;
        if (Math.abs(totalDelta) >= OI_CHANGE_THRESHOLD_USD * 5 && Math.abs(totalPct) >= OI_CHANGE_THRESHOLD_PCT) {
          const dir = totalDelta > 0 ? '+' : '';
          events.push({
            type: 'oi',
            severity: 'warning',
            message: `Protocol OI: ${dir}${formatUsd(totalDelta)} (${dir}${totalPct.toFixed(1)}%) — total: ${formatUsd(totalOi)}`,
          });
        }
      }
    }

    this.prevProtocol = current;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private async getRpcLatency(): Promise<number> {
    try {
      const { getRpcManagerInstance } = await import('../network/rpc-manager.js');
      const mgr = getRpcManagerInstance();
      return mgr?.activeLatencyMs ?? -1;
    } catch {
      return -1;
    }
  }

  // ─── Output ──────────────────────────────────────────────────────────

  private printHeader(): void {
    console.log('');
    let title: string;
    switch (this.monitorType) {
      case 'market':
        title = `Monitoring ${chalk.bold(this.market!)}`;
        break;
      case 'position':
        title = `Monitoring Position: ${chalk.bold(this.market!)}`;
        break;
      case 'liquidations':
        title = `Monitoring Liquidations: ${chalk.bold(this.market!)}`;
        break;
      case 'protocol':
        title = 'Protocol Monitor';
        break;
    }
    console.log(`  ${theme.accentBold(title)}`);
    console.log(`  ${theme.separator(40)}`);
    console.log(theme.dim(`  Refresh: ${POLL_INTERVAL_MS / 1000}s  |  Press 'q' to exit`));
    console.log('');
  }

  private printEvent(ev: MonitorEvent): void {
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const timestamp = theme.dim(now);

    let icon: string;
    let colorFn: (text: string) => string;

    switch (ev.severity) {
      case 'critical':
        icon = '●';
        colorFn = theme.negative;
        break;
      case 'warning':
        icon = '▲';
        colorFn = theme.warning;
        break;
      default:
        icon = '│';
        colorFn = theme.text;
        break;
    }

    // Type-specific icons
    switch (ev.type) {
      case 'price':
        icon = ev.severity === 'info' ? '↕' : '⚡';
        break;
      case 'oi':
        icon = '◆';
        break;
      case 'funding':
        icon = '↻';
        break;
      case 'whale':
        icon = '🐋';
        break;
      case 'pnl':
        icon = '$';
        break;
      case 'liquidation':
        icon = '⚠';
        break;
      case 'rpc':
        icon = '⌂';
        break;
      case 'oracle':
        icon = '◎';
        break;
    }

    console.log(`  ${timestamp}  ${colorFn(icon)} ${colorFn(ev.message)}`);
  }
}
