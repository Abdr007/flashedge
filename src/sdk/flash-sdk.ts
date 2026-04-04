/**
 * Flash SDK — Programmatic interface to Flash Terminal
 *
 * Thin wrapper over the CLI JSON interface (`flash exec --format json`).
 * No business logic duplication — CLI remains the source of truth.
 *
 * Usage:
 *   import { FlashSDK } from 'bolt-terminal/sdk';
 *   const flash = new FlashSDK();
 *   const positions = await flash.positions();
 */

import { execFile } from 'child_process';
import { resolve, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import type {
  FlashSDKOptions,
  FlashResponse,
  PositionsData,
  Portfolio,
  TradeResult,
  OpenParams,
  CloseParams,
  AddCollateralParams,
  RemoveCollateralParams,
  LimitOrderParams,
  EarnData,
  EarnActionParams,
  FafStatus,
  FafStakeParams,
  WalletBalance,
  WalletTokens,
  MarketsData,
  VolumeData,
  OpenInterestData,
  HealthData,
  MetricsData,
  WatchOptions,
  WatchHandle,
} from './types.js';
import { FlashError, FlashTimeoutError, FlashParseError, FlashProcessError } from './errors.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 1;
const TRANSIENT_ERROR_CODES = new Set(['COMMAND_TIMEOUT', 'NETWORK_ERROR', 'RPC_UNAVAILABLE']);

// ─── SDK Class ───────────────────────────────────────────────────────────────

export class FlashSDK {
  private readonly binPath: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly env: Record<string, string>;
  private readonly cwd: string | undefined;

  constructor(options: FlashSDKOptions = {}) {
    this.binPath = options.binPath ?? this.resolveBinPath();
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.env = options.env ?? {};
    this.cwd = options.cwd;
  }

  // ─── Core Execute ────────────────────────────────────────────────────

  /**
   * Execute any Flash Terminal command and return the parsed JSON response.
   *
   * @param command - The command string (e.g. "positions", "open long sol 3x $100")
   * @returns Parsed FlashResponse with typed data
   * @throws FlashError on command failure
   * @throws FlashTimeoutError on timeout
   * @throws FlashParseError on invalid JSON output
   */
  async execute<T = Record<string, unknown>>(command: string): Promise<FlashResponse<T>> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const raw = await this.execCli(command);
        const response = this.parseResponse<T>(raw, command);

        // If the command failed, throw a structured error
        if (!response.success && response.error) {
          throw FlashError.fromErrorInfo(response.error, command);
        }

        return response;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Only retry transient errors
        if (error instanceof FlashError && TRANSIENT_ERROR_CODES.has(error.code) && attempt < this.maxRetries) {
          continue;
        }

        // Don't retry parse errors, process errors, or business logic errors
        throw error;
      }
    }

    throw lastError ?? new FlashError('UNKNOWN_ERROR', 'Execution failed after retries', {}, command);
  }

  /**
   * Execute a command and return the raw response (including failures).
   * Does NOT throw on command failure — returns the error in the response.
   * Only throws on process/parse errors.
   */
  async executeRaw<T = Record<string, unknown>>(command: string): Promise<FlashResponse<T>> {
    const raw = await this.execCli(command);
    return this.parseResponse<T>(raw, command);
  }

  // ─── Trading ─────────────────────────────────────────────────────────

  /** Get all open positions. */
  async positions(): Promise<FlashResponse<PositionsData>> {
    return this.execute<PositionsData>('positions');
  }

  /** Get portfolio overview. */
  async portfolio(): Promise<FlashResponse<Portfolio>> {
    return this.execute<Portfolio>('portfolio');
  }

  /** Open a new position. Returns trade details (may require confirmation in interactive mode). */
  async open(params: OpenParams): Promise<FlashResponse<TradeResult>> {
    const parts = [params.side, params.market, `${params.leverage}x`, `$${params.collateral}`];
    if (params.tp) parts.push(`tp $${params.tp}`);
    if (params.sl) parts.push(`sl $${params.sl}`);
    return this.execute<TradeResult>(parts.join(' '));
  }

  /** Close a position. */
  async close(params: CloseParams): Promise<FlashResponse<TradeResult>> {
    const parts = ['close', params.market, params.side];
    if (params.percent && params.percent < 100) parts.push(`${params.percent}%`);
    return this.execute<TradeResult>(parts.join(' '));
  }

  /** Add collateral to an existing position. */
  async addCollateral(params: AddCollateralParams): Promise<FlashResponse<TradeResult>> {
    return this.execute<TradeResult>(`add ${params.market} ${params.side} $${params.amount}`);
  }

  /** Remove collateral from an existing position. */
  async removeCollateral(params: RemoveCollateralParams): Promise<FlashResponse<TradeResult>> {
    return this.execute<TradeResult>(`remove ${params.market} ${params.side} $${params.amount}`);
  }

  /** Place a limit order. */
  async limitOrder(params: LimitOrderParams): Promise<FlashResponse<TradeResult>> {
    return this.execute<TradeResult>(
      `limit ${params.side} ${params.market} ${params.leverage}x $${params.collateral} @ $${params.price}`,
    );
  }

  /** List open limit orders. */
  async orders(): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute('orders');
  }

  /** Close all open positions. */
  async closeAll(): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute('close all');
  }

  /** Get trade history. */
  async tradeHistory(): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute('trade history');
  }

  // ─── Market Data ─────────────────────────────────────────────────────

  /** List all available markets. */
  async markets(): Promise<FlashResponse<MarketsData>> {
    return this.execute<MarketsData>('markets');
  }

  /** Get 24h volume data. */
  async volume(): Promise<FlashResponse<VolumeData>> {
    return this.execute<VolumeData>('volume');
  }

  /** Get open interest data. */
  async openInterest(): Promise<FlashResponse<OpenInterestData>> {
    return this.execute<OpenInterestData>('oi');
  }

  /** Analyze a specific market. */
  async analyze(market: string): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute(`analyze ${market}`);
  }

  /** Get funding rates for a market. */
  async funding(market: string): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute(`funding ${market}`);
  }

  // ─── Earn / LP ───────────────────────────────────────────────────────

  /** Get earn pool status. */
  async earn(): Promise<FlashResponse<EarnData>> {
    return this.execute<EarnData>('earn');
  }

  /** Get detailed info for a pool. */
  async earnInfo(pool: string): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute(`earn info ${pool}`);
  }

  /** Add liquidity to a pool. */
  async earnDeposit(params: EarnActionParams): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute(`earn add ${params.pool} $${params.amount}`);
  }

  /** Remove liquidity from a pool. */
  async earnWithdraw(params: EarnActionParams): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute(`earn remove ${params.pool} $${params.amount}`);
  }

  /** Stake FLP tokens. */
  async earnStake(params: EarnActionParams): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute(`earn stake ${params.pool} $${params.amount}`);
  }

  /** Unstake FLP tokens. */
  async earnUnstake(params: EarnActionParams): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute(`earn unstake ${params.pool} $${params.amount}`);
  }

  /** Claim earn rewards. */
  async earnClaim(): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute('earn claim');
  }

  /** Get earn dashboard. */
  async earnDashboard(): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute('earn dashboard');
  }

  // ─── FAF Token ───────────────────────────────────────────────────────

  /** Get FAF token status. */
  async faf(): Promise<FlashResponse<FafStatus>> {
    return this.execute<FafStatus>('faf');
  }

  /** Stake FAF tokens. */
  async fafStake(params: FafStakeParams): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute(`faf stake ${params.amount}`);
  }

  /** Unstake FAF tokens. */
  async fafUnstake(params: FafStakeParams): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute(`faf unstake ${params.amount}`);
  }

  /** Claim FAF rewards. */
  async fafClaim(): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute('faf claim');
  }

  /** Get FAF VIP tier info. */
  async fafTier(): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute('faf tier');
  }

  // ─── Wallet ──────────────────────────────────────────────────────────

  /** Get wallet balance (SOL + USDC). */
  async walletBalance(): Promise<FlashResponse<WalletBalance>> {
    return this.execute<WalletBalance>('wallet balance');
  }

  /** Get all token balances in wallet. */
  async walletTokens(): Promise<FlashResponse<WalletTokens>> {
    return this.execute<WalletTokens>('wallet tokens');
  }

  /** Get wallet status. */
  async walletStatus(): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute('wallet');
  }

  /** List saved wallets. */
  async walletList(): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute('wallet list');
  }

  // ─── System ──────────────────────────────────────────────────────────

  /** Run system health check. */
  async health(): Promise<FlashResponse<HealthData>> {
    return this.execute<HealthData>('doctor');
  }

  /** Get session metrics. */
  async metrics(): Promise<FlashResponse<MetricsData>> {
    return this.execute<MetricsData>('metrics');
  }

  /** Get RPC status. */
  async rpcStatus(): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute('rpc status');
  }

  /** Get system status. */
  async systemStatus(): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute('system status');
  }

  // ─── Protocol Inspection ─────────────────────────────────────────────

  /** Inspect protocol overview. */
  async inspectProtocol(): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute('inspect protocol');
  }

  /** Inspect a specific pool. */
  async inspectPool(pool: string): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute(`inspect pool ${pool}`);
  }

  /** Inspect a specific market. */
  async inspectMarket(market: string): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute(`inspect market ${market}`);
  }

  // ─── Risk & Analytics ────────────────────────────────────────────────

  /** Get portfolio dashboard. */
  async dashboard(): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute('dashboard');
  }

  /** Get risk report. */
  async riskReport(): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute('risk report');
  }

  /** Get portfolio exposure. */
  async exposure(): Promise<FlashResponse<Record<string, unknown>>> {
    return this.execute('exposure');
  }

  // ─── Watch (Event Loop) ──────────────────────────────────────────────

  /**
   * Repeatedly execute a command at a given interval.
   * Emits new data only when it changes (by default).
   *
   * @param command - Command to watch (e.g. "positions", "portfolio")
   * @param callback - Called with each new response
   * @param options - Polling interval, dedup, max iterations
   * @returns WatchHandle to stop the loop
   */
  watch<T = Record<string, unknown>>(
    command: string,
    callback: (response: FlashResponse<T>, iteration: number) => void,
    options: WatchOptions = {},
  ): WatchHandle {
    const interval = options.interval ?? 5_000;
    const deduplicate = options.deduplicate ?? true;
    const maxIterations = options.maxIterations ?? 0;

    let running = true;
    let iteration = 0;
    let lastHash = '';

    const loop = async (): Promise<void> => {
      while (running) {
        if (maxIterations > 0 && iteration >= maxIterations) {
          running = false;
          break;
        }

        try {
          const response = await this.executeRaw<T>(command);
          iteration++;

          if (deduplicate) {
            const hash = JSON.stringify(response.data);
            if (hash === lastHash) {
              await sleep(interval);
              continue;
            }
            lastHash = hash;
          }

          callback(response, iteration);
        } catch {
          // Swallow errors in watch loop — continue polling
        }

        await sleep(interval);
      }
    };

    // Start the loop (non-blocking)
    loop().catch(() => {
      running = false;
    });

    return {
      stop: () => {
        running = false;
      },
      get running() {
        return running;
      },
    };
  }

  // ─── Internal ────────────────────────────────────────────────────────

  /** Execute the CLI process and return raw stdout. */
  private execCli(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['exec', command, '--format', 'json'];
      const env = {
        ...process.env,
        ...this.env,
        // Ensure no interactive prompts
        NO_DNA: process.env.NO_DNA || '1',
      };

      // If binPath is a .js file, run it with node
      const bin = this.binPath.endsWith('.js') ? process.execPath : this.binPath;
      const fullArgs = this.binPath.endsWith('.js') ? [this.binPath, ...args] : args;

      const child = execFile(
        bin,
        fullArgs,
        {
          timeout: this.timeout,
          maxBuffer: 2 * 1024 * 1024, // 2MB
          env,
          cwd: this.cwd,
          shell: false,
        },
        (error, stdout, stderr) => {
          if (error) {
            if ('killed' in error && error.killed) {
              return reject(new FlashTimeoutError(command, this.timeout));
            }
            // Process exited with error — check if stdout has valid JSON anyway
            if (stdout && stdout.trim()) {
              try {
                JSON.parse(stdout.trim());
                return resolve(stdout.trim());
              } catch {
                // stdout is not valid JSON — report the process error
              }
            }
            return reject(new FlashProcessError(command, error.code ? parseInt(String(error.code)) : null, stderr || error.message));
          }
          resolve(stdout.trim());
        },
      );

      // Safety kill if child hangs
      child.on('error', (err) => {
        reject(new FlashProcessError(command, null, err.message));
      });
    });
  }

  /** Parse raw CLI output into a typed FlashResponse. */
  private parseResponse<T>(raw: string, command: string): FlashResponse<T> {
    if (!raw) {
      throw new FlashParseError(command, raw);
    }

    // Find the last complete JSON object in stdout
    // (in case there's any stray output before the JSON)
    const jsonStart = raw.lastIndexOf('\n{');
    const jsonStr = jsonStart >= 0 ? raw.slice(jsonStart + 1) : raw;

    try {
      const parsed = JSON.parse(jsonStr);

      // Validate minimum schema compliance
      if (typeof parsed !== 'object' || parsed === null) {
        throw new FlashParseError(command, raw);
      }

      // Ensure required fields exist with correct types
      const response: FlashResponse<T> = {
        success: typeof parsed.success === 'boolean' ? parsed.success : false,
        command: typeof parsed.command === 'string' ? parsed.command : command,
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
        version: typeof parsed.version === 'string' ? parsed.version : 'v1',
        data: (parsed.data ?? {}) as T,
        error: parsed.error ?? null,
      };

      return response;
    } catch (error: unknown) {
      if (error instanceof FlashParseError) throw error;
      throw new FlashParseError(command, raw);
    }
  }

  /** Resolve the flash CLI binary path. */
  private resolveBinPath(): string {
    // 1. Relative to this SDK file: ../../index.js (dist/sdk/ → dist/index.js)
    try {
      const sdkDir = dirname(fileURLToPath(import.meta.url));
      const localDist = resolve(sdkDir, '..', 'index.js');
      if (existsSync(localDist)) return localDist;
    } catch { /* not in file:// context */ }

    // 2. Check cwd/dist/index.js (project root)
    const cwdDist = resolve(process.cwd(), 'dist', 'index.js');
    if (existsSync(cwdDist)) return cwdDist;

    // 3. Check node_modules/.bin/flash
    const nmBin = resolve(process.cwd(), 'node_modules', '.bin', 'flash');
    if (existsSync(nmBin)) return nmBin;

    // 4. Fall back to global
    return 'flash';
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
