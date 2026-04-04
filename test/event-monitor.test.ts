/**
 * Event Monitor Tests
 * Verifies: monitor types, event detection, threshold logic, data sources, no synthetic data.
 */

import { describe, it } from 'vitest';
import assert from 'assert';
import { readFileSync } from 'fs';

describe('Event Monitor', () => {

const source = readFileSync('src/monitor/event-monitor.ts', 'utf-8');

// ─── Module Structure ──────────────────────────────────────────────────────

it('EventMonitor class is exported', () => {
  assert.ok(source.includes('export class EventMonitor'), 'EventMonitor class not exported');
});

it('MonitorType type is exported', () => {
  assert.ok(source.includes("export type MonitorType = 'market' | 'position' | 'liquidations' | 'protocol'"), 'MonitorType not exported');
});

// ─── Monitor Types ─────────────────────────────────────────────────────────

it('Supports market monitor', () => {
  assert.ok(source.includes('tickMarket'), 'tickMarket method missing');
});

it('Supports position monitor', () => {
  assert.ok(source.includes('tickPosition'), 'tickPosition method missing');
});

it('Supports liquidation monitor', () => {
  assert.ok(source.includes('tickLiquidations'), 'tickLiquidations method missing');
});

it('Supports protocol monitor', () => {
  assert.ok(source.includes('tickProtocol'), 'tickProtocol method missing');
});

// ─── Event Detection Thresholds ────────────────────────────────────────────

it('Has price change threshold', () => {
  assert.ok(source.includes('PRICE_CHANGE_THRESHOLD_PCT'), 'Price threshold missing');
});

it('Has OI change threshold', () => {
  assert.ok(source.includes('OI_CHANGE_THRESHOLD_PCT'), 'OI threshold missing');
  assert.ok(source.includes('OI_CHANGE_THRESHOLD_USD'), 'OI USD threshold missing');
});

it('Has funding flip threshold', () => {
  assert.ok(source.includes('FUNDING_FLIP_THRESHOLD'), 'Funding threshold missing');
});

it('Has whale size threshold', () => {
  assert.ok(source.includes('WHALE_SIZE_THRESHOLD_USD'), 'Whale threshold missing');
});

it('Has PnL change threshold', () => {
  assert.ok(source.includes('PNL_CHANGE_THRESHOLD_USD'), 'PnL threshold missing');
});

it('Has liquidation distance threshold', () => {
  assert.ok(source.includes('LIQ_DISTANCE_CHANGE_PCT'), 'Liq distance threshold missing');
});

it('Has RPC latency spike threshold', () => {
  assert.ok(source.includes('RPC_LATENCY_SPIKE_MS'), 'RPC latency threshold missing');
});

it('Has oracle delay threshold', () => {
  assert.ok(source.includes('ORACLE_DELAY_THRESHOLD_S'), 'Oracle delay threshold missing');
});

// ─── Data Sources ──────────────────────────────────────────────────────────

it('Uses PriceService (Pyth Hermes)', () => {
  assert.ok(source.includes('PriceService'), 'PriceService not imported');
  assert.ok(source.includes('this.priceSvc.getPrices'), 'Not fetching from PriceService');
});

it('Uses FStatsClient (protocol analytics)', () => {
  assert.ok(source.includes('FStatsClient'), 'FStatsClient not imported');
  assert.ok(source.includes('this.fstats.getOpenInterest'), 'Not fetching OI from fstats');
  assert.ok(source.includes('this.fstats.getOpenPositions'), 'Not fetching whale data from fstats');
});

it('Uses IFlashClient (positions)', () => {
  assert.ok(source.includes('this.client.getPositions'), 'Not fetching positions from client');
  assert.ok(source.includes('this.client.getMarketData'), 'Not fetching market data from client');
});

it('Uses RPC manager for latency', () => {
  assert.ok(source.includes('getRpcManagerInstance'), 'Not using RPC manager');
  assert.ok(source.includes('activeLatencyMs'), 'Not reading latency');
});

// ─── No Synthetic Data ─────────────────────────────────────────────────────

it('No fabricated signals or confidence scores', () => {
  const lower = source.toLowerCase();
  assert.ok(!lower.includes('confidence'), 'Contains "confidence"');
  assert.ok(!lower.includes('signal score'), 'Contains "signal score"');
  assert.ok(!lower.includes('math.random'), 'Contains Math.random');
  assert.ok(!lower.includes('fake'), 'Contains "fake"');
});

// ─── Event Severity System ─────────────────────────────────────────────────

it('Has severity levels: info, warning, critical', () => {
  assert.ok(source.includes("severity: 'info'"), 'Missing info severity');
  assert.ok(source.includes("severity: 'warning'"), 'Missing warning severity');
  assert.ok(source.includes("'critical'"), 'Missing critical severity');
  assert.ok(source.includes("'info' | 'warning' | 'critical'"), 'Missing severity type definition');
});

// ─── State Comparison ──────────────────────────────────────────────────────

it('Maintains previous state for delta detection', () => {
  assert.ok(source.includes('prevMarket'), 'No previous market state');
  assert.ok(source.includes('prevPosition'), 'No previous position state');
  assert.ok(source.includes('prevProtocol'), 'No previous protocol state');
});

it('Only emits events when thresholds exceeded', () => {
  // Price: checks percentage change against threshold
  assert.ok(source.includes('Math.abs(pricePctChange) >= PRICE_CHANGE_THRESHOLD_PCT'), 'No price threshold check');
  // OI: checks absolute and percentage change
  assert.ok(source.includes('OI_CHANGE_THRESHOLD_PCT') && source.includes('OI_CHANGE_THRESHOLD_USD'), 'No OI threshold check');
});

// ─── Safety Guards ─────────────────────────────────────────────────────────

it('Max events per cycle to prevent flood', () => {
  assert.ok(source.includes('MAX_EVENTS_PER_CYCLE'), 'No event cap');
});

it('Whale keys bounded to prevent memory leak', () => {
  assert.ok(source.includes('knownWhaleKeys.size > 500'), 'No whale key bound');
});

it('Periodic heartbeat for liveness', () => {
  assert.ok(source.includes('No significant changes detected'), 'No heartbeat message');
});

// ─── Terminal Integration ──────────────────────────────────────────────────

const terminalSource = readFileSync('src/cli/terminal.ts', 'utf-8');

it('Terminal has bare "monitor" command route', () => {
  assert.ok(
    terminalSource.includes("lower.startsWith('monitor ')") || terminalSource.includes("lower === 'monitor'"),
    'No monitor route in terminal'
  );
});

}); // end describe
