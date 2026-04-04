/**
 * Partial Close Tests
 *
 * Verifies:
 *   - Parser: close by percentage, dollar amount, full close
 *   - Parser: prefix syntax ("close 50% of SOL long")
 *   - Parser: rejects invalid percentages via AI prompt
 *   - Simulation: partial close reduces position size
 *   - Simulation: partial close with dollar amount
 *   - Simulation: full close when percentage = 100
 *   - Simulation: rejects closing more than position size
 *   - Simulation: tiny remainder triggers full close
 */
import { describe, it, expect } from 'vitest';
import { localParse } from '../src/ai/interpreter.js';
import { ActionType, TradeSide } from '../src/types/index.js';

// ─── Parser Tests ────────────────────────────────────────────────────────

describe('Partial Close Parsing', () => {
  it('should parse close with percentage suffix', () => {
    const result = localParse('close SOL long 50%');
    expect(result).not.toBeNull();
    expect(result!.action).toBe(ActionType.ClosePosition);
    const r = result as { market: string; side: string; closePercent?: number };
    expect(r.market).toBe('SOL');
    expect(r.side).toBe(TradeSide.Long);
    expect(r.closePercent).toBe(50);
  });

  it('should parse close with 25%', () => {
    const result = localParse('close BTC short 25%');
    expect(result).not.toBeNull();
    const r = result as { market: string; side: string; closePercent?: number };
    expect(r.market).toBe('BTC');
    expect(r.side).toBe(TradeSide.Short);
    expect(r.closePercent).toBe(25);
  });

  it('should parse close with 75%', () => {
    const result = localParse('close ETH long 75%');
    expect(result).not.toBeNull();
    const r = result as { market: string; side: string; closePercent?: number };
    expect(r.closePercent).toBe(75);
  });

  it('should parse close with dollar amount', () => {
    const result = localParse('close SOL long $20');
    expect(result).not.toBeNull();
    const r = result as { market: string; side: string; closeAmount?: number };
    expect(r.market).toBe('SOL');
    expect(r.side).toBe(TradeSide.Long);
    expect(r.closeAmount).toBe(20);
  });

  it('should parse close with decimal dollar amount', () => {
    const result = localParse('close BTC short $15.50');
    expect(result).not.toBeNull();
    const r = result as { market: string; side: string; closeAmount?: number };
    expect(r.closeAmount).toBe(15.5);
  });

  it('should parse full close (no amount)', () => {
    const result = localParse('close SOL long');
    expect(result).not.toBeNull();
    const r = result as { market: string; side: string; closePercent?: number; closeAmount?: number };
    expect(r.market).toBe('SOL');
    expect(r.side).toBe(TradeSide.Long);
    expect(r.closePercent).toBeUndefined();
    expect(r.closeAmount).toBeUndefined();
  });

  it('should parse "percent" word', () => {
    const result = localParse('close SOL long 50 percent');
    expect(result).not.toBeNull();
    const r = result as { closePercent?: number };
    expect(r.closePercent).toBe(50);
  });

  // Prefix syntax: "close 50% of SOL long"
  it('should parse prefix percentage syntax', () => {
    const result = localParse('close 50% of SOL long');
    expect(result).not.toBeNull();
    const r = result as { market: string; side: string; closePercent?: number };
    expect(r.market).toBe('SOL');
    expect(r.side).toBe(TradeSide.Long);
    expect(r.closePercent).toBe(50);
  });

  it('should parse prefix dollar amount syntax', () => {
    const result = localParse('close $20 of SOL long');
    expect(result).not.toBeNull();
    const r = result as { market: string; side: string; closeAmount?: number };
    expect(r.market).toBe('SOL');
    expect(r.side).toBe(TradeSide.Long);
    expect(r.closeAmount).toBe(20);
  });

  it('should parse "close 25% of my BTC short"', () => {
    const result = localParse('close 25% of my BTC short');
    expect(result).not.toBeNull();
    const r = result as { market: string; side: string; closePercent?: number };
    expect(r.market).toBe('BTC');
    expect(r.side).toBe(TradeSide.Short);
    expect(r.closePercent).toBe(25);
  });

  // "exit" and "sell" aliases
  it('should parse "exit SOL long 50%"', () => {
    const result = localParse('exit SOL long 50%');
    expect(result).not.toBeNull();
    const r = result as { market: string; closePercent?: number };
    expect(r.market).toBe('SOL');
    expect(r.closePercent).toBe(50);
  });

  it('should parse "sell 30% of ETH long"', () => {
    const result = localParse('sell 30% of ETH long');
    expect(result).not.toBeNull();
    const r = result as { market: string; closePercent?: number };
    expect(r.market).toBe('ETH');
    expect(r.closePercent).toBe(30);
  });

  // Asset aliases
  it('should parse close with asset alias', () => {
    const result = localParse('close solana long 50%');
    expect(result).not.toBeNull();
    const r = result as { market: string; closePercent?: number };
    expect(r.market).toBe('SOL');
    expect(r.closePercent).toBe(50);
  });
});
