/**
 * Shadow Event Logger — Observability for shadow trading engine.
 *
 * Emits structured log events for shadow trade execution:
 *   - shadow trade success/failure
 *   - shadow divergence detection
 *   - shadow engine enable/disable
 *
 * ADDITIVE ONLY — never blocks the live or shadow pipeline.
 * All methods are fire-and-forget; errors are swallowed.
 */

import { getLogger } from '../utils/logger.js';
import { getMetrics } from './metrics.js';
import type { ShadowTradeResult } from '../shadow/shadow-engine.js';
import type { RiskDivergence } from '../shadow/risk-mirror.js';

// ─── Shadow Metric Names ────────────────────────────────────────────────────

export const SHADOW_METRIC = {
  SHADOW_TRADE_SUCCESS: 'shadow_trade_success_total',
  SHADOW_TRADE_FAILURE: 'shadow_trade_failure_total',
  SHADOW_DIVERGENCE: 'shadow_divergence_total',
  SHADOW_LATENCY: 'shadow_latency_ms',
} as const;

// ─── Shadow Event Functions ─────────────────────────────────────────────────

/** Log a shadow trade result (success or failure). */
export function logShadowTrade(result: ShadowTradeResult): void {
  try {
    const metrics = getMetrics();
    if (result.success) {
      metrics.increment(SHADOW_METRIC.SHADOW_TRADE_SUCCESS);
    } else {
      metrics.increment(SHADOW_METRIC.SHADOW_TRADE_FAILURE);
    }
    metrics.record(SHADOW_METRIC.SHADOW_LATENCY, result.latencyMs);

    getLogger().debug('SHADOW', `Shadow ${result.action} ${result.success ? 'ok' : 'fail'}`, {
      event: result.success ? 'shadow_trade_success' : 'shadow_trade_failure',
      action: result.action,
      market: result.market,
      side: result.side,
      latencyMs: result.latencyMs,
      shadowPnl: result.shadowPnl,
      shadowBalance: result.shadowBalance,
      error: result.error,
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* observability must never throw */
  }
}

/** Log a risk mirror divergence. */
export function logShadowDivergence(divergence: RiskDivergence): void {
  try {
    getMetrics().increment(SHADOW_METRIC.SHADOW_DIVERGENCE);
    getLogger().warn('SHADOW', `Divergence: ${divergence.message}`, {
      event: 'shadow_divergence',
      type: divergence.type,
      liveValue: divergence.liveValue,
      shadowValue: divergence.shadowValue,
      delta: divergence.delta,
      timestamp: divergence.timestamp,
    });
  } catch {
    /* observability must never throw */
  }
}

/** Log shadow engine state change. */
export function logShadowStateChange(enabled: boolean): void {
  try {
    getLogger().info('SHADOW', `Shadow trading ${enabled ? 'enabled' : 'disabled'}`, {
      event: 'shadow_state_change',
      enabled,
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* observability must never throw */
  }
}
