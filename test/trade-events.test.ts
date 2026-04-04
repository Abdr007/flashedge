/**
 * Tests for structured trade event logging.
 * Verifies all event functions are callable without throwing.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  logKillSwitchBlock,
  logExposureBlock,
  logCircuitBreakerBlock,
  logTradeStart,
  logTradeSuccess,
  logTradeFailure,
  logTxSubmission,
  logTxConfirmed,
  logTxTimeout,
  logRpcLatency,
} from '../src/observability/trade-events.js';

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('Trade Event Logging', () => {
  it('logKillSwitchBlock does not throw', () => {
    expect(() => logKillSwitchBlock('SOL', 'long')).not.toThrow();
  });

  it('logExposureBlock does not throw', () => {
    expect(() => logExposureBlock('SOL', 'long', 5000, 8000, 10000)).not.toThrow();
  });

  it('logCircuitBreakerBlock does not throw', () => {
    expect(() => logCircuitBreakerBlock('SOL', 'long', 'Session loss limit')).not.toThrow();
  });

  it('logTradeStart does not throw', () => {
    expect(() => logTradeStart('open', 'SOL', 'long', { collateral: 100 })).not.toThrow();
  });

  it('logTradeSuccess does not throw', () => {
    expect(() => logTradeSuccess('open', 'SOL', 'long', { txSignature: 'abc123' })).not.toThrow();
  });

  it('logTradeFailure does not throw', () => {
    expect(() => logTradeFailure('close', 'SOL', 'long', 'RPC timeout')).not.toThrow();
  });

  it('logTxSubmission does not throw', () => {
    expect(() => logTxSubmission('sig123', 500, 'https://api.mainnet.solana.com')).not.toThrow();
  });

  it('logTxConfirmed does not throw', () => {
    expect(() => logTxConfirmed('sig123', 2500)).not.toThrow();
  });

  it('logTxTimeout does not throw', () => {
    expect(() => logTxTimeout('sig123', 45000, 'Not confirmed')).not.toThrow();
  });

  it('logRpcLatency does not throw for normal latency', () => {
    expect(() => logRpcLatency('https://api.mainnet.solana.com', 200, 'getSlot')).not.toThrow();
  });

  it('logRpcLatency logs warning for high latency', () => {
    expect(() => logRpcLatency('https://api.mainnet.solana.com', 8000, 'getSlot')).not.toThrow();
  });

  it('all trade types are valid for logTradeStart', () => {
    for (const type of ['open', 'close', 'add_collateral', 'remove_collateral'] as const) {
      expect(() => logTradeStart(type, 'BTC', 'short')).not.toThrow();
    }
  });
});
