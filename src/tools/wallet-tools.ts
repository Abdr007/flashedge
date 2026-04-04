import { z } from 'zod';
import { ToolDefinition, ToolResult } from '../types/index.js';
import { formatUsd } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import { updateLastWallet, clearLastWallet } from '../wallet/session.js';
import { WalletStore } from '../wallet/wallet-store.js';
import chalk from 'chalk';
import { theme } from '../cli/theme.js';

// ─── Wallet Tools ───────────────────────────────────────────────────────────

const walletStore = new WalletStore();

export const walletImport: ToolDefinition = {
  name: 'wallet_import',
  description: 'Register a wallet from a keypair JSON file path (no key material stored)',
  parameters: z.object({
    name: z.string(),
    path: z.string(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { name, path } = params as { name: string; path: string };

    if (!name || !path) {
      return {
        success: true,
        message: [
          theme.titleBlock('IMPORT WALLET'),
          '',
          `  ${chalk.cyan('wallet import <name> <path>')}`,
          chalk.dim('  wallet import main ~/.config/solana/id.json'),
          '',
          chalk.dim('  Only the file path is stored — your private key is never copied.'),
          '',
        ].join('\n'),
      };
    }

    try {
      const result = walletStore.registerWallet(name, path);

      // Auto-set as default
      walletStore.setDefault(name);

      // Auto-connect the wallet directly from the original file
      const wm = context.walletManager;
      if (wm) {
        wm.loadFromFile(result.path);
        context.walletAddress = result.address;
        context.walletName = name;
      }

      // Persist session
      updateLastWallet(name);

      const canSign = wm?.isConnected ?? false;
      const lines = [
        '',
        chalk.green('  Wallet Imported'),
        chalk.dim('  ─────────────────'),
        `  Name:    ${chalk.bold(name)}`,
        `  Path:    ${chalk.dim(result.path)}`,
        `  Address: ${chalk.cyan(result.address)}`,
        '',
        chalk.dim('  No key material stored by Flash Terminal.'),
        '',
      ];

      if (canSign) {
        lines.push(chalk.bgRed.white.bold('  LIVE TRADING ENABLED '));
        lines.push('');
        lines.push(chalk.dim('  Fund with SOL (for fees) and USDC (for collateral) before trading.'));
        lines.push('');
      }

      return {
        success: true,
        message: lines.join('\n'),
        data: canSign ? { walletConnected: true } : undefined,
      };
    } catch (error: unknown) {
      return { success: false, message: chalk.red(`  Failed to import wallet: ${getErrorMessage(error)}`) };
    }
  },
};

export const walletList: ToolDefinition = {
  name: 'wallet_list',
  description: 'List all stored wallets',
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    const wallets = walletStore.listWallets();
    const defaultName = walletStore.getDefault();

    if (wallets.length === 0) {
      return {
        success: true,
        message: [
          '',
          chalk.dim('  No wallets stored.'),
          chalk.dim('  Use "wallet import <name> <path>" to import a wallet.'),
          '',
        ].join('\n'),
      };
    }

    const lines = [theme.titleBlock('REGISTERED WALLETS')];

    for (const name of wallets) {
      const isDefault = name === defaultName;
      const tag = isDefault ? chalk.green(' (default)') : '';
      lines.push(`  ${chalk.bold(name)}${tag}`);
      try {
        const entry = walletStore.getWalletEntry(name);
        lines.push(chalk.dim(`    ${entry.path}`));
      } catch {
        /* skip */
      }
    }

    lines.push('');
    return { success: true, message: lines.join('\n') };
  },
};

export const walletUse: ToolDefinition = {
  name: 'wallet_use',
  description: 'Switch to a stored wallet and set it as default',
  parameters: z.object({
    name: z.string(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { name } = params as { name: string };
    try {
      const walletPath = walletStore.getWalletPath(name);
      walletStore.setDefault(name);
      updateLastWallet(name);

      // Connect the wallet
      const wm = context.walletManager;
      if (wm) {
        const result = wm.loadFromFile(walletPath);
        context.walletAddress = result.address;
        context.walletName = name;

        const lines = [
          '',
          chalk.green(`  Switched to wallet: ${chalk.bold(name)}`),
          `  Address: ${chalk.dim(result.address)}`,
          '',
        ];

        // Signal live mode switch if wallet can sign
        if (wm.isConnected) {
          lines.push(chalk.bgRed.white.bold('  LIVE TRADING ENABLED '));
          lines.push(chalk.dim('  Transactions executed from this wallet are real.'));
          lines.push('');
        }

        return {
          success: true,
          message: lines.join('\n'),
          data: wm.isConnected ? { walletConnected: true } : undefined,
        };
      }

      return { success: false, message: chalk.red('  Wallet manager not available') };
    } catch (error: unknown) {
      return { success: false, message: chalk.red(`  Failed to switch wallet: ${getErrorMessage(error)}`) };
    }
  },
};

export const walletRemove: ToolDefinition = {
  name: 'wallet_remove',
  description: 'Remove a registered wallet (does not delete the keypair file)',
  parameters: z.object({
    name: z.string(),
  }),
  execute: async (params): Promise<ToolResult> => {
    const { name } = params as { name: string };
    try {
      walletStore.removeWallet(name);
      return {
        success: true,
        message: [chalk.green(`  Wallet "${name}" removed.`), chalk.dim('  Your keypair file was not deleted.')].join(
          '\n',
        ),
      };
    } catch (error: unknown) {
      return { success: false, message: chalk.red(`  Failed to remove wallet: ${getErrorMessage(error)}`) };
    }
  },
};

export const walletStatus: ToolDefinition = {
  name: 'wallet_status',
  description: 'Show current wallet connection status',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const wm = context.walletManager;
    const defaultName = walletStore.getDefault();
    const storedCount = walletStore.listWallets().length;

    const lines = [theme.titleBlock('WALLET STATUS'), ''];

    if (wm && wm.isConnected) {
      lines.push(theme.pair('Connected', theme.positive('Yes')));
      if (defaultName) {
        lines.push(theme.pair('Wallet', chalk.bold(defaultName)));
      }
    } else if (wm && wm.hasAddress) {
      lines.push(theme.pair('Connected', theme.warning('Read-only')));
    } else {
      lines.push(theme.pair('Connected', theme.negative('No')));
    }

    lines.push(theme.pair('Registered', `${storedCount} wallet(s)`));
    lines.push('');

    if (!wm?.isConnected && storedCount === 0) {
      lines.push(chalk.dim('  Use "wallet import <name> <path>" to add a wallet.'));
      lines.push('');
    }

    return { success: true, message: lines.join('\n') };
  },
};

export const walletDisconnect: ToolDefinition = {
  name: 'wallet_disconnect',
  description: 'Disconnect the currently active wallet',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const wm = context.walletManager;
    if (!wm || (!wm.isConnected && !wm.hasAddress)) {
      return { success: true, message: chalk.dim('  No wallet connected.') };
    }

    // Clear wallet from runtime
    wm.disconnect();
    context.walletAddress = 'unknown';
    context.walletName = '';
    clearLastWallet();

    // Clear default so it won't auto-load next startup
    const config = walletStore.getDefault();
    if (config) {
      walletStore.clearDefault();
    }

    const isLive = !context.simulationMode;

    const lines = ['', chalk.green('  Wallet disconnected.')];

    if (isLive) {
      lines.push('');
      lines.push(chalk.yellow('  Live trading disabled until a wallet is connected.'));
      lines.push(chalk.dim('  Use "wallet import", "wallet use", or "wallet connect" to reconnect.'));
    }

    lines.push('');

    return {
      success: true,
      message: lines.join('\n'),
      data: { disconnected: true },
    };
  },
};

export const walletAddress: ToolDefinition = {
  name: 'wallet_address',
  description: 'Show connected wallet address',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const wm = context.walletManager;
    if (!wm || !wm.isConnected) {
      return {
        success: true,
        message: chalk.dim('  No wallet connected. Use "wallet import <name> <path>" or "wallet connect <path>".'),
      };
    }
    return {
      success: true,
      message: `  Wallet: ${chalk.cyan(wm.address)}`,
    };
  },
};

export const walletBalance: ToolDefinition = {
  name: 'wallet_balance',
  description: 'Fetch SOL and token balances for connected wallet',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const wm = context.walletManager;
    if (!wm || !wm.isConnected) {
      // In simulation mode, show sim balance instead of error
      if (context.simulationMode) {
        const balance = context.flashClient.getBalance();
        const lines = [
          theme.titleBlock('WALLET BALANCE (SIM)'),
          '',
          theme.pair('USDC', theme.positive(formatUsd(balance))),
          theme.dim('  Simulation wallet — no real tokens'),
          '',
        ];
        return { success: true, message: lines.join('\n') };
      }
      return {
        success: true,
        message: chalk.dim('  No wallet connected. Use "wallet import <name> <path>" or "wallet connect <path>".'),
      };
    }
    try {
      const { sol, tokens } = await wm.getTokenBalances();
      const lines = [
        theme.titleBlock('WALLET BALANCE'),
        '',
        theme.pair('SOL', theme.positive(sol.toFixed(4) + ' SOL')),
      ];
      for (const t of tokens) {
        const decimals = t.symbol === 'USDC' || t.symbol === 'USDT' ? 2 : t.amount >= 1000 ? 2 : 4;
        const label = t.symbol === 'UNKNOWN' ? `UNKNOWN (${t.mint.slice(0, 6)}...)` : t.symbol;
        lines.push(theme.pair(label, theme.positive(`${t.amount.toFixed(decimals)} ${t.symbol}`)));
      }
      if (tokens.length === 0) {
        lines.push(theme.dim('  No SPL tokens found'));
      }
      lines.push('');
      return { success: true, message: lines.join('\n') };
    } catch (error: unknown) {
      return { success: false, message: `  Failed to fetch balance: ${getErrorMessage(error)}` };
    }
  },
};

export const walletTokens: ToolDefinition = {
  name: 'wallet_tokens',
  description: 'Detect all tokens in the connected wallet',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const wm = context.walletManager;
    if (!wm || (!wm.isConnected && !wm.hasAddress)) {
      // In simulation mode, show sim balance instead of error
      if (context.simulationMode) {
        const balance = context.flashClient.getBalance();
        const lines = [
          theme.titleBlock('TOKENS IN WALLET (SIM)'),
          '',
          theme.pair('USDC', theme.positive(formatUsd(balance))),
          theme.dim('  Simulation wallet — no real tokens on-chain'),
          '',
        ];
        return { success: true, message: lines.join('\n') };
      }
      return {
        success: true,
        message: chalk.dim('  No wallet connected. Use "wallet import <name> <path>" or "wallet connect <path>".'),
      };
    }
    try {
      const { sol, tokens } = await wm.getTokenBalances();
      const lines = [theme.titleBlock('TOKENS IN WALLET'), '', theme.pair('SOL', theme.positive(sol.toFixed(4)))];
      for (const t of tokens) {
        const decimals = t.symbol === 'USDC' || t.symbol === 'USDT' ? 2 : 4;
        const label = t.symbol === 'UNKNOWN' ? `UNKNOWN (${t.mint.slice(0, 6)}...)` : t.symbol;
        lines.push(theme.pair(label, theme.positive(t.amount.toFixed(decimals))));
      }
      if (tokens.length === 0) {
        lines.push(theme.dim('  No SPL tokens found'));
      }
      lines.push('');
      return { success: true, message: lines.join('\n') };
    } catch (error: unknown) {
      return { success: false, message: `  Failed to fetch wallet tokens: ${getErrorMessage(error)}` };
    }
  },
};

export const flashMarkets: ToolDefinition = {
  name: 'flash_markets_list',
  description: 'List all Flash Trade markets with pool mapping',
  parameters: z.object({}),
  execute: async (_params, _context): Promise<ToolResult> => {
    const { POOL_MARKETS, isTradeablePool } = await import('../config/index.js');
    const lines = [theme.titleBlock('FLASH TRADE MARKETS'), ''];
    for (const [pool, markets] of Object.entries(POOL_MARKETS)) {
      const tradeable = isTradeablePool(pool);
      for (const market of markets) {
        const tag = tradeable ? '' : theme.dim(' (coming soon)');
        lines.push(`  ${market.padEnd(12)} ${theme.dim('→')} ${theme.accent(pool)}${tag}`);
      }
    }
    lines.push('');
    return { success: true, message: lines.join('\n') };
  },
};

export const walletConnect: ToolDefinition = {
  name: 'wallet_connect',
  description: 'Connect a wallet from a keypair file',
  parameters: z.object({
    path: z.string(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { path: inputPath } = params as { path: string };
    if (!inputPath) {
      return {
        success: false,
        message: [
          chalk.red('  Missing path. Usage:'),
          '',
          `    ${chalk.cyan('wallet connect <path>')}`,
          '',
          chalk.dim('  Example: wallet connect ~/.config/solana/id.json'),
        ].join('\n'),
      };
    }

    // If input looks like a wallet name (no path separators, no extension),
    // check if it matches a stored wallet and suggest "wallet use" instead.
    const looksLikeName = !inputPath.includes('/') && !inputPath.includes('\\') && !inputPath.includes('.');
    if (looksLikeName) {
      const { WalletStore: WS } = await import('../wallet/wallet-store.js');
      const store = new WS();
      const wallets = store.listWallets().map((n) => n.toLowerCase());
      if (wallets.includes(inputPath.toLowerCase())) {
        return {
          success: false,
          message: [
            '',
            chalk.yellow(`  "${inputPath}" is a saved wallet name, not a file path.`),
            '',
            `  ${chalk.dim('Use:')}  ${chalk.cyan(`wallet use ${inputPath}`)}`,
            '',
          ].join('\n'),
        };
      }
    }

    const wm = context.walletManager;
    if (!wm) {
      return { success: false, message: chalk.red('  Wallet manager not available') };
    }
    try {
      const { address } = wm.loadFromFile(inputPath);
      context.walletAddress = address;
      context.walletName = 'wallet';
      updateLastWallet('wallet');

      const canSign = wm.isConnected;
      const lines = ['', chalk.green('  Wallet Connected'), chalk.dim('  ─────────────────'), ''];

      if (canSign) {
        lines.push(chalk.bgRed.white.bold('  LIVE TRADING ENABLED '));
        lines.push('');
      }

      return {
        success: true,
        message: lines.join('\n'),
        data: canSign ? { walletConnected: true } : undefined,
      };
    } catch (error: unknown) {
      return { success: false, message: `  Failed to connect wallet: ${getErrorMessage(error)}` };
    }
  },
};

export const allWalletTools: ToolDefinition[] = [
  walletImport,
  walletList,
  walletUse,
  walletRemove,
  walletDisconnect,
  walletStatus,
  walletAddress,
  walletBalance,
  walletTokens,
  walletConnect,
  flashMarkets,
];
