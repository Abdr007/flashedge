/**
 * Magic-mode local trade history — append-only JSONL at
 * `~/.flash/magic-history.jsonl`.
 *
 * Every magic trade (open / close / partial / increase / TP / SL / limit / etc.)
 * appends one line so the user can see what happened locally even when the
 * audit log got rotated. Independent of `~/.flash/signing-audit.log`, which
 * is the security audit; this is the user-facing journal.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

const LOG_PATH = join(homedir(), '.flash', 'magic-history.jsonl');

export interface MagicTradeEntry {
  ts: string; // ISO timestamp
  type:
    | 'open'
    | 'close'
    | 'partial_close'
    | 'increase'
    | 'reverse'
    | 'add_collateral'
    | 'remove_collateral'
    | 'tp'
    | 'sl'
    | 'limit_place'
    | 'limit_cancel'
    | 'trigger_cancel'
    | 'liquidate'
    | 'deposit'
    | 'withdraw'
    | 'settle';
  market?: string;
  side?: 'long' | 'short';
  collateralUsd?: number;
  sizeUsd?: number;
  leverage?: number;
  triggerPriceUsd?: number;
  txSignature: string;
  network: 'mainnet-beta' | 'devnet';
  walletAddress: string;
}

function ensure(): void {
  const dir = dirname(LOG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function recordMagicTrade(entry: MagicTradeEntry): void {
  try {
    ensure();
    appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch {
    // best-effort — don't crash on log failure
  }
}

/** Read most recent N entries, newest last. */
export function readMagicHistory(limit = 20, walletFilter?: string): MagicTradeEntry[] {
  if (!existsSync(LOG_PATH)) return [];
  try {
    const lines = readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
    const entries: MagicTradeEntry[] = [];
    for (const ln of lines) {
      try {
        const e = JSON.parse(ln) as MagicTradeEntry;
        if (walletFilter && e.walletAddress !== walletFilter) continue;
        entries.push(e);
      } catch {
        /* skip corrupt line */
      }
    }
    return entries.slice(-limit);
  } catch {
    return [];
  }
}
