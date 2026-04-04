/**
 * Behavior-locking tests for TradingGate (kill switch + exposure control).
 */

import { describe, it, expect, vi } from 'vitest';
import { TradingGate } from '../src/security/trading-gate.js';
import type { IFlashClient } from '../src/types/index.js';

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    trade: () => {},
  }),
}));

// Helper: create a mock flash client with given positions
function mockClient(positions: Array<{ sizeUsd: number }>): IFlashClient {
  return {
    getPositions: async () => positions.map(p => ({
      market: 'SOL',
      side: 'long' as const,
      sizeUsd: p.sizeUsd,
      collateralUsd: p.sizeUsd / 5,
      leverage: 5,
      entryPrice: 150,
      markPrice: 150,
      liquidationPrice: 120,
      unrealizedPnl: 0,
      unrealizedPnlPercent: 0,
      openFee: 0,
      totalFees: 0,
    })),
  } as unknown as IFlashClient;
}

describe('TradingGate', () => {

  // ─── Kill Switch ──────────────────────────────────────────────────────

  describe('kill switch', () => {
    it('allows trading when enabled', () => {
      const gate = new TradingGate({ tradingEnabled: true });
      expect(gate.checkKillSwitch().allowed).toBe(true);
    });

    it('blocks trading when disabled', () => {
      const gate = new TradingGate({ tradingEnabled: false });
      const check = gate.checkKillSwitch();
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain('disabled');
    });

    it('disable() blocks trading at runtime', () => {
      const gate = new TradingGate({ tradingEnabled: true });
      expect(gate.tradingEnabled).toBe(true);

      gate.disable('emergency');
      expect(gate.tradingEnabled).toBe(false);
      expect(gate.checkKillSwitch().allowed).toBe(false);
    });

    it('enable() resumes trading at runtime', () => {
      const gate = new TradingGate({ tradingEnabled: false });
      gate.enable();
      expect(gate.tradingEnabled).toBe(true);
      expect(gate.checkKillSwitch().allowed).toBe(true);
    });
  });

  // ─── Exposure Control ─────────────────────────────────────────────────

  describe('exposure control', () => {
    it('allows when no limit configured', async () => {
      const gate = new TradingGate({ maxPortfolioExposure: 0 });
      const check = await gate.checkExposure(10000, mockClient([{ sizeUsd: 5000 }]));
      expect(check.allowed).toBe(true);
    });

    it('allows when projected exposure is under limit', async () => {
      const gate = new TradingGate({ maxPortfolioExposure: 20000 });
      const client = mockClient([{ sizeUsd: 5000 }]);
      const check = await gate.checkExposure(10000, client); // 5000 + 10000 = 15000 < 20000
      expect(check.allowed).toBe(true);
    });

    it('blocks when projected exposure exceeds limit', async () => {
      const gate = new TradingGate({ maxPortfolioExposure: 10000 });
      const client = mockClient([{ sizeUsd: 5000 }]);
      const check = await gate.checkExposure(8000, client); // 5000 + 8000 = 13000 > 10000
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain('exposure limit exceeded');
    });

    it('includes current and projected amounts in reason', async () => {
      const gate = new TradingGate({ maxPortfolioExposure: 10000 });
      const client = mockClient([{ sizeUsd: 7000 }]);
      const check = await gate.checkExposure(5000, client);
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain('7000.00');
      expect(check.reason).toContain('5000.00');
      expect(check.reason).toContain('12000.00');
    });

    it('allows when no existing positions', async () => {
      const gate = new TradingGate({ maxPortfolioExposure: 10000 });
      const client = mockClient([]);
      const check = await gate.checkExposure(5000, client);
      expect(check.allowed).toBe(true);
    });

    it('allows trade when position fetch fails (non-blocking)', async () => {
      const gate = new TradingGate({ maxPortfolioExposure: 10000 });
      const failingClient = {
        getPositions: async () => { throw new Error('RPC timeout'); },
      } as unknown as IFlashClient;
      const check = await gate.checkExposure(50000, failingClient);
      expect(check.allowed).toBe(true); // fail-open by design
    });

    it('sums multiple positions correctly', async () => {
      const gate = new TradingGate({ maxPortfolioExposure: 20000 });
      const client = mockClient([
        { sizeUsd: 5000 },
        { sizeUsd: 8000 },
        { sizeUsd: 3000 },
      ]); // total: 16000
      const check = await gate.checkExposure(5000, client); // 16000 + 5000 = 21000 > 20000
      expect(check.allowed).toBe(false);
    });
  });

  // ─── Property accessors ───────────────────────────────────────────────

  it('exposes tradingEnabled getter', () => {
    const gate = new TradingGate({ tradingEnabled: false });
    expect(gate.tradingEnabled).toBe(false);
  });

  it('exposes maxPortfolioExposure getter', () => {
    const gate = new TradingGate({ maxPortfolioExposure: 50000 });
    expect(gate.maxPortfolioExposure).toBe(50000);
  });
});
