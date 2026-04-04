/**
 * Recovery Engine — Crash recovery on terminal startup.
 *
 * Runs BEFORE normal startup completes. Checks the trade journal for
 * pending/sent transactions that were interrupted (process crash, network
 * loss, etc.) and verifies their on-chain status.
 *
 * Recovery rules:
 *   - NEVER executes new trades
 *   - NEVER modifies risk calculations
 *   - NEVER blocks startup longer than 3 seconds
 *   - If RPC unavailable: skip verification, log warning
 *   - Read-only: only queries blockchain, never sends transactions
 *
 * Startup sequence integration:
 *   1. Load configuration
 *   2. Run recovery engine  ← THIS MODULE
 *   3. Verify pending transactions
 *   4. Synchronize positions (state reconciler)
 *   5. Continue normal startup
 */

import { Connection } from '@solana/web3.js';
import { getLogger } from '../utils/logger.js';
import { getTradeJournal, JournalEntry } from '../journal/trade-journal.js';

const RECOVERY_TIMEOUT_MS = 3_000; // Max 3s for entire recovery
const SIGNATURE_CHECK_TIMEOUT_MS = 2_000; // Per-signature RPC check
const STALE_ENTRY_AGE_MS = 24 * 60 * 60_000; // 24h — entries older than this are pruned

export interface RecoveryResult {
  recovered: number; // entries confirmed on-chain
  failed: number; // entries that did not land
  pruned: number; // stale entries removed
  skipped: boolean; // true if recovery was skipped (no RPC, no entries)
  durationMs: number;
}

/**
 * Run crash recovery. Call once during startup, before normal operation begins.
 *
 * @param connection - Solana RPC connection (or null if unavailable)
 * @returns Recovery result summary
 */
export async function runRecovery(connection: Connection | null): Promise<RecoveryResult> {
  const logger = getLogger();
  const startTime = Date.now();

  const result: RecoveryResult = {
    recovered: 0,
    failed: 0,
    pruned: 0,
    skipped: false,
    durationMs: 0,
  };

  try {
    const journal = getTradeJournal();

    // Prune stale entries (older than 24h)
    result.pruned = journal.pruneStale(STALE_ENTRY_AGE_MS);
    if (result.pruned > 0) {
      logger.info('RECOVERY', `Pruned ${result.pruned} stale journal entries (>24h old)`);
    }

    // Get pending/sent entries
    const pending = journal.getPendingEntries();
    if (pending.length === 0) {
      result.skipped = true;
      result.durationMs = Date.now() - startTime;
      return result;
    }

    logger.info('RECOVERY', `Found ${pending.length} pending transaction(s) from previous session`);

    if (!connection) {
      logger.warn('RECOVERY', 'RPC unavailable — skipping transaction verification');
      result.skipped = true;
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // Verify each pending entry with timeout enforcement
    for (const entry of pending) {
      // Enforce total timeout
      if (Date.now() - startTime >= RECOVERY_TIMEOUT_MS) {
        logger.warn('RECOVERY', `Recovery timeout (${RECOVERY_TIMEOUT_MS}ms) — remaining entries skipped`);
        break;
      }

      await verifyEntry(entry, connection, journal, result, logger);
    }
  } catch (err: unknown) {
    logger.warn('RECOVERY', `Recovery engine error: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  result.durationMs = Date.now() - startTime;

  if (result.recovered > 0 || result.failed > 0) {
    logger.info(
      'RECOVERY',
      `Recovery complete: ${result.recovered} confirmed, ${result.failed} unconfirmed (${result.durationMs}ms)`,
    );
  }

  return result;
}

async function verifyEntry(
  entry: JournalEntry,
  connection: Connection,
  journal: ReturnType<typeof getTradeJournal>,
  result: RecoveryResult,
  logger: ReturnType<typeof getLogger>,
): Promise<void> {
  const label = `${entry.action} ${entry.market} ${entry.side}`;

  // Entries without a signature were never broadcast
  if (!entry.signature) {
    logger.info('RECOVERY', `${label}: no signature (never broadcast) — removing`);
    journal.remove(entry.id);
    result.failed++;
    return;
  }

  try {
    // Check on-chain status with per-signature timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SIGNATURE_CHECK_TIMEOUT_MS);

    try {
      const { value } = await connection.getSignatureStatuses([entry.signature]);
      const status = value?.[0];

      if (
        status &&
        !status.err &&
        (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
      ) {
        // Transaction landed on-chain
        logger.info('RECOVERY', `${label}: confirmed on-chain (${entry.signature.slice(0, 12)}...)`);
        journal.recordConfirmed(entry.id);
        journal.remove(entry.id);
        result.recovered++;
      } else if (status?.err) {
        // Transaction failed on-chain
        logger.warn('RECOVERY', `${label}: failed on-chain (${JSON.stringify(status.err)})`);
        journal.remove(entry.id);
        result.failed++;
      } else {
        // Transaction not found — likely expired or never landed
        const ageMs = Date.now() - entry.createdAt;
        if (ageMs > 5 * 60_000) {
          // Older than 5 minutes — blockhash expired, won't land
          logger.info('RECOVERY', `${label}: not found on-chain (${Math.round(ageMs / 1000)}s old) — removing`);
          journal.remove(entry.id);
          result.failed++;
        } else {
          // Recent — might still be in flight, leave in journal
          logger.info('RECOVERY', `${label}: not yet confirmed (${Math.round(ageMs / 1000)}s old) — keeping`);
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err: unknown) {
    // RPC failure for this specific signature — don't remove, might recover next startup
    logger.debug('RECOVERY', `${label}: verification failed (${err instanceof Error ? err.message : 'unknown'})`);
  }
}
