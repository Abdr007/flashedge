import { Connection } from '@solana/web3.js';
import chalk from 'chalk';
import { theme } from '../cli/theme.js';
import { getLogger } from '../utils/logger.js';
import { createConnection } from '../wallet/connection.js';
import { getScheduler } from '../core/scheduler.js';
import { TaskPriority } from '../core/runtime-state.js';

const LATENCY_THRESHOLD_MS = 3_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const HEALTH_MONITOR_INTERVAL_MS = 30_000;
const FAILURE_RATE_WINDOW = 20;
const FAILURE_RATE_THRESHOLD = 0.5; // 50% failure rate triggers failover
const FAILOVER_COOLDOWN_MS = 60_000; // Minimum 60s between failovers to prevent oscillation
const SLOT_LAG_THRESHOLD = 50; // Slots behind network tip before endpoint is considered stale
const SLOT_CONSENSUS_DIVERGENCE = 3; // Max slot divergence for consensus
const PARTITION_SLOT_DIVERGENCE = 10; // Slot divergence threshold to declare network partition
const PARTITION_COOLDOWN_MS = 5_000; // Minimum time to stay in partition state before clearing

export interface RpcEndpoint {
  url: string;
  label: string;
}

export interface RpcHealthResult {
  url: string;
  label: string;
  healthy: boolean;
  latencyMs: number;
  slot?: number;
  slotLag?: number;
  error?: string;
}

export type ConnectionChangeCallback = (connection: Connection, endpoint: RpcEndpoint) => void;

/**
 * RPC Manager — manages multiple RPC endpoints with automatic failover,
 * background health monitoring, failure rate tracking, and connection
 * change propagation.
 */
export class RpcManager {
  private endpoints: RpcEndpoint[];
  private activeIndex = 0;
  private _connection: Connection;
  private failoverCount = 0;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private onConnectionChange: ConnectionChangeCallback | null = null;
  private lastFailoverTime = 0;
  private failoverPromise: Promise<boolean> | null = null;

  /** Rolling failure window per endpoint (true = success, false = failure) */
  private failureHistory: Map<string, boolean[]> = new Map();
  /** Last measured latency per endpoint */
  private latencyHistory: Map<string, number> = new Map();
  /** Last observed slot per endpoint (for slot lag detection) */
  private slotHistory: Map<string, number> = new Map();
  /** Consecutive monitor failures — suppress log spam during prolonged outages */
  private consecutiveMonitorFailures = 0;
  /** Mutex: prevents overlapping health check cycles */
  private healthCheckInProgress = false;
  /** Network partition state — true = partition detected, broadcast should pause */
  private _partitionDetected = false;
  /** When partition was first detected */
  private partitionDetectedAt = 0;

  constructor(endpoints: RpcEndpoint[]) {
    if (endpoints.length === 0) {
      throw new Error('At least one RPC endpoint is required');
    }
    this.endpoints = endpoints;
    this._connection = createConnection(endpoints[0].url);
    for (const ep of endpoints) {
      this.failureHistory.set(ep.url, []);
    }
  }

  get connection(): Connection {
    return this._connection;
  }

  get activeEndpoint(): RpcEndpoint {
    return this.endpoints[this.activeIndex];
  }

  get totalEndpoints(): number {
    return this.endpoints.length;
  }

  /** All configured endpoints (read-only snapshot for broadcast). */
  getEndpoints(): readonly RpcEndpoint[] {
    return this.endpoints;
  }

  /** Add a new RPC endpoint at runtime. Returns false if already present. */
  addEndpoint(url: string, label?: string): boolean {
    if (this.endpoints.some((ep) => ep.url === url)) return false;
    const ep: RpcEndpoint = { url, label: label ?? labelFromUrl(url) };
    this.endpoints.push(ep);
    this.failureHistory.set(url, []);
    return true;
  }

  /** Remove an RPC endpoint by URL. Cannot remove the active endpoint. Returns false if not found or active. */
  removeEndpoint(url: string): boolean {
    const idx = this.endpoints.findIndex((ep) => ep.url === url);
    if (idx < 0 || idx === this.activeIndex) return false;
    this.endpoints.splice(idx, 1);
    this.failureHistory.delete(url);
    this.latencyHistory.delete(url);
    this.slotHistory.delete(url);
    // Adjust active index if needed
    if (this.activeIndex > idx) this.activeIndex--;
    return true;
  }

  /** Switch to a specific endpoint by URL. Returns false if not found. */
  switchTo(url: string): boolean {
    const idx = this.endpoints.findIndex((ep) => ep.url === url);
    if (idx < 0 || idx === this.activeIndex) return false;
    this.activeIndex = idx;
    this._connection = createConnection(this.endpoints[idx].url);
    this.onConnectionChange?.(this._connection, this.endpoints[idx]);
    return true;
  }

  /** Last known latency (ms) for a specific endpoint, or -1 if unknown. */
  getEndpointLatency(url: string): number {
    return this.latencyHistory.get(url) ?? -1;
  }

  get fallbackCount(): number {
    return Math.max(0, this.endpoints.length - 1);
  }

  get totalFailovers(): number {
    return this.failoverCount;
  }

  /** Last known latency (ms) for the active endpoint, or -1 if unknown. */
  get activeLatencyMs(): number {
    return this.latencyHistory.get(this.activeEndpoint.url) ?? -1;
  }

  /** Last known slot for the active endpoint, or -1 if unknown. */
  get activeSlot(): number {
    return this.slotHistory.get(this.activeEndpoint.url) ?? -1;
  }

  /** Slot lag for the active endpoint (0 = synced, -1 = unknown). */
  get activeSlotLag(): number {
    return this.getSlotLag(this.activeEndpoint.url);
  }

  /**
   * Register a callback invoked whenever the active connection changes (failover).
   * Used by FlashClient to pick up the new connection automatically.
   */
  setConnectionChangeCallback(cb: ConnectionChangeCallback): void {
    this.onConnectionChange = cb;
  }

  /**
   * Record a success or failure for the active endpoint.
   */
  recordResult(success: boolean): void {
    const url = this.activeEndpoint.url;
    const history = this.failureHistory.get(url) ?? [];
    history.push(success);
    if (history.length > FAILURE_RATE_WINDOW) {
      history.shift();
    }
    this.failureHistory.set(url, history);
  }

  /**
   * Get failure rate for an endpoint (0.0 = all success, 1.0 = all failures).
   */
  getFailureRate(url: string): number {
    const history = this.failureHistory.get(url);
    if (!history || history.length === 0) return 0;
    const failures = history.filter((s) => !s).length;
    return failures / history.length;
  }

  /**
   * Get the highest known slot across all endpoints (used for slot lag comparison).
   */
  private getMaxKnownSlot(): number {
    let max = 0;
    for (const slot of this.slotHistory.values()) {
      if (slot > max) max = slot;
    }
    return max;
  }

  /**
   * Get current slot lag for an endpoint (0 = synced, -1 = unknown).
   */
  getSlotLag(url: string): number {
    const slot = this.slotHistory.get(url);
    if (slot === undefined) return -1;
    const max = this.getMaxKnownSlot();
    if (max === 0 || slot >= max) return 0;
    return max - slot;
  }

  /**
   * Test a single RPC endpoint for health + latency + slot.
   * Uses a lightweight Connection without WebSocket to avoid leaking sockets
   * during repeated health checks.
   */
  async checkHealth(endpoint: RpcEndpoint): Promise<RpcHealthResult> {
    try {
      // Lightweight connection: no WebSocket, just HTTP for health checks
      const conn = new Connection(endpoint.url, {
        commitment: 'confirmed',
        disableRetryOnRateLimit: true,
        fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) }),
      });
      const start = Date.now();
      await conn.getLatestBlockhash('confirmed');
      const latencyMs = Date.now() - start;
      this.latencyHistory.set(endpoint.url, latencyMs);

      // Feed latency to system health monitor
      try {
        const { getHealth } = await import('../system/health.js');
        getHealth()?.recordRpcLatency(latencyMs);
      } catch { /* health monitor may not be initialized yet */ }

      // Get slot for sync check and slot lag detection
      let slot: number | undefined;
      let slotLag: number | undefined;
      try {
        slot = await conn.getSlot('confirmed');
        if (slot !== undefined) {
          // [M-8] Slot sanity check — reject suspiciously high slot values that could poison failover
          const maxKnownSlot = this.getMaxKnownSlot();
          const MAX_SLOT_JUMP = 1000;
          if (maxKnownSlot > 0 && slot > maxKnownSlot + MAX_SLOT_JUMP) {
            const logger = getLogger();
            logger.warn(
              'RPC',
              `Suspicious slot ${slot} from ${endpoint.label} (max known: ${maxKnownSlot}, jump: ${slot - maxKnownSlot}) — ignoring`,
            );
            // Don't update slotHistory with suspicious value
          } else {
            this.slotHistory.set(endpoint.url, slot);
          }
          // Compute slot lag: compare against the highest known slot across all endpoints
          const freshMax = this.getMaxKnownSlot();
          if (freshMax > 0 && slot < freshMax) {
            slotLag = freshMax - slot;
          }
        }
      } catch {
        // Slot check is best-effort
      }

      return {
        url: endpoint.url,
        label: endpoint.label,
        healthy: true,
        latencyMs,
        slot,
        slotLag,
      };
    } catch (e: unknown) {
      this.latencyHistory.set(endpoint.url, -1);
      return {
        url: endpoint.url,
        label: endpoint.label,
        healthy: false,
        latencyMs: -1,
        error: e instanceof Error ? e.message : 'Unknown error',
      };
    }
  }

  /**
   * Check health of all configured endpoints.
   */
  async checkAllHealth(): Promise<RpcHealthResult[]> {
    return Promise.all(this.endpoints.map((ep) => this.checkHealth(ep)));
  }

  /**
   * Measure latency of the active connection (3-call average).
   */
  async measureLatency(): Promise<number> {
    let total = 0;
    const calls = 3;
    for (let i = 0; i < calls; i++) {
      const start = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this._connection.getLatestBlockhash('confirmed'),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), HEALTH_CHECK_TIMEOUT_MS);
          }),
        ]);
        total += Date.now() - start;
      } catch {
        total += HEALTH_CHECK_TIMEOUT_MS;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    const avg = Math.round(total / calls);
    this.latencyHistory.set(this.activeEndpoint.url, avg);
    return avg;
  }

  /**
   * Attempt automatic failover to the next healthy endpoint.
   * Returns true if failover succeeded, false if no healthy backup found.
   * Enforces a cooldown period to prevent oscillation between endpoints.
   * @param force — bypass cooldown (used for explicit network errors during trading)
   */
  /**
   * Attempt automatic failover to the next healthy endpoint.
   * Uses a shared promise as mutex — concurrent callers await the same in-flight failover.
   */
  async failover(force = false): Promise<boolean> {
    // If a failover is already in-flight, all callers await the same promise
    if (this.failoverPromise) {
      getLogger().debug('RPC', 'Failover already in progress — waiting for completion');
      return this.failoverPromise;
    }

    this.failoverPromise = this._doFailover(force);
    try {
      return await this.failoverPromise;
    } finally {
      this.failoverPromise = null;
    }
  }

  private async _doFailover(force: boolean): Promise<boolean> {
    const logger = getLogger();

    // Cooldown: prevent oscillation between endpoints
    const now = Date.now();
    if (!force && now - this.lastFailoverTime < FAILOVER_COOLDOWN_MS) {
      const remaining = Math.ceil((FAILOVER_COOLDOWN_MS - (now - this.lastFailoverTime)) / 1000);
      logger.debug('RPC', `Failover cooldown active (${remaining}s remaining) — skipping`);
      return false;
    }

    for (let i = 0; i < this.endpoints.length; i++) {
      const idx = (this.activeIndex + 1 + i) % this.endpoints.length;
      if (idx === this.activeIndex) continue;

      const ep = this.endpoints[idx];
      const health = await this.checkHealth(ep);

      if (health.healthy) {
        const prevLabel = this.endpoints[this.activeIndex].label;
        logger.warn('RPC', `Failover: switching from ${prevLabel} to ${ep.label} (latency: ${health.latencyMs}ms)`);
        this.activeIndex = idx;
        this._connection = createConnection(ep.url);
        this.failoverCount++;
        this.lastFailoverTime = Date.now();
        this._allEndpointsDown = false;
        this._allDownSince = 0;

        // Notify FlashClient of connection change
        if (this.onConnectionChange) {
          this.onConnectionChange(this._connection, ep);
        }

        return true;
      }
    }

    // Before declaring all down, re-check the ACTIVE endpoint —
    // it may have recovered while we were testing backups
    const activeRecheck = await this.checkHealth(this.activeEndpoint);
    if (activeRecheck.healthy) {
      logger.info('RPC', `Active endpoint ${this.activeEndpoint.label} recovered during failover — staying connected`);
      this._allEndpointsDown = false;
      this.consecutiveMonitorFailures = 0;
      return true;
    }

    logger.error('RPC', 'No healthy RPC endpoint found');
    this._allEndpointsDown = true;
    this._allDownSince = Date.now();
    return false;
  }

  /** True when the last failover attempt found no healthy endpoints */
  private _allEndpointsDown = false;
  private _allDownSince = 0;

  /** Whether all RPC endpoints are currently unreachable.
   *  Auto-clears after 60s to prevent permanent read-only lockout. */
  get allEndpointsDown(): boolean {
    if (this._allEndpointsDown && this._allDownSince > 0) {
      // Auto-expire after 60s — force re-evaluation on next health check
      if (Date.now() - this._allDownSince > 60_000) {
        this._allEndpointsDown = false;
        this._allDownSince = 0;
        getLogger().info('RPC', 'Read-only mode auto-expired — re-evaluating endpoint health');
      }
    }
    return this._allEndpointsDown;
  }

  /**
   * Get a connection, checking health first. If unhealthy or high failure rate, attempt failover.
   *
   * Optimized for chaos conditions: checks cached failure rate first (no network call).
   * Only performs a live health check if failure rate data is insufficient (< 3 samples).
   * This prevents doubling latency under degraded RPC conditions.
   */
  async getHealthyConnection(): Promise<Connection> {
    // Check failure rate first (fast, no network call)
    const failureRate = this.getFailureRate(this.activeEndpoint.url);
    if (failureRate >= FAILURE_RATE_THRESHOLD && this.fallbackCount > 0) {
      const logger = getLogger();
      logger.warn(
        'RPC',
        `High failure rate (${(failureRate * 100).toFixed(0)}%) on ${this.activeEndpoint.label} — attempting failover`,
      );
      const didFailover = await this.failover();
      if (didFailover) return this._connection;
    }

    // Only perform a live health check if we have insufficient failure rate data.
    // The background health monitor already checks every 30s — adding a check
    // on every getHealthyConnection() call doubles latency under degraded conditions
    // and can itself time out, causing cascading failures.
    const history = this.failureHistory.get(this.activeEndpoint.url);
    const hasSufficientData = history && history.length >= 3;

    if (!hasSufficientData) {
      const health = await this.checkHealth(this.activeEndpoint);
      if (!health.healthy || health.latencyMs > LATENCY_THRESHOLD_MS) {
        const didFailover = await this.failover();
        if (didFailover) {
          return this._connection;
        }
        // No backup available — return current connection anyway
      }
    }

    return this._connection;
  }

  /**
   * Start background health monitoring.
   * Checks the active endpoint periodically and auto-fails over if needed.
   */
  startMonitoring(): void {
    if (this.monitorTimer) return; // Already running
    const logger = getLogger();
    logger.info('RPC', `Health monitor started (interval: ${HEALTH_MONITOR_INTERVAL_MS / 1000}s)`);

    const monitorFn = async (): Promise<void> => {
      if (this.healthCheckInProgress) return;
      this.healthCheckInProgress = true;
      try {
        const health = await this.checkHealth(this.activeEndpoint);
        this.recordResult(health.healthy);

        if (!health.healthy) {
          this.consecutiveMonitorFailures++;
          if (this.consecutiveMonitorFailures <= 3 || this.consecutiveMonitorFailures % 5 === 0) {
            logger.warn(
              'RPC',
              `Active RPC ${this.activeEndpoint.label} unhealthy (${this.consecutiveMonitorFailures} consecutive) — attempting failover`,
            );
          }
          await this.failover();
        } else if (health.latencyMs > LATENCY_THRESHOLD_MS) {
          logger.warn(
            'RPC',
            `Active RPC ${this.activeEndpoint.label} latency ${health.latencyMs}ms > ${LATENCY_THRESHOLD_MS}ms threshold`,
          );
          if (this.fallbackCount > 0) {
            await this.failover();
          }
          this.consecutiveMonitorFailures = 0;
        } else if (health.slotLag !== undefined && health.slotLag > SLOT_LAG_THRESHOLD) {
          logger.warn(
            'RPC',
            `Active RPC ${this.activeEndpoint.label} is ${health.slotLag} slots behind (threshold: ${SLOT_LAG_THRESHOLD}) — attempting failover`,
          );
          if (this.fallbackCount > 0) {
            await this.failover();
          }
          this.consecutiveMonitorFailures = 0;
        } else {
          if (this.consecutiveMonitorFailures > 0) {
            logger.info(
              'RPC',
              `Active RPC ${this.activeEndpoint.label} recovered after ${this.consecutiveMonitorFailures} consecutive failures`,
            );
          }
          this.consecutiveMonitorFailures = 0;
          this._allEndpointsDown = false;
        this._allDownSince = 0;
        }

        this.detectPartition();
      } catch {
        this.consecutiveMonitorFailures++;
      } finally {
        this.healthCheckInProgress = false;
      }
    };

    // Use central scheduler if available (NORMAL — throttled 5x in IDLE)
    const scheduler = getScheduler();
    if (scheduler) {
      scheduler.register({
        name: 'rpc-health-monitor',
        fn: monitorFn,
        baseIntervalMs: HEALTH_MONITOR_INTERVAL_MS,
        priority: TaskPriority.NORMAL,
      });
      // Set a dummy timer so monitorTimer is truthy (prevents re-entry)
      this.monitorTimer = setInterval(() => {}, 2_147_483_647);
      this.monitorTimer.unref();
    } else {
      this.monitorTimer = setInterval(monitorFn, HEALTH_MONITOR_INTERVAL_MS);
      if (this.monitorTimer.unref) this.monitorTimer.unref();
    }
  }

  /**
   * Pre-warm connections to all backup endpoints during idle time.
   * Establishes HTTP connections by issuing a lightweight getSlot('processed') call.
   * Fire-and-forget — logs results but never throws.
   */
  async warmupConnections(): Promise<void> {
    const logger = getLogger();
    if (this.endpoints.length <= 1) {
      logger.debug('RPC', 'Warmup skipped — single endpoint configured');
      return;
    }

    logger.info('RPC', `Warming up ${this.endpoints.length - 1} backup connection(s)...`);

    for (const ep of this.endpoints) {
      if (ep.url === this.activeEndpoint.url) continue;
      try {
        const conn = new Connection(ep.url, {
          commitment: 'processed',
          disableRetryOnRateLimit: true,
          fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) }),
        });
        const start = Date.now();
        const slot = await conn.getSlot('processed');
        const latencyMs = Date.now() - start;
        this.latencyHistory.set(ep.url, latencyMs);
        if (slot !== undefined) {
          this.slotHistory.set(ep.url, slot);
        }
        logger.debug('RPC', `Warmed ${ep.label}: slot=${slot}, latency=${latencyMs}ms`);
      } catch (e: unknown) {
        logger.debug('RPC', `Warmup failed for ${ep.label}: ${e instanceof Error ? e.message : 'unknown error'}`);
      }
    }

    logger.info('RPC', 'Connection warmup complete');
  }

  /**
   * Stop background health monitoring.
   */
  stopMonitoring(): void {
    const scheduler = getScheduler();
    if (scheduler) scheduler.unregister('rpc-health-monitor');
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
      getLogger().info('RPC', 'Health monitor stopped');
    }
  }

  /**
   * Get slot consensus across all endpoints.
   * Returns the median slot and whether endpoints agree within SLOT_CONSENSUS_DIVERGENCE.
   */
  getSlotConsensus(): { medianSlot: number; inConsensus: boolean; divergentEndpoints: string[] } {
    const slots: { url: string; slot: number }[] = [];
    for (const ep of this.endpoints) {
      const slot = this.slotHistory.get(ep.url);
      if (slot !== undefined && slot > 0) {
        slots.push({ url: ep.url, slot });
      }
    }

    if (slots.length === 0) {
      return { medianSlot: 0, inConsensus: true, divergentEndpoints: [] };
    }

    // Compute median
    const sorted = [...slots].sort((a, b) => a.slot - b.slot);
    const medianSlot = sorted[Math.floor(sorted.length / 2)].slot;

    // Find divergent endpoints (> SLOT_CONSENSUS_DIVERGENCE from median)
    const divergent: string[] = [];
    for (const s of slots) {
      if (Math.abs(s.slot - medianSlot) > SLOT_CONSENSUS_DIVERGENCE) {
        divergent.push(s.url);
      }
    }

    return {
      medianSlot,
      inConsensus: divergent.length === 0,
      divergentEndpoints: divergent,
    };
  }

  /**
   * Detect network partition: endpoints disagree on slot height by > PARTITION_SLOT_DIVERGENCE.
   * When a partition is detected, transaction broadcast should be paused.
   */
  detectPartition(): boolean {
    if (this.endpoints.length < 2) {
      // Can't detect partition with a single endpoint
      this._partitionDetected = false;
      return false;
    }

    const slots: number[] = [];
    for (const ep of this.endpoints) {
      const slot = this.slotHistory.get(ep.url);
      if (slot !== undefined && slot > 0) slots.push(slot);
    }

    if (slots.length < 2) {
      this._partitionDetected = false;
      return false;
    }

    const maxSlot = Math.max(...slots);
    const minSlot = Math.min(...slots);
    const divergence = maxSlot - minSlot;

    if (divergence > PARTITION_SLOT_DIVERGENCE) {
      if (!this._partitionDetected) {
        this._partitionDetected = true;
        this.partitionDetectedAt = Date.now();
        getLogger().warn('RPC', `Network partition detected: slot divergence ${divergence} (${minSlot}..${maxSlot})`);
      }
      return true;
    }

    // Clear partition state only after cooldown
    if (this._partitionDetected && Date.now() - this.partitionDetectedAt > PARTITION_COOLDOWN_MS) {
      this._partitionDetected = false;
      getLogger().info('RPC', `Network partition cleared: slot divergence ${divergence}`);
    }

    return this._partitionDetected;
  }

  /** Whether a network partition is currently detected */
  get partitionDetected(): boolean {
    return this._partitionDetected;
  }

  /**
   * Get connections that are within slot consensus (< 3 slot divergence from median).
   * Used by broadcast to exclude stale endpoints.
   */
  getConsensusHealthyConnections(): Connection[] {
    const consensus = this.getSlotConsensus();
    if (consensus.medianSlot === 0) {
      // No slot data — return primary only
      return [this._connection];
    }

    const connections: Connection[] = [];
    for (const ep of this.endpoints) {
      if (!consensus.divergentEndpoints.includes(ep.url)) {
        if (ep.url === this.activeEndpoint.url) {
          connections.push(this._connection);
        } else {
          try {
            connections.push(
              new Connection(ep.url, {
                commitment: 'confirmed',
                disableRetryOnRateLimit: true,
                fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(30_000) }),
              }),
            );
          } catch {
            // Skip invalid endpoints
          }
        }
      }
    }

    // Always include at least the primary
    if (connections.length === 0) {
      connections.push(this._connection);
    }

    return connections;
  }

  /**
   * Format status for CLI display (enhanced with per-endpoint details).
   */
  formatStatus(latencyMs: number): string {
    const active = this.activeEndpoint;
    const lines = [
      '',
      theme.titleBlock('RPC STATUS'),
      '',
      `  Active RPC:    ${chalk.cyan(active.label)}`,
      `  Endpoint:      ${chalk.dim(this.maskUrl(active.url))}`,
      `  Latency:       ${this.colorLatency(latencyMs)}`,
      `  Fallback RPCs: ${chalk.bold(String(this.fallbackCount))}`,
      `  Failovers:     ${chalk.bold(String(this.failoverCount))}`,
    ];

    // Slot lag for active
    const activeSlotLag = this.getSlotLag(active.url);
    if (activeSlotLag > 0) {
      lines.push(`  Slot Lag:      ${this.colorSlotLag(activeSlotLag)}`);
    }

    // Failure rate for active
    const failRate = this.getFailureRate(active.url);
    if (failRate > 0) {
      lines.push(`  Failure Rate:  ${this.colorFailureRate(failRate)}`);
    }

    if (this.endpoints.length > 1) {
      lines.push('');
      lines.push(`  ${theme.section('All Endpoints')}`);
      lines.push(`  ${theme.separator(25)}`);
      for (let i = 0; i < this.endpoints.length; i++) {
        const ep = this.endpoints[i];
        const isActive = i === this.activeIndex;
        const marker = isActive ? chalk.green('●') : chalk.dim('○');
        const label = isActive ? chalk.green(ep.label) : ep.label;
        const lat = this.latencyHistory.get(ep.url);
        const latStr = lat !== undefined ? ` ${this.colorLatency(lat)}` : '';
        const fr = this.getFailureRate(ep.url);
        const frStr = fr > 0 ? ` ${this.colorFailureRate(fr)}` : '';
        const sl = this.getSlotLag(ep.url);
        const slStr = sl > 0 ? ` ${this.colorSlotLag(sl)}` : '';
        lines.push(`    ${marker} ${label.padEnd(18)}${latStr}${frStr}${slStr}`);
        lines.push(chalk.dim(`      ${this.maskUrl(ep.url)}`));
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  /**
   * Mask API keys in URLs for display.
   */
  private maskUrl(url: string): string {
    try {
      const parsed = new URL(url);
      // Mask path segments that look like API keys (long alphanumeric strings)
      const parts = parsed.pathname.split('/');
      const masked = parts.map((p) => (p.length > 20 ? p.slice(0, 6) + '***' : p));
      parsed.pathname = masked.join('/');
      // Remove query params that might contain keys
      if (parsed.search) {
        parsed.search = '';
      }
      return parsed.toString().replace(/\/$/, '');
    } catch {
      return url.slice(0, 30) + '***';
    }
  }

  private colorLatency(ms: number): string {
    if (ms < 0) return chalk.red('unavailable');
    if (ms < 500) return chalk.green(`${ms}ms`);
    if (ms < 1500) return chalk.yellow(`${ms}ms`);
    return chalk.red(`${ms}ms`);
  }

  private colorFailureRate(rate: number): string {
    const pct = `${(rate * 100).toFixed(0)}% fail`;
    if (rate < 0.1) return chalk.green(pct);
    if (rate < 0.3) return chalk.yellow(pct);
    return chalk.red(pct);
  }

  private colorSlotLag(lag: number): string {
    if (lag <= 0) return chalk.green('synced');
    if (lag <= 10) return chalk.green(`${lag} slots behind`);
    if (lag <= SLOT_LAG_THRESHOLD) return chalk.yellow(`${lag} slots behind`);
    return chalk.red(`${lag} slots behind`);
  }
}

/**
 * Build RPC endpoints from config.
 * Accepts the primary URL and optional backup URLs from the config.
 */
export function buildRpcEndpoints(primaryUrl: string, backupUrls?: string[]): RpcEndpoint[] {
  const endpoints: RpcEndpoint[] = [{ url: primaryUrl, label: labelFromUrl(primaryUrl) }];

  if (backupUrls) {
    for (const url of backupUrls) {
      if (url) {
        endpoints.push({ url, label: labelFromUrl(url) });
      }
    }
  }

  return endpoints;
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: RpcManager | null = null;

export function initRpcManager(endpoints: RpcEndpoint[]): RpcManager {
  _instance = new RpcManager(endpoints);
  return _instance;
}

export function getRpcManagerInstance(): RpcManager | null {
  return _instance;
}

function labelFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host.includes('helius')) return 'Helius';
    if (host.includes('quicknode')) return 'QuickNode';
    if (host.includes('alchemy')) return 'Alchemy';
    if (host.includes('triton')) return 'Triton';
    if (host.includes('getblock')) return 'GetBlock';
    if (host.includes('ankr')) return 'Ankr';
    if (host.includes('shyft')) return 'Shyft';
    if (host.includes('mainnet-beta.solana.com')) return 'Solana Public';
    if (host === 'localhost' || host === '127.0.0.1') return 'Localhost';
    return host.split('.')[0] || 'Custom';
  } catch {
    return 'Custom';
  }
}
