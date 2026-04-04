/**
 * Signing Guard — Central transaction signing security module.
 *
 * Provides:
 * - Configurable max trade limits (collateral, position size, leverage)
 * - Signing rate limiter (max trades/minute, min delay between trades)
 * - Signing audit log (file-based, never logs private keys)
 * - Enforcement that every transaction must pass through this gate
 */

import { appendFileSync, mkdirSync, existsSync, writeFileSync, statSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

// ─── Configuration ────────────────────────────────────────────────────────────

export interface SigningGuardConfig {
  /** Maximum collateral per single trade (USD). 0 = unlimited. */
  maxCollateralPerTrade: number;
  /** Maximum position size per single trade (USD). 0 = unlimited. */
  maxPositionSize: number;
  /** Maximum leverage allowed. 0 = use market defaults only. */
  maxLeverage: number;
  /** Maximum number of signing operations per minute. 0 = unlimited. */
  maxTradesPerMinute: number;
  /** Minimum delay between consecutive signings (ms). 0 = no delay. */
  minDelayBetweenTradesMs: number;
  /** Path to signing audit log file. */
  auditLogPath: string;
}

export const DEFAULT_SIGNING_GUARD_CONFIG: SigningGuardConfig = {
  maxCollateralPerTrade: 0, // unlimited by default — user sets via env
  maxPositionSize: 0, // unlimited by default
  maxLeverage: 0, // use market defaults
  maxTradesPerMinute: 10, // 10 trades/minute max
  minDelayBetweenTradesMs: 3000, // 3s minimum between trades
  auditLogPath: join(homedir(), '.flash', 'signing-audit.log'),
};

// ─── Trade Limit Validation ───────────────────────────────────────────────────

export interface TradeLimitCheck {
  allowed: boolean;
  reason?: string;
}

// ─── Signing Audit Entry ──────────────────────────────────────────────────────

export interface SigningAuditEntry {
  timestamp: string;
  type: 'open' | 'close' | 'partial_close' | 'add_collateral' | 'remove_collateral';
  market: string;
  side?: string;
  collateral?: number;
  leverage?: number;
  sizeUsd?: number;
  walletAddress: string;
  result: 'confirmed' | 'rejected' | 'failed' | 'rate_limited';
  reason?: string;
}

// ─── Signing Guard ────────────────────────────────────────────────────────────

const MAX_AUDIT_LOG_BYTES = 10 * 1024 * 1024; // 10MB max
const MAX_SIGNING_HISTORY = 100; // Hard cap on timestamp array size

export class SigningGuard {
  private config: SigningGuardConfig;
  private signingTimestamps: number[] = [];
  private lastSigningTime = 0;

  constructor(config?: Partial<SigningGuardConfig>) {
    this.config = { ...DEFAULT_SIGNING_GUARD_CONFIG, ...config };
    this.initAuditLog();
  }

  // ─── Trade Limit Checks ─────────────────────────────────────────────────

  /**
   * Check if a trade's parameters are within configured limits.
   * Returns { allowed: true } if OK, { allowed: false, reason } if blocked.
   */
  checkTradeLimits(params: { collateral: number; leverage: number; sizeUsd: number; market: string }): TradeLimitCheck {
    const { collateral, leverage, sizeUsd, market: _market } = params;

    // Max collateral per trade
    if (this.config.maxCollateralPerTrade > 0 && collateral > this.config.maxCollateralPerTrade) {
      return {
        allowed: false,
        reason:
          `Collateral $${collateral.toFixed(2)} exceeds maximum allowed $${this.config.maxCollateralPerTrade.toFixed(2)} per trade. ` +
          `Adjust MAX_COLLATERAL_PER_TRADE in .env to change this limit.`,
      };
    }

    // Max position size
    if (this.config.maxPositionSize > 0 && sizeUsd > this.config.maxPositionSize) {
      return {
        allowed: false,
        reason:
          `Position size $${sizeUsd.toFixed(2)} exceeds maximum allowed $${this.config.maxPositionSize.toFixed(2)}. ` +
          `Adjust MAX_POSITION_SIZE in .env to change this limit.`,
      };
    }

    // Max leverage
    if (this.config.maxLeverage > 0 && leverage > this.config.maxLeverage) {
      return {
        allowed: false,
        reason:
          `Leverage ${leverage}x exceeds maximum allowed ${this.config.maxLeverage}x. ` +
          `Adjust MAX_LEVERAGE in .env to change this limit.`,
      };
    }

    return { allowed: true };
  }

  // ─── Rate Limiter ───────────────────────────────────────────────────────

  /**
   * [M-5] Check rate limit AND reserve a slot atomically to prevent TOCTOU gap.
   * The slot is reserved immediately so concurrent trades can't bypass the limiter
   * during the 45s+ confirmation window.
   * Returns { allowed: true } if OK, { allowed: false, reason } if rate-limited.
   */
  checkRateLimit(): TradeLimitCheck {
    const now = Date.now();

    // Minimum delay between trades
    if (this.config.minDelayBetweenTradesMs > 0) {
      const elapsed = now - this.lastSigningTime;
      if (this.lastSigningTime > 0 && elapsed < this.config.minDelayBetweenTradesMs) {
        const waitSec = ((this.config.minDelayBetweenTradesMs - elapsed) / 1000).toFixed(1);
        return {
          allowed: false,
          reason:
            `Rate limited: minimum ${(this.config.minDelayBetweenTradesMs / 1000).toFixed(0)}s between trades. ` +
            `Wait ${waitSec}s before submitting another transaction.`,
        };
      }
    }

    // Max trades per minute
    if (this.config.maxTradesPerMinute > 0) {
      const oneMinuteAgo = now - 60_000;
      this.signingTimestamps = this.signingTimestamps.filter((t) => t > oneMinuteAgo);
      if (this.signingTimestamps.length >= this.config.maxTradesPerMinute) {
        return {
          allowed: false,
          reason:
            `Rate limited: maximum ${this.config.maxTradesPerMinute} trades per minute reached. ` +
            `Wait before submitting another transaction.`,
        };
      }
    }

    // Reserve the slot immediately to close TOCTOU gap
    this.lastSigningTime = now;
    this.signingTimestamps.push(now);

    // Hard cap: prevent unbounded growth under any condition
    if (this.signingTimestamps.length > MAX_SIGNING_HISTORY) {
      this.signingTimestamps = this.signingTimestamps.slice(-MAX_SIGNING_HISTORY);
    }

    return { allowed: true };
  }

  /**
   * Record that a signing operation completed (call after confirmation).
   * Since checkRateLimit() now reserves eagerly, this just trims old timestamps.
   */
  recordSigning(): void {
    const now = Date.now();
    this.lastSigningTime = now;
    // Trim old timestamps (keep last 2 minutes) + enforce hard cap
    const twoMinutesAgo = now - 120_000;
    this.signingTimestamps = this.signingTimestamps.filter((t) => t > twoMinutesAgo);
    if (this.signingTimestamps.length > MAX_SIGNING_HISTORY) {
      this.signingTimestamps = this.signingTimestamps.slice(-MAX_SIGNING_HISTORY);
    }
  }

  // ─── Audit Log ──────────────────────────────────────────────────────────

  /**
   * Log a signing event to the audit log.
   * NEVER logs private keys, signatures, or raw transaction data.
   */
  logAudit(entry: SigningAuditEntry): void {
    const line = JSON.stringify(entry) + '\n';

    try {
      // Rotate if needed
      if (existsSync(this.config.auditLogPath)) {
        const size = statSync(this.config.auditLogPath).size;
        if (size > MAX_AUDIT_LOG_BYTES) {
          // Rotate up to 10 files
          for (let i = 9; i >= 1; i--) {
            const from = i === 1 ? this.config.auditLogPath + '.old' : this.config.auditLogPath + `.old.${i}`;
            const to = this.config.auditLogPath + `.old.${i + 1}`;
            try {
              renameSync(from, to);
            } catch {
              /* ignore */
            }
          }
          renameSync(this.config.auditLogPath, this.config.auditLogPath + '.old');
          writeFileSync(this.config.auditLogPath, '', { mode: 0o600 });
        }
      }
      appendFileSync(this.config.auditLogPath, line);
    } catch {
      // Best-effort — don't crash on audit log failure
    }
  }

  private initAuditLog(): void {
    try {
      const dir = dirname(this.config.auditLogPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      if (!existsSync(this.config.auditLogPath)) {
        writeFileSync(this.config.auditLogPath, '', { mode: 0o600 });
      }
    } catch {
      // Best-effort
    }
  }

  // ─── Getters ────────────────────────────────────────────────────────────

  get limits(): {
    maxCollateralPerTrade: number;
    maxPositionSize: number;
    maxLeverage: number;
    maxTradesPerMinute: number;
  } {
    return {
      maxCollateralPerTrade: this.config.maxCollateralPerTrade,
      maxPositionSize: this.config.maxPositionSize,
      maxLeverage: this.config.maxLeverage,
      maxTradesPerMinute: this.config.maxTradesPerMinute,
    };
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _guard: SigningGuard | null = null;

export function initSigningGuard(config?: Partial<SigningGuardConfig>): SigningGuard {
  if (_guard) return _guard;
  _guard = new SigningGuard(config);
  return _guard;
}

export function getSigningGuard(): SigningGuard {
  if (!_guard) {
    _guard = new SigningGuard();
  }
  return _guard;
}
