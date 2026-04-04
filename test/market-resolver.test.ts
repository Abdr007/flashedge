/**
 * Tests for centralized market resolver.
 * Covers alias resolution, case insensitivity, multi-word aliases,
 * and integration with the interpreter localParse.
 */

import { describe, it } from 'vitest';
import { resolveMarket, resolveAndValidateMarket, isValidMarket, normalizeAssetText } from '../src/utils/market-resolver.js';
import { localParse } from '../src/ai/interpreter.js';
import { ActionType } from '../src/types/index.js';
import assert from 'assert';

describe('Market Resolver', () => {

// ─── resolveMarket() ──────────────────────────────────────────────────────

it('resolves "crude oil" → CRUDEOIL', () => {
  assert.strictEqual(resolveMarket('crude oil'), 'CRUDEOIL');
});

it('resolves "oil" → CRUDEOIL', () => {
  assert.strictEqual(resolveMarket('oil'), 'CRUDEOIL');
});

it('resolves "CRUDE OIL" → CRUDEOIL', () => {
  assert.strictEqual(resolveMarket('CRUDE OIL'), 'CRUDEOIL');
});

it('resolves "crude" → CRUDEOIL', () => {
  assert.strictEqual(resolveMarket('crude'), 'CRUDEOIL');
});

it('resolves "Crude Oil" (mixed case) → CRUDEOIL', () => {
  assert.strictEqual(resolveMarket('Crude Oil'), 'CRUDEOIL');
});

it('resolves "SOL" → SOL', () => {
  assert.strictEqual(resolveMarket('SOL'), 'SOL');
});

it('resolves "sol" → SOL', () => {
  assert.strictEqual(resolveMarket('sol'), 'SOL');
});

it('resolves "bitcoin" → BTC', () => {
  assert.strictEqual(resolveMarket('bitcoin'), 'BTC');
});

it('resolves "gold" → XAU', () => {
  assert.strictEqual(resolveMarket('gold'), 'XAU');
});

it('resolves "met" → MET (case insensitive canonical lookup)', () => {
  assert.strictEqual(resolveMarket('met'), 'MET');
});

it('resolves "metaplex" → MET', () => {
  assert.strictEqual(resolveMarket('metaplex'), 'MET');
});

it('resolves "yen" → USDJPY', () => {
  assert.strictEqual(resolveMarket('yen'), 'USDJPY');
});

it('resolves "EUR" → EUR', () => {
  assert.strictEqual(resolveMarket('EUR'), 'EUR');
});

it('resolves "fartcoin" → FARTCOIN', () => {
  assert.strictEqual(resolveMarket('fartcoin'), 'FARTCOIN');
});

it('resolves "CRUDEOIL" → CRUDEOIL (already canonical)', () => {
  assert.strictEqual(resolveMarket('CRUDEOIL'), 'CRUDEOIL');
});

// ─── resolveAndValidateMarket() ──────────────────────────────────────────

it('validates "oil" as valid market', () => {
  assert.strictEqual(resolveAndValidateMarket('oil'), 'CRUDEOIL');
});

it('validates "sol" as valid market', () => {
  assert.strictEqual(resolveAndValidateMarket('sol'), 'SOL');
});

it('rejects "NOTAMARKET" as invalid', () => {
  assert.strictEqual(resolveAndValidateMarket('NOTAMARKET'), null);
});

// ─── isValidMarket() ─────────────────────────────────────────────────────

it('isValidMarket("SOL") → true', () => {
  assert.strictEqual(isValidMarket('SOL'), true);
});

it('isValidMarket("CRUDEOIL") → true', () => {
  assert.strictEqual(isValidMarket('CRUDEOIL'), true);
});

it('isValidMarket("MET") → true', () => {
  assert.strictEqual(isValidMarket('MET'), true);
});

it('isValidMarket("FAKE") → false', () => {
  assert.strictEqual(isValidMarket('FAKE'), false);
});

// ─── normalizeAssetText() ────────────────────────────────────────────────

it('normalizeAssetText handles "crude oil" → "crudeoil"', () => {
  const result = normalizeAssetText('analyze crude oil');
  assert.ok(result.includes('crudeoil'), `Expected "crudeoil" in "${result}"`);
});

it('normalizeAssetText handles "gold" → "xau"', () => {
  const result = normalizeAssetText('analyze gold');
  assert.ok(result.includes('xau'), `Expected "xau" in "${result}"`);
});

// ─── localParse integration: analyze ──────────────────────────────────────

it('localParse("analyze crude oil") → Analyze CRUDEOIL', () => {
  const result = localParse('analyze crude oil');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.Analyze);
  assert.strictEqual((result as Record<string, unknown>).market, 'CRUDEOIL');
});

it('localParse("analyze oil") → Analyze CRUDEOIL', () => {
  const result = localParse('analyze oil');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.Analyze);
  assert.strictEqual((result as Record<string, unknown>).market, 'CRUDEOIL');
});

it('localParse("analyse sol") → Analyze SOL (British spelling)', () => {
  const result = localParse('analyse sol');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.Analyze);
  assert.strictEqual((result as Record<string, unknown>).market, 'SOL');
});

it('localParse("analyze met") → Analyze MET', () => {
  const result = localParse('analyze met');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.Analyze);
  assert.strictEqual((result as Record<string, unknown>).market, 'MET');
});

// ─── localParse integration: liquidations ─────────────────────────────────

it('localParse("liquidations crude oil") → LiquidationMap CRUDEOIL', () => {
  const result = localParse('liquidations crude oil');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.LiquidationMap);
  assert.strictEqual((result as Record<string, unknown>).market, 'CRUDEOIL');
});

it('localParse("liquidations sol") → LiquidationMap SOL', () => {
  const result = localParse('liquidations sol');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.LiquidationMap);
  assert.strictEqual((result as Record<string, unknown>).market, 'SOL');
});

// ─── localParse integration: funding ──────────────────────────────────────

it('localParse("funding crude oil") → FundingDashboard CRUDEOIL', () => {
  const result = localParse('funding crude oil');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.FundingDashboard);
  assert.strictEqual((result as Record<string, unknown>).market, 'CRUDEOIL');
});

it('localParse("funding met") → FundingDashboard MET', () => {
  const result = localParse('funding met');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.FundingDashboard);
  assert.strictEqual((result as Record<string, unknown>).market, 'MET');
});

// ─── localParse integration: depth ────────────────────────────────────────

it('localParse("depth crude oil") → LiquidityDepth CRUDEOIL', () => {
  const result = localParse('depth crude oil');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.LiquidityDepth);
  assert.strictEqual((result as Record<string, unknown>).market, 'CRUDEOIL');
});

it('localParse("depth sol") → LiquidityDepth SOL', () => {
  const result = localParse('depth sol');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.LiquidityDepth);
  assert.strictEqual((result as Record<string, unknown>).market, 'SOL');
});

// ─── localParse integration: add collateral with dollar word ──────────────

it('localParse("add $5 collateral on sol long") → AddCollateral SOL', () => {
  const result = localParse('add $5 collateral on sol long');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.AddCollateral);
  assert.strictEqual((result as Record<string, unknown>).market, 'SOL');
  assert.strictEqual((result as Record<string, unknown>).amount, 5);
});

it('localParse("add 5 dollar collateral on sol") → AddCollateral SOL (no side, auto-detect)', () => {
  const result = localParse('add 5 dollar collateral on sol');
  assert.ok(result, 'Should parse');
  assert.strictEqual(result!.action, ActionType.AddCollateral);
  assert.strictEqual((result as Record<string, unknown>).market, 'SOL');
});

}); // end describe
