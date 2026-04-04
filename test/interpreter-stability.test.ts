/**
 * Interpreter Stability Tests
 *
 * Verifies deterministic command parsing, alias expansion,
 * input normalization, validation, and alert generation.
 */
import { describe, it, expect } from 'vitest';
import { localParse, validateIntent } from '../src/ai/interpreter.js';
import { ActionType, TradeSide } from '../src/types/index.js';
import { detectMalformedCommand } from '../src/utils/command-alerts.js';

// ─── Helper ──────────────────────────────────────────────────────────────────

type ParseResult = Record<string, unknown> | null;

// ─── Valid Open Commands ─────────────────────────────────────────────────────

describe('Open Command Parsing', () => {
  it('should parse standard open command', () => {
    const r = localParse('open 2x long SOL $100') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.OpenPosition);
    expect(r!.market).toBe('SOL');
    expect(r!.side).toBe(TradeSide.Long);
    expect(r!.leverage).toBe(2);
    expect(r!.collateral).toBe(100);
  });

  it('should parse open with market before side', () => {
    const r = localParse('open 5x ETH long $500') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.OpenPosition);
    expect(r!.market).toBe('ETH');
    expect(r!.side).toBe(TradeSide.Long);
    expect(r!.leverage).toBe(5);
    expect(r!.collateral).toBe(500);
  });

  it('should parse open with tp and sl', () => {
    const r = localParse('open 2x long SOL $100 tp $95 sl $80') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.takeProfit).toBe(95);
    expect(r!.stopLoss).toBe(80);
  });

  it('should parse open with "for" prefix', () => {
    const r = localParse('open 3x short BTC for $200') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.market).toBe('BTC');
    expect(r!.side).toBe(TradeSide.Short);
    expect(r!.collateral).toBe(200);
  });

  it('should parse open with decimal leverage', () => {
    const r = localParse('open 1.5x long SOL $50') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.leverage).toBe(1.5);
  });
});

// ─── Command Aliases ─────────────────────────────────────────────────────────

describe('Command Aliases', () => {
  it('should expand "o" to "open"', () => {
    const r = localParse('o 2x long SOL $100') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.OpenPosition);
    expect(r!.market).toBe('SOL');
  });

  it('should expand "c" to "close"', () => {
    const r = localParse('c SOL long') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.ClosePosition);
    expect(r!.market).toBe('SOL');
  });

  it('should expand "p" to "positions"', () => {
    const r = localParse('p') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.GetPositions);
  });

  it('should expand "pos" to "positions"', () => {
    const r = localParse('pos') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.GetPositions);
  });

  it('should expand "m" to "monitor"', () => {
    const r = localParse('m') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.MarketMonitor);
  });

  it('should expand "d" to "dashboard"', () => {
    const r = localParse('d') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.Dashboard);
  });

  it('should expand "w" to "wallet"', () => {
    const r = localParse('w') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.WalletStatus);
  });

  it('should expand "bal" to "portfolio"', () => {
    const r = localParse('bal') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.GetPortfolio);
  });

  it('should expand "c SOL long 50%" for partial close alias', () => {
    const r = localParse('c SOL long 50%') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.ClosePosition);
    expect(r!.closePercent).toBe(50);
  });
});

// ─── Input Normalization ─────────────────────────────────────────────────────

describe('Input Normalization', () => {
  it('should handle extra whitespace', () => {
    const r = localParse('  open   2x   long   SOL   $100  ') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.OpenPosition);
    expect(r!.market).toBe('SOL');
  });

  it('should handle tabs and newlines', () => {
    const r = localParse('open\t2x\tlong\tSOL\t$100') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.OpenPosition);
  });

  it('should handle control characters', () => {
    const r = localParse('open\x00 2x long SOL $100') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.OpenPosition);
  });

  it('should handle uppercase input', () => {
    const r = localParse('OPEN 2X LONG SOL $100') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.OpenPosition);
  });

  it('should handle mixed case input', () => {
    const r = localParse('Open 2x Long Sol $100') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.OpenPosition);
  });

  it('should normalize number words', () => {
    const r = localParse('POSITIONS') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.GetPositions);
  });

  it('should normalize asset aliases', () => {
    const r = localParse('open 2x long solana $100') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.market).toBe('SOL');
  });
});

// ─── Close Commands ──────────────────────────────────────────────────────────

describe('Close Command Parsing', () => {
  it('should parse full close', () => {
    const r = localParse('close SOL long') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.ClosePosition);
    expect(r!.closePercent).toBeUndefined();
    expect(r!.closeAmount).toBeUndefined();
  });

  it('should parse percentage close', () => {
    const r = localParse('close SOL long 50%') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.closePercent).toBe(50);
  });

  it('should parse dollar amount close', () => {
    const r = localParse('close BTC short $200') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.closeAmount).toBe(200);
  });

  it('should parse prefix percentage close', () => {
    const r = localParse('close 25% of SOL long') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.closePercent).toBe(25);
  });

  it('should parse prefix dollar amount close', () => {
    const r = localParse('close $50 of ETH long') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.closeAmount).toBe(50);
  });

  it('should parse "exit" alias', () => {
    const r = localParse('exit SOL long') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.ClosePosition);
  });

  it('should parse "sell" alias', () => {
    const r = localParse('sell SOL long 75%') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.ClosePosition);
    expect(r!.closePercent).toBe(75);
  });
});

// ─── TP/SL Commands ──────────────────────────────────────────────────────────

describe('TP/SL Parsing', () => {
  it('should parse set tp', () => {
    const r = localParse('set tp SOL long $95') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.SetTpSl);
    expect(r!.type).toBe('tp');
    expect(r!.price).toBe(95);
  });

  it('should parse set sl with "to" prefix', () => {
    const r = localParse('set sl BTC long to 60000') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.SetTpSl);
    expect(r!.type).toBe('sl');
    expect(r!.price).toBe(60000);
  });

  it('should parse remove tp', () => {
    const r = localParse('remove tp SOL long') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.RemoveTpSl);
    expect(r!.type).toBe('tp');
  });

  it('should return help for malformed set tp', () => {
    const r = localParse('set tp blah') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.Help);
  });
});

// ─── Limit Order Parsing ─────────────────────────────────────────────────────

describe('Limit Order Parsing', () => {
  it('should parse standard limit order', () => {
    const r = localParse('limit long SOL 2x $100 @ $82') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.LimitOrder);
    expect(r!.market).toBe('SOL');
    expect(r!.side).toBe(TradeSide.Long);
    expect(r!.leverage).toBe(2);
    expect(r!.limitPrice).toBe(82);
  });

  it('should parse limit with "at" keyword', () => {
    const r = localParse('limit short BTC 3x $200 at $72000') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.limitPrice).toBe(72000);
  });

  it('should return help for malformed limit', () => {
    const r = localParse('limit long SOL') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.Help);
  });
});

// ─── Collateral Commands ─────────────────────────────────────────────────────

describe('Collateral Command Parsing', () => {
  it('should parse add collateral', () => {
    const r = localParse('add $200 to SOL long') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.AddCollateral);
    expect(r!.amount).toBe(200);
  });

  it('should parse remove collateral', () => {
    const r = localParse('remove $100 from ETH long') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.RemoveCollateral);
    expect(r!.amount).toBe(100);
  });
});

// ─── Parameter Validation ────────────────────────────────────────────────────

describe('Parameter Validation', () => {
  it('should reject leverage below 1.1', () => {
    const intent = { action: ActionType.OpenPosition, market: 'SOL', side: TradeSide.Long, leverage: 0.5, collateral: 100 };
    const alert = validateIntent(intent as any);
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe('parameter');
  });

  it('should reject leverage above 1000', () => {
    const intent = { action: ActionType.OpenPosition, market: 'SOL', side: TradeSide.Long, leverage: 1500, collateral: 100 };
    const alert = validateIntent(intent as any);
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe('parameter');
  });

  it('should accept valid leverage', () => {
    const intent = { action: ActionType.OpenPosition, market: 'SOL', side: TradeSide.Long, leverage: 5, collateral: 100 };
    const alert = validateIntent(intent as any);
    expect(alert).toBeNull();
  });

  it('should reject negative collateral', () => {
    const intent = { action: ActionType.OpenPosition, market: 'SOL', side: TradeSide.Long, leverage: 2, collateral: -10 };
    const alert = validateIntent(intent as any);
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe('parameter');
  });

  it('should reject zero collateral', () => {
    const intent = { action: ActionType.OpenPosition, market: 'SOL', side: TradeSide.Long, leverage: 2, collateral: 0 };
    const alert = validateIntent(intent as any);
    expect(alert).not.toBeNull();
  });

  it('should reject percentage below 1', () => {
    const intent = { action: ActionType.ClosePosition, market: 'SOL', side: TradeSide.Long, closePercent: 0 };
    const alert = validateIntent(intent as any);
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe('parameter');
  });

  it('should reject percentage above 100', () => {
    const intent = { action: ActionType.ClosePosition, market: 'SOL', side: TradeSide.Long, closePercent: 150 };
    const alert = validateIntent(intent as any);
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe('parameter');
  });

  it('should accept valid percentage', () => {
    const intent = { action: ActionType.ClosePosition, market: 'SOL', side: TradeSide.Long, closePercent: 50 };
    const alert = validateIntent(intent as any);
    expect(alert).toBeNull();
  });

  it('should reject negative price', () => {
    const intent = { action: ActionType.SetTpSl, market: 'SOL', side: TradeSide.Long, type: 'tp', price: -100 };
    const alert = validateIntent(intent as any);
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe('parameter');
  });

  it('should reject unknown market for trading actions', () => {
    const intent = { action: ActionType.OpenPosition, market: 'FAKECOIN', side: TradeSide.Long, leverage: 2, collateral: 100 };
    const alert = validateIntent(intent as any);
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe('market');
  });

  it('should accept unknown market for non-trading actions', () => {
    const intent = { action: ActionType.Analyze, market: 'ANYMARKET' };
    const alert = validateIntent(intent as any);
    expect(alert).toBeNull();
  });
});

// ─── Malformed Command Detection ─────────────────────────────────────────────

describe('Malformed Command Detection', () => {
  it('should detect malformed open command', () => {
    const alert = detectMalformedCommand('open sol');
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe('syntax');
  });

  it('should detect malformed open without leverage', () => {
    const alert = detectMalformedCommand('open long sol $100');
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe('syntax');
  });

  it('should not trigger for valid non-open commands', () => {
    const alert = detectMalformedCommand('positions');
    expect(alert).toBeNull();
  });

  it('should not trigger for "open interest"', () => {
    const alert = detectMalformedCommand('open interest');
    expect(alert).toBeNull();
  });

  it('should detect malformed close with invalid suffix', () => {
    const alert = detectMalformedCommand('close something weird');
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe('syntax');
  });

  it('should detect malformed add command', () => {
    const alert = detectMalformedCommand('add more stuff');
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe('syntax');
  });
});

// ─── Simple Commands ─────────────────────────────────────────────────────────

describe('Simple Command Parsing', () => {
  it('should parse "help"', () => {
    const r = localParse('help') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.Help);
  });

  it('should parse "?"', () => {
    const r = localParse('?') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.Help);
  });

  it('should parse "markets"', () => {
    const r = localParse('markets') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.FlashMarkets);
  });

  it('should parse "dashboard"', () => {
    const r = localParse('dashboard') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.Dashboard);
  });

  it('should parse "volume"', () => {
    const r = localParse('volume') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.GetVolume);
  });

  it('should parse "risk report"', () => {
    const r = localParse('risk report') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.RiskReport);
  });

  it('should parse "risk" as risk report', () => {
    const r = localParse('risk') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.RiskReport);
  });

  it('should parse wallet commands', () => {
    expect((localParse('wallet') as ParseResult)!.action).toBe(ActionType.WalletStatus);
    expect((localParse('wallet balance') as ParseResult)!.action).toBe(ActionType.WalletBalance);
    expect((localParse('wallet tokens') as ParseResult)!.action).toBe(ActionType.WalletTokens);
    expect((localParse('wallet list') as ParseResult)!.action).toBe(ActionType.WalletList);
    expect((localParse('wallet disconnect') as ParseResult)!.action).toBe(ActionType.WalletDisconnect);
  });

  it('should parse "monitor"', () => {
    const r = localParse('monitor') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.MarketMonitor);
  });

  it('should parse "trade history"', () => {
    const r = localParse('trade history') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.TradeHistory);
  });

  it('should parse "trades" alias', () => {
    const r = localParse('trades') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.TradeHistory);
  });
});

// ─── Cancel/Edit Order Commands ──────────────────────────────────────────────

describe('Order Commands', () => {
  it('should parse cancel order', () => {
    const r = localParse('cancel order 0') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.CancelOrder);
    expect(r!.orderId).toBe('0');
  });

  it('should parse cancel order with #', () => {
    const r = localParse('cancel order #3') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.orderId).toBe('3');
  });

  it('should parse edit limit', () => {
    const r = localParse('edit limit 0 $85') as ParseResult;
    expect(r).not.toBeNull();
    expect(r!.action).toBe(ActionType.EditLimitOrder);
  });
});

// ─── Determinism Check ───────────────────────────────────────────────────────

describe('Determinism', () => {
  it('should parse the same command identically every time', () => {
    const command = 'open 3x long SOL $200';
    const results = Array.from({ length: 10 }, () => localParse(command));
    for (const r of results) {
      expect(r).toEqual(results[0]);
    }
  });

  it('should never produce ambiguous output', () => {
    // Every parsed result must have exactly one action
    const commands = [
      'open 2x long SOL $100',
      'close SOL long',
      'close SOL long 50%',
      'add $50 to SOL long',
      'remove $25 from BTC short',
      'set tp SOL long $95',
      'limit long SOL 2x $100 @ $82',
      'positions',
      'help',
      'markets',
      'monitor',
    ];
    for (const cmd of commands) {
      const r = localParse(cmd) as ParseResult;
      expect(r).not.toBeNull();
      expect(r!.action).toBeDefined();
      expect(typeof r!.action).toBe('string');
    }
  });
});
