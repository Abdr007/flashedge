/**
 * SQLite Trade Journal — optional persistent backend.
 *
 * Activated by setting JOURNAL_DB=sqlite in environment.
 * Falls back to file-based journal when not configured or on import failure.
 *
 * Schema is auto-created on first use. All writes are synchronous
 * (better-sqlite3 is sync by design) which matches the crash-safety
 * requirement: data is flushed before the function returns.
 */

import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { createRequire } from 'module';
import type { JournalEntry, JournalStatus } from './trade-journal.js';
import type { BetterSqliteDatabase, BetterSqliteConstructor } from '../types/flash-sdk-interfaces.js';

const DB_DIR = join(homedir(), '.flash');
const DB_PATH = join(DB_DIR, 'journal.db');
const MAX_ENTRIES = 1000;

const require = createRequire(import.meta.url);

let _db: BetterSqliteDatabase | null = null;

interface DbRow {
  id: string;
  market: string;
  side: string;
  action: string;
  collateral: number | null;
  leverage: number | null;
  size_usd: number | null;
  signature: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

function getDb(): BetterSqliteDatabase {
  if (_db) return _db;

  let Database: BetterSqliteConstructor;
  try {
    Database = require('better-sqlite3') as BetterSqliteConstructor;
  } catch {
    throw new Error('better-sqlite3 not installed. Run: npm install better-sqlite3');
  }

  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      market TEXT NOT NULL,
      side TEXT NOT NULL,
      action TEXT NOT NULL,
      collateral REAL,
      leverage REAL,
      size_usd REAL,
      signature TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  _db.exec(`
    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
    CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at);
  `);

  return _db;
}

function rowToEntry(row: DbRow): JournalEntry {
  return {
    id: row.id,
    market: row.market,
    side: row.side,
    action: row.action,
    collateral: row.collateral ?? undefined,
    leverage: row.leverage ?? undefined,
    sizeUsd: row.size_usd ?? undefined,
    signature: row.signature ?? undefined,
    status: row.status as JournalStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteJournal {
  private db: BetterSqliteDatabase;

  constructor() {
    this.db = getDb();
  }

  recordPending(params: {
    market: string;
    side: string;
    action: string;
    collateral?: number;
    leverage?: number;
    sizeUsd?: number;
  }): string {
    const id = `tj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    this.db
      .prepare(
        `
      INSERT INTO trades (id, market, side, action, collateral, leverage, size_usd, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `,
      )
      .run(
        id,
        params.market,
        params.side,
        params.action,
        params.collateral ?? null,
        params.leverage ?? null,
        params.sizeUsd ?? null,
        now,
        now,
      );

    this.prune();
    return id;
  }

  recordSent(id: string, signature: string): void {
    this.db
      .prepare(
        `
      UPDATE trades SET status = 'sent', signature = ?, updated_at = ? WHERE id = ?
    `,
      )
      .run(signature, Date.now(), id);
  }

  recordConfirmed(id: string): void {
    this.db
      .prepare(
        `
      UPDATE trades SET status = 'confirmed', updated_at = ? WHERE id = ?
    `,
      )
      .run(Date.now(), id);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM trades WHERE id = ?').run(id);
  }

  getPending(): JournalEntry[] {
    return (
      this.db
        .prepare("SELECT * FROM trades WHERE status IN ('pending', 'sent') ORDER BY created_at ASC")
        .all() as unknown as DbRow[]
    ).map(rowToEntry);
  }

  getAll(): JournalEntry[] {
    return (this.db.prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT 100').all() as unknown as DbRow[]).map(
      rowToEntry,
    );
  }

  private prune(): void {
    const count =
      (this.db.prepare('SELECT COUNT(*) as cnt FROM trades').get() as { cnt: number } | undefined)?.cnt ?? 0;
    if (count > MAX_ENTRIES) {
      this.db
        .prepare(
          `
        DELETE FROM trades WHERE id IN (
          SELECT id FROM trades ORDER BY created_at ASC LIMIT ?
        )
      `,
        )
        .run(count - MAX_ENTRIES);
    }
  }

  close(): void {
    if (_db) {
      _db.close();
      _db = null;
    }
  }
}

/** Check if SQLite journal is configured. */
export function isSqliteJournalEnabled(): boolean {
  return (process.env.JOURNAL_DB ?? '').toLowerCase() === 'sqlite';
}
