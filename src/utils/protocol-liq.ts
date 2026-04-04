/**
 * Protocol Liquidation Utilities
 *
 * All liquidation price calculations MUST use getLiquidationPriceContractHelper()
 * from the Flash SDK. This module provides a unified wrapper.
 *
 * Reference: https://github.com/flash-trade/flash-trade-sdk/blob/main/SDK/src/PerpetualsClient.ts#L2244
 *
 * Data sources:
 * - CustodyAccount (on-chain) — maintenance margin, fee config
 * - PositionAccount (on-chain) — collateral, size, entry price
 * - OraclePrice (Pyth) — entry price representation
 */

import { TradeSide } from '../types/index.js';
import { getLogger } from '../utils/logger.js';

/** Maximum acceptable deviation between CLI and SDK liquidation prices. */
const DIVERGENCE_THRESHOLD = 0.005; // 0.5%

/** If true, divergence throws instead of warning. Set via FLASH_STRICT_PROTOCOL env. */
const STRICT_MODE = (process.env.FLASH_STRICT_PROTOCOL ?? '').toLowerCase() === 'true';

/** Per-market divergence status — consumed by telemetry status bar. */
const _divergenceStatus = new Map<string, boolean>();

/** Get overall divergence check status for telemetry. True if no market has diverged. */
export function isDivergenceOk(): boolean {
  for (const ok of _divergenceStatus.values()) {
    if (!ok) return false;
  }
  return true;
}

/**
 * Verify CLI liquidation calculation against Flash SDK helper.
 * Called after position open or simulation — reuses existing data, no extra RPC calls.
 *
 * @returns deviation ratio, or -1 if SDK check is unavailable
 */
export async function checkLiquidationDivergence(
  cliLiqPrice: number,
  perpClient: unknown | null,
  entryOraclePrice: unknown,
  unsettledFees: unknown,
  sdkSide: unknown,
  custodyAcct: unknown,
  posAcct: unknown,
  market: string,
): Promise<number> {
  if (!perpClient || !entryOraclePrice || !custodyAcct || !posAcct) {
    // SDK data not available (simulation mode) — skip check
    return -1;
  }

  try {
    const client = perpClient as unknown as {
      getLiquidationPriceContractHelper: (...args: unknown[]) => { toUiPrice: (decimals: number) => string };
    };
    const liqOraclePrice = client.getLiquidationPriceContractHelper(
      entryOraclePrice,
      unsettledFees,
      sdkSide,
      custodyAcct,
      posAcct,
    );
    const sdkLiq = parseFloat(liqOraclePrice.toUiPrice(8));

    if (!Number.isFinite(sdkLiq) || sdkLiq <= 0 || !Number.isFinite(cliLiqPrice) || cliLiqPrice <= 0) {
      return -1;
    }

    const deviation = Math.abs(cliLiqPrice - sdkLiq) / sdkLiq;

    if (deviation > DIVERGENCE_THRESHOLD) {
      _divergenceStatus.set(market.toUpperCase(), false);
      const msg = [
        `Protocol divergence detected for ${market}`,
        `  CLI liquidation:  $${cliLiqPrice.toFixed(2)}`,
        `  SDK liquidation:  $${sdkLiq.toFixed(2)}`,
        `  Deviation:        ${(deviation * 100).toFixed(2)}%`,
      ].join('\n');

      getLogger().warn('DIVERGENCE', msg);

      if (STRICT_MODE) {
        throw new Error(
          `Protocol divergence exceeds threshold (${(deviation * 100).toFixed(2)}% > ${(DIVERGENCE_THRESHOLD * 100).toFixed(1)}%) for ${market}`,
        );
      }

      // Print warning to CLI
      const chalk = (await import('chalk')).default;
      console.log('');
      console.log(chalk.yellow('  ⚠ Protocol divergence detected'));
      console.log(chalk.yellow(`    CLI liquidation:  $${cliLiqPrice.toFixed(2)}`));
      console.log(chalk.yellow(`    SDK liquidation:  $${sdkLiq.toFixed(2)}`));
      console.log(chalk.yellow(`    Deviation:        ${(deviation * 100).toFixed(2)}%`));
      console.log('');
    } else {
      _divergenceStatus.set(market.toUpperCase(), true);
    }

    return deviation;
  } catch (err) {
    // Re-throw strict mode errors
    if (err instanceof Error && err.message.includes('Protocol divergence exceeds')) throw err;
    // SDK helper not available — skip silently
    getLogger().debug('DIVERGENCE', `SDK check skipped: ${err}`);
    return -1;
  }
}

/**
 * Compute liquidation price using Flash SDK's getLiquidationPriceContractHelper().
 *
 * This mirrors the exact on-chain logic:
 *   liabilities = sizeUsd * BPS_POWER / maxLeverage
 *   liq price = entry ± (collateral - liabilities - unsettledFees) / size * entryPrice
 *
 * @param perpClient - Flash SDK PerpetualsClient
 * @param entryOraclePrice - OraclePrice from position entry
 * @param unsettledFees - BN of accumulated fees (USD, 6 decimals)
 * @param side - SDK Side enum value
 * @param custodyAcct - CustodyAccount (fetched from on-chain)
 * @param posAcct - PositionAccount (or modified clone)
 * @returns Liquidation price as a UI number, or 0 if unavailable
 */
export function computeLiquidationPrice(
  perpClient: unknown,
  entryOraclePrice: unknown,
  unsettledFees: unknown,
  side: unknown,
  custodyAcct: unknown,
  posAcct: unknown,
): number {
  try {
    const client = perpClient as {
      getLiquidationPriceContractHelper: (...args: unknown[]) => { toUiPrice: (decimals: number) => string };
    };
    const liqOraclePrice = client.getLiquidationPriceContractHelper(
      entryOraclePrice,
      unsettledFees,
      side,
      custodyAcct,
      posAcct,
    );
    const liqUi = parseFloat(liqOraclePrice.toUiPrice(8));
    if (Number.isFinite(liqUi) && liqUi > 0) {
      return liqUi;
    }
  } catch {
    // SDK call failed — return 0
  }
  return 0;
}

/**
 * Compute liquidation price for simulation mode using the same protocol formula
 * as getLiquidationPriceContractHelper but with known constants.
 *
 * Formula from Flash SDK PerpetualsClient.ts:
 *   liabilities = sizeUsd * maintenanceMarginRate  (from custodyAcct.pricing.maintenanceMargin / BPS_POWER)
 *   exitFee = sizeUsd * closeFeeRate
 *   availableCollateral = collateral - liabilities - unsettledFees - exitFee
 *   priceMove = availableCollateral / sizeUsd * entryPrice
 *   liqPrice = entryPrice - priceMove (long) or entryPrice + priceMove (short)
 *
 * Protocol parameter sources:
 *   maintenanceMarginRate: 1 / (custodyAcct.pricing.maxLeverage / BPS_POWER) (default 1% = 1/100)
 *   closeFeeRate: custodyAcct.fees.closePosition / RATE_POWER (default 0.08%)
 *
 * @param maintenanceMarginRate - Derived as 1 / maxLeverage from custodyAcct.pricing.maxLeverage.
 *                                 Defaults to 0.01 (1%), equivalent to maxLeverage=100.
 */
export function computeSimulationLiquidationPrice(
  entryPrice: number,
  sizeUsd: number,
  collateralUsd: number,
  side: TradeSide,
  maintenanceMarginRate: number = 0.01,
  closeFeeRate: number = 0.0008,
  unsettledFeesUsd: number = 0,
): number {
  if (
    !Number.isFinite(entryPrice) ||
    entryPrice <= 0 ||
    !Number.isFinite(sizeUsd) ||
    sizeUsd <= 0 ||
    !Number.isFinite(collateralUsd) ||
    collateralUsd <= 0
  ) {
    return 0;
  }

  // Validate protocol parameters — reject NaN/negative to prevent garbage calculations
  if (!Number.isFinite(maintenanceMarginRate) || maintenanceMarginRate < 0) return 0;
  if (!Number.isFinite(closeFeeRate) || closeFeeRate < 0) return 0;
  if (!Number.isFinite(unsettledFeesUsd) || unsettledFeesUsd < 0) unsettledFeesUsd = 0;

  // Maintenance margin from custodyAcct.pricing.maintenanceMargin / BPS_POWER
  const maintenanceMargin = sizeUsd * maintenanceMarginRate;
  // Exit fee: sizeUsd * closeFeeRate
  const exitFee = sizeUsd * closeFeeRate;
  // Available collateral after liabilities
  const availableCollateral = collateralUsd - maintenanceMargin - exitFee - unsettledFeesUsd;

  if (availableCollateral <= 0) {
    // Position is at or beyond liquidation
    return entryPrice;
  }

  // Price distance to liquidation
  const priceMove = (availableCollateral / sizeUsd) * entryPrice;

  if (side === TradeSide.Long) {
    const liqPrice = entryPrice - priceMove;
    return liqPrice > 0 ? liqPrice : 0;
  } else {
    return entryPrice + priceMove;
  }
}
