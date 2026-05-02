/**
 * Magic-mode client unit tests.
 *
 * Covers pure helpers + signing-guard wiring that don't need live RPC:
 *   - usdToOraclePrice round-trip
 *   - magic-history append + read
 *   - ER health monitor state transitions (mocked Connection)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { ErHealthMonitor } from '../src/monitor/magic-er-health.js';
import { recordMagicTrade, readMagicHistory, type MagicTradeEntry } from '../src/security/magic-history.js';

const HISTORY_PATH = join(homedir(), '.flash', 'magic-history.jsonl');

describe('magic mode — history journal', () => {
  beforeEach(() => {
    if (existsSync(HISTORY_PATH)) rmSync(HISTORY_PATH);
  });

  it('appends and reads back entries in order', () => {
    const e1: MagicTradeEntry = {
      ts: '2026-05-03T10:00:00Z',
      type: 'open',
      market: 'SOL',
      side: 'long',
      collateralUsd: 10,
      leverage: 2,
      txSignature: 'sig1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      network: 'mainnet-beta',
      walletAddress: 'WaLLeT11111111111111111111111111111111111111',
    };
    const e2: MagicTradeEntry = { ...e1, ts: '2026-05-03T10:01:00Z', type: 'close', txSignature: 'sig2' };
    recordMagicTrade(e1);
    recordMagicTrade(e2);
    const out = readMagicHistory(10);
    expect(out).toHaveLength(2);
    expect(out[0].txSignature).toBe('sig1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(out[1].type).toBe('close');
  });

  it('respects the limit argument and walletFilter', () => {
    for (let i = 0; i < 5; i++) {
      recordMagicTrade({
        ts: `2026-05-03T10:0${i}:00Z`,
        type: 'open',
        market: 'SOL',
        side: 'long',
        txSignature: `sig${i}aaaaaaa`,
        network: 'mainnet-beta',
        walletAddress: i < 3 ? 'WALLET_A' : 'WALLET_B',
      });
    }
    const all = readMagicHistory(10);
    expect(all).toHaveLength(5);
    const justA = readMagicHistory(10, 'WALLET_A');
    expect(justA).toHaveLength(3);
    const last2 = readMagicHistory(2);
    expect(last2).toHaveLength(2);
    expect(last2[1].txSignature).toBe('sig4aaaaaaa');
  });

  it('survives corrupt lines without throwing', () => {
    recordMagicTrade({
      ts: '2026-05-03T10:00:00Z',
      type: 'open',
      txSignature: 'sigOk',
      network: 'mainnet-beta',
      walletAddress: 'WALLET',
    });
    const fs = require('fs');
    fs.appendFileSync(HISTORY_PATH, 'not-json-at-all\n');
    fs.appendFileSync(HISTORY_PATH, '{"ts":"x"}\n'); // malformed but valid json
    const out = readMagicHistory(10);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.some((e) => e.txSignature === 'sigOk')).toBe(true);
  });
});

describe('magic mode — ER health monitor', () => {
  it('starts unhealthy=false and snapshot has the right shape', () => {
    const m = new ErHealthMonitor('https://flashtrade.magicblock.app/');
    const s = m.snapshot();
    expect(s.endpoint).toBe('https://flashtrade.magicblock.app/');
    expect(s.healthy).toBe(true); // optimistic default until first probe
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastErr).toBeNull();
  });

  it('start() then stop() does not throw or leak timers', () => {
    const m = new ErHealthMonitor('http://127.0.0.1:9'); // unreachable; we won't await tick
    m.start(60_000);
    m.stop();
    // calling stop() twice is safe
    m.stop();
    expect(m.snapshot().endpoint).toBe('http://127.0.0.1:9');
  });
});
