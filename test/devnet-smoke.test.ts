/**
 * Devnet Smoke Test — optional real-network validation.
 *
 * Only runs when DEVNET_TEST=true environment variable is set.
 * Skipped in CI and normal test runs.
 *
 * Tests basic RPC connectivity and wallet operations against devnet.
 * Does NOT execute trades or require real capital.
 */

import { describe, it, expect } from 'vitest';

const DEVNET_ENABLED = process.env.DEVNET_TEST === 'true';
const DEVNET_URL = 'https://api.devnet.solana.com';

describe.skipIf(!DEVNET_ENABLED)('Devnet Smoke Test', () => {

  it('can connect to devnet RPC', async () => {
    const { Connection } = await import('@solana/web3.js');
    const conn = new Connection(DEVNET_URL, 'confirmed');
    const slot = await conn.getSlot();
    expect(slot).toBeGreaterThan(0);
  });

  it('can fetch latest blockhash', async () => {
    const { Connection } = await import('@solana/web3.js');
    const conn = new Connection(DEVNET_URL, 'confirmed');
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    expect(blockhash).toBeTruthy();
    expect(lastValidBlockHeight).toBeGreaterThan(0);
  });

  it('can generate keypair and check balance', async () => {
    const { Connection, Keypair } = await import('@solana/web3.js');
    const conn = new Connection(DEVNET_URL, 'confirmed');
    const kp = Keypair.generate();
    const balance = await conn.getBalance(kp.publicKey);
    expect(balance).toBe(0); // New keypair has 0 balance
  });

  it('RPC responds within 5 seconds', async () => {
    const { Connection } = await import('@solana/web3.js');
    const conn = new Connection(DEVNET_URL, 'confirmed');
    const start = Date.now();
    await conn.getSlot();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });

  it('simulation client works with devnet prices', async () => {
    // This tests the SimulatedFlashClient in isolation — no real trades
    const { SimulatedFlashClient } = await import('../src/client/simulation.js');
    const client = new SimulatedFlashClient(10_000);
    expect(client.getBalance()).toBe(10_000);
    expect(client.walletAddress).toMatch(/^SIM_/);
  });
});
