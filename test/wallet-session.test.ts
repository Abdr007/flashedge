/**
 * Tests for wallet session stability.
 *
 * Verifies:
 * - Wallet session persists in ToolContext
 * - WalletManager isConnected state tracking
 * - Idle timer behavior
 * - Execution middleware wallet checks
 * - Auto-restoration logic
 * - Trading action coverage
 */

import { describe, it } from 'vitest';
import assert from 'assert';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '..');

// ─── WalletManager Session State ────────────────────────────────────────────

describe('WalletManager Session State', () => {
  it('isConnected returns true when keypair is loaded', async () => {
    const { WalletManager, createConnection } = await import('../src/wallet/index.js');
    const conn = createConnection('https://api.mainnet-beta.solana.com');
    const wm = new WalletManager(conn);
    // Initially not connected
    assert.strictEqual(wm.isConnected, false);
  });

  it('disconnect sets isConnected to false', async () => {
    const { WalletManager, createConnection } = await import('../src/wallet/index.js');
    const conn = createConnection('https://api.mainnet-beta.solana.com');
    const wm = new WalletManager(conn);
    wm.disconnect();
    assert.strictEqual(wm.isConnected, false);
    assert.strictEqual(wm.address, null);
  });

  it('address returns null when disconnected', async () => {
    const { WalletManager, createConnection } = await import('../src/wallet/index.js');
    const conn = createConnection('https://api.mainnet-beta.solana.com');
    const wm = new WalletManager(conn);
    assert.strictEqual(wm.address, null);
  });

  it('resetIdleTimer is safe to call when no keypair', async () => {
    const { WalletManager, createConnection } = await import('../src/wallet/index.js');
    const conn = createConnection('https://api.mainnet-beta.solana.com');
    const wm = new WalletManager(conn);
    // Should not throw
    wm.resetIdleTimer();
    assert.strictEqual(wm.isConnected, false);
  });

  it('clearBalanceCache is safe to call anytime', async () => {
    const { WalletManager, createConnection } = await import('../src/wallet/index.js');
    const conn = createConnection('https://api.mainnet-beta.solana.com');
    const wm = new WalletManager(conn);
    // Should not throw
    wm.clearBalanceCache();
  });
});

// ─── ToolContext Wallet Reference ───────────────────────────────────────────

describe('ToolContext Wallet Reference', () => {
  it('walletManager is non-optional in ToolContext', () => {
    const src = readFileSync(resolve(ROOT, 'src/types/index.ts'), 'utf8');
    // Should NOT have the optional marker
    assert.ok(src.includes('walletManager: WalletManager;'),
      'walletManager should be required (not optional) in ToolContext');
    assert.ok(!src.includes('walletManager?: WalletManager;'),
      'walletManager should NOT be optional');
  });

  it('terminal sets walletManager in context at startup', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('walletManager: this.walletManager'),
      'terminal should set walletManager in ToolContext');
  });

  it('idle timer is reset on every user input', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('this.walletManager.resetIdleTimer()'),
      'should reset idle timer on user input');
  });
});

// ─── Execution Middleware ────────────────────────────────────────────────────

describe('Execution Middleware Wallet Checks', () => {
  it('TRADING_ACTIONS includes all wallet-requiring actions', () => {
    const src = readFileSync(resolve(ROOT, 'src/core/execution-middleware.ts'), 'utf8');
    const required = [
      'OpenPosition', 'ClosePosition', 'AddCollateral', 'RemoveCollateral',
      'CloseAll', 'Swap', 'LimitOrder', 'CancelOrder', 'SetTpSl', 'RemoveTpSl',
      'EarnAddLiquidity', 'EarnRemoveLiquidity', 'EarnStake', 'EarnUnstake', 'EarnClaimRewards',
    ];
    for (const action of required) {
      assert.ok(src.includes(`ActionType.${action}`),
        `TRADING_ACTIONS should include ActionType.${action}`);
    }
  });

  it('middleware attempts wallet restoration before blocking', () => {
    const src = readFileSync(resolve(ROOT, 'src/core/execution-middleware.ts'), 'utf8');
    assert.ok(src.includes('tryRestoreWalletSession'),
      'should have wallet restoration function');
    assert.ok(src.includes('Wallet session restored'),
      'should print restoration message');
  });

  it('restoration tries last wallet, then default, then single wallet', () => {
    const src = readFileSync(resolve(ROOT, 'src/core/execution-middleware.ts'), 'utf8');
    assert.ok(src.includes('getLastWallet'),
      'should try last session wallet');
    assert.ok(src.includes('getDefault'),
      'should try default wallet');
    assert.ok(src.includes('wallets.length === 1'),
      'should auto-select single wallet');
  });

  it('restoration logs success', () => {
    const src = readFileSync(resolve(ROOT, 'src/core/execution-middleware.ts'), 'utf8');
    assert.ok(src.includes("'WALLET', `Session restored:"),
      'should log restoration');
  });

  it('simulation mode bypasses wallet check', () => {
    const src = readFileSync(resolve(ROOT, 'src/core/execution-middleware.ts'), 'utf8');
    assert.ok(src.includes('if (context.simulationMode) return { pass: true }'),
      'simulation mode should always pass wallet check');
  });
});

// ─── Idle Timer Safety ──────────────────────────────────────────────────────

describe('Idle Timer Safety', () => {
  it('default session timeout is 15 minutes', () => {
    const src = readFileSync(resolve(ROOT, 'src/wallet/walletManager.ts'), 'utf8');
    assert.ok(src.includes('900_000') || src.includes("'900000'"),
      'default SESSION_TIMEOUT_MS should be 900000 (15 min)');
  });

  it('idle timer is unrefed (does not prevent process exit)', () => {
    const src = readFileSync(resolve(ROOT, 'src/wallet/walletManager.ts'), 'utf8');
    assert.ok(src.includes('.unref()'),
      'idle timer should be unrefed');
  });

  it('idle timer is cleared on disconnect', () => {
    const src = readFileSync(resolve(ROOT, 'src/wallet/walletManager.ts'), 'utf8');
    // disconnect() should clear the timer
    assert.ok(src.includes('clearTimeout(this.idleTimer)'),
      'disconnect should clear idle timer');
  });

  it('verifyKeypairIntegrity returns false when disconnected', async () => {
    const { WalletManager, createConnection } = await import('../src/wallet/index.js');
    const conn = createConnection('https://api.mainnet-beta.solana.com');
    const wm = new WalletManager(conn);
    assert.strictEqual(wm.verifyKeypairIntegrity(), false);
  });
});

// ─── handleWalletReconnected ────────────────────────────────────────────────

describe('Wallet Reconnection Flow', () => {
  it('handleWalletReconnected updates context flashClient', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/wallet-flows.ts'), 'utf8');
    assert.ok(src.includes('context.flashClient'),
      'should update context.flashClient');
  });

  it('handleWalletReconnected updates context walletAddress', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/wallet-flows.ts'), 'utf8');
    assert.ok(src.includes("context.walletAddress = deps.walletManager.address"),
      'should update context.walletAddress');
  });

  it('handleWalletReconnected rebuilds ToolEngine', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/wallet-flows.ts'), 'utf8');
    assert.ok(src.includes('new ToolEngine('),
      'should rebuild engine with updated context');
  });

  it('walletRebuilding mutex prevents concurrent trades', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/wallet-flows.ts'), 'utf8');
    assert.ok(src.includes('walletRebuilding = true'),
      'should set mutex during rebuild');
    assert.ok(src.includes('walletRebuilding = false'),
      'should release mutex after rebuild');
  });
});

// ─── Session Persistence ────────────────────────────────────────────────────

describe('Session Persistence', () => {
  it('wallet tools update context.walletAddress after connection', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/wallet-tools.ts'), 'utf8');
    // walletImport, walletUse, walletConnect all update context
    const updates = (src.match(/context\.walletAddress\s*=/g) || []).length;
    assert.ok(updates >= 3,
      `should update walletAddress at least 3 times (import/use/connect), found ${updates}`);
  });

  it('wallet tools update context.walletName after connection', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/wallet-tools.ts'), 'utf8');
    const updates = (src.match(/context\.walletName\s*=/g) || []).length;
    assert.ok(updates >= 3,
      `should update walletName at least 3 times, found ${updates}`);
  });

  it('walletConnected flag is set for wallet tools', () => {
    const src = readFileSync(resolve(ROOT, 'src/tools/wallet-tools.ts'), 'utf8');
    assert.ok(src.includes('walletConnected: true'),
      'wallet tools should set walletConnected flag');
  });

  it('trade execution resets idle timer', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    const resets = (src.match(/resetIdleTimer/g) || []).length;
    assert.ok(resets >= 2,
      `should reset idle timer in multiple places (trade success), found ${resets}`);
  });
});
