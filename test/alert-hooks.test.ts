/**
 * Tests for the alert hooks system.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AlertManager, ALERT_EVENT } from '../src/observability/alert-hooks.js';

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

describe('AlertManager', () => {
  let manager: AlertManager;

  beforeEach(() => {
    manager = new AlertManager();
  });

  it('fires registered handlers on emit', () => {
    const handler = vi.fn();
    manager.onAlert(handler);

    manager.emit('warning', 'test_event', 'Test message');
    expect(handler).toHaveBeenCalledTimes(1);

    const alert = handler.mock.calls[0][0];
    expect(alert.severity).toBe('warning');
    expect(alert.event).toBe('test_event');
    expect(alert.message).toBe('Test message');
    expect(alert.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('supports multiple handlers', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    manager.onAlert(h1);
    manager.onAlert(h2);

    manager.emit('info', 'test', 'msg');
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe removes handler', () => {
    const handler = vi.fn();
    const unsub = manager.onAlert(handler);

    manager.emit('info', 'test', 'msg');
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    manager.emit('info', 'test', 'msg');
    expect(handler).toHaveBeenCalledTimes(1); // not called again
  });

  it('silently catches handler errors', () => {
    manager.onAlert(() => { throw new Error('handler crashed'); });
    expect(() => manager.emit('info', 'test', 'msg')).not.toThrow();
  });

  it('silently catches async handler rejections', () => {
    manager.onAlert(async () => { throw new Error('async handler crashed'); });
    expect(() => manager.emit('info', 'test', 'msg')).not.toThrow();
  });

  it('stores recent alerts', () => {
    manager.emit('info', 'a', 'msg1');
    manager.emit('warning', 'b', 'msg2');
    manager.emit('critical', 'c', 'msg3');

    const recent = manager.getRecent();
    expect(recent.length).toBe(3);
    expect(recent[0].event).toBe('a');
    expect(recent[2].event).toBe('c');
  });

  it('limits recent alerts to 100', () => {
    for (let i = 0; i < 120; i++) {
      manager.emit('info', `event_${i}`, `msg_${i}`);
    }
    expect(manager.getRecent().length).toBe(100);
  });

  it('getRecent respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      manager.emit('info', `event_${i}`, `msg_${i}`);
    }
    const recent = manager.getRecent(3);
    expect(recent.length).toBe(3);
  });

  it('passes data to alerts', () => {
    const handler = vi.fn();
    manager.onAlert(handler);

    manager.emit('warning', 'test', 'msg', { market: 'SOL', side: 'long' });
    expect(handler.mock.calls[0][0].data).toEqual({ market: 'SOL', side: 'long' });
  });

  it('clearHandlers removes all handlers', () => {
    const handler = vi.fn();
    manager.onAlert(handler);
    manager.clearHandlers();

    manager.emit('info', 'test', 'msg');
    expect(handler).not.toHaveBeenCalled();
  });

  it('ALERT_EVENT constants are defined', () => {
    expect(ALERT_EVENT.CIRCUIT_BREAKER_TRIP).toBe('circuit_breaker_trip');
    expect(ALERT_EVENT.KILL_SWITCH_BLOCK).toBe('kill_switch_block');
    expect(ALERT_EVENT.RPC_FAILOVER).toBe('rpc_failover');
  });
});
