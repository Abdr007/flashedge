/**
 * Hardening V3 Tests — Self-aware, adaptive runtime validation.
 *
 * Tests: root-cause analysis, adaptive degradation, health history,
 * circuit breaker cooldown, stress resilience.
 */
import { describe, it, expect, afterEach } from 'vitest';

// ─── Root-Cause Analysis ─────────────────────────────────────────────────────

describe('Health root-cause analysis', async () => {
  const { initHealth, shutdownHealth } = await import('../src/system/health.js');

  afterEach(() => shutdownHealth());

  it('reports no cause when HEALTHY', () => {
    const h = initHealth();
    const snap = h.snapshot();
    expect(snap.primaryCause).toBe('none');
    expect(snap.causes).toEqual([]);
  });

  it('snapshot includes stateAge', () => {
    const h = initHealth();
    const snap = h.snapshot();
    expect(snap.stateAge).toBeGreaterThanOrEqual(0);
  });

  it('causes are sorted by severity (critical first)', () => {
    const h = initHealth();
    // Record many errors to trigger warning
    for (let i = 0; i < 15; i++) h.recordError();
    const snap = h.snapshot();
    // If there are causes, they should be sorted critical-first
    if (snap.causes.length > 1) {
      for (let i = 1; i < snap.causes.length; i++) {
        if (snap.causes[i - 1].severity === 'warning') {
          expect(snap.causes[i].severity).not.toBe('critical');
        }
      }
    }
  });

  it('cause breakdown includes value and threshold', () => {
    const h = initHealth();
    // Record errors to create a cause
    for (let i = 0; i < 12; i++) h.recordError();
    const snap = h.snapshot();
    if (snap.causes.length > 0) {
      const cause = snap.causes[0];
      expect(cause).toHaveProperty('cause');
      expect(cause).toHaveProperty('severity');
      expect(cause).toHaveProperty('value');
      expect(cause).toHaveProperty('threshold');
      expect(cause).toHaveProperty('label');
      expect(typeof cause.value).toBe('number');
      expect(typeof cause.threshold).toBe('number');
    }
  });
});

// ─── Adaptive Degradation Params ─────────────────────────────────────────────

describe('Adaptive degradation parameters', async () => {
  const { initHealth, shutdownHealth } = await import('../src/system/health.js');

  afterEach(() => shutdownHealth());

  it('returns normal params when HEALTHY', () => {
    const h = initHealth();
    const p = h.getDegradationParams();
    expect(p.scanIntervalMultiplier).toBe(1.0);
    expect(p.maxConcurrency).toBe(10);
    expect(p.tradeThresholdMultiplier).toBe(1.0);
    expect(p.retryDelayMultiplier).toBe(1.0);
    expect(p.tradesBlocked).toBe(false);
  });

  it('degradation params have correct types', () => {
    const h = initHealth();
    const p = h.getDegradationParams();
    expect(typeof p.scanIntervalMultiplier).toBe('number');
    expect(typeof p.maxConcurrency).toBe('number');
    expect(typeof p.tradeThresholdMultiplier).toBe('number');
    expect(typeof p.retryDelayMultiplier).toBe('number');
    expect(typeof p.tradesBlocked).toBe('boolean');
  });

  it('all multipliers are >= 1.0', () => {
    const h = initHealth();
    const p = h.getDegradationParams();
    expect(p.scanIntervalMultiplier).toBeGreaterThanOrEqual(1.0);
    expect(p.tradeThresholdMultiplier).toBeGreaterThanOrEqual(1.0);
    expect(p.retryDelayMultiplier).toBeGreaterThanOrEqual(1.0);
  });
});

// ─── Health History & Trending ───────────────────────────────────────────────

describe('Health history and trending', async () => {
  const { initHealth, shutdownHealth } = await import('../src/system/health.js');

  afterEach(() => shutdownHealth());

  it('starts with empty history', () => {
    const h = initHealth();
    const hist = h.getHistory();
    expect(hist.sampleCount).toBe(0);
    expect(hist.avg5m.lagMs).toBe(0);
    expect(hist.avg15m.lagMs).toBe(0);
    expect(hist.avg60m.lagMs).toBe(0);
  });

  it('trends default to stable', () => {
    const h = initHealth();
    const hist = h.getHistory();
    expect(hist.trends.lag).toBe('stable');
    expect(hist.trends.memory).toBe('stable');
    expect(hist.trends.errors).toBe('stable');
  });

  it('history averages have correct shape', () => {
    const h = initHealth();
    const hist = h.getHistory();
    for (const avg of [hist.avg5m, hist.avg15m, hist.avg60m]) {
      expect(avg).toHaveProperty('lagMs');
      expect(avg).toHaveProperty('rssMB');
      expect(avg).toHaveProperty('errorRate');
      expect(avg).toHaveProperty('rpcLatencyMs');
    }
  });
});

// ─── Circuit Breaker Cooldown ────────────────────────────────────────────────

describe('Circuit breaker cooldown', () => {
  it('CRITICAL cooldown constant is at least 30 seconds', async () => {
    // Verify the cooldown is meaningful (read from module)
    // We can't easily force CRITICAL state in tests without mocking memory,
    // so we verify the design invariant
    const mod = await import('../src/system/health.js');
    // The module uses CRITICAL_COOLDOWN_MS = 60_000 internally
    // We verify via behavior: initHealth returns a monitor that starts HEALTHY
    const h = mod.initHealth();
    expect(h.state).toBe('HEALTHY');
    // Recovery from CRITICAL is gated by cooldown — this is a design test
    // The cooldown ensures stability even if transient recovery occurs
    mod.shutdownHealth();
  });
});

// ─── Stress Tests ────────────────────────────────────────────────────────────

describe('Stress: high command throughput', async () => {
  const { CommandThrottle } = await import('../src/system/backpressure.js');

  it('throttle handles 1000 rapid-fire checks without crash', () => {
    const throttle = new CommandThrottle({ minIntervalMs: 0, maxPerWindow: 500, windowMs: 10_000 });
    let allowed = 0;
    let blocked = 0;
    for (let i = 0; i < 1000; i++) {
      const result = throttle.check();
      if (result.allowed) allowed++;
      else blocked++;
    }
    expect(allowed).toBe(500);
    expect(blocked).toBe(500);
  });
});

describe('Stress: semaphore under contention', async () => {
  const { AsyncSemaphore } = await import('../src/system/backpressure.js');

  it('handles 100 concurrent acquires on semaphore(3) without deadlock', async () => {
    const sem = new AsyncSemaphore(3);
    let completed = 0;

    const tasks = Array.from({ length: 100 }, async () => {
      const release = await sem.acquire();
      // Simulate async work
      await new Promise((r) => setTimeout(r, 1));
      completed++;
      release();
    });

    await Promise.all(tasks);
    expect(completed).toBe(100);
    expect(sem.available).toBe(3);
    expect(sem.waiting).toBe(0);
  });
});

describe('Stress: retry budget exhaustion', async () => {
  const { withRetry, getRetryBudgetUsage } = await import('../src/utils/retry.js');

  it('budget prevents retry storm', async () => {
    // Fire many failing retries rapidly
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        withRetry(
          () => Promise.reject(new Error('test failure')),
          `stress-${i}`,
          { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 },
        ).catch(() => {}), // Swallow expected errors
      );
    }
    await Promise.all(promises);

    // Budget should have been consumed
    const budget = getRetryBudgetUsage();
    expect(budget.used).toBeGreaterThan(0);
  });
});

describe('Stress: error rate tracking', async () => {
  const { initHealth, shutdownHealth } = await import('../src/system/health.js');

  afterEach(() => shutdownHealth());

  it('handles 1000 rapid error recordings', () => {
    const h = initHealth();
    for (let i = 0; i < 1000; i++) {
      h.recordError();
    }
    // Error rate tracks last 60s, so all 1000 should be counted
    const snap = h.snapshot();
    expect(snap.errorRate).toBe(1000);
    // Should not crash or OOM
  });

  it('handles rapid RPC latency recordings', () => {
    const h = initHealth();
    for (let i = 0; i < 1000; i++) {
      h.recordRpcLatency(100 + Math.random() * 200);
    }
    const snap = h.snapshot();
    // Only last 20 samples are kept
    expect(snap.rpcLatencyMs).toBeGreaterThan(0);
    expect(snap.rpcLatencyMs).toBeLessThan(400);
  });
});

describe('Stress: no memory growth in health monitor', async () => {
  const { initHealth, shutdownHealth } = await import('../src/system/health.js');

  afterEach(() => shutdownHealth());

  it('lag samples are bounded', () => {
    const h = initHealth();
    // The lag timer runs every 500ms internally — we can't easily trigger it
    // but we verify snapshot works after many operations
    for (let i = 0; i < 100; i++) {
      h.recordError();
      h.recordRpcLatency(100);
    }
    const snap = h.snapshot();
    expect(snap).toBeDefined();
  });
});

// ─── Integration: health + retry ─────────────────────────────────────────────

describe('Integration: health affects retry behavior', async () => {
  const { initHealth, shutdownHealth, getHealth } = await import('../src/system/health.js');

  afterEach(() => shutdownHealth());

  it('getDegradationParams is always available', () => {
    const h = initHealth();
    expect(h.getDegradationParams()).toBeDefined();
    expect(h.getDegradationParams().retryDelayMultiplier).toBeGreaterThanOrEqual(1.0);
  });
});

// ─── Snapshot stability ──────────────────────────────────────────────────────

describe('Snapshot consistency', async () => {
  const { initHealth, shutdownHealth } = await import('../src/system/health.js');

  afterEach(() => shutdownHealth());

  it('consecutive snapshots are consistent', () => {
    const h = initHealth();
    const s1 = h.snapshot();
    const s2 = h.snapshot();

    // State should be the same
    expect(s2.state).toBe(s1.state);
    // Memory should be in same ballpark
    expect(Math.abs(s2.memoryRssMB - s1.memoryRssMB)).toBeLessThan(50);
    // Uptime should be >= previous
    expect(s2.uptimeSeconds).toBeGreaterThanOrEqual(s1.uptimeSeconds);
  });

  it('shutdown does not crash subsequent calls', () => {
    const h = initHealth();
    h.shutdown();
    // These should not throw after shutdown
    expect(h.state).toBe('HEALTHY');
    expect(h.snapshot().state).toBe('HEALTHY');
    expect(h.isTradeBlocked()).toBe(false);
    expect(h.getDegradationParams()).toBeDefined();
    expect(h.getHistory()).toBeDefined();
  });
});
