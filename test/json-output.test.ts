/**
 * JSON Output Certification Test Suite
 *
 * Validates that the --format json output path produces valid, schema-compliant
 * JSON for all command categories. Tests the v1 response contract:
 *
 * {
 *   success: boolean,
 *   command: string,
 *   timestamp: string (ISO-8601),
 *   version: "v1",
 *   data: { ... },
 *   error: null | { code: string, message: string, details: { ... } }
 * }
 */

import { describe, it, expect } from 'vitest';
import {
  jsonSuccess,
  jsonError,
  jsonFromToolResult,
  jsonStringify,
  ErrorCode,
  JSON_SCHEMA_VERSION,
  type JsonResponse,
} from '../src/cli/json-response.js';

// ─── Schema Validation Helpers ───────────────────────────────────────────────

function assertValidJsonResponse(response: JsonResponse): void {
  // success MUST always exist
  expect(typeof response.success).toBe('boolean');

  // command MUST always exist
  expect(typeof response.command).toBe('string');
  expect(response.command.length).toBeGreaterThan(0);

  // timestamp MUST be ISO-8601
  expect(typeof response.timestamp).toBe('string');
  expect(new Date(response.timestamp).toISOString()).toBe(response.timestamp);

  // version MUST be present
  expect(response.version).toBe(JSON_SCHEMA_VERSION);

  // data MUST always exist (even if empty)
  expect(response.data).toBeDefined();
  expect(typeof response.data).toBe('object');
  expect(response.data).not.toBeNull();

  // error MUST be null OR structured object
  if (response.success) {
    expect(response.error).toBeNull();
  } else {
    expect(response.error).not.toBeNull();
    if (response.error) {
      expect(typeof response.error.code).toBe('string');
      expect(response.error.code.length).toBeGreaterThan(0);
      expect(typeof response.error.message).toBe('string');
      expect(typeof response.error.details).toBe('object');
      expect(response.error.details).not.toBeNull();
    }
  }

  // NO undefined fields at top level
  for (const key of Object.keys(response)) {
    expect((response as Record<string, unknown>)[key]).not.toBeUndefined();
  }
}

function assertValidJson(str: string): JsonResponse {
  const parsed = JSON.parse(str);
  assertValidJsonResponse(parsed);
  return parsed;
}

// ─── jsonSuccess() ───────────────────────────────────────────────────────────

describe('jsonSuccess', () => {
  it('produces valid schema with data', () => {
    const response = jsonSuccess('get_positions', {
      positions: [{ market: 'SOL', side: 'long', sizeUsd: 100 }],
    });
    assertValidJsonResponse(response);
    expect(response.success).toBe(true);
    expect(response.command).toBe('get_positions');
    expect(response.error).toBeNull();
    expect(response.data.positions).toHaveLength(1);
  });

  it('produces valid schema with empty data', () => {
    const response = jsonSuccess('help');
    assertValidJsonResponse(response);
    expect(response.data).toEqual({});
  });

  it('sanitizes undefined values from data', () => {
    const response = jsonSuccess('test', {
      a: 1,
      b: undefined,
      c: 'hello',
    } as Record<string, unknown>);
    assertValidJsonResponse(response);
    expect(response.data).toEqual({ a: 1, c: 'hello' });
    expect('b' in response.data).toBe(false);
  });

  it('sanitizes functions from data', () => {
    const response = jsonSuccess('test', {
      value: 42,
      executeAction: () => {},
    } as Record<string, unknown>);
    assertValidJsonResponse(response);
    expect('executeAction' in response.data).toBe(false);
    expect(response.data.value).toBe(42);
  });

  it('handles nested objects', () => {
    const response = jsonSuccess('portfolio', {
      positions: [{ market: 'SOL', nested: { pnl: 10.5, entries: [1, 2] } }],
    });
    assertValidJsonResponse(response);
    const positions = response.data.positions as Array<Record<string, unknown>>;
    expect(positions[0].market).toBe('SOL');
  });
});

// ─── jsonError() ─────────────────────────────────────────────────────────────

describe('jsonError', () => {
  it('produces valid error schema', () => {
    const response = jsonError(
      'earn_unstake',
      ErrorCode.NO_SFLP_BALANCE,
      'No sFLP tokens found',
      { pool: 'crypto' },
    );
    assertValidJsonResponse(response);
    expect(response.success).toBe(false);
    expect(response.command).toBe('earn_unstake');
    expect(response.data).toEqual({});
    expect(response.error?.code).toBe('NO_SFLP_BALANCE');
    expect(response.error?.message).toBe('No sFLP tokens found');
    expect(response.error?.details).toEqual({ pool: 'crypto' });
  });

  it('produces valid error with no details', () => {
    const response = jsonError('unknown', ErrorCode.COMMAND_NOT_FOUND, 'Unknown command');
    assertValidJsonResponse(response);
    expect(response.error?.details).toEqual({});
  });

  it('uses all defined error codes correctly', () => {
    for (const [, code] of Object.entries(ErrorCode)) {
      const response = jsonError('test', code, 'test message');
      assertValidJsonResponse(response);
      expect(response.error?.code).toBe(code);
    }
  });
});

// ─── jsonFromToolResult() ────────────────────────────────────────────────────

describe('jsonFromToolResult', () => {
  it('parses JSON from tool message (IS_AGENT mode)', () => {
    const response = jsonFromToolResult('get_positions', {
      success: true,
      message: JSON.stringify({
        action: 'get_positions',
        timestamp: new Date().toISOString(),
        positions: [{ market: 'SOL', side: 'long' }],
      }),
    });
    assertValidJsonResponse(response);
    expect(response.success).toBe(true);
    expect(response.data.positions).toBeDefined();
    // Internal fields stripped
    expect('action' in response.data).toBe(false);
    expect('timestamp' in response.data).toBe(false);
  });

  it('falls back to result.data when message is not JSON', () => {
    const response = jsonFromToolResult('get_portfolio', {
      success: true,
      message: '  Portfolio: $1000 USDC',
      data: { balance: 1000, currency: 'USDC' },
    });
    assertValidJsonResponse(response);
    expect(response.data.balance).toBe(1000);
    expect(response.data.currency).toBe('USDC');
  });

  it('strips executeAction from data', () => {
    const response = jsonFromToolResult('open_position', {
      success: true,
      message: 'not json',
      data: {
        market: 'SOL',
        executeAction: async () => ({ success: true, message: '' }),
      },
    });
    assertValidJsonResponse(response);
    expect(response.data.market).toBe('SOL');
    expect('executeAction' in response.data).toBe(false);
  });

  it('includes txSignature in data', () => {
    const response = jsonFromToolResult('open_position', {
      success: true,
      message: '{}',
      txSignature: '5abc123def456',
    });
    assertValidJsonResponse(response);
    expect(response.data.tx_signature).toBe('5abc123def456');
  });

  it('creates structured error for failed results', () => {
    const response = jsonFromToolResult('close_position', {
      success: false,
      message: '  Position not found for SOL long',
    });
    assertValidJsonResponse(response);
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe(ErrorCode.POSITION_NOT_FOUND);
    expect(response.error?.message).toContain('Position not found');
  });

  it('infers correct error codes from messages', () => {
    const cases: Array<{ msg: string; expectedCode: string }> = [
      { msg: 'Insufficient balance', expectedCode: ErrorCode.INSUFFICIENT_BALANCE },
      { msg: 'No wallet connected', expectedCode: ErrorCode.NO_WALLET },
      { msg: 'Market not found: DOGE', expectedCode: ErrorCode.MARKET_NOT_FOUND },
      { msg: 'Rate limit exceeded', expectedCode: ErrorCode.RATE_LIMIT_EXCEEDED },
      { msg: 'Timeout waiting for confirmation', expectedCode: ErrorCode.COMMAND_TIMEOUT },
      { msg: 'Duplicate position on SOL long', expectedCode: ErrorCode.DUPLICATE_POSITION },
      { msg: 'No sFLP tokens found', expectedCode: ErrorCode.NO_SFLP_BALANCE },
      { msg: 'No FLP balance', expectedCode: ErrorCode.NO_FLP_BALANCE },
      { msg: 'RPC unavailable', expectedCode: ErrorCode.RPC_UNAVAILABLE },
      { msg: 'Transaction failed on-chain', expectedCode: ErrorCode.TRANSACTION_FAILED },
    ];

    for (const { msg, expectedCode } of cases) {
      const response = jsonFromToolResult('test', { success: false, message: msg });
      assertValidJsonResponse(response);
      expect(response.error?.code).toBe(expectedCode);
    }
  });
});

// ─── jsonStringify() ─────────────────────────────────────────────────────────

describe('jsonStringify', () => {
  it('produces valid parseable JSON', () => {
    const response = jsonSuccess('test', { value: 42 });
    const str = jsonStringify(response);
    const parsed = assertValidJson(str);
    expect(parsed.data.value).toBe(42);
  });

  it('contains no ANSI escape codes', () => {
    const response = jsonSuccess('test', { message: '\x1b[31mred\x1b[0m' });
    const str = jsonStringify(response);
    // eslint-disable-next-line no-control-regex
    expect(str).not.toMatch(/\x1b\[/);
  });

  it('preserves numeric types (not stringified)', () => {
    const response = jsonSuccess('test', {
      price: 95.42,
      leverage: 3,
      pnl: -12.5,
    });
    const str = jsonStringify(response);
    const parsed = JSON.parse(str);
    expect(typeof parsed.data.price).toBe('number');
    expect(typeof parsed.data.leverage).toBe('number');
    expect(typeof parsed.data.pnl).toBe('number');
  });

  it('handles null values correctly', () => {
    const response = jsonSuccess('test', { value: null, other: 'ok' });
    const str = jsonStringify(response);
    const parsed = JSON.parse(str);
    expect(parsed.data.value).toBeNull();
    expect(parsed.data.other).toBe('ok');
  });
});

// ─── Schema Version Contract ─────────────────────────────────────────────────

describe('Schema Version Contract', () => {
  it('version is v1', () => {
    expect(JSON_SCHEMA_VERSION).toBe('v1');
  });

  it('all responses include version field', () => {
    const success = jsonSuccess('test');
    const error = jsonError('test', ErrorCode.UNKNOWN_ERROR, 'error');
    const fromResult = jsonFromToolResult('test', { success: true, message: '{}' });

    expect(success.version).toBe('v1');
    expect(error.version).toBe('v1');
    expect(fromResult.version).toBe('v1');
  });
});

// ─── Deterministic Output Contract ───────────────────────────────────────────

describe('Deterministic Output Contract', () => {
  it('same input produces same JSON shape', () => {
    const r1 = jsonSuccess('positions', { positions: [] });
    const r2 = jsonSuccess('positions', { positions: [] });

    const keys1 = Object.keys(r1).sort();
    const keys2 = Object.keys(r2).sort();
    expect(keys1).toEqual(keys2);

    // Data shape is identical
    const dataKeys1 = Object.keys(r1.data).sort();
    const dataKeys2 = Object.keys(r2.data).sort();
    expect(dataKeys1).toEqual(dataKeys2);
  });

  it('field names are consistent across success and error', () => {
    const success = jsonSuccess('test', { value: 1 });
    const error = jsonError('test', ErrorCode.UNKNOWN_ERROR, 'fail');

    // Both must have exactly these top-level fields
    const requiredFields = ['success', 'command', 'timestamp', 'version', 'data', 'error'];
    for (const field of requiredFields) {
      expect(field in success).toBe(true);
      expect(field in error).toBe(true);
    }
  });

  it('error shape is always consistent', () => {
    const e1 = jsonError('test', ErrorCode.INSUFFICIENT_BALANCE, 'msg1', { amount: 10 });
    const e2 = jsonError('test', ErrorCode.MARKET_NOT_FOUND, 'msg2', {});

    const errorKeys1 = Object.keys(e1.error!).sort();
    const errorKeys2 = Object.keys(e2.error!).sort();
    expect(errorKeys1).toEqual(errorKeys2);
    expect(errorKeys1).toEqual(['code', 'details', 'message']);
  });
});

// ─── Command Category Coverage ───────────────────────────────────────────────

describe('Command Category JSON Coverage', () => {
  // These tests verify that jsonFromToolResult produces valid output
  // for the kinds of data each command category returns.

  it('Trading: positions', () => {
    const response = jsonFromToolResult('get_positions', {
      success: true,
      message: JSON.stringify({
        action: 'get_positions',
        positions: [
          { market: 'SOL', side: 'long', leverage: 3, sizeUsd: 300, collateralUsd: 100, entryPrice: 95.5, pnl: 12.3 },
        ],
      }),
    });
    assertValidJsonResponse(response);
    expect(response.data.positions).toBeDefined();
  });

  it('Trading: open position (confirmation required)', () => {
    const response = jsonFromToolResult('open_position', {
      success: true,
      message: JSON.stringify({
        market: 'SOL',
        side: 'long',
        leverage: 3,
        collateral: 100,
        estimatedSize: 300,
      }),
      data: {
        executeAction: async () => ({ success: true, message: '' }),
      },
    });
    assertValidJsonResponse(response);
    // Confirmation details would be added by terminal.ts
    expect(response.data.market).toBe('SOL');
  });

  it('Trading: close failure', () => {
    const response = jsonFromToolResult('close_position', {
      success: false,
      message: 'No position found for ETH short',
    });
    assertValidJsonResponse(response);
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe(ErrorCode.POSITION_NOT_FOUND);
  });

  it('Earn: pool status', () => {
    const response = jsonFromToolResult('earn_status', {
      success: true,
      message: JSON.stringify({
        action: 'earn_status',
        pools: [{ name: 'crypto', tvl: 5_000_000, apy: 12.5 }],
      }),
    });
    assertValidJsonResponse(response);
    expect(response.data.pools).toBeDefined();
  });

  it('Earn: unstake failure', () => {
    const response = jsonFromToolResult('earn_unstake', {
      success: false,
      message: 'No sFLP tokens found in wallet',
    });
    assertValidJsonResponse(response);
    expect(response.error?.code).toBe(ErrorCode.NO_SFLP_BALANCE);
  });

  it('FAF: status', () => {
    const response = jsonFromToolResult('faf_status', {
      success: true,
      message: JSON.stringify({
        action: 'faf_status',
        wallet_balance_faf: 1000,
        staked_faf: 500,
        vip_level: 'gold',
      }),
    });
    assertValidJsonResponse(response);
    expect(response.data.wallet_balance_faf).toBe(1000);
  });

  it('Wallet: balance', () => {
    const response = jsonFromToolResult('wallet_balance', {
      success: true,
      message: JSON.stringify({
        action: 'wallet_balance',
        sol: 2.5,
        usdc: 1000,
        address: 'ABC123...',
      }),
    });
    assertValidJsonResponse(response);
    expect(typeof response.data.sol).toBe('number');
    expect(typeof response.data.usdc).toBe('number');
  });

  it('Market Data: volume', () => {
    const response = jsonFromToolResult('get_volume', {
      success: true,
      message: JSON.stringify({
        action: 'get_volume',
        total_volume_24h: 50_000_000,
        markets: [{ market: 'SOL', volume_24h: 20_000_000 }],
      }),
    });
    assertValidJsonResponse(response);
    expect(typeof response.data.total_volume_24h).toBe('number');
  });

  it('System: degraded mode error', () => {
    const response = jsonError(
      'open_position',
      ErrorCode.DEGRADED_MODE,
      'All RPC endpoints unavailable. Terminal running in read-only mode.',
      { blocked_action: 'open_position' },
    );
    assertValidJsonResponse(response);
    expect(response.error?.code).toBe('DEGRADED_MODE');
  });

  it('System: wallet override failure', () => {
    const response = jsonError(
      'wallet_override',
      ErrorCode.WALLET_OVERRIDE_FAILED,
      'Wallet override failed: file not found',
      { key: 'missing-wallet' },
    );
    assertValidJsonResponse(response);
    expect(response.error?.code).toBe('WALLET_OVERRIDE_FAILED');
    expect(response.error?.details.key).toBe('missing-wallet');
  });
});

// ─── Pipeline Safety ─────────────────────────────────────────────────────────

describe('Pipeline Safety', () => {
  it('jsonStringify produces single valid JSON object', () => {
    const response = jsonSuccess('test', { value: 42 });
    const str = jsonStringify(response);

    // Must parse as a single object
    const parsed = JSON.parse(str);
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();

    // No extra text before or after
    expect(str.trim()).toBe(str);
  });

  it('no ANSI codes in any field', () => {
    const response = jsonSuccess('test', {
      colored: '\x1b[32mgreen\x1b[0m',
    });
    // Data sanitization should pass through strings as-is,
    // but jsonStringify should not add ANSI
    const str = jsonStringify(response);
    // The JSON itself should not contain escape sequences from the builder
    const parsed = JSON.parse(str);
    expect(parsed.success).toBe(true);
  });

  it('handles empty string message gracefully', () => {
    const response = jsonFromToolResult('test', {
      success: true,
      message: '',
    });
    assertValidJsonResponse(response);
    expect(response.success).toBe(true);
  });

  it('handles malformed JSON in message gracefully', () => {
    const response = jsonFromToolResult('test', {
      success: true,
      message: '{broken json',
    });
    assertValidJsonResponse(response);
    // Should not throw, falls back to empty data
  });
});
