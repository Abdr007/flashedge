/**
 * Wallet UI flows extracted from terminal.ts for modularization.
 * Each function corresponds to a former private method on FlashTerminal.
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import chalk from 'chalk';
import { ToolContext, FlashConfig, IFlashClient } from '../types/index.js';
import { WalletManager } from '../wallet/walletManager.js';
import { WalletStore } from '../wallet/wallet-store.js';
import { getLastWallet, updateLastWallet } from '../wallet/session.js';
import { shortAddress } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import { IS_AGENT, agentError } from '../no-dna.js';
import { ToolEngine } from '../tools/engine.js';
import { RpcManager } from '../network/rpc-manager.js';
import { getReconciler } from '../core/state-reconciliation.js';

/**
 * Dependencies that wallet flow functions need from the terminal.
 * Passed in by thin wrapper methods on the class.
 */
export interface WalletFlowDeps {
  ask: (question: string) => Promise<string>;
  readHidden: (prompt: string) => Promise<string>;
  confirm: (prompt: string) => Promise<boolean>;
  walletManager: WalletManager;
  config: FlashConfig;
  flashClient: IFlashClient;
  context: ToolContext;
  rpcManager: RpcManager;
  engine: ToolEngine;
  noPlugins: boolean;
}

/**
 * Mutable state that some wallet flows need to read/write on the terminal.
 * Passed by reference so mutations are visible to the caller.
 */
export interface WalletFlowState {
  flashClient: IFlashClient;
  context: ToolContext;
  engine: ToolEngine;
  walletRebuilding: boolean;
}

// ─── tryConnectWallet ─────────────────────────────────────────────

/** Try to connect a wallet from a file path. Returns info on success, null on failure. */
export function tryConnectWallet(walletManager: WalletManager, path: string): { address: string } | null {
  try {
    const result = walletManager.loadFromFile(path);
    return { address: result.address };
  } catch (error: unknown) {
    console.log(chalk.red(`  Failed to load wallet: ${getErrorMessage(error)}`));
    return null;
  }
}

// ─── setupLiveMode ────────────────────────────────────────────────

/**
 * Set up live mode: ensure a wallet is connected.
 * Auto-connects if a default or single wallet exists.
 * Returns wallet info on success, null if user chose exit.
 */
export async function setupLiveMode(deps: WalletFlowDeps): Promise<{ address: string; name: string } | null> {
  const store = new WalletStore();
  const wallets = store.listWallets();
  let defaultWallet = store.getDefault();
  const sessionWallet = getLastWallet();

  // NO_DNA: never prompt — auto-connect default/only wallet or fail
  if (IS_AGENT) {
    if (!defaultWallet && wallets.length === 1) {
      store.setDefault(wallets[0]);
      defaultWallet = wallets[0];
    }
    const target = defaultWallet ?? sessionWallet;
    if (!target || !wallets.includes(target)) {
      agentError('no_wallet', {
        detail: 'Live mode requires a configured wallet. Set a default wallet first.',
        available_wallets: wallets,
      });
      return null;
    }
    try {
      const walletPath = store.getWalletPath(target);
      const info = tryConnectWallet(deps.walletManager, walletPath);
      if (info && deps.walletManager.isConnected) {
        updateLastWallet(target);
        return { ...info, name: target };
      }
    } catch {
      agentError('wallet_connect_failed', { wallet: target });
    }
    return null;
  }

  // No wallets saved — first-time setup
  if (wallets.length === 0) {
    return showFirstTimeWalletSetup(deps, store);
  }

  // Auto-set default if there's exactly one wallet saved
  if (!defaultWallet && wallets.length === 1) {
    store.setDefault(wallets[0]);
    defaultWallet = wallets[0];
  }

  // Check session for previous wallet
  const targetWallet = defaultWallet ?? sessionWallet;

  // Wallets exist — show saved wallets menu
  if (targetWallet && wallets.includes(targetWallet)) {
    return showSavedWalletsMenu(deps, store, wallets, targetWallet);
  }

  // Wallets exist but no target — go straight to picker
  return showWalletPicker(deps, store, wallets);
}

// ─── showSavedWalletsMenu ─────────────────────────────────────────

/**
 * Show the saved wallets menu when wallets already exist.
 * Options: use previous, select another, import new, create new.
 */
export async function showSavedWalletsMenu(
  deps: WalletFlowDeps,
  store: WalletStore,
  wallets: string[],
  targetWallet: string,
): Promise<{ address: string; name: string } | null> {
  console.log('');
  console.log(chalk.bold('  Saved Wallets'));
  console.log(chalk.dim('  ────────────'));
  console.log('');
  console.log(`    ${chalk.cyan('1)')} Use previous wallet ${chalk.dim(`(${targetWallet})`)}`);
  console.log(`    ${chalk.cyan('2)')} Select another saved wallet`);
  console.log(`    ${chalk.cyan('3)')} Import new wallet`);
  console.log(`    ${chalk.cyan('4)')} Create new wallet`);
  console.log('');

  while (true) {
    const choice = (await deps.ask(`  ${chalk.yellow('>')} `)).trim();

    switch (choice) {
      case '1': {
        // Reconnect previous wallet
        try {
          const walletPath = store.getWalletPath(targetWallet);
          const info = tryConnectWallet(deps.walletManager, walletPath);
          if (info && deps.walletManager.isConnected) {
            console.log(chalk.green(`\n  Wallet connected: ${targetWallet}`));
            updateLastWallet(targetWallet);
            return { ...info, name: targetWallet };
          }
        } catch {
          console.log(chalk.dim(`  Wallet "${targetWallet}" could not be loaded.`));
        }
        // Fall through to picker on failure
        return showWalletPicker(deps, store, wallets);
      }

      case '2': {
        // Show wallet picker (excludes the target wallet from being auto-selected)
        return showWalletPicker(deps, store, wallets);
      }

      case '3': {
        // Import new wallet
        const importedName = await handleWalletImportFlow(deps, store);
        if (importedName) return { address: deps.walletManager.address!, name: importedName };
        continue;
      }

      case '4': {
        // Create new wallet
        const created = await handleWalletCreateFlow(deps, store);
        if (created) return created;
        continue;
      }

      default:
        console.log(chalk.dim('  Enter 1, 2, 3, or 4.'));
        continue;
    }
  }
}

// ─── showWalletPicker ─────────────────────────────────────────────

/** Pick from multiple saved wallets by number. */
export async function showWalletPicker(
  deps: WalletFlowDeps,
  store: WalletStore,
  wallets: string[],
): Promise<{ address: string; name: string } | null> {
  console.log('');
  console.log(chalk.bold('  Select wallet:'));
  console.log('');
  for (let i = 0; i < wallets.length; i++) {
    try {
      const addr = store.getAddress(wallets[i]);
      console.log(`    ${chalk.cyan(String(i + 1) + ')')} ${wallets[i]} ${chalk.dim(`(${shortAddress(addr)})`)}`);
    } catch {
      console.log(`    ${chalk.cyan(String(i + 1) + ')')} ${wallets[i]}`);
    }
  }
  console.log('');
  console.log(`    ${chalk.cyan('i)')} Import new wallet`);
  console.log(`    ${chalk.cyan('c)')} Create new wallet`);
  console.log(`    ${chalk.dim('q)')} Exit`);
  console.log('');

  while (true) {
    const choice = (await deps.ask(`  ${chalk.yellow('>')} `)).trim().toLowerCase();

    if (choice === 'q') return null;

    if (choice === 'i') {
      const importedName = await handleWalletImportFlow(deps, store);
      if (importedName) return { address: deps.walletManager.address!, name: importedName };
      continue;
    }

    if (choice === 'c') {
      const created = await handleWalletCreateFlow(deps, store);
      if (created) return created;
      continue;
    }

    const idx = parseInt(choice, 10) - 1;
    if (idx >= 0 && idx < wallets.length) {
      try {
        const walletPath = store.getWalletPath(wallets[idx]);
        const info = tryConnectWallet(deps.walletManager, walletPath);
        if (info) {
          store.setDefault(wallets[idx]);
          updateLastWallet(wallets[idx]);
          console.log(chalk.green(`\n  Wallet connected: ${wallets[idx]}`));
          return { ...info, name: wallets[idx] };
        }
      } catch (error: unknown) {
        console.log(chalk.red(`  ${getErrorMessage(error)}`));
      }
    } else {
      console.log(chalk.dim(`  Enter 1-${wallets.length}, i, c, or q.`));
    }
  }
}

// ─── showFirstTimeWalletSetup ─────────────────────────────────────

/** First-time wallet setup — no saved wallets. */
export async function showFirstTimeWalletSetup(
  deps: WalletFlowDeps,
  store: WalletStore,
): Promise<{ address: string; name: string } | null> {
  console.log('');
  console.log(chalk.bold('  Wallet Setup'));
  console.log(chalk.dim('  ────────────'));
  console.log('');
  console.log(chalk.dim('  A wallet is required for live trading.'));
  console.log('');
  console.log(`    ${chalk.cyan('1)')} Create new wallet`);
  console.log(`    ${chalk.cyan('2)')} Import wallet file`);
  console.log(`    ${chalk.cyan('3)')} Connect existing Solana keypair`);
  console.log('');

  while (true) {
    const choice = (await deps.ask(`  ${chalk.yellow('>')} `)).trim();

    switch (choice) {
      case '1': {
        const created = await handleWalletCreateFlow(deps, store);
        if (created) return created;
        continue;
      }

      case '2': {
        const importedName = await handleWalletImportFlow(deps, store);
        if (importedName) return { address: deps.walletManager.address!, name: importedName };
        continue;
      }

      case '3': {
        const connected = await handleWalletConnectFlow(deps);
        if (connected) return { address: deps.walletManager.address!, name: 'wallet' };
        continue;
      }

      default:
        console.log(chalk.dim('  Enter 1, 2, or 3.'));
        continue;
    }
  }
}

// ─── handleWalletCreateFlow ───────────────────────────────────────

/**
 * Create a new Solana wallet, save it, and connect.
 */
export async function handleWalletCreateFlow(
  deps: WalletFlowDeps,
  store: WalletStore,
): Promise<{ address: string; name: string } | null> {
  console.log('');

  const name = (await deps.ask(`  ${chalk.yellow('Wallet name:')} `)).trim();
  if (!name) {
    console.log(chalk.red('  Wallet name cannot be empty.'));
    return null;
  }

  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    console.log(chalk.red('  Name must be 1-64 alphanumeric/hyphen/underscore characters.'));
    return null;
  }

  const defaultPath = join(homedir(), '.config', 'solana', `${name}.json`);
  console.log('');
  console.log(chalk.dim(`  Where should the keypair be saved?`));
  console.log(chalk.dim(`  Default: ${defaultPath}`));
  const rawSavePath = (await deps.ask(`  ${chalk.yellow('Save path:')} `)).trim();
  const savePath = rawSavePath || defaultPath;

  const expandedPath = savePath.startsWith('~') ? join(homedir(), savePath.slice(1)) : resolve(savePath);

  try {
    const { Keypair } = await import('@solana/web3.js');
    const { writeFileSync, mkdirSync } = await import('fs');
    const { dirname } = await import('path');

    // Ensure parent directory exists
    const dir = dirname(expandedPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    if (existsSync(expandedPath)) {
      console.log(chalk.red(`  File already exists: ${expandedPath}`));
      return null;
    }

    const keypair = Keypair.generate();
    const secretKeyArray = Array.from(keypair.secretKey);
    const address = keypair.publicKey.toBase58();

    // Write keypair to the user-chosen location
    writeFileSync(expandedPath, JSON.stringify(secretKeyArray), { mode: 0o600 });

    // Zero sensitive data from memory
    secretKeyArray.fill(0);

    // Register the wallet path (no key material stored by Flash)
    const result = store.registerWallet(name, expandedPath);
    store.setDefault(name);

    // Connect the wallet
    deps.walletManager.loadFromFile(result.path);
    updateLastWallet(name);

    console.log('');
    console.log(chalk.green(`  Wallet "${name}" created successfully`));
    console.log('');
    console.log(`  ${chalk.bold('Name:')}    ${name}`);
    console.log(`  ${chalk.bold('Address:')} ${chalk.cyan(address)}`);
    console.log(`  ${chalk.bold('Saved to:')} ${chalk.dim(expandedPath)}`);
    console.log('');
    console.log(chalk.yellow.bold('  Security'));
    console.log(chalk.dim('    Back up this file securely'));
    console.log(chalk.dim('    Loss of this file means permanent loss of funds'));
    console.log(chalk.dim('    Flash Terminal does not store a copy of this key'));
    console.log('');
    console.log(chalk.dim('  Fund this wallet with SOL (for fees) and USDC (for collateral).'));
    console.log('');

    return { address, name };
  } catch (error: unknown) {
    console.log(chalk.red(`  Create failed: ${getErrorMessage(error)}`));
    return null;
  }
}

// ─── handleWalletImportFlow ───────────────────────────────────────

/**
 * Interactive wallet import: prompts for name and wallet file path.
 * Registers the path in ~/.flash/wallets.json — never copies the private key.
 */
export async function handleWalletImportFlow(deps: WalletFlowDeps, store: WalletStore): Promise<string | null> {
  console.log('');

  const name = (await deps.ask(`  ${chalk.yellow('Wallet name:')} `)).trim();
  if (!name) {
    console.log(chalk.red('  Wallet name cannot be empty.'));
    return null;
  }

  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    console.log(chalk.red('  Name must be 1-64 alphanumeric/hyphen/underscore characters.'));
    return null;
  }

  console.log('');
  console.log(chalk.dim('  Enter path to your Solana wallet JSON file'));
  console.log(chalk.dim('  Example: ~/.config/solana/id.json'));
  const rawPath = (await deps.ask(`  ${chalk.yellow('Path:')} `)).trim();

  if (!rawPath) {
    console.log(chalk.red('  No path provided.'));
    return null;
  }

  try {
    const result = store.registerWallet(name, rawPath);
    store.setDefault(name);

    // Connect the wallet directly from the original file
    deps.walletManager.loadFromFile(result.path);

    console.log('');
    console.log(chalk.green(`  Wallet "${name}" imported successfully`));
    console.log('');
    console.log(`  ${chalk.bold('Name:')}    ${name}`);
    console.log(`  ${chalk.bold('Path:')}    ${chalk.dim(result.path)}`);
    console.log(`  ${chalk.bold('Address:')} ${chalk.cyan(result.address)}`);
    console.log('');
    console.log(chalk.dim('  No key material stored by Flash Terminal.'));
    console.log(chalk.dim('  Your private key remains only in its original file.'));
    console.log('');

    return name;
  } catch (error: unknown) {
    console.log(chalk.red(`  Import failed: ${getErrorMessage(error)}`));
    return null;
  }
}

// ─── handleWalletConnectFlow ──────────────────────────────────────

/**
 * Interactive wallet connect: prompts for keypair file path,
 * validates, and connects.
 */
export async function handleWalletConnectFlow(deps: WalletFlowDeps): Promise<boolean> {
  console.log('');

  console.log(chalk.dim('  Enter path to your Solana wallet JSON file'));
  console.log(chalk.dim('  Example: ~/.config/solana/id.json'));
  const rawPath = (await deps.ask(`  ${chalk.yellow('Path:')} `)).trim();
  if (!rawPath) {
    console.log(chalk.red('  No path provided.'));
    return false;
  }

  // Expand ~ to home directory
  const expandedPath = rawPath.startsWith('~') ? join(homedir(), rawPath.slice(1)) : resolve(rawPath);

  if (!existsSync(expandedPath)) {
    console.log(chalk.red(`  File not found: ${expandedPath}`));
    return false;
  }

  const info = tryConnectWallet(deps.walletManager, expandedPath);
  if (!info) return false;

  console.log(chalk.green(`  Connected: ${info.address}`));

  // Show balance
  try {
    const bal = await deps.walletManager.getBalance();
    console.log(`  Balance: ${chalk.green(bal.toFixed(4))} SOL`);
  } catch {
    // Balance fetch is best-effort at setup
  }

  console.log('');
  return true;
}

// ─── handleWalletDisconnected ─────────────────────────────────────

/**
 * Handle wallet disconnect in live mode.
 * Mode stays locked — only disables trading capability.
 */
export function handleWalletDisconnected(): void {
  // Do NOT change mode — mode is locked for the session
  // Trading commands will fail naturally since wallet is disconnected
}

// ─── handleWalletReconnected ──────────────────────────────────────

/**
 * Handle wallet reconnected in live mode.
 * Reinitialize the live client with the new wallet.
 */
export async function handleWalletReconnected(deps: WalletFlowDeps, state: WalletFlowState): Promise<void> {
  // Only relevant in live mode — rebuild client with new wallet
  if (deps.config.simulationMode) return;

  // Mutex: prevent trade execution during wallet rebuild
  state.walletRebuilding = true;

  const connection = deps.rpcManager.connection;

  try {
    const { FlashClient } = await import('../client/flash-client.js');
    state.flashClient = new FlashClient(connection, deps.walletManager, deps.config);
    state.context.flashClient = state.flashClient;
    state.context.walletAddress = deps.walletManager.address ?? 'unknown';
    // walletName is preserved from initial setup
  } catch (error: unknown) {
    console.log(chalk.red(`  Failed to reinitialize live client: ${getErrorMessage(error)}`));
    console.log(chalk.dim('  Trading commands may fail until a wallet is reconnected.'));
    return;
  } finally {
    // Always release mutex even on failure
    state.walletRebuilding = false;
  }

  // Update reconciler with new client
  const reconciler = getReconciler();
  if (reconciler) {
    reconciler.setClient(state.flashClient);
    reconciler.reconcile().catch(() => {});
  }

  // Rebuild tool engine with updated context
  state.engine = new ToolEngine(state.context);

  // Re-register plugin tools lost during engine rebuild
  if (!deps.noPlugins) {
    try {
      const { loadPlugins } = await import('../plugins/plugin-loader.js');
      const pluginTools = await loadPlugins(state.context);
      for (const tool of pluginTools) {
        state.engine.registerTool(tool);
      }
    } catch {
      // Non-critical — plugins may not be available
    }
  }
}
