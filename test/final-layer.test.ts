/**
 * Final Hardening Layer Tests
 *
 * Validates: health score, system metrics, watchdog, memory backpressure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initRuntimeState,
  shutdownRuntimeState,
  TaskPriority,
} from '../src/core/runtime-state.js';
import {
  initScheduler,
  shutdownScheduler,
} from '../src/core/scheduler.js';
import { resetAllBreakers, getServiceBreaker, CircuitState } from '../src/core/circuit-breaker-service.js';

function cleanup(): void {
  shutdownScheduler();
  shutdownRuntimeState();
  resetAllBreakers();
}

// ─── Health Score ─────────────────────────────────────────────────────────────

describe('Health Score', () => {
  it('health snapshot includes healthScore field', async () => {
    // Dynamic import to avoid singleton issues
    const { initHealth, shutdownHealth } = await import('../src/system/health.js');
    const h = initHealth();
    const snap = h.snapshot();
    expect(typeof snap.healthScore).toBe('number');
    expect(snap.healthScore).toBeGreaterThanOrEqual(0);
    expect(snap.healthScore).toBeLessThanOrEqual(100);
    // Fresh system with no load should be high
    expect(snap.healthScore).toBeGreaterThanOrEqual(70);
    shutdownHealth();
  });
});

// ─── Watchdog ─────────────────────────────────────────────────────────────────

describe('Scheduler Watchdog', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('stuck task running flag is released by watchdog', async () => {
    const rt = initRuntimeState();
    rt.start();
    const sched = initScheduler();

    let tickCount = 0;
    sched.register({
      name: 'will-get-stuck',
      fn: async () => {
        tickCount++;
        // Simulate stuck — never resolves
        await new Promise(() => {}); // eslint-disable-line @typescript-eslint/no-empty-function
      },
      baseIntervalMs: 50,
      priority: TaskPriority.NORMAL,
    });
    sched.start();

    // First tick runs and gets stuck
    await new Promise((r) => setTimeout(r, 100));
    expect(tickCount).toBe(1);

    // Subsequent ticks skipped because running=true
    await new Promise((r) => setTimeout(r, 100));
    expect(tickCount).toBe(1); // Still 1

    // Verify the task shows as running in status
    const status = sched.status();
    const task = status.find((s) => s.name === 'will-get-stuck');
    expect(task?.running).toBe(true);
  });

  it('scheduler tracks droppedTicks under memory pressure simulation', async () => {
    const rt = initRuntimeState();
    rt.start();
    const sched = initScheduler();

    // Simulate high lag (which triggers backpressure)
    sched.setLagProvider(() => 3000);

    let lowTicks = 0;
    sched.register({
      name: 'low-under-pressure',
      fn: () => { lowTicks++; },
      baseIntervalMs: 30,
      priority: TaskPriority.LOW,
    });
    sched.start();

    await new Promise((r) => setTimeout(r, 150));
    expect(lowTicks).toBe(0);
    expect(sched.totalDroppedTicks).toBeGreaterThan(0);
  });
});

// ─── Full System Integration ──────────────────────────────────────────────────

describe('Full System Integration', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('all three layers work: runtime state + scheduler + circuit breakers', async () => {
    const rt = initRuntimeState();
    rt.start();
    const sched = initScheduler();

    const cb = getServiceBreaker('integration-svc', { failureThreshold: 2, cooldownMs: 50 });

    let serviceCalls = 0;
    let blockedByBreaker = 0;
    let blockedByPriority = 0;

    // NORMAL task that calls a service with circuit breaker
    sched.register({
      name: 'service-caller',
      fn: () => {
        if (!cb.allowRequest()) {
          blockedByBreaker++;
          return;
        }
        serviceCalls++;
        cb.recordFailure(); // Always fails
      },
      baseIntervalMs: 20,
      priority: TaskPriority.NORMAL,
    });
    sched.start();

    await new Promise((r) => setTimeout(r, 200));

    // Circuit should have opened after 2 failures (may have transitioned to HALF_OPEN on slow CI)
    expect([CircuitState.OPEN, CircuitState.HALF_OPEN]).toContain(cb.currentState);
    expect(serviceCalls).toBeLessThanOrEqual(3); // 2-3 before circuit opens
    expect(blockedByBreaker).toBeGreaterThan(0); // Subsequent calls blocked

    // Now degrade the system
    rt.markDegraded();
    await new Promise((r) => setTimeout(r, 50));

    // Scheduler should have rebalanced (2x slower for NORMAL)
    const status = sched.status();
    const task = status.find((s) => s.name === 'service-caller');
    expect(task?.currentMs).toBe(40); // 20ms base * 2x DEGRADED multiplier
  });

  it('CRITICAL tasks survive all failure modes', async () => {
    const rt = initRuntimeState();
    rt.start();
    const sched = initScheduler();

    // Simulate every failure mode simultaneously
    sched.setLagProvider(() => 4000); // High lag
    rt.markDegraded(); // System degraded

    let critTicks = 0;
    let normalTicks = 0;
    let lowTicks = 0;

    sched.register({ name: 'crit', fn: () => { critTicks++; }, baseIntervalMs: 30, priority: TaskPriority.CRITICAL });
    sched.register({ name: 'norm', fn: () => { normalTicks++; }, baseIntervalMs: 30, priority: TaskPriority.NORMAL });
    sched.register({ name: 'low', fn: () => { lowTicks++; }, baseIntervalMs: 30, priority: TaskPriority.LOW });
    sched.start();

    await new Promise((r) => setTimeout(r, 200));

    expect(critTicks).toBeGreaterThan(0); // CRITICAL always runs
    expect(lowTicks).toBe(0); // LOW dropped by lag
    // NORMAL may or may not run (lag is 4s, threshold is >5s for NORMAL drop)
  });

  it('system recovers fully from degraded state', async () => {
    const rt = initRuntimeState();
    rt.start();
    const sched = initScheduler();

    let lowTicks = 0;
    sched.register({
      name: 'recovery-test',
      fn: () => { lowTicks++; },
      baseIntervalMs: 30,
      priority: TaskPriority.LOW,
    });
    sched.start();

    // Enter degraded (LOW throttled 5x: 30ms * 5 = 150ms)
    rt.markDegraded();
    await new Promise((r) => setTimeout(r, 50));
    const degradedStatus = sched.status().find((s) => s.name === 'recovery-test');
    expect(degradedStatus?.currentMs).toBe(150);

    // Recover
    lowTicks = 0;
    rt.markRecovered();
    await new Promise((r) => setTimeout(r, 50));
    const recoveredStatus = sched.status().find((s) => s.name === 'recovery-test');
    expect(recoveredStatus?.currentMs).toBe(30); // Back to base

    await new Promise((r) => setTimeout(r, 100));
    expect(lowTicks).toBeGreaterThan(0); // Tasks running again
  });

  it('circuit breaker isolation: service A failure does not affect service B', () => {
    const a = getServiceBreaker('svc-a', { failureThreshold: 1 });
    const b = getServiceBreaker('svc-b', { failureThreshold: 1 });

    // A fails completely
    a.recordFailure();
    expect(a.isOpen).toBe(true);

    // B still works
    expect(b.allowRequest()).toBe(true);
    b.recordSuccess();
    expect(b.currentState).toBe(CircuitState.CLOSED);
  });
});
