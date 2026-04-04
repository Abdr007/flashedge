/**
 * Runtime State Machine — controls system-wide behavior based on activity.
 *
 * States:
 *   ACTIVE   — user interacting or agent running; normal polling
 *   IDLE     — no input for IDLE_THRESHOLD_MS; reduce all background activity
 *   DEGRADED — RPC/Pyth failures; safe mode with backoff
 *
 * Transitions are deterministic and logged.
 */

import { getLogger } from '../utils/logger.js';

// ─── State Definitions ────────────────────────────────────────────────────

export enum RuntimeState {
  ACTIVE = 'ACTIVE',
  IDLE = 'IDLE',
  DEGRADED = 'DEGRADED',
}

export enum TaskPriority {
  /** Always runs at normal interval (event loop lag, heartbeat) */
  CRITICAL = 'CRITICAL',
  /** Throttled 5x in IDLE, 2x in DEGRADED */
  NORMAL = 'NORMAL',
  /** Suspended in IDLE, throttled 5x in DEGRADED */
  LOW = 'LOW',
}

export interface RuntimeStateSnapshot {
  state: RuntimeState;
  since: number;
  lastActivity: number;
  idleDurationMs: number;
  rpcDown: boolean;
}

// ─── Configuration ────────────────────────────────────────────────────────

/** Transition to IDLE after this many ms of no user input */
const IDLE_THRESHOLD_MS = 60_000; // 60s

/** How often to check for idle transition (internal tick) */
const IDLE_CHECK_INTERVAL_MS = 10_000; // 10s

/** Multipliers for polling intervals per state+priority */
const THROTTLE_MAP: Record<RuntimeState, Record<TaskPriority, number>> = {
  [RuntimeState.ACTIVE]: {
    [TaskPriority.CRITICAL]: 1,
    [TaskPriority.NORMAL]: 1,
    [TaskPriority.LOW]: 1,
  },
  [RuntimeState.IDLE]: {
    [TaskPriority.CRITICAL]: 1,
    [TaskPriority.NORMAL]: 5,
    [TaskPriority.LOW]: 0, // 0 = suspended
  },
  [RuntimeState.DEGRADED]: {
    [TaskPriority.CRITICAL]: 1,
    [TaskPriority.NORMAL]: 2,
    [TaskPriority.LOW]: 5,
  },
};

// ─── State Machine ────────────────────────────────────────────────────────

type StateChangeListener = (prev: RuntimeState, next: RuntimeState) => void;

class RuntimeStateMachine {
  private state: RuntimeState = RuntimeState.ACTIVE;
  private stateSince: number = Date.now();
  private lastActivity: number = Date.now();
  private rpcDown = false;
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private listeners: StateChangeListener[] = [];
  private logger = getLogger();

  /** Start the idle-check timer. Call once at startup. */
  start(): void {
    if (this.idleCheckTimer) return;
    this.idleCheckTimer = setInterval(() => this.tick(), IDLE_CHECK_INTERVAL_MS);
    this.idleCheckTimer.unref();
    this.logger.info('RUNTIME', 'State machine started (state=ACTIVE)');
  }

  /** Stop the idle-check timer. Call on shutdown. */
  stop(): void {
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
  }

  /** Call on every user input / agent action to signal activity. */
  markActive(): void {
    this.lastActivity = Date.now();
    if (this.state === RuntimeState.IDLE) {
      this.transition(RuntimeState.ACTIVE);
    }
    // If DEGRADED, activity alone doesn't recover — RPC must come back
  }

  /** Call when RPC / external dependency failures exceed threshold. */
  markDegraded(): void {
    this.rpcDown = true;
    if (this.state !== RuntimeState.DEGRADED) {
      this.transition(RuntimeState.DEGRADED);
    }
  }

  /** Call when RPC recovers (at least one endpoint healthy). */
  markRecovered(): void {
    this.rpcDown = false;
    if (this.state === RuntimeState.DEGRADED) {
      // Recover to ACTIVE or IDLE depending on recent activity
      const idle = Date.now() - this.lastActivity > IDLE_THRESHOLD_MS;
      this.transition(idle ? RuntimeState.IDLE : RuntimeState.ACTIVE);
    }
  }

  /** Get the current runtime state. */
  get current(): RuntimeState {
    return this.state;
  }

  /** Get the throttle multiplier for a given task priority. 0 = suspended. */
  getThrottle(priority: TaskPriority): number {
    return THROTTLE_MAP[this.state][priority];
  }

  /** Whether the system should block trade execution. */
  get isReadOnly(): boolean {
    return this.rpcDown;
  }

  /** Snapshot for diagnostics. */
  snapshot(): RuntimeStateSnapshot {
    return {
      state: this.state,
      since: this.stateSince,
      lastActivity: this.lastActivity,
      idleDurationMs: this.state === RuntimeState.IDLE ? Date.now() - this.lastActivity : 0,
      rpcDown: this.rpcDown,
    };
  }

  /** Register a listener for state changes. */
  onStateChange(fn: StateChangeListener): void {
    this.listeners.push(fn);
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private tick(): void {
    if (this.state === RuntimeState.DEGRADED) return; // DEGRADED is sticky until recovery

    const elapsed = Date.now() - this.lastActivity;
    if (this.state === RuntimeState.ACTIVE && elapsed > IDLE_THRESHOLD_MS) {
      this.transition(RuntimeState.IDLE);
    }
  }

  private transition(next: RuntimeState): void {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    this.stateSince = Date.now();
    this.logger.info('RUNTIME', `State transition: ${prev} → ${next}`);
    for (const fn of this.listeners) {
      try {
        fn(prev, next);
      } catch {
        /* listener errors must not crash the state machine */
      }
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let instance: RuntimeStateMachine | null = null;

export function initRuntimeState(): RuntimeStateMachine {
  if (!instance) {
    instance = new RuntimeStateMachine();
  }
  return instance;
}

export function getRuntimeState(): RuntimeStateMachine | null {
  return instance;
}

export function shutdownRuntimeState(): void {
  instance?.stop();
  instance = null;
}
