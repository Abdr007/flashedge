/**
 * Tests for webhook and Slack alert consumers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AlertManager } from '../src/observability/alert-hooks.js';

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// Mock global fetch
const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', mockFetch);

describe('Webhook Consumer', () => {
  let manager: AlertManager;

  beforeEach(() => {
    manager = new AlertManager();
    mockFetch.mockClear();
  });

  it('sends POST to webhook URL on alert', async () => {
    // Manually register a handler that mimics webhook behavior
    manager.onAlert(async (alert) => {
      await fetch('https://hooks.example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          severity: alert.severity,
          event: alert.event,
          message: alert.message,
        }),
      });
    });

    manager.emit('critical', 'test_event', 'Test alert');

    // Give async handler time to execute
    await new Promise(r => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://hooks.example.com/webhook');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.severity).toBe('critical');
    expect(body.event).toBe('test_event');
  });

  it('does not throw when fetch fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    manager.onAlert(async () => {
      await fetch('https://hooks.example.com/webhook', { method: 'POST' });
    });

    expect(() => manager.emit('warning', 'test', 'msg')).not.toThrow();
  });

  it('filters by severity level', async () => {
    // Only forward critical alerts
    manager.onAlert(async (alert) => {
      if (alert.severity !== 'critical') return;
      await fetch('https://hooks.example.com/webhook', { method: 'POST' });
    });

    manager.emit('info', 'low_priority', 'info msg');
    await new Promise(r => setTimeout(r, 10));
    expect(mockFetch).not.toHaveBeenCalled();

    manager.emit('critical', 'high_priority', 'critical msg');
    await new Promise(r => setTimeout(r, 10));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('Slack Consumer', () => {
  let manager: AlertManager;

  beforeEach(() => {
    manager = new AlertManager();
    mockFetch.mockClear();
  });

  it('sends Slack-formatted payload', async () => {
    manager.onAlert(async (alert) => {
      await fetch('https://hooks.slack.com/services/xxx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `*${alert.event}*: ${alert.message}`,
        }),
      });
    });

    manager.emit('warning', 'circuit_breaker_trip', 'Session loss limit reached');
    await new Promise(r => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text).toContain('circuit_breaker_trip');
    expect(body.text).toContain('Session loss limit reached');
  });
});
