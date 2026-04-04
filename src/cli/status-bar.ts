import { Interface as ReadlineInterface } from 'readline';
import { IFlashClient } from '../types/index.js';
import { RpcManager } from '../network/rpc-manager.js';
import { getReconciler } from '../core/state-reconciliation.js';
import { getLogger } from '../utils/logger.js';
import { getScheduler } from '../core/scheduler.js';
import { TaskPriority } from '../core/runtime-state.js';
import { getErrorMessage } from '../utils/retry.js';

// ─── Status Bar ──────────────────────────────────────────────────────────────
//
// Lightweight status bar that updates the terminal title and renders a
// one-time visual bar below the prompt.
//
// Design constraints:
//   • No new network calls — reuses cached data from existing systems
//   • Suspends during command execution or monitor mode
//   • Uses terminal title (xterm OSC sequence) for live updates — zero visual spam
//   • One-time visual render on start/resume, then silent title-only updates
//   • Timer is unref'd so it doesn't prevent Node exit

const STATUS_INTERVAL_MS = 10_000;

interface StatusBarConfig {
  simulationMode: boolean;
  walletName: string;
}

interface CachedStatus {
  rpcLabel: string;
  latencyMs: number;
  network: string;
  walletName: string;
  positions: number;
  exposureUsd: number;
  mode: string;
  syncOk: boolean;
  slotLag: number;
  timestamp: number;
}

// ─── Latency Smoother ────────────────────────────────────────────────────────
// Rolling window average with outlier rejection.
// Prevents visual jitter from transient RPC spikes.

const LATENCY_WINDOW_SIZE = 5;
const OUTLIER_MULTIPLIER = 3;

class LatencySmoother {
  private buffer: number[] = [];

  /** Add a raw latency sample and return the smoothed value. */
  add(rawMs: number): number {
    if (rawMs <= 0) return this.average();

    // Outlier rejection: ignore single spike > 3× rolling average
    const avg = this.average();
    if (this.buffer.length >= 2 && avg > 0 && rawMs > avg * OUTLIER_MULTIPLIER) {
      // Skip this spike — return current average unchanged
      return avg;
    }

    this.buffer.push(rawMs);
    if (this.buffer.length > LATENCY_WINDOW_SIZE) {
      this.buffer.shift();
    }
    return this.average();
  }

  /** Current smoothed average, or 0 if no samples. */
  private average(): number {
    if (this.buffer.length === 0) return 0;
    const sum = this.buffer.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.buffer.length);
  }

  /** Reset the buffer (e.g. after RPC failover). */
  reset(): void {
    this.buffer.length = 0;
  }
}

export class StatusBar {
  private timer: ReturnType<typeof setInterval> | null = null;
  private initDelayTimer: ReturnType<typeof setTimeout> | null = null;
  private rl: ReadlineInterface;
  private client: IFlashClient;
  private rpcManager: RpcManager;
  private cfg: StatusBarConfig;
  private suspended = false;
  private lastStatus: CachedStatus | null = null;
  private active = false;
  /** Previous plain-text status for change detection */
  private prevPlainStatus = '';
  /** Rolling latency smoother */
  private latencySmoother = new LatencySmoother();

  constructor(rl: ReadlineInterface, client: IFlashClient, rpcManager: RpcManager, cfg: StatusBarConfig) {
    this.rl = rl;
    this.client = client;
    this.rpcManager = rpcManager;
    this.cfg = cfg;
  }

  /** Start periodic status bar updates. */
  start(): void {
    if (this.active) return;
    this.active = true;

    // Initial render after a brief delay to avoid stomping on startup output
    this.initDelayTimer = setTimeout(() => {
      this.initDelayTimer = null;
      if (this.active && !this.suspended) {
        this.refresh().catch(() => {});
      }
    }, 2_000);
    if (this.initDelayTimer.unref) this.initDelayTimer.unref();

    const refreshFn = (): void => {
      if (!this.suspended) {
        this.refresh().catch(() => {});
      }
    };
    const scheduler = getScheduler();
    if (scheduler) {
      scheduler.register({
        name: 'status-bar-refresh',
        fn: refreshFn,
        baseIntervalMs: STATUS_INTERVAL_MS,
        priority: TaskPriority.LOW,
      });
    } else {
      this.timer = setInterval(refreshFn, STATUS_INTERVAL_MS);
      if (this.timer.unref) this.timer.unref();
    }
  }

  /** Stop the status bar permanently. */
  stop(): void {
    this.active = false;
    const scheduler = getScheduler();
    if (scheduler) scheduler.unregister('status-bar-refresh');
    if (this.initDelayTimer) {
      clearTimeout(this.initDelayTimer);
      this.initDelayTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Clear the terminal title
    if (process.stdout.isTTY) {
      process.stdout.write('\x1b]0;\x07');
    }
  }

  /** Temporarily suspend rendering (during command execution / monitor mode). */
  suspend(): void {
    this.suspended = true;
  }

  /** Resume rendering after suspension. */
  resume(): void {
    this.suspended = false;
  }

  /** Update the client reference (e.g. after wallet reconnect). */
  setClient(client: IFlashClient): void {
    this.client = client;
  }

  /** Update the wallet display name. */
  setWalletName(name: string): void {
    this.cfg.walletName = name;
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private async refresh(): Promise<void> {
    if (!this.active || this.suspended) return;

    try {
      const status = await this.gatherStatus();
      this.lastStatus = status;
      this.render(status);
    } catch (err) {
      getLogger().debug('STATUS_BAR', `Refresh error: ${getErrorMessage(err)}`);
    }
  }

  private async gatherStatus(): Promise<CachedStatus> {
    const ep = this.rpcManager.activeEndpoint;
    const rawLatency = this.rpcManager.activeLatencyMs;
    const latency = rawLatency > 0 ? this.latencySmoother.add(rawLatency) : rawLatency;

    let positions = 0;
    let exposureUsd = 0;

    try {
      // getPositions uses cached data from the reconciler in most cases
      const positionList = await this.client.getPositions();
      positions = positionList.length;
      for (const p of positionList) {
        if (Number.isFinite(p.sizeUsd) && p.sizeUsd > 0) {
          exposureUsd += p.sizeUsd;
        }
      }
    } catch {
      // Use last known values if available
      if (this.lastStatus) {
        positions = this.lastStatus.positions;
        exposureUsd = this.lastStatus.exposureUsd;
      }
    }

    // Sync state from reconciler
    const reconciler = getReconciler();
    const syncOk = reconciler ? !reconciler.hasMismatch : true;

    // Slot lag from RPC manager
    const slotLag = this.rpcManager.getSlotLag(ep.url);

    return {
      rpcLabel: ep.label,
      latencyMs: latency,
      network: 'mainnet-beta',
      walletName: this.cfg.walletName || 'N/A',
      positions,
      exposureUsd,
      mode: this.cfg.simulationMode ? 'SIMULATION' : 'LIVE',
      syncOk,
      slotLag: slotLag > 0 ? slotLag : 0,
      timestamp: Date.now(),
    };
  }

  private render(s: CachedStatus): void {
    if (this.suspended || !this.active) return;

    // Build plain-text status for change detection and terminal title
    const latPlain = s.latencyMs > 0 ? `${s.latencyMs}ms` : '--';
    const rpcPart =
      s.slotLag > 100 ? `RPC: ${s.rpcLabel} (${latPlain}) | Slot lag detected` : `RPC: ${s.rpcLabel} (${latPlain})`;
    const syncPart = s.syncOk ? 'Sync: OK' : 'Sync: DELAY';
    const plainParts = [rpcPart, `Wallet: ${s.walletName}`, `Pos: ${s.positions}`, syncPart, `Mode: ${s.mode}`];
    const plainStatus = plainParts.join('  |  ');

    // Skip if nothing changed
    if (plainStatus === this.prevPlainStatus) {
      return;
    }
    this.prevPlainStatus = plainStatus;

    // Update terminal title bar (xterm OSC escape — works on macOS Terminal,
    // iTerm2, Windows Terminal, most Linux terminals). This is completely
    // invisible in the scrollback and never adds lines.
    if (process.stdout.isTTY) {
      process.stdout.write(`\x1b]0;Flash | ${plainStatus}\x07`);
    }
  }
}
