/**
 * Trade Journal — Crash-safe transaction tracking.
 *
 * Records pending trades BEFORE broadcast and updates them through the
 * transaction lifecycle: pending → sent → confirmed → removed.
 *
 * If the process crashes mid-transaction, the recovery engine reads
 * this journal on next startup to verify whether the trade landed on-chain.
 *
 * Writes are atomic: data → tmp file → rename to final path.
 * The journal is bounded to MAX_ENTRIES to prevent unbounded disk growth.
 *
 * Lifecycle:
 *   1. recordPending()   — called BEFORE broadcast (market, side, collateral, timestamp)
 *   2. recordSent()      — called AFTER sendRawTransaction returns a signature
 *   3. recordConfirmed() — called AFTER RPC confirmation
 *   4. remove()          — called AFTER confirmation to clean up
 *
 * On corruption: journal is rebuilt as empty with a warning log.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';

const JOURNAL_DIR = join(homedir(), '.flash');
const JOURNAL_FILE = join(JOURNAL_DIR, 'pending-trades.json');
const JOURNAL_TMP = join(JOURNAL_DIR, 'pending-trades.tmp');
const MAX_ENTRIES = 100;
const MAX_FILE_BYTES = 512 * 1024; // 512KB safety limit

export type JournalStatus = 'pending' | 'sent' | 'confirmed';

export interface JournalEntry {
  id: string;
  market: string;
  side: string;
  action: string; // open, close, add_collateral, remove_collateral
  collateral?: number;
  leverage?: number;
  sizeUsd?: number;
  signature?: string;
  status: JournalStatus;
  createdAt: number; // ms timestamp
  updatedAt: number; // ms timestamp
}

interface JournalFile {
  version: 1;
  entries: JournalEntry[];
}

// ─── Singleton ────────────────────────────────────────────────────────────

let _instance: TradeJournal | null = null;

export function getTradeJournal(): TradeJournal {
  if (!_instance) {
    _instance = new TradeJournal();
  }
  return _instance;
}

export class TradeJournal {
  private entries: JournalEntry[] = [];
  private loaded = false;

  constructor() {
    this.load();
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Record a trade as pending BEFORE broadcast.
   * Returns the journal entry ID for subsequent updates.
   */
  recordPending(params: {
    market: string;
    side: string;
    action: string;
    collateral?: number;
    leverage?: number;
    sizeUsd?: number;
  }): string {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const entry: JournalEntry = {
      id,
      market: params.market,
      side: params.side,
      action: params.action,
      collateral: params.collateral,
      leverage: params.leverage,
      sizeUsd: params.sizeUsd,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    this.entries.push(entry);
    this.enforceLimit();
    this.flush();
    return id;
  }

  /**
   * Update entry after signature is obtained from sendRawTransaction.
   */
  recordSent(id: string, signature: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    entry.signature = signature;
    entry.status = 'sent';
    entry.updatedAt = Date.now();
    this.flush();
  }

  /**
   * Mark entry as confirmed after RPC confirmation.
   */
  recordConfirmed(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    entry.status = 'confirmed';
    entry.updatedAt = Date.now();
    this.flush();
  }

  /**
   * Remove entry after successful confirmation (cleanup).
   */
  remove(id: string): void {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx >= 0) {
      this.entries.splice(idx, 1);
      this.flush();
    }
  }

  /**
   * Get all pending/sent entries (for recovery engine).
   */
  getPendingEntries(): JournalEntry[] {
    return this.entries.filter((e) => e.status === 'pending' || e.status === 'sent');
  }

  /**
   * Get all entries (for diagnostics).
   */
  getAllEntries(): readonly JournalEntry[] {
    return this.entries;
  }

  /**
   * Remove stale entries older than maxAgeMs.
   */
  pruneStale(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.updatedAt > cutoff);
    const pruned = before - this.entries.length;
    if (pruned > 0) this.flush();
    return pruned;
  }

  // ─── Persistence ───────────────────────────────────────────────────────

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;

    try {
      if (!existsSync(JOURNAL_FILE)) return;

      const raw = readFileSync(JOURNAL_FILE, 'utf-8');
      if (raw.length > MAX_FILE_BYTES) {
        getLogger().warn('JOURNAL', `Journal file too large (${raw.length} bytes), rebuilding`);
        this.entries = [];
        this.flush();
        return;
      }

      const data = JSON.parse(raw) as JournalFile;

      if (data.version !== 1 || !Array.isArray(data.entries)) {
        getLogger().warn('JOURNAL', 'Journal file has invalid schema, rebuilding');
        this.entries = [];
        this.flush();
        return;
      }

      // Validate each entry
      this.entries = data.entries.filter((e) => {
        if (!e.id || !e.market || !e.side || !e.action || !e.status) return false;
        if (!Number.isFinite(e.createdAt) || !Number.isFinite(e.updatedAt)) return false;
        if (e.createdAt <= 0 || e.updatedAt <= 0) return false;
        return true;
      });

      this.enforceLimit();

      if (this.entries.length > 0) {
        getLogger().info('JOURNAL', `Loaded ${this.entries.length} journal entries`);
      }
    } catch (err: unknown) {
      getLogger().warn(
        'JOURNAL',
        `Failed to load journal, rebuilding: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      this.entries = [];
      this.flush();
    }
  }

  /**
   * Atomic write: data → tmp file → rename to final path.
   * This prevents corruption if the process crashes mid-write.
   */
  private flush(): void {
    try {
      if (!existsSync(JOURNAL_DIR)) {
        mkdirSync(JOURNAL_DIR, { recursive: true, mode: 0o700 });
      }

      const data: JournalFile = {
        version: 1,
        entries: this.entries,
      };

      const json = JSON.stringify(data, null, 2);

      // Safety: don't write if too large
      if (json.length > MAX_FILE_BYTES) {
        getLogger().warn('JOURNAL', 'Journal data too large, trimming to most recent entries');
        this.entries = this.entries.slice(-Math.floor(MAX_ENTRIES / 2));
        const trimmed = JSON.stringify({ version: 1, entries: this.entries }, null, 2);
        writeFileSync(JOURNAL_TMP, trimmed, { mode: 0o600 });
      } else {
        writeFileSync(JOURNAL_TMP, json, { mode: 0o600 });
      }

      // Atomic rename: tmp → final
      renameSync(JOURNAL_TMP, JOURNAL_FILE);
    } catch (err: unknown) {
      // Journal write failure is non-critical — log but don't crash
      try {
        getLogger().warn('JOURNAL', `Failed to write journal: ${err instanceof Error ? err.message : 'unknown'}`);
      } catch {
        /* truly nothing we can do */
      }
    }
  }

  private enforceLimit(): void {
    if (this.entries.length > MAX_ENTRIES) {
      // Keep the most recent entries
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
  }
}
