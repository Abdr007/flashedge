/**
 * Webhook Alert Consumer — sends alerts to a generic webhook endpoint.
 *
 * Configuration via environment:
 *   ALERT_WEBHOOK_URL — target URL (if unset, consumer is disabled)
 *
 * ADDITIVE ONLY — never blocks the trading pipeline.
 * All requests are fire-and-forget with timeout.
 */

import { getAlertManager, type Alert, type AlertSeverity } from '../alert-hooks.js';
import { getLogger } from '../../utils/logger.js';

const WEBHOOK_TIMEOUT_MS = 5_000;

export interface WebhookConsumerConfig {
  url: string;
  /** Minimum severity to forward (default: 'warning') */
  minSeverity?: AlertSeverity;
  /** Custom headers */
  headers?: Record<string, string>;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

/**
 * Register a webhook alert consumer.
 * Returns an unsubscribe function.
 */
export function registerWebhookConsumer(config: WebhookConsumerConfig): () => void {
  const minRank = SEVERITY_RANK[config.minSeverity ?? 'warning'];

  return getAlertManager().onAlert(async (alert: Alert) => {
    if (SEVERITY_RANK[alert.severity] < minRank) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      await fetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...config.headers,
        },
        body: JSON.stringify({
          severity: alert.severity,
          event: alert.event,
          message: alert.message,
          timestamp: alert.timestamp,
          data: alert.data,
          source: 'bolt-terminal',
        }),
        signal: controller.signal,
      });
    } catch (err) {
      try {
        getLogger().debug('WEBHOOK', `Alert delivery failed: ${err}`);
      } catch {
        /* never throw */
      }
    } finally {
      clearTimeout(timeout);
    }
  });
}

/**
 * Auto-register webhook consumer from environment if ALERT_WEBHOOK_URL is set.
 * Returns unsubscribe function or null if not configured.
 */
export function autoRegisterWebhook(): (() => void) | null {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return null;

  const minSeverity = (process.env.ALERT_MIN_SEVERITY as AlertSeverity) ?? 'warning';

  try {
    getLogger().info('WEBHOOK', `Alert webhook registered: ${url.slice(0, 40)}...`);
  } catch {
    /* never throw */
  }

  return registerWebhookConsumer({ url, minSeverity });
}
