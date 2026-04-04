/**
 * Atomic Transaction Pipeline Tests
 *
 * Verifies:
 * - Instruction aggregation (batch creation, append, signer dedup)
 * - Batch size estimation and limit checking
 * - ALT resolver caching and graceful degradation
 * - ATA resolver instruction generation
 * - Atomic open + TP/SL flow
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey, TransactionInstruction, Keypair } from '@solana/web3.js';
import {
  createBatch,
  appendToBatch,
  estimateBatchSize,
  isBatchWithinLimit,
  batchSummary,
  type SdkResult,
} from '../src/transaction/instruction-aggregator.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockInstruction(dataSize = 32): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false },
    ],
    programId: Keypair.generate().publicKey,
    data: Buffer.alloc(dataSize),
  });
}

function mockSdkResult(ixCount = 1, dataSize = 32): SdkResult {
  return {
    instructions: Array.from({ length: ixCount }, () => mockInstruction(dataSize)),
    additionalSigners: [],
  };
}

// ─── Instruction Aggregator ──────────────────────────────────────────────────

describe('InstructionAggregator', () => {
  describe('createBatch', () => {
    it('creates empty batch', () => {
      const batch = createBatch();
      expect(batch.instructions).toHaveLength(0);
      expect(batch.additionalSigners).toHaveLength(0);
      expect(batch.labels).toHaveLength(0);
    });
  });

  describe('appendToBatch', () => {
    it('appends instructions and label', () => {
      const batch = createBatch();
      const result = mockSdkResult(3);
      appendToBatch(batch, result, 'open');

      expect(batch.instructions).toHaveLength(3);
      expect(batch.labels).toEqual(['open']);
    });

    it('merges multiple SDK results', () => {
      const batch = createBatch();
      appendToBatch(batch, mockSdkResult(2), 'open');
      appendToBatch(batch, mockSdkResult(1), 'tp');
      appendToBatch(batch, mockSdkResult(1), 'sl');

      expect(batch.instructions).toHaveLength(4);
      expect(batch.labels).toEqual(['open', 'tp', 'sl']);
    });

    it('deduplicates signers by pubkey', () => {
      const batch = createBatch();
      const sharedSigner = Keypair.generate();

      appendToBatch(batch, {
        instructions: [mockInstruction()],
        additionalSigners: [sharedSigner],
      }, 'open');

      appendToBatch(batch, {
        instructions: [mockInstruction()],
        additionalSigners: [sharedSigner], // same signer
      }, 'tp');

      expect(batch.additionalSigners).toHaveLength(1);
      expect(batch.additionalSigners[0].publicKey.toBase58()).toBe(
        sharedSigner.publicKey.toBase58(),
      );
    });

    it('keeps unique signers', () => {
      const batch = createBatch();

      appendToBatch(batch, {
        instructions: [mockInstruction()],
        additionalSigners: [Keypair.generate()],
      }, 'open');

      appendToBatch(batch, {
        instructions: [mockInstruction()],
        additionalSigners: [Keypair.generate()],
      }, 'tp');

      expect(batch.additionalSigners).toHaveLength(2);
    });
  });

  describe('estimateBatchSize', () => {
    it('returns 0 for empty batch', () => {
      const batch = createBatch();
      expect(estimateBatchSize(batch, Keypair.generate().publicKey)).toBe(0);
    });

    it('returns positive size for non-empty batch', () => {
      const batch = createBatch();
      appendToBatch(batch, mockSdkResult(2), 'open');
      const size = estimateBatchSize(batch, Keypair.generate().publicKey);
      expect(size).toBeGreaterThan(0);
      // Mock instructions use random unique keys, so size can exceed 1232
      // In production, ALTs compress shared accounts. Just verify it's computed.
      expect(size).toBeGreaterThan(100);
    });
  });

  describe('isBatchWithinLimit', () => {
    it('small batch fits within limit', () => {
      const batch = createBatch();
      const payer = Keypair.generate().publicKey;
      const ix = new TransactionInstruction({
        keys: [{ pubkey: payer, isSigner: true, isWritable: true }],
        programId: Keypair.generate().publicKey,
        data: Buffer.alloc(8),
      });
      appendToBatch(batch, { instructions: [ix], additionalSigners: [] }, 'open');
      expect(isBatchWithinLimit(batch, payer)).toBe(true);
    });

    it('huge batch exceeds limit', () => {
      const batch = createBatch();
      // Add many large instructions to exceed limit
      for (let i = 0; i < 20; i++) {
        appendToBatch(batch, mockSdkResult(3, 128), `ix-${i}`);
      }
      expect(isBatchWithinLimit(batch, Keypair.generate().publicKey)).toBe(false);
    });
  });

  describe('batchSummary', () => {
    it('returns human-readable summary', () => {
      const batch = createBatch();
      appendToBatch(batch, mockSdkResult(2), 'open');
      appendToBatch(batch, mockSdkResult(1), 'tp');
      appendToBatch(batch, mockSdkResult(1), 'sl');

      const summary = batchSummary(batch);
      expect(summary).toBe('4 instructions [open + tp + sl]');
    });

    it('handles single label', () => {
      const batch = createBatch();
      appendToBatch(batch, mockSdkResult(1), 'open');
      expect(batchSummary(batch)).toBe('1 instructions [open]');
    });
  });
});

// ─── ALT Resolver ────────────────────────────────────────────────────────────

describe('ALT Resolver', () => {
  beforeEach(async () => {
    const { clearALTCache } = await import('../src/transaction/alt-resolver.js');
    clearALTCache();
  });

  it('returns empty array on error (graceful degradation)', async () => {
    const { resolveALTs } = await import('../src/transaction/alt-resolver.js');

    const mockClient = {
      getOrLoadAddressLookupTable: vi.fn().mockRejectedValue(new Error('network error')),
    };

    const result = await resolveALTs(mockClient, { poolName: 'test' } as any);
    expect(result).toEqual([]);
  });

  it('returns ALTs from SDK', async () => {
    const { resolveALTs } = await import('../src/transaction/alt-resolver.js');

    const mockALT = { key: Keypair.generate().publicKey, state: { addresses: [] } };
    const mockClient = {
      getOrLoadAddressLookupTable: vi.fn().mockResolvedValue({
        addressLookupTables: [mockALT],
      }),
    };

    const result = await resolveALTs(mockClient, { poolName: 'Crypto.1' } as any);
    expect(result).toHaveLength(1);
  });

  it('caches ALTs within TTL', async () => {
    const { resolveALTs } = await import('../src/transaction/alt-resolver.js');

    const mockALT = { key: Keypair.generate().publicKey, state: { addresses: [] } };
    const mockClient = {
      getOrLoadAddressLookupTable: vi.fn().mockResolvedValue({
        addressLookupTables: [mockALT],
      }),
    };

    const poolConfig = { poolName: 'Crypto.1' } as any;

    await resolveALTs(mockClient, poolConfig);
    await resolveALTs(mockClient, poolConfig);

    // Should only call SDK once due to caching
    expect(mockClient.getOrLoadAddressLookupTable).toHaveBeenCalledTimes(1);
  });
});

// ─── ATA Resolver ────────────────────────────────────────────────────────────

describe('ATA Resolver', () => {
  it('getATAAddress returns deterministic address', async () => {
    const { getATAAddress } = await import('../src/transaction/ata-resolver.js');

    const owner = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;

    const addr1 = getATAAddress(owner, mint);
    const addr2 = getATAAddress(owner, mint);

    expect(addr1.toBase58()).toBe(addr2.toBase58());
  });

  it('different mints produce different ATAs', async () => {
    const { getATAAddress } = await import('../src/transaction/ata-resolver.js');

    const owner = Keypair.generate().publicKey;
    const mint1 = Keypair.generate().publicKey;
    const mint2 = Keypair.generate().publicKey;

    const addr1 = getATAAddress(owner, mint1);
    const addr2 = getATAAddress(owner, mint2);

    expect(addr1.toBase58()).not.toBe(addr2.toBase58());
  });
});

// ─── Atomic Transaction Flow ─────────────────────────────────────────────────

describe('Atomic transaction flow', () => {
  it('batch with open + tp + sl has correct labels', () => {
    const batch = createBatch();
    appendToBatch(batch, mockSdkResult(3), 'open');
    appendToBatch(batch, mockSdkResult(2), 'tp');
    appendToBatch(batch, mockSdkResult(2), 'sl');

    expect(batch.labels).toEqual(['open', 'tp', 'sl']);
    expect(batch.instructions).toHaveLength(7);
  });

  it('batch preserves instruction order', () => {
    const batch = createBatch();

    const openIx = mockInstruction(10);
    const tpIx = mockInstruction(20);
    const slIx = mockInstruction(30);

    appendToBatch(batch, { instructions: [openIx], additionalSigners: [] }, 'open');
    appendToBatch(batch, { instructions: [tpIx], additionalSigners: [] }, 'tp');
    appendToBatch(batch, { instructions: [slIx], additionalSigners: [] }, 'sl');

    expect(batch.instructions[0].data.length).toBe(10);
    expect(batch.instructions[1].data.length).toBe(20);
    expect(batch.instructions[2].data.length).toBe(30);
  });

  it('empty batch is within limit', () => {
    const batch = createBatch();
    expect(isBatchWithinLimit(batch, Keypair.generate().publicKey)).toBe(true);
  });

  it('typical open + tp + sl batch fits with shared accounts', () => {
    const batch = createBatch();
    // In production, open/tp/sl share many accounts (pool, custody, position PDAs).
    // Simulate with shared keys to represent real-world account overlap.
    const payer = Keypair.generate().publicKey;
    const sharedPool = Keypair.generate().publicKey;
    const sharedCustody = Keypair.generate().publicKey;
    const program = Keypair.generate().publicKey;

    const sharedKeys = [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: sharedPool, isSigner: false, isWritable: true },
      { pubkey: sharedCustody, isSigner: false, isWritable: false },
    ];

    for (const label of ['open', 'tp', 'sl']) {
      const ix = new TransactionInstruction({
        keys: [...sharedKeys, { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
        programId: program,
        data: Buffer.alloc(48),
      });
      appendToBatch(batch, { instructions: [ix], additionalSigners: [] }, label);
    }

    expect(isBatchWithinLimit(batch, payer)).toBe(true);
  });
});
