/**
 * Instruction Aggregator
 *
 * Collects multiple SDK instruction sets into a single ordered batch
 * for atomic transaction execution. Handles signer deduplication
 * and size estimation.
 */

import {
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  PublicKey,
  type AddressLookupTableAccount,
} from '@solana/web3.js';
import type { Signer } from '@solana/web3.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface InstructionBatch {
  instructions: TransactionInstruction[];
  additionalSigners: Signer[];
  labels: string[];
  /** H3: Track instruction count per label for correct splitting */
  ixCountPerLabel: number[];
}

export interface SdkResult {
  instructions: TransactionInstruction[];
  additionalSigners: Signer[];
}

// Solana max transaction size
const MAX_TX_SIZE = 1232;
// Safety margin — leave room for signatures and padding
const SAFE_TX_SIZE = 1180;

// ─── Batch Operations ───────────────────────────────────────────────────────

/** Create an empty instruction batch. */
export function createBatch(): InstructionBatch {
  return { instructions: [], additionalSigners: [], labels: [], ixCountPerLabel: [] };
}

/**
 * Append an SDK result (instructions + signers) to the batch.
 * Deduplicates signers by public key.
 */
export function appendToBatch(batch: InstructionBatch, result: SdkResult, label: string): void {
  batch.instructions.push(...result.instructions);
  batch.labels.push(label);
  batch.ixCountPerLabel.push(result.instructions.length);

  // Deduplicate signers by pubkey
  const existingKeys = new Set(batch.additionalSigners.map((s) => s.publicKey.toBase58()));
  for (const signer of result.additionalSigners) {
    if (!existingKeys.has(signer.publicKey.toBase58())) {
      batch.additionalSigners.push(signer);
      existingKeys.add(signer.publicKey.toBase58());
    }
  }
}

/**
 * Estimate the serialized size of a batch when compiled into a V0 transaction.
 * Uses a dummy blockhash to avoid RPC calls.
 */
export function estimateBatchSize(
  batch: InstructionBatch,
  payerKey: PublicKey,
  altAccounts?: AddressLookupTableAccount[],
): number {
  if (batch.instructions.length === 0) return 0;

  try {
    const message = new TransactionMessage({
      payerKey,
      instructions: batch.instructions,
      recentBlockhash: 'GDDMwNyyx8uB6zqW2ih1UzsHi3xQ5emyXAGaicKE1ZCR', // dummy blockhash for size estimation
    }).compileToV0Message(altAccounts ?? []);

    const tx = new VersionedTransaction(message);
    return tx.serialize().length;
  } catch {
    // If compilation fails, return max size to trigger split
    return MAX_TX_SIZE + 1;
  }
}

/** Check if the batch fits within the safe transaction size limit. */
export function isBatchWithinLimit(
  batch: InstructionBatch,
  payerKey: PublicKey,
  altAccounts?: AddressLookupTableAccount[],
): boolean {
  return estimateBatchSize(batch, payerKey, altAccounts) <= SAFE_TX_SIZE;
}

/**
 * Split a batch into two: primary (first label) and secondary (remaining).
 * Used as fallback when the combined batch exceeds the size limit.
 */
export function splitBatch(batch: InstructionBatch): [InstructionBatch, InstructionBatch] {
  if (batch.labels.length <= 1) {
    return [batch, createBatch()];
  }

  // H3 fix: Split using tracked ixCountPerLabel
  const firstLabelIxCount = batch.ixCountPerLabel[0] ?? batch.instructions.length;
  const _primary = createBatch();
  const _secondary = createBatch();

  _primary.instructions = batch.instructions.slice(0, firstLabelIxCount);
  _primary.labels = [batch.labels[0]];
  _primary.ixCountPerLabel = [firstLabelIxCount];

  _secondary.instructions = batch.instructions.slice(firstLabelIxCount);
  _secondary.labels = batch.labels.slice(1);
  _secondary.ixCountPerLabel = batch.ixCountPerLabel.slice(1);

  // Signers: both batches get all signers (dedup is already done)
  _primary.additionalSigners = [...batch.additionalSigners];
  _secondary.additionalSigners = [...batch.additionalSigners];

  return [_primary, _secondary];
}

/** Get a human-readable summary of the batch contents. */
export function batchSummary(batch: InstructionBatch): string {
  return `${batch.instructions.length} instructions [${batch.labels.join(' + ')}]`;
}
