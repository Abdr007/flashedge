/**
 * Tests for Close All, Swap, and Earn command parsing.
 */

import { describe, it, expect, vi } from 'vitest';
import { ActionType } from '../src/types/index.js';

// Mock dependencies for interpreter
vi.mock('../src/data/prices.js', () => ({
  PriceService: class {
    async getPrices(symbols: string[]) {
      return new Map();
    }
  },
}));

vi.mock('../src/data/fstats.js', () => ({
  FStatsClient: class { async getOpenPositions() { return []; } },
}));

vi.mock('../src/utils/protocol-fees.js', () => ({
  getProtocolFeeRates: async () => ({
    openFeeRate: 0.0008, closeFeeRate: 0.0008,
    maintenanceMarginRate: 0.01, maxLeverage: 100, source: 'sdk-default' as const,
  }),
  calcFeeUsd: (sizeUsd: number, feeRate: number) => sizeUsd * feeRate,
}));

vi.mock('../src/config/index.js', () => ({
  getAllMarkets: () => ['SOL', 'BTC', 'ETH', 'USDC'],
  getMaxLeverage: () => 100,
}));

vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, trade: () => {} }),
}));

// Import after mocks
const { localParse } = await import('../src/ai/interpreter.js');

describe('Close All parsing', () => {
  it('parses "close all"', () => {
    const result = localParse('close all');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.CloseAll);
  });

  it('parses "close all positions"', () => {
    const result = localParse('close all positions');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.CloseAll);
  });

  it('parses "close-all"', () => {
    const result = localParse('close-all');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.CloseAll);
  });

  it('parses "exit all"', () => {
    const result = localParse('exit all');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.CloseAll);
  });

  it('parses "ca" alias', () => {
    const result = localParse('ca');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.CloseAll);
  });
});

describe('Swap parsing', () => {
  it('parses "swap 10 SOL to USDC"', () => {
    const result = localParse('swap 10 SOL to USDC');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.Swap);
    const r = result as any;
    expect(r.inputToken).toBe('SOL');
    expect(r.outputToken).toBe('USDC');
    expect(r.amount).toBe(10);
  });

  it('parses "swap SOL to USDC $50"', () => {
    const result = localParse('swap SOL to USDC $50');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.Swap);
    const r = result as any;
    expect(r.inputToken).toBe('SOL');
    expect(r.outputToken).toBe('USDC');
    expect(r.amount).toBe(50);
  });

  it('parses "swap SOL USDC $10"', () => {
    const result = localParse('swap SOL USDC $10');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.Swap);
    const r = result as any;
    expect(r.inputToken).toBe('SOL');
    expect(r.outputToken).toBe('USDC');
    expect(r.amount).toBe(10);
  });

  it('parses "swap $50 USDC to SOL"', () => {
    const result = localParse('swap $50 USDC to SOL');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.Swap);
    const r = result as any;
    expect(r.inputToken).toBe('USDC');
    expect(r.outputToken).toBe('SOL');
    expect(r.amount).toBe(50);
  });

  it('parses "swap SOL for USDC $25"', () => {
    const result = localParse('swap SOL for USDC $25');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.Swap);
    const r = result as any;
    expect(r.amount).toBe(25);
  });

  it('bare "swap" returns help', () => {
    const result = localParse('swap');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.Help);
  });
});

describe('Earn parsing', () => {
  it('parses "earn add-liquidity $100"', () => {
    const result = localParse('earn add-liquidity $100');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.EarnAddLiquidity);
    const r = result as any;
    expect(r.amount).toBe(100);
    expect(r.token).toBe('USDC');
  });

  it('parses "earn add liquidity $200"', () => {
    const result = localParse('earn add liquidity $200');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.EarnAddLiquidity);
    const r = result as any;
    expect(r.amount).toBe(200);
    expect(r.token).toBe('USDC');
  });

  it('parses "earn remove-liquidity 50%"', () => {
    const result = localParse('earn remove-liquidity 50%');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.EarnRemoveLiquidity);
    const r = result as any;
    expect(r.percent).toBe(50);
  });

  it('parses "earn remove liquidity 25%"', () => {
    const result = localParse('earn remove liquidity 25%');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.EarnRemoveLiquidity);
  });

  it('parses "earn stake $200"', () => {
    const result = localParse('earn stake $200');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.EarnStake);
    const r = result as any;
    expect(r.amount).toBe(200);
  });

  it('parses "earn stake-flp $500"', () => {
    const result = localParse('earn stake-flp $500');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.EarnStake);
    const r = result as any;
    expect(r.amount).toBe(500);
  });

  it('parses "earn unstake 25%"', () => {
    const result = localParse('earn unstake 25%');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.EarnUnstake);
    const r = result as any;
    expect(r.percent).toBe(25);
  });

  it('parses "earn unstake-flp 100%"', () => {
    const result = localParse('earn unstake-flp 100%');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.EarnUnstake);
  });

  it('parses "earn claim"', () => {
    const result = localParse('earn claim');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.EarnClaimRewards);
  });

  it('parses "earn claim-rewards"', () => {
    const result = localParse('earn claim-rewards');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.EarnClaimRewards);
  });

  it('parses "earn claim rewards"', () => {
    const result = localParse('earn claim rewards');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.EarnClaimRewards);
  });

  it('parses "earn" as earn status', () => {
    const result = localParse('earn');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.EarnStatus);
  });

  it('parses "earn status"', () => {
    const result = localParse('earn status');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.EarnStatus);
  });
});

describe('Earn pool targeting', () => {
  it('parses "earn add-liquidity $100 pool:Crypto.1"', () => {
    const result = localParse('earn add-liquidity $100 pool:Crypto.1');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.EarnAddLiquidity);
    const r = result as any;
    expect(r.amount).toBe(100);
    expect(r.pool).toBe('Crypto.1');
  });

  it('parses "earn stake $200 pool:Virtual.1"', () => {
    const result = localParse('earn stake $200 pool:Virtual.1');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.EarnStake);
    const r = result as any;
    expect(r.amount).toBe(200);
    expect(r.pool).toBe('Virtual.1');
  });

  it('parses "earn unstake 50% pool:Governance.1"', () => {
    const result = localParse('earn unstake 50% pool:Governance.1');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.EarnUnstake);
    const r = result as any;
    expect(r.percent).toBe(50);
    expect(r.pool).toBe('Governance.1');
  });

  it('parses "earn claim pool:Ondo.1"', () => {
    const result = localParse('earn claim pool:Ondo.1');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.EarnClaimRewards);
    const r = result as any;
    expect(r.pool).toBe('Ondo.1');
  });

  it('parses "earn remove-liquidity 25% pool:Crypto.1"', () => {
    const result = localParse('earn remove-liquidity 25% pool:Crypto.1');
    expect(result).toBeDefined();
    expect(result!.action).toBe(ActionType.EarnRemoveLiquidity);
    const r = result as any;
    expect(r.percent).toBe(25);
    expect(r.pool).toBe('Crypto.1');
  });

  it('no pool defaults to Crypto.1', () => {
    const result = localParse('earn stake $100');
    expect(result).toBeDefined();
    const r = result as any;
    expect(r.pool).toBe('Crypto.1');
  });
});
