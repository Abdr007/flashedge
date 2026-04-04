/**
 * Runtime Stability Tests
 *
 * Validates: idle detection, scheduler throttling, circuit breaker states,
 * degraded mode, READ-ONLY enforcement.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initRuntimeState,
  getRuntimeState,
  shutdownRuntimeState,
  RuntimeState,
  TaskPriority,
} from '../src/core/runtime-state.js';
import {
  initScheduler,
  getScheduler,
  shutdownScheduler,
  CentralScheduler,
} from '../src/core/scheduler.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cleanup(): void {
  shutdownScheduler();
  shutdownRuntimeState();
}

// ─── Runtime State Machine ────────────────────────────────────────────────────

describe('RuntimeStateMachine', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('starts in ACTIVE state', () => {
    const rt = initRuntimeState();
    rt.start();
    expect(rt.current).toBe(RuntimeState.ACTIVE);
  });

  it('markDegraded transitions to DEGRADED', () => {
    const rt = initRuntimeState();
    rt.start();
    rt.markDegraded();
    expect(rt.current).toBe(RuntimeState.DEGRADED);
    expect(rt.isReadOnly).toBe(true);
  });

  it('markRecovered exits DEGRADED', () => {
    const rt = initRuntimeState();
    rt.start();
    rt.markDegraded();
    rt.markRecovered();
    expect(rt.current).toBe(RuntimeState.ACTIVE);
    expect(rt.isReadOnly).toBe(false);
  });

  it('markActive does not exit DEGRADED (requires markRecovered)', () => {
    const rt = initRuntimeState();
    rt.start();
    rt.markDegraded();
    rt.markActive();
    expect(rt.current).toBe(RuntimeState.DEGRADED);
  });

  it('fires state change listeners', () => {
    const rt = initRuntimeState();
    rt.start();
    const transitions: string[] = [];
    rt.onStateChange((prev, next) => transitions.push(`${prev}->${next}`));
    rt.markDegraded();
    rt.markRecovered();
    expect(transitions).toEqual([
      'ACTIVE->DEGRADED',
      'DEGRADED->ACTIVE',
    ]);
  });

  it('snapshot returns correct structure', () => {
    const rt = initRuntimeState();
    rt.start();
    const snap = rt.snapshot();
    expect(snap.state).toBe(RuntimeState.ACTIVE);
    expect(snap.rpcDown).toBe(false);
    expect(snap.idleDurationMs).toBe(0);
    expect(typeof snap.since).toBe('number');
    expect(typeof snap.lastActivity).toBe('number');
  });

  it('ACTIVE throttle multipliers are all 1', () => {
    const rt = initRuntimeState();
    rt.start();
    expect(rt.getThrottle(TaskPriority.CRITICAL)).toBe(1);
    expect(rt.getThrottle(TaskPriority.NORMAL)).toBe(1);
    expect(rt.getThrottle(TaskPriority.LOW)).toBe(1);
  });

  it('DEGRADED throttle multipliers are 1/2/5', () => {
    const rt = initRuntimeState();
    rt.start();
    rt.markDegraded();
    expect(rt.getThrottle(TaskPriority.CRITICAL)).toBe(1);
    expect(rt.getThrottle(TaskPriority.NORMAL)).toBe(2);
    expect(rt.getThrottle(TaskPriority.LOW)).toBe(5);
  });

  it('singleton pattern works', () => {
    const rt1 = initRuntimeState();
    const rt2 = getRuntimeState();
    expect(rt1).toBe(rt2);
  });

  it('shutdown cleans up', () => {
    const rt = initRuntimeState();
    rt.start();
    shutdownRuntimeState();
    expect(getRuntimeState()).toBeNull();
  });
});

// ─── Central Scheduler ────────────────────────────────────────────────────────

describe('CentralScheduler', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('registers and executes tasks', async () => {
    const rt = initRuntimeState();
    rt.start();
    const sched = initScheduler();

    let count = 0;
    sched.register({
      name: 'test-task',
      fn: () => { count++; },
      baseIntervalMs: 50,
      priority: TaskPriority.NORMAL,
    });
    sched.start();

    await new Promise((r) => setTimeout(r, 180));
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('unregister stops task', async () => {
    const rt = initRuntimeState();
    rt.start();
    const sched = initScheduler();

    let count = 0;
    sched.register({
      name: 'test-unreg',
      fn: () => { count++; },
      baseIntervalMs: 50,
      priority: TaskPriority.NORMAL,
    });
    sched.start();

    await new Promise((r) => setTimeout(r, 120));
    const before = count;
    sched.unregister('test-unreg');
    await new Promise((r) => setTimeout(r, 120));
    expect(count).toBe(before); // No more ticks
  });

  it('DEGRADED state throttles NORMAL tasks 2x', async () => {
    const rt = initRuntimeState();
    rt.start();
    const sched = initScheduler();

    sched.register({
      name: 'throttle-test',
      fn: () => {},
      baseIntervalMs: 100,
      priority: TaskPriority.NORMAL,
    });
    sched.start();

    rt.markDegraded();
    await new Promise((r) => setTimeout(r, 50));

    const status = sched.status();
    const task = status.find((s) => s.name === 'throttle-test');
    expect(task?.currentMs).toBe(200); // 100 * 2
  });

  it('DEGRADED state throttles LOW tasks 5x', async () => {
    const rt = initRuntimeState();
    rt.start();
    const sched = initScheduler();

    sched.register({
      name: 'low-test',
      fn: () => {},
      baseIntervalMs: 100,
      priority: TaskPriority.LOW,
    });
    sched.start();

    rt.markDegraded();
    await new Promise((r) => setTimeout(r, 50));

    const status = sched.status();
    const task = status.find((s) => s.name === 'low-test');
    expect(task?.currentMs).toBe(500); // 100 * 5
  });

  it('CRITICAL tasks are never throttled', async () => {
    const rt = initRuntimeState();
    rt.start();
    const sched = initScheduler();

    sched.register({
      name: 'crit-test',
      fn: () => {},
      baseIntervalMs: 100,
      priority: TaskPriority.CRITICAL,
    });
    sched.start();

    rt.markDegraded();
    await new Promise((r) => setTimeout(r, 50));

    const status = sched.status();
    const task = status.find((s) => s.name === 'crit-test');
    expect(task?.currentMs).toBe(100); // unchanged
  });

  it('recovery restores original intervals', async () => {
    const rt = initRuntimeState();
    rt.start();
    const sched = initScheduler();

    sched.register({
      name: 'recover-test',
      fn: () => {},
      baseIntervalMs: 100,
      priority: TaskPriority.NORMAL,
    });
    sched.start();

    rt.markDegraded();
    await new Promise((r) => setTimeout(r, 50));
    expect(sched.status().find((s) => s.name === 'recover-test')?.currentMs).toBe(200);

    rt.markRecovered();
    await new Promise((r) => setTimeout(r, 50));
    expect(sched.status().find((s) => s.name === 'recover-test')?.currentMs).toBe(100);
  });

  it('overlapping async tasks are guarded (no double-tick)', async () => {
    const rt = initRuntimeState();
    rt.start();
    const sched = initScheduler();

    let concurrent = 0;
    let maxConcurrent = 0;
    sched.register({
      name: 'overlap-test',
      fn: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 200)); // Longer than interval
        concurrent--;
      },
      baseIntervalMs: 50,
      priority: TaskPriority.NORMAL,
    });
    sched.start();

    await new Promise((r) => setTimeout(r, 400));
    expect(maxConcurrent).toBe(1); // Never >1 concurrent
  });

  it('status() returns all registered tasks', () => {
    const rt = initRuntimeState();
    rt.start();
    const sched = initScheduler();

    sched.register({ name: 'a', fn: () => {}, baseIntervalMs: 100, priority: TaskPriority.CRITICAL });
    sched.register({ name: 'b', fn: () => {}, baseIntervalMs: 200, priority: TaskPriority.NORMAL });
    sched.register({ name: 'c', fn: () => {}, baseIntervalMs: 300, priority: TaskPriority.LOW });
    sched.start();

    const status = sched.status();
    expect(status).toHaveLength(3);
    expect(status.map((s) => s.name).sort()).toEqual(['a', 'b', 'c']);
  });

  it('shutdown clears all timers', () => {
    const rt = initRuntimeState();
    rt.start();
    const sched = initScheduler();

    sched.register({ name: 'x', fn: () => {}, baseIntervalMs: 100, priority: TaskPriority.NORMAL });
    sched.start();
    sched.shutdown();

    expect(sched.size).toBe(0);
  });
});

// ─── Integration: State + Scheduler ───────────────────────────────────────────

describe('Runtime Integration', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('rapid state transitions do not crash', () => {
    const rt = initRuntimeState();
    rt.start();
    const sched = initScheduler();
    sched.register({ name: 'stress', fn: () => {}, baseIntervalMs: 50, priority: TaskPriority.NORMAL });
    sched.start();

    // Rapid fire
    for (let i = 0; i < 100; i++) {
      rt.markDegraded();
      rt.markRecovered();
      rt.markActive();
    }
    expect(rt.current).toBe(RuntimeState.ACTIVE);
  });

  it('task error does not crash scheduler', async () => {
    const rt = initRuntimeState();
    rt.start();
    const sched = initScheduler();

    let goodCount = 0;
    sched.register({
      name: 'bad-task',
      fn: () => { throw new Error('boom'); },
      baseIntervalMs: 50,
      priority: TaskPriority.NORMAL,
    });
    sched.register({
      name: 'good-task',
      fn: () => { goodCount++; },
      baseIntervalMs: 50,
      priority: TaskPriority.NORMAL,
    });
    sched.start();

    await new Promise((r) => setTimeout(r, 200));
    expect(goodCount).toBeGreaterThan(0); // Good task survived
  });

  it('async task rejection does not crash scheduler', async () => {
    const rt = initRuntimeState();
    rt.start();
    const sched = initScheduler();

    let goodCount = 0;
    sched.register({
      name: 'reject-task',
      fn: async () => { throw new Error('async boom'); },
      baseIntervalMs: 50,
      priority: TaskPriority.NORMAL,
    });
    sched.register({
      name: 'survivor',
      fn: () => { goodCount++; },
      baseIntervalMs: 50,
      priority: TaskPriority.NORMAL,
    });
    sched.start();

    await new Promise((r) => setTimeout(r, 200));
    expect(goodCount).toBeGreaterThan(0);
  });

  it('re-registering a task replaces the old one', () => {
    const rt = initRuntimeState();
    rt.start();
    const sched = initScheduler();
    sched.start();

    let first = 0;
    let second = 0;
    sched.register({ name: 'dup', fn: () => { first++; }, baseIntervalMs: 50, priority: TaskPriority.NORMAL });
    sched.register({ name: 'dup', fn: () => { second++; }, baseIntervalMs: 50, priority: TaskPriority.NORMAL });

    expect(sched.size).toBe(1);
  });
});
