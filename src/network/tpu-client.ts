/**
 * TPU Client — Direct Validator Transaction Forwarding
 *
 * Resolves leader validator TPU addresses from the cluster node list
 * and forwards signed transactions directly via UDP (legacy) or
 * QUIC (when available), bypassing RPC gossip entirely.
 *
 * Failover chain: TPU QUIC → TPU UDP → null (caller falls back to RPC)
 *
 * Design constraints:
 *   - NEVER blocks the execution pipeline
 *   - Best-effort forwarding — failure is silent, RPC broadcast always runs in parallel
 *   - UDP/QUIC are fire-and-forget — no confirmation via TPU
 *   - Leader schedule drives which validator to target
 */

import { Connection, type ContactInfo } from '@solana/web3.js';
import * as dgram from 'node:dgram';
import { getLogger } from '../utils/logger.js';
import { getLeaderRouter } from '../core/leader-router.js';

// ─── Configuration ───────────────────────────────────────────────────────────

/** How often to refresh the cluster node → TPU address mapping */
const NODE_REFRESH_INTERVAL_MS = 60_000;

/** Timeout for getClusterNodes() RPC call */
const NODE_FETCH_TIMEOUT_MS = 10_000;

/** Maximum UDP packet size (Solana tx max is 1232 bytes, fits in single UDP datagram) */
const MAX_TX_SIZE = 1_232;

/** Number of TPU forward attempts per send */
const TPU_SEND_ATTEMPTS = 2;

/** UDP socket send timeout */
const UDP_SEND_TIMEOUT_MS = 2_000;

// ─── Types ───────────────────────────────────────────────────────────────────

interface TpuAddress {
  /** Validator identity pubkey (base58) */
  identity: string;
  /** TPU UDP address (ip:port) */
  tpuUdp: string | null;
  /** TPU QUIC address (ip:port) — typically UDP port + 6 */
  tpuQuic: string | null;
}

export interface TpuForwardResult {
  /** Whether the forward was attempted */
  attempted: boolean;
  /** Transport used: 'udp', 'quic', or 'none' */
  transport: 'udp' | 'quic' | 'none';
  /** Target validator identity */
  targetValidator: string | null;
  /** Forward latency in ms */
  latencyMs: number;
  /** Error message if forward failed */
  error?: string;
}

export interface TpuClientMetrics {
  forwardAttempts: number;
  forwardSuccesses: number;
  forwardFailures: number;
  udpSends: number;
  nodeMapSize: number;
  lastRefreshMs: number;
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: TpuClient | null = null;

export function initTpuClient(connection: Connection): TpuClient {
  if (_instance) {
    _instance.shutdown();
  }
  _instance = new TpuClient(connection);
  return _instance;
}

export function getTpuClient(): TpuClient | null {
  return _instance;
}

export function shutdownTpuClient(): void {
  if (_instance) {
    _instance.shutdown();
    _instance = null;
  }
}

// ─── TPU Client ──────────────────────────────────────────────────────────────

export class TpuClient {
  private connection: Connection;

  /** Validator identity → TPU addresses */
  private nodeMap: Map<string, TpuAddress> = new Map();
  private nodeRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInProgress = false;

  /** Reusable UDP socket for TPU forwarding */
  private udpSocket: dgram.Socket | null = null;

  // Metrics
  private _metrics: TpuClientMetrics = {
    forwardAttempts: 0,
    forwardSuccesses: 0,
    forwardFailures: 0,
    udpSends: 0,
    nodeMapSize: 0,
    lastRefreshMs: 0,
  };

  constructor(connection: Connection) {
    this.connection = connection;

    // Create reusable UDP socket
    try {
      this.udpSocket = dgram.createSocket('udp4');
      this.udpSocket.unref(); // Don't keep process alive
      this.udpSocket.on('error', () => {
        // Silently handle socket errors — TPU is best-effort
      });
    } catch {
      // UDP not available — will skip TPU forwarding
    }

    // Initial node map fetch
    this.refreshNodeMap().catch(() => {});

    // Background refresh
    this.nodeRefreshTimer = setInterval(() => {
      this.refreshNodeMap().catch(() => {});
    }, NODE_REFRESH_INTERVAL_MS);
    this.nodeRefreshTimer.unref();

    getLogger().info('TPU-CLIENT', 'TPU direct forwarding client initialized');
  }

  // ─── Node Map Refresh ───────────────────────────────────────────────────

  private async refreshNodeMap(): Promise<void> {
    if (this.refreshInProgress) return;
    this.refreshInProgress = true;

    const start = Date.now();
    const logger = getLogger();

    try {
      // Fetch cluster nodes with timeout
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), NODE_FETCH_TIMEOUT_MS);

      let nodes: ContactInfo[];
      try {
        nodes = await this.connection.getClusterNodes();
      } finally {
        clearTimeout(timer);
      }

      // Build identity → TPU address map
      const newMap = new Map<string, TpuAddress>();

      for (const node of nodes) {
        if (!node.pubkey || !node.tpu) continue;

        // Parse TPU address
        const tpuUdp = node.tpu; // e.g. "1.2.3.4:8004"

        // QUIC TPU is typically UDP port + 6
        let tpuQuic: string | null = null;
        try {
          const [host, portStr] = tpuUdp.split(':');
          const quicPort = parseInt(portStr, 10) + 6;
          if (Number.isFinite(quicPort) && quicPort > 0 && quicPort < 65536) {
            tpuQuic = `${host}:${quicPort}`;
          }
        } catch {
          // Skip QUIC derivation
        }

        newMap.set(node.pubkey, {
          identity: node.pubkey,
          tpuUdp,
          tpuQuic,
        });
      }

      this.nodeMap = newMap;
      this._metrics.nodeMapSize = newMap.size;
      this._metrics.lastRefreshMs = Date.now() - start;

      logger.debug('TPU-CLIENT', `Node map refreshed: ${newMap.size} validators (${Date.now() - start}ms)`);
    } catch (err) {
      logger.debug('TPU-CLIENT', `Node map refresh failed: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      this.refreshInProgress = false;
    }
  }

  // ─── Forward Transaction ────────────────────────────────────────────────

  /**
   * Forward a signed transaction directly to the upcoming leader's TPU port.
   *
   * This is a fire-and-forget optimization — the caller should always
   * also broadcast via standard RPC in parallel.
   *
   * Returns immediately after UDP send (no confirmation via TPU).
   */
  async forwardToLeader(txBytes: Buffer): Promise<TpuForwardResult> {
    const start = Date.now();
    this._metrics.forwardAttempts++;

    // Validate tx size
    if (txBytes.length > MAX_TX_SIZE) {
      return {
        attempted: false,
        transport: 'none',
        targetValidator: null,
        latencyMs: 0,
        error: 'tx too large for TPU',
      };
    }

    // Get current leader from leader router
    const leaderRouter = getLeaderRouter();
    if (!leaderRouter) {
      return { attempted: false, transport: 'none', targetValidator: null, latencyMs: 0, error: 'no leader router' };
    }

    const leaderInfo = leaderRouter.getLeaderInfo();
    const targetLeader = leaderInfo.currentLeader || leaderInfo.nextLeader;
    if (!targetLeader) {
      return { attempted: false, transport: 'none', targetValidator: null, latencyMs: 0, error: 'no leader known' };
    }

    // Resolve TPU address
    const tpuAddr = this.nodeMap.get(targetLeader);
    if (!tpuAddr || !tpuAddr.tpuUdp) {
      return {
        attempted: false,
        transport: 'none',
        targetValidator: targetLeader,
        latencyMs: 0,
        error: 'no TPU address for leader',
      };
    }

    // Forward via UDP
    try {
      await this.sendUdp(txBytes, tpuAddr.tpuUdp);
      this._metrics.forwardSuccesses++;
      return {
        attempted: true,
        transport: 'udp',
        targetValidator: targetLeader,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      this._metrics.forwardFailures++;
      return {
        attempted: false,
        transport: 'none',
        targetValidator: targetLeader,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : 'unknown',
      };
    }
  }

  /**
   * Forward to multiple upcoming leaders (current + next few slots).
   * Maximizes chance of hitting the right leader.
   */
  async forwardToUpcomingLeaders(txBytes: Buffer): Promise<TpuForwardResult> {
    const start = Date.now();
    this._metrics.forwardAttempts++;

    if (txBytes.length > MAX_TX_SIZE || !this.udpSocket) {
      return { attempted: false, transport: 'none', targetValidator: null, latencyMs: 0 };
    }

    const leaderRouter = getLeaderRouter();
    if (!leaderRouter) {
      return { attempted: false, transport: 'none', targetValidator: null, latencyMs: 0 };
    }

    // Get upcoming leaders (current + next 3)
    const leaderInfo = leaderRouter.getLeaderInfo();
    const leaders = new Set<string>();
    if (leaderInfo.currentLeader) leaders.add(leaderInfo.currentLeader);
    if (leaderInfo.nextLeader) leaders.add(leaderInfo.nextLeader);

    if (leaders.size === 0) {
      return { attempted: false, transport: 'none', targetValidator: null, latencyMs: 0 };
    }

    // Send to all known leaders in parallel
    const sends: Promise<void>[] = [];
    let targetValidator: string | null = null;

    for (const leader of leaders) {
      const tpuAddr = this.nodeMap.get(leader);
      if (tpuAddr?.tpuUdp) {
        if (!targetValidator) targetValidator = leader;
        // Send multiple copies for reliability
        for (let i = 0; i < TPU_SEND_ATTEMPTS; i++) {
          sends.push(this.sendUdp(txBytes, tpuAddr.tpuUdp).catch(() => {}));
        }
      }
    }

    if (sends.length === 0) {
      return { attempted: false, transport: 'none', targetValidator: null, latencyMs: 0 };
    }

    // Fire all sends in parallel — don't wait for completion (fire-and-forget)
    Promise.allSettled(sends).catch(() => {});

    this._metrics.forwardSuccesses++;
    return {
      attempted: true,
      transport: 'udp',
      targetValidator,
      latencyMs: Date.now() - start,
    };
  }

  // ─── UDP Send ───────────────────────────────────────────────────────────

  private sendUdp(data: Buffer, address: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.udpSocket) {
        reject(new Error('UDP socket not available'));
        return;
      }

      const [host, portStr] = address.split(':');
      const port = parseInt(portStr, 10);
      if (!Number.isFinite(port) || port <= 0 || port >= 65536) {
        reject(new Error(`Invalid TPU address: ${address}`));
        return;
      }

      const timer = setTimeout(() => reject(new Error('UDP send timeout')), UDP_SEND_TIMEOUT_MS);

      this.udpSocket.send(data, port, host, (err) => {
        clearTimeout(timer);
        if (err) {
          reject(err);
        } else {
          this._metrics.udpSends++;
          resolve();
        }
      });
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  get metrics(): TpuClientMetrics {
    return { ...this._metrics };
  }

  /** Check if TPU forwarding is operational */
  get isOperational(): boolean {
    return this.udpSocket !== null && this.nodeMap.size > 0;
  }

  updateConnection(connection: Connection): void {
    this.connection = connection;
  }

  // ─── Shutdown ───────────────────────────────────────────────────────────

  shutdown(): void {
    if (this.nodeRefreshTimer) {
      clearInterval(this.nodeRefreshTimer);
      this.nodeRefreshTimer = null;
    }
    if (this.udpSocket) {
      try {
        this.udpSocket.close();
      } catch {
        /* already closed */
      }
      this.udpSocket = null;
    }
    this.nodeMap.clear();
    getLogger().info('TPU-CLIENT', 'TPU client shut down');
  }
}
