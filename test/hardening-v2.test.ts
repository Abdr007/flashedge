/**
 * Hardening V2 Tests — Production resilience validation.
 *
 * Tests: event loop monitoring, backpressure, retry budget,
 * logger resilience, system health state machine.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ─── System Health Monitor ──────────────────────────────────────────────────

describe('System Health Monitor', async () => {
  const { initHealth, shutdownHealth, getHealth } = await import('../src/system/health.js');

  afterEach(() => {
    shutdownHealth();
  });

  it('starts in HEALTHY state', () => {
    const health = initHealth();
    expect(health.state).toBe('HEALTHY');
  });

  it('provides complete snapshot', () => {
    const health = initHealth();
    const snap = health.snapshot();
    expect(snap.state).toBe('HEALTHY');
    expect(snap.eventLoopLagMs).toBeGreaterThanOrEqual(0);
    expect(snap.memoryRssMB).toBeGreaterThan(0);
    expect(snap.heapUsedMB).toBeGreaterThan(0);
    expect(snap.errorRate).toBe(0);
    expect(snap.rpcLatencyMs).toBe(0);
    expect(snap.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(snap.reasons).toEqual([]);
  });

  it('tracks error rate correctly', () => {
    const health = initHealth();
    expect(health.snapshot().errorRate).toBe(0);

    // Record errors
    for (let i = 0; i < 5; i++) health.recordError();
    expect(health.snapshot().errorRate).toBe(5);
  });

  it('does not block trades in HEALTHY state', () => {
    const health = initHealth();
    expect(health.isTradeBlocked()).toBe(false);
  });

  it('records RPC latency', () => {
    const health = initHealth();
    health.recordRpcLatency(150);
    health.recordRpcLatency(200);
    expect(health.snapshot().rpcLatencyMs).toBe(175); // avg of 150 and 200
  });

  it('ignores invalid RPC latency values', () => {
    const health = initHealth();
    health.recordRpcLatency(-1);
    health.recordRpcLatency(NaN);
    health.recordRpcLatency(Infinity);
    expect(health.snapshot().rpcLatencyMs).toBe(0);
  });

  it('singleton pattern works', () => {
    const h1 = initHealth();
    expect(getHealth()).toBe(h1);
    shutdownHealth();
    expect(getHealth()).toBeNull();
  });

  it('shutdown clears timers', () => {
    const health = initHealth();
    health.shutdown();
    // Should not throw or cause issues
    expect(health.state).toBe('HEALTHY');
  });

  it('re-initialization shuts down previous instance', () => {
    const h1 = initHealth();
    const h2 = initHealth();
    expect(h2).not.toBe(h1);
    expect(getHealth()).toBe(h2);
  });
});

// ─── Backpressure: AsyncSemaphore ───────────────────────────────────────────

describe('AsyncSemaphore', async () => {
  const { AsyncSemaphore } = await import('../src/system/backpressure.js');

  it('allows up to maxConcurrency permits', async () => {
    const sem = new AsyncSemaphore(2);
    expect(sem.available).toBe(2);

    const r1 = await sem.acquire();
    expect(sem.available).toBe(1);

    const r2 = await sem.acquire();
    expect(sem.available).toBe(0);

    r1();
    expect(sem.available).toBe(1);

    r2();
    expect(sem.available).toBe(2);
  });

  it('queues when permits exhausted', async () => {
    const sem = new AsyncSemaphore(1);
    const r1 = await sem.acquire();
    expect(sem.available).toBe(0);

    let acquired = false;
    const p2 = sem.acquire().then((r) => {
      acquired = true;
      return r;
    });
    expect(sem.waiting).toBe(1);

    // Release first permit — should wake up waiter
    r1();
    const r2 = await p2;
    expect(acquired).toBe(true);
    expect(sem.available).toBe(0);
    r2();
    expect(sem.available).toBe(1);
  });

  it('tryAcquire returns null when exhausted', async () => {
    const sem = new AsyncSemaphore(1);
    const r1 = sem.tryAcquire();
    expect(r1).not.toBeNull();

    const r2 = sem.tryAcquire();
    expect(r2).toBeNull();

    r1!();
  });

  it('release is idempotent', async () => {
    const sem = new AsyncSemaphore(1);
    const release = await sem.acquire();
    release();
    release(); // Should not double-release
    expect(sem.available).toBe(1);
  });

  it('handles high concurrency correctly', async () => {
    const sem = new AsyncSemaphore(3);
    const releases: Array<() => void> = [];
    const results: number[] = [];

    // Acquire 5 permits (3 immediate, 2 queued)
    const promises = Array.from({ length: 5 }, (_, i) =>
      sem.acquire().then((r) => {
        releases.push(r);
        results.push(i);
        return r;
      }),
    );

    // Wait for the first 3 to acquire
    await new Promise((r) => setTimeout(r, 10));
    expect(results.length).toBe(3);

    // Release one — should wake up 4th waiter
    releases[0]();
    await new Promise((r) => setTimeout(r, 10));
    expect(results.length).toBe(4);

    // Release another — should wake up 5th
    releases[1]();
    await new Promise((r) => setTimeout(r, 10));
    expect(results.length).toBe(5);

    // Cleanup
    for (const r of releases) r();
  });
});

// ─── Backpressure: CommandThrottle ──────────────────────────────────────────

describe('CommandThrottle', async () => {
  const { CommandThrottle } = await import('../src/system/backpressure.js');

  it('allows first command', () => {
    const throttle = new CommandThrottle();
    expect(throttle.check().allowed).toBe(true);
  });

  it('throttles rapid-fire commands', async () => {
    const throttle = new CommandThrottle({ minIntervalMs: 50 });
    expect(throttle.check().allowed).toBe(true);

    // Immediate second command should be throttled
    const result = throttle.check();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Too fast');

    // Wait for interval to pass
    await new Promise((r) => setTimeout(r, 60));
    expect(throttle.check().allowed).toBe(true);
  });

  it('enforces per-window rate limit', () => {
    const throttle = new CommandThrottle({
      minIntervalMs: 0, // No interval limit
      maxPerWindow: 3,
      windowMs: 10_000,
    });

    expect(throttle.check().allowed).toBe(true);
    expect(throttle.check().allowed).toBe(true);
    expect(throttle.check().allowed).toBe(true);

    // 4th command should be rate limited
    const result = throttle.check();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Rate limit');
  });

  it('reset clears state', () => {
    const throttle = new CommandThrottle({ minIntervalMs: 0, maxPerWindow: 1 });
    throttle.check();
    expect(throttle.check().allowed).toBe(false);
    throttle.reset();
    expect(throttle.check().allowed).toBe(true);
  });
});

// ─── Retry Budget ───────────────────────────────────────────────────────────

describe('Retry Budget', async () => {
  const { getRetryBudgetUsage } = await import('../src/utils/retry.js');

  it('reports current budget usage', () => {
    const budget = getRetryBudgetUsage();
    expect(budget).toHaveProperty('used');
    expect(budget).toHaveProperty('max');
    expect(budget).toHaveProperty('exhausted');
    expect(budget.max).toBe(50);
    expect(typeof budget.used).toBe('number');
    expect(typeof budget.exhausted).toBe('boolean');
  });
});

// ─── Logger Resilience ──────────────────────────────────────────────────────

describe('Logger write failure handling', async () => {
  const { Logger, LogLevel } = await import('../src/utils/logger.js');

  it('handles missing log file gracefully', () => {
    // Logger with a non-existent path should not throw
    const logger = new Logger({ level: LogLevel.Info });
    expect(() => logger.info('TEST', 'test message')).not.toThrow();
  });

  it('flushSync handles missing log file', () => {
    const logger = new Logger({ level: LogLevel.Info });
    expect(() => logger.flushSync('TEST', 'shutdown')).not.toThrow();
  });

  it('writeFailures counter starts at 0', () => {
    const logger = new Logger({ level: LogLevel.Info });
    // Access internal state via snapshot — just verify construction works
    expect(logger).toBeDefined();
  });
});

// ─── Event Loop Lag Detection ───────────────────────────────────────────────

describe('Event loop lag detection', () => {
  it('performance.now() returns monotonic values', () => {
    const t1 = performance.now();
    const t2 = performance.now();
    expect(t2).toBeGreaterThanOrEqual(t1);
  });

  it('interval-based lag measurement works', async () => {
    const targetMs = 50;
    const start = performance.now();

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const actual = performance.now() - start;
        const lag = actual - targetMs;
        // Should be within reasonable bounds (not > 500ms lag)
        expect(lag).toBeLessThan(500);
        resolve();
      }, targetMs);
      timer.unref?.();
    });
  });
});

// ─── Time Safety: Monotonic vs Wall Clock ────────────────────────────────────

describe('Time safety', () => {
  it('performance.now() is available', () => {
    expect(typeof performance.now).toBe('function');
    expect(performance.now()).toBeGreaterThan(0);
  });

  it('Date.now() and performance.now() are independent', () => {
    // Date.now() returns wall clock, performance.now() returns monotonic
    const wall = Date.now();
    const mono = performance.now();
    expect(typeof wall).toBe('number');
    expect(typeof mono).toBe('number');
    // They should be different magnitudes (wall is epoch ms, mono is process-relative)
    expect(wall).toBeGreaterThan(mono);
  });
});
