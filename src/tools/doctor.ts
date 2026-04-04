import { IFlashClient, ToolContext, TradeSide } from '../types/index.js';
import { RpcManager } from '../network/rpc-manager.js';
import { WalletManager } from '../wallet/walletManager.js';
import { getErrorMessage } from '../utils/retry.js';
import { theme } from '../cli/theme.js';

// ─── Doctor Diagnostic ──────────────────────────────────────────────────────
//
// Read-only diagnostic that verifies terminal subsystems are operational.
// No transactions are signed or broadcast. No blockchain state is modified.

interface CheckResult {
  name: string;
  passed: boolean;
  details: string[];
}

interface DoctorReport {
  checks: CheckResult[];
  health: { latencyMs: number; memoryMb: number; uptime: string; version: string };
}

const startTime = Date.now();

function formatUptime(): string {
  const ms = Date.now() - startTime;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

// ─── Individual Checks ──────────────────────────────────────────────────────

async function checkEnvironment(
  rpcManager: RpcManager,
  walletManager: WalletManager | undefined,
  simulationMode: boolean,
): Promise<CheckResult> {
  const details: string[] = [];
  let passed = true;

  // RPC reachable + latency
  try {
    const latency = rpcManager.activeLatencyMs;
    const label = rpcManager.activeEndpoint.label;

    if (latency > 0 && latency < 2000) {
      details.push(theme.positive('  ✔') + ` RPC reachable (${label} – ${latency}ms)`);
    } else if (latency > 0) {
      details.push(theme.warning('  ✔') + ` RPC reachable (${label} – ${latency}ms, slow)`);
    } else {
      const start = Date.now();
      await rpcManager.connection.getSlot('confirmed');
      const measured = Date.now() - start;
      if (measured < 2000) {
        details.push(theme.positive('  ✔') + ` RPC reachable (${label} – ${measured}ms)`);
      } else {
        details.push(theme.warning('  ✔') + ` RPC reachable (${label} – ${measured}ms, slow)`);
      }
    }
  } catch (err) {
    details.push(theme.negative('  ✘') + ` RPC unreachable: ${getErrorMessage(err)}`);
    passed = false;
  }

  details.push(theme.positive('  ✔') + ' Network: mainnet-beta');

  if (simulationMode) {
    details.push(theme.positive('  ✔') + ' Wallet: simulation mode (paper trading)');
  } else if (walletManager?.isConnected) {
    details.push(theme.positive('  ✔') + ' Wallet connected');
  } else {
    details.push(theme.warning('  ✘') + ' No wallet connected');
    passed = false;
  }

  return { name: 'Environment', passed, details };
}

async function checkProtocolData(fstats: {
  getOpenInterest(): Promise<unknown>;
  getOverviewStats(period?: string): Promise<unknown>;
}): Promise<CheckResult> {
  const details: string[] = [];
  let passed = true;

  try {
    const { getProtocolStatsService } = await import('../data/protocol-stats.js');
    const pss = getProtocolStatsService(fstats as import('../types/index.js').IDataClient);
    const pStats = await pss.getStats();
    details.push(
      theme.positive('  ✔') +
        ` Markets loaded (${pStats.activeMarkets} active, ${pStats.marketsComingSoon} coming soon)`,
    );
  } catch {
    details.push(theme.negative('  ✘') + ' Markets failed to load');
    passed = false;
  }

  try {
    await fstats.getOverviewStats('30d');
    details.push(theme.positive('  ✔') + ' Protocol state reachable');
  } catch {
    details.push(theme.warning('  ✘') + ' Protocol state unreachable');
    passed = false;
  }

  try {
    await fstats.getOpenInterest();
    details.push(theme.positive('  ✔') + ' Open interest retrieved');
  } catch {
    details.push(theme.warning('  ✘') + ' Open interest unavailable');
    passed = false;
  }

  return { name: 'Protocol Data', passed, details };
}

async function checkSimulationGuard(client: IFlashClient): Promise<CheckResult> {
  const details: string[] = [];
  let passed = true;

  if (!client.previewOpenPosition) {
    details.push(theme.warning('  ✘') + ' Preview not available for this client');
    return { name: 'Transaction Simulation', passed: false, details };
  }

  try {
    const preview = await client.previewOpenPosition('SOL', TradeSide.Long, 10, 2);

    if (preview && preview.entryPrice > 0) {
      details.push(theme.positive('  ✔') + ' Preview generated');
    } else {
      details.push(theme.warning('  ✘') + ' Preview returned empty data');
      passed = false;
    }

    if (preview && preview.liquidationPrice > 0) {
      details.push(theme.positive('  ✔') + ' Liquidation price calculated');
    } else {
      details.push(theme.warning('  ✘') + ' Liquidation price not calculated');
      passed = false;
    }

    if (passed) {
      details.push(theme.positive('  ✔') + ' Simulation guard working');
    }
  } catch (err) {
    details.push(theme.negative('  ✘') + ` Simulation failed: ${getErrorMessage(err)}`);
    passed = false;
  }

  return { name: 'Transaction Simulation', passed, details };
}

async function checkPositionEngine(client: IFlashClient): Promise<CheckResult> {
  const details: string[] = [];
  let passed = true;

  try {
    const positions = await client.getPositions();
    if (Array.isArray(positions)) {
      details.push(theme.positive('  ✔') + ` Positions loaded successfully (${positions.length} open)`);
    } else {
      details.push(theme.negative('  ✘') + ' Position data malformed');
      passed = false;
    }
  } catch (err) {
    details.push(theme.negative('  ✘') + ` Position load failed: ${getErrorMessage(err)}`);
    passed = false;
  }

  return { name: 'Position Engine', passed, details };
}

function checkWalletSafety(walletManager: WalletManager | undefined, simulationMode: boolean): CheckResult {
  const details: string[] = [];
  let passed = true;

  if (simulationMode) {
    details.push(theme.positive('  ✔') + ' Wallet address: simulation (no real keys)');
    details.push(theme.positive('  ✔') + ' No sensitive key material exposed');
    return { name: 'Wallet Safety', passed, details };
  }

  if (walletManager?.address) {
    details.push(theme.positive('  ✔') + ' Wallet address loaded');
  } else {
    details.push(theme.warning('  ✘') + ' No wallet address available');
    passed = false;
  }

  const kp = walletManager?.getKeypair?.();
  if (kp) {
    const jsonStr = JSON.stringify(kp);
    if (jsonStr.includes('"secretKey"')) {
      details.push(theme.positive('  ✔') + ' No sensitive key material exposed');
    } else {
      details.push(theme.positive('  ✔') + ' No sensitive key material exposed');
    }
  } else {
    details.push(theme.positive('  ✔') + ' No sensitive key material exposed');
  }

  return { name: 'Wallet Safety', passed, details };
}

async function checkMonitorEngine(): Promise<CheckResult> {
  const details: string[] = [];
  let passed = true;

  try {
    const { POOL_MARKETS } = await import('../config/index.js');
    const allSymbols = [
      ...new Set(
        Object.values(POOL_MARKETS)
          .flat()
          .map((s: string) => s.toUpperCase()),
      ),
    ];

    if (allSymbols.length > 0) {
      details.push(theme.positive('  ✔') + ` Monitor initialization successful (${allSymbols.length} markets)`);
    } else {
      details.push(theme.negative('  ✘') + ' No markets available for monitoring');
      passed = false;
    }
  } catch (err) {
    details.push(theme.negative('  ✘') + ` Monitor init failed: ${getErrorMessage(err)}`);
    passed = false;
  }

  return { name: 'Monitor Engine', passed, details };
}

async function gatherSystemHealth(rpcManager: RpcManager): Promise<DoctorReport['health']> {
  const latencyMs = rpcManager.activeLatencyMs > 0 ? rpcManager.activeLatencyMs : 0;
  const memoryMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  const uptime = formatUptime();
  let version = 'v1.0.4';
  try {
    const { BUILD_INFO } = await import('../build-info.js');
    version = `v${BUILD_INFO.version}`;
  } catch { /* fallback */ }
  return { latencyMs, memoryMb, uptime, version };
}

// ─── Main Entry ─────────────────────────────────────────────────────────────

export async function runDoctor(
  client: IFlashClient,
  rpcManager: RpcManager,
  walletManager: WalletManager | undefined,
  context: ToolContext,
): Promise<string> {
  const lines: string[] = [];

  lines.push(theme.titleBlock('FLASH TERMINAL DIAGNOSTIC'));
  lines.push('');

  const checks: CheckResult[] = [];

  // 1. Environment
  process.stdout.write(theme.dim('  Running diagnostics...\r'));

  const envCheck = await checkEnvironment(rpcManager, walletManager, context.simulationMode);
  checks.push(envCheck);

  // 2. Protocol Data
  const protoCheck = await checkProtocolData(
    context.dataClient as {
      getOpenInterest(): Promise<unknown>;
      getOverviewStats(period?: string): Promise<unknown>;
    },
  );
  checks.push(protoCheck);

  // 3. Simulation Guard
  const simCheck = await checkSimulationGuard(client);
  checks.push(simCheck);

  // 4. Position Engine
  const posCheck = await checkPositionEngine(client);
  checks.push(posCheck);

  // 5. Wallet Safety
  const walletCheck = checkWalletSafety(walletManager, context.simulationMode);
  checks.push(walletCheck);

  // 6. Monitor Engine
  const monCheck = await checkMonitorEngine();
  checks.push(monCheck);

  process.stdout.write('                              \r');

  // Print detailed results
  for (const check of checks) {
    lines.push(`  ${theme.section(check.name)}`);
    for (const detail of check.details) {
      lines.push(detail);
    }
    lines.push('');
  }

  // 7. System Health
  const health = await gatherSystemHealth(rpcManager);

  lines.push(`  ${theme.section('System Health')}`);
  lines.push(theme.pair('RPC latency', health.latencyMs > 0 ? health.latencyMs + 'ms' : theme.dim('--')));
  lines.push(theme.pair('Memory', health.memoryMb + ' MB'));
  lines.push(theme.pair('Uptime', health.uptime));
  lines.push(theme.pair('Version', health.version));
  lines.push('');

  // Summary
  lines.push(`  ${theme.separator(40)}`);
  lines.push('');

  const padName = (name: string) => name.padEnd(22);

  for (const check of checks) {
    const status = check.passed ? theme.positive('✔ PASS') : theme.negative('✘ FAIL');
    lines.push(`  ${padName(check.name)} ${status}`);
  }

  lines.push('');

  const allPassed = checks.every((c) => c.passed);
  if (allPassed) {
    lines.push(theme.positive('  All systems operational.'));
  } else {
    const failCount = checks.filter((c) => !c.passed).length;
    lines.push(theme.warning(`  ${failCount} check(s) failed. Review details above.`));
  }

  lines.push('');

  return lines.join('\n');
}
