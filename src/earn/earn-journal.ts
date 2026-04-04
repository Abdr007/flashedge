/**
 * Earn Journal — tracks deposit/withdraw/stake/unstake actions for PnL calculation.
 *
 * Persists to ~/.flash/earn-journal.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface EarnJournalEntry {
  pool: string;
  action: 'deposit' | 'withdraw';
  amountUsd: number;
  timestamp: number;
  txSignature: string;
}

const JOURNAL_FILE = join(homedir(), '.flash', 'earn-journal.json');
const MAX_ENTRIES = 5000;

/** Append an earn action to the journal. */
export function recordEarnAction(entry: EarnJournalEntry): void {
  try {
    const dir = join(homedir(), '.flash');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

    const entries = getEarnJournal();
    entries.push(entry);

    // Cap journal size
    while (entries.length > MAX_ENTRIES) entries.shift();

    writeFileSync(JOURNAL_FILE, JSON.stringify(entries, null, 2), { mode: 0o600 });
  } catch {
    /* non-critical — don't break transactions */
  }
}

/** Read all journal entries. */
export function getEarnJournal(): EarnJournalEntry[] {
  try {
    if (!existsSync(JOURNAL_FILE)) return [];
    const raw = readFileSync(JOURNAL_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    // Basic validation
    return data.filter(
      (e: unknown) =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as EarnJournalEntry).pool === 'string' &&
        typeof (e as EarnJournalEntry).action === 'string' &&
        typeof (e as EarnJournalEntry).amountUsd === 'number' &&
        Number.isFinite((e as EarnJournalEntry).amountUsd),
    ) as EarnJournalEntry[];
  } catch {
    return [];
  }
}

/** Sum deposits and withdrawals for a given pool. */
export function getPoolDeposits(poolId: string): { totalDeposited: number; totalWithdrawn: number } {
  const entries = getEarnJournal();
  let totalDeposited = 0;
  let totalWithdrawn = 0;

  for (const e of entries) {
    if (e.pool !== poolId) continue;
    if (e.action === 'deposit') {
      totalDeposited += e.amountUsd;
    } else if (e.action === 'withdraw') {
      totalWithdrawn += e.amountUsd;
    }
  }

  return { totalDeposited, totalWithdrawn };
}
