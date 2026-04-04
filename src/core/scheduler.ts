/**
 * Central Scheduler — manages ALL background polling loops.
 *
 * Every background timer registers here instead of using raw setInterval.
 * The scheduler auto-adjusts intervals based on RuntimeState:
 *   ACTIVE   → normal intervals
 *   IDLE     → NORMAL tasks throttled 5x, LOW tasks suspended
 *   DEGRADED → NORMAL tasks throttled 2x, LOW tasks throttled 5x
 *
 * Benefits:
 *   - Single point of control for all polling
 *   - No independent setInterval storms
 *   - Clean shutdown via scheduler.shutdown()
 *   - Observable: list all active timers for diagnostics
 */

import {
  RuntimeState,
  TaskPriority,
  getRuntimeState,
} from './runtime-state.js';
import { getLogger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface ManagedTask {
  /** Unique name for diagnostics */
  name: string;
  /** The function to execute on each tick */
  fn: () => void | Promise<void>;
  /** Base interval in ms (used in ACTIVE state) */
  baseIntervalMs: number;
  /** Priority determines throttling behavior */
  priority: TaskPriority;
}

interface ActiveTimer {
  task: ManagedTask;
  timer: ReturnType<typeof setInterval> | null;
  currentIntervalMs: number;
  lastRunAt: number;
  running: boolean; // guards against overlapping async executions
}

// ─── Scheduler ────────────────────────────────────────────────────────────

/** Memory threshold for backpressure (same as health.ts MEM_CRITICAL_BYTES) */
const MEM_BACKPRESSURE_BYTES = 2.5 * 1024 * 1024 * 1024; // 2.5 GB
const MEM_WARNING_BYTES = 1.8 * 1024 * 1024 * 1024; // 1.8 GB
const WATCHDOG_INTERVAL_MS = 30_000; // Check every 30s
const WATCHDOG_STUCK_THRESHOLD_MS = 60_000; // Task stuck for >60s

export class CentralScheduler {
  private timers = new Map<string, ActiveTimer>();
  private logger = getLogger();
  private started = false;
  private droppedTicks = 0;
  private lagProvider: (() => number) | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = Date.now();

  /** Register a managed task. Starts immediately if scheduler is running. */
  register(task: ManagedTask): void {
    if (this.timers.has(task.name)) {
      this.unregister(task.name);
    }
    const interval = this.computeInterval(task);
    const entry: ActiveTimer = {
      task,
      timer: null,
      currentIntervalMs: interval,
      lastRunAt: 0,
      running: false,
    };
    this.timers.set(task.name, entry);
    if (this.started) {
      this.startTimer(entry);
    }
  }

  /** Remove a managed task and clear its timer. */
  unregister(name: string): void {
    const entry = this.timers.get(name);
    if (entry) {
      if (entry.timer) clearInterval(entry.timer);
      this.timers.delete(name);
    }
  }

  /** Start all registered timers. Call once at startup. */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Listen for state changes to re-adjust intervals
    const runtime = getRuntimeState();
    runtime?.onStateChange(() => this.rebalance());

    for (const entry of this.timers.values()) {
      this.startTimer(entry);
    }

    // Watchdog: detect stuck tasks and frozen scheduler
    this.watchdogTimer = setInterval(() => this.watchdog(), WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref();

    this.logger.info('SCHEDULER', `Started with ${this.timers.size} tasks`);
  }

  /** Stop all timers. Call on shutdown. */
  shutdown(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    for (const entry of this.timers.values()) {
      if (entry.timer) {
        clearInterval(entry.timer);
        entry.timer = null;
      }
    }
    this.timers.clear();
    this.started = false;
  }

  /** Get diagnostics for all managed timers. */
  status(): Array<{
    name: string;
    priority: TaskPriority;
    baseMs: number;
    currentMs: number;
    suspended: boolean;
    running: boolean;
  }> {
    return Array.from(this.timers.values()).map((e) => ({
      name: e.task.name,
      priority: e.task.priority,
      baseMs: e.task.baseIntervalMs,
      currentMs: e.currentIntervalMs,
      suspended: e.timer === null && this.started,
      running: e.running,
    }));
  }

  /** Total number of registered tasks. */
  get size(): number {
    return this.timers.size;
  }

  /** Number of ticks dropped due to backpressure (event loop lag). */
  get totalDroppedTicks(): number {
    return this.droppedTicks;
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  /** Recompute all intervals and restart timers that changed. */
  private rebalance(): void {
    const runtime = getRuntimeState();
    const state = runtime?.current ?? RuntimeState.ACTIVE;
    this.logger.info('SCHEDULER', `Rebalancing ${this.timers.size} tasks for state=${state}`);

    for (const entry of this.timers.values()) {
      const newInterval = this.computeInterval(entry.task);
      const wasSuspended = entry.timer === null && this.started;
      const shouldSuspend = newInterval === 0;

      if (shouldSuspend && !wasSuspended) {
        // Suspend
        if (entry.timer) clearInterval(entry.timer);
        entry.timer = null;
        entry.currentIntervalMs = 0;
        this.logger.info('SCHEDULER', `Suspended: ${entry.task.name}`);
      } else if (!shouldSuspend && wasSuspended) {
        // Resume
        entry.currentIntervalMs = newInterval;
        this.startTimer(entry);
        this.logger.info('SCHEDULER', `Resumed: ${entry.task.name} (${newInterval}ms)`);
      } else if (!shouldSuspend && newInterval !== entry.currentIntervalMs) {
        // Interval changed — restart timer
        if (entry.timer) clearInterval(entry.timer);
        entry.currentIntervalMs = newInterval;
        this.startTimer(entry);
        this.logger.info('SCHEDULER', `Adjusted: ${entry.task.name} ${entry.currentIntervalMs}ms → ${newInterval}ms`);
      }
    }
  }

  /** Set a callback that returns current event loop lag in ms. */
  setLagProvider(fn: () => number): void {
    this.lagProvider = fn;
  }

  /** Watchdog: detect stuck tasks. */
  private watchdog(): void {
    const now = Date.now();
    for (const entry of this.timers.values()) {
      if (entry.running && entry.lastRunAt > 0) {
        const elapsed = now - entry.lastRunAt;
        if (elapsed > WATCHDOG_STUCK_THRESHOLD_MS) {
          this.logger.info(
            'WATCHDOG',
            `Task "${entry.task.name}" stuck for ${Math.round(elapsed / 1000)}s — forcing release`,
          );
          entry.running = false; // Unblock future ticks
        }
      }
    }
  }

  private getCurrentLagMs(): number {
    return this.lagProvider?.() ?? 0;
  }

  /** Check memory pressure for backpressure decisions. */
  private isMemoryPressure(): boolean {
    try {
      return process.memoryUsage.rss() >= MEM_WARNING_BYTES;
    } catch {
      return false;
    }
  }

  private isMemoryCritical(): boolean {
    try {
      return process.memoryUsage.rss() >= MEM_BACKPRESSURE_BYTES;
    } catch {
      return false;
    }
  }

  private computeInterval(task: ManagedTask): number {
    const runtime = getRuntimeState();
    const multiplier = runtime?.getThrottle(task.priority) ?? 1;
    if (multiplier === 0) return 0; // suspended
    return task.baseIntervalMs * multiplier;
  }

  private startTimer(entry: ActiveTimer): void {
    if (entry.currentIntervalMs <= 0) return;
    entry.timer = setInterval(() => this.tick(entry), entry.currentIntervalMs);
    entry.timer.unref();
  }

  private tick(entry: ActiveTimer): void {
    if (entry.running) return; // skip if previous tick still executing

    // ── Active backpressure: event loop lag + memory ──
    const lag = this.getCurrentLagMs();
    if (lag > 5000 || this.isMemoryCritical()) {
      // EMERGENCY: only CRITICAL tasks run
      if (entry.task.priority !== TaskPriority.CRITICAL) {
        this.droppedTicks++;
        return;
      }
    } else if (lag > 2000 || this.isMemoryPressure()) {
      // THROTTLE: drop LOW tasks
      if (entry.task.priority === TaskPriority.LOW) {
        this.droppedTicks++;
        return;
      }
    }

    entry.running = true;
    entry.lastRunAt = Date.now();
    try {
      const result = entry.task.fn();
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>)
          .catch(() => {
            /* task errors are silenced — tasks handle their own errors */
          })
          .finally(() => {
            entry.running = false;
          });
      } else {
        entry.running = false;
      }
    } catch {
      entry.running = false;
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let instance: CentralScheduler | null = null;

export function initScheduler(): CentralScheduler {
  if (!instance) {
    instance = new CentralScheduler();
  }
  return instance;
}

export function getScheduler(): CentralScheduler | null {
  return instance;
}

export function shutdownScheduler(): void {
  instance?.shutdown();
  instance = null;
}
