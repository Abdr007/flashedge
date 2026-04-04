/**
 * Tests for startup configuration validation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateConfig } from '../src/config/config-validator.js';

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

describe('ConfigValidator', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset relevant env vars
    delete process.env.TRADING_ENABLED;
    delete process.env.SIMULATION_MODE;
    delete process.env.MAX_POSITION_SIZE;
    delete process.env.MAX_PORTFOLIO_EXPOSURE;
    delete process.env.MAX_COLLATERAL_PER_TRADE;
    delete process.env.MAX_LEVERAGE;
    delete process.env.RPC_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.MAX_SESSION_LOSS_USD;
    delete process.env.MAX_DAILY_LOSS_USD;
    delete process.env.MAX_TRADES_PER_MINUTE;
    delete process.env.COMPUTE_UNIT_PRICE;
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('returns no warnings for default configuration', () => {
    const warnings = validateConfig();
    // Might warn about missing AI key; filter to only structural warnings
    const structural = warnings.filter(w => w.code !== 'NO_AI_KEY');
    expect(structural.length).toBe(0);
  });

  it('warns when kill switch is on in live mode', () => {
    process.env.TRADING_ENABLED = 'false';
    process.env.SIMULATION_MODE = 'false';
    const warnings = validateConfig();
    const found = warnings.find(w => w.code === 'KILL_SWITCH_LIVE');
    expect(found).toBeDefined();
    expect(found!.message).toContain('monitoring-only');
  });

  it('warns when MAX_POSITION_SIZE > MAX_PORTFOLIO_EXPOSURE', () => {
    process.env.MAX_POSITION_SIZE = '50000';
    process.env.MAX_PORTFOLIO_EXPOSURE = '10000';
    const warnings = validateConfig();
    expect(warnings.find(w => w.code === 'POSITION_GT_EXPOSURE')).toBeDefined();
  });

  it('warns when collateral × leverage > exposure', () => {
    process.env.MAX_COLLATERAL_PER_TRADE = '1000';
    process.env.MAX_LEVERAGE = '50';
    process.env.MAX_PORTFOLIO_EXPOSURE = '10000';
    const warnings = validateConfig();
    expect(warnings.find(w => w.code === 'COLLATERAL_LEV_EXPOSURE')).toBeDefined();
  });

  it('warns on non-HTTPS RPC URL', () => {
    process.env.RPC_URL = 'http://insecure-rpc.example.com';
    const warnings = validateConfig();
    expect(warnings.find(w => w.code === 'RPC_NOT_HTTPS')).toBeDefined();
  });

  it('does not warn on localhost HTTP', () => {
    process.env.RPC_URL = 'http://localhost:8899';
    const warnings = validateConfig();
    expect(warnings.find(w => w.code === 'RPC_NOT_HTTPS')).toBeUndefined();
  });


  it('warns when session loss > daily loss', () => {
    process.env.MAX_SESSION_LOSS_USD = '500';
    process.env.MAX_DAILY_LOSS_USD = '100';
    const warnings = validateConfig();
    expect(warnings.find(w => w.code === 'SESSION_GT_DAILY')).toBeDefined();
  });

  it('warns on very low rate limit', () => {
    process.env.MAX_TRADES_PER_MINUTE = '1';
    const warnings = validateConfig();
    expect(warnings.find(w => w.code === 'LOW_RATE_LIMIT')).toBeDefined();
  });

  it('warns on extremely high priority fee', () => {
    process.env.COMPUTE_UNIT_PRICE = '50000000';
    const warnings = validateConfig();
    expect(warnings.find(w => w.code === 'HIGH_PRIORITY_FEE')).toBeDefined();
  });

  it('does not warn on normal priority fee', () => {
    process.env.COMPUTE_UNIT_PRICE = '500000';
    const warnings = validateConfig();
    expect(warnings.find(w => w.code === 'HIGH_PRIORITY_FEE')).toBeUndefined();
  });
});
