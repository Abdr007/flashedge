/**
 * ALT (Address Lookup Table) Verification Tests
 *
 * Verifies the complete ALT pipeline:
 * - Lookup table content validation (addresses exist)
 * - Account overlap detection (tx accounts match ALT entries)
 * - Compilation with ALTs (message.addressTableLookups populated)
 * - Diagnostics and cache management
 * - Fallback when ALTs unavailable
 * - Force test with many accounts to trigger ALT compression
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  Keypair,
  AddressLookupTableAccount,
} from '@solana/web3.js';
import {
  resolveALTs,
  clearALTCache,
  verifyALTAccountOverlap,
  getALTDiagnostics,
  getALTCacheAge,
  logMessageALTDiagnostics,
} from '../src/transaction/alt-resolver.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a mock ALT with real addresses. */
function createMockALT(addresses: PublicKey[]): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: BigInt('18446744073709551615'), // u64::MAX = active
      lastExtendedSlot: 100,
      lastExtendedSlotStartIndex: 0,
      authority: Keypair.generate().publicKey,
      addresses,
    },
  });
}

/** Create a transaction instruction using specific accounts. */
function makeIx(accounts: PublicKey[], programId?: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    keys: accounts.map((pubkey, i) => ({
      pubkey,
      isSigner: i === 0,
      isWritable: i < 2,
    })),
    programId: programId ?? Keypair.generate().publicKey,
    data: Buffer.alloc(16),
  });
}

// ─── STEP 1: Verify Lookup Table Content ─────────────────────────────────────

describe('ALT Content Verification', () => {
  beforeEach(() => clearALTCache());

  it('detects ALT with addresses', async () => {
    const addresses = Array.from({ length: 10 }, () => Keypair.generate().publicKey);
    const mockALT = createMockALT(addresses);

    const mockClient = {
      getOrLoadAddressLookupTable: vi.fn().mockResolvedValue({
        addressLookupTables: [mockALT],
      }),
    };

    const result = await resolveALTs(mockClient, { poolName: 'TestPool' } as any);
    expect(result).toHaveLength(1);
    expect(result[0].state.addresses).toHaveLength(10);
  });

  it('logs warning for ALT with zero addresses', async () => {
    const emptyALT = createMockALT([]);

    const mockClient = {
      getOrLoadAddressLookupTable: vi.fn().mockResolvedValue({
        addressLookupTables: [emptyALT],
      }),
    };

    const result = await resolveALTs(mockClient, { poolName: 'EmptyPool' } as any);
    // Still returns the table (SDK may populate later), but warns
    expect(result).toHaveLength(1);
    expect(result[0].state.addresses).toHaveLength(0);
  });

  it('returns diagnostics for cached ALTs', async () => {
    const addresses = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
    const mockALT = createMockALT(addresses);

    const mockClient = {
      getOrLoadAddressLookupTable: vi.fn().mockResolvedValue({
        addressLookupTables: [mockALT],
      }),
    };

    await resolveALTs(mockClient, { poolName: 'DiagPool' } as any);

    const diag = getALTDiagnostics('DiagPool');
    expect(diag).not.toBeNull();
    expect(diag!.tableCount).toBe(1);
    expect(diag!.totalAddresses).toBe(5);
    expect(diag!.tablesWithAddresses).toBe(1);
    expect(diag!.tableDetails[0].addressCount).toBe(5);
  });

  it('returns null diagnostics for unknown pool', () => {
    expect(getALTDiagnostics('NonExistent')).toBeNull();
  });

  it('tracks cache age', async () => {
    const mockClient = {
      getOrLoadAddressLookupTable: vi.fn().mockResolvedValue({
        addressLookupTables: [createMockALT([Keypair.generate().publicKey])],
      }),
    };

    expect(getALTCacheAge('AgePool')).toBe(-1);

    await resolveALTs(mockClient, { poolName: 'AgePool' } as any);

    const age = getALTCacheAge('AgePool');
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(1000);
  });
});

// ─── STEP 2: Verify ALT Extension (address content) ─────────────────────────

describe('ALT Extension Verification', () => {
  it('ALT contains protocol-like accounts', async () => {
    // Simulate an ALT that contains typical Flash Trade protocol accounts
    const programId = Keypair.generate().publicKey;
    const poolAccount = Keypair.generate().publicKey;
    const custodyAccount = Keypair.generate().publicKey;
    const oracleAccount = Keypair.generate().publicKey;
    const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const systemProgram = new PublicKey('11111111111111111111111111111111');

    const addresses = [programId, poolAccount, custodyAccount, oracleAccount, tokenProgram, systemProgram];
    const alt = createMockALT(addresses);

    expect(alt.state.addresses).toHaveLength(6);
    expect(alt.state.addresses.map(a => a.toBase58())).toContain(tokenProgram.toBase58());
    expect(alt.state.addresses.map(a => a.toBase58())).toContain(systemProgram.toBase58());
  });
});

// ─── STEP 3 & 4: Verify ALT Usage During Compilation + Account Matching ─────

describe('ALT Compilation Verification', () => {
  it('compileToV0Message with ALT produces addressTableLookups', () => {
    const payer = Keypair.generate();

    // Create shared accounts that appear in both the instruction AND the ALT
    const sharedAccounts = Array.from({ length: 8 }, () => Keypair.generate().publicKey);
    const alt = createMockALT(sharedAccounts);

    // Create instruction that references the shared accounts
    const ix = new TransactionInstruction({
      keys: sharedAccounts.map((pubkey, i) => ({
        pubkey,
        isSigner: false,
        isWritable: i < 4,
      })),
      programId: Keypair.generate().publicKey,
      data: Buffer.alloc(32),
    });

    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      instructions: [ix],
      recentBlockhash: 'GDDMwNyyx8uB6zqW2ih1UzsHi3xQ5emyXAGaicKE1ZCR',
    }).compileToV0Message([alt]);

    // STEP 5: Verify message.addressTableLookups is populated
    expect(message.addressTableLookups.length).toBeGreaterThan(0);

    const lookup = message.addressTableLookups[0];
    expect(lookup.accountKey.toBase58()).toBe(alt.key.toBase58());
    // Writable + readonly indexes should cover the shared accounts
    const totalLookupAccounts = lookup.writableIndexes.length + lookup.readonlyIndexes.length;
    expect(totalLookupAccounts).toBe(8); // all 8 shared accounts compressed
  });

  it('compileToV0Message without ALT has empty addressTableLookups', () => {
    const payer = Keypair.generate();
    const ix = new TransactionInstruction({
      keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
      programId: Keypair.generate().publicKey,
      data: Buffer.alloc(8),
    });

    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      instructions: [ix],
      recentBlockhash: 'GDDMwNyyx8uB6zqW2ih1UzsHi3xQ5emyXAGaicKE1ZCR',
    }).compileToV0Message([]);

    expect(message.addressTableLookups).toHaveLength(0);
  });

  it('ALT is ignored when no accounts overlap', () => {
    const payer = Keypair.generate();

    // ALT contains different accounts than the instruction
    const altAccounts = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
    const ixAccounts = Array.from({ length: 3 }, () => Keypair.generate().publicKey);
    const alt = createMockALT(altAccounts);

    const ix = new TransactionInstruction({
      keys: ixAccounts.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
      programId: Keypair.generate().publicKey,
      data: Buffer.alloc(16),
    });

    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      instructions: [ix],
      recentBlockhash: 'GDDMwNyyx8uB6zqW2ih1UzsHi3xQ5emyXAGaicKE1ZCR',
    }).compileToV0Message([alt]);

    // No overlap = no lookups used
    expect(message.addressTableLookups).toHaveLength(0);
  });
});

// ─── STEP 4: Account Overlap Verification ────────────────────────────────────

describe('ALT Account Overlap Detection', () => {
  it('detects full overlap', () => {
    const sharedAccounts = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
    const alt = createMockALT(sharedAccounts);
    const ix = makeIx(sharedAccounts);

    const result = verifyALTAccountOverlap([ix], [alt]);
    // programId is unique (not in ALT), so not all accounts overlap
    expect(result.compressible).toBe(5); // the 5 shared accounts
    expect(result.compressionRatio).toBeGreaterThan(0.5);
  });

  it('detects zero overlap', () => {
    const altAccounts = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
    const ixAccounts = Array.from({ length: 3 }, () => Keypair.generate().publicKey);
    const alt = createMockALT(altAccounts);
    const ix = makeIx(ixAccounts);

    const result = verifyALTAccountOverlap([ix], [alt]);
    expect(result.compressible).toBe(0);
    expect(result.compressionRatio).toBe(0);
  });

  it('detects partial overlap', () => {
    const sharedAccounts = Array.from({ length: 3 }, () => Keypair.generate().publicKey);
    const uniqueAccounts = Array.from({ length: 2 }, () => Keypair.generate().publicKey);
    const alt = createMockALT(sharedAccounts);
    const ix = makeIx([...sharedAccounts, ...uniqueAccounts]);

    const result = verifyALTAccountOverlap([ix], [alt]);
    expect(result.compressible).toBe(3);
    expect(result.totalAccounts).toBeGreaterThan(3);
    expect(result.compressionRatio).toBeGreaterThan(0);
    expect(result.compressionRatio).toBeLessThan(1);
  });

  it('handles empty instructions', () => {
    const alt = createMockALT([Keypair.generate().publicKey]);
    const result = verifyALTAccountOverlap([], [alt]);
    expect(result.totalAccounts).toBe(0);
    expect(result.compressible).toBe(0);
  });

  it('handles empty ALTs', () => {
    const ix = makeIx([Keypair.generate().publicKey, Keypair.generate().publicKey]);
    const result = verifyALTAccountOverlap([ix], []);
    expect(result.totalAccounts).toBeGreaterThan(0);
    expect(result.compressible).toBe(0);
    expect(result.compressionRatio).toBe(0);
  });
});

// ─── STEP 6: Transaction Size Trigger ────────────────────────────────────────

describe('ALT Size Trigger', () => {
  it('small transaction does not benefit from ALT', () => {
    const payer = Keypair.generate();
    const ix = new TransactionInstruction({
      keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }],
      programId: Keypair.generate().publicKey,
      data: Buffer.alloc(8),
    });

    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      instructions: [ix],
      recentBlockhash: 'GDDMwNyyx8uB6zqW2ih1UzsHi3xQ5emyXAGaicKE1ZCR',
    }).compileToV0Message([]);

    // Small tx — few static accounts, ALT not needed
    expect(message.staticAccountKeys.length).toBeLessThan(10);
    expect(message.addressTableLookups).toHaveLength(0);
  });

  it('large transaction benefits from ALT compression', () => {
    const payer = Keypair.generate();

    // Generate many shared accounts (simulates Flash Trade protocol accounts)
    const sharedAccounts = Array.from({ length: 20 }, () => Keypair.generate().publicKey);
    const alt = createMockALT(sharedAccounts);
    const program = Keypair.generate().publicKey;

    // Create multiple instructions referencing the shared accounts
    const instructions = [];
    for (let i = 0; i < 3; i++) {
      const slice = sharedAccounts.slice(i * 6, (i + 1) * 6 + 2);
      instructions.push(new TransactionInstruction({
        keys: slice.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
        programId: program,
        data: Buffer.alloc(32),
      }));
    }

    // Compile WITHOUT ALT
    const msgWithout = new TransactionMessage({
      payerKey: payer.publicKey,
      instructions,
      recentBlockhash: 'GDDMwNyyx8uB6zqW2ih1UzsHi3xQ5emyXAGaicKE1ZCR',
    }).compileToV0Message([]);

    // Compile WITH ALT
    const msgWith = new TransactionMessage({
      payerKey: payer.publicKey,
      instructions,
      recentBlockhash: 'GDDMwNyyx8uB6zqW2ih1UzsHi3xQ5emyXAGaicKE1ZCR',
    }).compileToV0Message([alt]);

    // With ALT: fewer static accounts, lookup entries populated
    expect(msgWith.staticAccountKeys.length).toBeLessThan(msgWithout.staticAccountKeys.length);
    expect(msgWith.addressTableLookups.length).toBeGreaterThan(0);
    expect(msgWithout.addressTableLookups).toHaveLength(0);

    // Verify actual size savings
    const txWithout = new VersionedTransaction(msgWithout);
    const txWith = new VersionedTransaction(msgWith);
    const sizeWithout = txWithout.serialize().length;
    const sizeWith = txWith.serialize().length;

    // ALT should produce a smaller transaction
    expect(sizeWith).toBeLessThan(sizeWithout);
  });
});

// ─── STEP 7: Force Test (Many Accounts) ─────────────────────────────────────

describe('ALT Force Test', () => {
  it('ALT compresses 30+ account transaction', () => {
    const payer = Keypair.generate();
    const program = Keypair.generate().publicKey;

    // Simulate a complex multi-instruction transaction (like open + TP + SL)
    // with many shared protocol accounts
    const protocolAccounts = Array.from({ length: 30 }, () => Keypair.generate().publicKey);
    const alt = createMockALT(protocolAccounts);

    const instructions: TransactionInstruction[] = [];

    // "Open position" instruction — uses accounts 0-14
    instructions.push(new TransactionInstruction({
      keys: protocolAccounts.slice(0, 15).map(pubkey => ({
        pubkey, isSigner: false, isWritable: true,
      })),
      programId: program,
      data: Buffer.alloc(64),
    }));

    // "Take profit" instruction — uses accounts 5-20 (overlaps with open)
    instructions.push(new TransactionInstruction({
      keys: protocolAccounts.slice(5, 21).map(pubkey => ({
        pubkey, isSigner: false, isWritable: true,
      })),
      programId: program,
      data: Buffer.alloc(48),
    }));

    // "Stop loss" instruction — uses accounts 5-25 (overlaps with both)
    instructions.push(new TransactionInstruction({
      keys: protocolAccounts.slice(5, 26).map(pubkey => ({
        pubkey, isSigner: false, isWritable: true,
      })),
      programId: program,
      data: Buffer.alloc(48),
    }));

    // Compile with ALT
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      instructions,
      recentBlockhash: 'GDDMwNyyx8uB6zqW2ih1UzsHi3xQ5emyXAGaicKE1ZCR',
    }).compileToV0Message([alt]);

    // Verify ALT was used
    expect(message.addressTableLookups.length).toBe(1);
    const lookup = message.addressTableLookups[0];
    const compressedCount = lookup.writableIndexes.length + lookup.readonlyIndexes.length;
    // Most of the 26 unique protocol accounts should be compressed
    expect(compressedCount).toBeGreaterThanOrEqual(20);

    // Verify significant size savings
    const msgWithout = new TransactionMessage({
      payerKey: payer.publicKey,
      instructions,
      recentBlockhash: 'GDDMwNyyx8uB6zqW2ih1UzsHi3xQ5emyXAGaicKE1ZCR',
    }).compileToV0Message([]);

    const sizeWith = new VersionedTransaction(message).serialize().length;
    const sizeWithout = new VersionedTransaction(msgWithout).serialize().length;

    // Each compressed account saves ~31 bytes (32 byte address → 1 byte index)
    const savings = sizeWithout - sizeWith;
    expect(savings).toBeGreaterThan(300); // significant savings
  });
});

// ─── STEP 8: Fallback and Cache Behavior ─────────────────────────────────────

describe('ALT Fallback Behavior', () => {
  beforeEach(() => clearALTCache());

  it('falls back to perpClient.addressLookupTables on error', async () => {
    const fallbackALT = createMockALT([Keypair.generate().publicKey]);

    const mockClient = {
      getOrLoadAddressLookupTable: vi.fn().mockRejectedValue(new Error('RPC down')),
      addressLookupTables: [fallbackALT],
    };

    const result = await resolveALTs(mockClient, { poolName: 'FallbackPool' } as any);
    expect(result).toHaveLength(1);
    expect(result[0].key.toBase58()).toBe(fallbackALT.key.toBase58());
  });

  it('returns empty when both sources fail', async () => {
    const mockClient = {
      getOrLoadAddressLookupTable: vi.fn().mockRejectedValue(new Error('RPC down')),
      // No addressLookupTables property
    };

    const result = await resolveALTs(mockClient, { poolName: 'FailPool' } as any);
    expect(result).toEqual([]);
  });

  it('cache is cleared properly', async () => {
    const mockClient = {
      getOrLoadAddressLookupTable: vi.fn().mockResolvedValue({
        addressLookupTables: [createMockALT([Keypair.generate().publicKey])],
      }),
    };

    await resolveALTs(mockClient, { poolName: 'ClearPool' } as any);
    expect(getALTDiagnostics('ClearPool')).not.toBeNull();

    clearALTCache();
    expect(getALTDiagnostics('ClearPool')).toBeNull();
  });

  it('different pools have independent caches', async () => {
    const alt1 = createMockALT(Array.from({ length: 3 }, () => Keypair.generate().publicKey));
    const alt2 = createMockALT(Array.from({ length: 7 }, () => Keypair.generate().publicKey));

    const mockClient = {
      getOrLoadAddressLookupTable: vi.fn()
        .mockResolvedValueOnce({ addressLookupTables: [alt1] })
        .mockResolvedValueOnce({ addressLookupTables: [alt2] }),
    };

    await resolveALTs(mockClient, { poolName: 'Pool1' } as any);
    await resolveALTs(mockClient, { poolName: 'Pool2' } as any);

    const diag1 = getALTDiagnostics('Pool1');
    const diag2 = getALTDiagnostics('Pool2');

    expect(diag1!.totalAddresses).toBe(3);
    expect(diag2!.totalAddresses).toBe(7);
  });
});

// ─── Message Diagnostics ─────────────────────────────────────────────────────

describe('ALT Message Diagnostics', () => {
  it('logMessageALTDiagnostics does not throw', () => {
    const payer = Keypair.generate();
    const ix = new TransactionInstruction({
      keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }],
      programId: Keypair.generate().publicKey,
      data: Buffer.alloc(8),
    });

    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      instructions: [ix],
      recentBlockhash: 'GDDMwNyyx8uB6zqW2ih1UzsHi3xQ5emyXAGaicKE1ZCR',
    }).compileToV0Message([]);

    // Should not throw
    expect(() => logMessageALTDiagnostics(message, 'test')).not.toThrow();
  });

  it('logMessageALTDiagnostics handles ALT lookups', () => {
    const payer = Keypair.generate();
    const sharedAccounts = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
    const alt = createMockALT(sharedAccounts);

    const ix = new TransactionInstruction({
      keys: sharedAccounts.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })),
      programId: Keypair.generate().publicKey,
      data: Buffer.alloc(16),
    });

    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      instructions: [ix],
      recentBlockhash: 'GDDMwNyyx8uB6zqW2ih1UzsHi3xQ5emyXAGaicKE1ZCR',
    }).compileToV0Message([alt]);

    // Should not throw, even with ALT lookups
    expect(() => logMessageALTDiagnostics(message, 'test-with-alt')).not.toThrow();
  });
});
