/**
 * Backpressure Control — prevents system overload from excessive inputs.
 *
 * Components:
 *   - AsyncSemaphore: limits concurrent async operations
 *   - CommandThrottle: debounces rapid user input
 *
 * Design:
 *   - Semaphore blocks (await) — never drops work silently
 *   - Throttle returns immediately — drops excess with user feedback
 *   - Both are lightweight (no timers, no polling)
 */

// ─── Async Semaphore ─────────────────────────────────────────────────────────

/**
 * Counting semaphore for limiting concurrent async operations.
 * Usage: `const release = await semaphore.acquire(); try { ... } finally { release(); }`
 */
export class AsyncSemaphore {
  private permits: number;
  private readonly maxPermits: number;
  private waitQueue: Array<() => void> = [];

  constructor(maxConcurrency: number) {
    this.permits = maxConcurrency;
    this.maxPermits = maxConcurrency;
  }

  /**
   * Acquire a permit. Resolves immediately if available,
   * otherwise waits until a permit is released.
   * Returns a release function.
   */
  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      return this.createRelease();
    }

    // Wait for a permit to become available
    return new Promise<() => void>((resolve) => {
      this.waitQueue.push(() => {
        this.permits--;
        resolve(this.createRelease());
      });
    });
  }

  /**
   * Try to acquire without waiting. Returns release function or null.
   */
  tryAcquire(): (() => void) | null {
    if (this.permits > 0) {
      this.permits--;
      return this.createRelease();
    }
    return null;
  }

  /** Current available permits */
  get available(): number {
    return this.permits;
  }

  /** Number of waiters in queue */
  get waiting(): number {
    return this.waitQueue.length;
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return; // Idempotent
      released = true;
      this.permits++;

      // Wake up next waiter if any
      if (this.waitQueue.length > 0) {
        const next = this.waitQueue.shift()!;
        next();
      }
    };
  }
}

// ─── Command Throttle ────────────────────────────────────────────────────────

/**
 * Prevents rapid-fire command execution.
 * Returns true if the command should proceed, false if throttled.
 */
export class CommandThrottle {
  private lastCommandTime = 0;
  private readonly minIntervalMs: number;
  private commandCount = 0;
  private windowStart = 0;
  private readonly maxPerWindow: number;
  private readonly windowMs: number;

  constructor(opts?: {
    /** Minimum ms between commands (default: 100ms) */
    minIntervalMs?: number;
    /** Max commands per window (default: 30) */
    maxPerWindow?: number;
    /** Window duration in ms (default: 10000ms / 10s) */
    windowMs?: number;
  }) {
    this.minIntervalMs = opts?.minIntervalMs ?? 100;
    this.maxPerWindow = opts?.maxPerWindow ?? 30;
    this.windowMs = opts?.windowMs ?? 10_000;
  }

  /**
   * Check if a command should be allowed.
   * Returns { allowed: true } or { allowed: false, reason: string }.
   */
  check(): { allowed: boolean; reason?: string } {
    const now = performance.now();

    // Minimum interval between commands
    if (now - this.lastCommandTime < this.minIntervalMs) {
      return { allowed: false, reason: 'Too fast — please wait' };
    }

    // Sliding window rate limit
    if (now - this.windowStart > this.windowMs) {
      // Reset window
      this.windowStart = now;
      this.commandCount = 0;
    }

    if (this.commandCount >= this.maxPerWindow) {
      return { allowed: false, reason: `Rate limit: ${this.maxPerWindow} commands per ${this.windowMs / 1000}s` };
    }

    this.lastCommandTime = now;
    this.commandCount++;
    return { allowed: true };
  }

  /** Reset throttle state */
  reset(): void {
    this.lastCommandTime = 0;
    this.commandCount = 0;
    this.windowStart = 0;
  }
}
