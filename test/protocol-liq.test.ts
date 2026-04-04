/**
 * Behavior-locking tests for liquidation price computation.
 *
 * These tests verify the simulation liquidation formula matches
 * the Flash SDK's getLiquidationPriceContractHelper() logic.
 */

import { describe, it, expect } from 'vitest';
import { computeSimulationLiquidationPrice } from '../src/utils/protocol-liq.js';
import { TradeSide } from '../src/types/index.js';

describe('computeSimulationLiquidationPrice', () => {

  // ─── Long Position ────────────────────────────────────────────────────

  it('computes correct liq price for long position', () => {
    // Entry: $150, Size: $500, Collateral: $100, Leverage: 5x
    // maintenanceMargin = 500 * 0.01 = $5
    // exitFee = 500 * 0.0008 = $0.40
    // availableCollateral = 100 - 5 - 0.40 = $94.60
    // priceMove = (94.60 / 500) * 150 = $28.38
    // liqPrice = 150 - 28.38 = $121.62
    const liqPrice = computeSimulationLiquidationPrice(150, 500, 100, TradeSide.Long, 0.01, 0.0008);

    expect(liqPrice).toBeCloseTo(121.62, 1);
    expect(liqPrice).toBeGreaterThan(0);
    expect(liqPrice).toBeLessThan(150);
  });

  it('computes correct liq price for short position', () => {
    // Entry: $150, Size: $500, Collateral: $100
    // priceMove same as above: $28.38
    // liqPrice = 150 + 28.38 = $178.38
    const liqPrice = computeSimulationLiquidationPrice(150, 500, 100, TradeSide.Short, 0.01, 0.0008);

    expect(liqPrice).toBeCloseTo(178.38, 1);
    expect(liqPrice).toBeGreaterThan(150);
  });

  // ─── Higher Leverage = Closer Liquidation ─────────────────────────────

  it('higher leverage produces closer liquidation price', () => {
    const liq5x = computeSimulationLiquidationPrice(150, 750, 150, TradeSide.Long, 0.01, 0.0008);
    const liq10x = computeSimulationLiquidationPrice(150, 1500, 150, TradeSide.Long, 0.01, 0.0008);

    // 10x leverage should have liq price closer to entry than 5x
    expect(Math.abs(150 - liq10x)).toBeLessThan(Math.abs(150 - liq5x));
  });

  // ─── Edge Cases ───────────────────────────────────────────────────────

  it('returns 0 for zero entry price', () => {
    expect(computeSimulationLiquidationPrice(0, 500, 100, TradeSide.Long)).toBe(0);
  });

  it('returns 0 for zero size', () => {
    expect(computeSimulationLiquidationPrice(150, 0, 100, TradeSide.Long)).toBe(0);
  });

  it('returns 0 for zero collateral', () => {
    expect(computeSimulationLiquidationPrice(150, 500, 0, TradeSide.Long)).toBe(0);
  });

  it('returns 0 for NaN entry price', () => {
    expect(computeSimulationLiquidationPrice(NaN, 500, 100, TradeSide.Long)).toBe(0);
  });

  it('returns 0 for Infinity size', () => {
    expect(computeSimulationLiquidationPrice(150, Infinity, 100, TradeSide.Long)).toBe(0);
  });

  it('returns 0 for negative collateral', () => {
    expect(computeSimulationLiquidationPrice(150, 500, -100, TradeSide.Long)).toBe(0);
  });

  it('returns entry price when collateral insufficient for margin', () => {
    // Collateral $1, size $500 — maintenance margin alone ($5) exceeds collateral
    const liqPrice = computeSimulationLiquidationPrice(150, 500, 1, TradeSide.Long, 0.01, 0.0008);
    expect(liqPrice).toBe(150); // at or beyond liquidation
  });

  it('handles zero maintenance margin rate gracefully', () => {
    const liqPrice = computeSimulationLiquidationPrice(150, 500, 100, TradeSide.Long, 0, 0.0008);
    expect(Number.isFinite(liqPrice)).toBe(true);
    expect(liqPrice).toBeGreaterThan(0);
  });

  it('handles zero close fee rate gracefully', () => {
    const liqPrice = computeSimulationLiquidationPrice(150, 500, 100, TradeSide.Long, 0.01, 0);
    expect(Number.isFinite(liqPrice)).toBe(true);
    expect(liqPrice).toBeGreaterThan(0);
  });

  // ─── Long liq price never goes negative ───────────────────────────────

  it('long liq price is always >= 0', () => {
    // Very high collateral relative to size — liq price could theoretically go negative
    const liqPrice = computeSimulationLiquidationPrice(10, 10, 100, TradeSide.Long, 0.01, 0.0008);
    expect(liqPrice).toBeGreaterThanOrEqual(0);
  });
});
