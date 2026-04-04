import chalk from 'chalk';
import { ToolContext } from '../types/index.js';
import { RpcManager } from '../network/rpc-manager.js';
import { formatUsd } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import { BUILD_INFO } from '../build-info.js';
import { theme } from '../cli/theme.js';

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: SystemDiagnostics | null = null;

export function initSystemDiagnostics(rpcManager: RpcManager, context: ToolContext): SystemDiagnostics {
  _instance = new SystemDiagnostics(rpcManager, context);
  return _instance;
}

export function getSystemDiagnostics(): SystemDiagnostics | null {
  return _instance;
}

/**
 * System Diagnostics — inspect system health, RPC status, and transaction details.
 */
export class SystemDiagnostics {
  private rpcManager: RpcManager;
  private context: ToolContext;

  constructor(rpcManager: RpcManager, context: ToolContext) {
    this.rpcManager = rpcManager;
    this.context = context;
  }

  /**
   * Full system status report.
   */
  async systemStatus(): Promise<string> {
    const lines: string[] = [theme.titleBlock('SYSTEM STATUS'), ''];

    // Build
    lines.push(chalk.bold('  Build'));
    lines.push(`    Version: ${chalk.cyan(`v${BUILD_INFO.version}`)}`);
    lines.push(`    Commit:  ${chalk.dim(BUILD_INFO.gitHash)}`);
    lines.push(`    Branch:  ${chalk.dim(BUILD_INFO.branch)}`);
    lines.push(`    Built:   ${chalk.dim(BUILD_INFO.buildDate)}`);
    lines.push('');

    // RPC
    const activeRpc = this.rpcManager.activeEndpoint;
    let latency = -1;
    try {
      latency = await this.rpcManager.measureLatency();
    } catch {
      /* best-effort */
    }

    lines.push(chalk.bold('  RPC'));
    lines.push(`    Active:    ${chalk.cyan(activeRpc.label)}`);
    lines.push(`    Latency:   ${this.colorLatency(latency)}`);
    lines.push(`    Failovers: ${this.rpcManager.totalFailovers}`);
    lines.push(`    Backups:   ${this.rpcManager.fallbackCount}`);
    lines.push('');

    // Wallet
    const wm = this.context.walletManager;
    lines.push(chalk.bold('  Wallet'));
    if (wm?.isConnected) {
      lines.push(`    Status:  ${chalk.green('Connected')}`);
      lines.push(`    Address: ${chalk.cyan(wm.address ?? 'unknown')}`);
      lines.push(`    Mode:    ${wm.isReadOnly ? chalk.yellow('Read-Only') : chalk.green('Full Access')}`);
    } else if (wm?.hasAddress) {
      lines.push(`    Status:  ${chalk.yellow('Read-Only')}`);
      lines.push(`    Address: ${chalk.cyan(wm.address ?? 'unknown')}`);
    } else {
      lines.push(`    Status:  ${chalk.red('Disconnected')}`);
    }
    lines.push('');

    // Positions
    try {
      const positions = await this.context.flashClient.getPositions();
      lines.push(chalk.bold('  Positions'));
      lines.push(`    Open: ${chalk.bold(String(positions.length))}`);
      if (positions.length > 0) {
        const totalSize = positions.reduce((s, p) => s + p.sizeUsd, 0);
        lines.push(`    Total Size: ${formatUsd(totalSize)}`);
      }
    } catch {
      lines.push(chalk.bold('  Positions'));
      lines.push(chalk.dim('    Unable to fetch'));
    }
    lines.push('');

    // Memory
    const mem = process.memoryUsage();
    lines.push(chalk.bold('  Memory'));
    lines.push(`    Heap Used:  ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`);
    lines.push(`    Heap Total: ${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`);
    lines.push(`    RSS:        ${(mem.rss / 1024 / 1024).toFixed(1)} MB`);
    lines.push('');

    // Mode
    lines.push(chalk.bold('  Session'));
    lines.push(`    Mode:    ${this.context.simulationMode ? chalk.yellow('Simulation') : chalk.red('Live Trading')}`);
    lines.push(`    Uptime:  ${this.formatUptime()}`);
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Detailed RPC status with per-endpoint breakdown.
   */
  async rpcStatus(): Promise<string> {
    const latency = await this.rpcManager.measureLatency();
    return this.rpcManager.formatStatus(latency);
  }

  /**
   * Test all configured RPC endpoints with latency, slot sync, and recommendation.
   */
  async rpcTest(): Promise<string> {
    const results = await this.rpcManager.checkAllHealth();
    const lines: string[] = [
      theme.titleBlock('RPC DIAGNOSTIC TEST'),
      '',
    ];

    // Find highest slot across all healthy endpoints for sync comparison
    const healthySlots = results.filter((r) => r.healthy && r.slot).map((r) => r.slot!);
    const maxSlot = healthySlots.length > 0 ? Math.max(...healthySlots) : 0;

    let bestIdx = -1;
    let bestScore = -1;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const status = r.healthy ? chalk.green('PASS') : chalk.red('FAIL');
      const isActive = r.url === this.rpcManager.activeEndpoint.url;
      const activeTag = isActive ? chalk.green(' (active)') : '';

      lines.push(`  ${status} ${r.label}${activeTag}`);

      if (r.healthy) {
        lines.push(`    Latency:  ${this.colorLatency(r.latencyMs)}`);
        if (r.slot) {
          const slotDelta = maxSlot - r.slot;
          const syncStatus =
            slotDelta === 0
              ? chalk.green('synced')
              : slotDelta <= 50
                ? chalk.yellow(`${slotDelta} slots behind`)
                : chalk.red(`${slotDelta} slots behind — stale`);
          lines.push(`    Slot:     ${r.slot.toLocaleString()} (${syncStatus})`);
        }
        const fr = this.rpcManager.getFailureRate(r.url);
        if (fr > 0) {
          lines.push(`    Failures: ${this.colorFailureRate(fr)}`);
        }

        // Score: lower latency + synced slot = better
        const latencyScore = Math.max(0, 1 - r.latencyMs / 3000);
        const slotScore = r.slot ? Math.max(0, 1 - (maxSlot - r.slot) / 10) : 0.5;
        const failScore = 1 - this.rpcManager.getFailureRate(r.url);
        const score = latencyScore * 0.4 + slotScore * 0.3 + failScore * 0.3;
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      } else {
        lines.push(`    Error:    ${chalk.red(r.error ?? 'unreachable')}`);
      }
      lines.push('');
    }

    // Recommendation
    lines.push(chalk.dim('  ────────────────────────────────────────'));
    if (bestIdx >= 0) {
      const best = results[bestIdx];
      const isCurrent = best.url === this.rpcManager.activeEndpoint.url;
      if (isCurrent) {
        lines.push(chalk.green(`  Recommended: ${best.label} (current) — ${best.latencyMs}ms`));
      } else {
        lines.push(chalk.yellow(`  Recommended: ${best.label} — ${best.latencyMs}ms (not currently active)`));
      }
    } else {
      lines.push(chalk.red('  No healthy RPC endpoints found'));
    }

    // Tip for users with only public RPC
    const healthyCount = results.filter((r) => r.healthy).length;
    if (healthyCount <= 1 && results.length <= 1) {
      lines.push('');
      lines.push(chalk.dim('  Tip: Add BACKUP_RPC_1 and BACKUP_RPC_2 in .env for automatic failover.'));
      lines.push(chalk.dim('  Free RPCs: Helius (helius.dev), QuickNode (quicknode.com)'));
    }

    lines.push('');
    return lines.join('\n');
  }

  /**
   * Inspect a transaction by signature (legacy command).
   */
  async txInspect(signature: string): Promise<string> {
    return this.txDebug(signature, false);
  }

  /**
   * Transaction debugger — deep protocol-level transaction inspection.
   *
   * Data sources:
   *   Transaction data:  Solana RPC getTransaction()
   *   Program IDs:       Flash SDK PoolConfig
   *   Protocol config:   Flash SDK CustodyAccount (when --state flag)
   *
   * Single RPC call: getTransaction(signature) — no redundant queries.
   */
  async txDebug(signature: string, showState: boolean): Promise<string> {
    const sec = theme.section;
    const pair = theme.pair;
    const dim = theme.dim;
    const sep = theme.separator;

    const lines: string[] = [
      '',
      `  ${theme.accentBold('Transaction Debug')}`,
      `  ${sep(52)}`,
      '',
      pair(
        'Signature',
        chalk.dim(signature.length > 20 ? signature.slice(0, 8) + '...' + signature.slice(-4) : signature),
      ),
      '',
    ];

    try {
      const conn = this.rpcManager.connection;

      // Single RPC call — fetch full transaction with all metadata
      const tx = await conn.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (!tx) {
        lines.push(`  ${chalk.yellow('Status: Not found')}`);
        lines.push(dim(`  Transaction may not have landed or has been pruned.`));
        lines.push('');
        lines.push(dim(`  Explorer: https://solscan.io/tx/${signature}`));
        lines.push('');
        lines.push(`  ${sep(52)}`);
        lines.push(dim(`  Data Source: Solana RPC getTransaction()`));
        lines.push('');
        return lines.join('\n');
      }

      // ─── Status ──────────────────────────────────────────────────
      const failed = tx.meta?.err != null;
      lines.push(`  ${sec('Status')}`);
      if (failed) {
        lines.push(pair('Result', chalk.red('FAILED')));
        lines.push(pair('Error', chalk.red(JSON.stringify(tx.meta!.err))));
      } else {
        lines.push(pair('Result', chalk.green('SUCCESS')));
      }
      lines.push(pair('Slot', tx.slot.toLocaleString()));
      if (tx.blockTime) {
        lines.push(pair('Block Time', new Date(tx.blockTime * 1000).toISOString()));
      }
      lines.push(pair('Fee', `${(tx.meta?.fee ?? 0) / 1e9} SOL`));
      lines.push('');

      // ─── Compute Units ───────────────────────────────────────────
      const cu = tx.meta?.computeUnitsConsumed;
      if (cu !== undefined) {
        // Try to extract CU limit from ComputeBudget instructions in logs
        let cuLimit = 200_000; // default
        const cuLimitLog = tx.meta?.logMessages?.find((l) => l.includes('SetComputeUnitLimit'));
        if (cuLimitLog) {
          const match = cuLimitLog.match(/units\s*=?\s*(\d+)/i);
          if (match) cuLimit = parseInt(match[1], 10);
        }
        lines.push(`  ${sec('Compute Units')}`);
        const utilPct = cuLimit > 0 ? ((cu / cuLimit) * 100).toFixed(1) : '?';
        const cuColor = cu / cuLimit > 0.9 ? chalk.red : cu / cuLimit > 0.7 ? chalk.yellow : chalk.green;
        lines.push(pair('Used', cuColor(`${cu.toLocaleString()} / ${cuLimit.toLocaleString()} (${utilPct}%)`)));
        lines.push('');
      }

      // ─── Instructions ────────────────────────────────────────────
      // Build Flash program ID set for identification
      const flashProgramIds = await this.getFlashProgramIds();
      const accountKeys = tx.transaction.message.getAccountKeys({
        accountKeysFromLookups: tx.meta?.loadedAddresses,
      });

      lines.push(`  ${sec('Instructions')}`);
      lines.push(`  ${sep(52)}`);
      lines.push('');

      const innerInstructions = tx.meta?.innerInstructions ?? [];

      // Get compiled instructions from message
      const compiledIxs = tx.transaction.message.compiledInstructions;
      for (let i = 0; i < compiledIxs.length; i++) {
        const ix = compiledIxs[i];
        const programKey = accountKeys.get(ix.programIdIndex);
        const programId = programKey?.toBase58() ?? 'unknown';
        const isFlash = flashProgramIds.has(programId);

        const programLabel = isFlash ? chalk.cyan('Flash Program') : this.labelProgram(programId);

        lines.push(`  ${chalk.bold(`${i + 1}.`)} ${programLabel}`);
        lines.push(dim(`     ${programId}`));

        // Decode Flash instructions from program logs
        if (isFlash) {
          const decoded = this.decodeFlashInstruction(tx.meta?.logMessages ?? [], i);
          if (decoded.name) {
            lines.push(`     Instruction: ${chalk.cyan(decoded.name)}`);
          }
          for (const detail of decoded.details) {
            lines.push(`     ${detail}`);
          }
        }

        // Show inner instructions count
        const inner = innerInstructions.find((ii) => ii.index === i);
        if (inner && inner.instructions.length > 0) {
          lines.push(dim(`     Inner instructions: ${inner.instructions.length}`));
        }

        lines.push('');
      }

      // ─── Program Logs ────────────────────────────────────────────
      if (tx.meta?.logMessages && tx.meta.logMessages.length > 0) {
        lines.push(`  ${sec('Program Logs')}`);
        lines.push(`  ${sep(52)}`);
        lines.push('');

        // Show Flash program logs with highlighting, others dimmed
        for (const log of tx.meta.logMessages) {
          if (log.includes('Program log:') || log.includes('Error')) {
            // Extract the meaningful part
            const content = log.replace(/^Program log:\s*/, '').trim();
            if (log.toLowerCase().includes('error') || log.toLowerCase().includes('fail')) {
              lines.push(`  ${chalk.red('>')} ${chalk.red(content)}`);
            } else {
              lines.push(`  ${chalk.cyan('>')} ${content}`);
            }
          } else if (log.includes('Program') && log.includes('invoke')) {
            // Program invocation markers — dim
            lines.push(dim(`  ${log}`));
          } else if (log.includes('Program') && (log.includes('success') || log.includes('consumed'))) {
            lines.push(dim(`  ${log}`));
          }
        }
        lines.push('');
      }

      // ─── Decoded Error ───────────────────────────────────────────
      if (failed && tx.meta?.logMessages) {
        const errorInfo = this.decodeFlashError(tx.meta.logMessages);
        if (errorInfo) {
          lines.push(`  ${sec('Decoded Error')}`);
          lines.push(`  ${sep(52)}`);
          lines.push('');
          lines.push(pair('Error Code', chalk.red(errorInfo.code)));
          lines.push(pair('Explanation', errorInfo.explanation));
          lines.push('');
        }
      }

      // ─── Protocol State (--state flag) ───────────────────────────
      if (showState) {
        const stateLines = await this.getProtocolStateForTx(tx.meta?.logMessages ?? []);
        if (stateLines.length > 0) {
          lines.push(`  ${sec('Protocol State')}`);
          lines.push(`  ${sep(52)}`);
          lines.push('');
          for (const sl of stateLines) {
            lines.push(sl);
          }
          lines.push('');
        }
      }

      // ─── Data source labels ──────────────────────────────────────
      lines.push(`  ${sep(52)}`);
      lines.push(dim(`  Explorer: https://solscan.io/tx/${signature}`));
      lines.push('');
      lines.push(`  ${sep(52)}`);
      lines.push(dim(`  Transaction Data:  Solana RPC getTransaction()`));
      lines.push(dim(`  Program IDs:       Flash SDK PoolConfig`));
      if (showState) {
        lines.push(dim(`  Protocol Config:   Flash SDK PoolConfig + CustodyAccount`));
      }
    } catch (e: unknown) {
      lines.push(chalk.red(`  Error: ${getErrorMessage(e)}`));
    }

    lines.push('');
    return lines.join('\n');
  }

  /**
   * Get Flash Trade program IDs from SDK pool configs.
   */
  private async getFlashProgramIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    try {
      const { PoolConfig: SDKPoolConfig } = await import('flash-sdk');
      const { POOL_MARKETS } = await import('../config/index.js');
      const network = this.context.simulationMode ? 'mainnet-beta' : 'mainnet-beta';
      for (const poolName of Object.keys(POOL_MARKETS)) {
        try {
          const pc = SDKPoolConfig.fromIdsByName(poolName, network);
          if (pc.programId) ids.add(pc.programId.toBase58());
          if (pc.perpComposibilityProgramId) ids.add(pc.perpComposibilityProgramId.toBase58());
        } catch {
          /* skip unknown pools */
        }
      }
    } catch {
      /* SDK not available */
    }
    return ids;
  }

  /**
   * Label well-known Solana program IDs.
   */
  private labelProgram(programId: string): string {
    const known: Record<string, string> = {
      '11111111111111111111111111111111': 'System Program',
      TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'Token Program',
      ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated Token Program',
      ComputeBudget111111111111111111111111111111: 'Compute Budget',
      JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter',
      SysvarRent111111111111111111111111111111111: 'Sysvar: Rent',
      SysvarC1ock11111111111111111111111111111111: 'Sysvar: Clock',
    };
    return known[programId] ?? chalk.dim('Unknown Program');
  }

  /**
   * Attempt to decode Flash instruction name and details from program logs.
   * Matches patterns like "Program log: Instruction: OpenPosition" in log output.
   */
  private decodeFlashInstruction(logs: string[], instructionIndex: number): { name: string | null; details: string[] } {
    const details: string[] = [];
    let name: string | null = null;

    // Flash SDK logs instruction names as "Program log: Instruction: <Name>"
    // We need to find the correct instruction scope by tracking invoke/success pairs
    let depth = 0;
    let currentIx = -1;
    let inScope = false;

    for (const log of logs) {
      if (log.includes('invoke [1]')) {
        currentIx++;
        if (currentIx === instructionIndex) {
          inScope = true;
          depth = 1;
        }
        continue;
      }

      if (!inScope) continue;

      if (log.includes('invoke [')) {
        depth++;
        continue;
      }
      if (log.includes('success') || log.includes('failed')) {
        depth--;
        if (depth <= 0) break;
        continue;
      }

      // Extract instruction name
      const ixMatch = log.match(/Instruction:\s*(\w+)/);
      if (ixMatch && !name) {
        name = ixMatch[1];
      }

      // Extract relevant parameters from logs
      const paramMatch = log.match(/Program log:\s*(.+)/);
      if (paramMatch) {
        const content = paramMatch[1].trim();
        // Skip generic invoke/success/consumed messages
        if (!content.startsWith('Instruction:') && content.length < 120) {
          details.push(chalk.dim(content));
        }
      }
    }

    return { name, details: details.slice(0, 5) };
  }

  /**
   * Decode Flash Trade error codes from program logs.
   * Maps common error patterns to human-readable explanations.
   */
  private decodeFlashError(logs: string[]): { code: string; explanation: string } | null {
    const errorMap: Record<string, string> = {
      InsufficientCollateral: 'Collateral does not meet maintenance margin requirement.',
      InsufficientMargin: 'Collateral does not meet maintenance margin requirement.',
      MaxLeverageExceeded: 'Requested leverage exceeds the maximum allowed for this market.',
      PositionNotFound: 'No open position found for the specified market and side.',
      StaleOracle: 'Oracle price data is too old. Pyth feed may be stale.',
      SlippageExceeded: 'Price slippage exceeded the allowed tolerance.',
      MaxUtilizationExceeded: 'Pool utilization would exceed the maximum allowed.',
      InsufficientPoolAmount: 'Pool does not have enough liquidity for this trade size.',
      InvalidPositionState: 'Position is in an invalid state for this operation.',
      MaxOpenInterestExceeded: 'Open interest cap for this market has been reached.',
      BorrowRateExceeded: 'Current borrow rate exceeds the acceptable threshold.',
      InstructionFallbackNotFound: 'Unknown instruction — may be an unsupported operation.',
    };

    for (const log of logs) {
      // Check for "Error Code: <code>" pattern
      const codeMatch = log.match(/Error Code:\s*(\w+)/);
      if (codeMatch) {
        const code = codeMatch[1];
        return {
          code: `FlashError::${code}`,
          explanation: errorMap[code] ?? 'Unknown Flash protocol error.',
        };
      }

      // Check for "custom program error: 0x<hex>" pattern
      const hexMatch = log.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
      if (hexMatch) {
        const hexCode = hexMatch[1];
        return {
          code: `ProgramError(0x${hexCode})`,
          explanation: `Custom program error code 0x${hexCode}. Check Flash Trade error registry.`,
        };
      }

      // Check for error name patterns in log messages
      for (const [errName, explanation] of Object.entries(errorMap)) {
        if (log.includes(errName)) {
          return { code: `FlashError::${errName}`, explanation };
        }
      }
    }

    return null;
  }

  /**
   * Fetch related protocol state for transaction context.
   * Uses Flash SDK PoolConfig and CustodyAccount.
   */
  private async getProtocolStateForTx(logs: string[]): Promise<string[]> {
    const stateLines: string[] = [];

    try {
      const { PoolConfig: SDKPoolConfig, CustodyAccount: SDKCustodyAccount } = await import('flash-sdk');
      const { POOL_MARKETS } = await import('../config/index.js');

      // Try to detect which market the tx was for from logs
      let detectedMarket: string | null = null;
      for (const log of logs) {
        for (const symbols of Object.values(POOL_MARKETS)) {
          for (const sym of symbols) {
            if (log.toUpperCase().includes(sym.toUpperCase()) && sym.length >= 3) {
              detectedMarket = sym.toUpperCase();
              break;
            }
          }
          if (detectedMarket) break;
        }
        if (detectedMarket) break;
      }

      // Show pool configs
      const RATE_POWER = 1_000_000_000;
      for (const poolName of Object.keys(POOL_MARKETS)) {
        try {
          const pc = SDKPoolConfig.fromIdsByName(poolName, 'mainnet-beta');
          stateLines.push(`  ${chalk.bold(poolName)}`);
          stateLines.push(`    Program:  ${chalk.dim(pc.programId.toBase58())}`);

          const markets = pc.markets as Array<{ targetMint: unknown; side: unknown }>;
          stateLines.push(`    Markets:  ${markets.length}`);

          // If we detected a market, show its custody config
          if (detectedMarket) {
            const tokens = pc.tokens as Array<{ symbol: string; mintKey: unknown }>;
            const targetToken = tokens.find((t) => t.symbol.toUpperCase() === detectedMarket);
            if (targetToken) {
              const custodies = pc.custodies as unknown as Array<Record<string, unknown> & { symbol: string }>;
              const custodyInfo = custodies.find((c) => c.symbol === targetToken.symbol);
              if (custodyInfo) {
                try {
                  const custodyKey = custodyInfo.custodyAccount as Parameters<typeof SDKCustodyAccount.from>[0];
                  const perpClient = (
                    (this.context as unknown as Record<string, unknown>).flashClient as
                      | Record<string, unknown>
                      | undefined
                  )?.perpClient;
                  const custodyData = perpClient
                    ? await (
                        perpClient as {
                          program?: { account?: { custody?: { fetch: (key: unknown) => Promise<unknown> } } };
                        }
                      ).program?.account?.custody?.fetch(custodyKey)
                    : null;
                  if (custodyData) {
                    const custodyAcct = SDKCustodyAccount.from(
                      custodyKey,
                      custodyData as Parameters<typeof SDKCustodyAccount.from>[1],
                    );
                    stateLines.push('');
                    stateLines.push(`  ${chalk.bold(`${detectedMarket} Custody`)}`);

                    const openFee = (parseFloat(custodyAcct.fees.openPosition.toString()) / RATE_POWER) * 100;
                    const closeFee = (parseFloat(custodyAcct.fees.closePosition.toString()) / RATE_POWER) * 100;
                    stateLines.push(`    Open Fee:   ${openFee.toFixed(4)}%`);
                    stateLines.push(`    Close Fee:  ${closeFee.toFixed(4)}%`);

                    const BPS_POWER = 10_000;
                    const rawMaxLev = (custodyAcct as unknown as Record<string, Record<string, unknown>>).pricing
                      ?.maxLeverage as unknown;
                    const rawNum =
                      typeof rawMaxLev === 'object' && rawMaxLev !== null && 'toNumber' in rawMaxLev
                        ? (rawMaxLev as { toNumber: () => number }).toNumber()
                        : typeof rawMaxLev === 'number'
                          ? rawMaxLev
                          : 0;
                    if (Number.isFinite(rawNum) && rawNum > 0) {
                      const humanMaxLev = rawNum / BPS_POWER;
                      if (humanMaxLev > 0 && humanMaxLev <= 2000) {
                        stateLines.push(`    Max Leverage: ${humanMaxLev}x`);
                        stateLines.push(`    Maint. Margin: ${((BPS_POWER / rawNum) * 100).toFixed(2)}%`);
                      }
                    }
                  }
                } catch {
                  /* custody fetch is best-effort */
                }
              }
            }
          }
          stateLines.push('');
        } catch {
          /* skip unknown pools */
        }
      }
    } catch {
      stateLines.push(chalk.dim('  Flash SDK not available — cannot load protocol state'));
    }

    return stateLines;
  }

  private colorLatency(ms: number): string {
    if (ms < 0) return chalk.red('unavailable');
    if (ms < 500) return chalk.green(`${ms}ms`);
    if (ms < 1500) return chalk.yellow(`${ms}ms`);
    return chalk.red(`${ms}ms`);
  }

  private colorFailureRate(rate: number): string {
    const pct = `${(rate * 100).toFixed(0)}% fail`;
    if (rate < 0.1) return chalk.green(pct);
    if (rate < 0.3) return chalk.yellow(pct);
    return chalk.red(pct);
  }

  private formatUptime(): string {
    const seconds = Math.floor(process.uptime());
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
  }
}
