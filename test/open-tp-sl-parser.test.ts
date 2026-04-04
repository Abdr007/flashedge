/**
 * Open + Inline TP/SL Parser Tests
 *
 * Verifies that inline TP/SL syntax on open commands is correctly parsed
 * and produces the same ParsedIntent used by the tools layer.
 *
 * Covers:
 *   - open with TP only
 *   - open with SL only
 *   - open with TP and SL
 *   - open with reversed TP/SL order
 *   - open with decimal values
 *   - open without TP/SL
 *   - alternate open syntax ("long SOL $100 2x")
 *   - open with buy/enter aliases
 *   - open with natural language extras ("a", "position", "on", "with")
 */
import { describe, it, expect } from 'vitest';
import { localParse } from '../src/ai/interpreter.js';
import { ActionType, TradeSide } from '../src/types/index.js';

describe('Open + Inline TP/SL Parsing', () => {
  // ─── TP Only ──────────────────────────────────────────────────────

  it('should parse open with TP only', () => {
    const result = localParse('open 3x long BTC $200 tp $72000');
    expect(result).not.toBeNull();
    expect(result!.action).toBe(ActionType.OpenPosition);
    const r = result as { action: string; market: string; side: string; leverage: number; collateral: number; takeProfit?: number; stopLoss?: number };
    expect(r.market).toBe('BTC');
    expect(r.side).toBe(TradeSide.Long);
    expect(r.leverage).toBe(3);
    expect(r.collateral).toBe(200);
    expect(r.takeProfit).toBe(72000);
    expect(r.stopLoss).toBeUndefined();
  });

  // ─── SL Only ──────────────────────────────────────────────────────

  it('should parse open with SL only', () => {
    const result = localParse('open 3x short BTC $200 sl $73000');
    expect(result).not.toBeNull();
    const r = result as { action: string; market: string; side: string; leverage: number; collateral: number; takeProfit?: number; stopLoss?: number };
    expect(r.market).toBe('BTC');
    expect(r.side).toBe(TradeSide.Short);
    expect(r.leverage).toBe(3);
    expect(r.collateral).toBe(200);
    expect(r.takeProfit).toBeUndefined();
    expect(r.stopLoss).toBe(73000);
  });

  // ─── TP and SL ────────────────────────────────────────────────────

  it('should parse open with TP and SL', () => {
    const result = localParse('open 2x long SOL $100 tp $95 sl $80');
    expect(result).not.toBeNull();
    const r = result as { action: string; market: string; side: string; leverage: number; collateral: number; takeProfit?: number; stopLoss?: number };
    expect(r.market).toBe('SOL');
    expect(r.side).toBe(TradeSide.Long);
    expect(r.leverage).toBe(2);
    expect(r.collateral).toBe(100);
    expect(r.takeProfit).toBe(95);
    expect(r.stopLoss).toBe(80);
  });

  it('should parse open with TP and SL (5x)', () => {
    const result = localParse('open 5x long SOL $50 tp $120 sl $70');
    expect(result).not.toBeNull();
    const r = result as { action: string; takeProfit?: number; stopLoss?: number };
    expect(r.takeProfit).toBe(120);
    expect(r.stopLoss).toBe(70);
  });

  // ─── Reversed Order ───────────────────────────────────────────────

  it('should parse open with SL before TP', () => {
    const result = localParse('open 5x long SOL $50 sl $70 tp $120');
    expect(result).not.toBeNull();
    const r = result as { action: string; takeProfit?: number; stopLoss?: number };
    expect(r.takeProfit).toBe(120);
    expect(r.stopLoss).toBe(70);
  });

  // ─── Decimal Values ───────────────────────────────────────────────

  it('should parse open with decimal TP and SL', () => {
    const result = localParse('open 2.5x long SOL $100.50 tp $95.25 sl $80.10');
    expect(result).not.toBeNull();
    const r = result as { action: string; leverage: number; collateral: number; takeProfit?: number; stopLoss?: number };
    expect(r.leverage).toBe(2.5);
    expect(r.collateral).toBe(100.50);
    expect(r.takeProfit).toBe(95.25);
    expect(r.stopLoss).toBe(80.10);
  });

  // ─── Without TP/SL ────────────────────────────────────────────────

  it('should parse open without TP/SL', () => {
    const result = localParse('open 2x long SOL $100');
    expect(result).not.toBeNull();
    const r = result as { action: string; market: string; takeProfit?: number; stopLoss?: number };
    expect(r.action).toBe(ActionType.OpenPosition);
    expect(r.market).toBe('SOL');
    expect(r.takeProfit).toBeUndefined();
    expect(r.stopLoss).toBeUndefined();
  });

  // ─── Alternate Open Syntax ────────────────────────────────────────

  it('should parse alternate syntax with TP/SL', () => {
    const result = localParse('long SOL $100 2x tp $95 sl $80');
    expect(result).not.toBeNull();
    const r = result as { action: string; market: string; side: string; leverage: number; collateral: number; takeProfit?: number; stopLoss?: number };
    expect(r.action).toBe(ActionType.OpenPosition);
    expect(r.market).toBe('SOL');
    expect(r.side).toBe(TradeSide.Long);
    expect(r.collateral).toBe(100);
    expect(r.leverage).toBe(2);
    expect(r.takeProfit).toBe(95);
    expect(r.stopLoss).toBe(80);
  });

  // ─── Buy/Enter Aliases ────────────────────────────────────────────

  it('should parse "buy" with TP/SL', () => {
    const result = localParse('buy 2x long SOL $100 tp $95 sl $80');
    expect(result).not.toBeNull();
    const r = result as { action: string; takeProfit?: number; stopLoss?: number };
    expect(r.action).toBe(ActionType.OpenPosition);
    expect(r.takeProfit).toBe(95);
    expect(r.stopLoss).toBe(80);
  });

  it('should parse "enter" with TP/SL', () => {
    const result = localParse('enter 2x long SOL $100 tp $95 sl $80');
    expect(result).not.toBeNull();
    const r = result as { action: string; takeProfit?: number; stopLoss?: number };
    expect(r.action).toBe(ActionType.OpenPosition);
    expect(r.takeProfit).toBe(95);
    expect(r.stopLoss).toBe(80);
  });

  // ─── Natural Language Extras ──────────────────────────────────────

  it('should parse with "a", "position", "on", "with"', () => {
    const result = localParse('open a 2x long position on SOL with $100 tp $95 sl $80');
    expect(result).not.toBeNull();
    const r = result as { action: string; market: string; takeProfit?: number; stopLoss?: number };
    expect(r.action).toBe(ActionType.OpenPosition);
    expect(r.market).toBe('SOL');
    expect(r.takeProfit).toBe(95);
    expect(r.stopLoss).toBe(80);
  });

  // ─── Without $ sign on TP/SL ──────────────────────────────────────

  it('should parse TP/SL without $ sign', () => {
    const result = localParse('open 2x long SOL $100 tp 95 sl 80');
    expect(result).not.toBeNull();
    const r = result as { action: string; takeProfit?: number; stopLoss?: number };
    expect(r.takeProfit).toBe(95);
    expect(r.stopLoss).toBe(80);
  });

  // ─── Case Insensitivity ───────────────────────────────────────────

  it('should handle uppercase TP/SL', () => {
    const result = localParse('open 2x long SOL $100 TP $95 SL $80');
    expect(result).not.toBeNull();
    const r = result as { action: string; takeProfit?: number; stopLoss?: number };
    expect(r.takeProfit).toBe(95);
    expect(r.stopLoss).toBe(80);
  });

  // ─── Asset Alias with TP/SL ───────────────────────────────────────

  it('should resolve asset aliases with TP/SL', () => {
    const result = localParse('open 2x long gold $100 tp $2050 sl $1900');
    expect(result).not.toBeNull();
    const r = result as { action: string; market: string; takeProfit?: number; stopLoss?: number };
    expect(r.market).toBe('XAU');
    expect(r.takeProfit).toBe(2050);
    expect(r.stopLoss).toBe(1900);
  });

  // ─── Short Side with TP/SL ────────────────────────────────────────

  it('should parse short with TP/SL', () => {
    const result = localParse('open 3x short ETH $500 tp $1800 sl $2200');
    expect(result).not.toBeNull();
    const r = result as { action: string; side: string; takeProfit?: number; stopLoss?: number };
    expect(r.side).toBe(TradeSide.Short);
    expect(r.takeProfit).toBe(1800);
    expect(r.stopLoss).toBe(2200);
  });

  // ─── TP/SL values produce identical results to set commands ───────

  it('should produce same fields as separate set commands would use', () => {
    const openResult = localParse('open 2x long SOL $100 tp $95 sl $80') as Record<string, unknown>;
    expect(openResult).not.toBeNull();
    expect(openResult.takeProfit).toBe(95);
    expect(openResult.stopLoss).toBe(80);
    expect(openResult.market).toBe('SOL');
    expect(openResult.side).toBe(TradeSide.Long);

    // The set command would produce these values for the TP/SL engine:
    const setTpResult = localParse('set tp SOL long $95') as Record<string, unknown>;
    expect(setTpResult).not.toBeNull();
    expect(setTpResult.action).toBe(ActionType.SetTpSl);
    expect(setTpResult.price).toBe(95);
    expect(setTpResult.market).toBe('SOL');
    expect(setTpResult.side).toBe(TradeSide.Long);

    // Same price values — engine will receive identical targets
    expect(openResult.takeProfit).toBe(setTpResult.price);
  });
});
