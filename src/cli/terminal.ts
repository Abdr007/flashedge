/* eslint-disable max-lines -- core REPL orchestrator; further extraction would break class cohesion */
import { createInterface, Interface } from 'readline';
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import chalk from 'chalk';
import { OfflineInterpreter, localParse } from '../ai/interpreter.js';
import { ToolEngine } from '../tools/engine.js';
import {
  ToolContext,
  ToolResult,
  FlashConfig,
  IFlashClient,
  ActionType,
  ParsedIntent,
  TradeSide,
} from '../types/index.js';
import type { FlashClientInternals, InterpreterWithContext } from '../types/flash-sdk-interfaces.js';
import { SimulatedFlashClient } from '../client/simulation.js';
import { FStatsClient } from '../data/fstats.js';
import { PriceService } from '../data/prices.js';
import { WalletManager, createConnection } from '../wallet/index.js';
import { WalletStore } from '../wallet/wallet-store.js';
import { shortAddress } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import { initLogger, getLogger, Logger, generateRequestId } from '../utils/logger.js';
import { formatUsd } from '../utils/format.js';
import { MarketRegime } from '../regime/regime-types.js';
import { initSigningGuard } from '../security/signing-guard.js';
import { RpcManager, buildRpcEndpoints, initRpcManager } from '../network/rpc-manager.js';
import { initSystemDiagnostics } from '../system/system-diagnostics.js';
import { initReconciler, getReconciler } from '../core/state-reconciliation.js';
import { shutdownStateCache } from '../core/state-cache.js';
import { shutdownStateSnapshot } from '../core/state-snapshot.js';
import { shutdownUltraTxEngine } from '../core/ultra-tx-engine.js';
import { shutdownTpuClient } from '../network/tpu-client.js';

import { loadPlugins, shutdownPlugins } from '../plugins/plugin-loader.js';
import { initHealth, shutdownHealth, getHealth } from '../system/health.js';
import { initRuntimeState, getRuntimeState, shutdownRuntimeState } from '../core/runtime-state.js';
import { initScheduler, shutdownScheduler } from '../core/scheduler.js';
import { CommandThrottle } from '../system/backpressure.js';
import { StatusBar } from './status-bar.js';
import { runDoctor } from '../tools/doctor.js';
// watch.ts removed — monitor command replaces watch functionality
import { theme } from './theme.js';
import { completer, getSuggestions } from './completer.js';
import { buildFastDispatch } from './command-registry.js';
import {
  handleDryRun as handleDryRunExtracted,
  resolveIntent as resolveIntentExtracted,
  type DryRunDeps,
} from './dryrun-handler.js';
import { runMarketMonitor } from './market-monitor.js';
import {
  protocolFees as protocolFeesView,
  protocolVerify as protocolVerifyView,
  sourceVerify as sourceVerifyView,
  positionDebug as positionDebugView,
  type ProtocolViewDeps,
} from './protocol-views.js';
import { getCommandGuidance } from '../utils/command-guidance.js';
import { resolveMarket } from '../utils/market-resolver.js';
import { IS_AGENT, agentError, agentOutput, enableStructuredOutput, restoreOutputMode } from '../no-dna.js';
import { jsonSuccess, jsonError, jsonFromToolResult, jsonStringify, ErrorCode } from './json-response.js';
import {
  setupLiveMode as setupLiveModeFlow,
  showSavedWalletsMenu as showSavedWalletsMenuFlow,
  showWalletPicker as showWalletPickerFlow,
  showFirstTimeWalletSetup as showFirstTimeWalletSetupFlow,
  handleWalletCreateFlow as handleWalletCreateFlowFn,
  handleWalletImportFlow as handleWalletImportFlowFn,
  handleWalletConnectFlow as handleWalletConnectFlowFn,
  handleWalletDisconnected as handleWalletDisconnectedFn,
  handleWalletReconnected as handleWalletReconnectedFn,
  tryConnectWallet as tryConnectWalletFn,
  WalletFlowDeps,
  WalletFlowState,
} from './wallet-flows.js';

/** Alias for backward compat — delegates to centralized resolver */
function resolveMarketAlias(input: string): string {
  return resolveMarket(input);
}

/**
 * Normalize user input: collapse whitespace, trim, strip trailing punctuation.
 * Does NOT lowercase — callers decide casing.
 */
function normalizeInput(raw: string): string {
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, ' ') // strip control chars
      .replace(/\s+/g, ' ') // collapse whitespace
      .trim()
      .replace(/[.!?]+$/, '')
  ); // strip trailing punctuation
}

const COMMAND_TIMEOUT_MS = 120_000;

// ─── Global Flag Extraction ─────────────────────────────────────────────────
// Strips --format json and --key <name> from input before command parsing.

interface CommandFlags {
  /** Output as structured JSON instead of formatted text */
  jsonOutput: boolean;
  /** Temporary wallet override (name or file path) */
  keyOverride: string | null;
  /** Cleaned input with flags removed */
  cleanInput: string;
}

function extractFlags(input: string): CommandFlags {
  let jsonOutput = false;
  let keyOverride: string | null = null;
  let clean = input;

  // Extract --format json (or --format=json)
  const formatMatch = clean.match(/\s+--format[\s=]+json\b/i) || clean.match(/^--format[\s=]+json\b\s*/i);
  if (formatMatch) {
    jsonOutput = true;
    clean = clean.replace(formatMatch[0], ' ');
  }

  // Extract --key <name-or-path> (or --key=<name>) — supports quoted paths with spaces
  const keyMatch =
    clean.match(/\s+--key[\s=]+"([^"]+)"/) ||
    clean.match(/^--key[\s=]+"([^"]+)"\s*/) ||
    clean.match(/\s+--key[\s=]+'([^']+)'/) ||
    clean.match(/^--key[\s=]+'([^']+)'\s*/) ||
    clean.match(/\s+--key[\s=]+(\S+)/) ||
    clean.match(/^--key[\s=]+(\S+)\s*/);
  if (keyMatch) {
    keyOverride = keyMatch[1];
    clean = clean.replace(keyMatch[0], ' ');
  }

  return {
    jsonOutput,
    keyOverride,
    cleanInput: clean.replace(/\s+/g, ' ').trim(),
  };
}
const HISTORY_FILE = join(homedir(), '.flash', 'history');
const MAX_HISTORY = 1000;

/** Single-token fast dispatch — derived from command registry */
const FAST_DISPATCH = buildFastDispatch() as Record<string, ParsedIntent>;

/** Actions that require a working RPC connection (blocked in degraded mode) */
const TRADE_ACTIONS = new Set<string>([
  ActionType.OpenPosition,
  ActionType.ClosePosition,
  ActionType.AddCollateral,
  ActionType.RemoveCollateral,
  ActionType.SetTpSl,
  ActionType.RemoveTpSl,
  ActionType.LimitOrder,
  ActionType.CancelOrder,
  ActionType.EditLimitOrder,
  ActionType.CloseAll,
  ActionType.Swap,
  ActionType.EarnAddLiquidity,
  ActionType.EarnRemoveLiquidity,
  ActionType.EarnStake,
]);

/** Timeout wrapper for command execution */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Command timed out after ${ms / 1000}s: ${label}`)), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

interface IntelligenceData {
  marketCount: number;
  positionCount: number;
  portfolioBalance: number;
  totalPnl: number;
  dominantRegime?: string;
}

export class FlashTerminal {
  private config: FlashConfig;
  private interpreter: OfflineInterpreter;
  private engine!: ToolEngine;
  private context!: ToolContext;
  private rl!: Interface;
  private flashClient!: IFlashClient;
  private fstats: FStatsClient;
  private walletManager: WalletManager;
  /** Mode is locked for the entire session once selected */
  private modeLocked = false;
  /** Confirmation callback for the next line input */
  private pendingConfirmation: ((answer: string) => void) | null = null;
  /** Prevent concurrent command processing */
  private processing = false;
  /** Suppress repeated "Please wait" messages during a single command */
  private processingWarnShown = false;
  /** Prevent trade execution during wallet rebuild */
  private walletRebuilding = false;
  /** Active stdin listener for readHidden — ensures only one at a time */
  private hiddenInputListener: ((buf: Buffer) => void) | null = null;
  /** Buffer for input received while processing (e.g. pre-typed "y" for confirmation) */
  private bufferedLine: string | null = null;
  /** RPC manager for failover support */
  private rpcManager!: RpcManager;
  /** Background maintenance handle */
  private maintenance: { stop(): void } | null = null;
  /** Degraded mode check interval — cleaned up on shutdown */
  private degradedCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** Command throttle — prevents rapid-fire input from overwhelming the system */
  private commandThrottle = new CommandThrottle();
  /** Live status bar */
  private statusBar: StatusBar | null = null;
  /** Last executed command text (for context line) */
  private lastCommand = '';
  /** Last command execution time in ms (for context line) */
  private lastCommandMs = 0;
  /** True when all RPC endpoints are unreachable — blocks trade commands */
  private degradedMode = false;
  /** Tracks whether the degraded-mode entry banner has been shown (prevents spam) */
  private degradedBannerShown = false;
  /** Timestamp when degraded mode was entered */
  private degradedSince = 0;

  constructor(config: FlashConfig) {
    this.config = config;
    this.fstats = new FStatsClient();
    // Initial connection for wallet manager — will be replaced after RPC manager init
    const initConnection = createConnection(config.rpcUrl);
    this.walletManager = new WalletManager(initConnection);

    initLogger(config.logFile ? { logFile: config.logFile } : undefined);

    // Initialize signing guard with config limits
    initSigningGuard({
      maxCollateralPerTrade: config.maxCollateralPerTrade,
      maxPositionSize: config.maxPositionSize,
      maxLeverage: config.maxLeverage,
      maxTradesPerMinute: config.maxTradesPerMinute,
      minDelayBetweenTradesMs: config.minDelayBetweenTradesMs,
    });

    this.interpreter = new OfflineInterpreter();
  }

  async start(): Promise<void> {
    // Create readline early — needed for prompts
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      historySize: MAX_HISTORY,
      completer,
    });

    this.loadHistory();

    // ─── Environment Variable Validation ─────────────────────────────
    {
      const { validateEnvironmentOrExit } = await import('../config/validate-env.js');
      validateEnvironmentOrExit();
    }

    // ─── Early Config Validation ──────────────────────────────────────
    // Run before mode selection so operators see warnings immediately
    try {
      const { validateAndLogConfig } = await import('../config/config-validator.js');
      const earlyWarnings = validateAndLogConfig();
      if (earlyWarnings.length > 0) {
        console.log('');
        for (const w of earlyWarnings) {
          console.log(chalk.yellow(`  ⚠ [${w.code}] ${w.message}`));
        }
        console.log('');
      }
    } catch {
      /* config validation is non-critical */
    }

    // ─── SDK Compatibility Check ─────────────────────────────────────
    try {
      const { checkSdkCompatibility } = await import('../config/sdk-compat.js');
      const sdkCompat = checkSdkCompatibility();
      if (!sdkCompat.compatible) {
        console.log(
          chalk.yellow(
            `  ⚠ Incompatible Flash SDK detected (v${sdkCompat.installed}). Expected ${sdkCompat.expected}. Upgrade recommended.`,
          ),
        );
      }
    } catch {
      /* sdk compat check is non-critical */
    }

    // ─── Update Check (non-blocking) ────────────────────────────────
    try {
      const { BUILD_INFO } = await import('../build-info.js');
      fetch('https://registry.npmjs.org/bolt-terminal/latest', {
        signal: AbortSignal.timeout(5000),
      })
        .then((res) => (res.ok ? (res.json() as Promise<{ version: string }>) : null))
        .then((data) => {
          if (data && data.version !== BUILD_INFO.version) {
            console.log(
              chalk.yellow(
                `\n  Update available: v${BUILD_INFO.version} → v${data.version}` +
                  `\n  Run ${chalk.bold('flash update')} to install\n`,
              ),
            );
          }
        })
        .catch(() => {
          /* update check is non-critical */
        });
    } catch {
      /* update check is non-critical */
    }

    // ─── Alert Consumers ──────────────────────────────────────────────
    try {
      const { autoRegisterWebhook } = await import('../observability/alert-consumers/webhook-consumer.js');
      const { autoRegisterSlack } = await import('../observability/alert-consumers/slack-consumer.js');
      autoRegisterWebhook();
      autoRegisterSlack();
    } catch {
      /* alert consumers are non-critical */
    }

    // ─── Welcome Screen & Mode Selection ──────────────────────────────
    const mode = await this.showModeSelection();

    if (mode === 'exit') {
      console.log(chalk.dim('\n  Goodbye.\n'));
      this.rl.close();
      process.exit(0);
    }

    this.config.tradingMode = mode;
    this.config.simulationMode = mode !== 'live';
    this.modeLocked = true;
    // Persist so restarts remember — user can override with env TRADING_MODE.
    void (async () => {
      try {
        const { saveTradingMode } = await import('../config/index.js');
        saveTradingMode(mode);
      } catch {
        /* best-effort */
      }
    })();



    // Re-initialize signing guard with relaxed rate limits for simulation
    if (this.config.simulationMode) {
      initSigningGuard({
        maxCollateralPerTrade: this.config.maxCollateralPerTrade,
        maxPositionSize: this.config.maxPositionSize,
        maxLeverage: this.config.maxLeverage,
        maxTradesPerMinute: 60,
        minDelayBetweenTradesMs: 500,
      });
    }

    // ─── Mode-Specific Setup ──────────────────────────────────────────
    let walletInfo: { address: string; name: string } | null = null;

    if (mode === 'live' || mode === 'magic') {
      // Magic mode needs a real keypair to derive basket/UDL PDAs + sign on-chain ixs.
      // Reuse the live-mode wallet flow (wallet load/create/select).
      walletInfo = await this.setupLiveMode();
      if (!walletInfo) {
        console.log(chalk.dim('\n  Goodbye.\n'));
        this.rl.close();
        process.exit(0);
      }
    }

    // Pause readline during initialization — prevents stray Enter keypresses
    // from being consumed and lost before the line handler is registered
    this.rl.pause();

    // ─── Initialize RPC Manager ─────────────────────────────────────
    const rpcEndpoints = buildRpcEndpoints(this.config.rpcUrl, this.config.backupRpcUrls);
    this.rpcManager = initRpcManager(rpcEndpoints);
    const connection = this.rpcManager.connection;

    // Warn if using public RPC for live trading
    if (!this.config.simulationMode && this.config.rpcUrl.includes('api.mainnet-beta.solana.com')) {
      console.log(chalk.yellow('\n  ⚠ Using default public RPC — transactions may be slow or fail.'));
      console.log(chalk.dim('    Set RPC_URL in .env for reliable execution (e.g. Helius, QuickNode).'));
    }

    // RPC latency check (non-blocking, 3-call average to avoid cold-start bias)
    if (!this.config.simulationMode) {
      (async () => {
        try {
          const avg = await this.rpcManager.measureLatency();
          if (avg > 600) {
            console.log(chalk.yellow(`\n  ⚠ RPC latency is high (${avg}ms average).`));
            console.log(chalk.dim('    Transaction confirmations may be slower.'));
            console.log(chalk.dim('    Consider switching to a faster RPC provider.\n'));
          }
        } catch {
          /* non-critical */
        }
      })();
    }

    if (this.config.simulationMode) {
      this.flashClient = new SimulatedFlashClient(10_000);
    } else {
      try {
        const { FlashClient } = await import('../client/flash-client.js');
        this.flashClient = new FlashClient(connection, this.walletManager, this.config);
      } catch (error: unknown) {
        console.log(chalk.red(`\n  Failed to initialize live client: ${getErrorMessage(error)}`));
        // Attempt RPC failover
        if (this.rpcManager.fallbackCount > 0) {
          console.log(chalk.yellow('  Attempting RPC failover...'));
          const didFailover = await this.rpcManager.failover();
          if (didFailover) {
            console.log(chalk.green(`  Switched to ${this.rpcManager.activeEndpoint.label}`));
            try {
              const { FlashClient: FC } = await import('../client/flash-client.js');
              this.flashClient = new FC(this.rpcManager.connection, this.walletManager, this.config);
            } catch (e2: unknown) {
              console.log(chalk.red(`  Failover also failed: ${getErrorMessage(e2)}\n`));
              this.rl.close();
              process.exit(1);
            }
          } else {
            console.log(chalk.red('  No healthy backup RPC found.\n'));
            this.rl.close();
            process.exit(1);
          }
        } else {
          console.log(chalk.dim('  Please check your RPC connection and try again.\n'));
          this.rl.close();
          process.exit(1);
        }
      }
    }

    // Start balance fetch early so it runs in parallel with setup below
    const balancePromise = !this.config.simulationMode
      ? Promise.race([
          this.walletManager.getTokenBalances(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
        ]).catch(() => null)
      : Promise.resolve(null);

    // Sync open positions into session history so CLOSE events have matching OPEN records
    // Non-blocking: populates sessionTrades in background to avoid startup delay
    const sessionTrades: import('../types/index.js').SessionTrade[] = [];
    if (!this.config.simulationMode) {
      Promise.race([
        this.flashClient.getPositions(),
        new Promise<never[]>((resolve) => setTimeout(() => resolve([]), 3_000)),
      ])
        .then((existingPositions) => {
          for (const pos of existingPositions) {
            sessionTrades.push({
              action: 'open',
              market: pos.market,
              side: pos.side,
              leverage: pos.leverage,
              sizeUsd: pos.sizeUsd,
              entryPrice: pos.entryPrice,
              openFeePaid: pos.openFee > 0 ? pos.openFee : undefined,
              timestamp: pos.timestamp ? pos.timestamp * 1000 : Date.now(),
            });
          }
        })
        .catch(() => {
          // Non-critical: proceed with empty session history
        });
    }

    // Build tool context
    this.context = {
      flashClient: this.flashClient,
      dataClient: this.fstats,
      simulationMode: this.config.simulationMode,
      tradingMode: this.config.tradingMode,
      degenMode: false,
      walletAddress: walletInfo?.address ?? this.flashClient.walletAddress ?? 'unknown',
      walletName: walletInfo?.name ?? '',
      walletManager: this.walletManager,
      config: this.config,
      sessionTrades,
    };


    this.engine = new ToolEngine(this.context);

    // Initialize system diagnostics
    initSystemDiagnostics(this.rpcManager, this.context);

    // Provide RPC connection to earn pool data for TVL/APY calculations
    try {
      const { setPoolDataConnection } = await import('../earn/pool-data.js');
      setPoolDataConnection(connection);
    } catch {
      /* non-critical */
    }

    // TP/SL and limit orders are now on-chain via Flash SDK.
    // No local engine initialization needed — orders are managed via
    // placeTriggerOrder/placeLimitOrder SDK methods in flash-client.ts.

    // Wire RPC failover to auto-update FlashClient connection
    if (!this.config.simulationMode) {
      this.rpcManager.setConnectionChangeCallback((newConn, ep) => {
        if (this.flashClient && 'replaceConnection' in this.flashClient) {
          (this.flashClient as { replaceConnection: (c: typeof newConn) => void }).replaceConnection(newConn);
        }
        // Update context reference
        if (this.context) {
          this.context.flashClient = this.flashClient;
        }
        // Successful failover — exit degraded mode if active
        if (this.degradedMode) {
          this.degradedMode = false;
          getRuntimeState()?.markRecovered();
          if (this.degradedBannerShown) {
            const downDuration = this.degradedSince > 0
              ? ` (down for ${Math.round((Date.now() - this.degradedSince) / 1000)}s)`
              : '';
            console.log(chalk.green(`\n  ✔ Connection restored${downDuration} — trading re-enabled`));
            this.degradedBannerShown = false;
            this.degradedSince = 0;
          }
        }
        console.log(chalk.cyan(`\n  ℹ RPC failover → ${ep.label}`));
      });
    }

    // ── Staggered background init ──────────────────────────────────────────
    // Defer non-critical RPC-heavy tasks to avoid 429 rate limiting on startup.
    // Each task is spaced out to prevent simultaneous RPC bursts.
    if (!this.config.simulationMode) {
      // Health monitor — start after 5s, with degraded mode detection via scheduler
      setTimeout(async () => {
        this.rpcManager.startMonitoring();
        const { getScheduler } = await import('../core/scheduler.js');
        const { TaskPriority } = await import('../core/runtime-state.js');
        const sched = getScheduler();
        if (sched) {
          sched.register({
            name: 'degraded-mode-check',
            fn: () => {
              const wasDown = this.degradedMode;
              this.degradedMode = this.rpcManager.allEndpointsDown;
              if (this.degradedMode && !wasDown) {
                getRuntimeState()?.markDegraded();
                this.degradedSince = Date.now();
                // Show comprehensive banner ONCE per failure event
                if (!this.degradedBannerShown) {
                  this.degradedBannerShown = true;
                  console.log('');
                  console.log(chalk.yellow('  ─────────────────────────────────────────'));
                  console.log(chalk.yellow.bold('  NETWORK ISSUE — RPC UNAVAILABLE'));
                  console.log(chalk.yellow('  ─────────────────────────────────────────'));
                  console.log('');
                  console.log(chalk.dim('  Unable to reach the blockchain (all RPC endpoints failed).'));
                  console.log('');
                  console.log(`  ${chalk.green('✔')} Trading is temporarily disabled`);
                  console.log(`  ${chalk.green('✔')} Terminal is running in read-only mode`);
                  console.log('');
                  console.log(chalk.dim('  The system is retrying every ~15 seconds.'));
                  console.log(chalk.dim('  Trading will automatically resume once connection is restored.'));
                  console.log('');
                  console.log(chalk.dim('  If this persists: check your internet or update RPC_URL in .env'));
                  console.log('');
                }
              } else if (!this.degradedMode && wasDown) {
                getRuntimeState()?.markRecovered();
                // Show recovery message ONCE
                if (this.degradedBannerShown) {
                  const downDuration = this.degradedSince > 0
                    ? ` (down for ${Math.round((Date.now() - this.degradedSince) / 1000)}s)`
                    : '';
                  console.log('');
                  console.log(chalk.green(`  ✔ Connection restored${downDuration} — trading re-enabled`));
                  console.log('');
                  this.degradedBannerShown = false;
                  this.degradedSince = 0;
                }
              }
            },
            baseIntervalMs: 30_000,
            priority: TaskPriority.CRITICAL,
          });
        }
      }, 5_000).unref();

      // Metrics HTTP server — enable via METRICS_PORT env var
      try {
        const { startMetricsServer } = await import('../observability/metrics-export.js');
        startMetricsServer();
      } catch {
        /* non-critical */
      }

      // Crash recovery — start after 3s
      setTimeout(async () => {
        try {
          const { runRecovery } = await import('../runtime/recovery-engine.js');
          const conn = this.rpcManager?.connection ?? null;
          const recoveryResult = await runRecovery(conn);
          if (recoveryResult.recovered > 0) {
            console.log(chalk.green(`\n  Recovery: ${recoveryResult.recovered} pending trade(s) confirmed on-chain`));
          }
          if (recoveryResult.failed > 0) {
            console.log(chalk.yellow(`\n  Recovery: ${recoveryResult.failed} trade(s) did not land`));
          }
        } catch {
          // Recovery is non-critical
        }
      }, 3_000).unref();

      // State reconciliation — start after 8s (after recovery finishes)
      setTimeout(() => {
        const reconciler = initReconciler(this.flashClient);
        reconciler.reconcile().catch((e) => {
          getLogger().warn('reconciliation', `Failed: ${e instanceof Error ? e.message : String(e)}`);
        });
        reconciler.startPeriodicSync();
      }, 8_000).unref();
    } else {
      // Sim mode: just init reconciler without periodic sync
      const reconciler = initReconciler(this.flashClient);
      reconciler.reconcile().catch((e) => {
        getLogger().warn('reconciliation', `Failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }

    // Start background maintenance after 10s
    setTimeout(async () => {
      try {
        const { startMaintenance } = await import('../system/maintenance.js');
        this.maintenance = startMaintenance();
      } catch {
        // Maintenance is non-critical
      }
    }, 10_000).unref();

    // System health monitor — event loop lag, memory, error rate
    initHealth();

    // Runtime state machine + central scheduler
    const runtimeState = initRuntimeState();
    runtimeState.start();
    const scheduler = initScheduler();
    // Wire event loop lag from health monitor into scheduler for active backpressure
    const healthMon = getHealth();
    if (healthMon) {
      scheduler.setLagProvider(() => healthMon.snapshot().eventLoopLagMs);
    }
    scheduler.start();

    // RPC connection warmup — pre-establish HTTP connections to backup endpoints (12s)
    setTimeout(() => {
      this.rpcManager.warmupConnections().catch(() => {});
    }, 12_000).unref();

    // Silent version check — runs ONCE, 15s after startup, never spams
    setTimeout(async () => {
      try {
        const { silentVersionCheck } = await import('../system/update-checker.js');
        await silentVersionCheck();
      } catch {
        // Must never break the terminal
      }
    }, 15_000).unref();

    // Load plugins and register their tools
    if (this.config.noPlugins) {
      console.log(chalk.dim('  Plugins disabled (--no-plugins).'));
    } else {
      try {
        const pluginTools = await loadPlugins(this.context);
        if (pluginTools.length > 0) {
          for (const tool of pluginTools) {
            this.engine.registerTool(tool);
          }
          console.log(chalk.yellow('  Plugins loaded with full system access.'));
          console.log(chalk.dim('  Only install plugins from trusted sources. Use --no-plugins to disable.'));
        }
      } catch {
        // Plugin loading is non-critical
      }
    }

    // Set prompt based on mode
    this.updatePrompt();

    // Config validation already ran before mode selection (early startup)

    // Log startup readiness (structured, for operational visibility)
    {
      const logger = getLogger();
      logger.info('STARTUP', 'Terminal ready', {
        mode: this.config.simulationMode ? 'simulation' : 'live',
        wallet: walletInfo?.address ?? 'none',
        rpc: this.rpcManager.activeEndpoint.label,
        backupRpcs: this.rpcManager.fallbackCount,
        plugins: this.config.noPlugins ? 'disabled' : 'enabled',
      });
    }

    // ─── Display Intelligence Screen ─────────────────────────────────
    const prefetchedBalances = await balancePromise;
    await this.showIntelligenceScreen(walletInfo?.name ?? null, prefetchedBalances);

    // ─── Start Status Bar (disabled under NO_DNA — no TUI elements) ───
    if (!IS_AGENT) {
      this.statusBar = new StatusBar(this.rl, this.flashClient, this.rpcManager, {
        simulationMode: this.config.simulationMode,
        walletName: walletInfo?.name ?? (this.config.simulationMode ? 'paper' : 'N/A'),
      });
      this.statusBar.start();
    }

    // ─── Signal Handlers ──────────────────────────────────────────────
    process.once('SIGINT', () => {
      process.once('SIGINT', () => process.exit(1)); // force-kill on 2nd Ctrl+C
      this.shutdown();
    });
    process.once('SIGTERM', () => this.shutdown());

    // ─── Start Line Handler ───────────────────────────────────────────
    // Resume readline now that the line handler is about to be registered
    this.rl.resume();

    this.rl.on('close', () => {
      this.shutdown();
    });

    this.rl.on('line', async (line) => {
      if (this.pendingConfirmation) {
        const cb = this.pendingConfirmation;
        this.pendingConfirmation = null;
        cb(line);
        return;
      }

      // Reset session idle timer on any user activity (not just trades)
      if (this.walletManager?.isConnected) {
        this.walletManager.resetIdleTimer();
      }

      // Sanitize: strip control chars (null bytes, etc.) and collapse whitespace
      // eslint-disable-next-line no-control-regex
      const trimmed = line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();

      if (!trimmed) {
        this.rl.prompt();
        return;
      }

      if (trimmed.length > 4096) {
        console.log(chalk.red('  Input too long (max 4096 characters).'));
        this.rl.prompt();
        return;
      }

      const lower = trimmed.toLowerCase();
      if (lower === 'exit' || lower === 'quit') {
        if (!IS_AGENT && !this.config.simulationMode) {
          const ok = await this.confirm('Exit Flash Terminal?');
          if (!ok) {
            this.rl.prompt();
            return;
          }
        }
        this.shutdown();
        return;
      }

      if (this.processing) {
        // Buffer input during processing so confirmation prompts can use it
        // (e.g. user pre-types "y" before the confirmation prompt appears)
        this.bufferedLine = trimmed;
        return;
      }

      this.processing = true;
      this.processingWarnShown = false;
      Logger.setRequestId(generateRequestId());
      this.statusBar?.suspend();
      const cmdStart = Date.now();
      let cmdFailed = false;
      try {
        await this.handleInput(trimmed);
      } catch (error: unknown) {
        console.log(chalk.red(`  ✖ Error: ${getErrorMessage(error)}`));
        cmdFailed = true;
      } finally {
        this.processing = false;
        this.processingWarnShown = false;
        this.bufferedLine = null;
        this.lastCommand = trimmed;
        this.lastCommandMs = Date.now() - cmdStart;
        // Record session metrics
        try {
          const { getSessionMetrics } = await import('../core/session-metrics.js');
          getSessionMetrics().recordCommand(this.lastCommandMs, !cmdFailed);
        } catch {
          /* non-critical */
        }
        try {
          const { getMetrics, METRIC } = await import('../observability/metrics.js');
          getMetrics().record(METRIC.COMMAND_LATENCY, this.lastCommandMs);
        } catch {
          /* non-critical */
        }
        Logger.clearRequestId();
        this.renderExecutionTimer();
        this.statusBar?.resume();
        this.saveHistory();
        this.rl.prompt();
      }
    });

    this.rl.prompt();
  }

  // ─── Single-Command Execution (Pipeline Mode) ──────────────────────

  /**
   * Execute a single command and exit. Used by `flash exec` for pipelines.
   * Initializes in simulation mode (or live if SIMULATION_MODE=false),
   * runs the command, outputs result, and exits.
   */
  async startExec(command: string, jsonMode: boolean): Promise<void> {
    // Minimal readline (not used for prompting, but needed by init path)
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
    this.rl.pause();

    // Determine mode from environment. TRADING_MODE wins; SIMULATION_MODE is legacy.
    const envMode = process.env.TRADING_MODE?.toLowerCase();
    const explicitLive = process.env.SIMULATION_MODE?.toLowerCase() === 'false';
    const agentMode: 'live' | 'simulation' | 'magic' =
      envMode === 'live' || envMode === 'simulation' || envMode === 'magic'
        ? (envMode as 'live' | 'simulation' | 'magic')
        : explicitLive
          ? 'live'
          : 'simulation';
    this.config.tradingMode = agentMode;
    this.config.simulationMode = agentMode !== 'live';
    this.modeLocked = true;

    // In agent mode with magic, auto-load default wallet so magic tools get a Keypair.
    if (agentMode === 'magic') {
      try {
        const { WalletStore } = await import('../wallet/wallet-store.js');
        const store = new WalletStore();
        const def = store.getDefault();
        if (def && !this.walletManager.isConnected) {
          this.walletManager.loadFromFile(store.getWalletPath(def));
        }
      } catch {
        /* best-effort */
      }
    }

    // Re-init signing guard for simulation
    if (this.config.simulationMode) {
      initSigningGuard({
        maxCollateralPerTrade: this.config.maxCollateralPerTrade,
        maxPositionSize: this.config.maxPositionSize,
        maxLeverage: this.config.maxLeverage,
        maxTradesPerMinute: 60,
        minDelayBetweenTradesMs: 500,
      });
    }

    // Initialize RPC
    const rpcEndpoints = buildRpcEndpoints(this.config.rpcUrl, this.config.backupRpcUrls);
    this.rpcManager = initRpcManager(rpcEndpoints);
    const connection = this.rpcManager.connection;

    // Initialize client
    if (this.config.simulationMode) {
      this.flashClient = new SimulatedFlashClient();
    } else {
      // Live mode: try to connect wallet
      const walletStore = new WalletStore();
      this.walletManager = new WalletManager(connection);
      const defaultWallet = walletStore.getDefault();
      if (defaultWallet) {
        try {
          this.walletManager.loadFromFile(walletStore.getWalletPath(defaultWallet));
        } catch {
          // Fall through — wallet-dependent commands will fail gracefully
        }
      }

      try {
        const { FlashClient } = await import('../client/flash-client.js');
        this.flashClient = new FlashClient(connection, this.walletManager, this.config);
      } catch {
        // Fallback to simulation
        this.flashClient = new SimulatedFlashClient();
        this.config.simulationMode = true;
      }
    }

    // Build context
    this.context = {
      flashClient: this.flashClient,
      dataClient: this.fstats,
      simulationMode: this.config.simulationMode,
      tradingMode: this.config.tradingMode,
      degenMode: false,
      walletAddress: this.flashClient.walletAddress ?? 'unknown',
      walletName: '',
      walletManager: this.walletManager,
      config: this.config,
      sessionTrades: [],
    };


    this.engine = new ToolEngine(this.context);

    // Inject --format json if jsonMode is requested but not already in command
    const execCommand = jsonMode && !command.includes('--format json') && !command.includes('--format=json')
      ? `${command} --format json`
      : command;

    // Execute the command
    try {
      await this.handleInput(execCommand);
    } catch (error: unknown) {
      if (jsonMode) {
        console.log(jsonStringify(jsonError('exec', ErrorCode.UNKNOWN_ERROR, getErrorMessage(error))));
      } else {
        console.error(chalk.red(`  Error: ${getErrorMessage(error)}`));
      }
      process.exitCode = 1;
    }

    // L5: Cleanup before exit to flush state
    this.rl.close();
    await this.shutdown();
    process.exit(process.exitCode ?? 0);
  }

  // ─── Welcome Screen ────────────────────────────────────────────────

  private async showModeSelection(): Promise<'live' | 'simulation' | 'magic' | 'exit'> {
    // NO_DNA: never prompt. Honour TRADING_MODE, fall back to SIMULATION_MODE legacy env.
    if (IS_AGENT) {
      const envMode = process.env.TRADING_MODE?.toLowerCase();
      if (envMode === 'live' || envMode === 'simulation' || envMode === 'magic') return envMode;
      const explicitLive = process.env.SIMULATION_MODE?.toLowerCase() === 'false';
      return explicitLive ? 'live' : 'simulation';
    }

    console.log('');
    console.log(`  ${theme.accentBold('FLASH TERMINAL')}`);
    console.log(`  ${theme.separator(32)}`);
    console.log('');
    console.log(theme.dim('  Trading Interface for Flash Trade'));
    console.log('');
    console.log(theme.dim('  Real-time market intelligence and trading tools'));
    console.log(theme.dim('  powered by live blockchain data.'));
    console.log('');
    console.log(theme.section('  Select Mode'));
    console.log('');
    console.log(`    ${theme.command('1)')} ${theme.section('LIVE TRADING')}`);
    console.log(theme.dim('       Execute real transactions on Flash Trade.'));
    console.log('');
    console.log(`    ${theme.command('2)')} ${theme.section('SIMULATION')}`);
    console.log(theme.dim('       Test strategies using paper trading.'));
    console.log('');
    {
      const magicNet = (process.env.MAGIC_NETWORK ?? 'mainnet-beta').toLowerCase() === 'devnet' ? 'DEVNET' : 'MAINNET';
      const magicTag = magicNet === 'MAINNET' ? chalk.green(`[${magicNet}]`) : chalk.red(`[${magicNet}]`);
      console.log(`    ${theme.command('3)')} ${theme.section('MAGIC TRADING')} ${magicTag}`);
    }
    console.log(theme.dim('       Flash Magic Trade on MagicBlock ER — session-key UX, sub-50ms.'));
    console.log('');
    console.log(`    ${theme.command('4)')} ${theme.dim('Exit')}`);
    console.log('');

    while (true) {
      const choice = (await this.ask(`  ${chalk.yellow('>')} `)).trim();

      switch (choice) {
        case '1':
          return 'live';
        case '2':
          return 'simulation';
        case '3':
          return 'magic';
        case '4':
          return 'exit';
        default:
          console.log(chalk.dim('  Enter 1, 2, 3, or 4.'));
          continue;
      }
    }
  }

  // ─── Live Mode Setup ───────────────────────────────────────────────

  /**
   * Set up live mode: ensure a wallet is connected.
   * Auto-connects if a default or single wallet exists.
   * Returns wallet info on success, null if user chose exit.
   */
  private async setupLiveMode(): Promise<{ address: string; name: string } | null> {
    return setupLiveModeFlow(this.walletFlowDeps());
  }

  /** Wallet flow deps helper — builds the deps object from class properties. */
  private walletFlowDeps(): WalletFlowDeps {
    return {
      ask: (q: string) => this.ask(q),
      readHidden: (p: string) => this.readHidden(p),
      confirm: (p: string) => this.confirm(p),
      walletManager: this.walletManager,
      config: this.config,
      flashClient: this.flashClient,
      context: this.context,
      rpcManager: this.rpcManager,
      engine: this.engine,
      noPlugins: !!this.config.noPlugins,
    };
  }

  /** Wallet flow state helper — builds mutable state refs. */
  private walletFlowState(): WalletFlowState {
    return {
      flashClient: this.flashClient,
      context: this.context,
      engine: this.engine,
      walletRebuilding: this.walletRebuilding,
    };
  }

  /** Apply wallet flow state mutations back to class properties. */
  private applyWalletFlowState(state: WalletFlowState): void {
    this.flashClient = state.flashClient;
    this.context = state.context;
    this.engine = state.engine;
    this.walletRebuilding = state.walletRebuilding;
  }

  private async showSavedWalletsMenu(
    store: WalletStore,
    wallets: string[],
    targetWallet: string,
  ): Promise<{ address: string; name: string } | null> {
    return showSavedWalletsMenuFlow(this.walletFlowDeps(), store, wallets, targetWallet);
  }

  private async showWalletPicker(
    store: WalletStore,
    wallets: string[],
  ): Promise<{ address: string; name: string } | null> {
    return showWalletPickerFlow(this.walletFlowDeps(), store, wallets);
  }

  private async showFirstTimeWalletSetup(store: WalletStore): Promise<{ address: string; name: string } | null> {
    return showFirstTimeWalletSetupFlow(this.walletFlowDeps(), store);
  }

  private async handleWalletCreateFlow(store: WalletStore): Promise<{ address: string; name: string } | null> {
    return handleWalletCreateFlowFn(this.walletFlowDeps(), store);
  }

  // ─── Mode Banners ──────────────────────────────────────────────────

  private showSimulationBanner(): void {
    console.log('');
    console.log(chalk.yellow.bold('  ⚡ FLASH TERMINAL ⚡'));
    console.log(chalk.yellow('  ━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log('');
    console.log(chalk.bgYellow.black(' SIMULATION MODE '));
    console.log('');
    console.log(`  Balance: ${chalk.green('$' + this.flashClient.getBalance().toFixed(2))}`);
    console.log(chalk.dim('  Trades are simulated. No real transactions.'));
    console.log('');
    console.log(chalk.dim('  Type "help" for commands.'));
    console.log(chalk.dim('  Type "exit" to close the terminal.'));
    console.log('');
  }

  private async showLiveBanner(walletName: string): Promise<void> {
    console.log('');
    console.log(chalk.red.bold('  ⚡ FLASH TERMINAL ⚡'));
    console.log(chalk.red('  ━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log('');
    console.log(chalk.bgRed.white.bold(' LIVE TRADING MODE '));
    console.log('');
    const walletAddr = this.walletManager.address;
    console.log(`  Wallet:  ${chalk.cyan(walletName)}`);
    if (walletAddr) {
      console.log(`  Address: ${chalk.dim(shortAddress(walletAddr))}`);
    }
    console.log(`  Network: ${chalk.bold(this.config.network)}`);
    console.log('');

    let usdcBal: number | null = null;
    try {
      const tokenData = await this.walletManager.getTokenBalances();
      console.log(`  SOL Balance:  ${chalk.green(tokenData.sol.toFixed(4))} SOL`);
      const usdcToken = tokenData.tokens.find((t) => t.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      usdcBal = usdcToken?.amount ?? 0;
      const usdcColor = usdcBal > 0 ? chalk.green : chalk.yellow;
      console.log(`  USDC Balance: ${usdcColor(usdcBal.toFixed(2))} USDC`);
    } catch {
      try {
        const bal = await this.walletManager.getBalance();
        console.log(`  SOL Balance: ${chalk.green(bal.toFixed(4))} SOL`);
      } catch {
        // best-effort
      }
    }

    console.log('');
    if (usdcBal !== null && usdcBal === 0) {
      console.log(chalk.yellow('  Flash Trade requires USDC collateral to open positions.'));
      console.log(chalk.dim('  Run "wallet tokens" to view all token balances.'));
      console.log('');
    }
    console.log(chalk.yellow('  WARNING'));
    console.log(chalk.dim('  Transactions executed here are real.'));
    console.log('');
    console.log(chalk.dim('  Type "help" for commands.'));
    console.log(chalk.dim('  Type "exit" to close the terminal.'));
    console.log('');
  }

  // ─── Intelligence Screen ─────────────────────────────────────────

  private async showIntelligenceScreen(walletName: string | null, prefetchedBalances?: unknown): Promise<void> {
    // NO_DNA: emit structured ready event, skip TUI
    if (IS_AGENT) {
      const isSim = this.config.tradingMode === 'simulation';
      const isMagic = this.config.tradingMode === 'magic';
      const readyData: Record<string, unknown> = {
        status: 'ready',
        mode: this.config.tradingMode,
        wallet: walletName ?? (isSim ? 'paper' : isMagic ? this.walletManager?.address ?? 'none' : 'none'),
        wallet_address: this.walletManager?.address ?? null,
        rpc_endpoint: this.rpcManager?.activeEndpoint?.label ?? null,
      };
      if (isMagic) {
        readyData.magic_program = this.config.magicProgramId;
        readyData.magic_router = this.config.magicRpcUrl;
      }
      if (isSim) {
        readyData.balance_usdc = this.flashClient.getBalance();
      }
      // Detect FAF stake for agent mode
      if (!isSim && this.walletManager?.address) {
        try {
          const { getFafStakeInfo } = await import('../token/faf-data.js');
          const { PublicKey } = await import('@solana/web3.js');
          const client = this.flashClient as unknown as Partial<FlashClientInternals>;
          if (client.perpClient && client.poolConfig) {
            const info = await Promise.race([
              getFafStakeInfo(client.perpClient, client.poolConfig, new PublicKey(this.walletManager.address)),
              new Promise<null>((r) => setTimeout(() => r(null), 3000)),
            ]);
            if (info && info.stakedAmount > 0) {
              readyData.faf_staked = info.stakedAmount;
              readyData.vip_tier = info.level;
              readyData.fee_discount = info.tier.feeDiscount;
            }
          }
        } catch {
          /* non-critical */
        }
      }
      agentOutput(readyData);
      return;
    }

    const isMagic = this.config.tradingMode === 'magic';
    const isSim = this.config.tradingMode === 'simulation';
    const magicNetLabel = (this.config.magicNetwork ?? 'mainnet-beta') === 'mainnet-beta' ? 'MAINNET' : 'DEVNET';
    const modeLabel = isMagic ? `MAGIC TRADING [${magicNetLabel}]` : isSim ? 'SIMULATION' : 'LIVE TRADING';
    const modeBg = isMagic ? chalk.bgMagenta.white.bold : isSim ? theme.simBadge : theme.liveBadge;

    // Header
    console.log('');
    console.log(`  ${theme.accentBold('FLASH TERMINAL')}`);
    console.log(`  ${theme.separator(32)}`);
    console.log('');
    console.log(`  ${modeBg(' ' + modeLabel + ' ')}`);
    console.log('');

    // Wallet / Balance
    if (isMagic && walletName) {
      const walletAddr = this.walletManager.address;
      console.log(theme.pair('Wallet', theme.accent(walletName)));
      if (walletAddr) console.log(theme.pair('Address', theme.dim(walletAddr)));
      console.log(theme.pair('Program', theme.value('FMTgsEDaPPfJi1PKD67McLTC5n833T4irbBP53LLxtvj')));
      console.log(theme.pair('Router', theme.value(this.config.magicRpcUrl)));
      console.log('');
      console.log(theme.dim('  Run `magic status` to see preflight state, `magic setup` to initialise.'));
    } else if (isSim) {
      console.log(theme.pair('Balance', theme.positive('$' + this.flashClient.getBalance().toFixed(2))));
      console.log(theme.dim('  Trades are simulated. No real transactions.'));
    } else if (walletName) {
      const walletAddr = this.walletManager.address;
      console.log(theme.pair('Wallet', theme.accent(walletName)));
      if (walletAddr) {
        console.log(theme.pair('Address', theme.dim(walletAddr)));
      }
      console.log(theme.pair('Network', theme.value(this.config.network)));
      console.log('');

      // Use pre-fetched balance data (started before setup) — no extra RPC call
      let solBal: number | null = null;
      let usdcBal: number | null = null;
      const tokenData = prefetchedBalances as { sol: number; tokens: Array<{ mint: string; amount: number }> } | null;
      if (tokenData) {
        solBal = tokenData.sol;
        const usdcToken = tokenData.tokens.find((t) => t.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
        usdcBal = usdcToken?.amount ?? 0;
      }

      if (solBal !== null) {
        console.log(theme.pair('SOL Balance', theme.positive(solBal.toFixed(4) + ' SOL')));
      }
      if (usdcBal !== null) {
        const val =
          usdcBal > 0 ? theme.positive(usdcBal.toFixed(2) + ' USDC') : theme.warning(usdcBal.toFixed(2) + ' USDC');
        console.log(theme.pair('USDC Balance', val));
      }
      if (solBal === null && usdcBal === null) {
        console.log(theme.dim('  Run "wallet tokens" to view balances.'));
      }

      // ── FAF Stake Detection (non-blocking, 3s timeout) ──
      try {
        const { getFafStakeInfo, getVoltageInfo } = await import('../token/faf-data.js');
        const { formatFaf } = await import('../token/faf-registry.js');
        const { PublicKey } = await import('@solana/web3.js');

        if (this.flashClient && 'perpClient' in this.flashClient && 'poolConfig' in this.flashClient) {
          const client = this.flashClient as unknown as FlashClientInternals;
          const userPk = new PublicKey(this.walletManager.address!);

          const stakeInfo = await Promise.race([
            getFafStakeInfo(client.perpClient, client.poolConfig, userPk),
            new Promise<null>((r) => setTimeout(() => r(null), 3000)),
          ]);

          if (stakeInfo && stakeInfo.stakedAmount > 0) {
            console.log('');
            console.log(theme.pair('FAF Staked', theme.accent(formatFaf(stakeInfo.stakedAmount))));
            console.log(
              theme.pair('VIP Tier', `Level ${stakeInfo.level} (${stakeInfo.tier.feeDiscount}% fee discount)`),
            );

            if (stakeInfo.pendingRewards > 0) {
              console.log(theme.pair('Pending FAF', theme.positive(formatFaf(stakeInfo.pendingRewards))));
            }
            if (stakeInfo.pendingRevenue > 0) {
              console.log(theme.pair('Pending USDC', theme.positive('$' + stakeInfo.pendingRevenue.toFixed(2))));
            }

            // Voltage tier
            try {
              const voltageInfo = await Promise.race([
                getVoltageInfo(client.perpClient, client.poolConfig, userPk),
                new Promise<null>((r) => setTimeout(() => r(null), 2000)),
              ]);
              if (voltageInfo) {
                console.log(theme.pair('Voltage Tier', `${voltageInfo.tierName} (${voltageInfo.multiplier}x)`));
              }
            } catch {
              /* voltage is non-critical */
            }
          }
        }
      } catch {
        // FAF detection is non-critical — never block startup
      }

      console.log('');
      if (usdcBal !== null && usdcBal === 0) {
        console.log(theme.warning('  Flash Trade requires USDC collateral to open positions.'));
        console.log(theme.dim('  Run "wallet tokens" to view all token balances.'));
        console.log('');
      }
      console.log(theme.warning('  WARNING'));
      console.log(theme.dim('  Transactions executed here are real.'));
    }
    console.log('');

    // ─── Quick Start Hints ───────────────────────────────────────
    console.log(theme.section('  Quick Start'));
    console.log(`    ${theme.command('help')}           List all commands`);
    console.log(`    ${theme.command('dashboard')}      Protocol & portfolio overview`);
    console.log(`    ${theme.command('monitor')}        Live market monitoring`);
    console.log(`    ${theme.command('wallet tokens')}  View token balances`);
    console.log(`    ${theme.command('markets')}        View available markets`);
    console.log('');
    console.log(theme.dim('  Type "exit" to close the terminal.'));
    console.log('');
  }

  private async fetchIntelligence(): Promise<IntelligenceData | null> {
    const INTEL_TIMEOUT = 5_000; // 5s max for intelligence fetch

    return new Promise<IntelligenceData | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), INTEL_TIMEOUT);

      this.doFetchIntelligence()
        .then((data) => {
          clearTimeout(timer);
          resolve(data);
        })
        .catch(() => {
          clearTimeout(timer);
          resolve(null);
        });
    });
  }

  private async doFetchIntelligence(): Promise<IntelligenceData> {
    const { SolanaInspector } = await import('../agent/solana-inspector.js');
    const inspector = new SolanaInspector(this.context.flashClient, this.context.dataClient);
    const snapshot = await inspector.getFullSnapshot();

    const data: IntelligenceData = {
      marketCount: snapshot.markets.length,
      positionCount: snapshot.positions.length,
      portfolioBalance: snapshot.portfolio.balance,
      totalPnl: snapshot.portfolio.totalUnrealizedPnl,
    };

    // Regime detection
    if (snapshot.markets.length > 0) {
      try {
        const { RegimeDetector } = await import('../regime/regime-detector.js');
        const rd = new RegimeDetector();
        const regimes = rd.detectAll(snapshot.markets, snapshot.volume, snapshot.openInterest);
        if (regimes.size > 0) {
          const counts = new Map<string, number>();
          for (const [, state] of regimes) {
            counts.set(state.regime, (counts.get(state.regime) ?? 0) + 1);
          }
          data.dominantRegime = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        }
      } catch {
        // regime detection is best-effort
      }
    }

    return data;
  }

  private renderIntelligence(intel: IntelligenceData): void {
    console.log(chalk.bold('  Market Overview'));
    console.log(chalk.dim('  ─────────────────────────────────────────'));
    console.log('');

    // Regime
    if (intel.dominantRegime) {
      console.log(`  Regime:    ${this.colorRegime(intel.dominantRegime)}`);
    } else {
      console.log(chalk.dim('  Regime:    Data unavailable'));
    }

    // Coverage
    console.log(`  Markets:   ${chalk.bold(String(intel.marketCount))} active`);
    console.log('');

    // Portfolio summary (only if positions exist)
    if (intel.positionCount > 0) {
      console.log(chalk.bold('  Portfolio'));
      console.log(
        `    Positions: ${intel.positionCount}  PnL: ${intel.totalPnl >= 0 ? chalk.green(formatUsd(intel.totalPnl)) : chalk.red(formatUsd(intel.totalPnl))}`,
      );
      console.log('');
    }
  }

  private colorRegime(regime: string): string {
    switch (regime) {
      case MarketRegime.TRENDING:
        return chalk.green(regime);
      case MarketRegime.RANGING:
        return chalk.blue(regime);
      case MarketRegime.HIGH_VOLATILITY:
        return chalk.red(regime);
      case MarketRegime.LOW_VOLATILITY:
        return chalk.gray(regime);
      case MarketRegime.WHALE_DOMINATED:
        return chalk.magenta(regime);
      case MarketRegime.LOW_LIQUIDITY:
        return chalk.yellow(regime);
      default:
        return chalk.gray(regime);
    }
  }

  // ─── Wallet Flows ──────────────────────────────────────────────────

  /** Try to connect a wallet from a file path. Returns info on success, null on failure. */
  private tryConnectWallet(path: string): { address: string } | null {
    return tryConnectWalletFn(this.walletManager, path);
  }

  /** Blocking question prompt. */
  private ask(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(question, resolve);
    });
  }

  /**
   * Read a line of input with echo disabled.
   * Uses a temporary readline with no output to guarantee zero echo,
   * plus ANSI hide sequences as a belt-and-suspenders safeguard.
   */
  private readHidden(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.pause();

      // Remove any prior hidden-input listener to prevent accumulation
      if (this.hiddenInputListener) {
        process.stdin.removeListener('data', this.hiddenInputListener);
        this.hiddenInputListener = null;
      }

      process.stdout.write(prompt);

      // Read raw keystrokes — avoids readline race conditions with stdin ownership.
      // Accumulates characters until Enter, handles Backspace and Ctrl+C.
      const chunks: string[] = [];
      const wasRaw = process.stdin.isRaw;
      let resolved = false;

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();

      const cleanup = () => {
        if (this.hiddenInputListener) {
          process.stdin.removeListener('data', this.hiddenInputListener);
          this.hiddenInputListener = null;
        }
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(wasRaw ?? false);
        }
        this.rl.resume();
      };

      const onData = (buf: Buffer) => {
        if (resolved) return;
        for (const byte of buf) {
          if (byte === 0x0d || byte === 0x0a) {
            // Enter — done
            resolved = true;
            cleanup();
            process.stdout.write('\n');
            resolve(chunks.join('').trim());
            return;
          }
          if (byte === 0x03) {
            // Ctrl+C — cancel
            resolved = true;
            cleanup();
            process.stdout.write('\n');
            resolve('');
            return;
          }
          if (byte === 0x7f || byte === 0x08) {
            // Backspace
            chunks.pop();
          } else if (byte >= 0x20) {
            chunks.push(String.fromCharCode(byte));
          }
        }
      };

      this.hiddenInputListener = onData;
      process.stdin.on('data', onData);
    });
  }

  private async handleWalletImportFlow(store: WalletStore): Promise<string | null> {
    return handleWalletImportFlowFn(this.walletFlowDeps(), store);
  }

  private async handleWalletConnectFlow(): Promise<boolean> {
    return handleWalletConnectFlowFn(this.walletFlowDeps());
  }

  // ─── Wallet Disconnect (Mode-Locked) ──────────────────────────────

  private handleWalletDisconnected(): void {
    handleWalletDisconnectedFn();
  }

  private async handleWalletReconnected(): Promise<void> {
    const state = this.walletFlowState();
    await handleWalletReconnectedFn(this.walletFlowDeps(), state);
    this.applyWalletFlowState(state);
  }

  // ─── System Metrics ──────────────────────────────────────────────

  private async handleSystemMetrics(): Promise<void> {
    const lines: string[] = [''];

    // Health score
    const health = getHealth();
    if (health) {
      const snap = health.snapshot();
      const scoreColor = snap.healthScore >= 80 ? chalk.green : snap.healthScore >= 60 ? chalk.yellow : chalk.red;
      lines.push(chalk.bold('  SYSTEM HEALTH'));
      lines.push(`  Score:       ${scoreColor(String(snap.healthScore) + '/100')}`);
      lines.push(`  State:       ${snap.state}`);
      lines.push(`  Event Loop:  ${snap.eventLoopLagMs}ms`);
      lines.push(`  Memory RSS:  ${snap.memoryRssMB}MB`);
      lines.push(`  Error Rate:  ${snap.errorRate}/min`);
      lines.push(`  RPC Latency: ${snap.rpcLatencyMs}ms`);
      lines.push('');
    }

    // Runtime state
    const runtime = getRuntimeState();
    if (runtime) {
      const rs = runtime.snapshot();
      lines.push(chalk.bold('  RUNTIME STATE'));
      lines.push(`  State:       ${rs.state}`);
      lines.push(`  RPC Down:    ${rs.rpcDown}`);
      lines.push(`  Idle:        ${rs.idleDurationMs > 0 ? Math.round(rs.idleDurationMs / 1000) + 's' : 'no'}`);
      lines.push('');
    }

    // Scheduler
    const { getScheduler: getSched } = await import('../core/scheduler.js');
    const sched = getSched();
    if (sched) {
      const tasks = sched.status();
      lines.push(chalk.bold('  SCHEDULER'));
      lines.push(`  Tasks:       ${tasks.length}`);
      lines.push(`  Dropped:     ${sched.totalDroppedTicks}`);
      for (const t of tasks) {
        const state = t.suspended ? chalk.red('SUSPENDED') : chalk.green('ACTIVE');
        lines.push(`    ${chalk.dim(t.name.padEnd(25))} ${t.priority.padEnd(10)} ${state} ${chalk.dim(`${t.currentMs}ms`)}`);
      }
      lines.push('');
    }

    // Circuit breakers
    const { getAllBreakers } = await import('../core/circuit-breaker-service.js');
    const breakers = getAllBreakers();
    if (breakers.length > 0) {
      lines.push(chalk.bold('  CIRCUIT BREAKERS'));
      for (const cb of breakers) {
        const s = cb.snapshot();
        const stateColor = s.state === 'CLOSED' ? chalk.green : s.state === 'OPEN' ? chalk.red : chalk.yellow;
        lines.push(`    ${s.name.padEnd(20)} ${stateColor(s.state.padEnd(10))} failures: ${s.consecutiveFailures}/${s.totalFailures}`);
      }
      lines.push('');
    }

    // Retry budget
    const { getRetryBudgetUsage } = await import('../utils/retry.js');
    const budget = getRetryBudgetUsage();
    lines.push(chalk.bold('  RETRY BUDGET'));
    lines.push(`  Used:        ${budget.used}/${budget.max} ${budget.exhausted ? chalk.red('EXHAUSTED') : chalk.green('OK')}`);
    lines.push('');

    console.log(lines.join('\n'));
  }

  // ─── Update ─────────────────────────────────────────────────────

  /** Check for updates and install from within the terminal */
  private async handleUpdate(): Promise<void> {
    const { BUILD_INFO } = await import('../build-info.js');
    process.stdout.write('  Checking for updates...\r');

    try {
      const res = await fetch('https://registry.npmjs.org/bolt-terminal/latest', {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        console.log(chalk.yellow('  Could not reach npm registry.'));
        return;
      }
      const data = (await res.json()) as { version: string };
      if (data.version === BUILD_INFO.version) {
        console.log(`  Already up to date (v${BUILD_INFO.version}).     `);
        return;
      }

      console.log(`  Updating v${BUILD_INFO.version} → v${data.version}...     `);
      const { spawn } = await import('child_process');
      await new Promise<void>((resolveP, rejectP) => {
        const child = spawn('npm', ['install', '-g', 'bolt-terminal@latest'], {
          shell: false,
          stdio: 'inherit',
          timeout: 120_000,
        });
        child.on('close', (code) => {
          if (code === 0) resolveP();
          else rejectP(new Error(`npm install exited with code ${code}`));
        });
        child.on('error', rejectP);
      });

      console.log('');
      console.log(chalk.green(`  Updated to v${data.version}.`));
      console.log(chalk.dim('  Restart Flash Terminal to use the new version.'));
      console.log('');
    } catch (err) {
      console.log(chalk.red(`  Update failed: ${getErrorMessage(err)}`));
      console.log(chalk.dim('  Try manually: npm install -g bolt-terminal@latest'));
    }
  }

  // ─── RPC Management ──────────────────────────────────────────────

  /** Set primary RPC URL — switches active endpoint and persists */
  private async handleRpcSet(url: string): Promise<void> {
    if (!url) {
      console.log(chalk.yellow('  Usage: rpc set <url>'));
      return;
    }
    try {
      const { validateRpcUrl, saveConfigField } = await import('../config/index.js');
      const validUrl = validateRpcUrl(url);
      const { getRpcManagerInstance } = await import('../network/rpc-manager.js');
      const mgr = getRpcManagerInstance();
      if (!mgr) {
        console.log(chalk.red('  RPC manager not initialized.'));
        return;
      }
      // Add if not present, then switch to it
      mgr.addEndpoint(validUrl);
      mgr.switchTo(validUrl);
      // Persist as primary
      saveConfigField('rpc_url', validUrl);
      // Update config in memory
      this.config.rpcUrl = validUrl;
      const masked = validUrl.replace(/([?&])(api[-_]?key|key|token|secret)=([^&]+)/gi, (_, prefix, param, _val) => `${prefix}${param}=${'*'.repeat(8)}`);
      console.log(chalk.green(`\n  Primary RPC set to: ${masked}\n`));
    } catch (err) {
      console.log(chalk.red(`  Invalid RPC URL: ${getErrorMessage(err)}`));
    }
  }

  /** Add a backup RPC endpoint */
  private async handleRpcAdd(url: string): Promise<void> {
    if (!url) {
      console.log(chalk.yellow('  Usage: rpc add <url>'));
      return;
    }
    try {
      const { validateRpcUrl, saveConfigField } = await import('../config/index.js');
      const validUrl = validateRpcUrl(url);
      const { getRpcManagerInstance } = await import('../network/rpc-manager.js');
      const mgr = getRpcManagerInstance();
      if (!mgr) {
        console.log(chalk.red('  RPC manager not initialized.'));
        return;
      }
      const added = mgr.addEndpoint(validUrl);
      if (!added) {
        console.log(chalk.yellow('  Endpoint already configured.'));
        return;
      }
      // Persist backup URLs
      const currentBackups = this.config.backupRpcUrls ?? [];
      currentBackups.push(validUrl);
      this.config.backupRpcUrls = currentBackups;
      saveConfigField('backup_rpc_urls', currentBackups);
      const masked = validUrl.replace(/([?&])(api[-_]?key|key|token|secret)=([^&]+)/gi, (_, prefix, param, _val) => `${prefix}${param}=${'*'.repeat(8)}`);
      console.log(chalk.green(`\n  Backup RPC added: ${masked}`));
      console.log(chalk.dim(`  Total endpoints: ${mgr.totalEndpoints}\n`));
    } catch (err) {
      console.log(chalk.red(`  Invalid RPC URL: ${getErrorMessage(err)}`));
    }
  }

  /** Remove a backup RPC endpoint */
  private async handleRpcRemove(url: string): Promise<void> {
    if (!url) {
      console.log(chalk.yellow('  Usage: rpc remove <url>'));
      return;
    }
    const { getRpcManagerInstance } = await import('../network/rpc-manager.js');
    const mgr = getRpcManagerInstance();
    if (!mgr) {
      console.log(chalk.red('  RPC manager not initialized.'));
      return;
    }
    const active = mgr.activeEndpoint;
    if (active.url === url) {
      console.log(chalk.red('  Cannot remove the active endpoint. Switch to another first with: rpc set <url>'));
      return;
    }
    const removed = mgr.removeEndpoint(url);
    if (!removed) {
      console.log(chalk.yellow('  Endpoint not found.'));
      return;
    }
    // Update persisted backups
    const { saveConfigField } = await import('../config/index.js');
    const currentBackups = (this.config.backupRpcUrls ?? []).filter((u) => u !== url);
    this.config.backupRpcUrls = currentBackups;
    saveConfigField('backup_rpc_urls', currentBackups as unknown as string);
    console.log(chalk.green(`\n  Removed: ${url}`));
    console.log(chalk.dim(`  Remaining endpoints: ${mgr.totalEndpoints}\n`));
  }

  // ─── Prompt ────────────────────────────────────────────────────────

  /** Update prompt prefix based on current mode */
  private updatePrompt(): void {
    if (IS_AGENT) {
      // NO_DNA: minimal plain prompt — no colors, no decorations
      this.rl.setPrompt('');
      return;
    }
    const prefix =
      this.config.tradingMode === 'magic'
        ? theme.accent('flash') + chalk.magenta(' [magic]')
        : this.config.tradingMode === 'live'
          ? theme.negative('flash') + theme.dim(' [live]')
          : theme.warning('flash') + theme.dim(' [sim]');
    this.rl.setPrompt(`${prefix} ${theme.accent('>')} `);
  }

  // ─── History ───────────────────────────────────────────────────────

  /** Load command history from file */
  private loadHistory(): void {
    try {
      const data = readFileSync(HISTORY_FILE, 'utf-8');
      const lines = data.split('\n').filter(Boolean).slice(-MAX_HISTORY);
      const rlAny = this.rl as unknown as { history: string[] };
      if (Array.isArray(rlAny.history)) {
        rlAny.history = lines.reverse();
      }
    } catch {
      // No history file yet
    }
  }

  // [M-7] Sensitive command patterns — scrubbed from history file to prevent info leak
  private static readonly SENSITIVE_HISTORY_PATTERN =
    /^(wallet\s+(import|connect)\s|open\s|close\s|add\s+collateral|remove\s+collateral)/i;

  /** Save command history to file — scrubs sensitive trade/wallet commands */
  private saveHistory(): void {
    try {
      const rlAny = this.rl as unknown as { history: string[] };
      if (Array.isArray(rlAny.history)) {
        const lines = [...rlAny.history]
          .filter((line) => !FlashTerminal.SENSITIVE_HISTORY_PATTERN.test(line))
          .reverse()
          .slice(-MAX_HISTORY);
        writeFileSync(HISTORY_FILE, lines.join('\n') + '\n', { mode: 0o600 });
      }
    } catch {
      // Best-effort
    }
  }

  // ─── Shutdown ──────────────────────────────────────────────────────

  private isShuttingDown = false;

  private shutdown(): void {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    const logger = getLogger();
    logger.info('SHUTDOWN', 'Graceful shutdown initiated', {
      mode: this.config.simulationMode ? 'simulation' : 'live',
      uptime: Math.floor(process.uptime()),
    });

    this.saveHistory();
    try {
      // Flush price history to disk so 24h change persists across restarts
      new PriceService().flushHistory();
    } catch {
      // Best-effort cleanup
    }
    try {
      if (this.statusBar) this.statusBar.stop();
    } catch {
      // Best-effort cleanup
    }
    try {
      const reconciler = getReconciler();
      if (reconciler) reconciler.stop();
    } catch {
      // Best-effort cleanup
    }
    try {
      shutdownPlugins().catch(() => {});
    } catch {
      // Best-effort cleanup
    }
    try {
      shutdownStateSnapshot();
    } catch {
      // Best-effort cleanup
    }
    try {
      shutdownStateCache();
    } catch {
      // Best-effort cleanup
    }
    try {
      shutdownTpuClient();
    } catch {
      // Best-effort cleanup
    }
    try {
      shutdownUltraTxEngine();
    } catch {
      // Best-effort cleanup
    }
    try {
      if (this.degradedCheckTimer) {
        clearInterval(this.degradedCheckTimer);
        this.degradedCheckTimer = null;
      }
      this.rpcManager?.stopMonitoring();
    } catch {
      // Best-effort cleanup
    }
    try {
      if (this.maintenance) this.maintenance.stop();
    } catch {
      // Best-effort cleanup
    }
    try {
      shutdownHealth();
    } catch {
      // Best-effort cleanup
    }
    try {
      shutdownScheduler();
    } catch {
      // Best-effort cleanup
    }
    try {
      shutdownRuntimeState();
    } catch {
      // Best-effort cleanup
    }
    // TP/SL and limit orders are on-chain — no local engine cleanup needed.
    try {
      if (this.flashClient && 'stopBlockhashRefresh' in this.flashClient) {
        (this.flashClient as { stopBlockhashRefresh: () => void }).stopBlockhashRefresh();
      }
    } catch {
      // Best-effort cleanup
    }
    // Flush shutdown log synchronously before exit
    logger.flushSync('SHUTDOWN', 'Shutdown complete', {
      uptime: Math.floor(process.uptime()),
    });

    console.log(chalk.dim('\n  Goodbye.\n'));
    this.rl.close();
    process.exit(0);
  }

  // ─── Command Handler ──────────────────────────────────────────────

  private async handleInput(rawInput: string): Promise<void> {
    // M14: Reject trade commands during wallet rebuild
    if (this.walletRebuilding) {
      console.log(chalk.dim('  Wallet reconnecting, please wait...'));
      return;
    }

    // Signal user activity to runtime state machine
    getRuntimeState()?.markActive();

    // ── Backpressure: throttle rapid-fire commands ──
    const throttle = this.commandThrottle.check();
    if (!throttle.allowed) {
      console.log(chalk.dim(`  ${throttle.reason}`));
      return;
    }

    // ── Extract global flags (--format json, --key <wallet>) ──
    const flags = extractFlags(rawInput);
    const input = normalizeInput(flags.cleanInput);
    if (!input) return;

    const lower = input.toLowerCase();


    // ─── Update Command ──────────────────────────────────────────
    if (lower === 'update' || lower === 'flash update') {
      await this.handleUpdate();
      return;
    }

    // ─── System Metrics ──────────────────────────────────────────
    if (lower === 'system metrics' || lower === 'sysmetrics') {
      await this.handleSystemMetrics();
      return;
    }

    // ─── Doctor Diagnostic Intercept ───────────────────────────────
    // ─── Session Metrics ──────────────────────────────────────
    if (lower === 'metrics' || lower === 'flash metrics' || lower === 'session metrics') {
      try {
        const { getSessionMetrics } = await import('../core/session-metrics.js');
        const m = getSessionMetrics();
        const stats = m.getStats();

        if (IS_AGENT || flags.jsonOutput) {
          const payload = { action: 'metrics', ...stats, uptime: m.getUptime(), cache_hit_rate: m.getCacheHitRate() };
          if (IS_AGENT) agentOutput(payload);
          else console.log(JSON.stringify(payload, null, 2));
          return;
        }

        console.log('');
        console.log(`  ${theme.accentBold('SESSION METRICS')}`);
        console.log(`  ${theme.separator(45)}`);
        console.log('');
        console.log(theme.pair('Uptime', m.getUptime()));
        console.log(theme.pair('Commands', `${stats.commandCount} (${stats.errorCount} errors)`));
        console.log(theme.pair('Avg Latency', `${stats.avgLatencyMs}ms`));
        console.log(theme.pair('Peak Latency', `${stats.peakLatencyMs}ms`));
        console.log(theme.pair('Cache Hit Rate', `${m.getCacheHitRate()}%`));
        console.log(theme.pair('RPC Requests', `${stats.rpcRequests} (${stats.rpcFailures} failed)`));
        console.log(theme.pair('TX Submitted', `${stats.txSubmitted} (${stats.txConfirmed} confirmed)`));
        console.log('');
      } catch {
        console.log(chalk.dim('  Metrics not available.'));
      }
      return;
    }

    if (lower === 'system health' || lower === 'sys health' || lower === 'runtime' || lower === 'system health --history') {
      const h = getHealth();
      if (!h) {
        console.log(chalk.dim('  Health monitor not initialized.'));
      } else {
        const snap = h.snapshot();
        const stateColor = snap.state === 'HEALTHY' ? chalk.green : snap.state === 'DEGRADED' ? chalk.yellow : chalk.red;
        console.log('');
        console.log(`  ${theme.accentBold('System Health')}`);
        console.log(`  ${theme.separator(45)}`);
        console.log(`  State:          ${stateColor(snap.state)} (${snap.stateAge}s in this state)`);
        console.log(`  Event Loop Lag: ${snap.eventLoopLagMs}ms`);
        console.log(`  Memory RSS:     ${snap.memoryRssMB}MB`);
        console.log(`  Heap Used:      ${snap.heapUsedMB}MB`);
        console.log(`  Error Rate:     ${snap.errorRate}/min`);
        console.log(`  RPC Latency:    ${snap.rpcLatencyMs}ms`);
        console.log(`  Uptime:         ${Math.floor(snap.uptimeSeconds / 60)}m ${snap.uptimeSeconds % 60}s`);

        // Root cause
        if (snap.primaryCause !== 'none') {
          console.log('');
          console.log(`  ${theme.accentBold('Root Cause')}`);
          console.log(`  Primary:        ${chalk.yellow(snap.primaryCause.replace(/_/g, ' '))}`);
          for (const c of snap.causes) {
            const icon = c.severity === 'critical' ? chalk.red('●') : chalk.yellow('▲');
            console.log(`  ${icon} ${c.label}`);
          }
        }

        // Degradation params
        const params = h.getDegradationParams();
        if (snap.state !== 'HEALTHY') {
          console.log('');
          console.log(`  ${theme.accentBold('Adaptive Response')}`);
          console.log(`  Scan Freq:      ${params.scanIntervalMultiplier}x slower`);
          console.log(`  Concurrency:    max ${params.maxConcurrency}`);
          console.log(`  Trade Threshold: ${params.tradeThresholdMultiplier}x stricter`);
          console.log(`  Retry Delay:    ${params.retryDelayMultiplier}x slower`);
          if (params.tradesBlocked) console.log(`  Trades:         ${chalk.red('BLOCKED')}`);
        }

        // Retry budget
        const { getRetryBudgetUsage } = await import('../utils/retry.js');
        const budget = getRetryBudgetUsage();
        console.log('');
        console.log(`  Retry Budget:   ${budget.used}/${budget.max}${budget.exhausted ? chalk.red(' EXHAUSTED') : ''}`);

        // History (if --history flag or always show trends)
        const history = h.getHistory();
        if (history.sampleCount > 0) {
          const trendIcon = (t: string) => t === 'rising' ? chalk.red('↑') : t === 'falling' ? chalk.green('↓') : chalk.dim('→');
          console.log('');
          console.log(`  ${theme.accentBold('Trends')}  (${history.sampleCount} samples)`);
          console.log(`  Lag:    ${trendIcon(history.trends.lag)} ${history.trends.lag}  (5m: ${history.avg5m.lagMs}ms → 15m: ${history.avg15m.lagMs}ms)`);
          console.log(`  Memory: ${trendIcon(history.trends.memory)} ${history.trends.memory}  (5m: ${history.avg5m.rssMB}MB → 15m: ${history.avg15m.rssMB}MB)`);
          console.log(`  Errors: ${trendIcon(history.trends.errors)} ${history.trends.errors}  (5m: ${history.avg5m.errorRate}/min → 15m: ${history.avg15m.errorRate}/min)`);

          // Show 60m averages if we have enough data
          if (lower.includes('--history') && history.sampleCount >= 20) {
            console.log('');
            console.log(`  ${theme.accentBold('60m Averages')}`);
            console.log(`  Lag: ${history.avg60m.lagMs}ms | RSS: ${history.avg60m.rssMB}MB | Errors: ${history.avg60m.errorRate}/min | RPC: ${history.avg60m.rpcLatencyMs}ms`);
          }
        }
        console.log('');
      }
      return;
    }

    if (lower === 'doctor' || lower === 'flash doctor' || lower === 'health' || lower === 'flash health') {
      if (flags.jsonOutput) {
        enableStructuredOutput();
        const output = await runDoctor(this.flashClient, this.rpcManager, this.walletManager, this.context);
        restoreOutputMode();
        // Doctor returns formatted text — wrap as data
        // eslint-disable-next-line no-control-regex
        const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, '').trim();
        console.log(jsonStringify(jsonSuccess('doctor', { report: cleanOutput })));
      } else {
        const output = await runDoctor(this.flashClient, this.rpcManager, this.walletManager, this.context);
        console.log(output);
      }
      return;
    }

    // ─── Template Commands ────────────────────────────────────
    if (lower.startsWith('template ') && lower !== 'template') {
      const match = input.match(/^template\s+(\S+)\s*=\s*(.+)$/i);
      if (match) {
        const { setTemplate } = await import('./trade-templates.js');
        const ok = setTemplate(match[1], match[2].trim());
        if (flags.jsonOutput) {
          console.log(jsonStringify(ok
            ? jsonSuccess('template_set', { name: match[1], command: match[2].trim() })
            : jsonError('template_set', ErrorCode.INVALID_PARAMETERS, 'Too many templates (max 100)', { name: match[1] })));
        } else if (ok) {
          console.log(chalk.green(`  Template set: ${match[1]} → ${match[2].trim()}`));
        } else {
          console.log(chalk.red('  Too many templates (max 100).'));
        }
      } else {
        if (flags.jsonOutput) {
          console.log(jsonStringify(jsonError('template_set', ErrorCode.INVALID_PARAMETERS, 'Usage: template <name> = <command>')));
        } else {
          console.log(chalk.dim('  Usage: template <name> = <command>'));
          console.log(chalk.dim('  Example: template scalp = long sol 3x 50 tp 2% sl 1%'));
        }
      }
      return;
    }
    if (lower === 'templates') {
      const { getAllTemplates } = await import('./trade-templates.js');
      const templates = getAllTemplates();
      if (flags.jsonOutput) {
        console.log(jsonStringify(jsonSuccess('templates', { templates })));
      } else {
        const entries = Object.entries(templates);
        if (entries.length === 0) {
          console.log(chalk.dim('  No templates. Use "template <name> = <command>" to create one.'));
        } else {
          console.log('');
          for (const [k, v] of entries.sort()) {
            console.log(`  ${chalk.cyan(k.padEnd(16))} → ${v}`);
          }
          console.log('');
        }
      }
      return;
    }
    if (lower.startsWith('untemplate ')) {
      const name = input.slice(11).trim();
      const { removeTemplate } = await import('./trade-templates.js');
      const ok = removeTemplate(name);
      if (flags.jsonOutput) {
        console.log(jsonStringify(ok
          ? jsonSuccess('template_remove', { name })
          : jsonError('template_remove', ErrorCode.COMMAND_NOT_FOUND, `Template not found: ${name}`, { name })));
      } else if (ok) {
        console.log(chalk.green(`  Template removed: ${name}`));
      } else {
        console.log(chalk.yellow(`  Template not found: ${name}`));
      }
      return;
    }

    // ─── Alias Commands ────────────────────────────────────────
    if (lower.startsWith('alias ') && lower !== 'alias') {
      const match = input.match(/^alias\s+(\S+)\s*=\s*(.+)$/i);
      if (match) {
        const { setAlias } = await import('./learned-aliases.js');
        const ok = setAlias(match[1], match[2].trim());
        if (flags.jsonOutput) {
          console.log(jsonStringify(ok
            ? jsonSuccess('alias_set', { name: match[1], expansion: match[2].trim() })
            : jsonError('alias_set', ErrorCode.INVALID_PARAMETERS, 'Too many aliases (max 200)', { name: match[1] })));
        } else if (ok) {
          console.log(chalk.green(`  Alias set: ${match[1]} → ${match[2].trim()}`));
        } else {
          console.log(chalk.red('  Too many aliases (max 200).'));
        }
      } else {
        if (flags.jsonOutput) {
          console.log(jsonStringify(jsonError('alias_set', ErrorCode.INVALID_PARAMETERS, 'Usage: alias <shortcut> = <expansion>')));
        } else {
          console.log(chalk.dim('  Usage: alias <shortcut> = <expansion>'));
          console.log(chalk.dim('  Example: alias lsol = long sol'));
        }
      }
      return;
    }
    if (lower === 'aliases') {
      const { getAllAliases } = await import('./learned-aliases.js');
      const aliases = getAllAliases();
      if (flags.jsonOutput) {
        console.log(jsonStringify(jsonSuccess('aliases', { aliases })));
      } else {
        const entries = Object.entries(aliases);
        if (entries.length === 0) {
          console.log(chalk.dim('  No custom aliases. Use "alias <shortcut> = <expansion>" to add one.'));
        } else {
          console.log('');
          for (const [k, v] of entries.sort()) {
            console.log(`  ${chalk.cyan(k.padEnd(16))} → ${v}`);
          }
          console.log('');
        }
      }
      return;
    }
    if (lower.startsWith('unalias ')) {
      const name = input.slice(8).trim();
      const { removeAlias } = await import('./learned-aliases.js');
      const ok = removeAlias(name);
      if (flags.jsonOutput) {
        console.log(jsonStringify(ok
          ? jsonSuccess('alias_remove', { name })
          : jsonError('alias_remove', ErrorCode.COMMAND_NOT_FOUND, `Alias not found: ${name}`, { name })));
      } else if (ok) {
        console.log(chalk.green(`  Alias removed: ${name}`));
      } else {
        console.log(chalk.yellow(`  Alias not found: ${name}`));
      }
      return;
    }

    // ─── Degen Mode Toggle ──────────────────────────────────────
    if (
      lower === 'degen' ||
      lower === 'degen mode' ||
      lower === 'degen on' ||
      lower === 'degen off' ||
      lower === 'degen toggle'
    ) {
      if (lower === 'degen off') {
        this.context.degenMode = false;
      } else if (lower === 'degen on') {
        this.context.degenMode = true;
      } else {
        this.context.degenMode = !this.context.degenMode;
      }

      if (flags.jsonOutput) {
        const degenData: Record<string, unknown> = { enabled: this.context.degenMode };
        if (this.context.degenMode) {
          const { hasDegenMode: hasDegen, getMaxLeverage: getMaxLev, getAllMarkets: getAll } = await import('../config/index.js');
          const degenMarkets = getAll().filter((m) => hasDegen(m));
          degenData.degen_markets = degenMarkets.map((m) => ({ market: m, max_leverage: getMaxLev(m, true) }));
          const highLevMarkets = getAll().filter((m) => !hasDegen(m) && getMaxLev(m, false) >= 200);
          degenData.high_leverage_markets = highLevMarkets.map((m) => ({ market: m, max_leverage: getMaxLev(m, false) }));
        }
        console.log(jsonStringify(jsonSuccess('degen', degenData)));
        return;
      }

      if (this.context.degenMode) {
        // Show per-market leverage from protocol config
        const { hasDegenMode: hasDegen, getMaxLeverage: getMaxLev } = await import('../config/index.js');
        const { getAllMarkets: getAll } = await import('../config/index.js');
        // Degen-extended markets (SOL/BTC/ETH: 100x → 500x)
        const degenMarkets = getAll().filter((m) => hasDegen(m));
        const degenInfo = degenMarkets.map((m) => `${m} ${getMaxLev(m, true)}x`).join(', ');
        // High-leverage markets that already have ≥200x as standard (forex pairs)
        const highLevMarkets = getAll().filter((m) => !hasDegen(m) && getMaxLev(m, false) >= 200);
        const highLevInfo = highLevMarkets.map((m) => `${m} ${getMaxLev(m, false)}x`).join(', ');
        console.log('');
        console.log(chalk.red.bold('  ⚡ DEGEN MODE ENABLED'));
        if (degenInfo) {
          console.log(chalk.yellow(`  Degen markets: ${degenInfo}`));
        }
        if (highLevInfo) {
          console.log(chalk.yellow(`  High leverage: ${highLevInfo}`));
        }
        if (!degenInfo && !highLevInfo) {
          console.log(chalk.yellow('  No markets have extended leverage beyond standard limits.'));
        }
        console.log(chalk.dim('  Type "degen off" to disable'));
        console.log('');
      } else {
        console.log('');
        console.log(chalk.green('  Degen mode disabled — standard leverage limits active'));
        console.log('');
      }
      return;
    }

    // Per-category help: `help trading`, `help earn`, `help wallet`, etc.
    if (lower.startsWith('help ') && lower !== 'help') {
      const arg = input.slice(5).trim();
      const { resolveCategory, getCommandsByCategory } = await import('./command-registry.js');
      const category = resolveCategory(arg);
      if (category) {
        if (flags.jsonOutput) {
          const categories = getCommandsByCategory();
          const entries = (categories.get(category) || []).map((e) => ({
            name: e.name,
            description: e.description,
            format: e.helpFormat || e.name,
          }));
          console.log(jsonStringify(jsonSuccess('help', { category, commands: entries })));
          return;
        }
        const categories = getCommandsByCategory();
        const entries = categories.get(category) || [];
        const COL_WIDTH = 32;
        const lines = [
          '',
          `  ${theme.accentBold('FLASH TERMINAL')}  ${theme.dim(`— ${category}`)}`,
          `  ${theme.separator(52)}`,
          '',
        ];
        if (entries.length === 0) {
          lines.push(`  ${theme.dim('No commands in this category.')}`);
        } else {
          for (const entry of entries) {
            const label = entry.helpFormat || entry.name;
            const padded = label.padEnd(COL_WIDTH);
            lines.push(`    ${theme.command(padded)}${entry.description}`);
          }
        }
        lines.push('');
        lines.push(`  ${theme.separator(52)}`);
        lines.push(
          `  ${theme.dim('Type')} ${theme.command('help <command>')} ${theme.dim('for detailed usage, e.g.')} ${theme.command('help open')}`,
        );
        lines.push(`  ${theme.dim('Type')} ${theme.command('help')} ${theme.dim('for overview of all categories')}`);
        lines.push('');
        console.log(lines.join('\n'));
        return;
      }
    }

    // Per-command help: `help <command>` or `help long`, `help positions`, etc.
    if (lower.startsWith('help ') && lower !== 'help') {
      const cmdName = input.slice(5).trim();
      try {
        const { getCommandHelp } = await import('./command-help.js');
        const helpText = getCommandHelp(cmdName);
        if (helpText) {
          if (flags.jsonOutput) {
            // eslint-disable-next-line no-control-regex
            const cleanHelp = helpText.replace(/\x1b\[[0-9;]*m/g, '').trim();
            console.log(jsonStringify(jsonSuccess('help', { command: cmdName, help: cleanHelp })));
          } else {
            console.log(helpText);
          }
          return;
        }
      } catch {
        // command-help module not available — fall through to normal dispatch
      }
    }

    // Magic-mode commands — intercepted before FAST_DISPATCH since they're tri-mode
    // gated, not part of the general intent grammar.
    if (lower === 'magic' || lower.startsWith('magic ')) {
      if (this.config.tradingMode !== 'magic') {
        console.log('');
        console.log(chalk.yellow('  `magic` commands require MAGIC TRADING mode. Current mode: ' + this.config.tradingMode));
        console.log(chalk.dim('  Switch modes via TRADING_MODE env var or restart and select option 3.'));
        console.log('');
        return;
      }
      // Use the original (case-preserving) input for arg extraction. Base58 mint
      // pubkeys lose meaning if lowercased — `EPjFW…` ≠ `epjfw…`.
      const trimmed = input.trim();
      const raw = trimmed.toLowerCase() === 'magic' ? 'inspect' : trimmed.slice(6).trim();
      const parts = raw.split(/\s+/);
      const sub = (parts[0] ?? 'inspect').toLowerCase();
      const resolved = (() => {
        switch (sub) {
          case 'inspect':
          case '':
            return { tool: 'magicInspect', params: {} };
          case 'portfolio':
            return { tool: 'magicPortfolio', params: {} };
          case 'verify':
          case 'parity':
            return { tool: 'magicVerify', params: {} };
          case 'price': {
            if (parts.length < 2) return { error: 'usage: magic price <symbol>' };
            return { tool: 'magicPrice', params: { market: parts[1] } };
          }
          case 'markets':
            return { tool: 'magicMarkets', params: {} };
          case 'delegation':
          case 'delegated':
            return { tool: 'magicDelegation', params: {} };
          case 'status':
            return { tool: 'magicStatus', params: {} };
          case 'faucet':
            return { tool: 'magicFaucet', params: {} };
          case 'setup':
            return { tool: 'magicSetup', params: {} };
          case 'deposit': {
            // magic deposit <symbol-or-mint> <amount> (human units)
            if (parts.length < 3) return { error: 'usage: magic deposit <symbol|mint> <amount>  (e.g. `magic deposit USDC 50`)' };
            const amount = Number(parts[2]);
            if (!Number.isFinite(amount) || amount <= 0) return { error: `amount must be a positive number (got '${parts[2]}')` };
            return { tool: 'magicDeposit', params: { token: parts[1], amount } };
          }
          case 'withdraw': {
            // magic withdraw <symbol-or-mint> <amount> (human units)
            if (parts.length < 3) return { error: 'usage: magic withdraw <symbol|mint> <amount>  (e.g. `magic withdraw USDC 50`)' };
            const amount = Number(parts[2]);
            if (!Number.isFinite(amount) || amount <= 0) return { error: `amount must be a positive number (got '${parts[2]}')` };
            return { tool: 'magicWithdraw', params: { token: parts[1], amount } };
          }
          case 'open': {
            // magic open <symbol> <long|short> <collateralUsd> <leverage> [collateralToken]
            if (parts.length < 5) return { error: 'usage: magic open <symbol> <long|short> <collateral_usd> <leverage> [collateralToken]' };
            const side = parts[2];
            if (side !== 'long' && side !== 'short') return { error: `side must be 'long' or 'short' (got '${side}')` };
            const collateral = Number(parts[3]);
            const leverage = Number(parts[4]);
            if (!Number.isFinite(collateral) || collateral <= 0) return { error: `collateral must be a positive number (got '${parts[3]}')` };
            if (!Number.isFinite(leverage) || leverage <= 0) return { error: `leverage must be a positive number (got '${parts[4]}')` };
            return {
              tool: 'magicOpen',
              params: {
                market: parts[1],
                side,
                collateral,
                leverage,
                ...(parts[5] ? { collateralToken: parts[5] } : {}),
              },
            };
          }
          case 'close': {
            // magic close <symbol> <long|short> [receiveToken]
            if (parts.length < 3) return { error: 'usage: magic close <symbol> <long|short> [receiveToken]' };
            const side = parts[2];
            if (side !== 'long' && side !== 'short') return { error: `side must be 'long' or 'short' (got '${side}')` };
            return {
              tool: 'magicClose',
              params: {
                market: parts[1],
                side,
                ...(parts[3] ? { receiveToken: parts[3] } : {}),
              },
            };
          }
          case 'add':
          case 'add-collateral': {
            // magic add <symbol> <long|short> <amountUsd>
            if (parts.length < 4) return { error: 'usage: magic add <symbol> <long|short> <amount_usd>' };
            const side = parts[2];
            if (side !== 'long' && side !== 'short') return { error: `side must be 'long' or 'short' (got '${side}')` };
            const amount = Number(parts[3]);
            if (!Number.isFinite(amount) || amount <= 0) return { error: `amount must be a positive number (got '${parts[3]}')` };
            return { tool: 'magicAddCollateral', params: { market: parts[1], side, amount } };
          }
          case 'remove':
          case 'remove-collateral': {
            // magic remove <symbol> <long|short> <amountUsd>
            if (parts.length < 4) return { error: 'usage: magic remove <symbol> <long|short> <amount_usd>' };
            const side = parts[2];
            if (side !== 'long' && side !== 'short') return { error: `side must be 'long' or 'short' (got '${side}')` };
            const amount = Number(parts[3]);
            if (!Number.isFinite(amount) || amount <= 0) return { error: `amount must be a positive number (got '${parts[3]}')` };
            return { tool: 'magicRemoveCollateral', params: { market: parts[1], side, amount } };
          }
          case 'session': {
            return {
              error:
                'session keys removed — CLI signs trades directly from your wallet keypair file (sub-ms, no popup needed). ' +
                'No setup required; just run `magic open <symbol> <side> <collateral> <leverage>`.',
            };
          }
          default:
            return { error: null };
        }
      })();
      if (!('tool' in resolved)) {
        console.log('');
        if (resolved.error) {
          console.log(chalk.yellow(`  ${resolved.error}`));
        } else {
          console.log(chalk.yellow(`  Unknown magic subcommand: "${sub}"`));
          console.log(chalk.dim('  Available:'));
          console.log(chalk.dim('    magic inspect                        — enumerate pools/markets/custodies'));
          console.log(chalk.dim('    magic status                         — wallet preflight (SOL, UDL, basket)'));
          console.log(chalk.dim('    magic portfolio                      — your positions + balance'));
          console.log(chalk.dim('    magic verify                         — confirm CLI/UI parity (same on-chain accounts)'));
          console.log(chalk.dim('    magic markets                        — list Market pubkeys'));
          console.log(chalk.dim('    magic delegation                     — basket delegation status'));
          console.log(chalk.dim('    magic faucet                         — where to get devnet SOL + stable tokens'));
          console.log(chalk.dim('    magic setup                          — init UDL + basket + delegate (idempotent)'));
          console.log(chalk.dim('    magic deposit <symbol|mint> <amount>  — deposit to vault  (e.g. `magic deposit USDC 50`)'));
          console.log(chalk.dim('    magic withdraw <symbol|mint> <amount> — withdraw from vault'));
          console.log(chalk.dim('    magic open <symbol> <long|short> <collateral_usd> <leverage> [collateralToken]'));
          console.log(chalk.dim('    magic close <symbol> <long|short> [receiveToken]'));
          console.log(chalk.dim('    magic add <symbol> <long|short> <amount_usd>      — add collateral'));
          console.log(chalk.dim('    magic remove <symbol> <long|short> <amount_usd>   — remove collateral'));
        }
        console.log('');
        return;
      }
      try {
        const result = await this.engine.executeTool(resolved.tool!, resolved.params!);
        console.log(result.message);
      } catch (err) {
        console.log(chalk.red(`  magic error: ${(err as Error).message}`));
      }
      return;
    }

    // Fast dispatch for single-token commands
    let intent: ParsedIntent;
    const fastIntent = FAST_DISPATCH[lower];

    if (fastIntent) {
      intent = fastIntent;
    } else if (/^set\s+(tp|sl)\b/.test(lower)) {
      // Set TP/SL — parse via interpreter, show usage on failure
      const parsed = localParse(input);
      if (parsed && parsed.action === ActionType.SetTpSl) {
        intent = parsed;
      } else {
        if (flags.jsonOutput) {
          console.log(jsonStringify(jsonError('set_tp_sl', ErrorCode.PARSE_ERROR, 'Invalid TP/SL syntax', { input, usage: 'set tp SOL long $95' })));
        } else {
          console.log('');
          console.log(chalk.yellow('  Invalid TP/SL syntax.'));
          console.log('');
          console.log(chalk.dim('  Usage:'));
          console.log(`    ${chalk.bold('set tp SOL long $95')}`);
          console.log(`    ${chalk.bold('set sl SOL long $80')}`);
          console.log(`    ${chalk.bold('set tp btc long to 75000')}`);
          console.log('');
        }
        return;
      }
    } else if (lower.startsWith('edit limit')) {
      // Edit limit order — parse via interpreter
      const parsed = localParse(input);
      if (parsed && parsed.action === ActionType.EditLimitOrder) {
        intent = parsed;
      } else {
        if (flags.jsonOutput) {
          console.log(jsonStringify(jsonError('edit_limit_order', ErrorCode.PARSE_ERROR, 'Invalid edit limit syntax', { input, usage: 'edit limit <id> $<price>' })));
        } else {
          console.log('');
          console.log(chalk.yellow('  Invalid edit limit syntax.'));
          console.log(chalk.dim('  Usage: edit limit <id> $<price>'));
          console.log(chalk.dim('  Example: edit limit 0 $85'));
          console.log('');
        }
        return;
      }
    } else if (lower.startsWith('limit')) {
      // Limit order — parse via interpreter, show usage on failure
      const parsed = localParse(input);
      if (parsed && parsed.action === ActionType.LimitOrder) {
        intent = parsed;
      } else {
        if (flags.jsonOutput) {
          console.log(jsonStringify(jsonError('limit_order', ErrorCode.PARSE_ERROR, 'Invalid limit order syntax', { input, usage: 'limit long SOL 2x $100 @ $82' })));
        } else {
          console.log('');
          console.log(chalk.yellow('  Invalid limit order syntax.'));
          console.log('');
          console.log(chalk.dim('  Usage:'));
          console.log(`    ${chalk.bold('limit long SOL 2x $100 @ $82')}`);
          console.log(`    ${chalk.bold('limit short BTC 3x $200 at $72000')}`);
          console.log(`    ${chalk.bold('limit order sol 2x for 10 dollars long at 82')}`);
          console.log('');
          console.log(chalk.dim('  Required: side (long/short), market, leverage (Nx), collateral ($), price (@ or at)'));
          console.log('');
        }
        return;
      }
    } else if (lower.startsWith('position debug ') || lower.startsWith('pos debug ')) {
      const prefix = lower.startsWith('position debug ') ? 'position debug ' : 'pos debug ';
      const rawMarket = input.slice(prefix.length).trim();
      if (!rawMarket) {
        if (flags.jsonOutput) {
          console.log(jsonStringify(jsonError('position_debug', ErrorCode.INVALID_PARAMETERS, 'Usage: position debug <market>')));
        } else {
          console.log(chalk.yellow(`  Usage: position debug <market>`));
          console.log(chalk.dim(`  Example: position debug sol`));
        }
        return;
      }
      const market = resolveMarketAlias(rawMarket);
      await this.handlePositionDebug(market);
      return;
    } else if (lower.startsWith('dryrun ') || lower.startsWith('dry-run ') || lower.startsWith('dry run ')) {
      const prefix = lower.startsWith('dryrun ') ? 'dryrun ' : lower.startsWith('dry-run ') ? 'dry-run ' : 'dry run ';
      const innerCmd = input.slice(prefix.length).trim();
      intent = { action: ActionType.DryRun, innerCommand: innerCmd } as ParsedIntent;
    } else if (lower.startsWith('analyze ') || lower.startsWith('analyse ')) {
      const prefix = lower.startsWith('analyze ') ? 'analyze ' : 'analyse ';
      const rawMarket = input.slice(prefix.length).trim();
      const market = resolveMarketAlias(rawMarket);
      intent = { action: ActionType.Analyze, market } as ParsedIntent;
    } else if (lower.startsWith('liquidations ') || lower.startsWith('liquidation ')) {
      const prefix = lower.startsWith('liquidations ') ? 'liquidations ' : 'liquidation ';
      const rawMarket = input.slice(prefix.length).trim();
      const market = resolveMarketAlias(rawMarket);
      intent = { action: ActionType.LiquidationMap, market } as ParsedIntent;
    } else if (lower.startsWith('funding ')) {
      const rawMarket = input.slice('funding '.length).trim();
      const market = resolveMarketAlias(rawMarket);
      intent = { action: ActionType.FundingDashboard, market } as ParsedIntent;
    } else if (lower.startsWith('depth ')) {
      const rawMarket = input.slice('depth '.length).trim();
      const market = resolveMarketAlias(rawMarket);
      intent = { action: ActionType.LiquidityDepth, market } as ParsedIntent;
    } else if (lower.startsWith('monitor ') || lower.startsWith('market monitor ')) {
      // Any monitor subcommand is no longer supported — only bare "monitor" works
      if (flags.jsonOutput) {
        console.log(jsonStringify(jsonError('monitor', ErrorCode.COMMAND_NOT_FOUND, 'Unknown monitor subcommand. Use bare "monitor" command.')));
      } else {
        console.log(theme.dim('\n  Unknown command.\n'));
      }
      return;
    } else if (lower.startsWith('rpc set ')) {
      const url = input.slice('rpc set '.length).trim();
      await this.handleRpcSet(url);
      return;
    } else if (lower.startsWith('rpc add ')) {
      const url = input.slice('rpc add '.length).trim();
      await this.handleRpcAdd(url);
      return;
    } else if (lower.startsWith('rpc remove ')) {
      const url = input.slice('rpc remove '.length).trim();
      await this.handleRpcRemove(url);
      return;
    } else if (lower === 'inspect pool' || lower.startsWith('inspect pool ')) {
      const poolInput = lower === 'inspect pool' ? '' : input.slice('inspect pool '.length).trim();
      const { POOL_NAMES } = await import('../config/index.js');
      if (!poolInput) {
        const uniqueNames = [...new Set(POOL_NAMES)];
        if (flags.jsonOutput) {
          console.log(jsonStringify(jsonError('inspect_pool', ErrorCode.INVALID_PARAMETERS, 'Usage: inspect pool <name>', { available_pools: uniqueNames })));
        } else {
          console.log(chalk.yellow(`  Usage: inspect pool <name>`));
          console.log(chalk.dim(`  Available pools: ${uniqueNames.join(', ')}`));
        }
        return;
      }
      const pool = POOL_NAMES.find((p: string) => p.toLowerCase() === poolInput.toLowerCase());
      if (!pool) {
        const uniqueNames = [...new Set(POOL_NAMES)];
        if (flags.jsonOutput) {
          console.log(jsonStringify(jsonError('inspect_pool', ErrorCode.POOL_NOT_FOUND, `Unknown pool: ${poolInput}`, { input: poolInput, valid_pools: uniqueNames })));
        } else {
          console.log(chalk.red(`  Unknown pool: ${poolInput}`));
          console.log(chalk.dim(`  Valid pools: ${uniqueNames.join(', ')}`));
        }
        return;
      }
      intent = { action: ActionType.InspectPool, pool } as ParsedIntent;
    } else if (lower.startsWith('protocol fees ') || lower.startsWith('protocol fee ')) {
      const prefix = lower.startsWith('protocol fees ') ? 'protocol fees ' : 'protocol fee ';
      const rawMarket = input.slice(prefix.length).trim();
      if (!rawMarket) {
        if (flags.jsonOutput) {
          console.log(jsonStringify(jsonError('protocol_fees', ErrorCode.INVALID_PARAMETERS, 'Usage: protocol fees <market>')));
        } else {
          console.log(chalk.yellow('  Usage: protocol fees <market>  (e.g. protocol fees sol)'));
        }
        return;
      }
      const market = resolveMarketAlias(rawMarket);
      const { getPoolForMarket } = await import('../config/index.js');
      if (!getPoolForMarket(market)) {
        if (flags.jsonOutput) {
          console.log(jsonStringify(jsonError('protocol_fees', ErrorCode.MARKET_NOT_FOUND, `Unknown market: ${rawMarket}`, { input: rawMarket })));
        } else {
          console.log(chalk.red(`  Unknown market: ${rawMarket}`));
        }
        return;
      }
      await this.handleProtocolFees(market);
      return;
    } else if (
      lower === 'source verify' ||
      lower === 'verify source' ||
      lower.startsWith('source verify ') ||
      lower.startsWith('verify source ')
    ) {
      const prefix = lower.startsWith('source verify')
        ? lower.startsWith('source verify ')
          ? 'source verify '
          : 'source verify'
        : lower.startsWith('verify source ')
          ? 'verify source '
          : 'verify source';
      const rawMarket = input.slice(prefix.length).trim();
      if (!rawMarket) {
        if (flags.jsonOutput) {
          console.log(jsonStringify(jsonError('source_verify', ErrorCode.INVALID_PARAMETERS, 'Usage: source verify <asset>')));
        } else {
          console.log('');
          console.log(chalk.yellow('  Usage: source verify <asset>'));
          console.log('');
          console.log(chalk.dim('  Example:'));
          console.log(chalk.dim('    source verify SOL'));
          console.log(chalk.dim('    source verify BTC'));
          console.log('');
        }
        return;
      }
      const market = resolveMarketAlias(rawMarket);
      const { getPoolForMarket } = await import('../config/index.js');
      if (!getPoolForMarket(market)) {
        if (flags.jsonOutput) {
          console.log(jsonStringify(jsonError('source_verify', ErrorCode.MARKET_NOT_FOUND, `Unknown market: ${rawMarket}`, { input: rawMarket })));
        } else {
          console.log(chalk.red(`  Unknown market: ${rawMarket}`));
        }
        return;
      }
      await this.handleSourceVerify(market);
      return;
    } else if (lower === 'protocol verify' || lower === 'verify protocol' || lower === 'verify') {
      await this.handleProtocolVerify();
      return;
    } else if (lower.startsWith('protocol verify ') || lower.startsWith('verify protocol ')) {
      // "protocol verify SOL" → route to source verify for per-market verification
      const rawMarket = lower.startsWith('protocol verify ')
        ? lower.slice('protocol verify '.length).trim()
        : lower.slice('verify protocol '.length).trim();
      if (rawMarket) {
        const market = resolveMarket(rawMarket.toUpperCase());
        await this.handleSourceVerify(market);
      } else {
        await this.handleProtocolVerify();
      }
      return;
    } else if (
      lower.startsWith('inspect market ') ||
      (lower.startsWith('inspect ') &&
        !lower.startsWith('inspect pool') &&
        !lower.startsWith('inspect protocol') &&
        lower !== 'inspect')
    ) {
      const prefix = lower.startsWith('inspect market ') ? 'inspect market ' : 'inspect ';
      const rawMarket = input.slice(prefix.length).trim();
      const market = resolveMarketAlias(rawMarket);
      const { getPoolForMarket } = await import('../config/index.js');
      if (!getPoolForMarket(market)) {
        if (flags.jsonOutput) {
          console.log(jsonStringify(jsonError('inspect_market', ErrorCode.MARKET_NOT_FOUND, `Unknown market: ${market}`, { input: market })));
        } else {
          console.log(chalk.red(`  Unknown market: ${market}`));
        }
        return;
      }
      intent = { action: ActionType.InspectMarket, market } as ParsedIntent;
    } else if (lower.startsWith('tx inspect ')) {
      const signature = input.slice('tx inspect '.length).trim();
      intent = { action: ActionType.TxInspect, signature } as ParsedIntent;
    } else if (lower.startsWith('tx debug ')) {
      const rest = input.slice('tx debug '.length).trim();
      const showState = rest.includes('--state');
      const signature = rest.replace('--state', '').trim();
      intent = { action: ActionType.TxDebug, signature, showState } as ParsedIntent;
    } else {
      // Full interpreter path (regex + AI)
      if (!IS_AGENT && !flags.jsonOutput) process.stdout.write(chalk.dim('  Parsing...\r'));
      try {
        intent = await withTimeout(this.interpreter.parseIntent(input), COMMAND_TIMEOUT_MS, 'parsing');
        if (!IS_AGENT && !flags.jsonOutput) process.stdout.write('              \r');

        // Safety guard: block AI-inferred destructive actions
        const { shouldBlockAiIntent } = await import('../core/command-safety.js');
        if (shouldBlockAiIntent(input, intent.action)) {
          const { getSafeCommandSuggestion } = await import('../core/command-safety.js');
          const suggestion = getSafeCommandSuggestion(input);
          if (flags.jsonOutput) {
            console.log(jsonStringify(jsonError('unknown', ErrorCode.COMMAND_NOT_FOUND, `Unknown command: ${input}`, suggestion ? { suggestion } : {})));
          } else {
            console.log('');
            console.log(chalk.yellow(`  Unknown command: ${input}`));
            if (suggestion) {
              console.log(chalk.dim(`  Did you mean: ${chalk.cyan(suggestion)}?`));
            }
            console.log('');
          }
          return;
        }
      } catch (error: unknown) {
        if (flags.jsonOutput) {
          console.log(jsonStringify(jsonError('parse', ErrorCode.PARSE_ERROR, getErrorMessage(error), { input })));
        } else {
          console.log(chalk.red(`  ✖ Parse error: ${getErrorMessage(error)}`));
        }
        return;
      }
    }

    // ─── Interactive Trade Builder ──────────────────────────────
    // If the parser returned Help (unknown command), check if it's an
    // incomplete trade command and guide the user through completion.
    if (intent.action === ActionType.Help && !fastIntent && !IS_AGENT) {
      try {
        const { detectPartialTrade, buildTradeInteractively } = await import('./interactive-builder.js');
        const partial = detectPartialTrade(input);
        if (partial) {
          const builtIntent = await buildTradeInteractively(
            (prompt: string) => this.ask(prompt),
            partial,
            this.context.degenMode,
          );
          if (builtIntent) {
            intent = builtIntent;
          } else {
            return; // User cancelled
          }
        }
      } catch {
        /* builder not available */
      }
    }

    // ─── Ambiguous Resolution ────────────────────────────────────
    // If still Help, try resolving as an ambiguous trade using history defaults
    if (intent.action === ActionType.Help && !fastIntent) {
      try {
        const { resolveAmbiguous, needsConfirmation, formatConfirmation } = await import('../ai/intent-scorer.js');
        const ctx = (this.interpreter as unknown as InterpreterWithContext).context;
        const scored = resolveAmbiguous(
          input,
          ctx?.lastMarket,
          ctx?.lastSide as TradeSide | undefined,
          ctx?.lastLeverage,
          ctx?.lastCollateral,
        );
        if (scored) {
          if (IS_AGENT || !needsConfirmation(scored)) {
            intent = scored.intent;
          } else {
            // Show what we interpreted and ask for confirmation
            console.log('');
            console.log(formatConfirmation(scored));
            const ok = await this.confirm('Execute?');
            if (ok) {
              intent = scored.intent;
            } else {
              console.log(chalk.dim('  Cancelled.'));
              return;
            }
          }
        }
      } catch {
        /* scorer not available — fall through to normal unknown path */
      }
    }

    // ─── Command Alert Intercept ──────────────────────────────────
    // If the interpreter returned Help with an _alert, display the alert message
    // instead of the generic unknown command output.
    if (intent.action === ActionType.Help && !fastIntent) {
      // NO_DNA: structured error for unknown commands
      if (IS_AGENT) {
        agentError('unknown_command', { input });
        return;
      }

      const alert = (intent as Record<string, unknown>)._alert as { message: string } | undefined;
      if (alert?.message) {
        console.log(alert.message);
        return;
      }

      // Fetch positions for context-aware suggestions
      let positions: { market: string; side: string }[] | undefined;
      try {
        const posList = await this.flashClient.getPositions();
        positions = posList
          .map((p) => ({
            market: p.market ?? '',
            side: p.side ?? '',
          }))
          .filter((p) => p.market && p.side);
      } catch {
        // Non-critical — proceed without position context
      }

      // Intelligent guidance system — fuzzy match, incomplete, invalid params
      const guidance = getCommandGuidance(input, positions);
      if (guidance) {
        console.log(guidance);
        return;
      }

      // Legacy suggestion engine fallback
      const suggestion = getSuggestions(
        input,
        positions as { market: string; side: string; sizeUsd: number }[] | undefined,
      );
      if (suggestion) {
        console.log('');
        console.log(theme.warning(`  Unknown command: ${input}`));
        console.log(suggestion);
        return;
      }

      // Generic fallback — with "did you mean" for near-misses
      console.log('');
      console.log(chalk.yellow(`  Unknown command: ${input}`));
      try {
        const { getSafeCommandSuggestion } = await import('../core/command-safety.js');
        const suggestion = getSafeCommandSuggestion(input);
        if (suggestion) {
          console.log(chalk.dim(`  Did you mean: ${chalk.cyan(suggestion)}?`));
        }
      } catch {
        /* non-critical */
      }
      console.log('');
      console.log(`  ${theme.section('Try')}`);
      console.log(`    ${theme.command('help')}         List all commands`);
      console.log(`    ${theme.command('markets')}      View available markets`);
      console.log(`    ${theme.command('positions')}    View open positions`);
      console.log('');
      return;
    }

    // ─── Market Monitor Intercept ────────────────────────────────────
    if (intent.action === ActionType.MarketMonitor) {
      await this.handleMarketMonitor();
      return;
    }

    // ─── Dry Run Intercept ──────────────────────────────────────────
    if (intent.action === ActionType.DryRun && 'innerCommand' in intent) {
      await this.handleDryRun(intent.innerCommand as string);
      return;
    }

    // ─── Auto-Detect Position Side ─────────────────────────────────
    // When close/add/remove has a market but no side, auto-detect from open positions
    const intentAny = intent as Record<string, unknown>;
    const needsSide =
      (intent.action === ActionType.ClosePosition ||
        intent.action === ActionType.AddCollateral ||
        intent.action === ActionType.RemoveCollateral) &&
      intentAny.market &&
      !intentAny.side;

    if (needsSide) {
      const mkt = String(intentAny.market).toUpperCase();
      try {
        const posList = await this.flashClient.getPositions();
        const matching = posList.filter((p) => (p.market ?? '').toUpperCase() === mkt);
        if (matching.length === 1) {
          intent = { ...intent, side: matching[0].side } as ParsedIntent;
        } else if (matching.length === 0) {
          console.log(theme.warning(`  No open position found for ${mkt}.`));
          return;
        } else {
          const sides = matching.map((p) => p.side?.toLowerCase()).join(' and ');
          console.log(theme.warning(`  Multiple ${mkt} positions open (${sides}).`));
          console.log(theme.dim(`  Please specify the side, e.g. "${input} long" or "${input} short"`));
          return;
        }
      } catch {
        console.log(theme.warning(`  Could not detect position side. Please specify long or short.`));
        return;
      }
    }

    // ─── Pre-Trade Safety Checks (live mode only) ─────────────────
    const isTradeAction = [
      ActionType.OpenPosition,
      ActionType.ClosePosition,
      ActionType.AddCollateral,
      ActionType.RemoveCollateral,
    ].includes(intent.action);

    if (isTradeAction && !this.config.simulationMode) {
      // Feature 1: RPC health check before trades
      const health = await this.rpcManager.checkHealth(this.rpcManager.activeEndpoint);
      if (!health.healthy || health.latencyMs > 3000 || (health.slotLag !== undefined && health.slotLag > 50)) {
        const reasons: string[] = [];
        if (!health.healthy) reasons.push('RPC unreachable');
        if (health.latencyMs > 3000) reasons.push(`latency ${health.latencyMs}ms`);
        if (health.slotLag !== undefined && health.slotLag > 50) reasons.push(`${health.slotLag} slots behind`);

        if (IS_AGENT) {
          // NO_DNA: fail with structured error instead of prompting
          if (!health.healthy) {
            agentError('rpc_unhealthy', { reasons });
            return;
          }
          // Degraded but reachable — proceed with warning metadata
        } else {
          console.log(chalk.yellow(`\n  ⚠ RPC health warning: ${reasons.join(', ')}`));
          console.log(chalk.dim('    Trading may be unreliable. Proceed with caution.'));
          const proceed = await this.confirm('Continue anyway?');
          if (!proceed) {
            console.log(chalk.dim('  Cancelled.'));
            return;
          }
        }
      }

      // Feature 2: Position verification before close/modify
      if (intent.action !== ActionType.OpenPosition && intentAny.market && intentAny.side) {
        const mkt = String(intentAny.market).toUpperCase();
        const sd = String(intentAny.side);
        try {
          const positions = await this.flashClient.getPositions();
          const found = positions.some((p) => (p.market ?? '').toUpperCase() === mkt && p.side === sd);
          if (!found) {
            console.log(chalk.yellow('  ⚠ Position not confirmed on-chain yet. Waiting for state sync...'));
            // Trigger reconciliation and retry once
            const rec = getReconciler();
            if (rec) await rec.reconcile();
            const retry = await this.flashClient.getPositions();
            const retryFound = retry.some((p) => (p.market ?? '').toUpperCase() === mkt && p.side === sd);
            if (!retryFound) {
              console.log(chalk.red(`  ✖ Position ${mkt} ${sd} not found after sync. Cannot proceed.`));
              return;
            }
            console.log(chalk.green('  Position verified after sync.'));
          }
        } catch {
          // Non-critical — let the trade tool handle it
        }
      }
    }

    // ── Per-command wallet override (--key <name|path>) ──────────────
    let walletRestoreData: { address: string; name: string } | null = null;
    if (flags.keyOverride) {
      try {
        const walletStore = new WalletStore();
        let walletPath: string;

        // Try as a registered wallet name first, then as a file path
        if (walletStore.hasWallet(flags.keyOverride)) {
          walletPath = walletStore.getWalletPath(flags.keyOverride);
        } else {
          walletPath = walletStore.validateWalletPath(flags.keyOverride);
        }

        // Save current wallet state for restoration
        walletRestoreData = {
          address: this.context.walletAddress,
          name: this.context.walletName,
        };

        // Load temporary wallet
        const { address } = this.walletManager.loadFromFile(walletPath);
        this.context.walletAddress = address;
        this.context.walletName = flags.keyOverride;

        if (!flags.jsonOutput && !IS_AGENT) {
          console.log(
            chalk.dim(`  Using wallet: ${flags.keyOverride} (${address.slice(0, 4)}...${address.slice(-4)})`),
          );
        }
      } catch (err: unknown) {
        if (flags.jsonOutput) {
          console.log(
            jsonStringify(jsonError('wallet_override', ErrorCode.WALLET_OVERRIDE_FAILED, `Wallet override failed: ${getErrorMessage(err)}`, { key: flags.keyOverride })),
          );
        } else {
          console.log(chalk.red(`  Invalid --key: ${getErrorMessage(err)}`));
        }
        return;
      }
    }

    // Degraded mode gate — block trade commands when all RPCs are down
    const runtimeReadOnly = getRuntimeState()?.isReadOnly ?? false;
    if ((this.degradedMode || runtimeReadOnly) && TRADE_ACTIONS.has(intent.action)) {
      if (flags.jsonOutput) {
        console.log(jsonStringify(jsonError(intent.action, ErrorCode.DEGRADED_MODE, 'All RPC endpoints unavailable. Terminal running in read-only mode.', { blocked_action: intent.action })));
      } else {
        console.log('');
        console.log(chalk.yellow('  Trading unavailable — RPC connection down.'));
        console.log(chalk.dim('  The system is retrying automatically. Read-only commands still work.'));
        console.log('');
      }
      this.restoreWallet(walletRestoreData);
      return;
    }

    // Health gate — block trades when system is CRITICAL
    const health = getHealth();
    if (health?.isTradeBlocked() && TRADE_ACTIONS.has(intent.action)) {
      const snap = health.snapshot();
      if (flags.jsonOutput) {
        console.log(jsonStringify(jsonError(intent.action, ErrorCode.DEGRADED_MODE, `System health CRITICAL: ${snap.reasons.join(', ')}`, { blocked_action: intent.action })));
      } else {
        console.log('');
        console.log(chalk.red(`  System health CRITICAL — trades blocked`));
        console.log(chalk.dim(`  Reasons: ${snap.reasons.join(', ')}`));
        console.log(chalk.dim('  System will auto-recover when conditions improve.'));
        console.log('');
      }
      this.restoreWallet(walletRestoreData);
      return;
    }

    // Execute tool — no animated ticker (conflicts with sendTx progress output)

    // Enable structured output during dispatch so tools return JSON in message
    if (flags.jsonOutput) enableStructuredOutput();

    let result: ToolResult;
    try {
      result = await withTimeout(this.engine.dispatch(intent), COMMAND_TIMEOUT_MS, 'execution');
      // Restore output mode BEFORE any IS_AGENT display checks
      if (flags.jsonOutput) restoreOutputMode();
    } catch (error: unknown) {
      if (flags.jsonOutput) restoreOutputMode();
      // Record error for health monitoring
      getHealth()?.recordError();
      if (flags.jsonOutput) {
        const errMsg = getErrorMessage(error);
        const code = errMsg.toLowerCase().includes('timeout') ? ErrorCode.COMMAND_TIMEOUT : ErrorCode.UNKNOWN_ERROR;
        console.log(jsonStringify(jsonError(intent.action || 'unknown', code, errMsg)));
      } else if (IS_AGENT) {
        agentError('execution_error', { detail: getErrorMessage(error) });
      } else {
        console.log(chalk.red(`  ✖ Execution error: ${getErrorMessage(error)}`));
      }
      this.restoreWallet(walletRestoreData);
      return;
    }

    // ── NO_DNA: structured JSON output ──────────────────────────────
    if (IS_AGENT) {
      // Build structured response from tool result
      const agentPayload: Record<string, unknown> = {
        status: result.success ? 'success' : 'error',
        action: intent.action,
      };

      // Include structured data if available
      if (result.data) {
        const { executeAction: _executeAction, ...safeData } = result.data;
        Object.assign(agentPayload, safeData);
      }
      if (result.txSignature) agentPayload.tx_signature = result.txSignature;

      // Auto-confirm trades (NO_DNA: never prompt)
      if (result.requiresConfirmation && result.data?.executeAction) {
        try {
          const execResult = await withTimeout(result.data.executeAction(), COMMAND_TIMEOUT_MS, 'transaction');
          agentPayload.status = execResult.success ? 'submitted' : 'failed';
          if (execResult.txSignature) agentPayload.tx_signature = execResult.txSignature;
          if (execResult.data) {
            const { executeAction: _, ...execSafeData } = execResult.data;
            Object.assign(agentPayload, execSafeData);
          }

          // Post-trade verification (live mode only)
          if (!this.config.simulationMode && execResult.data?.market && execResult.data?.side) {
            const rec = getReconciler();
            if (rec) {
              rec.verifyTrade(execResult.data.market as string, execResult.data.side as string).catch(() => {});
            }
          }
        } catch (error: unknown) {
          agentPayload.status = 'failed';
          agentPayload.error = getErrorMessage(error);
        }
      }

      if (!result.success && !result.requiresConfirmation) {
        agentError(intent.action, agentPayload);
      } else {
        agentOutput(agentPayload);
      }

      // Handle wallet state changes
      if (result.data?.disconnected) this.handleWalletDisconnected();
      if (result.data?.walletConnected && !this.config.simulationMode) {
        await this.handleWalletReconnected();
      }
      this.restoreWallet(walletRestoreData);
      return;
    }

    // ── JSON output mode (--format json) ───────────────────────────
    // Standardized JSON response via json-response.ts (v1 contract).
    if (flags.jsonOutput) {
      const commandName = intent.action || 'unknown';
      const response = jsonFromToolResult(commandName, result);

      // For confirmation-required commands, include confirmation details in data
      if (result.requiresConfirmation) {
        response.data.action_required = 'confirmation';
        response.data.prompt = result.confirmationPrompt ?? 'Confirm?';
      }

      console.log(jsonStringify(response));

      // Handle wallet state changes (non-trade commands like wallet use)
      if (result.data?.disconnected) this.handleWalletDisconnected();
      if (result.data?.walletConnected && !this.config.simulationMode) {
        await this.handleWalletReconnected();
      }
      this.restoreWallet(walletRestoreData);
      return;
    }

    // ── Human mode: existing display logic ──────────────────────────
    // Display result with success/error indicator
    console.log(result.message);
    if (!result.requiresConfirmation) {
      this.printIndicator(result);
    }

    // Handle wallet disconnect — mode stays locked
    if (result.data?.disconnected) {
      this.handleWalletDisconnected();
    }

    // Handle wallet reconnected in live mode — rebuild client
    if (result.data?.walletConnected && !this.config.simulationMode) {
      await this.handleWalletReconnected();
    }

    // Handle confirmation flow
    if (result.requiresConfirmation && result.data?.executeAction) {
      const confirmed = await this.confirm(result.confirmationPrompt ?? 'Confirm?');
      if (confirmed) {
        // Prevent trade execution during wallet rebuild — check atomically before submission
        if (this.walletRebuilding) {
          console.log(chalk.red('  Wallet switch in progress — trade cancelled for safety.'));
          this.restoreWallet(walletRestoreData);
          return;
        }
        // Double-check: yield to event loop so any pending wallet rebuild can settle
        await new Promise((r) => setImmediate(r));
        if (this.walletRebuilding) {
          console.log(chalk.red('  Wallet switch detected — trade cancelled for safety.'));
          this.restoreWallet(walletRestoreData);
          return;
        }

        console.log(chalk.dim('  Submitting transaction...'));

        try {
          const submitStart = Date.now();
          const execResult = await withTimeout(result.data.executeAction(), COMMAND_TIMEOUT_MS, 'transaction');
          const elapsed = ((Date.now() - submitStart) / 1000).toFixed(1);
          if (execResult.success) {
            console.log(chalk.green(`  ✔ Confirmed in ${elapsed}s`));
          }
          console.log(execResult.message);

          // Post-trade verification (live mode only) — non-blocking
          if (!this.config.simulationMode && execResult.data?.market && execResult.data?.side) {
            const rec = getReconciler();
            if (rec) {
              rec
                .verifyTrade(execResult.data.market as string, execResult.data.side as string)
                .then((verified) => {
                  if (!verified) {
                    console.log(chalk.yellow('  ⚠ Position not yet found on-chain. It may take a moment to settle.'));
                  }
                })
                .catch((e) => {
                  getLogger().warn('trade-verify', `Post-trade verification failed: ${e instanceof Error ? e.message : String(e)}`);
                });
            }
          }
        } catch (error: unknown) {
          console.log(chalk.red(`  ✖ ${getErrorMessage(error)}`));
        }
      } else {
        console.log(chalk.dim('  Cancelled.'));
      }
    }

    this.restoreWallet(walletRestoreData);
  }

  /** Restore session wallet after --key override */
  private restoreWallet(restoreData: { address: string; name: string } | null): void {
    if (!restoreData) return;
    // Reload the original wallet
    try {
      const walletStore = new WalletStore();
      if (walletStore.hasWallet(restoreData.name)) {
        const walletPath = walletStore.getWalletPath(restoreData.name);
        this.walletManager.loadFromFile(walletPath);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.yellow(`  Warning: wallet restore failed for "${restoreData.name}": ${msg}`));
      getLogger().warn('wallet', `Wallet restore failed: ${msg}`);
    }
    this.context.walletAddress = restoreData.address;
    this.context.walletName = restoreData.name;
  }

  // ─── Execution Timer ─────────────────────────────────────────

  /**
   * Print a compact execution timer after each command.
   * Format: [153ms] or [7.4s]
   */
  private renderExecutionTimer(): void {
    if (IS_AGENT) return; // NO_DNA: no TUI decorations
    if (!this.lastCommand || this.lastCommandMs < 1) return;

    // Skip for trivial commands
    const skip = ['help', 'commands', '?', 'exit', 'quit'];
    if (skip.includes(this.lastCommand.toLowerCase())) return;

    const timeStr =
      this.lastCommandMs >= 1000 ? `${(this.lastCommandMs / 1000).toFixed(1)}s` : `${this.lastCommandMs}ms`;

    console.log(theme.dim(`  [${timeStr}]`));
  }

  // ─── Result Indicators ─────────────────────────────────────

  /**
   * Print a success/error/warning indicator after tool output.
   */
  private printIndicator(result: ToolResult): void {
    if (result.success === false) {
      // Only print indicator if the message doesn't already contain error styling
      if (result.message && !result.message.includes('✖')) {
        console.log(chalk.red('  ✖ Command failed'));
      }
    }
    // Success is implicit — clean output means success.
    // We don't print ✔ for every read-only command (positions, portfolio, etc.)
    // to avoid noise. The ✔ is reserved for trade confirmations (handled above).
  }

  // ─── Usage Hints ──────────────────────────────────────────────

  /**
   * Show usage hint for commands typed without required parameters.
   * Returns true if a hint was shown (caller should return early).
   */
  private showUsageHint(lower: string): boolean {
    const guidance = getCommandGuidance(lower);
    if (guidance) {
      console.log(guidance);
      return true;
    }
    return false;
  }

  // ─── Dry Run Handler ─────────────────────────────────────────────

  /**
   * Market monitor — professional full-screen market table with event velocity intelligence.
   * Uses diff-based rendering for flicker-free updates. Press 'q' to exit cleanly.
   *
   * Lifecycle:
   *   1. Isolate input (pause readline, set raw mode)
   *   2. Clear screen, show loading
   *   3. Fetch first dataset (block until data arrives)
   *   4. Render initial frame
   *   5. Start 5s refresh loop with diff rendering
   *   6. Exit cleanly on 'q'
   *
   * Data sources:
   *   Prices:        Flash API (authoritative price source)
   *   Open Interest:  fstats API (aggregated Flash protocol state)
   */
  private async handleMarketMonitor(filterMarket?: string): Promise<void> {
    await runMarketMonitor(
      {
        rl: this.rl,
        rpcManager: this.rpcManager,
        fstats: this.fstats,
        config: this.config,
      },
      filterMarket,
    );
  }

  /**
   * Position debug — protocol-level debugging view of an open position.
   *
   * Data sources:
   *   Position data:      Flash SDK perpClient.getUserPositions()
   *   Price data:         Flash API (authoritative price source)
   *   Liquidation math:   Flash SDK getLiquidationPriceContractHelper()
   *   Fees/margin:        Flash SDK CustodyAccount (on-chain)
   *   Leverage limits:    Flash SDK PoolConfig MarketConfig
   */
  /** Build dependency bag for protocol view functions. */
  private getProtocolViewDeps(): ProtocolViewDeps {
    return {
      config: this.config,
      flashClient: this.flashClient,
      rpcManager: this.rpcManager,
      walletManager: this.walletManager,
    };
  }

  /**
   * Protocol fee verification — shows raw on-chain fee parameters from CustodyAccount.
   * Data source: CustodyAccount.fees.openPosition / closePosition via Flash SDK.
   */
  private async handleProtocolFees(market: string): Promise<void> {
    return protocolFeesView(this.getProtocolViewDeps(), market);
  }

  /**
   * protocol verify — Full protocol alignment audit.
   * Runs all checks in parallel with per-task timeout protection.
   */
  private async handleProtocolVerify(): Promise<void> {
    return protocolVerifyView(this.getProtocolViewDeps());
  }

  private async handleSourceVerify(market: string): Promise<void> {
    return sourceVerifyView(this.getProtocolViewDeps(), market);
  }

  // Agent removed — see flash-agent repo

  private async handlePositionDebug(market: string): Promise<void> {
    return positionDebugView(this.getProtocolViewDeps(), market);
  }

  /**
   * Resolve a raw command string into a ParsedIntent.
   * Reuses FAST_DISPATCH, inspect routing, and the AI interpreter.
   * Used by watch mode and dry-run to parse commands without executing them.
   */
  private async resolveIntent(input: string): Promise<ParsedIntent> {
    return resolveIntentExtracted(this.dryRunDeps(), input);
  }

  /**
   * Handle dry-run commands.
   * Parses the inner command, builds a transaction preview, and displays it.
   * SAFETY: No transaction is ever signed or sent.
   */
  private async handleDryRun(innerCommand: string): Promise<void> {
    return handleDryRunExtracted(this.dryRunDeps(), innerCommand);
  }

  /** Build DryRunDeps from current instance state. */
  private dryRunDeps(): DryRunDeps {
    return {
      interpreter: this.interpreter,
      flashClient: this.flashClient,
      config: this.config,
    };
  }

  // [L-11] Confirmation timeout — cancel trade if user doesn't respond within 2 minutes
  private static readonly CONFIRM_TIMEOUT_MS = 120_000;

  /** Confirmation via pendingConfirmation callback — auto-cancels after timeout */
  private confirm(prompt: string): Promise<boolean> {
    return new Promise((resolve) => {
      process.stdout.write(`  ${chalk.yellow(prompt)} ${chalk.dim('(yes/no)')} `);

      // Check if user pre-typed a response while the command was processing.
      // In live mode, discard buffered input so the user must see the trade
      // summary before confirming — prevents accidental auto-confirmation.
      if (this.bufferedLine) {
        if (this.config.simulationMode) {
          const answer = this.bufferedLine;
          this.bufferedLine = null;
          resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
          return;
        }
        // Live mode: discard pre-typed input — user must confirm after seeing details
        this.bufferedLine = null;
      }

      // Atomic guard: prevent both timeout and callback from resolving
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pendingConfirmation = null;
        process.stdout.write(`\n  ${chalk.yellow('Confirmation timed out — trade cancelled.')}\n`);
        resolve(false);
      }, FlashTerminal.CONFIRM_TIMEOUT_MS);
      timeout.unref();
      this.pendingConfirmation = (answer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.pendingConfirmation = null;
        resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
      };
    });
  }
}
