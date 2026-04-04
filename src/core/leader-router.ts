/**
 * Leader-Aware Transaction Router
 *
 * Optimizes transaction propagation by routing toward the current/upcoming
 * slot leader. Maintains a cached leader schedule and continuous slot tracking
 * to determine optimal RPC broadcast ordering.
 *
 * Design constraints:
 *   - NEVER blocks transaction execution
 *   - NEVER delays broadcast — leader routing is best-effort optimization
 *   - Falls back gracefully to standard broadcast on any failure
 *   - All schedule/slot fetches happen asynchronously in the background
 *
 * Architecture:
 *   1. Slot Watcher — polls getSlot() every 400ms, tracks current + next slot
 *   2. Leader Schedule — cached for 60s, fetched asynchronously
 *   3. Endpoint Ranker — orders RPC endpoints by latency to the upcoming leader
 *   4. Broadcast Advisor — returns ordered endpoint list for a given tx broadcast
 */

import { Connection } from '@solana/web3.js';
import { getLogger } from '../utils/logger.js';
import { getRpcManagerInstance } from '../network/rpc-manager.js';

// ─── Configuration ───────────────────────────────────────────────────────────

/** Slot polling interval — 2s balances leader awareness vs RPC rate limits */
const SLOT_POLL_MS = 2_000;

/** Faster slot polling during active trading — 1s for tighter leader awareness */
const SLOT_POLL_ACTIVE_MS = 1_000;

/** Leader schedule cache TTL — 5 min (schedule rarely changes mid-epoch) */
const SCHEDULE_CACHE_TTL_MS = 300_000;

/** Number of upcoming leader slots to look ahead */
const LEADER_LOOKAHEAD_SLOTS = 4;

/** Timeout for leader schedule fetch (don't block on slow RPCs) */
const SCHEDULE_FETCH_TIMEOUT_MS = 5_000;

/** Solana epoch length in slots (mainnet) */
const SLOTS_PER_EPOCH = 432_000;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LeaderInfo {
  /** Current slot number */
  currentSlot: number;
  /** Validator identity for the current slot leader */
  currentLeader: string | null;
  /** Validator identity for the next slot leader */
  nextLeader: string | null;
  /** Age of the slot data in ms */
  slotAge: number;
  /** Whether the leader schedule is cached */
  scheduleAvailable: boolean;
}

export interface BroadcastOrder {
  /** Ordered list of connections — leader-preferred first */
  connections: Connection[];
  /** Whether leader routing was used (vs standard ordering) */
  leaderRouted: boolean;
  /** The leader validator identity used for routing, if any */
  targetLeader: string | null;
}

interface CachedSchedule {
  /** Map of slot -> validator identity (base58 pubkey) */
  slotToLeader: Map<number, string>;
  /** The slot the schedule starts from */
  startSlot: number;
  /** When the schedule was fetched */
  fetchedAt: number;
}

interface SlotState {
  slot: number;
  fetchedAt: number;
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: LeaderRouter | null = null;

export function getLeaderRouter(): LeaderRouter | null {
  return _instance;
}

export function initLeaderRouter(connection: Connection): LeaderRouter {
  if (_instance) {
    _instance.shutdown();
  }
  _instance = new LeaderRouter(connection);
  return _instance;
}

export function shutdownLeaderRouter(): void {
  if (_instance) {
    _instance.shutdown();
    _instance = null;
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

export class LeaderRouter {
  private connection: Connection;

  // Slot tracking
  private currentSlot: SlotState | null = null;
  private slotTimer: ReturnType<typeof setInterval> | null = null;

  // Leader schedule
  private cachedSchedule: CachedSchedule | null = null;
  private scheduleInflight: Promise<CachedSchedule | null> | null = null;
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;

  // Active trading mode
  private activeTrading = false;

  // Metrics
  private leaderRoutedCount = 0;
  private totalBroadcastCount = 0;
  private slotInclusionDelays: number[] = [];
  private endpointFirstCounts: Map<string, number> = new Map();

  constructor(connection: Connection) {
    this.connection = connection;
    this.startSlotWatcher();
    this.startScheduleRefresh();
    getLogger().info('LEADER-ROUTER', 'Leader-aware routing initialized');
  }

  // ─── Slot Watcher ──────────────────────────────────────────────────────

  private startSlotWatcher(): void {
    // Immediate first fetch
    this.fetchSlot();

    this.slotTimer = setInterval(() => {
      this.fetchSlot();
    }, SLOT_POLL_MS);
    this.slotTimer.unref();
  }

  private fetchSlot(): void {
    this.connection
      .getSlot('confirmed')
      .then((slot) => {
        this.currentSlot = { slot, fetchedAt: Date.now() };
      })
      .catch(() => {
        // Non-critical — stale slot is better than no slot
      });
  }

  // ─── Leader Schedule ───────────────────────────────────────────────────

  private startScheduleRefresh(): void {
    // Immediate first fetch
    this.refreshSchedule();

    this.scheduleTimer = setInterval(() => {
      this.refreshSchedule();
    }, SCHEDULE_CACHE_TTL_MS);
    this.scheduleTimer.unref();
  }

  private refreshSchedule(): void {
    // Don't start a new fetch if one is in-flight
    if (this.scheduleInflight) return;

    this.scheduleInflight = (async () => {
      try {
        // Timeout guard: abort the fetch if RPC hangs
        let timer: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), SCHEDULE_FETCH_TIMEOUT_MS);
        });

        try {
          // getLeaderSchedule returns a map of validator identity -> slot indices
          // relative to the epoch start. Race against timeout to prevent hanging.
          const schedulePromise = this.connection.getLeaderSchedule();
          const schedule = await Promise.race([schedulePromise, timeoutPromise]);

          if (timer) clearTimeout(timer);

          if (!schedule) {
            return null;
          }

          // Build reverse mapping: relative slot index -> leader identity
          const slotToLeader = new Map<number, string>();
          for (const [validatorIdentity, slots] of Object.entries(schedule)) {
            for (const relativeSlot of slots) {
              slotToLeader.set(relativeSlot, validatorIdentity);
            }
          }

          const cached: CachedSchedule = {
            slotToLeader,
            startSlot: this.currentSlot?.slot ?? 0,
            fetchedAt: Date.now(),
          };

          this.cachedSchedule = cached;
          getLogger().debug('LEADER-ROUTER', `Leader schedule cached (${slotToLeader.size} slots)`);
          return cached;
        } finally {
          if (timer) clearTimeout(timer);
        }
      } catch {
        getLogger().debug('LEADER-ROUTER', 'Leader schedule fetch failed — using stale cache');
        return this.cachedSchedule;
      } finally {
        this.scheduleInflight = null;
      }
    })();
  }

  // ─── Leader Lookup ─────────────────────────────────────────────────────

  /**
   * Get the current and upcoming leader validator identities.
   * Returns null leaders if data is unavailable — never blocks.
   */
  getLeaderInfo(): LeaderInfo {
    const slotState = this.currentSlot;
    const schedule = this.cachedSchedule;

    if (!slotState) {
      return {
        currentSlot: 0,
        currentLeader: null,
        nextLeader: null,
        slotAge: -1,
        scheduleAvailable: false,
      };
    }

    const slotAge = Date.now() - slotState.fetchedAt;
    const currentSlot = slotState.slot;

    // If slot data is stale, still return what we have but flag it
    if (!schedule || Date.now() - schedule.fetchedAt > SCHEDULE_CACHE_TTL_MS * 2) {
      return {
        currentSlot,
        currentLeader: null,
        nextLeader: null,
        slotAge,
        scheduleAvailable: false,
      };
    }

    // getLeaderSchedule() returns slot indices relative to the epoch start.
    // Convert absolute slot to relative slot within epoch for lookup.
    const relativeSlot = currentSlot % SLOTS_PER_EPOCH;
    const currentLeader = schedule.slotToLeader.get(relativeSlot) ?? null;
    const nextLeader = schedule.slotToLeader.get(relativeSlot + 1) ?? null;

    return {
      currentSlot,
      currentLeader,
      nextLeader,
      slotAge,
      scheduleAvailable: true,
    };
  }

  /**
   * Get the set of leader validator identities for the next N slots.
   */
  private getUpcomingLeaders(): Set<string> {
    const leaders = new Set<string>();
    const slotState = this.currentSlot;
    const schedule = this.cachedSchedule;

    if (!slotState || !schedule) return leaders;

    if (schedule.slotToLeader.size === 0) return leaders;

    const relativeSlot = slotState.slot % SLOTS_PER_EPOCH;
    for (let offset = 0; offset < LEADER_LOOKAHEAD_SLOTS; offset++) {
      const leader = schedule.slotToLeader.get(relativeSlot + offset);
      if (leader) leaders.add(leader);
    }

    return leaders;
  }

  // ─── Broadcast Ordering ────────────────────────────────────────────────

  /**
   * Get optimally-ordered broadcast connections.
   *
   * Strategy:
   *   1. Identify upcoming leader(s)
   *   2. Rank endpoints by known latency (lowest first)
   *   3. If leader data is available, prefer endpoints with lowest latency
   *      (lower latency endpoints are geographically closer to validators)
   *   4. Always include all endpoints — leader routing only affects ORDER
   *
   * This method NEVER blocks and NEVER fails.
   */
  getBroadcastOrder(primaryConnection: Connection, broadcastConnections: Connection[]): BroadcastOrder {
    this.totalBroadcastCount++;

    // If we have no leader data or only one endpoint, return as-is
    if (broadcastConnections.length <= 1 || !this.currentSlot || !this.cachedSchedule) {
      return {
        connections: broadcastConnections,
        leaderRouted: false,
        targetLeader: null,
      };
    }

    const rpcMgr = getRpcManagerInstance();
    if (!rpcMgr) {
      return {
        connections: broadcastConnections,
        leaderRouted: false,
        targetLeader: null,
      };
    }

    try {
      const upcomingLeaders = this.getUpcomingLeaders();
      if (upcomingLeaders.size === 0) {
        return {
          connections: broadcastConnections,
          leaderRouted: false,
          targetLeader: null,
        };
      }

      // Rank all endpoints by latency (lowest = closest to validators)
      const endpoints = rpcMgr.getEndpoints();
      const endpointLatencies: Array<{ url: string; latency: number; index: number }> = [];

      for (let i = 0; i < endpoints.length; i++) {
        const lat = rpcMgr.getEndpointLatency(endpoints[i].url);
        endpointLatencies.push({
          url: endpoints[i].url,
          latency: lat >= 0 ? lat : 999_999, // Unknown = worst
          index: i,
        });
      }

      // Sort by latency — lowest latency endpoint first
      endpointLatencies.sort((a, b) => a.latency - b.latency);

      // Build connection map: URL -> Connection
      // broadcastConnections[0] is always primaryConnection
      const activeUrl = rpcMgr.activeEndpoint.url;
      const urlToConn = new Map<string, Connection>();
      urlToConn.set(activeUrl, primaryConnection);

      let connIdx = 1; // Skip primary at index 0
      for (const ep of endpoints) {
        if (ep.url !== activeUrl && connIdx < broadcastConnections.length) {
          urlToConn.set(ep.url, broadcastConnections[connIdx]);
          connIdx++;
        }
      }

      // Order connections by latency ranking
      const ordered: Connection[] = [];
      const seen = new Set<Connection>();

      for (const entry of endpointLatencies) {
        const conn = urlToConn.get(entry.url);
        if (conn && !seen.has(conn)) {
          ordered.push(conn);
          seen.add(conn);
        }
      }

      // Append any connections not in the ranking (safety net)
      for (const conn of broadcastConnections) {
        if (!seen.has(conn)) {
          ordered.push(conn);
          seen.add(conn);
        }
      }

      // Track metrics
      this.leaderRoutedCount++;
      const firstUrl = endpointLatencies[0]?.url;
      if (firstUrl) {
        this.endpointFirstCounts.set(firstUrl, (this.endpointFirstCounts.get(firstUrl) ?? 0) + 1);
      }

      const targetLeader = upcomingLeaders.values().next().value ?? null;

      return {
        connections: ordered,
        leaderRouted: true,
        targetLeader,
      };
    } catch {
      // Leader routing must NEVER fail — fall back silently
      return {
        connections: broadcastConnections,
        leaderRouted: false,
        targetLeader: null,
      };
    }
  }

  // ─── Slot Inclusion Tracking ───────────────────────────────────────────

  /**
   * Record the slot at which a transaction was included.
   * Used to compute average slot inclusion delay.
   */
  recordInclusion(submittedAtSlot: number, includedAtSlot: number): void {
    if (submittedAtSlot > 0 && includedAtSlot >= submittedAtSlot) {
      const delay = includedAtSlot - submittedAtSlot;
      this.slotInclusionDelays.push(delay);
      if (this.slotInclusionDelays.length > 100) {
        this.slotInclusionDelays.shift();
      }
    }
  }

  /**
   * Get the current slot at broadcast time (for inclusion tracking).
   */
  getCurrentSlot(): number {
    return this.currentSlot?.slot ?? 0;
  }

  // ─── Metrics ───────────────────────────────────────────────────────────

  getMetrics(): {
    leaderRoutedPct: number;
    avgSlotDelay: number;
    fastestEndpoint: string | null;
    fastestEndpointPct: number;
    scheduleAvailable: boolean;
    currentSlot: number;
  } {
    const leaderRoutedPct =
      this.totalBroadcastCount > 0 ? Math.round((this.leaderRoutedCount / this.totalBroadcastCount) * 100) : 0;

    const avgSlotDelay =
      this.slotInclusionDelays.length > 0
        ? Math.round((this.slotInclusionDelays.reduce((a, b) => a + b, 0) / this.slotInclusionDelays.length) * 10) / 10
        : 0;

    // Find the endpoint that was ranked first most often
    let fastestEndpoint: string | null = null;
    let fastestCount = 0;
    for (const [url, count] of this.endpointFirstCounts) {
      if (count > fastestCount) {
        fastestCount = count;
        fastestEndpoint = url;
      }
    }

    const fastestEndpointPct =
      this.leaderRoutedCount > 0 ? Math.round((fastestCount / this.leaderRoutedCount) * 100) : 0;

    return {
      leaderRoutedPct,
      avgSlotDelay,
      fastestEndpoint,
      fastestEndpointPct,
      scheduleAvailable: this.cachedSchedule !== null,
      currentSlot: this.currentSlot?.slot ?? 0,
    };
  }

  // ─── Connection Management ─────────────────────────────────────────────

  updateConnection(connection: Connection): void {
    this.connection = connection;
  }

  /**
   * Toggle active trading mode for adaptive slot polling.
   * When active, polling interval is reduced to 1s for tighter leader awareness.
   * When inactive, polling interval is restored to 2s to reduce RPC load.
   * Safe to call from acquireTradeLock / releaseTradeLock.
   */
  setActiveTrading(active: boolean): void {
    if (active === this.activeTrading) return;
    this.activeTrading = active;

    // Restart slot watcher with the new interval
    if (this.slotTimer) {
      clearInterval(this.slotTimer);
      this.slotTimer = null;
    }

    const intervalMs = active ? SLOT_POLL_ACTIVE_MS : SLOT_POLL_MS;
    this.slotTimer = setInterval(() => {
      this.fetchSlot();
    }, intervalMs);
    this.slotTimer.unref();

    getLogger().debug('LEADER-ROUTER', `Slot polling ${active ? 'accelerated' : 'restored'} to ${intervalMs}ms`);
  }

  // ─── Shutdown ──────────────────────────────────────────────────────────

  shutdown(): void {
    if (this.slotTimer) {
      clearInterval(this.slotTimer);
      this.slotTimer = null;
    }
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    this.cachedSchedule = null;
    this.currentSlot = null;
    getLogger().info('LEADER-ROUTER', 'Leader router shut down');
  }
}
