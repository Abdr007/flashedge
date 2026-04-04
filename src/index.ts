#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig } from './config/index.js';
import { FlashTerminal } from './cli/terminal.js';
import { getErrorMessage } from './utils/retry.js';
import { BUILD_INFO } from './build-info.js';
import { IS_AGENT, agentError } from './no-dna.js';
import chalk from 'chalk';

// Suppress noisy @solana/web3.js 429 retry messages that pollute the terminal prompt.
// The library prints these directly to console.error — we redirect to the log file instead.
const _origConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const msg = typeof args[0] === 'string' ? args[0] : '';
  if (msg.includes('Server responded with') && msg.includes('Retrying after')) {
    // Drop these — they come from @solana/web3.js internal retry logic
    // and interleave with the user's CLI prompt making it unreadable.
    return;
  }
  if (msg.startsWith('ws error:') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT')) {
    // Drop WebSocket reconnect noise — happens when laptop sleeps or network drops.
    // The RPC manager handles failover automatically.
    return;
  }
  _origConsoleError(...args);
};

// Global error handlers — prevent crashes from leaking to the user
// NOTE: unhandledRejection must NOT call process.exit() — background subsystems
// (health monitor, reconciler) fire-and-forget promises that may
// reject during RPC outages. Crashing the terminal for a background task error
// would bypass graceful shutdown (history save, cleanup).
process.on('unhandledRejection', (reason) => {
  if (IS_AGENT) {
    agentError('unhandled_rejection', { detail: getErrorMessage(reason) });
  } else {
    console.error(chalk.red(`\n  Unhandled async error: ${getErrorMessage(reason)}`));
    console.error(chalk.dim('  The terminal is still running. If this persists, restart with "exit".\n'));
  }
});

process.on('uncaughtException', (err) => {
  if (IS_AGENT) {
    agentError('fatal_error', { detail: getErrorMessage(err) }, 1);
  } else {
    console.error(chalk.red(`\n  Fatal error: ${getErrorMessage(err)}\n`));
    process.exit(1);
  }
});

// NOTE: SIGTERM is handled by FlashTerminal.start() once the terminal is
// running. Registering it here would bypass the terminal's graceful shutdown
// (history save, monitor cleanup). For non-interactive
// commands (markets, stats, etc.), Node exits naturally when done.

const program = new Command();

const versionString = [
  `Flash Terminal v${BUILD_INFO.version}`,
  `Commit: ${BUILD_INFO.gitHash}`,
  `Branch: ${BUILD_INFO.branch}`,
  `Built:  ${BUILD_INFO.buildDate}`,
].join('\n');

program
  .name('flash')
  .description('Flash Terminal — CLI for Flash Trade on Solana')
  .version(versionString, '-v, --version');

// Default command: launch the interactive terminal
program
  .command('start', { isDefault: true })
  .description('Start the interactive Flash Terminal')
  .option('-p, --pool <name>', 'Default pool name')
  .option('--rpc <url>', 'Solana RPC URL')
  .option('--no-plugins', 'Disable plugin loading')
  .action(async (opts: { pool?: string; rpc?: string; plugins?: boolean }) => {
    const config = loadConfig();

    if (opts.pool) config.defaultPool = opts.pool;
    if (opts.rpc) {
      const { validateRpcUrl } = await import('./config/index.js');
      config.rpcUrl = validateRpcUrl(opts.rpc);
    }
    if (opts.plugins === false) config.noPlugins = true;

    const terminal = new FlashTerminal(config);
    await terminal.start();
  });

program
  .command('markets')
  .description('List all available markets')
  .action(async () => {
    const { POOL_MARKETS } = await import('./config/index.js');
    if (IS_AGENT) {
      const { agentOutput } = await import('./no-dna.js');
      agentOutput({ action: 'list_markets', pools: POOL_MARKETS });
      return;
    }
    console.log(chalk.bold('\n  Flash Trade Markets\n'));
    for (const [pool, markets] of Object.entries(POOL_MARKETS)) {
      console.log(`  ${chalk.yellow(pool)}: ${markets.join(', ')}`);
    }
    console.log();
  });

program
  .command('stats')
  .description('Show Flash Trade overview stats')
  .option('-p, --period <period>', 'Time period (7d, 30d, all)', '30d')
  .action(async (opts: { period?: '7d' | '30d' | 'all' }) => {
    const { FStatsClient } = await import('./data/fstats.js');
    const { formatUsd, colorPercent } = await import('./utils/format.js');
    const fstats = new FStatsClient();

    try {
      const stats = await fstats.getOverviewStats(opts.period);
      if (IS_AGENT) {
        const { agentOutput } = await import('./no-dna.js');
        agentOutput({ action: 'stats', period: opts.period, ...stats });
        return;
      }
      console.log(chalk.bold('\n  Flash Trade Stats\n'));
      console.log(`  Volume:     ${formatUsd(stats.volumeUsd)} (${colorPercent(stats.volumeChangePct)})`);
      console.log(`  Trades:     ${stats.trades.toLocaleString()}`);
      console.log(`  Fees:       ${formatUsd(stats.feesUsd)}`);
      console.log(`  Pool PnL:   ${formatUsd(stats.poolPnlUsd)}`);
      console.log(`  Revenue:    ${formatUsd(stats.poolRevenueUsd)}`);
      console.log(`  Traders:    ${stats.uniqueTraders}`);
      console.log();
    } catch (error: unknown) {
      if (IS_AGENT) {
        agentError('stats_failed', { detail: getErrorMessage(error) });
      } else {
        console.error(chalk.red(`  Error: ${getErrorMessage(error)}`));
      }
    }
  });

program
  .command('leaderboard')
  .description('Show trader leaderboard')
  .option('-m, --metric <metric>', 'Ranking metric (pnl, volume)', 'pnl')
  .option('-d, --days <days>', 'Time period in days', '30')
  .option('-n, --limit <limit>', 'Number of entries', '10')
  .action(async (opts: { metric?: 'pnl' | 'volume'; days?: string; limit?: string }) => {
    const { FStatsClient } = await import('./data/fstats.js');
    const { formatUsd, colorPnl, shortAddress, formatTable } = await import('./utils/format.js');
    const fstats = new FStatsClient();

    try {
      const entries = await fstats.getLeaderboard(
        opts.metric,
        parseInt(opts.days ?? '30'),
        parseInt(opts.limit ?? '10'),
      );
      if (IS_AGENT) {
        const { agentOutput } = await import('./no-dna.js');
        agentOutput({
          action: 'leaderboard',
          metric: opts.metric ?? 'pnl',
          days: parseInt(opts.days ?? '30'),
          entries: entries.map((e) => ({
            rank: e.rank,
            address: e.address,
            pnl: e.pnl,
            volume: e.volume,
            trades: e.trades,
          })),
        });
        return;
      }
      console.log(chalk.bold(`\n  Leaderboard — ${(opts.metric ?? 'pnl').toUpperCase()} (${opts.days ?? '30'}d)\n`));

      const headers = ['#', 'Trader', 'PnL', 'Volume', 'Trades'];
      const rows = entries.map((e) => [
        `${e.rank}`,
        shortAddress(e.address),
        colorPnl(e.pnl),
        formatUsd(e.volume),
        e.trades.toString(),
      ]);
      console.log(formatTable(headers, rows));
      console.log();
    } catch (error: unknown) {
      if (IS_AGENT) {
        agentError('leaderboard_failed', { detail: getErrorMessage(error) });
      } else {
        console.error(chalk.red(`  Error: ${getErrorMessage(error)}`));
      }
    }
  });

program
  .command('doctor')
  .description('Check system environment and connectivity')
  .action(async () => {
    const config = loadConfig();
    const { agentOutput } = await import('./no-dna.js');

    type CheckResult = { name: string; status: 'ok' | 'warn' | 'fail'; detail: string };
    const checks: CheckResult[] = [];

    // 1. Node.js version
    const nodeVersion = process.versions.node;
    const major = parseInt(nodeVersion.split('.')[0], 10);
    checks.push({
      name: 'node_version',
      status: major >= 18 ? 'ok' : 'fail',
      detail: `v${nodeVersion}`,
    });

    // 2. RPC connection
    if (!config.rpcUrl) {
      checks.push({ name: 'rpc', status: 'fail', detail: 'RPC_URL not configured' });
    } else {
      try {
        const res = await fetch(config.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
          signal: AbortSignal.timeout(5000),
        });
        const data = (await res.json()) as { result?: string };
        checks.push({
          name: 'rpc',
          status: data.result === 'ok' ? 'ok' : 'warn',
          detail: data.result === 'ok' ? 'Connected' : 'Reachable but unhealthy',
        });
      } catch {
        checks.push({ name: 'rpc', status: 'fail', detail: 'Unreachable' });
      }
    }

    // 3. Market data
    try {
      const { PriceService } = await import('./data/prices.js');
      const ps = new PriceService();
      const prices = await ps.getPrices(['SOL']);
      const solPrice = prices.get('SOL');
      checks.push({
        name: 'market_data',
        status: solPrice && solPrice.price > 0 ? 'ok' : 'warn',
        detail: solPrice && solPrice.price > 0 ? 'Live data available' : 'No price data returned',
      });
    } catch {
      checks.push({ name: 'market_data', status: 'fail', detail: 'Unable to fetch prices' });
    }

    // 4. fstats.io connectivity
    try {
      const { FStatsClient } = await import('./data/fstats.js');
      const fstats = new FStatsClient();
      const stats = await fstats.getOverviewStats();
      checks.push({
        name: 'flash_trade_data',
        status: stats.trades > 0 ? 'ok' : 'warn',
        detail: stats.trades > 0 ? 'Connected' : 'No data returned',
      });
    } catch {
      checks.push({ name: 'flash_trade_data', status: 'fail', detail: 'Unable to reach fstats.io' });
    }

    // 5. Command parser
    checks.push({
      name: 'command_parser',
      status: 'ok',
      detail: 'Deterministic (local regex)',
    });

    // 6. Wallet
    try {
      const { WalletStore } = await import('./wallet/wallet-store.js');
      const store = new WalletStore();
      const wallets = store.listWallets();
      const defaultWallet = store.getDefault();
      checks.push({
        name: 'wallet',
        status: defaultWallet ? 'ok' : wallets.length > 0 ? 'warn' : 'warn',
        detail: defaultWallet
          ? `Default: ${defaultWallet}`
          : wallets.length > 0
            ? `${wallets.length} saved, none set as default`
            : 'Not configured',
      });
    } catch {
      checks.push({ name: 'wallet', status: 'warn', detail: 'Not configured' });
    }

    const allOk = checks.every((c) => c.status !== 'fail');

    // Agent mode: structured JSON
    if (IS_AGENT) {
      agentOutput({
        action: 'doctor',
        healthy: allOk,
        checks: checks.map((c) => ({ name: c.name, status: c.status, detail: c.detail })),
      });
      return;
    }

    // Human mode: formatted output
    const label = (name: string) => `  ${name.padEnd(23)}`;
    const ok = (msg: string) => chalk.green(`✓ ${msg}`);
    const warn = (msg: string) => chalk.yellow(`⚠ ${msg}`);
    const fail = (msg: string) => chalk.red(`✗ ${msg}`);
    const statusFn = { ok, warn, fail };

    console.log('');
    console.log(chalk.bold('  FLASH TERMINAL DIAGNOSTICS'));
    console.log(chalk.yellow('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log('');

    const nameMap: Record<string, string> = {
      node_version: 'Node.js version',
      rpc: 'RPC connection',
      market_data: 'Market data',
      flash_trade_data: 'Flash Trade data',
      command_parser: 'Command parser',
      wallet: 'Wallet',
    };

    for (const check of checks) {
      console.log(label(nameMap[check.name] ?? check.name) + statusFn[check.status](check.detail));
    }

    console.log('');
    if (allOk) {
      console.log(chalk.green('  Environment ready.'));
    } else {
      console.log(chalk.yellow('  Some checks failed. Review the issues above.'));
    }
    console.log('');
  });

// ─── Non-Interactive Trade Commands ──────────────────────────────────────────
// These allow direct CLI usage: `flash price sol`, `flash positions`, etc.
// Designed for automation, scripting, and agent integration.

program
  .command('price <market>')
  .description('Get current price for a market')
  .action(async (market: string) => {
    const { PriceService } = await import('./data/prices.js');
    const { agentOutput } = await import('./no-dna.js');
    const { formatPrice, colorPercent } = await import('./utils/format.js');
    const priceSvc = new PriceService();
    const symbol = market.toUpperCase();

    try {
      const prices = await priceSvc.getPrices([symbol]);
      const p = prices.get(symbol);
      if (!p) {
        if (IS_AGENT) {
          agentError('market_not_found', { market: symbol });
        } else {
          console.error(chalk.red(`  Market not found: ${symbol}`));
        }
        process.exit(1);
      }

      if (IS_AGENT) {
        agentOutput({
          action: 'price',
          market: symbol,
          price: p.price,
          change_24h_pct: p.priceChange24h,
          source: p.isFallback ? 'fallback' : 'live',
        });
      } else {
        console.log(`\n  ${chalk.bold(symbol)}  ${formatPrice(p.price)}  ${colorPercent(p.priceChange24h)}\n`);
      }
    } catch (error: unknown) {
      if (IS_AGENT) {
        agentError('price_failed', { market: symbol, detail: getErrorMessage(error) });
      } else {
        console.error(chalk.red(`  Error: ${getErrorMessage(error)}`));
      }
      process.exit(1);
    }
  });

program
  .command('completion <shell>')
  .description('Generate shell completion script (bash, zsh, fish)')
  .action(async (shell: string) => {
    try {
      const { generateBashCompletion, generateZshCompletion, generateFishCompletion } =
        await import('./cli/shell-completion.js');
      switch (shell.toLowerCase()) {
        case 'bash':
          process.stdout.write(generateBashCompletion());
          break;
        case 'zsh':
          process.stdout.write(generateZshCompletion());
          break;
        case 'fish':
          process.stdout.write(generateFishCompletion());
          break;
        default:
          if (IS_AGENT) {
            agentError('invalid_shell', { shell, supported: ['bash', 'zsh', 'fish'] });
          } else {
            console.error(chalk.red(`  Unsupported shell: ${shell}. Use bash, zsh, or fish.`));
          }
          process.exit(1);
      }
    } catch (error: unknown) {
      if (IS_AGENT) {
        agentError('completion_failed', { detail: getErrorMessage(error) });
      } else {
        console.error(chalk.red(`  Error generating completion: ${getErrorMessage(error)}`));
      }
      process.exit(1);
    }
  });

program
  .command('version')
  .description('Show version and build information')
  .action(async () => {
    const { agentOutput } = await import('./no-dna.js');
    if (IS_AGENT) {
      agentOutput({
        action: 'version',
        name: 'bolt-terminal',
        version: BUILD_INFO.version,
        commit: BUILD_INFO.gitHash,
        branch: BUILD_INFO.branch,
        build_date: BUILD_INFO.buildDate,
        platform: BUILD_INFO.platform ?? process.platform,
        arch: BUILD_INFO.arch ?? process.arch,
        node: process.versions.node,
        network: 'mainnet-beta',
      });
      return;
    }
    console.log('');
    console.log(chalk.bold(`  Flash Terminal v${BUILD_INFO.version}`));
    console.log('');
    console.log(`  ${chalk.dim('Commit:')}    ${BUILD_INFO.gitHash}`);
    console.log(`  ${chalk.dim('Branch:')}    ${BUILD_INFO.branch}`);
    console.log(`  ${chalk.dim('Built:')}     ${BUILD_INFO.buildDate}`);
    console.log(
      `  ${chalk.dim('Platform:')}  ${BUILD_INFO.platform ?? process.platform}/${BUILD_INFO.arch ?? process.arch}`,
    );
    console.log(`  ${chalk.dim('Node:')}      v${process.versions.node}`);
    console.log(`  ${chalk.dim('Network:')}   Solana Mainnet`);
    console.log('');
  });

program
  .command('update')
  .description('Check for updates and install the latest version')
  .option('--check', 'Only check for updates, do not install')
  .action(async (opts: { check?: boolean }) => {
    const { agentOutput } = await import('./no-dna.js');
    const currentVersion = BUILD_INFO.version;

    // Fetch latest version from npm registry
    if (!IS_AGENT) process.stdout.write('  Checking for updates...\r');

    let latestVersion: string;
    try {
      const res = await fetch('https://registry.npmjs.org/bolt-terminal/latest', {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        // Package may not be published yet
        if (IS_AGENT) {
          agentOutput({
            action: 'update',
            status: 'unavailable',
            current_version: currentVersion,
            detail: 'Package not found on npm registry',
          });
        } else {
          console.log('  Package not yet published to npm.');
          console.log(chalk.dim('  Update manually: git pull && npm run build'));
        }
        return;
      }
      const data = (await res.json()) as { version: string };
      latestVersion = data.version;
    } catch (error: unknown) {
      if (IS_AGENT) {
        agentError('update_check_failed', { detail: getErrorMessage(error) });
      } else {
        console.error(chalk.red(`  Failed to check for updates: ${getErrorMessage(error)}`));
      }
      process.exit(1);
      return; // TypeScript flow
    }

    // Compare versions
    const isUpToDate = currentVersion === latestVersion;

    if (isUpToDate) {
      if (IS_AGENT) {
        agentOutput({ action: 'update', status: 'up_to_date', current_version: currentVersion });
      } else {
        console.log(`  Already up to date (v${currentVersion}).     `);
      }
      return;
    }

    // New version available
    if (opts.check) {
      if (IS_AGENT) {
        agentOutput({
          action: 'update',
          status: 'available',
          current_version: currentVersion,
          latest_version: latestVersion,
        });
      } else {
        console.log(`  New version available: v${latestVersion} (current: v${currentVersion})`);
        console.log(chalk.dim(`  Run "flash update" to install.`));
      }
      return;
    }

    // Perform update via npm
    if (!IS_AGENT) {
      console.log(`  Updating v${currentVersion} → v${latestVersion}...     `);
    }

    try {
      // Use spawn with shell:false and explicit args to prevent command injection.
      // Only the whitelisted command 'npm install -g bolt-terminal@latest' is allowed.
      const { spawn } = await import('child_process');
      await new Promise<void>((resolveP, rejectP) => {
        const child = spawn('npm', ['install', '-g', 'bolt-terminal@latest'], {
          shell: false,
          stdio: IS_AGENT ? 'pipe' : 'inherit',
          timeout: 120_000,
        });
        child.on('close', (code) => {
          if (code === 0) resolveP();
          else rejectP(new Error(`npm install exited with code ${code}`));
        });
        child.on('error', rejectP);
      });

      if (IS_AGENT) {
        agentOutput({
          action: 'update',
          status: 'updated',
          previous_version: currentVersion,
          new_version: latestVersion,
        });
      } else {
        console.log('');
        console.log(chalk.green(`  Updated to v${latestVersion}.`));
        console.log(chalk.dim('  Restart Flash Terminal to use the new version.'));
        console.log('');
      }
    } catch (error: unknown) {
      if (IS_AGENT) {
        agentError('update_failed', {
          current_version: currentVersion,
          target_version: latestVersion,
          detail: getErrorMessage(error),
        });
      } else {
        console.error(chalk.red(`  Update failed: ${getErrorMessage(error)}`));
        console.log(chalk.dim('  Try manually: npm install -g bolt-terminal@latest'));
      }
      process.exit(1);
    }
  });

// Single-command execution for pipelines and automation
// Usage: flash exec "positions --format json" | jq '.data'
//        flash exec "portfolio" --format json > output.json
program
  .command('exec <command>')
  .description('Execute a single command and exit (for pipelines/automation)')
  .option('--format <type>', 'Output format (json)', '')
  .action(async (command: string, opts: { format?: string }) => {
    const config = loadConfig();
    // Force JSON output if --format json is passed to exec
    const isJson = opts.format === 'json' || command.includes('--format json') || command.includes('--format=json');
    if (isJson) {
      // Ensure no stray output — suppress console.error for non-critical messages
      const origErr = console.error;
      console.error = (...args: unknown[]) => {
        const msg = typeof args[0] === 'string' ? args[0] : '';
        // Only allow critical errors through to stderr
        if (msg.includes('fatal') || msg.includes('FATAL') || msg.includes('uncaught')) {
          origErr(...args);
        }
      };
    }

    const terminal = new FlashTerminal(config);
    try {
      await terminal.startExec(command, isJson);
    } catch (error: unknown) {
      if (isJson) {
        const { jsonStringify, jsonError, ErrorCode } = await import('./cli/json-response.js');
        console.log(jsonStringify(jsonError('exec', ErrorCode.UNKNOWN_ERROR, getErrorMessage(error))));
      } else {
        console.error(chalk.red(`  Error: ${getErrorMessage(error)}`));
      }
      process.exitCode = 1;
    }
  });

program
  .command('help-cmd [command]')
  .description('Show detailed help for a command')
  .action(async (command?: string) => {
    if (!command) {
      // Show general help
      program.outputHelp();
      return;
    }
    try {
      const { getCommandHelp } = await import('./cli/command-help.js');
      const help = getCommandHelp(command);
      if (help) {
        console.log(help);
      } else {
        if (IS_AGENT) {
          agentError('unknown_command', { command });
        } else {
          console.error(chalk.yellow(`  No help found for: ${command}`));
          console.log(chalk.dim('  Run "flash help-cmd" for a list of available commands.'));
        }
      }
    } catch (error: unknown) {
      console.error(chalk.red(`  Error: ${getErrorMessage(error)}`));
    }
  });

program.parse();
