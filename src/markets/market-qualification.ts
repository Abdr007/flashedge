/**
 * Market Qualification System — Shadow mode for newly discovered markets.
 *
 * Every market discovered from the SDK starts in SHADOW mode.
 * The agent tracks signals without executing real trades until the market
 * accumulates enough data to prove positive expected value.
 *
 * Promotion criteria:
 *   - ≥20 signals tracked
 *   - Expected value (EV) > 0
 *
 * Tiered agent inclusion:
 *   Phase A (<50 total trades):  Only Tier 1 (core markets)
 *   Phase B (50-150 trades):     Tier 1 + Tier 2 (new crypto, 30% max allocation)
 *   Phase C (>150 trades):       All tiers (controlled exposure)
 *
 * Persistence: ~/.flash/market-qualification.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';
import { MarketType, getMarketType, getRegisteredSymbols } from './market-registry.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const MIN_SIGNALS_FOR_PROMOTION = 20;
const QUALIFICATION_FILE = join(homedir(), '.flash', 'market-qualification.json');
const SAVE_INTERVAL_MS = 60_000;
const MAX_SIGNALS_TRACKED = 200; // per market

// ─── Types ───────────────────────────────────────────────────────────────────

export enum MarketTier {
  TIER_1 = 1, // Core markets (established crypto)
  TIER_2 = 2, // New crypto markets
  TIER_3 = 3, // Equities, forex, commodities, new additions
}

export enum QualificationStatus {
  SHADOW = 'SHADOW',       // Tracking signals, no real trades
  QUALIFIED = 'QUALIFIED', // Met criteria, eligible for real trades
  DISABLED = 'DISABLED',   // Auto-disabled due to negative EV after qualification
}

export interface MarketSignal {
  timestamp: number;
  direction: 'long' | 'short';
  score: number;       // 0-1 signal strength
  hypotheticalPnl: number; // simulated outcome
}

export interface MarketQualification {
  symbol: string;
  status: QualificationStatus;
  tier: MarketTier;
  signals: MarketSignal[];
  totalSignals: number;
  winCount: number;
  totalPnl: number;
  /** Expected value = totalPnl / totalSignals */
  ev: number;
  /** Win rate = winCount / totalSignals */
  winRate: number;
  /** Sharpe-like ratio (mean / stddev of PnL) */
  sharpe: number;
  /**
   * Confidence score (0-100): composite of signal volume, EV consistency, win rate.
   * Must reach ≥60 for promotion. Computed from:
   *   - Signal volume factor (20-40 signals → 0-30 pts)
   *   - EV consistency factor (EV > 0 across recent windows → 0-30 pts)
   *   - Win rate factor (45%-70%+ → 0-25 pts)
   *   - Sharpe factor (0-1+ → 0-15 pts)
   */
  confidenceScore: number;
  promotedAt?: number;
  disabledAt?: number;
}

export interface QualificationStats {
  totalMarkets: number;
  shadow: number;
  qualified: number;
  disabled: number;
  byTier: Record<number, number>;
  topEv: Array<{ symbol: string; ev: number; signals: number }>;
  bottomEv: Array<{ symbol: string; ev: number; signals: number }>;
}

// ─── Tier Assignment ─────────────────────────────────────────────────────────

/** Core markets that start as Tier 1 (always eligible for real trading). */
const TIER_1_MARKETS = new Set([
  'SOL', 'BTC', 'ETH', 'BNB', 'ZEC',
  'XAU', 'XAG', 'CRUDEOIL', 'NATGAS',
  'EUR', 'GBP', 'USDJPY', 'USDCNH',
]);

function assignTier(symbol: string): MarketTier {
  if (TIER_1_MARKETS.has(symbol)) return MarketTier.TIER_1;

  const type = getMarketType(symbol);
  switch (type) {
    case MarketType.CRYPTO:
      return MarketTier.TIER_2;
    case MarketType.EQUITY:
    case MarketType.INDEX:
    case MarketType.FOREX:
    case MarketType.COMMODITY:
      return MarketTier.TIER_3;
    default:
      return MarketTier.TIER_3;
  }
}

// ─── Qualification Tracker ───────────────────────────────────────────────────

export class MarketQualificationTracker {
  private qualifications: Map<string, MarketQualification> = new Map();
  private lastSave = 0;
  private loaded = false;

  constructor() {
    this.loadFromDisk();
  }

  /** Record a signal for a market (shadow or real). */
  recordSignal(
    symbol: string,
    direction: 'long' | 'short',
    score: number,
    hypotheticalPnl: number,
  ): void {
    const upper = symbol.toUpperCase();
    const qual = this.ensureQualification(upper);

    const signal: MarketSignal = {
      timestamp: Date.now(),
      direction,
      score: Math.max(0, Math.min(1, score)),
      hypotheticalPnl,
    };

    qual.signals.push(signal);
    if (qual.signals.length > MAX_SIGNALS_TRACKED) {
      qual.signals.shift();
    }

    qual.totalSignals++;
    qual.totalPnl += hypotheticalPnl;
    if (hypotheticalPnl > 0) qual.winCount++;

    // Recompute stats
    qual.ev = qual.totalSignals > 0 ? qual.totalPnl / qual.totalSignals : 0;
    qual.winRate = qual.totalSignals > 0 ? qual.winCount / qual.totalSignals : 0;
    qual.sharpe = this.computeSharpe(qual.signals);
    qual.confidenceScore = this.computeConfidenceScore(qual);

    // Check promotion — STRICT criteria:
    //   1. ≥20 signals
    //   2. EV > 0
    //   3. Win rate ≥ 45%
    //   4. Confidence score ≥ 60
    if (qual.status === QualificationStatus.SHADOW) {
      const meetsThreshold =
        qual.totalSignals >= MIN_SIGNALS_FOR_PROMOTION &&
        qual.ev > 0 &&
        qual.winRate >= 0.45 &&
        qual.confidenceScore >= 60;

      if (meetsThreshold) {
        qual.status = QualificationStatus.QUALIFIED;
        qual.promotedAt = Date.now();
        getLogger().info(
          'QUALIFY',
          `${upper} PROMOTED (EV=$${qual.ev.toFixed(2)}, WR=${(qual.winRate * 100).toFixed(1)}%, ` +
          `Conf=${qual.confidenceScore.toFixed(0)}, Sharpe=${qual.sharpe.toFixed(2)}, ${qual.totalSignals} signals)`,
        );
      }
    }

    // Auto-disable check: qualified but EV turned negative after 40+ signals
    if (qual.status === QualificationStatus.QUALIFIED && qual.totalSignals >= MIN_SIGNALS_FOR_PROMOTION * 2 && qual.ev < 0) {
      qual.status = QualificationStatus.DISABLED;
      qual.disabledAt = Date.now();
      getLogger().warn('QUALIFY', `${upper} DISABLED — negative EV after ${qual.totalSignals} signals (EV=$${qual.ev.toFixed(2)})`);
    }

    this.maybeSave();
  }

  /** Check if a market is eligible for real trading by the agent. */
  isEligibleForTrading(symbol: string, totalTradeCount: number): boolean {
    const upper = symbol.toUpperCase();
    const qual = this.ensureQualification(upper);

    // Disabled markets are never eligible
    if (qual.status === QualificationStatus.DISABLED) return false;

    // Tier 1 markets are always eligible
    if (qual.tier === MarketTier.TIER_1) return true;

    // Shadow markets are not eligible for real trading
    if (qual.status === QualificationStatus.SHADOW) return false;

    // Tiered inclusion based on total trade count
    if (totalTradeCount < 50) {
      // Phase A: only Tier 1
      return false;
    }
    if (totalTradeCount < 150) {
      // Phase B: Tier 1 + Tier 2
      return qual.tier <= MarketTier.TIER_2;
    }
    // Phase C: all tiers (if qualified)
    return true;
  }

  /** Get qualification for a market. */
  getQualification(symbol: string): MarketQualification {
    return this.ensureQualification(symbol.toUpperCase());
  }

  /** Get qualification stats for all markets. */
  getStats(): QualificationStats {
    const all = Array.from(this.qualifications.values());
    const stats: QualificationStats = {
      totalMarkets: all.length,
      shadow: all.filter((q) => q.status === QualificationStatus.SHADOW).length,
      qualified: all.filter((q) => q.status === QualificationStatus.QUALIFIED).length,
      disabled: all.filter((q) => q.status === QualificationStatus.DISABLED).length,
      byTier: {},
      topEv: [],
      bottomEv: [],
    };

    for (const q of all) {
      stats.byTier[q.tier] = (stats.byTier[q.tier] ?? 0) + 1;
    }

    const withSignals = all.filter((q) => q.totalSignals >= 5).sort((a, b) => b.ev - a.ev);
    stats.topEv = withSignals.slice(0, 5).map((q) => ({ symbol: q.symbol, ev: q.ev, signals: q.totalSignals }));
    stats.bottomEv = withSignals.slice(-5).reverse().map((q) => ({ symbol: q.symbol, ev: q.ev, signals: q.totalSignals }));

    return stats;
  }

  /** Get per-market-type breakdown. */
  getTypeBreakdown(): Record<string, { markets: number; avgEv: number; avgWinRate: number; avgSharpe: number }> {
    const byType: Record<string, MarketQualification[]> = {};
    for (const q of this.qualifications.values()) {
      const type = getMarketType(q.symbol);
      if (!byType[type]) byType[type] = [];
      byType[type].push(q);
    }

    const result: Record<string, { markets: number; avgEv: number; avgWinRate: number; avgSharpe: number }> = {};
    for (const [type, quals] of Object.entries(byType)) {
      const withData = quals.filter((q) => q.totalSignals >= 5);
      result[type] = {
        markets: quals.length,
        avgEv: withData.length > 0 ? withData.reduce((s, q) => s + q.ev, 0) / withData.length : 0,
        avgWinRate: withData.length > 0 ? withData.reduce((s, q) => s + q.winRate, 0) / withData.length : 0,
        avgSharpe: withData.length > 0 ? withData.reduce((s, q) => s + q.sharpe, 0) / withData.length : 0,
      };
    }
    return result;
  }

  private ensureQualification(symbol: string): MarketQualification {
    let qual = this.qualifications.get(symbol);
    if (!qual) {
      qual = {
        symbol,
        status: TIER_1_MARKETS.has(symbol) ? QualificationStatus.QUALIFIED : QualificationStatus.SHADOW,
        tier: assignTier(symbol),
        signals: [],
        totalSignals: 0,
        winCount: 0,
        totalPnl: 0,
        ev: 0,
        winRate: 0,
        sharpe: 0,
        confidenceScore: TIER_1_MARKETS.has(symbol) ? 100 : 0,
      };
      this.qualifications.set(symbol, qual);
    }
    return qual;
  }

  /**
   * Compute confidence score (0-100) — composite measure of readiness.
   *
   * Components:
   *   - Volume (0-30 pts): 20 signals = 15pts, 40+ signals = 30pts
   *   - EV consistency (0-30 pts): EV > 0 in recent half of signals → full
   *   - Win rate (0-25 pts): 45% = 0pts, 60%+ = 25pts
   *   - Sharpe (0-15 pts): 0 = 0pts, 1.0+ = 15pts
   */
  private computeConfidenceScore(qual: MarketQualification): number {
    if (qual.totalSignals < 5) return 0;

    // Volume component (0-30)
    const volPts = Math.min(30, (qual.totalSignals / 40) * 30);

    // EV consistency: check if recent half of signals also has positive EV
    let evPts = 0;
    if (qual.ev > 0) {
      evPts = 15; // base for overall positive EV
      const recent = qual.signals.slice(-Math.max(10, Math.floor(qual.signals.length / 2)));
      if (recent.length >= 5) {
        const recentEv = recent.reduce((s, sig) => s + sig.hypotheticalPnl, 0) / recent.length;
        if (recentEv > 0) evPts = 30; // consistent across time windows
      }
    }

    // Win rate component (0-25): scales from 45% to 65%
    let wrPts = 0;
    if (qual.winRate >= 0.45) {
      wrPts = Math.min(25, ((qual.winRate - 0.45) / 0.20) * 25);
    }

    // Sharpe component (0-15): scales from 0 to 1.0
    const sharpePts = Math.min(15, Math.max(0, qual.sharpe) * 15);

    const total = volPts + evPts + wrPts + sharpePts;
    return Number.isFinite(total) ? Math.min(100, Math.max(0, total)) : 0;
  }

  private computeSharpe(signals: MarketSignal[]): number {
    if (signals.length < 5) return 0;
    const pnls = signals.map((s) => s.hypotheticalPnl);
    const mean = pnls.reduce((s, p) => s + p, 0) / pnls.length;
    const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length;
    const stddev = Math.sqrt(variance);
    if (stddev === 0 || !Number.isFinite(stddev)) return 0;
    const sharpe = mean / stddev;
    return Number.isFinite(sharpe) ? sharpe : 0;
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private loadFromDisk(): void {
    if (this.loaded) return;
    this.loaded = true;

    try {
      if (!existsSync(QUALIFICATION_FILE)) return;
      const raw = readFileSync(QUALIFICATION_FILE, 'utf8');
      if (raw.length > 5 * 1024 * 1024) return; // 5MB safety
      const data = JSON.parse(raw) as Record<string, MarketQualification>;

      for (const [sym, qual] of Object.entries(data)) {
        if (typeof qual !== 'object' || !qual) continue;
        // Re-assign tier in case classification changed
        qual.tier = assignTier(sym);
        // Trim signals to max
        if (qual.signals && qual.signals.length > MAX_SIGNALS_TRACKED) {
          qual.signals = qual.signals.slice(-MAX_SIGNALS_TRACKED);
        }
        this.qualifications.set(sym, qual);
      }
    } catch {
      // Start fresh
    }
  }

  private maybeSave(): void {
    const now = Date.now();
    if (now - this.lastSave < SAVE_INTERVAL_MS) return;
    this.saveToDisk();
    this.lastSave = now;
  }

  saveToDisk(): void {
    try {
      const dir = join(homedir(), '.flash');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

      const data: Record<string, MarketQualification> = {};
      for (const [sym, qual] of this.qualifications) {
        data[sym] = qual;
      }
      writeFileSync(QUALIFICATION_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch {
      // Non-critical
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _tracker: MarketQualificationTracker | null = null;

export function getQualificationTracker(): MarketQualificationTracker {
  if (!_tracker) _tracker = new MarketQualificationTracker();
  return _tracker;
}

/** Initialize tracker and ensure all registered markets have entries. */
export function initQualificationTracker(): MarketQualificationTracker {
  const tracker = getQualificationTracker();
  // Ensure all SDK markets have qualification entries
  for (const sym of getRegisteredSymbols()) {
    tracker.getQualification(sym);
  }
  return tracker;
}
