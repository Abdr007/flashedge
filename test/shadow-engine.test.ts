/**
 * Tests for ShadowEngine — parallel simulation engine.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock SimulatedFlashClient
vi.mock('../src/client/simulation.js', () => {
  return {
    SimulatedFlashClient: vi.fn().mockImplementation((balance: number) => ({
      getBalance: vi.fn().mockReturnValue(balance),
      walletAddress: 'SIM_SHADOW',
      openPosition: vi.fn().mockResolvedValue({ entryPrice: 100, txSignature: 'sim_tx_1' }),
      closePosition: vi.fn().mockResolvedValue({ pnl: 5.0, exitPrice: 105, txSignature: 'sim_tx_2' }),
      addCollateral: vi.fn().mockResolvedValue({ success: true }),
      removeCollateral: vi.fn().mockResolvedValue({ success: true }),
      getPositions: vi.fn().mockResolvedValue([]),
    })),
  };
});

vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    trade: vi.fn(),
  }),
}));

import { ShadowEngine } from '../src/shadow/shadow-engine.js';
import { TradeSide } from '../src/types/index.js';

describe('ShadowEngine', () => {
  let engine: ShadowEngine;

  beforeEach(() => {
    delete process.env.SHADOW_TRADING;
  });

  afterEach(() => {
    delete process.env.SHADOW_TRADING;
  });

  it('is disabled by default', () => {
    engine = new ShadowEngine();
    expect(engine.isEnabled).toBe(false);
  });

  it('is enabled when SHADOW_TRADING=true', () => {
    process.env.SHADOW_TRADING = 'true';
    engine = new ShadowEngine();
    expect(engine.isEnabled).toBe(true);
  });

  it('is enabled case-insensitively', () => {
    process.env.SHADOW_TRADING = 'TRUE';
    engine = new ShadowEngine();
    expect(engine.isEnabled).toBe(true);
  });

  it('returns null for all operations when disabled', async () => {
    engine = new ShadowEngine();
    expect(await engine.shadowOpen('SOL', TradeSide.Long, 100, 5)).toBeNull();
    expect(await engine.shadowClose('SOL', TradeSide.Long)).toBeNull();
    expect(await engine.shadowAddCollateral('SOL', TradeSide.Long, 50)).toBeNull();
    expect(await engine.shadowRemoveCollateral('SOL', TradeSide.Long, 50)).toBeNull();
  });

  it('returns empty positions when disabled', async () => {
    engine = new ShadowEngine();
    expect(await engine.getPositions()).toEqual([]);
  });

  it('shadowOpen returns result when enabled', async () => {
    process.env.SHADOW_TRADING = 'true';
    engine = new ShadowEngine(10_000);
    const result = await engine.shadowOpen('SOL', TradeSide.Long, 100, 5);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('open');
    expect(result!.success).toBe(true);
    expect(result!.market).toBe('SOL');
    expect(result!.side).toBe(TradeSide.Long);
    expect(result!.entryPrice).toBe(100);
    expect(result!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('shadowClose returns result with PnL when enabled', async () => {
    process.env.SHADOW_TRADING = 'true';
    engine = new ShadowEngine(10_000);
    const result = await engine.shadowClose('SOL', TradeSide.Long);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('close');
    expect(result!.success).toBe(true);
    expect(result!.shadowPnl).toBe(5.0);
    expect(result!.exitPrice).toBe(105);
  });

  it('shadowAddCollateral returns result when enabled', async () => {
    process.env.SHADOW_TRADING = 'true';
    engine = new ShadowEngine(10_000);
    const result = await engine.shadowAddCollateral('SOL', TradeSide.Long, 50);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('add_collateral');
    expect(result!.success).toBe(true);
  });

  it('shadowRemoveCollateral returns result when enabled', async () => {
    process.env.SHADOW_TRADING = 'true';
    engine = new ShadowEngine(10_000);
    const result = await engine.shadowRemoveCollateral('SOL', TradeSide.Long, 50);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('remove_collateral');
    expect(result!.success).toBe(true);
  });

  it('tracks trade count', async () => {
    process.env.SHADOW_TRADING = 'true';
    engine = new ShadowEngine(10_000);
    await engine.shadowOpen('SOL', TradeSide.Long, 100, 5);
    await engine.shadowClose('SOL', TradeSide.Long);
    const state = await engine.getState();
    expect(state.tradeCount).toBe(2);
  });

  it('tracks realized PnL', async () => {
    process.env.SHADOW_TRADING = 'true';
    engine = new ShadowEngine(10_000);
    await engine.shadowClose('SOL', TradeSide.Long);
    const state = await engine.getState();
    expect(state.totalRealizedPnl).toBe(5.0);
  });

  it('getState returns full snapshot', async () => {
    process.env.SHADOW_TRADING = 'true';
    engine = new ShadowEngine(10_000);
    const state = await engine.getState();
    expect(state.enabled).toBe(true);
    expect(state.balance).toBe(10_000);
    expect(state.positions).toEqual([]);
    expect(state.tradeCount).toBe(0);
    expect(state.totalRealizedPnl).toBe(0);
  });

  it('enable() and disable() toggle state', () => {
    engine = new ShadowEngine();
    expect(engine.isEnabled).toBe(false);
    engine.enable();
    expect(engine.isEnabled).toBe(true);
    engine.disable();
    expect(engine.isEnabled).toBe(false);
  });

  it('handles openPosition errors gracefully', async () => {
    process.env.SHADOW_TRADING = 'true';
    engine = new ShadowEngine(10_000);
    // Override mock to throw
    const client = (engine as any).client;
    client.openPosition.mockRejectedValueOnce(new Error('sim error'));
    const result = await engine.shadowOpen('SOL', TradeSide.Long, 100, 5);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.error).toBe('sim error');
  });

  it('handles closePosition errors gracefully', async () => {
    process.env.SHADOW_TRADING = 'true';
    engine = new ShadowEngine(10_000);
    const client = (engine as any).client;
    client.closePosition.mockRejectedValueOnce(new Error('close error'));
    const result = await engine.shadowClose('SOL', TradeSide.Long);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.error).toBe('close error');
  });
});
