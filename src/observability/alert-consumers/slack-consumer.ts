/**
 * Slack Alert Consumer — sends alerts to a Slack webhook.
 *
 * Configuration via environment:
 *   SLACK_WEBHOOK_URL — Slack incoming webhook URL
 *
 * ADDITIVE ONLY — never blocks the trading pipeline.
 */

import { getAlertManager, type Alert, type AlertSeverity } from '../alert-hooks.js';
import { getLogger } from '../../utils/logger.js';

const SLACK_TIMEOUT_MS = 5_000;

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  info: ':information_source:',
  warning: ':warning:',
  critical: ':rotating_light:',
};

export interface SlackConsumerConfig {
  webhookUrl: string;
  /** Minimum severity to forward (default: 'warning') */
  minSeverity?: AlertSeverity;
  /** Channel override */
  channel?: string;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

/**
 * Register a Slack alert consumer.
 * Returns an unsubscribe function.
 */
export function registerSlackConsumer(config: SlackConsumerConfig): () => void {
  const minRank = SEVERITY_RANK[config.minSeverity ?? 'warning'];

  return getAlertManager().onAlert(async (alert: Alert) => {
    if (SEVERITY_RANK[alert.severity] < minRank) return;

    const emoji = SEVERITY_EMOJI[alert.severity];
    const text = `${emoji} *Flash Terminal Alert*\n*${alert.event}*: ${alert.message}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);
    try {
      const payload: Record<string, unknown> = { text };
      if (config.channel) payload.channel = config.channel;

      await fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      try {
        getLogger().debug('SLACK', `Alert delivery failed: ${err}`);
      } catch {
        /* never throw */
      }
    } finally {
      clearTimeout(timeout);
    }
  });
}

/**
 * Auto-register Slack consumer from environment if SLACK_WEBHOOK_URL is set.
 */
export function autoRegisterSlack(): (() => void) | null {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return null;

  const minSeverity = (process.env.ALERT_MIN_SEVERITY as AlertSeverity) ?? 'warning';

  try {
    getLogger().info('SLACK', 'Slack alert consumer registered');
  } catch {
    /* never throw */
  }

  return registerSlackConsumer({ webhookUrl: url, minSeverity });
}
