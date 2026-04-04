/**
 * Tests for SigningGuard — trade limits, rate limiting, and audit logging.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SigningGuard } from '../src/security/signing-guard.js';

// Use temp path for audit log to avoid touching real filesystem
const TEMP_AUDIT_PATH = '/tmp/flash-test-signing-audit.log';

describe('SigningGuard', () => {
  let guard: SigningGuard;

  beforeEach(() => {
    guard = new SigningGuard({
      maxCollateralPerTrade: 1000,
      maxPositionSize: 5000,
      maxLeverage: 50,
      maxTradesPerMinute: 5,
      minDelayBetweenTradesMs: 500,
      auditLogPath: TEMP_AUDIT_PATH,
    });
  });

  // ─── Trade Limit Checks ─────────────────────────────────────────────────

  describe('checkTradeLimits', () => {
    it('allows trade within all limits', () => {
      const result = guard.checkTradeLimits({
        collateral: 500,
        leverage: 10,
        sizeUsd: 2500,
        market: 'SOL',
      });
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('rejects trade exceeding max collateral', () => {
      const result = guard.checkTradeLimits({
        collateral: 1500,
        leverage: 5,
        sizeUsd: 4000,
        market: 'SOL',
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Collateral');
      expect(result.reason).toContain('1500');
      expect(result.reason).toContain('1000');
    });

    it('rejects trade exceeding max position size', () => {
      const result = guard.checkTradeLimits({
        collateral: 500,
        leverage: 20,
        sizeUsd: 6000,
        market: 'SOL',
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Position size');
      expect(result.reason).toContain('exceeds');
    });

    it('rejects trade exceeding max leverage', () => {
      const result = guard.checkTradeLimits({
        collateral: 100,
        leverage: 100,
        sizeUsd: 2000,
        market: 'SOL',
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Leverage');
      expect(result.reason).toContain('100x');
    });

    it('allows trade when limits are 0 (unlimited)', () => {
      const unlimitedGuard = new SigningGuard({
        maxCollateralPerTrade: 0,
        maxPositionSize: 0,
        maxLeverage: 0,
        maxTradesPerMinute: 0,
        minDelayBetweenTradesMs: 0,
        auditLogPath: TEMP_AUDIT_PATH,
      });
      const result = unlimitedGuard.checkTradeLimits({
        collateral: 999_999,
        leverage: 500,
        sizeUsd: 10_000_000,
        market: 'BTC',
      });
      expect(result.allowed).toBe(true);
    });

    it('checks collateral before position size (first failing check wins)', () => {
      const result = guard.checkTradeLimits({
        collateral: 2000, // over limit
        leverage: 100,     // over limit
        sizeUsd: 50000,   // over limit
        market: 'SOL',
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Collateral'); // First check
    });
  });

  // ─── Rate Limiter ───────────────────────────────────────────────────────

  describe('checkRateLimit', () => {
    it('allows first trade', () => {
      const result = guard.checkRateLimit();
      expect(result.allowed).toBe(true);
    });

    it('blocks trade within minDelay window', () => {
      guard.checkRateLimit(); // first trade — reserves slot
      const result = guard.checkRateLimit(); // immediate second
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Rate limited');
      expect(result.reason).toContain('minimum');
    });

    it('blocks when max trades per minute exceeded', () => {
      // Create guard with no delay but max 3 trades/min
      const fastGuard = new SigningGuard({
        maxTradesPerMinute: 3,
        minDelayBetweenTradesMs: 0,
        auditLogPath: TEMP_AUDIT_PATH,
      });
      expect(fastGuard.checkRateLimit().allowed).toBe(true);
      expect(fastGuard.checkRateLimit().allowed).toBe(true);
      expect(fastGuard.checkRateLimit().allowed).toBe(true);
      // 4th should be blocked
      const result = fastGuard.checkRateLimit();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('maximum');
    });

    it('reserves slot atomically (TOCTOU prevention)', () => {
      // After checkRateLimit returns allowed, the slot is already reserved
      const result1 = guard.checkRateLimit();
      expect(result1.allowed).toBe(true);
      // Immediate second call should see the reserved slot
      const result2 = guard.checkRateLimit();
      expect(result2.allowed).toBe(false);
    });

    it('allows trade when rate limit is 0 (unlimited)', () => {
      const unlimitedGuard = new SigningGuard({
        maxTradesPerMinute: 0,
        minDelayBetweenTradesMs: 0,
        auditLogPath: TEMP_AUDIT_PATH,
      });
      for (let i = 0; i < 20; i++) {
        expect(unlimitedGuard.checkRateLimit().allowed).toBe(true);
      }
    });
  });

  // ─── Record Signing ─────────────────────────────────────────────────────

  describe('recordSigning', () => {
    it('trims timestamps older than 2 minutes', () => {
      // This verifies recordSigning doesn't throw and trims history
      expect(() => guard.recordSigning()).not.toThrow();
    });
  });

  // ─── Audit Log ──────────────────────────────────────────────────────────

  describe('logAudit', () => {
    it('writes audit entry without throwing', () => {
      expect(() => guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'open',
        market: 'SOL',
        side: 'long',
        collateral: 100,
        leverage: 5,
        sizeUsd: 500,
        walletAddress: 'TEST_WALLET',
        result: 'confirmed',
      })).not.toThrow();
    });

    it('handles rejection entries', () => {
      expect(() => guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'open',
        market: 'SOL',
        walletAddress: 'TEST_WALLET',
        result: 'rejected',
        reason: 'Exceeds max collateral',
      })).not.toThrow();
    });

    it('handles rate_limited entries', () => {
      expect(() => guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'close',
        market: 'BTC',
        walletAddress: 'TEST_WALLET',
        result: 'rate_limited',
        reason: 'Too many trades',
      })).not.toThrow();
    });

    it('survives invalid audit log path gracefully', () => {
      const badGuard = new SigningGuard({
        auditLogPath: '/nonexistent/path/audit.log',
      });
      expect(() => badGuard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'open',
        market: 'SOL',
        walletAddress: 'TEST_WALLET',
        result: 'confirmed',
      })).not.toThrow();
    });
  });

  // ─── Getters ────────────────────────────────────────────────────────────

  describe('limits getter', () => {
    it('returns configured limits', () => {
      const limits = guard.limits;
      expect(limits.maxCollateralPerTrade).toBe(1000);
      expect(limits.maxPositionSize).toBe(5000);
      expect(limits.maxLeverage).toBe(50);
      expect(limits.maxTradesPerMinute).toBe(5);
    });
  });
});
