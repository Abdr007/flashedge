/**
 * Tests for WalletStore — read-only wallet registry.
 * Verifies that no private key material is stored by the CLI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { Keypair } from '@solana/web3.js';

// We test the WalletStore class directly
import { WalletStore } from '../src/wallet/wallet-store.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), `flash-wallet-test-${process.pid}`);
const TEST_FLASH_DIR = join(TEST_DIR, '.flash');
const TEST_WALLETS_JSON = join(TEST_FLASH_DIR, 'wallets.json');

/** Create a valid Solana keypair JSON file at the given path. Returns the address. */
function createTestKeypair(filePath: string): { address: string; secretKey: number[] } {
  const keypair = Keypair.generate();
  const secretKey = Array.from(keypair.secretKey);
  const dir = join(filePath, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(filePath, JSON.stringify(secretKey), { mode: 0o600 });
  return { address: keypair.publicKey.toBase58(), secretKey };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WalletStore', () => {
  // These tests use the real WalletStore which reads/writes to ~/.flash/
  // We test the public API behavior, not internal file paths

  const testKeypairDir = join(homedir(), '.flash-test-keypairs');
  let testFiles: string[] = [];

  beforeEach(() => {
    if (!existsSync(testKeypairDir)) {
      mkdirSync(testKeypairDir, { recursive: true, mode: 0o700 });
    }
  });

  afterEach(() => {
    // Clean up test keypair files
    for (const f of testFiles) {
      try { rmSync(f); } catch { /* ignore */ }
    }
    testFiles = [];
    try { rmSync(testKeypairDir, { recursive: true }); } catch { /* ignore */ }
  });

  function createKeypairInTestDir(name: string): { path: string; address: string } {
    const filePath = join(testKeypairDir, `${name}.json`);
    const { address } = createTestKeypair(filePath);
    testFiles.push(filePath);
    return { path: filePath, address };
  }

  it('registerWallet stores only metadata, not keys', () => {
    const store = new WalletStore();
    const { path } = createKeypairInTestDir('test-meta-only');
    const testName = `test-meta-${Date.now()}`;

    try {
      const result = store.registerWallet(testName, path);
      expect(result.address).toBeTruthy();
      expect(result.path).toBe(path);

      // Verify the registry file does not contain the secret key
      const registryPath = join(homedir(), '.flash', 'wallets.json');
      const registryContent = readFileSync(registryPath, 'utf-8');

      // Registry should contain the name and path
      expect(registryContent).toContain(testName);
      expect(registryContent).toContain(path);

      // Registry should NOT contain a 64-element array (the secret key)
      const parsed = JSON.parse(registryContent);
      for (const wallet of parsed.wallets) {
        // No wallet entry should have a secretKey or key array field
        expect(wallet).not.toHaveProperty('secretKey');
        expect(wallet).not.toHaveProperty('key');
        // Entries should only have name, path, address
        const keys = Object.keys(wallet);
        expect(keys.sort()).toEqual(['address', 'name', 'path']);
      }

      // No file should be created at ~/.flash/wallets/<name>.json
      const legacyPath = join(homedir(), '.flash', 'wallets', `${testName}.json`);
      expect(existsSync(legacyPath)).toBe(false);
    } finally {
      // Clean up
      try { store.removeWallet(testName); } catch { /* ignore */ }
    }
  });

  it('getWalletPath returns original file path', () => {
    const store = new WalletStore();
    const { path } = createKeypairInTestDir('test-path-return');
    const testName = `test-path-${Date.now()}`;

    try {
      store.registerWallet(testName, path);
      const retrievedPath = store.getWalletPath(testName);
      expect(retrievedPath).toBe(path);
    } finally {
      try { store.removeWallet(testName); } catch { /* ignore */ }
    }
  });

  it('getAddress returns cached address without file read', () => {
    const store = new WalletStore();
    const { path, address } = createKeypairInTestDir('test-cached-addr');
    const testName = `test-addr-${Date.now()}`;

    try {
      store.registerWallet(testName, path);
      const result = store.getAddress(testName);
      expect(result).toBe(address);
    } finally {
      try { store.removeWallet(testName); } catch { /* ignore */ }
    }
  });

  it('removeWallet removes registry entry but not the original file', () => {
    const store = new WalletStore();
    const { path } = createKeypairInTestDir('test-remove');
    const testName = `test-remove-${Date.now()}`;

    store.registerWallet(testName, path);
    store.removeWallet(testName);

    // Registry entry should be gone
    expect(store.hasWallet(testName)).toBe(false);

    // Original keypair file should still exist
    expect(existsSync(path)).toBe(true);
  });

  it('rejects duplicate wallet names', () => {
    const store = new WalletStore();
    const { path } = createKeypairInTestDir('test-dup');
    const testName = `test-dup-${Date.now()}`;

    try {
      store.registerWallet(testName, path);
      expect(() => store.registerWallet(testName, path)).toThrow(/already exists/);
    } finally {
      try { store.removeWallet(testName); } catch { /* ignore */ }
    }
  });

  it('rejects files with insecure permissions', () => {
    const store = new WalletStore();
    const filePath = join(testKeypairDir, 'insecure.json');
    createTestKeypair(filePath);
    testFiles.push(filePath);

    // Make the file world-readable
    chmodSync(filePath, 0o644);

    const testName = `test-perms-${Date.now()}`;
    expect(() => store.registerWallet(testName, filePath)).toThrow(/insecure permissions/);
  });

  it('rejects files larger than 1KB', () => {
    const store = new WalletStore();
    const filePath = join(testKeypairDir, 'large.json');
    testFiles.push(filePath);

    // Write a file larger than 1KB
    writeFileSync(filePath, 'x'.repeat(2000), { mode: 0o600 });

    const testName = `test-large-${Date.now()}`;
    expect(() => store.registerWallet(testName, filePath)).toThrow(/too large/);
  });

  it('listWallets returns registered names', () => {
    const store = new WalletStore();
    const { path } = createKeypairInTestDir('test-list');
    const testName = `test-list-${Date.now()}`;

    try {
      store.registerWallet(testName, path);
      const wallets = store.listWallets();
      expect(wallets).toContain(testName);
    } finally {
      try { store.removeWallet(testName); } catch { /* ignore */ }
    }
  });

  it('setDefault and getDefault work with registry', () => {
    const store = new WalletStore();
    const { path } = createKeypairInTestDir('test-default');
    const testName = `test-default-${Date.now()}`;

    try {
      store.registerWallet(testName, path);
      store.setDefault(testName);
      expect(store.getDefault()).toBe(testName);

      store.clearDefault();
      expect(store.getDefault()).toBeNull();
    } finally {
      try { store.removeWallet(testName); } catch { /* ignore */ }
    }
  });

  it('wallet metadata persists across WalletStore instances', () => {
    const { path } = createKeypairInTestDir('test-persist');
    const testName = `test-persist-${Date.now()}`;

    try {
      // Register with one instance
      const store1 = new WalletStore();
      const result = store1.registerWallet(testName, path);

      // Read with a new instance
      const store2 = new WalletStore();
      expect(store2.hasWallet(testName)).toBe(true);
      expect(store2.getAddress(testName)).toBe(result.address);
      expect(store2.getWalletPath(testName)).toBe(path);
    } finally {
      try { new WalletStore().removeWallet(testName); } catch { /* ignore */ }
    }
  });
});
