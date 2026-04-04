/**
 * Market Performance Monitor — production hardening layer.
 *
 * Integrates with existing PerfMetrics, HealthMonitor, and MarketQualification
 * to provide per-market performance tracking with automated safety responses.
 *
 * Capabilities:
 *   1. Per-market EV/winRate/avgPnL/latency tracking
 *   2. Latency budget enforcement (auto-shed lowest priority markets)
 *   3. Dynamic market ranking for scan prioritization
 *   4. Safe mode: disable Tier 3 and reduce sizing on health degradation
 *   5. Auto-downscale/disable markets based on performance
 *   6. Edge analysis breakdown by type/cluster/regime
 *
 * Design:
 *   - Singleton, lightweight (no disk I/O on hot path)
 *   - All ring buffers bounded (max 200 samples/market)
 *   - Integrates with HealthMonitor state (HEALTHY/DEGRADED/CRITICAL)
 *   - Never blocks the tick loop
 */

import { getLogger } from '../utils/logger.js';
import {
  getMarketType,
  getMarketCluster,
  getRegisteredSymbols,
  getSizingMultiplier as baseMultiplier,
} from './market-registry.js';
import { MarketTier, getQualificationTracker } from './market-qualification.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_SAMPLES = 200;
const MAX_MARKETS_TRACKED = 100;

/** Tick latency budget: if p90 exceeds this, start shedding markets. */
const TICK_BUDGET_P90_MS = 2200;

/** Absolute tick latency ceiling: if p99 exceeds this, aggressive shed. */
const TICK_BUDGET_P99_MS = 5000;

// EV thresholds for auto-scaling
const EV_DOWNSCALE_THRESHOLD = 0;    // EV < 0 after 20 trades → 0.5x
const EV_DISABLE_THRESHOLD = 0;       // EV < 0 after 40 trades → disable
const EV_BOOST_THRESHOLD = 0.5;       // EV > 0.5 → priority boost
const MIN_TRADES_DOWNSCALE = 20;
const MIN_TRADES_DISABLE = 40;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MarketPerf {
  symbol: string;
  trades: number;
  wins: number;
  totalPnl: number;
  ev: number;
  winRate: number;
  avgPnl: number;
  avgSlippageBps: number;
  avgExecutionLatencyMs: number;
  /** Current sizing adjustment (1.0 = normal, 0.5 = downscaled, 0 = disabled) */
  sizeAdjustment: number;
  /** Dynamic scan rank (lower = higher priority) */
  scanRank: number;
  /** Market score: composite of EV, winRate, liquidity, latency */
  score: number;
}

export interface TickBudgetStatus {
  withinBudget: boolean;
  tickP90Ms: number;
  tickP99Ms: number;
  budgetP90Ms: number;
  budgetP99Ms: number;
  marketsShed: string[];
  safeMode: boolean;
}

export interface SafeModeState {
  active: boolean;
  reason: string;
  globalSizeMultiplier: number;
  disabledTiers: MarketTier[];
  activatedAt: number;
}

export interface EdgeBreakdown {
  byType: Record<string, TypeEdge>;
  byCluster: Record<string, ClusterEdge>;
  topMarkets: MarketPerf[];
  bottomMarkets: MarketPerf[];
}

export interface TypeEdge {
  type: string;
  markets: number;
  avgEv: number;
  avgWinRate: number;
  avgSharpe: number;
  totalPnl: number;
  contribution: number; // % of total PnL
}

export interface ClusterEdge {
  cluster: string;
  markets: number;
  avgEv: number;
  avgWinRate: number;
  totalPnl: number;
}

// ─── Internal per-market tracking ────────────────────────────────────────────

interface MarketSamples {
  pnls: number[];
  slippages: number[];
  latencies: number[];
  trades: number;
  wins: number;
  totalPnl: number;
}

// ─── Market Performance Monitor ──────────────────────────────────────────────

export class MarketPerfMonitor {
  private samples: Map<string, MarketSamples> = new Map();
  private tickLatencies: number[] = [];
  private _safeMode: SafeModeState = {
    active: false,
    reason: '',
    globalSizeMultiplier: 1.0,
    disabledTiers: [],
    activatedAt: 0,
  };
  private _shedMarkets: Set<string> = new Set();
  private _lastBudgetCheck = 0;

  // ─── Recording API (called from trade pipeline) ────────────────────────

  /** Record a completed trade's performance metrics. */
  recordTrade(
    symbol: string,
    pnl: number,
    slippageBps: number,
    executionLatencyMs: number,
  ): void {
    const upper = symbol.toUpperCase();
    const s = this.ensureSamples(upper);

    s.pnls.push(pnl);
    s.slippages.push(slippageBps);
    s.latencies.push(executionLatencyMs);
    s.trades++;
    s.totalPnl += pnl;
    if (pnl > 0) s.wins++;

    // Trim ring buffers
    if (s.pnls.length > MAX_SAMPLES) s.pnls.shift();
    if (s.slippages.length > MAX_SAMPLES) s.slippages.shift();
    if (s.latencies.length > MAX_SAMPLES) s.latencies.shift();

    // Also record in qualification tracker
    const tracker = getQualificationTracker();
    tracker.recordSignal(upper, 'long', 0.5, pnl);

    // Check auto-scaling rules
    this.evaluateAutoScale(upper, s);
  }

  /** Record a tick's total duration (called once per tick). */
  recordTickLatency(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.tickLatencies.push(ms);
    if (this.tickLatencies.length > MAX_SAMPLES) this.tickLatencies.shift();
  }

  // ─── Latency Budget Enforcement ────────────────────────────────────────

  /** Check tick latency budget and auto-shed markets if exceeded. */
  enforceBudget(): TickBudgetStatus {
    const now = Date.now();
    // Don't check more than once per second
    if (now - this._lastBudgetCheck < 1000) {
      return {
        withinBudget: !this._safeMode.active,
        tickP90Ms: 0,
        tickP99Ms: 0,
        budgetP90Ms: TICK_BUDGET_P90_MS,
        budgetP99Ms: TICK_BUDGET_P99_MS,
        marketsShed: [...this._shedMarkets],
        safeMode: this._safeMode.active,
      };
    }
    this._lastBudgetCheck = now;

    if (this.tickLatencies.length < 10) {
      return {
        withinBudget: true,
        tickP90Ms: 0,
        tickP99Ms: 0,
        budgetP90Ms: TICK_BUDGET_P90_MS,
        budgetP99Ms: TICK_BUDGET_P99_MS,
        marketsShed: [],
        safeMode: this._safeMode.active,
      };
    }

    const sorted = [...this.tickLatencies].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];

    const exceededP90 = p90 > TICK_BUDGET_P90_MS;
    const exceededP99 = p99 > TICK_BUDGET_P99_MS;

    if (exceededP99) {
      // Aggressive shed: disable Tier 3 + lowest-ranked Tier 2 markets
      this.activateSafeMode('Tick P99 exceeded budget', 0.7, [MarketTier.TIER_3]);
      this.shedLowestPriorityMarkets(5);
    } else if (exceededP90) {
      // Moderate shed: drop lowest-ranked markets from scan
      this.shedLowestPriorityMarkets(3);
    } else {
      // Within budget: gradually restore
      this.restoreShedMarkets();
    }

    return {
      withinBudget: !exceededP90 && !exceededP99,
      tickP90Ms: p90,
      tickP99Ms: p99,
      budgetP90Ms: TICK_BUDGET_P90_MS,
      budgetP99Ms: TICK_BUDGET_P99_MS,
      marketsShed: [...this._shedMarkets],
      safeMode: this._safeMode.active,
    };
  }

  // ─── Safe Mode ─────────────────────────────────────────────────────────

  /** Activate safe mode (called by budget enforcer or external health integration). */
  activateSafeMode(reason: string, sizeMultiplier: number, disabledTiers: MarketTier[]): void {
    if (this._safeMode.active && this._safeMode.reason === reason) return;

    this._safeMode = {
      active: true,
      reason,
      globalSizeMultiplier: sizeMultiplier,
      disabledTiers,
      activatedAt: Date.now(),
    };

    getLogger().warn('PERF', `SAFE MODE activated: ${reason} (size=${sizeMultiplier}x, disabled tiers: ${disabledTiers.join(',')})`);
  }

  /** Deactivate safe mode (call when conditions normalize). */
  deactivateSafeMode(): void {
    if (!this._safeMode.active) return;
    getLogger().info('PERF', 'SAFE MODE deactivated — conditions normalized');
    this._safeMode = {
      active: false,
      reason: '',
      globalSizeMultiplier: 1.0,
      disabledTiers: [],
      activatedAt: 0,
    };
    this._shedMarkets.clear();
  }

  /** Check safe mode state. */
  getSafeModeState(): SafeModeState {
    return { ...this._safeMode };
  }

  /**
   * Integrate with HealthMonitor state.
   * Call this periodically (e.g., every tick) with the current health state.
   */
  onHealthStateChange(state: 'HEALTHY' | 'DEGRADED' | 'CRITICAL'): void {
    switch (state) {
      case 'CRITICAL':
        this.activateSafeMode('System health CRITICAL', 0.5, [MarketTier.TIER_2, MarketTier.TIER_3]);
        break;
      case 'DEGRADED':
        this.activateSafeMode('System health DEGRADED', 0.7, [MarketTier.TIER_3]);
        break;
      case 'HEALTHY':
        if (this._safeMode.active && this._safeMode.reason.startsWith('System health')) {
          this.deactivateSafeMode();
        }
        break;
    }
  }

  // ─── Per-Market Performance ────────────────────────────────────────────

  /** Get performance stats for a single market. */
  getMarketPerf(symbol: string): MarketPerf {
    const upper = symbol.toUpperCase();
    const s = this.samples.get(upper);

    if (!s || s.trades === 0) {
      return {
        symbol: upper,
        trades: 0,
        wins: 0,
        totalPnl: 0,
        ev: 0,
        winRate: 0,
        avgPnl: 0,
        avgSlippageBps: 0,
        avgExecutionLatencyMs: 0,
        sizeAdjustment: 1.0,
        scanRank: 999,
        score: 0,
      };
    }

    const ev = s.totalPnl / s.trades;
    const winRate = s.wins / s.trades;
    const avgPnl = s.totalPnl / s.trades;
    const avgSlippage = s.slippages.length > 0
      ? s.slippages.reduce((a, b) => a + b, 0) / s.slippages.length
      : 0;
    const avgLatency = s.latencies.length > 0
      ? s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length
      : 0;

    const sizeAdj = this.computeSizeAdjustment(upper, s);
    const score = this.computeScore(ev, winRate, avgSlippage, avgLatency);

    return {
      symbol: upper,
      trades: s.trades,
      wins: s.wins,
      totalPnl: s.totalPnl,
      ev,
      winRate,
      avgPnl,
      avgSlippageBps: avgSlippage,
      avgExecutionLatencyMs: avgLatency,
      sizeAdjustment: sizeAdj,
      scanRank: 0, // computed in ranking
      score,
    };
  }

  /** Get performance for all tracked markets. */
  getAllMarketPerf(): MarketPerf[] {
    const all: MarketPerf[] = [];
    for (const sym of this.samples.keys()) {
      all.push(this.getMarketPerf(sym));
    }
    return all;
  }

  // ─── Dynamic Market Ranking ────────────────────────────────────────────

  /**
   * Rank all markets for scan priority.
   * Score = (EV * 0.4) + (winRate * 0.3) + (liquidity * 0.2) - (latency * 0.1)
   * Returns symbols ordered by priority (best first).
   */
  getRankedMarkets(): MarketPerf[] {
    const allSymbols = getRegisteredSymbols();
    const ranked: MarketPerf[] = [];

    for (const sym of allSymbols) {
      const perf = this.getMarketPerf(sym);

      // Skip shed markets
      if (this._shedMarkets.has(sym)) {
        perf.scanRank = 9999;
        ranked.push(perf);
        continue;
      }

      // Skip disabled tiers in safe mode
      const tracker = getQualificationTracker();
      const qual = tracker.getQualification(sym);
      if (this._safeMode.active && this._safeMode.disabledTiers.includes(qual.tier)) {
        perf.scanRank = 9998;
        ranked.push(perf);
        continue;
      }

      ranked.push(perf);
    }

    // Separate eligible from excluded (shed/disabled)
    const eligible = ranked.filter((m) => m.scanRank < 9998);
    const excluded = ranked.filter((m) => m.scanRank >= 9998);

    // Sort eligible by score (descending)
    eligible.sort((a, b) => b.score - a.score);

    // Assign ranks only to eligible markets
    for (let i = 0; i < eligible.length; i++) {
      eligible[i].scanRank = i + 1;
    }

    return [...eligible, ...excluded];
  }

  /**
   * Get the top N markets to scan (respects budget + safe mode).
   * Use this to limit scanning when under load.
   */
  getMarketsToScan(maxCount?: number): string[] {
    const ranked = this.getRankedMarkets();
    const eligible = ranked.filter((m) => m.scanRank < 9998);
    const limit = maxCount ?? eligible.length;
    return eligible.slice(0, limit).map((m) => m.symbol);
  }

  // ─── Effective Sizing ──────────────────────────────────────────────────

  /**
   * Get effective sizing multiplier for a market.
   * Combines: base (from type) × performance adjustment × safe mode.
   */
  getEffectiveSizing(symbol: string): number {
    const upper = symbol.toUpperCase();
    const base = baseMultiplier(upper);
    const perf = this.getMarketPerf(upper);
    const safeModeMultiplier = this._safeMode.active ? this._safeMode.globalSizeMultiplier : 1.0;

    const effective = base * perf.sizeAdjustment * safeModeMultiplier;
    return Math.max(0, Math.min(1.5, effective)); // clamp [0, 1.5]
  }

  // ─── Edge Analysis ─────────────────────────────────────────────────────

  /** Get edge breakdown by type, cluster, with top/bottom markets. */
  getEdgeBreakdown(): EdgeBreakdown {
    const allPerf = this.getAllMarketPerf().filter((m) => m.trades >= 5);

    // By type
    const byType: Record<string, { markets: MarketPerf[]; totalPnl: number }> = {};
    let grandTotalPnl = 0;

    for (const m of allPerf) {
      const type = getMarketType(m.symbol);
      if (!byType[type]) byType[type] = { markets: [], totalPnl: 0 };
      byType[type].markets.push(m);
      byType[type].totalPnl += m.totalPnl;
      grandTotalPnl += m.totalPnl;
    }

    const typeEdge: Record<string, TypeEdge> = {};
    for (const [type, data] of Object.entries(byType)) {
      const ms = data.markets;
      typeEdge[type] = {
        type,
        markets: ms.length,
        avgEv: ms.reduce((s, m) => s + m.ev, 0) / ms.length,
        avgWinRate: ms.reduce((s, m) => s + m.winRate, 0) / ms.length,
        avgSharpe: 0, // computed from qualification tracker
        totalPnl: data.totalPnl,
        contribution: grandTotalPnl !== 0 ? (data.totalPnl / Math.abs(grandTotalPnl)) * 100 : 0,
      };
    }

    // By cluster
    const byCluster: Record<string, MarketPerf[]> = {};
    for (const m of allPerf) {
      const cluster = getMarketCluster(m.symbol);
      if (!byCluster[cluster]) byCluster[cluster] = [];
      byCluster[cluster].push(m);
    }

    const clusterEdge: Record<string, ClusterEdge> = {};
    for (const [cluster, ms] of Object.entries(byCluster)) {
      clusterEdge[cluster] = {
        cluster,
        markets: ms.length,
        avgEv: ms.reduce((s, m) => s + m.ev, 0) / ms.length,
        avgWinRate: ms.reduce((s, m) => s + m.winRate, 0) / ms.length,
        totalPnl: ms.reduce((s, m) => s + m.totalPnl, 0),
      };
    }

    // Top/bottom markets
    const sorted = [...allPerf].sort((a, b) => b.ev - a.ev);

    return {
      byType: typeEdge,
      byCluster: clusterEdge,
      topMarkets: sorted.slice(0, 5),
      bottomMarkets: sorted.slice(-5).reverse(),
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private ensureSamples(symbol: string): MarketSamples {
    let s = this.samples.get(symbol);
    if (!s) {
      // Bound total tracked markets
      if (this.samples.size >= MAX_MARKETS_TRACKED) {
        // Evict least-traded market
        let minTrades = Infinity;
        let evictKey = '';
        for (const [k, v] of this.samples) {
          if (v.trades < minTrades) {
            minTrades = v.trades;
            evictKey = k;
          }
        }
        if (evictKey) this.samples.delete(evictKey);
      }

      s = { pnls: [], slippages: [], latencies: [], trades: 0, wins: 0, totalPnl: 0 };
      this.samples.set(symbol, s);
    }
    return s;
  }

  private evaluateAutoScale(symbol: string, s: MarketSamples): void {
    const ev = s.totalPnl / s.trades;

    // After 40+ trades with negative EV → disable
    if (s.trades >= MIN_TRADES_DISABLE && ev < EV_DISABLE_THRESHOLD) {
      getLogger().warn('PERF', `${symbol}: DISABLED after ${s.trades} trades (EV=$${ev.toFixed(2)})`);
    }
    // After 20+ trades with negative EV → downscale
    else if (s.trades >= MIN_TRADES_DOWNSCALE && ev < EV_DOWNSCALE_THRESHOLD) {
      getLogger().info('PERF', `${symbol}: downscaled to 0.5x after ${s.trades} trades (EV=$${ev.toFixed(2)})`);
    }
    // Positive EV with boost → log
    else if (s.trades >= MIN_TRADES_DOWNSCALE && ev > EV_BOOST_THRESHOLD) {
      getLogger().info('PERF', `${symbol}: BOOSTED priority (EV=$${ev.toFixed(2)}, WR=${((s.wins / s.trades) * 100).toFixed(1)}%)`);
    }
  }

  private computeSizeAdjustment(symbol: string, s: MarketSamples): number {
    if (s.trades < MIN_TRADES_DOWNSCALE) return 1.0;

    const ev = s.totalPnl / s.trades;

    // Disabled: 0
    if (s.trades >= MIN_TRADES_DISABLE && ev < EV_DISABLE_THRESHOLD) return 0;

    // Downscaled: 0.5
    if (ev < EV_DOWNSCALE_THRESHOLD) return 0.5;

    // Boosted: 1.2 (capped by getEffectiveSizing)
    if (ev > EV_BOOST_THRESHOLD) return 1.2;

    return 1.0;
  }

  private computeScore(ev: number, winRate: number, avgSlippage: number, avgLatency: number): number {
    // Normalize inputs to 0-1 range
    const evNorm = Math.max(-1, Math.min(1, ev)); // clamp EV to [-1, 1]
    const wrNorm = winRate; // already 0-1
    // Lower slippage is better: 1 - (slippage/50) clamped to [0,1]
    const liqNorm = Math.max(0, Math.min(1, 1 - avgSlippage / 50));
    // Lower latency is better: 1 - (latency/5000) clamped to [0,1]
    const latNorm = Math.max(0, Math.min(1, 1 - avgLatency / 5000));

    // Composite: EV(40%) + winRate(30%) + liquidity(20%) - latency(10%)
    const score = evNorm * 0.4 + wrNorm * 0.3 + liqNorm * 0.2 + latNorm * 0.1;

    // Tier bonus: Tier 1 gets a small scan priority bonus
    return Number.isFinite(score) ? score : 0;
  }

  private shedLowestPriorityMarkets(count: number): void {
    const ranked = this.getRankedMarkets()
      .filter((m) => m.scanRank < 9998 && !this._shedMarkets.has(m.symbol));

    // Shed from the bottom of the ranking
    const toShed = ranked.slice(-count);
    for (const m of toShed) {
      this._shedMarkets.add(m.symbol);
      getLogger().info('PERF', `Shed ${m.symbol} from scan (rank #${m.scanRank}, score=${m.score.toFixed(3)})`);
    }
  }

  private restoreShedMarkets(): void {
    if (this._shedMarkets.size > 0) {
      // Restore one market per call (gradual ramp-up)
      const first = this._shedMarkets.values().next().value;
      if (first) {
        this._shedMarkets.delete(first);
        getLogger().info('PERF', `Restored ${first} to scan`);
      }
    }
  }

  /** Reset all tracked data. */
  reset(): void {
    this.samples.clear();
    this.tickLatencies.length = 0;
    this._shedMarkets.clear();
    this.deactivateSafeMode();
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: MarketPerfMonitor | null = null;

export function getMarketPerfMonitor(): MarketPerfMonitor {
  if (!_instance) _instance = new MarketPerfMonitor();
  return _instance;
}

export function initMarketPerfMonitor(): MarketPerfMonitor {
  _instance = new MarketPerfMonitor();
  return _instance;
}
