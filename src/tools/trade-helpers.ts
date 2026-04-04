/**
 * Trade Helper Utilities — shared helpers for trade tool confirmations.
 *
 * Extracted from flash-tools.ts for maintainability.
 * All functions are internal to the tools layer.
 */

import { ToolContext, TradeSide, getLeverageLimits } from '../types/index.js';
import { formatUsd, formatPrice, colorPnl } from '../utils/format.js';
import { getProtocolFeeRates } from '../utils/protocol-fees.js';
import { computeSimulationLiquidationPrice } from '../utils/protocol-liq.js';
import chalk from 'chalk';

// ─── Risk Classification ─────────────────────────────────────────────────

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export function classifyRisk(distancePct: number): RiskLevel {
  if (distancePct > 60) return 'LOW';
  if (distancePct > 30) return 'MEDIUM';
  return 'HIGH';
}

export function colorRisk(level: RiskLevel): string {
  switch (level) {
    case 'LOW':
      return chalk.green(level);
    case 'MEDIUM':
      return chalk.yellow(level);
    case 'HIGH':
      return chalk.red(level);
  }
}

// ─── Liquidation Estimate ────────────────────────────────────────────────

/**
 * Compute pre-trade liquidation estimate using the same formula as
 * Flash SDK's getLiquidationPriceContractHelper().
 */
export async function estimateLiqPrice(
  entryPrice: number,
  leverage: number,
  side: TradeSide,
  market: string,
  perpClient: unknown | null,
): Promise<number> {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(leverage) || entryPrice <= 0 || leverage <= 0) return 0;
  const feeRates = await getProtocolFeeRates(market, perpClient);
  const sizeUsd = 1; // normalized
  const collateralUsd = sizeUsd / leverage;
  return computeSimulationLiquidationPrice(
    entryPrice,
    sizeUsd,
    collateralUsd,
    side,
    feeRates.maintenanceMarginRate,
    feeRates.closeFeeRate,
  );
}

// ─── Timeout Helper ──────────────────────────────────────────────────────

/** Timeout helper — resolves to fallback if promise takes too long. */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

export const PREVIEW_TIMEOUT_MS = 3_000;

// ─── Risk Preview ────────────────────────────────────────────────────────

/** Build risk preview lines for the open position confirmation panel. */
export async function buildRiskPreview(
  context: ToolContext,
  market: string,
  side: TradeSide,
  leverage: number,
  sizeUsd: number,
): Promise<string[]> {
  return withTimeout(_buildRiskPreview(context, market, side, leverage, sizeUsd), PREVIEW_TIMEOUT_MS, []);
}

async function _buildRiskPreview(
  context: ToolContext,
  market: string,
  side: TradeSide,
  leverage: number,
  sizeUsd: number,
): Promise<string[]> {
  const lines: string[] = [];
  try {
    const marketData = await context.flashClient.getMarketData(market);
    const md = marketData.find((m) => m.symbol.toUpperCase() === market.toUpperCase());
    if (!md || !Number.isFinite(md.price) || md.price <= 0) return lines;

    const entryEst = md.price;
    const perpClient = context.simulationMode
      ? null
      : ((context.flashClient as unknown as Record<string, unknown>).perpClient ?? null);
    const liqEst = await estimateLiqPrice(entryEst, leverage, side, market, perpClient);
    if (liqEst <= 0) return lines;
    const distancePct = (Math.abs(entryEst - liqEst) / entryEst) * 100;
    const risk = classifyRisk(distancePct);

    lines.push('');
    lines.push(chalk.dim('  Risk Preview:'));
    lines.push(`    Est. Entry:   ${formatPrice(entryEst)}`);
    lines.push(`    Est. Liq:     ${chalk.yellow(formatPrice(liqEst))}`);
    lines.push(`    Distance:     ${distancePct.toFixed(1)}%`);
    lines.push(`    Risk:         ${colorRisk(risk)}`);

    const positions = await context.flashClient.getPositions();
    const currentExposure = positions.reduce((sum, p) => sum + (Number.isFinite(p.sizeUsd) ? p.sizeUsd : 0), 0);
    const newExposure = currentExposure + sizeUsd;

    lines.push(`    Exposure:     ${formatUsd(currentExposure)} → ${chalk.bold(formatUsd(newExposure))}`);
  } catch {
    // Best effort — don't block trade if preview fails
  }
  return lines;
}

// ─── Position Preview ────────────────────────────────────────────────────

/** Build position details for close/modify confirmations. */
export async function buildPositionPreview(context: ToolContext, market: string, side: TradeSide): Promise<string[]> {
  return withTimeout(_buildPositionPreview(context, market, side), PREVIEW_TIMEOUT_MS, []);
}

async function _buildPositionPreview(context: ToolContext, market: string, side: TradeSide): Promise<string[]> {
  const lines: string[] = [];
  try {
    const positions = await context.flashClient.getPositions();
    const pos = positions.find((p) => p.market.toUpperCase() === market.toUpperCase() && p.side === side);
    if (!pos) return lines;

    lines.push(`  Size:    ${formatUsd(pos.sizeUsd)}`);
    lines.push(`  Entry:   ${formatPrice(pos.entryPrice)}`);
    lines.push(`  PnL:     ${colorPnl(pos.unrealizedPnl)}`);
    if (Number.isFinite(pos.liquidationPrice) && pos.liquidationPrice > 0) {
      lines.push(`  Liq:     ${chalk.yellow(formatPrice(pos.liquidationPrice))}`);
    }
  } catch {
    // Best effort
  }
  return lines;
}

// ─── Pre-Trade Validation ────────────────────────────────────────────────

export function validateLiveTradeContext(context: ToolContext): string | null {
  if (context.simulationMode) return null;
  if (!context.walletManager || !context.walletManager.isConnected) {
    return 'No wallet connected. Use "wallet import <name> <path>" or "wallet connect <path>".';
  }
  return null;
}

export function buildLiveTradeWarnings(market: string, leverage: number, collateral?: number): string[] {
  const warnings: string[] = [];
  const limits = getLeverageLimits(market);

  if (leverage < limits.min) warnings.push(`Leverage ${leverage}x is below minimum ${limits.min}x for ${market}`);
  if (leverage > limits.max) warnings.push(`Leverage ${leverage}x exceeds maximum ${limits.max}x for ${market}`);
  if (leverage >= 20) warnings.push(`High leverage (${leverage}x) — liquidation risk is significant`);
  if (leverage >= 50) warnings.push('Extreme leverage — small price moves can liquidate');

  const liqDistance = (1 / leverage) * 100;
  if (liqDistance < 5) {
    warnings.push(`Liquidation within ${liqDistance.toFixed(1)}% price move`);
  }

  if (collateral !== undefined && collateral > 1000) {
    warnings.push(`Large collateral amount: ${formatUsd(collateral)}`);
  }

  return warnings;
}
