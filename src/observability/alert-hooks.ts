/**
 * Alert Hooks — async notification system for operational events.
 *
 * Operators can register callbacks for critical events like:
 *   - circuit breaker trips
 *   - kill switch activations
 *   - repeated RPC failures
 *   - excessive trade failures
 *
 * ADDITIVE ONLY — never interrupts the trading pipeline.
 * All hooks run asynchronously and errors are silently caught.
 */

import { getLogger } from '../utils/logger.js';

// ─── Alert Types ─────────────────────────────────────────────────────────────

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  severity: AlertSeverity;
  event: string;
  message: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export type AlertHandler = (alert: Alert) => void | Promise<void>;

// ─── Well-Known Events ───────────────────────────────────────────────────────

export const ALERT_EVENT = {
  CIRCUIT_BREAKER_TRIP: 'circuit_breaker_trip',
  KILL_SWITCH_BLOCK: 'kill_switch_block',
  EXPOSURE_LIMIT_BLOCK: 'exposure_limit_block',
  RPC_FAILOVER: 'rpc_failover',
  RPC_ALL_DOWN: 'rpc_all_down',
  TRADE_FAILURE_STREAK: 'trade_failure_streak',
  SESSION_LOSS_WARNING: 'session_loss_warning',
} as const;

// ─── Alert Manager ───────────────────────────────────────────────────────────

export class AlertManager {
  private handlers: AlertHandler[] = [];
  private recentAlerts: Alert[] = [];
  private static readonly MAX_RECENT = 100;

  /** Register an alert handler. Returns unsubscribe function. */
  onAlert(handler: AlertHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /** Emit an alert to all registered handlers (async, non-blocking). */
  emit(severity: AlertSeverity, event: string, message: string, data?: Record<string, unknown>): void {
    const alert: Alert = {
      severity,
      event,
      message,
      timestamp: new Date().toISOString(),
      data,
    };

    // Store in recent alerts (bounded)
    this.recentAlerts.push(alert);
    if (this.recentAlerts.length > AlertManager.MAX_RECENT) {
      this.recentAlerts.shift();
    }

    // Log all alerts
    try {
      const logger = getLogger();
      if (severity === 'critical') {
        logger.warn('ALERT', `[${severity.toUpperCase()}] ${event}: ${message}`, data);
      } else {
        logger.info('ALERT', `[${severity.toUpperCase()}] ${event}: ${message}`, data);
      }
    } catch {
      /* logging must never throw */
    }

    // Fire all handlers asynchronously
    for (const handler of this.handlers) {
      try {
        const result = handler(alert);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(() => {
            /* handler errors are silenced */
          });
        }
      } catch {
        /* handler errors are silenced */
      }
    }
  }

  /** Get recent alerts (read-only). */
  getRecent(limit?: number): ReadonlyArray<Alert> {
    const n = limit ?? AlertManager.MAX_RECENT;
    return this.recentAlerts.slice(-n);
  }

  /** Clear all handlers. */
  clearHandlers(): void {
    this.handlers = [];
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: AlertManager | null = null;

export function getAlertManager(): AlertManager {
  if (!_instance) {
    _instance = new AlertManager();
  }
  return _instance;
}
