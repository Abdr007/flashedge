/**
 * Structured Trade Event Logger — Observability for trade execution lifecycle.
 *
 * Emits structured log events at key points in the trading pipeline:
 *   - pre-trade gate checks (kill switch, circuit breaker, exposure)
 *   - trade execution start/success/failure
 *   - transaction submission
 *   - RPC latency
 *
 * Also increments metrics counters and fires alert hooks.
 *
 * ADDITIVE ONLY — does not modify any execution logic.
 * All methods are fire-and-forget; errors are swallowed to avoid
 * affecting the trade pipeline.
 */

import { getLogger } from '../utils/logger.js';
import { getMetrics, METRIC } from './metrics.js';
import { getAlertManager, ALERT_EVENT } from './alert-hooks.js';

// ─── Event Types ─────────────────────────────────────────────────────────

export interface TradeEvent {
  event: string;
  timestamp: string;
  [key: string]: unknown;
}

// ─── Trade Lifecycle Events ──────────────────────────────────────────────

/** Emitted when a trade is blocked by the kill switch. */
export function logKillSwitchBlock(market: string, side: string): void {
  try {
    getMetrics().increment(METRIC.KILL_SWITCH_BLOCKS);
    getAlertManager().emit(
      'critical',
      ALERT_EVENT.KILL_SWITCH_BLOCK,
      `Kill switch blocked ${side} trade on ${market}`,
      { market, side },
    );
    getLogger().warn('GATE', 'Kill switch blocked trade', {
      event: 'kill_switch_block',
      market,
      side,
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* observability must never throw */
  }
}

/** Emitted when a trade is blocked by exposure limits. */
export function logExposureBlock(
  market: string,
  side: string,
  sizeUsd: number,
  currentExposure: number,
  limit: number,
): void {
  try {
    getMetrics().increment(METRIC.EXPOSURE_BLOCKS);
    getAlertManager().emit(
      'warning',
      ALERT_EVENT.EXPOSURE_LIMIT_BLOCK,
      `Exposure limit blocked $${sizeUsd.toFixed(0)} ${side} on ${market}`,
      { market, side, sizeUsd, currentExposure, limit },
    );
    getLogger().warn('GATE', 'Exposure limit blocked trade', {
      event: 'exposure_block',
      market,
      side,
      sizeUsd,
      currentExposure,
      limit,
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* observability must never throw */
  }
}

/** Emitted when a trade is blocked by the circuit breaker. */
export function logCircuitBreakerBlock(market: string, side: string, reason: string): void {
  try {
    getMetrics().increment(METRIC.CIRCUIT_BREAKER_TRIPS);
    getAlertManager().emit(
      'critical',
      ALERT_EVENT.CIRCUIT_BREAKER_TRIP,
      `Circuit breaker blocked ${side} on ${market}: ${reason}`,
      { market, side, reason },
    );
    getLogger().warn('CIRCUIT_BREAKER', 'Circuit breaker blocked trade', {
      event: 'circuit_breaker_block',
      market,
      side,
      reason,
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* observability must never throw */
  }
}

/** Emitted when a trade execution begins (after confirmation). */
export function logTradeStart(
  type: 'open' | 'close' | 'add_collateral' | 'remove_collateral',
  market: string,
  side: string,
  details?: Record<string, unknown>,
): void {
  try {
    if (type === 'open') getMetrics().increment(METRIC.TRADE_OPEN);
    if (type === 'close') getMetrics().increment(METRIC.TRADE_CLOSE);
    getLogger().info('TRADE_EXEC', `${type.toUpperCase()} started`, {
      event: 'trade_start',
      type,
      market,
      side,
      ...details,
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* observability must never throw */
  }
}

/** Emitted when a trade execution succeeds. */
export function logTradeSuccess(
  type: 'open' | 'close' | 'partial_close' | 'add_collateral' | 'remove_collateral',
  market: string,
  side: string,
  details?: Record<string, unknown>,
): void {
  try {
    getMetrics().increment(METRIC.TRADE_SUCCESS);
    getLogger().info('TRADE_EXEC', `${type.toUpperCase()} succeeded`, {
      event: 'trade_success',
      type,
      market,
      side,
      ...details,
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* observability must never throw */
  }
}

/** Emitted when a trade execution fails. */
export function logTradeFailure(
  type: 'open' | 'close' | 'add_collateral' | 'remove_collateral',
  market: string,
  side: string,
  error: string,
): void {
  try {
    getMetrics().increment(METRIC.TRADE_FAILURE);
    getLogger().warn('TRADE_EXEC', `${type.toUpperCase()} failed`, {
      event: 'trade_failure',
      type,
      market,
      side,
      error,
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* observability must never throw */
  }
}

/** Emitted on transaction submission to track RPC latency. */
export function logTxSubmission(txSignature: string, durationMs: number, endpoint?: string): void {
  try {
    getMetrics().record(METRIC.RPC_LATENCY, durationMs);
    getLogger().info('TX', 'Transaction submitted', {
      event: 'tx_submit',
      txSignature,
      durationMs,
      endpoint,
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* observability must never throw */
  }
}

/** Emitted on transaction confirmation. */
export function logTxConfirmed(txSignature: string, durationMs: number): void {
  try {
    getMetrics().record(METRIC.TX_CONFIRM_TIME, durationMs);
    getLogger().info('TX', 'Transaction confirmed', {
      event: 'tx_confirmed',
      txSignature,
      durationMs,
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* observability must never throw */
  }
}

/** Emitted on transaction timeout/failure. */
export function logTxTimeout(txSignature: string, durationMs: number, error: string): void {
  try {
    getLogger().warn('TX', 'Transaction timeout/failure', {
      event: 'tx_timeout',
      txSignature,
      durationMs,
      error,
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* observability must never throw */
  }
}

/** Emitted when RPC latency exceeds threshold. */
export function logRpcLatency(endpoint: string, latencyMs: number, operation: string): void {
  try {
    getMetrics().record(METRIC.RPC_LATENCY, latencyMs);
    if (latencyMs > 5000) {
      getLogger().warn('RPC', `High latency: ${latencyMs}ms`, {
        event: 'rpc_high_latency',
        endpoint,
        latencyMs,
        operation,
        timestamp: new Date().toISOString(),
      });
    }
  } catch {
    /* observability must never throw */
  }
}
