/**
 * Session Circuit Breaker — Protective trading halt on excessive losses.
 *
 * Tracks cumulative realized losses during a session. When thresholds are
 * breached, all trade execution is blocked until manual restart.
 *
 * ADDITIVE ONLY — does not modify any existing trading logic.
 * Called from the tool layer before trade execution proceeds.
 *
 * Configuration via environment variables:
 *   MAX_SESSION_LOSS_USD    — max cumulative loss before halt (default: 0 = disabled)
 *   MAX_DAILY_LOSS_USD      — max loss per calendar day (default: 0 = disabled)
 *   MAX_TRADES_PER_SESSION  — max trade count per session (default: 0 = disabled)
 */

import { getLogger } from '../utils/logger.js';

// ─── Configuration ──────────────────────────────────────────────────────────

export interface CircuitBreakerConfig {
  /** Max cumulative realized loss in a session (USD). 0 = disabled. */
  maxSessionLossUsd: number;
  /** Max cumulative realized loss per calendar day (USD). 0 = disabled. */
  maxDailyLossUsd: number;
  /** Max number of trades per session. 0 = disabled. */
  maxTradesPerSession: number;
}

function loadConfigFromEnv(): CircuitBreakerConfig {
  const parse = (key: string, fallback: number): number => {
    const val = process.env[key];
    if (!val) return fallback;
    const n = parseFloat(val);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  return {
    maxSessionLossUsd: parse('MAX_SESSION_LOSS_USD', 0),
    maxDailyLossUsd: parse('MAX_DAILY_LOSS_USD', 0),
    maxTradesPerSession: parse('MAX_TRADES_PER_SESSION', 0),
  };
}

// ─── State ──────────────────────────────────────────────────────────────────

export interface CircuitBreakerState {
  /** Whether trading is currently halted */
  tripped: boolean;
  /** Reason for the halt */
  tripReason: string;
  /** Cumulative realized loss this session (positive = loss) */
  sessionLossUsd: number;
  /** Cumulative realized loss today (positive = loss) */
  dailyLossUsd: number;
  /** Number of trades executed this session */
  sessionTradeCount: number;
  /** Date string (YYYY-MM-DD) for daily reset */
  currentDay: string;
}

// ─── Check Result ───────────────────────────────────────────────────────────

export interface CircuitBreakerCheck {
  allowed: boolean;
  reason?: string;
}

// ─── Circuit Breaker ────────────────────────────────────────────────────────

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: CircuitBreakerState;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    const envConfig = loadConfigFromEnv();
    this.config = { ...envConfig, ...config };
    this.state = {
      tripped: false,
      tripReason: '',
      sessionLossUsd: 0,
      dailyLossUsd: 0,
      sessionTradeCount: 0,
      currentDay: this.todayStr(),
    };
  }

  private todayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Check if trading is allowed. Called before every trade execution. */
  check(): CircuitBreakerCheck {
    // If already tripped, stay tripped until manual reset
    if (this.state.tripped) {
      return { allowed: false, reason: `Circuit breaker tripped: ${this.state.tripReason}` };
    }

    // Reset daily counter on day change
    const today = this.todayStr();
    if (today !== this.state.currentDay) {
      this.state.dailyLossUsd = 0;
      this.state.currentDay = today;
    }

    // Check session loss limit
    if (this.config.maxSessionLossUsd > 0 && this.state.sessionLossUsd >= this.config.maxSessionLossUsd) {
      this.trip(
        `Session loss limit reached: $${this.state.sessionLossUsd.toFixed(2)} >= $${this.config.maxSessionLossUsd.toFixed(2)}`,
      );
      return { allowed: false, reason: this.state.tripReason };
    }

    // Check daily loss limit
    if (this.config.maxDailyLossUsd > 0 && this.state.dailyLossUsd >= this.config.maxDailyLossUsd) {
      this.trip(
        `Daily loss limit reached: $${this.state.dailyLossUsd.toFixed(2)} >= $${this.config.maxDailyLossUsd.toFixed(2)}`,
      );
      return { allowed: false, reason: this.state.tripReason };
    }

    // Check session trade count
    if (this.config.maxTradesPerSession > 0 && this.state.sessionTradeCount >= this.config.maxTradesPerSession) {
      this.trip(`Session trade limit reached: ${this.state.sessionTradeCount} >= ${this.config.maxTradesPerSession}`);
      return { allowed: false, reason: this.state.tripReason };
    }

    return { allowed: true };
  }

  /** Record a completed trade and its PnL. Positive PnL = profit, negative = loss. */
  recordTrade(pnl: number): void {
    this.state.sessionTradeCount++;

    if (Number.isFinite(pnl) && pnl < 0) {
      const loss = Math.abs(pnl);
      this.state.sessionLossUsd += loss;
      this.state.dailyLossUsd += loss;
    }

    // Check immediately after recording
    const check = this.check();
    if (!check.allowed) {
      getLogger().warn('CIRCUIT_BREAKER', `Trading halted: ${check.reason}`);
    }
  }

  /** Record a trade that opened (no PnL yet, just count it) */
  recordOpen(): void {
    this.state.sessionTradeCount++;

    // Check trade count limit
    if (this.config.maxTradesPerSession > 0 && this.state.sessionTradeCount >= this.config.maxTradesPerSession) {
      this.trip(`Session trade limit reached: ${this.state.sessionTradeCount} >= ${this.config.maxTradesPerSession}`);
      getLogger().warn('CIRCUIT_BREAKER', `Trading halted: ${this.state.tripReason}`);
    }
  }

  private trip(reason: string): void {
    this.state.tripped = true;
    this.state.tripReason = reason;
    getLogger().warn('CIRCUIT_BREAKER', `TRIPPED: ${reason}`);
  }

  /** Manual reset — requires explicit action to resume trading after a trip. */
  reset(): void {
    this.state.tripped = false;
    this.state.tripReason = '';
    this.state.sessionLossUsd = 0;
    this.state.dailyLossUsd = 0;
    this.state.sessionTradeCount = 0;
    getLogger().info('CIRCUIT_BREAKER', 'Circuit breaker manually reset');
  }

  /** Get current state (read-only snapshot for display) */
  getState(): Readonly<CircuitBreakerState> {
    return { ...this.state };
  }

  /** Get configuration (read-only) */
  getConfig(): Readonly<CircuitBreakerConfig> {
    return { ...this.config };
  }

  /** Check if any limits are configured (non-zero) */
  get isConfigured(): boolean {
    return this.config.maxSessionLossUsd > 0 || this.config.maxDailyLossUsd > 0 || this.config.maxTradesPerSession > 0;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: CircuitBreaker | null = null;

export function getCircuitBreaker(): CircuitBreaker {
  if (!_instance) {
    _instance = new CircuitBreaker();
  }
  return _instance;
}

export function initCircuitBreaker(config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
  _instance = new CircuitBreaker(config);
  return _instance;
}
