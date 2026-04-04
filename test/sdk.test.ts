/**
 * Flash SDK Test Suite
 *
 * Tests the SDK wrapper: command building, response parsing,
 * error handling, timeout behavior, and watch mode.
 *
 * Uses vi.mock to mock child_process in ESM mode.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlashError, FlashTimeoutError, FlashParseError, FlashProcessError } from '../src/sdk/errors.js';
import type { FlashResponse, FlashErrorInfo } from '../src/sdk/types.js';

// ─── Mock child_process ──────────────────────────────────────────────────────

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecFileFn = (file: string, args: string[], opts: Record<string, unknown>, cb: ExecFileCallback) => { on: () => void };

let mockImpl: ExecFileFn;

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockImpl(...(args as Parameters<ExecFileFn>)),
}));

function setMockResponse(response: string, exitCode = 0, stderr = ''): void {
  mockImpl = (_file, _args, _opts, callback) => {
    if (exitCode !== 0) {
      const error = new Error(stderr || 'Process failed') as Error & { code?: string; killed?: boolean };
      error.code = String(exitCode);
      callback(error, response, stderr);
    } else {
      callback(null, response, stderr);
    }
    return { on: vi.fn() } as { on: () => void };
  };
}

function setMockTimeout(): void {
  mockImpl = (_file, _args, _opts, callback) => {
    const error = new Error('Timeout') as Error & { killed?: boolean };
    (error as Record<string, unknown>).killed = true;
    callback(error, '', '');
    return { on: vi.fn() } as { on: () => void };
  };
}

function makeResponse<T>(data: T, success = true, command = 'test'): string {
  const response: FlashResponse<T> = {
    success,
    command,
    timestamp: new Date().toISOString(),
    version: 'v1',
    data,
    error: success ? null : { code: 'TEST_ERROR', message: 'Test error', details: {} },
  };
  return JSON.stringify(response, null, 2);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

// Import SDK after mock setup
const { FlashSDK } = await import('../src/sdk/flash-sdk.js');

describe('FlashSDK', () => {
  let sdk: InstanceType<typeof FlashSDK>;

  beforeEach(() => {
    sdk = new FlashSDK({ binPath: '/usr/bin/flash', timeout: 5000 });
    setMockResponse(makeResponse({ ok: true })); // default
  });

  // ─── Constructor ─────────────────────────────────────────────────

  describe('constructor', () => {
    it('accepts custom options', () => {
      const custom = new FlashSDK({
        binPath: '/custom/flash',
        timeout: 30000,
        maxRetries: 3,
        env: { SIMULATION_MODE: 'true' },
        cwd: '/tmp',
      });
      expect(custom).toBeDefined();
    });

    it('uses defaults when no options provided', () => {
      expect(new FlashSDK()).toBeDefined();
    });
  });

  // ─── execute() ───────────────────────────────────────────────────

  describe('execute()', () => {
    it('returns parsed response for successful command', async () => {
      setMockResponse(makeResponse({ positions: [{ market: 'SOL', side: 'long' }] }, true, 'get_positions'));
      const result = await sdk.execute('positions');
      expect(result.success).toBe(true);
      expect(result.version).toBe('v1');
      expect(result.data.positions).toBeDefined();
    });

    it('throws FlashError for failed command', async () => {
      const errorResponse: FlashResponse = {
        success: false,
        command: 'close_position',
        timestamp: new Date().toISOString(),
        version: 'v1',
        data: {},
        error: {
          code: 'POSITION_NOT_FOUND',
          message: 'No position found for ETH short',
          details: { market: 'ETH', side: 'short' },
        },
      };
      setMockResponse(JSON.stringify(errorResponse));

      try {
        await sdk.execute('close ETH short');
        expect.fail('Should have thrown');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(FlashError);
        const fe = error as FlashError;
        expect(fe.code).toBe('POSITION_NOT_FOUND');
        expect(fe.message).toBe('No position found for ETH short');
        expect(fe.details.market).toBe('ETH');
        expect(fe.command).toBe('close ETH short');
      }
    });
  });

  // ─── executeRaw() ────────────────────────────────────────────────

  describe('executeRaw()', () => {
    it('returns error response without throwing', async () => {
      const errorResponse: FlashResponse = {
        success: false,
        command: 'test',
        timestamp: new Date().toISOString(),
        version: 'v1',
        data: {},
        error: { code: 'FAIL', message: 'failed', details: {} },
      };
      setMockResponse(JSON.stringify(errorResponse));

      const result = await sdk.executeRaw('test');
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FAIL');
    });
  });

  // ─── Response Parsing ────────────────────────────────────────────

  describe('response parsing', () => {
    it('parses valid JSON response', async () => {
      setMockResponse(makeResponse({ value: 42 }));
      const result = await sdk.execute('test');
      expect(result.data.value).toBe(42);
    });

    it('throws FlashParseError for invalid JSON', async () => {
      setMockResponse('this is not json');
      await expect(sdk.execute('test')).rejects.toThrow(FlashParseError);
    });

    it('throws FlashParseError for empty output', async () => {
      setMockResponse('');
      await expect(sdk.execute('test')).rejects.toThrow(FlashParseError);
    });

    it('handles JSON with leading noise', async () => {
      const response = makeResponse({ ok: true });
      setMockResponse(`some warning text\n${response}`);
      const result = await sdk.execute('test');
      expect(result.data.ok).toBe(true);
    });

    it('fills missing fields with defaults', async () => {
      setMockResponse(JSON.stringify({ data: { value: 1 } }));
      const result = await sdk.executeRaw('test');
      expect(result.success).toBe(false); // missing = false
      expect(result.version).toBe('v1');
      expect(result.command).toBe('test');
    });

    it('preserves numeric types', async () => {
      setMockResponse(makeResponse({ price: 95.42, leverage: 3, pnl: -12.5 }));
      const result = await sdk.execute('test');
      expect(typeof result.data.price).toBe('number');
      expect(typeof result.data.leverage).toBe('number');
      expect(typeof result.data.pnl).toBe('number');
    });
  });

  // ─── Timeout ─────────────────────────────────────────────────────

  describe('timeout handling', () => {
    it('throws FlashTimeoutError when process is killed', async () => {
      setMockTimeout();
      try {
        await sdk.execute('slow command');
        expect.fail('Should have thrown');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(FlashTimeoutError);
        expect((error as FlashTimeoutError).code).toBe('COMMAND_TIMEOUT');
      }
    });
  });

  // ─── Process Errors ──────────────────────────────────────────────

  describe('process errors', () => {
    it('throws FlashProcessError for non-zero exit with no stdout', async () => {
      setMockResponse('', 1, 'segfault');
      await expect(sdk.execute('bad')).rejects.toThrow(FlashProcessError);
    });

    it('extracts valid JSON from stdout even on non-zero exit', async () => {
      setMockResponse(makeResponse({ partial: true }), 1);
      const result = await sdk.executeRaw('partial');
      expect(result.data.partial).toBe(true);
    });
  });

  // ─── Retry Logic ─────────────────────────────────────────────────

  describe('retry logic', () => {
    it('does not retry business logic errors', async () => {
      const sdkRetry = new FlashSDK({ binPath: '/usr/bin/flash', maxRetries: 2 });
      let callCount = 0;
      mockImpl = (_f, _a, _o, cb) => {
        callCount++;
        const resp: FlashResponse = {
          success: false, command: 'test', timestamp: new Date().toISOString(), version: 'v1', data: {},
          error: { code: 'INSUFFICIENT_BALANCE', message: 'Not enough', details: {} },
        };
        cb(null, JSON.stringify(resp), '');
        return { on: vi.fn() } as { on: () => void };
      };

      await expect(sdkRetry.execute('test')).rejects.toThrow(FlashError);
      expect(callCount).toBe(1); // No retry
    });

    it('retries transient NETWORK_ERROR', async () => {
      const sdkRetry = new FlashSDK({ binPath: '/usr/bin/flash', maxRetries: 1 });
      let callCount = 0;
      mockImpl = (_f, _a, _o, cb) => {
        callCount++;
        if (callCount === 1) {
          const resp: FlashResponse = {
            success: false, command: 'test', timestamp: new Date().toISOString(), version: 'v1', data: {},
            error: { code: 'NETWORK_ERROR', message: 'Network down', details: {} },
          };
          cb(null, JSON.stringify(resp), '');
        } else {
          cb(null, makeResponse({ ok: true }), '');
        }
        return { on: vi.fn() } as { on: () => void };
      };

      const result = await sdkRetry.execute('test');
      expect(result.success).toBe(true);
      expect(callCount).toBe(2); // Retried once
    });
  });

  // ─── Command Building ────────────────────────────────────────────

  describe('convenience methods', () => {
    let lastArgs: string[];
    beforeEach(() => {
      lastArgs = [];
      mockImpl = (_f, args, _o, cb) => {
        lastArgs = args as string[];
        cb(null, makeResponse({}), '');
        return { on: vi.fn() } as { on: () => void };
      };
    });

    it('positions() sends "positions"', async () => {
      await sdk.positions();
      expect(lastArgs[1]).toBe('positions');
    });

    it('portfolio() sends "portfolio"', async () => {
      await sdk.portfolio();
      expect(lastArgs[1]).toBe('portfolio');
    });

    it('open() builds "long SOL 3x $50"', async () => {
      await sdk.open({ market: 'SOL', side: 'long', leverage: 3, collateral: 50 });
      expect(lastArgs[1]).toContain('long');
      expect(lastArgs[1]).toContain('SOL');
      expect(lastArgs[1]).toContain('3x');
      expect(lastArgs[1]).toContain('$50');
    });

    it('open() includes tp/sl', async () => {
      await sdk.open({ market: 'SOL', side: 'long', leverage: 3, collateral: 50, tp: 100, sl: 80 });
      expect(lastArgs[1]).toContain('tp $100');
      expect(lastArgs[1]).toContain('sl $80');
    });

    it('close() builds "close BTC short"', async () => {
      await sdk.close({ market: 'BTC', side: 'short' });
      expect(lastArgs[1]).toContain('close');
      expect(lastArgs[1]).toContain('BTC');
      expect(lastArgs[1]).toContain('short');
    });

    it('close() includes percent', async () => {
      await sdk.close({ market: 'SOL', side: 'long', percent: 50 });
      expect(lastArgs[1]).toContain('50%');
    });

    it('limitOrder() builds correct command', async () => {
      await sdk.limitOrder({ market: 'SOL', side: 'long', leverage: 2, collateral: 100, price: 82 });
      expect(lastArgs[1]).toContain('limit');
      expect(lastArgs[1]).toContain('@ $82');
    });

    it('markets() sends "markets"', async () => {
      await sdk.markets();
      expect(lastArgs[1]).toBe('markets');
    });

    it('walletBalance() sends "wallet balance"', async () => {
      await sdk.walletBalance();
      expect(lastArgs[1]).toBe('wallet balance');
    });

    it('earn() sends "earn"', async () => {
      await sdk.earn();
      expect(lastArgs[1]).toBe('earn');
    });

    it('faf() sends "faf"', async () => {
      await sdk.faf();
      expect(lastArgs[1]).toBe('faf');
    });

    it('health() sends "doctor"', async () => {
      await sdk.health();
      expect(lastArgs[1]).toBe('doctor');
    });

    it('analyze() sends "analyze SOL"', async () => {
      await sdk.analyze('SOL');
      expect(lastArgs[1]).toBe('analyze SOL');
    });

    it('addCollateral() builds correct command', async () => {
      await sdk.addCollateral({ market: 'SOL', side: 'long', amount: 25 });
      expect(lastArgs[1]).toContain('add');
      expect(lastArgs[1]).toContain('SOL');
      expect(lastArgs[1]).toContain('$25');
    });

    it('closeAll() sends "close all"', async () => {
      await sdk.closeAll();
      expect(lastArgs[1]).toBe('close all');
    });
  });

  // ─── Watch Mode ──────────────────────────────────────────────────

  describe('watch()', () => {
    it('calls callback with responses', async () => {
      setMockResponse(makeResponse({ tick: 1 }));
      const results: number[] = [];
      const handle = sdk.watch('test', (_resp, iter) => { results.push(iter); },
        { interval: 30, maxIterations: 3, deduplicate: false });

      await new Promise((r) => setTimeout(r, 200));
      handle.stop();
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('stop() terminates the loop', async () => {
      setMockResponse(makeResponse({ ok: true }));
      const handle = sdk.watch('test', () => {}, { interval: 30 });
      expect(handle.running).toBe(true);
      handle.stop();
      await new Promise((r) => setTimeout(r, 80));
      expect(handle.running).toBe(false);
    });

    it('deduplicates by default', async () => {
      setMockResponse(makeResponse({ same: 'data' }));
      const results: number[] = [];
      const handle = sdk.watch('test', (_r, i) => { results.push(i); },
        { interval: 30, maxIterations: 5 });

      await new Promise((r) => setTimeout(r, 300));
      handle.stop();
      expect(results.length).toBe(1); // Only 1 emit since data never changes
    });
  });
});

// ─── Error Classes ───────────────────────────────────────────────────────────

describe('FlashError', () => {
  it('has code, message, details, command', () => {
    const err = new FlashError('TEST_CODE', 'Test message', { key: 'value' }, 'test cmd');
    expect(err.code).toBe('TEST_CODE');
    expect(err.message).toBe('Test message');
    expect(err.details.key).toBe('value');
    expect(err.command).toBe('test cmd');
    expect(err.name).toBe('FlashError');
    expect(err).toBeInstanceOf(Error);
  });

  it('toJSON() produces structured output', () => {
    const json = new FlashError('CODE', 'msg', { x: 1 }).toJSON();
    expect(json.name).toBe('FlashError');
    expect(json.code).toBe('CODE');
  });

  it('fromErrorInfo() creates error from response', () => {
    const err = FlashError.fromErrorInfo(
      { code: 'INSUFFICIENT_BALANCE', message: 'Not enough', details: { needed: 100 } },
      'open sol',
    );
    expect(err.code).toBe('INSUFFICIENT_BALANCE');
    expect(err.details.needed).toBe(100);
    expect(err.command).toBe('open sol');
  });
});

describe('FlashTimeoutError', () => {
  it('has correct code and message', () => {
    const err = new FlashTimeoutError('slow', 15000);
    expect(err.code).toBe('COMMAND_TIMEOUT');
    expect(err.name).toBe('FlashTimeoutError');
    expect(err.message).toContain('15000ms');
    expect(err).toBeInstanceOf(FlashError);
  });
});

describe('FlashParseError', () => {
  it('captures raw output', () => {
    const err = new FlashParseError('test', 'garbage');
    expect(err.code).toBe('PARSE_ERROR');
    expect(err.rawOutput).toBe('garbage');
    expect(err).toBeInstanceOf(FlashError);
  });
});

describe('FlashProcessError', () => {
  it('captures exit code and stderr', () => {
    const err = new FlashProcessError('test', 1, 'segfault');
    expect(err.code).toBe('PROCESS_ERROR');
    expect(err.exitCode).toBe(1);
    expect(err.stderr).toBe('segfault');
    expect(err).toBeInstanceOf(FlashError);
  });
});
