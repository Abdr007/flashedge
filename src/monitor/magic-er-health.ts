/**
 * Background health probe for the MagicBlock ER router.
 *
 * Pings `getBlockHeight` every 30s and records (a) success vs error, (b) RTT.
 * Exposes a snapshot the prompt status bar can read so the user gets a heads-up
 * when the ER is degraded BEFORE they sign trades against it.
 *
 * Usage:
 *   const mon = startErHealthMonitor('https://flashtrade.magicblock.app/');
 *   const status = mon.snapshot();   // { healthy, lastRttMs, lastErr, ... }
 *   mon.stop();                       // on shutdown
 */

import { Connection } from '@solana/web3.js';

export interface ErHealthSnapshot {
  endpoint: string;
  healthy: boolean;
  lastCheckAt: number;
  lastRttMs: number;
  lastBlockHeight: number;
  lastErr: string | null;
  consecutiveFailures: number;
}

export class ErHealthMonitor {
  private conn: Connection;
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: ErHealthSnapshot;

  constructor(public readonly endpoint: string) {
    this.conn = new Connection(endpoint, 'confirmed');
    this.state = {
      endpoint,
      healthy: true,
      lastCheckAt: 0,
      lastRttMs: 0,
      lastBlockHeight: 0,
      lastErr: null,
      consecutiveFailures: 0,
    };
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): ErHealthSnapshot {
    return { ...this.state };
  }

  private async tick(): Promise<void> {
    const start = Date.now();
    try {
      const h = await this.conn.getBlockHeight('confirmed');
      this.state = {
        ...this.state,
        healthy: true,
        lastCheckAt: Date.now(),
        lastRttMs: Date.now() - start,
        lastBlockHeight: h,
        lastErr: null,
        consecutiveFailures: 0,
      };
    } catch (err) {
      this.state = {
        ...this.state,
        healthy: false,
        lastCheckAt: Date.now(),
        lastRttMs: Date.now() - start,
        lastErr: (err as Error).message,
        consecutiveFailures: this.state.consecutiveFailures + 1,
      };
    }
  }
}

let _global: ErHealthMonitor | null = null;

export function startErHealthMonitor(endpoint: string): ErHealthMonitor {
  if (_global && _global.endpoint === endpoint) return _global;
  if (_global) _global.stop();
  _global = new ErHealthMonitor(endpoint);
  _global.start();
  return _global;
}

export function getErHealthMonitor(): ErHealthMonitor | null {
  return _global;
}
