/**
 * Earn command parser tests — natural language pool aliases.
 *
 * Verifies that human-friendly earn commands resolve to correct
 * protocol pool names internally.
 */

import { describe, it, expect, vi } from 'vitest';
import { ActionType } from '../src/types/index.js';

// Mock dependencies for interpreter
vi.mock('../src/data/prices.js', () => ({
  PriceService: class {
    async getPrices() { return new Map(); }
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
  calcFeeUsd: (s: number, r: number) => s * r,
}));
vi.mock('../src/config/index.js', () => ({
  getAllMarkets: () => ['SOL', 'BTC', 'ETH', 'USDC'],
  getMaxLeverage: () => 100,
}));
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, trade: () => {} }),
}));

const { localParse } = await import('../src/ai/interpreter.js');

// ─── Add Liquidity ──────────────────────────────────────────────────────────

describe('earn add (natural language)', () => {
  it('"earn add $100 crypto" → Crypto.1', () => {
    const r = localParse('earn add $100 crypto') as any;
    expect(r.action).toBe(ActionType.EarnAddLiquidity);
    expect(r.amount).toBe(100);
    expect(r.pool).toBe('Crypto.1');
  });

  it('"earn add $50 governance" → Governance.1', () => {
    const r = localParse('earn add $50 governance') as any;
    expect(r.action).toBe(ActionType.EarnAddLiquidity);
    expect(r.amount).toBe(50);
    expect(r.pool).toBe('Governance.1');
  });

  it('"earn add $200 virtual" → Virtual.1', () => {
    const r = localParse('earn add $200 virtual') as any;
    expect(r.action).toBe(ActionType.EarnAddLiquidity);
    expect(r.amount).toBe(200);
    expect(r.pool).toBe('Virtual.1');
  });

  it('"earn add $100 meme" → Community.1', () => {
    const r = localParse('earn add $100 meme') as any;
    expect(r.action).toBe(ActionType.EarnAddLiquidity);
    expect(r.pool).toBe('Community.1');
  });

  // RWA/Ondo pool excluded — tests removed

  it('"earn add $100" defaults to Crypto.1', () => {
    const r = localParse('earn add $100') as any;
    expect(r.action).toBe(ActionType.EarnAddLiquidity);
    expect(r.amount).toBe(100);
    expect(r.pool).toBe('Crypto.1');
  });

  it('"earn add-liquidity $100 governance" still works (legacy)', () => {
    const r = localParse('earn add-liquidity $100 governance') as any;
    expect(r.action).toBe(ActionType.EarnAddLiquidity);
    expect(r.pool).toBe('Governance.1');
  });
});

// ─── Remove Liquidity ───────────────────────────────────────────────────────

describe('earn remove (natural language)', () => {
  it('"earn remove 50% crypto" → Crypto.1', () => {
    const r = localParse('earn remove 50% crypto') as any;
    expect(r.action).toBe(ActionType.EarnRemoveLiquidity);
    expect(r.percent).toBe(50);
    expect(r.pool).toBe('Crypto.1');
  });

  it('"earn remove 25% governance" → Governance.1', () => {
    const r = localParse('earn remove 25% governance') as any;
    expect(r.action).toBe(ActionType.EarnRemoveLiquidity);
    expect(r.percent).toBe(25);
    expect(r.pool).toBe('Governance.1');
  });

  it('"earn remove 100%" defaults to Crypto.1', () => {
    const r = localParse('earn remove 100%') as any;
    expect(r.action).toBe(ActionType.EarnRemoveLiquidity);
    expect(r.percent).toBe(100);
    expect(r.pool).toBe('Crypto.1');
  });
});

// ─── Stake ──────────────────────────────────────────────────────────────────

describe('earn stake (natural language)', () => {
  it('"earn stake $200 governance" → Governance.1', () => {
    const r = localParse('earn stake $200 governance') as any;
    expect(r.action).toBe(ActionType.EarnStake);
    expect(r.amount).toBe(200);
    expect(r.pool).toBe('Governance.1');
  });

  it('"earn stake $500 virtual" → Virtual.1', () => {
    const r = localParse('earn stake $500 virtual') as any;
    expect(r.action).toBe(ActionType.EarnStake);
    expect(r.amount).toBe(500);
    expect(r.pool).toBe('Virtual.1');
  });

  it('"earn stake $100" defaults to Crypto.1', () => {
    const r = localParse('earn stake $100') as any;
    expect(r.action).toBe(ActionType.EarnStake);
    expect(r.pool).toBe('Crypto.1');
  });
});

// ─── Unstake ────────────────────────────────────────────────────────────────

describe('earn unstake (natural language)', () => {
  it('"earn unstake 50% governance" → Governance.1', () => {
    const r = localParse('earn unstake 50% governance') as any;
    expect(r.action).toBe(ActionType.EarnUnstake);
    expect(r.percent).toBe(50);
    expect(r.pool).toBe('Governance.1');
  });

  it('"earn unstake 100% trump" → Trump.1', () => {
    const r = localParse('earn unstake 100% trump') as any;
    expect(r.action).toBe(ActionType.EarnUnstake);
    expect(r.pool).toBe('Trump.1');
  });

  it('"earn unstake 25%" defaults to Crypto.1', () => {
    const r = localParse('earn unstake 25%') as any;
    expect(r.action).toBe(ActionType.EarnUnstake);
    expect(r.pool).toBe('Crypto.1');
  });
});

// ─── Claim ──────────────────────────────────────────────────────────────────

describe('earn claim (natural language)', () => {
  it('"earn claim" → no pool (claim all)', () => {
    const r = localParse('earn claim') as any;
    expect(r.action).toBe(ActionType.EarnClaimRewards);
    expect(r.pool).toBeUndefined();
  });

  it('"earn claim crypto" → Crypto.1', () => {
    const r = localParse('earn claim crypto') as any;
    expect(r.action).toBe(ActionType.EarnClaimRewards);
    expect(r.pool).toBe('Crypto.1');
  });

  it('"earn claim governance" → Governance.1', () => {
    const r = localParse('earn claim governance') as any;
    expect(r.action).toBe(ActionType.EarnClaimRewards);
    expect(r.pool).toBe('Governance.1');
  });
});

// ─── Status / Help ──────────────────────────────────────────────────────────

describe('earn status', () => {
  it('"earn" shows earn status', () => {
    const r = localParse('earn')!;
    expect(r.action).toBe(ActionType.EarnStatus);
  });

  it('"earn status" shows earn status', () => {
    const r = localParse('earn status')!;
    expect(r.action).toBe(ActionType.EarnStatus);
  });
});

// ─── Default Pool Fallback ──────────────────────────────────────────────────

describe('default pool fallback', () => {
  it('all earn commands default to Crypto.1 when no pool specified', () => {
    const add = localParse('earn add $100') as any;
    const remove = localParse('earn remove 50%') as any;
    const stake = localParse('earn stake $200') as any;
    const unstake = localParse('earn unstake 25%') as any;

    expect(add.pool).toBe('Crypto.1');
    expect(remove.pool).toBe('Crypto.1');
    expect(stake.pool).toBe('Crypto.1');
    expect(unstake.pool).toBe('Crypto.1');
  });
});

// ─── Invalid / Unknown Input ────────────────────────────────────────────────

describe('invalid earn input', () => {
  it('unknown earn subcommand falls back to earn status', () => {
    const r = localParse('earn xyz')!;
    expect(r.action).toBe(ActionType.EarnStatus);
  });

  it('unknown pool alias treated as no pool (default)', () => {
    // "fakename" is not a pool alias, so it won't be extracted —
    // the regex won't match and it falls through to earn status
    const r = localParse('earn add $100 fakename') as any;
    // Since "fakename" isn't a known pool alias, it stays in the body
    // and the regex fails to match → falls through to EarnStatus
    expect(r.action).toBe(ActionType.EarnStatus);
  });

  it('"earn add" without amount falls through to earn status', () => {
    const r = localParse('earn add')!;
    expect(r.action).toBe(ActionType.EarnStatus);
  });
});

// ─── Legacy pool: Syntax ────────────────────────────────────────────────────

describe('legacy pool: syntax still works', () => {
  it('"earn add $100 pool:Crypto.1" → backward compat', () => {
    const r = localParse('earn add $100 pool:Crypto.1') as any;
    expect(r.action).toBe(ActionType.EarnAddLiquidity);
    expect(r.pool).toBe('Crypto.1');
  });

  it('"earn stake $200 pool:Virtual.1" → backward compat', () => {
    const r = localParse('earn stake $200 pool:Virtual.1') as any;
    expect(r.action).toBe(ActionType.EarnStake);
    expect(r.pool).toBe('Virtual.1');
  });
});

// ─── Gov Alias ──────────────────────────────────────────────────────────────

describe('short aliases', () => {
  it('"earn add $100 gov" → Governance.1', () => {
    const r = localParse('earn add $100 gov') as any;
    expect(r.action).toBe(ActionType.EarnAddLiquidity);
    expect(r.pool).toBe('Governance.1');
  });
});
