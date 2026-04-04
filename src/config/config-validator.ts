/**
 * Configuration Validator — startup safety checks.
 *
 * Validates environment configuration for conflicting or unsafe settings.
 * Emits warnings but never blocks startup — operators decide what to fix.
 *
 * ADDITIVE ONLY — does not modify any runtime behavior.
 */

import { getLogger } from '../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ConfigWarning {
  level: 'warning' | 'error';
  code: string;
  message: string;
}

// ─── Validation ──────────────────────────────────────────────────────────────

export function validateConfig(): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];

  // ── Kill switch + live mode conflict ──
  const tradingEnabled = (process.env.TRADING_ENABLED ?? 'true').toLowerCase().trim();
  const simMode = (process.env.SIMULATION_MODE ?? 'true').toLowerCase().trim();

  if (tradingEnabled === 'false' && simMode === 'false') {
    warnings.push({
      level: 'warning',
      code: 'KILL_SWITCH_LIVE',
      message: 'TRADING_ENABLED=false with SIMULATION_MODE=false — live mode will be monitoring-only.',
    });
  }

  // ── Position size > portfolio exposure conflict ──
  const maxPositionSize = parseFloat(process.env.MAX_POSITION_SIZE ?? '0');
  const maxExposure = parseFloat(process.env.MAX_PORTFOLIO_EXPOSURE ?? '0');

  if (maxPositionSize > 0 && maxExposure > 0 && maxPositionSize > maxExposure) {
    warnings.push({
      level: 'warning',
      code: 'POSITION_GT_EXPOSURE',
      message: `MAX_POSITION_SIZE ($${maxPositionSize}) exceeds MAX_PORTFOLIO_EXPOSURE ($${maxExposure}). A single trade could hit the exposure limit.`,
    });
  }

  // ── Collateral per trade > portfolio exposure ──
  const maxCollateral = parseFloat(process.env.MAX_COLLATERAL_PER_TRADE ?? '0');
  if (maxCollateral > 0 && maxExposure > 0) {
    // At max leverage, collateral * leverage could far exceed exposure
    const maxLev = parseFloat(process.env.MAX_LEVERAGE ?? '0');
    if (maxLev > 0 && maxCollateral * maxLev > maxExposure) {
      warnings.push({
        level: 'warning',
        code: 'COLLATERAL_LEV_EXPOSURE',
        message: `MAX_COLLATERAL_PER_TRADE ($${maxCollateral}) × MAX_LEVERAGE (${maxLev}x) = $${maxCollateral * maxLev} exceeds MAX_PORTFOLIO_EXPOSURE ($${maxExposure}).`,
      });
    }
  }

  // ── RPC URL validation ──
  const rpcUrl = process.env.RPC_URL ?? '';
  if (rpcUrl && !rpcUrl.startsWith('https://') && !rpcUrl.startsWith('http://localhost')) {
    warnings.push({
      level: 'warning',
      code: 'RPC_NOT_HTTPS',
      message: `RPC_URL is not HTTPS: ${rpcUrl.slice(0, 50)}... — traffic may be intercepted.`,
    });
  }

  // ── Session loss > daily loss conflict ──
  const sessionLoss = parseFloat(process.env.MAX_SESSION_LOSS_USD ?? '0');
  const dailyLoss = parseFloat(process.env.MAX_DAILY_LOSS_USD ?? '0');

  if (sessionLoss > 0 && dailyLoss > 0 && sessionLoss > dailyLoss) {
    warnings.push({
      level: 'warning',
      code: 'SESSION_GT_DAILY',
      message: `MAX_SESSION_LOSS_USD ($${sessionLoss}) exceeds MAX_DAILY_LOSS_USD ($${dailyLoss}). Daily limit will trigger first.`,
    });
  }

  // ── Extreme rate limiting ──
  const tradesPerMin = parseFloat(process.env.MAX_TRADES_PER_MINUTE ?? '10');
  if (tradesPerMin > 0 && tradesPerMin < 2) {
    warnings.push({
      level: 'warning',
      code: 'LOW_RATE_LIMIT',
      message: `MAX_TRADES_PER_MINUTE=${tradesPerMin} is very restrictive. May interfere with normal trading.`,
    });
  }

  // ── Compute unit price sanity ──
  const cuPrice = parseFloat(process.env.COMPUTE_UNIT_PRICE ?? '100000');
  if (cuPrice > 500_000) {
    warnings.push({
      level: 'warning',
      code: 'HIGH_PRIORITY_FEE',
      message: `COMPUTE_UNIT_PRICE=${cuPrice} microLamports is very high. Excessive priority fees.`,
    });
  }

  return warnings;
}

/** Run validation and log warnings. Returns the warnings for display. */
export function validateAndLogConfig(): ConfigWarning[] {
  const warnings = validateConfig();

  if (warnings.length === 0) return warnings;

  try {
    const logger = getLogger();
    for (const w of warnings) {
      if (w.level === 'error') {
        logger.warn('CONFIG', `[${w.code}] ${w.message}`);
      } else {
        logger.info('CONFIG', `[${w.code}] ${w.message}`);
      }
    }
  } catch {
    /* logging must never throw */
  }

  return warnings;
}
