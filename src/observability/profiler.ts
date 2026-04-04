/**
 * Performance Profiler — opt-in latency tracking per category.
 *
 * Enable via FLASH_PROFILE=1.  When disabled every function is a no-op
 * so there is zero overhead on the hot path.
 *
 * Categories:
 *   command       — end-to-end command latency
 *   rpc           — RPC call latency
 *   simulation    — simulation computation time
 *   tx_broadcast  — transaction broadcast time
 *
 * Samples are stored in a fixed-size ring buffer (500 per category)
 * to bound memory regardless of session length.
 */

import { z } from 'zod';
import chalk from 'chalk';
import { ToolDefinition, ToolResult } from '../types/index.js';
import { theme } from '../cli/theme.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_SAMPLES_PER_CATEGORY = 500;

// ─── Ring Buffer ────────────────────────────────────────────────────────────

class RingBuffer {
  private buf: number[];
  private head = 0;
  private size = 0;
  private readonly cap: number;

  constructor(capacity: number) {
    this.cap = capacity;
    this.buf = new Array<number>(capacity);
  }

  push(value: number): void {
    this.buf[this.head] = value;
    this.head = (this.head + 1) % this.cap;
    if (this.size < this.cap) this.size++;
  }

  /** Return all stored samples (oldest first). */
  drain(): number[] {
    if (this.size === 0) return [];
    if (this.size < this.cap) {
      return this.buf.slice(0, this.size);
    }
    // Wrap: oldest starts at head (which is the next write position)
    return [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)];
  }

  count(): number {
    return this.size;
  }

  reset(): void {
    this.head = 0;
    this.size = 0;
  }
}

// ─── State ──────────────────────────────────────────────────────────────────

const buffers = new Map<string, RingBuffer>();

function getBuffer(category: string): RingBuffer {
  let rb = buffers.get(category);
  if (!rb) {
    rb = new RingBuffer(MAX_SAMPLES_PER_CATEGORY);
    buffers.set(category, rb);
  }
  return rb;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function isProfilingEnabled(): boolean {
  return process.env.FLASH_PROFILE === '1';
}

/**
 * Begin a profiling span.  Returns a high-resolution start timestamp.
 * When profiling is disabled returns 0 (callers should still pass it to
 * profileEnd — which will also be a no-op).
 */
export function profileStart(_category: string, _label?: string): number {
  if (!isProfilingEnabled()) return 0;
  return performance.now();
}

/**
 * End a profiling span and record the elapsed time (ms).
 */
export function profileEnd(category: string, startTime: number, _label?: string): void {
  if (!isProfilingEnabled()) return;
  if (startTime === 0) return;
  const elapsed = performance.now() - startTime;
  if (!Number.isFinite(elapsed) || elapsed < 0) return;
  getBuffer(category).push(elapsed);
}

export interface ProfilingStat {
  avg: number;
  min: number;
  max: number;
  p95: number;
  count: number;
}

/**
 * Compute summary statistics for every recorded category.
 */
export function getProfilingSummary(): Record<string, ProfilingStat> {
  const result: Record<string, ProfilingStat> = {};
  for (const [cat, rb] of buffers) {
    const samples = rb.drain();
    if (samples.length === 0) continue;
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);
    result[cat] = {
      avg: sum / sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      count: sorted.length,
    };
  }
  return result;
}

/**
 * Clear all recorded samples.
 */
export function resetProfiling(): void {
  for (const rb of buffers.values()) {
    rb.reset();
  }
}

// ─── Formatting helper ──────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 100) return `${ms.toFixed(0)}ms`;
  if (ms >= 10) return `${ms.toFixed(1)}ms`;
  return `${ms.toFixed(1)}ms`;
}

function pad(s: string, w: number): string {
  return s.padStart(w);
}

// ─── Tool Definition ────────────────────────────────────────────────────────

export const profilingSummaryTool: ToolDefinition = {
  name: 'profiling_summary',
  description: 'Display performance profiling summary',
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    if (!isProfilingEnabled()) {
      return {
        success: true,
        message: [
          '',
          `  ${theme.dim('Profiling is disabled.')}`,
          `  ${theme.dim('Set FLASH_PROFILE=1 to enable.')}`,
          '',
        ].join('\n'),
      };
    }

    const summary = getProfilingSummary();
    const categories = Object.keys(summary);

    if (categories.length === 0) {
      return {
        success: true,
        message: ['', `  ${theme.dim('Profiling enabled but no samples recorded yet.')}`, ''].join('\n'),
      };
    }

    const COL = { cat: 18, val: 9 };
    const header =
      chalk.gray('Category'.padEnd(COL.cat)) +
      chalk.gray(pad('Avg', COL.val)) +
      chalk.gray(pad('Min', COL.val)) +
      chalk.gray(pad('Max', COL.val)) +
      chalk.gray(pad('P95', COL.val)) +
      chalk.gray(pad('Count', COL.val));

    const lines = [
      '',
      `  ${theme.accentBold('Performance Profile')}`,
      `  ${theme.separator(COL.cat + COL.val * 5)}`,
      `  ${header}`,
    ];

    for (const cat of categories) {
      const s = summary[cat];
      const row =
        chalk.cyan(cat.padEnd(COL.cat)) +
        chalk.white(pad(fmtMs(s.avg), COL.val)) +
        chalk.green(pad(fmtMs(s.min), COL.val)) +
        chalk.red(pad(fmtMs(s.max), COL.val)) +
        chalk.yellow(pad(fmtMs(s.p95), COL.val)) +
        chalk.white(pad(String(s.count), COL.val));
      lines.push(`  ${row}`);
    }

    lines.push('');
    return { success: true, message: lines.join('\n') };
  },
};
