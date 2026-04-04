/**
 * ATA (Associated Token Account) Resolver
 *
 * Ensures required token accounts exist before transaction execution.
 * Matches Flash Trade website behavior: always include createIdempotent
 * for the target token — no RPC check needed (the instruction is a no-op
 * if the account already exists).
 */

import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

/**
 * Build createAssociatedTokenAccountIdempotent instructions for the given mints.
 * Always includes the instruction — matches Flash Trade website behavior.
 * The idempotent variant is a no-op if the ATA already exists, so no RPC
 * check is needed and no extra latency is added.
 *
 * @param owner  Wallet public key (payer and owner)
 * @param mints  Token mints that need ATAs
 * @returns      createIdempotent instructions (one per mint)
 */
export function buildATAIdempotentIxs(owner: PublicKey, mints: PublicKey[]): TransactionInstruction[] {
  if (mints.length === 0) return [];

  return mints.map((mint) => {
    const ataAddress = getAssociatedTokenAddressSync(mint, owner, true);
    return createAssociatedTokenAccountIdempotentInstruction(
      owner, // payer
      ataAddress, // ATA address
      owner, // owner
      mint, // mint
      TOKEN_PROGRAM_ID,
    );
  });
}

/**
 * Check which ATAs exist and return create instructions for missing ones.
 * Uses idempotent instruction — safe to include even if account exists.
 * This variant does an RPC check first (use buildATAIdempotentIxs to skip the check).
 *
 * @param connection  Solana RPC connection
 * @param owner       Wallet public key (payer and owner)
 * @param mints       Token mints that need ATAs
 * @returns           Instructions to create missing ATAs (empty if all exist)
 */
export async function ensureATAs(
  connection: Connection,
  owner: PublicKey,
  mints: PublicKey[],
): Promise<TransactionInstruction[]> {
  if (mints.length === 0) return [];

  // Derive ATA addresses
  const ataAddresses = mints.map((mint) => getAssociatedTokenAddressSync(mint, owner, true));

  // Batch check which accounts exist
  const accountInfos = await connection.getMultipleAccountsInfo(ataAddresses);

  const instructions: TransactionInstruction[] = [];
  for (let i = 0; i < mints.length; i++) {
    if (!accountInfos[i]) {
      // ATA does not exist — create it (idempotent = no-op if it exists by the time tx lands)
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          owner, // payer
          ataAddresses[i], // ATA address
          owner, // owner
          mints[i], // mint
          TOKEN_PROGRAM_ID,
        ),
      );
    }
  }

  return instructions;
}

/**
 * Get the ATA address for a given owner and mint (no RPC call).
 */
export function getATAAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true);
}
