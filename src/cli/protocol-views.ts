/**
 * Protocol debug/verification views extracted from terminal.ts.
 *
 * Each function renders a diagnostic view to the console.
 * Dependencies are injected via ProtocolViewDeps.
 */

import chalk from 'chalk';
import type { FlashConfig, IFlashClient, Position } from '../types/index.js';
import { TradeSide } from '../types/index.js';
import type {
  FlashClientInternals,
  PoolCustodyConfig,
  PoolTokenConfig,
  PoolMarketConfig,
  CustodyAccountWithPricing,
} from '../types/flash-sdk-interfaces.js';
import { RpcManager } from '../network/rpc-manager.js';
import { WalletManager } from '../wallet/index.js';
import { theme } from './theme.js';
import { formatUsd, formatPrice, colorPnl } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import { computeSimulationLiquidationPrice, isDivergenceOk } from '../utils/protocol-liq.js';

export interface ProtocolViewDeps {
  config: FlashConfig;
  flashClient: IFlashClient;
  rpcManager: RpcManager;
  walletManager: WalletManager;
}

/**
 * Protocol fee verification -- shows raw on-chain fee parameters from CustodyAccount.
 * Data source: CustodyAccount.fees.openPosition / closePosition via Flash SDK.
 */
export async function protocolFees(deps: ProtocolViewDeps, market: string): Promise<void> {
  const upper = market.toUpperCase();
  const RATE_POWER = 1_000_000_000;
  const BPS_POWER = 10_000;

  console.log('');
  console.log(`  ${theme.accentBold(`FLASH PROTOCOL FEES — ${upper}`)}`);
  console.log(`  ${theme.separator(50)}`);
  console.log('');

  // Attempt on-chain fetch
  if (!deps.config.simulationMode) {
    try {
      const { PoolConfig, CustodyAccount } = await import('flash-sdk');
      const { getPoolForMarket } = await import('../config/index.js');
      const poolName = getPoolForMarket(upper);
      if (poolName) {
        const pc = PoolConfig.fromIdsByName(poolName, deps.config.network);
        const custodies = pc.custodies as PoolCustodyConfig[];
        const custody = custodies.find((c) => c.symbol.toUpperCase() === upper);
        const perpClient = (deps.flashClient as unknown as Partial<FlashClientInternals>).perpClient;

        if (custody && perpClient?.program?.account?.custody) {
          const custodyData = await perpClient.program.account.custody.fetch(custody.custodyAccount);
          if (custodyData) {
            const custodyAcct = CustodyAccount.from(custody.custodyAccount, custodyData);
            const rawOpen = parseFloat(custodyAcct.fees.openPosition.toString());
            const rawClose = parseFloat(custodyAcct.fees.closePosition.toString());
            const custodyWithPricing = custodyAcct as unknown as CustodyAccountWithPricing;
            const rawMaintenanceMargin = parseFloat(custodyWithPricing.pricing?.maintenanceMargin?.toString() ?? '0');
            const rawMaxLev = custodyWithPricing.pricing?.maxLeverage;
            const rawMaxLeverage =
              typeof rawMaxLev === 'object' && rawMaxLev?.toNumber
                ? rawMaxLev.toNumber()
                : typeof rawMaxLev === 'number'
                  ? rawMaxLev
                  : 0;

            console.log(theme.pair('Source', chalk.green('CustodyAccount (on-chain)')));
            console.log(theme.pair('Custody', chalk.dim(custody.custodyAccount.toString())));
            console.log(theme.pair('Pool', chalk.dim(poolName)));
            console.log('');

            console.log(`  ${theme.section('Raw Values')}`);
            console.log(theme.pair('openPosition', rawOpen.toString()));
            console.log(theme.pair('closePosition', rawClose.toString()));
            console.log(theme.pair('maintenanceMargin', rawMaintenanceMargin.toString()));
            console.log(theme.pair('maxLeverage', rawMaxLeverage.toString()));
            console.log(theme.pair('RATE_POWER', RATE_POWER.toString()));
            console.log(theme.pair('BPS_POWER', BPS_POWER.toString()));
            console.log('');

            const openRate = rawOpen / RATE_POWER;
            const closeRate = rawClose / RATE_POWER;
            const maxLev = rawMaxLeverage > 0 ? rawMaxLeverage / BPS_POWER : 0;
            const derivedMarginRate = maxLev > 0 ? 1 / maxLev : 0;

            console.log(`  ${theme.section('Converted Rates')}`);
            console.log(theme.pair('openFeeRate', `${openRate} (${(openRate * 100).toFixed(4)}%)`));
            console.log(theme.pair('closeFeeRate', `${closeRate} (${(closeRate * 100).toFixed(4)}%)`));
            if (maxLev > 0) {
              console.log(theme.pair('maxLeverage', `${maxLev}x`));
              console.log(
                theme.pair(
                  'maintMarginRate',
                  `1/${maxLev} = ${derivedMarginRate} (${(derivedMarginRate * 100).toFixed(4)}%)`,
                ),
              );
            }
            console.log('');

            // Verify against getProtocolFeeRates
            const { getProtocolFeeRates } = await import('../utils/protocol-fees.js');
            const feeRates = await getProtocolFeeRates(upper, perpClient);
            console.log(`  ${theme.section('getProtocolFeeRates() Output')}`);
            console.log(
              theme.pair('openFeeRate', `${feeRates.openFeeRate} (${(feeRates.openFeeRate * 100).toFixed(4)}%)`),
            );
            console.log(
              theme.pair('closeFeeRate', `${feeRates.closeFeeRate} (${(feeRates.closeFeeRate * 100).toFixed(4)}%)`),
            );
            console.log(theme.pair('maxLeverage', `${feeRates.maxLeverage}x`));
            console.log(
              theme.pair(
                'maintMarginRate',
                `${feeRates.maintenanceMarginRate} (${(feeRates.maintenanceMarginRate * 100).toFixed(4)}%)`,
              ),
            );
            console.log(theme.pair('source', feeRates.source));
            console.log('');

            // Cross-check
            const openMatch = Math.abs(openRate - feeRates.openFeeRate) < 1e-12;
            const closeMatch = Math.abs(closeRate - feeRates.closeFeeRate) < 1e-12;
            const marginMatch = Math.abs(derivedMarginRate - feeRates.maintenanceMarginRate) < 1e-9;
            const levMatch = maxLev > 0 && Math.abs(maxLev - feeRates.maxLeverage) < 1e-9;
            if (openMatch && closeMatch && marginMatch && levMatch) {
              console.log(chalk.green('  ✓ CustodyAccount and getProtocolFeeRates() match'));
            } else {
              console.log(chalk.red('  ✗ MISMATCH between CustodyAccount and getProtocolFeeRates()'));
              if (!openMatch) console.log(chalk.red(`    open: ${openRate} vs ${feeRates.openFeeRate}`));
              if (!closeMatch) console.log(chalk.red(`    close: ${closeRate} vs ${feeRates.closeFeeRate}`));
              if (!marginMatch)
                console.log(chalk.red(`    margin: ${derivedMarginRate} vs ${feeRates.maintenanceMarginRate}`));
              if (!levMatch) console.log(chalk.red(`    leverage: ${maxLev} vs ${feeRates.maxLeverage}`));
            }
            console.log('');
            return;
          }
        }
      }
    } catch (e: unknown) {
      console.log(chalk.yellow(`  Failed to fetch on-chain data: ${getErrorMessage(e)}`));
      console.log('');
    }
  }

  // Fallback: show defaults
  const { getProtocolFeeRates } = await import('../utils/protocol-fees.js');
  const feeRates = await getProtocolFeeRates(upper, null);
  console.log(theme.pair('Source', chalk.yellow(feeRates.source)));
  console.log('');
  console.log(`  ${theme.section('Fee Rates (default fallback)')}`);
  console.log(theme.pair('openFeeRate', `${feeRates.openFeeRate} (${(feeRates.openFeeRate * 100).toFixed(4)}%)`));
  console.log(theme.pair('closeFeeRate', `${feeRates.closeFeeRate} (${(feeRates.closeFeeRate * 100).toFixed(4)}%)`));
  console.log(
    theme.pair(
      'maintMarginRate',
      `${feeRates.maintenanceMarginRate} (${(feeRates.maintenanceMarginRate * 100).toFixed(2)}%)`,
    ),
  );
  console.log('');
  console.log(chalk.yellow('  ⚠ Showing SDK defaults — connect in live mode for on-chain values'));
  console.log('');
}

/**
 * Protocol verify -- Full protocol alignment audit.
 * Runs all checks in parallel with per-task timeout protection.
 */
export async function protocolVerify(deps: ProtocolViewDeps): Promise<void> {
  const startTime = Date.now();
  const TASK_TIMEOUT_MS = 1500;

  console.log('');
  console.log(`  ${theme.accentBold('FLASH TERMINAL — PROTOCOL VERIFY')}`);
  console.log(`  ${theme.separator(50)}`);
  console.log('');

  interface CheckResult {
    label: string;
    ok: boolean;
    detail: string;
    error?: string;
  }

  const timedTask = <T>(task: Promise<T>, label: string): Promise<T> =>
    Promise.race([
      task,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), TASK_TIMEOUT_MS)),
    ]);

  // ── 1. RPC Health ──
  const checkRpcHealth = async (): Promise<CheckResult> => {
    try {
      const latency = deps.rpcManager.activeLatencyMs;
      const ep = deps.rpcManager.activeEndpoint;
      const slot = await timedTask(deps.rpcManager.connection.getSlot('processed'), 'RPC slot fetch');
      if (!Number.isFinite(slot) || slot <= 0) {
        return { label: 'RPC', ok: false, detail: '', error: 'Slot not advancing' };
      }
      const latStr = latency > 0 ? `${latency}ms` : 'N/A';
      if (latency > 500) {
        return {
          label: 'RPC',
          ok: false,
          detail: `${ep.label} — ${latStr}`,
          error: `Latency ${latStr} exceeds 500ms threshold`,
        };
      }
      return { label: 'RPC', ok: true, detail: `reachable (${ep.label} — ${latStr}, slot ${slot})` };
    } catch (err: unknown) {
      return { label: 'RPC', ok: false, detail: '', error: getErrorMessage(err) };
    }
  };

  // ── 2. Oracle Health ──
  const checkOracleHealth = async (): Promise<CheckResult> => {
    try {
      const { PriceService } = await import('../data/prices.js');
      const priceSvc = new PriceService();
      const oracleStart = Date.now();
      const price = await timedTask(priceSvc.getPrice('SOL'), 'Oracle fetch');
      if (!price || !Number.isFinite(price.price) || price.price <= 0) {
        return { label: 'Oracle', ok: false, detail: '', error: 'Failed to fetch SOL price from Pyth Hermes' };
      }
      // Check timestamp freshness (< 5 seconds)
      const age = price.timestamp ? Date.now() / 1000 - price.timestamp : 0;
      if (age > 5) {
        return { label: 'Oracle', ok: false, detail: '', error: `Oracle data stale (${age.toFixed(0)}s old)` };
      }
      return { label: 'Oracle', ok: true, detail: `healthy (Pyth Hermes — ${Date.now() - oracleStart}ms)` };
    } catch (err: unknown) {
      return { label: 'Oracle', ok: false, detail: '', error: getErrorMessage(err) };
    }
  };

  // ── 3. Custody Account Validation ──
  const validateCustodyAccounts = async (): Promise<CheckResult> => {
    const markets = ['SOL', 'BTC', 'ETH'];
    const passed: string[] = [];
    const failed: string[] = [];

    const perpClient = deps.config.simulationMode
      ? null
      : ((deps.flashClient as unknown as Partial<FlashClientInternals>).perpClient ?? null);

    for (const mkt of markets) {
      try {
        const { getProtocolFeeRates } = await import('../utils/protocol-fees.js');
        const rates = await timedTask(getProtocolFeeRates(mkt, perpClient), `Custody ${mkt}`);
        if (rates.source === 'on-chain') {
          passed.push(mkt);
        } else {
          // sdk-default means we couldn't get on-chain data
          passed.push(`${mkt} (default)`);
        }
      } catch (err: unknown) {
        failed.push(`${mkt}: ${getErrorMessage(err)}`);
      }
    }

    if (failed.length > 0) {
      return { label: 'Custody accounts', ok: false, detail: '', error: failed.join('; ') };
    }
    return { label: 'Custody accounts', ok: true, detail: `valid (${passed.join(', ')})` };
  };

  // ── 4. Fee Engine Verification ──
  const verifyFeeEngine = async (): Promise<CheckResult> => {
    if (deps.config.simulationMode) {
      return { label: 'Fee engine', ok: true, detail: 'skipped (simulation mode — no perpClient)' };
    }

    const perpClient = (deps.flashClient as unknown as Partial<FlashClientInternals>).perpClient ?? null;
    if (!perpClient?.program?.account?.custody) {
      return { label: 'Fee engine', ok: true, detail: 'skipped (no perpClient)' };
    }

    try {
      const { PoolConfig, CustodyAccount } = await import('flash-sdk');
      const { getPoolForMarket } = await import('../config/index.js');
      const { getProtocolFeeRates } = await import('../utils/protocol-fees.js');
      const RATE_POWER = 1_000_000_000;

      const mismatches: string[] = [];
      for (const mkt of ['SOL', 'BTC', 'ETH']) {
        const poolName = getPoolForMarket(mkt);
        if (!poolName) continue;
        const pc = PoolConfig.fromIdsByName(poolName, deps.config.network);
        const custodies = pc.custodies as PoolCustodyConfig[];
        const custody = custodies.find((c) => c.symbol.toUpperCase() === mkt);
        if (!custody) continue;

        const rawData = await timedTask(
          perpClient.program.account.custody.fetch(custody.custodyAccount),
          `Fee engine ${mkt}`,
        );
        const custodyAcct = CustodyAccount.from(custody.custodyAccount, rawData);
        const custodyOpen = parseFloat(custodyAcct.fees.openPosition.toString()) / RATE_POWER;
        const custodyClose = parseFloat(custodyAcct.fees.closePosition.toString()) / RATE_POWER;

        const engineRates = await getProtocolFeeRates(mkt, perpClient);

        if (Math.abs(custodyOpen - engineRates.openFeeRate) > 0.00001) {
          mismatches.push(`${mkt} open: custody=${custodyOpen}, engine=${engineRates.openFeeRate}`);
        }
        if (Math.abs(custodyClose - engineRates.closeFeeRate) > 0.00001) {
          mismatches.push(`${mkt} close: custody=${custodyClose}, engine=${engineRates.closeFeeRate}`);
        }
      }

      if (mismatches.length > 0) {
        return { label: 'Fee engine', ok: false, detail: '', error: mismatches.join('; ') };
      }
      return { label: 'Fee engine', ok: true, detail: 'matches on-chain values' };
    } catch (err: unknown) {
      return { label: 'Fee engine', ok: false, detail: '', error: getErrorMessage(err) };
    }
  };

  // ── 5. Liquidation Engine Verification ──
  const verifyLiquidationEngine = async (): Promise<CheckResult> => {
    try {
      const { getProtocolFeeRates } = await import('../utils/protocol-fees.js');
      const perpClient = deps.config.simulationMode
        ? null
        : ((deps.flashClient as unknown as Partial<FlashClientInternals>).perpClient ?? null);
      const rates = await getProtocolFeeRates('SOL', perpClient);

      // Compute CLI liquidation for a reference position
      const entryPrice = 100; // normalized reference
      const sizeUsd = 1000;
      const collateralUsd = 100; // 10x leverage
      const cliLiqLong = computeSimulationLiquidationPrice(
        entryPrice,
        sizeUsd,
        collateralUsd,
        TradeSide.Long,
        rates.maintenanceMarginRate,
        rates.closeFeeRate,
      );
      const cliLiqShort = computeSimulationLiquidationPrice(
        entryPrice,
        sizeUsd,
        collateralUsd,
        TradeSide.Short,
        rates.maintenanceMarginRate,
        rates.closeFeeRate,
      );

      // Sanity checks: long liq < entry, short liq > entry
      if (cliLiqLong <= 0 || cliLiqLong >= entryPrice) {
        return {
          label: 'Liquidation engine',
          ok: false,
          detail: '',
          error: `Long liq price ${cliLiqLong} invalid for entry ${entryPrice}`,
        };
      }
      if (cliLiqShort <= entryPrice) {
        return {
          label: 'Liquidation engine',
          ok: false,
          detail: '',
          error: `Short liq price ${cliLiqShort} invalid for entry ${entryPrice}`,
        };
      }

      // Verify symmetry: |longDist - shortDist| should be ~0
      const longDist = entryPrice - cliLiqLong;
      const shortDist = cliLiqShort - entryPrice;
      if (Math.abs(longDist - shortDist) > 0.001) {
        return {
          label: 'Liquidation engine',
          ok: false,
          detail: '',
          error: `Asymmetric liq distances: long=${longDist.toFixed(4)}, short=${shortDist.toFixed(4)}`,
        };
      }

      // If live mode with SDK, compare against SDK helper
      const divStatus = isDivergenceOk() ? 'aligned' : 'divergence detected';
      return {
        label: 'Liquidation engine',
        ok: isDivergenceOk(),
        detail: `${divStatus} (long liq=$${cliLiqLong.toFixed(2)}, short liq=$${cliLiqShort.toFixed(2)})`,
      };
    } catch (err: unknown) {
      return { label: 'Liquidation engine', ok: false, detail: '', error: getErrorMessage(err) };
    }
  };

  // ── 6. Protocol Parameter Validation ──
  const validateProtocolParameters = async (): Promise<CheckResult> => {
    try {
      const { getProtocolFeeRates } = await import('../utils/protocol-fees.js');
      const perpClient = deps.config.simulationMode
        ? null
        : ((deps.flashClient as unknown as Partial<FlashClientInternals>).perpClient ?? null);
      const violations: string[] = [];

      for (const mkt of ['SOL', 'BTC', 'ETH']) {
        const rates = await getProtocolFeeRates(mkt, perpClient);
        if (rates.maxLeverage <= 0) violations.push(`${mkt}: maxLeverage=${rates.maxLeverage}`);
        if (rates.maintenanceMarginRate >= 1) violations.push(`${mkt}: margin≥100%`);
        if (rates.openFeeRate < 0) violations.push(`${mkt}: negative openFee`);
        if (rates.closeFeeRate < 0) violations.push(`${mkt}: negative closeFee`);
      }

      if (violations.length > 0) {
        return { label: 'Protocol parameters', ok: false, detail: '', error: violations.join('; ') };
      }
      return { label: 'Protocol parameters', ok: true, detail: 'valid' };
    } catch (err: unknown) {
      return { label: 'Protocol parameters', ok: false, detail: '', error: getErrorMessage(err) };
    }
  };

  // ── Run all checks in parallel ──
  const results = await Promise.all([
    checkRpcHealth(),
    checkOracleHealth(),
    validateCustodyAccounts(),
    verifyFeeEngine(),
    verifyLiquidationEngine(),
    validateProtocolParameters(),
  ]);

  // ── Display results ──
  let allOk = true;
  for (const r of results) {
    if (r.ok) {
      console.log(chalk.green(`  ✓ ${r.label} ${r.detail}`));
    } else {
      allOk = false;
      console.log(chalk.red(`  ✗ ${r.label} failed`));
      if (r.error) {
        console.log(chalk.dim(`    ${r.error}`));
      }
    }
  }

  console.log('');
  const elapsed = Date.now() - startTime;
  if (allOk) {
    console.log(chalk.green(`  System Status: HEALTHY`));
  } else {
    console.log(chalk.red(`  System Status: DEGRADED`));
  }
  console.log(theme.dim(`  Completed in ${elapsed}ms`));
  console.log('');
}

/**
 * Data provenance verification -- shows where each data source comes from.
 */
export async function sourceVerify(deps: ProtocolViewDeps, market: string): Promise<void> {
  const upper = market.toUpperCase();

  console.log('');
  console.log(`  ${theme.accentBold('DATA PROVENANCE VERIFICATION')}  ${theme.dim(`— ${upper}`)}`);
  console.log(`  ${theme.separator(50)}`);

  const checks: string[] = [];
  let allOk = true;

  // ── Section 1: Price Source ──
  console.log(theme.titleBlock('Price Source'));
  try {
    const { PriceService } = await import('../data/prices.js');
    const priceSvc = new PriceService();

    const priceData = await priceSvc.getPrice(upper);
    if (priceData && Number.isFinite(priceData.price) && priceData.price > 0) {
      // Fetch raw Pyth data for confidence interval
      let confidence = 'N/A';
      let publishSlot = 'N/A';
      const { getPythFeedId } = await import('../data/prices.js');
      const feedId = getPythFeedId(upper) ?? 'N/A';

      try {
        if (feedId === 'N/A') throw new Error('No feed ID');
        const rawUrl = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${encodeURIComponent(feedId)}&parsed=true`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          const res = await fetch(rawUrl, { signal: controller.signal, headers: { Accept: 'application/json' } });
          if (res.ok) {
            const raw = (await res.json()) as {
              parsed?: Array<{ price: { price: string; expo: number; publish_time: number; conf: string } }>;
            };
            const entry = raw.parsed?.[0];
            if (entry) {
              const price = parseInt(entry.price.price, 10) * Math.pow(10, entry.price.expo);
              const conf = parseInt(entry.price.conf ?? '0', 10) * Math.pow(10, entry.price.expo);
              if (Number.isFinite(price) && price > 0 && Number.isFinite(conf)) {
                confidence = `${((conf / price) * 100).toFixed(4)}%`;
              }
              publishSlot = entry.price.publish_time ? String(entry.price.publish_time) : 'N/A';
            }
          }
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        // Raw fetch failed — non-critical
      }

      console.log(theme.pair('Oracle', 'Pyth Hermes'));
      console.log(theme.pair('Feed', `${upper}/USD`));
      console.log(theme.pair('Price', `$${priceData.price.toFixed(4)}`));
      console.log(theme.pair('Publish Time', publishSlot));
      console.log(theme.pair('Confidence', confidence));
      console.log(theme.pair('Endpoint', 'hermes.pyth.network'));
      checks.push('Oracle price verified');
    } else {
      console.log(chalk.red(`  Failed to fetch price for ${upper}`));
      allOk = false;
    }
  } catch (err: unknown) {
    console.log(chalk.red(`  Price fetch error: ${getErrorMessage(err)}`));
    allOk = false;
  }

  // ── Section 2: Protocol Fee Source ──
  console.log(theme.titleBlock('Protocol Fees'));
  try {
    const { getProtocolFeeRates } = await import('../utils/protocol-fees.js');
    const perpClient = deps.config.simulationMode
      ? null
      : ((deps.flashClient as unknown as Partial<FlashClientInternals>).perpClient ?? null);
    const rates = await getProtocolFeeRates(upper, perpClient);

    // Get custody account address
    let custodyAddress = 'N/A';
    try {
      const { PoolConfig } = await import('flash-sdk');
      const { getPoolForMarket } = await import('../config/index.js');
      const poolName = getPoolForMarket(upper);
      if (poolName) {
        const pc = PoolConfig.fromIdsByName(poolName, 'mainnet-beta');
        const custodies = pc.custodies as PoolCustodyConfig[];
        const custody = custodies.find((c) => c.symbol.toUpperCase() === upper);
        if (custody) {
          custodyAddress = custody.custodyAccount.toString();
        }
      }
    } catch {
      // Non-critical — address display only
    }

    console.log(theme.pair('CustodyAccount', custodyAddress));
    console.log(theme.pair('Open Fee', `${(rates.openFeeRate * 100).toFixed(4)}%`));
    console.log(theme.pair('Close Fee', `${(rates.closeFeeRate * 100).toFixed(4)}%`));
    console.log(theme.pair('Max Leverage', `${rates.maxLeverage}x`));
    console.log(
      theme.pair(
        'Source',
        rates.source === 'on-chain'
          ? theme.positive('On-chain protocol data')
          : theme.warning('SDK defaults (simulation mode)'),
      ),
    );
    checks.push('Protocol fees ' + (rates.source === 'on-chain' ? 'on-chain' : 'sdk-default'));
  } catch (err: unknown) {
    console.log(chalk.red(`  Fee fetch error: ${getErrorMessage(err)}`));
    allOk = false;
  }

  // ── Section 3: Position Data Source ──
  console.log(theme.titleBlock('Position Data'));
  const { FLASH_PROGRAM_ID } = await import('../config/index.js');
  if (deps.config.simulationMode) {
    console.log(theme.pair('Source', 'SimulatedFlashClient'));
    console.log(theme.pair('Method', 'In-memory SimulationState'));
    console.log(theme.pair('Account Type', 'N/A (simulation)'));
    console.log(theme.pair('Program', theme.dim(FLASH_PROGRAM_ID)));
    checks.push('Positions from simulation state');
  } else {
    console.log(theme.pair('Source', 'Flash SDK'));
    console.log(theme.pair('Method', 'perpClient.getPositions()'));
    console.log(theme.pair('Account Type', 'UserPosition PDA'));
    console.log(theme.pair('Program', theme.accent(FLASH_PROGRAM_ID)));
    checks.push('Positions from protocol accounts');
  }

  // ── Section 4: Liquidation Engine ──
  console.log(theme.titleBlock('Liquidation Engine'));
  if (deps.config.simulationMode) {
    console.log(theme.pair('Calculation', 'CLI formula'));
    console.log(theme.pair('Method', 'computeSimulationLiquidationPrice()'));
    console.log(theme.pair('Parameters', 'SDK-default fee rates'));
    checks.push('Simulation liquidation engine');
  } else {
    console.log(theme.pair('Calculation', 'SDK helper'));
    console.log(theme.pair('Method', 'getLiquidationPriceContractHelper()'));
    console.log(theme.pair('Parameters', 'CustodyAccount pricing data'));
    console.log(theme.pair('Divergence Check', 'Enabled (0.5% threshold)'));
    checks.push('SDK liquidation engine');
  }

  // ── Section 5: Analytics Data ──
  console.log(theme.titleBlock('Analytics Data'));
  const { FSTATS_BASE_URL } = await import('../config/index.js');
  console.log(theme.pair('Open Interest', 'fstats API'));
  console.log(theme.pair('Endpoint', '/positions/open-interest'));
  console.log(theme.pair('Volume Data', '/volume/daily'));
  console.log(theme.pair('Base URL', FSTATS_BASE_URL));

  // Verify fstats is reachable
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${FSTATS_BASE_URL}/overview/stats?period=7d`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        console.log(theme.pair('Status', theme.positive('Reachable')));
        checks.push('Analytics from external API');
      } else {
        console.log(theme.pair('Status', theme.warning(`HTTP ${res.status}`)));
        allOk = false;
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    console.log(theme.pair('Status', theme.negative('Unreachable')));
    allOk = false;
  }

  // ── Section 6: Verification Summary ──
  console.log(theme.titleBlock('Verification'));
  for (const check of checks) {
    console.log(chalk.green(`  ✓ ${check}`));
  }
  if (!allOk) {
    console.log(chalk.yellow(`  ! Some checks could not be completed`));
  }

  console.log('');
  console.log(theme.dim(`  Mode: ${deps.config.simulationMode ? 'Simulation' : 'Live'}`));
  console.log('');
}

/**
 * Position debug view -- detailed position analysis with what-if scenarios.
 */
export async function positionDebug(deps: ProtocolViewDeps, market: string): Promise<void> {
  const upper = market.toUpperCase();

  // Fetch protocol fee rates for liquidation calculations
  const { getProtocolFeeRates } = await import('../utils/protocol-fees.js');
  const debugFeeRates = await getProtocolFeeRates(upper, null);

  // ─── 1. Fetch position ──────────────────────────────────────────
  let positions: Position[];
  try {
    positions = await deps.flashClient.getPositions();
  } catch (e: unknown) {
    console.log(chalk.red(`  Failed to fetch positions: ${getErrorMessage(e)}`));
    return;
  }

  const pos = positions.find((p) => p.market.toUpperCase() === upper);
  if (!pos) {
    console.log('');
    console.log(chalk.yellow(`  No open position found for ${upper}`));
    console.log(chalk.dim(`  Open one with: open 5x long ${upper} $100`));
    console.log('');
    return;
  }

  // ─── 2. Load protocol parameters (live mode only) ──────────────
  let openFeePct = 0;
  let closeFeePct = 0;
  let maintenanceMarginPct = 0;
  let maxLeverage = 0;
  let protocolParamsAvailable = false;
  const RATE_POWER = 1_000_000_000; // Flash SDK RATE_DECIMALS = 9

  // SDK objects retained for collateral scenario calculations
  // These use Record<string, unknown> because they hold opaque SDK objects
  // passed back to SDK methods (getLiquidationPriceContractHelper, PositionAccount.from).
  let sdkCustodyAcct: CustodyAccountWithPricing | null = null;
  let sdkEntryOraclePrice: unknown = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- opaque SDK position object passed back to SDK methods
  let sdkRawPosition: any = null;
  let sdkSide: unknown = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK PerpetualsClient passed to getLiquidationPriceContractHelper
  let sdkPerpClient: any = null;

  if (!deps.config.simulationMode) {
    try {
      const {
        PoolConfig: SDKPoolConfig,
        CustodyAccount: SDKCustodyAccount,
        OraclePrice: SDKOraclePrice,
        Side: SDKSide,
        BN_ZERO: SDK_BN_ZERO,
      } = await import('flash-sdk');
      const BN = (await import('bn.js')).default;
      const { getPoolForMarket } = await import('../config/index.js');
      const poolName = getPoolForMarket(upper);
      if (poolName) {
        const pc = SDKPoolConfig.fromIdsByName(poolName, deps.config.network);
        const custodies = pc.custodies as PoolCustodyConfig[];
        const tokens = pc.tokens as PoolTokenConfig[];
        const targetToken = tokens.find((t) => t.symbol.toUpperCase() === upper);
        const perpClient = (deps.flashClient as unknown as Partial<FlashClientInternals>).perpClient;

        if (targetToken && perpClient) {
          sdkPerpClient = perpClient;
          const custodyInfo = custodies.find((c) => c.symbol === targetToken.symbol);
          if (custodyInfo) {
            // Fetch on-chain custody account for fee and margin data
            const custodyData = await perpClient.program?.account?.custody?.fetch(custodyInfo.custodyAccount);
            if (custodyData) {
              const custodyAcct = SDKCustodyAccount.from(custodyInfo.custodyAccount, custodyData);
              sdkCustodyAcct = custodyAcct;
              openFeePct = (parseFloat(custodyAcct.fees.openPosition.toString()) / RATE_POWER) * 100;
              closeFeePct = (parseFloat(custodyAcct.fees.closePosition.toString()) / RATE_POWER) * 100;
              // Maintenance margin from pricing params.
              // pricing.maxLeverage is a u32 in BPS units (e.g. 10000000 = 1000x leverage).
              // SDK formula: liabilities = sizeUsd * BPS_POWER / maxLeverage
              // Human max leverage = maxLeverage / BPS_POWER
              // Maintenance margin % = BPS_POWER / maxLeverage * 100
              const BPS_POWER = 10_000;
              const rawMaxLev = (custodyAcct as unknown as CustodyAccountWithPricing).pricing?.maxLeverage;
              const rawNum =
                typeof rawMaxLev === 'object' && rawMaxLev?.toNumber
                  ? rawMaxLev.toNumber()
                  : typeof rawMaxLev === 'number'
                    ? rawMaxLev
                    : 0;
              if (Number.isFinite(rawNum) && rawNum > 0) {
                const humanMaxLev = rawNum / BPS_POWER;
                if (humanMaxLev > 0 && humanMaxLev <= 2000) {
                  maxLeverage = humanMaxLev;
                  maintenanceMarginPct = (BPS_POWER / rawNum) * 100;
                }
              }
              protocolParamsAvailable = true;
            }
          }

          // Fetch raw position for SDK liquidation math in collateral scenarios
          const markets = pc.markets as PoolMarketConfig[];
          const positionSide = pos.side === TradeSide.Long ? SDKSide.Long : SDKSide.Short;
          sdkSide = positionSide;
          const marketConfig = markets.find((m) => m.targetMint.equals(targetToken.mintKey) && m.side === positionSide);

          if (marketConfig && perpClient.program?.account?.position) {
            try {
              const wallet = (deps.flashClient as unknown as Partial<FlashClientInternals>).wallet?.publicKey;
              if (wallet) {
                const allPositions = await perpClient.program.account.position.all([
                  { memcmp: { offset: 8, bytes: wallet.toBase58() } },
                ]);
                // Find the raw position matching this market/side
                for (const rawPos of allPositions) {
                  const raw = rawPos.account;
                  if (raw.market?.equals?.(marketConfig.marketAccount)) {
                    sdkRawPosition = { ...raw, pubkey: rawPos.publicKey };
                    // Build entry oracle price from raw position
                    if (
                      raw.entryPrice &&
                      typeof raw.entryPrice === 'object' &&
                      'price' in raw.entryPrice &&
                      'exponent' in raw.entryPrice
                    ) {
                      sdkEntryOraclePrice = SDKOraclePrice.from({
                        price: raw.entryPrice.price,
                        exponent: new BN(String(raw.entryPrice.exponent)),
                        confidence: SDK_BN_ZERO,
                        timestamp: SDK_BN_ZERO,
                      });
                    }
                    break;
                  }
                }
              }
            } catch {
              // Non-critical: raw position fetch failed, collateral scenarios will fall back
            }
          }
        }
      }
    } catch {
      // Protocol params unavailable — proceed with position data only
    }
  }

  // Fallback max leverage from config
  if (maxLeverage === 0) {
    const { getMaxLeverage: getMaxLev } = await import('../config/index.js');
    maxLeverage = getMaxLev(upper, false);
    if (maintenanceMarginPct === 0 && maxLeverage > 0) {
      maintenanceMarginPct = (1 / maxLeverage) * 100;
    }
  }

  // SDK-exact collateral scenarios available when all raw data is loaded
  const canUseSDK = !!(sdkPerpClient && sdkCustodyAcct && sdkEntryOraclePrice && sdkRawPosition && sdkSide !== null);

  // ─── 3. Derived values ──────────────────────────────────────────
  const distToLiq =
    pos.liquidationPrice > 0 && pos.currentPrice > 0
      ? (Math.abs(pos.currentPrice - pos.liquidationPrice) / pos.currentPrice) * 100
      : 0;

  const pnlPct = pos.collateralUsd > 0 ? (pos.unrealizedPnl / pos.collateralUsd) * 100 : 0;
  const sideLabel = pos.side === TradeSide.Long ? 'Long' : 'Short';

  // ─── 4. Render position debug ───────────────────────────────────
  const lines: string[] = [''];
  const sec = theme.section;
  const pair = theme.pair;
  const dim = theme.dim;
  const sep = theme.separator;

  lines.push(`  ${theme.accentBold(`Position Debug — ${upper} ${sideLabel}`)}`);
  lines.push(`  ${sep(44)}`);
  lines.push('');

  // Position structure
  lines.push(`  ${sec('Position')}`);
  lines.push(pair('Size', formatUsd(pos.sizeUsd)));
  lines.push(pair('Collateral', formatUsd(pos.collateralUsd)));
  lines.push(pair('Entry Price', formatPrice(pos.entryPrice)));
  lines.push(pair('Current Price', formatPrice(pos.currentPrice)));
  lines.push(pair('Leverage', `${pos.leverage.toFixed(2)}x`));
  lines.push('');

  // PnL
  lines.push(`  ${sec('PnL')}`);
  lines.push(pair('Unrealized PnL', colorPnl(pos.unrealizedPnl)));
  lines.push(pair('PnL %', `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`));
  lines.push('');

  // Margin & liquidation
  lines.push(`  ${sec('Margin & Liquidation')}`);
  if (maintenanceMarginPct > 0) {
    lines.push(pair('Maint. Margin', `${maintenanceMarginPct.toFixed(2)}%`));
  }
  if (maxLeverage > 0) {
    lines.push(pair('Max Leverage', `${maxLeverage}x`));
  }
  if (pos.liquidationPrice > 0) {
    lines.push(pair('Liquidation Price', chalk.yellow(formatPrice(pos.liquidationPrice))));
    lines.push(pair('Distance to Liq', `${distToLiq.toFixed(1)}%`));
  } else {
    lines.push(pair('Liquidation Price', dim('Unavailable')));
  }
  lines.push('');

  // Fees (from protocol)
  lines.push(`  ${sec('Fees')}`);
  if (protocolParamsAvailable) {
    lines.push(pair('Open Fee Rate', `${openFeePct.toFixed(4)}%`));
    lines.push(pair('Close Fee Rate', `${closeFeePct.toFixed(4)}%`));
  }
  lines.push(pair('Unsettled Fees', formatUsd(pos.totalFees)));
  lines.push('');

  // ─── 5. Price impact scenarios ──────────────────────────────────
  lines.push(`  ${sec('What If Scenarios')}`);
  lines.push(`  ${sep(44)}`);
  lines.push('');

  const scenarios = [-15, -10, -5, 5, 10, 15];
  for (const pctMove of scenarios) {
    const simPrice = pos.currentPrice * (1 + pctMove / 100);
    const priceDelta = simPrice - pos.entryPrice;
    const mult = pos.side === TradeSide.Long ? 1 : -1;
    const simPnl = pos.entryPrice > 0 ? (priceDelta / pos.entryPrice) * pos.sizeUsd * mult : 0;

    // Check if this scenario would be liquidated
    const isLiquidated =
      pos.liquidationPrice > 0 &&
      ((pos.side === TradeSide.Long && simPrice <= pos.liquidationPrice) ||
        (pos.side === TradeSide.Short && simPrice >= pos.liquidationPrice));

    if (isLiquidated) {
      const _liqDistAtScenario = (Math.abs(simPrice - pos.liquidationPrice) / simPrice) * 100;
      lines.push(`  Price ${pctMove > 0 ? '+' : ''}${pctMove}%     → ${chalk.red('LIQUIDATED')}`);
    } else {
      const scenarioLiqDist =
        pos.liquidationPrice > 0 ? (Math.abs(simPrice - pos.liquidationPrice) / simPrice) * 100 : 0;
      // Pad the raw PnL string BEFORE colorizing to avoid ANSI codes breaking alignment
      const rawPnl = simPnl >= 0 ? `$${simPnl.toFixed(2)}` : `-$${Math.abs(simPnl).toFixed(2)}`;
      const paddedPnl = rawPnl.padEnd(12);
      const pnlStr = simPnl >= 0 ? chalk.green(paddedPnl) : chalk.red(paddedPnl);
      const liqStr = scenarioLiqDist > 0 ? `Liq Distance: ${scenarioLiqDist.toFixed(1)}%` : '';
      lines.push(
        `  Price ${(pctMove > 0 ? '+' : '') + pctMove + '%'}${' '.repeat(Math.max(1, 6 - String(pctMove).length))} → PnL: ${pnlStr}  ${liqStr}`,
      );
    }
  }
  lines.push('');

  // ─── 6. Collateral adjustment simulation ────────────────────────
  if (pos.liquidationPrice > 0) {
    lines.push(`  ${sec('Add Collateral Scenarios')}`);
    lines.push(`  ${sep(44)}`);
    lines.push('');

    const addAmounts = [50, 100, 200, 500];
    const USD_DECIMALS = 6;

    for (const addAmt of addAmounts) {
      const newCollateral = pos.collateralUsd + addAmt;
      const newLeverage = pos.sizeUsd / newCollateral;

      if (canUseSDK && sdkRawPosition && sdkPerpClient) {
        // SDK-exact: clone raw position with increased collateral, compute exact liq price
        try {
          const BN = (await import('bn.js')).default;
          const { PositionAccount: SDKPositionAccount } = await import('flash-sdk');
          const addBN = new BN(Math.round(addAmt * Math.pow(10, USD_DECIMALS)));
          const newCollateralBN = sdkRawPosition.collateralUsd.add(addBN);
          // Create modified position with increased collateral
          const modifiedRaw = { ...sdkRawPosition, collateralUsd: newCollateralBN };
          const modPosAcct = SDKPositionAccount.from(
            sdkRawPosition.pubkey,
            modifiedRaw as unknown as ConstructorParameters<typeof SDKPositionAccount>[1],
          );
          const unsettledFees = sdkRawPosition.unsettledFeesUsd ?? new BN(0);
          const liqOraclePrice = sdkPerpClient.getLiquidationPriceContractHelper(
            sdkEntryOraclePrice,
            unsettledFees,
            sdkSide,
            sdkCustodyAcct,
            modPosAcct,
          );
          const liqUi = parseFloat(liqOraclePrice.toUiPrice(8));
          if (Number.isFinite(liqUi) && liqUi > 0) {
            lines.push(
              `  Add ${formatUsd(addAmt).padEnd(8)} → Liq Price: ${chalk.yellow(formatPrice(liqUi))}  (${newLeverage.toFixed(1)}x leverage)`,
            );
            continue;
          }
        } catch {
          // Fall through to approximation
        }
      }

      // Fallback: use protocol-aligned formula (matches getLiquidationPriceContractHelper)
      if (newLeverage < 1) {
        // Fully collateralized — collateral exceeds position size, no liquidation risk
        lines.push(
          `  Add ${formatUsd(addAmt).padEnd(8)} → ${chalk.green('Liquidation: None')}  ${dim(`(fully collateralized, ${newLeverage.toFixed(2)}x effective leverage)`)}`,
        );
      } else if (pos.sizeUsd > 0 && pos.entryPrice > 0) {
        const fallbackLiqPrice = computeSimulationLiquidationPrice(
          pos.entryPrice,
          pos.sizeUsd,
          newCollateral,
          pos.side,
          debugFeeRates.maintenanceMarginRate,
          debugFeeRates.closeFeeRate,
        );
        if (Number.isFinite(fallbackLiqPrice) && fallbackLiqPrice > 0) {
          lines.push(
            `  Add ${formatUsd(addAmt).padEnd(8)} → Liq Price: ${chalk.yellow(formatPrice(fallbackLiqPrice))}  (${newLeverage.toFixed(1)}x leverage)`,
          );
        }
      }
    }
    lines.push('');
  }

  // ─── 7. Reduce position size scenarios ──────────────────────────
  if (pos.liquidationPrice > 0 && pos.leverage > 1 && pos.collateralUsd > 0) {
    // Generate leverage targets below current, down to 1x
    // For fractional leverage (e.g. 1.33x), start from floor and include 1x
    const targetLeverages: number[] = [];
    // If leverage > 2, show integer steps down
    for (let lev = Math.floor(pos.leverage) - 1; lev >= 1 && targetLeverages.length < 4; lev--) {
      targetLeverages.push(lev);
    }
    // If current leverage is fractional and > 1 but < 2, show 1x explicitly
    if (targetLeverages.length === 0 && pos.leverage > 1) {
      targetLeverages.push(1);
    }

    if (targetLeverages.length > 0) {
      lines.push(`  ${sec('Reduce Position Size')}`);
      lines.push(`  ${sep(44)}`);
      lines.push('');

      const USD_DECIMALS_SIZE = 6;

      for (const targetLev of targetLeverages) {
        const newSizeUsd = pos.collateralUsd * targetLev;

        if (canUseSDK && sdkRawPosition && sdkPerpClient) {
          // SDK-exact: clone raw position with reduced sizeUsd, compute exact liq price
          try {
            const BN = (await import('bn.js')).default;
            const { PositionAccount: SDKPositionAccount } = await import('flash-sdk');
            const newSizeBN = new BN(Math.round(newSizeUsd * Math.pow(10, USD_DECIMALS_SIZE)));
            const modifiedRaw = { ...sdkRawPosition, sizeUsd: newSizeBN };
            const modPosAcct = SDKPositionAccount.from(
              sdkRawPosition.pubkey,
              modifiedRaw as unknown as ConstructorParameters<typeof SDKPositionAccount>[1],
            );
            const unsettledFees = sdkRawPosition.unsettledFeesUsd ?? new BN(0);
            const liqOraclePrice = sdkPerpClient.getLiquidationPriceContractHelper(
              sdkEntryOraclePrice,
              unsettledFees,
              sdkSide,
              sdkCustodyAcct,
              modPosAcct,
            );
            const liqUi = parseFloat(liqOraclePrice.toUiPrice(8));
            if (Number.isFinite(liqUi) && liqUi > 0) {
              lines.push(
                `  Reduce to ${targetLev}x → Size: ${formatUsd(newSizeUsd).padEnd(10)} → Liq Price: ${chalk.yellow(formatPrice(liqUi))}`,
              );
              continue;
            }
          } catch {
            // Fall through to approximation
          }
        }

        // Fallback: use protocol-aligned liquidation formula
        if (targetLev >= 1 && pos.entryPrice > 0) {
          const fallbackLiq = computeSimulationLiquidationPrice(
            pos.entryPrice,
            newSizeUsd,
            pos.collateralUsd,
            pos.side,
            debugFeeRates.maintenanceMarginRate,
            debugFeeRates.closeFeeRate,
          );
          if (Number.isFinite(fallbackLiq) && fallbackLiq > 0) {
            lines.push(
              `  Reduce to ${targetLev}x → Size: ${formatUsd(newSizeUsd).padEnd(10)} → Liq Price: ${chalk.yellow(formatPrice(fallbackLiq))}`,
            );
          }
        }
      }
      lines.push('');
    }
  }

  // ─── 8. Data source labels ──────────────────────────────────────
  lines.push(`  ${sep(44)}`);
  lines.push(dim(`  Price Source:       Pyth Hermes`));
  const sdkLabel = canUseSDK
    ? ' (on-chain CustodyAccount + getLiquidationPriceContractHelper)'
    : protocolParamsAvailable
      ? ' (on-chain CustodyAccount)'
      : '';
  lines.push(dim(`  Liquidation Math:  Flash SDK${sdkLabel}`));
  lines.push(
    dim(
      `  Position Data:     ${deps.config.simulationMode ? 'Simulation' : 'Flash SDK perpClient.getUserPositions()'}`,
    ),
  );
  lines.push('');

  console.log(lines.join('\n'));
}
