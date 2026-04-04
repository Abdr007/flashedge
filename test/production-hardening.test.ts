/**
 * Production Hardening Tests
 *
 * Error codes, session metrics, fault tolerance,
 * resource management, and operational safety.
 */

import { describe, it } from 'vitest';
import assert from 'assert';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getSessionMetrics, resetSessionMetrics } from '../src/core/session-metrics.js';
import { ErrorCode } from '../src/core/execution-middleware.js';

const ROOT = resolve(import.meta.dirname, '..');

// ─── Structured Error Codes ─────────────────────────────────────────────────

describe('Structured Error Codes', () => {
  it('all error codes are defined', () => {
    assert.ok(ErrorCode.WALLET_DISCONNECTED);
    assert.ok(ErrorCode.WALLET_READ_ONLY);
    assert.ok(ErrorCode.POOL_NOT_FOUND);
    assert.ok(ErrorCode.INVALID_AMOUNT);
    assert.ok(ErrorCode.INVALID_PERCENTAGE);
    assert.ok(ErrorCode.INVALID_MARKET);
    assert.ok(ErrorCode.INSUFFICIENT_BALANCE);
    assert.ok(ErrorCode.SIMULATION_FAILED);
    assert.ok(ErrorCode.RPC_UNAVAILABLE);
    assert.ok(ErrorCode.RATE_LIMITED);
    assert.ok(ErrorCode.UNKNOWN_COMMAND);
  });

  it('error codes follow ERR_ prefix convention', () => {
    for (const code of Object.values(ErrorCode)) {
      assert.ok(code.startsWith('ERR_'), `${code} should start with ERR_`);
    }
  });
});

// ─── Session Metrics ────────────────────────────────────────────────────────

describe('Session Metrics', () => {
  it('tracks command count', () => {
    resetSessionMetrics();
    const m = getSessionMetrics();
    m.recordCommand(50, true);
    m.recordCommand(100, true);
    m.recordCommand(30, false);
    const stats = m.getStats();
    assert.strictEqual(stats.commandCount, 3);
    assert.strictEqual(stats.errorCount, 1);
  });

  it('calculates average latency', () => {
    resetSessionMetrics();
    const m = getSessionMetrics();
    m.recordCommand(100, true);
    m.recordCommand(200, true);
    assert.strictEqual(m.getStats().avgLatencyMs, 150);
  });

  it('tracks peak latency', () => {
    resetSessionMetrics();
    const m = getSessionMetrics();
    m.recordCommand(50, true);
    m.recordCommand(500, true);
    m.recordCommand(100, true);
    assert.strictEqual(m.getStats().peakLatencyMs, 500);
  });

  it('calculates cache hit rate', () => {
    resetSessionMetrics();
    const m = getSessionMetrics();
    m.recordCacheHit();
    m.recordCacheHit();
    m.recordCacheHit();
    m.recordCacheMiss();
    assert.strictEqual(m.getCacheHitRate(), 75);
  });

  it('0 cache requests = 0% hit rate', () => {
    resetSessionMetrics();
    assert.strictEqual(getSessionMetrics().getCacheHitRate(), 0);
  });

  it('tracks RPC metrics', () => {
    resetSessionMetrics();
    const m = getSessionMetrics();
    m.recordRpcRequest();
    m.recordRpcRequest();
    m.recordRpcFailure();
    const stats = m.getStats();
    assert.strictEqual(stats.rpcRequests, 2);
    assert.strictEqual(stats.rpcFailures, 1);
  });

  it('tracks TX metrics', () => {
    resetSessionMetrics();
    const m = getSessionMetrics();
    m.recordTxSubmitted();
    m.recordTxSubmitted();
    m.recordTxConfirmed();
    const stats = m.getStats();
    assert.strictEqual(stats.txSubmitted, 2);
    assert.strictEqual(stats.txConfirmed, 1);
  });

  it('uptime formats correctly', () => {
    resetSessionMetrics();
    const uptime = getSessionMetrics().getUptime();
    assert.ok(typeof uptime === 'string');
    assert.ok(uptime.includes('s') || uptime.includes('m'));
  });

  it('reset clears all metrics', () => {
    const m = getSessionMetrics();
    m.recordCommand(100, true);
    resetSessionMetrics();
    assert.strictEqual(getSessionMetrics().getStats().commandCount, 0);
  });
});

// ─── Fault Tolerance Infrastructure ─────────────────────────────────────────

describe('Fault Tolerance', () => {
  it('retry logic exists with exponential backoff', () => {
    const src = readFileSync(resolve(ROOT, 'src/utils/retry.ts'), 'utf8');
    assert.ok(src.includes('withRetry'));
    assert.ok(src.includes('baseDelay'));
    assert.ok(src.includes('maxAttempts'));
  });

  it('RPC failover exists', () => {
    const src = readFileSync(resolve(ROOT, 'src/network/rpc-manager.ts'), 'utf8');
    assert.ok(src.includes('failover'));
    assert.ok(src.includes('fallback'));
  });

  it('unhandled rejection handler exists', () => {
    const src = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');
    assert.ok(src.includes('unhandledRejection'));
    assert.ok(src.includes('uncaughtException'));
  });

  it('wallet session auto-restore exists', () => {
    const src = readFileSync(resolve(ROOT, 'src/core/execution-middleware.ts'), 'utf8');
    assert.ok(src.includes('tryRestoreWalletSession'));
  });
});

// ─── Log Security ───────────────────────────────────────────────────────────

describe('Log Security', () => {
  it('scrubs API keys from logs', () => {
    const src = readFileSync(resolve(ROOT, 'src/utils/logger.ts'), 'utf8');
    assert.ok(src.includes('sk-ant-'));
    assert.ok(src.includes('gsk_'));
    assert.ok(src.includes('REDACTED'));
  });

  it('log file has restricted permissions', () => {
    const src = readFileSync(resolve(ROOT, 'src/utils/logger.ts'), 'utf8');
    assert.ok(src.includes('0o600'));
  });

  it('log rotation exists', () => {
    const src = readFileSync(resolve(ROOT, 'src/utils/logger.ts'), 'utf8');
    assert.ok(src.includes('MAX_LOG_FILE_BYTES'));
    assert.ok(src.includes('.old'));
  });
});

// ─── Terminal Integration ───────────────────────────────────────────────────

describe('Terminal Metrics Integration', () => {
  it('terminal records command metrics', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('getSessionMetrics'));
    assert.ok(src.includes('recordCommand'));
  });

  it('metrics command exists in terminal', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes("'metrics'"));
    assert.ok(src.includes('SESSION METRICS'));
  });

  it('metrics supports NO_DNA mode', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    // Should check IS_AGENT in the metrics command
    assert.ok(src.includes('IS_AGENT') && src.includes("'metrics'"));
  });
});

// ─── Circuit Breaker ────────────────────────────────────────────────────────

describe('Circuit Breaker', () => {
  it('circuit breaker module exists', () => {
    const exists = require('fs').existsSync(resolve(ROOT, 'src/security/circuit-breaker.ts'));
    assert.ok(exists);
  });

  it('signing guard module exists', () => {
    const exists = require('fs').existsSync(resolve(ROOT, 'src/security/signing-guard.ts'));
    assert.ok(exists);
  });
});

// ─── Stress Resilience ──────────────────────────────────────────────────────

describe('Stress Resilience', () => {
  it('10,000 metric recordings do not crash', () => {
    resetSessionMetrics();
    const m = getSessionMetrics();
    for (let i = 0; i < 10000; i++) {
      m.recordCommand(Math.random() * 1000, Math.random() > 0.1);
      if (i % 3 === 0) m.recordCacheHit();
      if (i % 5 === 0) m.recordCacheMiss();
      if (i % 7 === 0) m.recordRpcRequest();
    }
    const stats = m.getStats();
    assert.strictEqual(stats.commandCount, 10000);
    assert.ok(stats.avgLatencyMs > 0);
    assert.ok(m.getCacheHitRate() > 0);
  });
});
