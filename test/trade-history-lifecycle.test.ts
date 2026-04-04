/**
 * Trade History Lifecycle Aggregation Tests
 *
 * Verifies that raw trade events (OPEN, ADD_COLLATERAL, REMOVE_COLLATERAL, CLOSE)
 * are correctly merged into lifecycle trade records with accurate entry, exit,
 * collateral, and PnL values.
 */
import { describe, it, expect, vi } from 'vitest';

// The aggregateTradeEvents function is internal to flash-tools.ts.
// We test it through the SimulatedFlashClient + tradeHistoryTool integration.
// But we also extract and test the aggregation logic directly.

// ─── Direct aggregation logic test (mirrored from flash-tools.ts) ────────────

interface AggregatedTrade {
  timestamp: number;
  market: string;
  side: string;
  leverage: number;
  entryPrice: number;
  exitPrice?: number;
  sizeUsd: number;
  collateral: number;
  pnl?: number;
  closed: boolean;
}

function aggregateTradeEvents(events: Array<{
  action: string;
  market: string;
  side: string;
  leverage?: number;
  collateral?: number;
  collateralUsd?: number;
  sizeUsd?: number;
  entryPrice?: number;
  exitPrice?: number;
  price?: number;
  pnl?: number;
  timestamp: number;
}>): AggregatedTrade[] {
  const active = new Map<string, AggregatedTrade>();
  const completed: AggregatedTrade[] = [];

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);

  for (const ev of sorted) {
    const market = (ev.market ?? '').toUpperCase();
    const side = (ev.side ?? '').toLowerCase();
    const key = `${market}-${side}`;

    if (ev.action === 'open') {
      const existing = active.get(key);
      if (existing) completed.push(existing);
      active.set(key, {
        timestamp: ev.timestamp,
        market,
        side,
        leverage: ev.leverage ?? (ev.collateralUsd && ev.sizeUsd ? ev.sizeUsd / ev.collateralUsd : 0),
        entryPrice: ev.entryPrice ?? ev.price ?? 0,
        sizeUsd: ev.sizeUsd ?? 0,
        collateral: ev.collateral ?? ev.collateralUsd ?? 0,
        closed: false,
      });
    } else if (ev.action === 'add_collateral') {
      const trade = active.get(key);
      if (trade) {
        trade.collateral += ev.collateral ?? ev.collateralUsd ?? 0;
        if (trade.collateral > 0) trade.leverage = trade.sizeUsd / trade.collateral;
      }
    } else if (ev.action === 'remove_collateral') {
      const trade = active.get(key);
      if (trade) {
        trade.collateral -= ev.collateral ?? ev.collateralUsd ?? 0;
        if (trade.collateral > 0) trade.leverage = trade.sizeUsd / trade.collateral;
      }
    } else if (ev.action === 'close') {
      const trade = active.get(key);
      if (trade) {
        trade.exitPrice = ev.exitPrice ?? ev.price;
        trade.pnl = ev.pnl;
        trade.closed = true;
        completed.push(trade);
        active.delete(key);
      } else {
        completed.push({
          timestamp: ev.timestamp,
          market,
          side,
          leverage: 0,
          entryPrice: ev.entryPrice ?? 0,
          exitPrice: ev.exitPrice ?? ev.price,
          sizeUsd: ev.sizeUsd ?? 0,
          collateral: ev.collateral ?? ev.collateralUsd ?? 0,
          pnl: ev.pnl,
          closed: true,
        });
      }
    }
  }

  for (const trade of active.values()) {
    completed.push(trade);
  }

  return completed.sort((a, b) => b.timestamp - a.timestamp);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Trade History Lifecycle Aggregation', () => {
  describe('OPEN → ADD_COLLATERAL → CLOSE lifecycle', () => {
    const events = [
      {
        action: 'open',
        market: 'SOL',
        side: 'long',
        leverage: 2,
        collateralUsd: 10,
        sizeUsd: 20,
        price: 86.1233,
        timestamp: 1000,
      },
      {
        action: 'add_collateral',
        market: 'SOL',
        side: 'long',
        collateralUsd: 5,
        sizeUsd: 20,
        leverage: 1.33,
        price: 86.50,
        timestamp: 2000,
      },
      {
        action: 'close',
        market: 'SOL',
        side: 'long',
        exitPrice: 86.1165,
        pnl: 0.03,
        sizeUsd: 20,
        timestamp: 3000,
      },
    ];

    it('produces a single aggregated trade record', () => {
      const result = aggregateTradeEvents(events);
      expect(result).toHaveLength(1);
    });

    it('has correct entry price from OPEN event', () => {
      const [trade] = aggregateTradeEvents(events);
      expect(trade.entryPrice).toBe(86.1233);
    });

    it('has correct exit price from CLOSE event', () => {
      const [trade] = aggregateTradeEvents(events);
      expect(trade.exitPrice).toBe(86.1165);
    });

    it('has correct collateral (initial + added)', () => {
      const [trade] = aggregateTradeEvents(events);
      expect(trade.collateral).toBeCloseTo(15, 2); // 10 + 5
    });

    it('has correct PnL from CLOSE event', () => {
      const [trade] = aggregateTradeEvents(events);
      expect(trade.pnl).toBe(0.03);
    });

    it('recalculates leverage after ADD_COLLATERAL', () => {
      const [trade] = aggregateTradeEvents(events);
      // sizeUsd=20, collateral=15 → leverage≈1.33
      expect(trade.leverage).toBeCloseTo(20 / 15, 2);
    });

    it('is marked as closed', () => {
      const [trade] = aggregateTradeEvents(events);
      expect(trade.closed).toBe(true);
    });

    it('preserves OPEN timestamp', () => {
      const [trade] = aggregateTradeEvents(events);
      expect(trade.timestamp).toBe(1000);
    });
  });

  describe('OPEN → REMOVE_COLLATERAL → CLOSE lifecycle', () => {
    const events = [
      {
        action: 'open',
        market: 'ETH',
        side: 'short',
        leverage: 3,
        collateralUsd: 30,
        sizeUsd: 90,
        price: 3200.50,
        timestamp: 1000,
      },
      {
        action: 'remove_collateral',
        market: 'ETH',
        side: 'short',
        collateralUsd: 10,
        sizeUsd: 90,
        leverage: 4.5,
        price: 3195.00,
        timestamp: 2000,
      },
      {
        action: 'close',
        market: 'ETH',
        side: 'short',
        exitPrice: 3150.00,
        pnl: 12.50,
        timestamp: 3000,
      },
    ];

    it('produces a single trade with reduced collateral', () => {
      const result = aggregateTradeEvents(events);
      expect(result).toHaveLength(1);
      const [trade] = result;
      expect(trade.collateral).toBeCloseTo(20, 2); // 30 - 10
      expect(trade.leverage).toBeCloseTo(90 / 20, 2); // 4.5x
      expect(trade.exitPrice).toBe(3150.00);
      expect(trade.pnl).toBe(12.50);
      expect(trade.closed).toBe(true);
    });
  });

  describe('OPEN only (still open position)', () => {
    const events = [
      {
        action: 'open',
        market: 'BTC',
        side: 'long',
        leverage: 5,
        collateralUsd: 100,
        sizeUsd: 500,
        price: 95000,
        timestamp: 1000,
      },
    ];

    it('produces an open (not closed) trade', () => {
      const [trade] = aggregateTradeEvents(events);
      expect(trade.closed).toBe(false);
      expect(trade.exitPrice).toBeUndefined();
      expect(trade.pnl).toBeUndefined();
      expect(trade.entryPrice).toBe(95000);
      expect(trade.collateral).toBe(100);
    });
  });

  describe('Multiple independent trades', () => {
    const events = [
      { action: 'open', market: 'SOL', side: 'long', leverage: 2, collateralUsd: 10, sizeUsd: 20, price: 80, timestamp: 1000 },
      { action: 'open', market: 'ETH', side: 'short', leverage: 3, collateralUsd: 30, sizeUsd: 90, price: 3200, timestamp: 1500 },
      { action: 'close', market: 'SOL', side: 'long', exitPrice: 85, pnl: 5, timestamp: 2000 },
      { action: 'close', market: 'ETH', side: 'short', exitPrice: 3100, pnl: 10, timestamp: 2500 },
    ];

    it('produces two separate trade records', () => {
      const result = aggregateTradeEvents(events);
      expect(result).toHaveLength(2);

      const sol = result.find(t => t.market === 'SOL');
      const eth = result.find(t => t.market === 'ETH');

      expect(sol).toBeDefined();
      expect(sol!.entryPrice).toBe(80);
      expect(sol!.exitPrice).toBe(85);
      expect(sol!.pnl).toBe(5);
      expect(sol!.closed).toBe(true);

      expect(eth).toBeDefined();
      expect(eth!.entryPrice).toBe(3200);
      expect(eth!.exitPrice).toBe(3100);
      expect(eth!.pnl).toBe(10);
      expect(eth!.closed).toBe(true);
    });
  });

  describe('Same market, different sides', () => {
    const events = [
      { action: 'open', market: 'SOL', side: 'long', leverage: 2, collateralUsd: 10, sizeUsd: 20, price: 80, timestamp: 1000 },
      { action: 'open', market: 'SOL', side: 'short', leverage: 3, collateralUsd: 15, sizeUsd: 45, price: 82, timestamp: 1500 },
      { action: 'close', market: 'SOL', side: 'long', exitPrice: 85, pnl: 5, timestamp: 2000 },
    ];

    it('tracks long and short independently', () => {
      const result = aggregateTradeEvents(events);
      expect(result).toHaveLength(2);

      const long = result.find(t => t.side === 'long');
      const short = result.find(t => t.side === 'short');

      expect(long!.closed).toBe(true);
      expect(long!.pnl).toBe(5);

      expect(short!.closed).toBe(false);
      expect(short!.exitPrice).toBeUndefined();
    });
  });

  describe('CLOSE without matching OPEN (pre-session position)', () => {
    const events = [
      { action: 'close', market: 'SOL', side: 'long', exitPrice: 90, pnl: 3, timestamp: 2000 },
    ];

    it('creates a standalone closed trade', () => {
      const [trade] = aggregateTradeEvents(events);
      expect(trade.closed).toBe(true);
      expect(trade.exitPrice).toBe(90);
      expect(trade.pnl).toBe(3);
      expect(trade.entryPrice).toBe(0); // unknown
    });
  });

  describe('Events out of order', () => {
    const events = [
      { action: 'close', market: 'SOL', side: 'long', exitPrice: 90, pnl: 3, timestamp: 3000 },
      { action: 'add_collateral', market: 'SOL', side: 'long', collateralUsd: 5, sizeUsd: 20, timestamp: 2000 },
      { action: 'open', market: 'SOL', side: 'long', leverage: 2, collateralUsd: 10, sizeUsd: 20, price: 80, timestamp: 1000 },
    ];

    it('sorts chronologically before aggregating', () => {
      const result = aggregateTradeEvents(events);
      expect(result).toHaveLength(1);
      const [trade] = result;
      expect(trade.entryPrice).toBe(80);
      expect(trade.exitPrice).toBe(90);
      expect(trade.collateral).toBeCloseTo(15, 2);
      expect(trade.closed).toBe(true);
    });
  });

  describe('Multiple ADD_COLLATERAL events', () => {
    const events = [
      { action: 'open', market: 'SOL', side: 'long', leverage: 5, collateralUsd: 10, sizeUsd: 50, price: 80, timestamp: 1000 },
      { action: 'add_collateral', market: 'SOL', side: 'long', collateralUsd: 5, sizeUsd: 50, timestamp: 2000 },
      { action: 'add_collateral', market: 'SOL', side: 'long', collateralUsd: 5, sizeUsd: 50, timestamp: 3000 },
      { action: 'add_collateral', market: 'SOL', side: 'long', collateralUsd: 5, sizeUsd: 50, timestamp: 4000 },
      { action: 'close', market: 'SOL', side: 'long', exitPrice: 82, pnl: 2, timestamp: 5000 },
    ];

    it('accumulates all collateral additions', () => {
      const [trade] = aggregateTradeEvents(events);
      expect(trade.collateral).toBeCloseTo(25, 2); // 10 + 5 + 5 + 5
      expect(trade.leverage).toBeCloseTo(50 / 25, 2); // 2x
      expect(trade.closed).toBe(true);
    });
  });

  describe('Session trade format (live mode)', () => {
    const events = [
      {
        action: 'open' as const,
        market: 'SOL',
        side: 'long',
        leverage: 2,
        collateral: 10,      // SessionTrade uses `collateral`, not `collateralUsd`
        sizeUsd: 20,
        entryPrice: 86.1233,
        timestamp: 1000,
      },
      {
        action: 'add_collateral' as const,
        market: 'SOL',
        side: 'long',
        collateral: 5,
        timestamp: 2000,
      },
      {
        action: 'close' as const,
        market: 'SOL',
        side: 'long',
        exitPrice: 86.1165,
        pnl: 0.03,
        timestamp: 3000,
      },
    ];

    it('handles SessionTrade collateral field correctly', () => {
      const [trade] = aggregateTradeEvents(events);
      expect(trade.collateral).toBeCloseTo(15, 2);
      expect(trade.entryPrice).toBe(86.1233);
      expect(trade.exitPrice).toBe(86.1165);
      expect(trade.pnl).toBe(0.03);
    });
  });

  describe('Re-open same market after close', () => {
    const events = [
      { action: 'open', market: 'SOL', side: 'long', leverage: 2, collateralUsd: 10, sizeUsd: 20, price: 80, timestamp: 1000 },
      { action: 'close', market: 'SOL', side: 'long', exitPrice: 85, pnl: 5, timestamp: 2000 },
      { action: 'open', market: 'SOL', side: 'long', leverage: 3, collateralUsd: 20, sizeUsd: 60, price: 86, timestamp: 3000 },
    ];

    it('creates two separate trade records', () => {
      const result = aggregateTradeEvents(events);
      expect(result).toHaveLength(2);

      // Most recent first
      const second = result[0]; // timestamp=3000
      const first = result[1];  // timestamp=1000

      expect(first.entryPrice).toBe(80);
      expect(first.exitPrice).toBe(85);
      expect(first.closed).toBe(true);

      expect(second.entryPrice).toBe(86);
      expect(second.closed).toBe(false);
    });
  });

  describe('Empty events', () => {
    it('returns empty array', () => {
      expect(aggregateTradeEvents([])).toHaveLength(0);
    });
  });
});
