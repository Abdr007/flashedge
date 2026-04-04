/**
 * Tests for executeAction() in flash-tools.ts trade tools.
 *
 * Covers:
 *   - Successful open/close execution path
 *   - RPC failure during trade execution
 *   - RPC failure during post-trade position refresh
 *   - Circuit breaker PnL recording
 *   - Session trade logging
 *   - Shadow engine fire-and-forget isolation
 *   - Error message formatting
 *
 * All tests use mocked clients — no real blockchain calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TradeSide } from '../src/types/index.js';
import type { ToolContext, ToolResult, IFlashClient } from '../src/types/index.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trade: vi.fn(),
  }),
}));

vi.mock('../src/observability/trade-events.js', () => ({
  logTradeStart: vi.fn(),
  logTradeSuccess: vi.fn(),
  logTradeFailure: vi.fn(),
  logKillSwitchBlock: vi.fn(),
  logExposureBlock: vi.fn(),
  logCircuitBreakerBlock: vi.fn(),
}));

vi.mock('../src/observability/shadow-events.js', () => ({
  logShadowTrade: vi.fn(),
}));

const mockRecordOpen = vi.fn();
const mockRecordTrade = vi.fn();
const mockCheck = vi.fn().mockReturnValue({ allowed: true });
vi.mock('../src/security/circuit-breaker.js', () => ({
  getCircuitBreaker: () => ({
    check: mockCheck,
    recordOpen: mockRecordOpen,
    recordTrade: mockRecordTrade,
  }),
}));

const mockCheckKillSwitch = vi.fn().mockReturnValue({ allowed: true });
const mockCheckExposure = vi.fn().mockResolvedValue({ allowed: true });
vi.mock('../src/security/trading-gate.js', () => ({
  getTradingGate: () => ({
    checkKillSwitch: mockCheckKillSwitch,
    checkExposure: mockCheckExposure,
  }),
}));

const mockCheckTradeLimits = vi.fn().mockReturnValue({ allowed: true });
const mockCheckRateLimit = vi.fn().mockReturnValue({ allowed: true });
const mockRecordSigning = vi.fn();
const mockLogAudit = vi.fn();
vi.mock('../src/security/signing-guard.js', () => ({
  getSigningGuard: () => ({
    checkTradeLimits: mockCheckTradeLimits,
    checkRateLimit: mockCheckRateLimit,
    recordSigning: mockRecordSigning,
    logAudit: mockLogAudit,
    limits: {
      maxCollateralPerTrade: 0,
      maxPositionSize: 0,
      maxLeverage: 0,
      maxTradesPerMinute: 10,
    },
  }),
}));

vi.mock('../src/shadow/shadow-engine.js', () => ({
  getShadowEngine: () => ({
    shadowOpen: vi.fn().mockResolvedValue(null),
    shadowClose: vi.fn().mockResolvedValue(null),
    shadowAddCollateral: vi.fn().mockResolvedValue(null),
    shadowRemoveCollateral: vi.fn().mockResolvedValue(null),
  }),
}));

vi.mock('../src/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/index.js')>();
  return {
    ...actual,
    getPoolForMarket: () => 'Crypto.1',
    isTradeablePool: () => true,
    getMaxLeverage: () => 100,
  };
});

vi.mock('../src/utils/market-resolver.js', () => ({
  resolveMarket: (m: string) => m.toUpperCase(),
}));

vi.mock('../src/core/risk-config.js', () => ({
  DATA_STALENESS_WARNING_SECONDS: 30,
}));

vi.mock('../src/core/invariants.js', () => ({
  filterValidPositions: (p: any[]) => p,
}));

vi.mock('../src/utils/protocol-fees.js', () => ({
  getProtocolFeeRates: vi.fn().mockResolvedValue({ openFeeRate: 0.0008, closeFeeRate: 0.0008 }),
  calcFeeUsd: (size: number, rate: number) => size * rate,
  ProtocolParameterError: class extends Error {},
}));

vi.mock('../src/tools/trade-helpers.js', () => ({
  buildRiskPreview: vi.fn().mockResolvedValue([]),
  buildPositionPreview: vi.fn().mockResolvedValue([]),
  validateLiveTradeContext: vi.fn().mockReturnValue(null),
  buildLiveTradeWarnings: vi.fn().mockReturnValue([]),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockClient(overrides: Partial<IFlashClient> = {}): IFlashClient {
  return {
    walletAddress: 'TEST_WALLET',
    openPosition: vi.fn().mockResolvedValue({
      txSignature: 'tx_open_123',
      entryPrice: 150.0,
      sizeUsd: 500,
      liquidationPrice: 120,
    }),
    closePosition: vi.fn().mockResolvedValue({
      txSignature: 'tx_close_456',
      exitPrice: 155.0,
      pnl: 16.5,
    }),
    addCollateral: vi.fn().mockResolvedValue({ txSignature: 'tx_add_789' }),
    removeCollateral: vi.fn().mockResolvedValue({ txSignature: 'tx_rem_012' }),
    getPositions: vi.fn().mockResolvedValue([
      {
        market: 'SOL', side: TradeSide.Long, sizeUsd: 500, collateralUsd: 100,
        leverage: 5, entryPrice: 150, markPrice: 155, liquidationPrice: 120,
        unrealizedPnl: 16.5, openFee: 0.4, totalFees: 0.4, fundingRate: 0.001,
      },
    ]),
    getMarketData: vi.fn().mockResolvedValue([]),
    getPortfolio: vi.fn().mockResolvedValue({ positions: [], totalValue: 0 }),
    dryRunOpen: vi.fn(),
    ...overrides,
  } as unknown as IFlashClient;
}

function makeContext(clientOverrides?: Partial<IFlashClient>): ToolContext {
  return {
    flashClient: makeMockClient(clientOverrides),
    dataClient: {} as any,
    simulationMode: true,
    degenMode: false,
    walletAddress: 'TEST_WALLET',
    walletName: 'test',
    sessionTrades: [],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executeAction — Open Position', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckKillSwitch.mockReturnValue({ allowed: true });
    mockCheck.mockReturnValue({ allowed: true });
    mockCheckRateLimit.mockReturnValue({ allowed: true });
    mockCheckTradeLimits.mockReturnValue({ allowed: true });
  });

  it('returns confirmation prompt before execution', async () => {
    const { flashOpenPosition } = await import('../src/tools/flash-tools.js');
    const ctx = makeContext();
    const result = await flashOpenPosition.execute(
      { market: 'SOL', side: TradeSide.Long, collateral: 100, leverage: 5 },
      ctx,
    );
    expect(result.requiresConfirmation).toBe(true);
    expect(result.data?.executeAction).toBeTypeOf('function');
  });

  it('executeAction calls openPosition and returns success', async () => {
    const { flashOpenPosition } = await import('../src/tools/flash-tools.js');
    const ctx = makeContext();
    const result = await flashOpenPosition.execute(
      { market: 'SOL', side: TradeSide.Long, collateral: 100, leverage: 5 },
      ctx,
    );
    const execResult = await result.data!.executeAction!();
    expect(execResult.success).toBe(true);
    expect(execResult.txSignature).toBe('tx_open_123');
    expect(execResult.message).toContain('Position Opened');
  });

  it('records open in circuit breaker on success', async () => {
    const { flashOpenPosition } = await import('../src/tools/flash-tools.js');
    const ctx = makeContext();
    const result = await flashOpenPosition.execute(
      { market: 'SOL', side: TradeSide.Long, collateral: 100, leverage: 5 },
      ctx,
    );
    await result.data!.executeAction!();
    expect(mockRecordOpen).toHaveBeenCalled();
  });

  it('logs audit entry on success', async () => {
    const { flashOpenPosition } = await import('../src/tools/flash-tools.js');
    const ctx = makeContext();
    const result = await flashOpenPosition.execute(
      { market: 'SOL', side: TradeSide.Long, collateral: 100, leverage: 5 },
      ctx,
    );
    await result.data!.executeAction!();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'open', result: 'confirmed' }),
    );
  });

  it('handles RPC failure during openPosition gracefully', async () => {
    const { flashOpenPosition } = await import('../src/tools/flash-tools.js');
    const ctx = makeContext({
      openPosition: vi.fn().mockRejectedValue(new Error('RPC timeout')),
    });
    const result = await flashOpenPosition.execute(
      { market: 'SOL', side: TradeSide.Long, collateral: 100, leverage: 5 },
      ctx,
    );
    const execResult = await result.data!.executeAction!();
    expect(execResult.success).toBe(false);
    expect(execResult.message).toContain('Failed to open position');
  });

  it('logs failed audit on RPC failure', async () => {
    const { flashOpenPosition } = await import('../src/tools/flash-tools.js');
    const ctx = makeContext({
      openPosition: vi.fn().mockRejectedValue(new Error('RPC timeout')),
    });
    const result = await flashOpenPosition.execute(
      { market: 'SOL', side: TradeSide.Long, collateral: 100, leverage: 5 },
      ctx,
    );
    await result.data!.executeAction!();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'open', result: 'failed' }),
    );
  });

  it('handles getPositions failure during post-trade refresh', async () => {
    const { flashOpenPosition } = await import('../src/tools/flash-tools.js');
    const ctx = makeContext({
      getPositions: vi.fn().mockRejectedValue(new Error('RPC down')),
    });
    // In simulation mode, getPositions isn't called for refresh,
    // so switch to non-sim to test the fallback path
    ctx.simulationMode = false;
    const result = await flashOpenPosition.execute(
      { market: 'SOL', side: TradeSide.Long, collateral: 100, leverage: 5 },
      ctx,
    );
    const execResult = await result.data!.executeAction!();
    // Should still succeed — uses SDK response values as fallback
    expect(execResult.success).toBe(true);
    expect(execResult.message).toContain('Position Opened');
  });

  it('pushes to sessionTrades on success', async () => {
    const { flashOpenPosition } = await import('../src/tools/flash-tools.js');
    const ctx = makeContext();
    const result = await flashOpenPosition.execute(
      { market: 'SOL', side: TradeSide.Long, collateral: 100, leverage: 5 },
      ctx,
    );
    await result.data!.executeAction!();
    expect(ctx.sessionTrades!.length).toBe(1);
    expect(ctx.sessionTrades![0].action).toBe('open');
  });
});

describe('executeAction — Close Position', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckKillSwitch.mockReturnValue({ allowed: true });
    mockCheck.mockReturnValue({ allowed: true });
    mockCheckRateLimit.mockReturnValue({ allowed: true });
  });

  it('executeAction calls closePosition and returns PnL', async () => {
    const { flashClosePosition } = await import('../src/tools/flash-tools.js');
    const ctx = makeContext();
    const result = await flashClosePosition.execute(
      { market: 'SOL', side: TradeSide.Long },
      ctx,
    );
    expect(result.requiresConfirmation).toBe(true);
    const execResult = await result.data!.executeAction!();
    expect(execResult.success).toBe(true);
    expect(execResult.txSignature).toBe('tx_close_456');
    expect(execResult.message).toContain('Position Closed');
  });

  it('records PnL in circuit breaker on close', async () => {
    const { flashClosePosition } = await import('../src/tools/flash-tools.js');
    const ctx = makeContext();
    const result = await flashClosePosition.execute(
      { market: 'SOL', side: TradeSide.Long },
      ctx,
    );
    await result.data!.executeAction!();
    expect(mockRecordTrade).toHaveBeenCalledWith(16.5);
  });

  it('handles RPC failure during closePosition', async () => {
    const { flashClosePosition } = await import('../src/tools/flash-tools.js');
    const ctx = makeContext({
      closePosition: vi.fn().mockRejectedValue(new Error('Network error')),
    });
    const result = await flashClosePosition.execute(
      { market: 'SOL', side: TradeSide.Long },
      ctx,
    );
    const execResult = await result.data!.executeAction!();
    expect(execResult.success).toBe(false);
    expect(execResult.message).toContain('Failed to close position');
  });

  it('handles non-finite PnL gracefully', async () => {
    const { flashClosePosition } = await import('../src/tools/flash-tools.js');
    const ctx = makeContext({
      closePosition: vi.fn().mockResolvedValue({
        txSignature: 'tx_close_nan',
        exitPrice: 155.0,
        pnl: NaN,
      }),
    });
    const result = await flashClosePosition.execute(
      { market: 'SOL', side: TradeSide.Long },
      ctx,
    );
    const execResult = await result.data!.executeAction!();
    expect(execResult.success).toBe(true);
    // NaN PnL should NOT be recorded in circuit breaker
    expect(mockRecordTrade).not.toHaveBeenCalled();
  });
});

describe('executeAction — Gate Checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('kill switch blocks open position', async () => {
    mockCheckKillSwitch.mockReturnValue({ allowed: false, reason: 'Trading disabled' });
    const { flashOpenPosition } = await import('../src/tools/flash-tools.js');
    const ctx = makeContext();
    const result = await flashOpenPosition.execute(
      { market: 'SOL', side: TradeSide.Long, collateral: 100, leverage: 5 },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('Trading disabled');
  });

  it('circuit breaker blocks close position', async () => {
    mockCheckKillSwitch.mockReturnValue({ allowed: true });
    mockCheck.mockReturnValue({ allowed: false, reason: 'Session loss limit reached' });
    const { flashClosePosition } = await import('../src/tools/flash-tools.js');
    const ctx = makeContext();
    const result = await flashClosePosition.execute(
      { market: 'SOL', side: TradeSide.Long },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('Session loss limit reached');
  });

  it('rate limiter blocks trade', async () => {
    mockCheckKillSwitch.mockReturnValue({ allowed: true });
    mockCheck.mockReturnValue({ allowed: true });
    mockCheckRateLimit.mockReturnValue({ allowed: false, reason: 'Rate limited' });
    const { flashClosePosition } = await import('../src/tools/flash-tools.js');
    const ctx = makeContext();
    const result = await flashClosePosition.execute(
      { market: 'SOL', side: TradeSide.Long },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('Rate limited');
  });
});
