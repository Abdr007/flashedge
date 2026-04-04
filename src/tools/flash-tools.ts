import { z } from 'zod';
import { ToolDefinition, ToolResult, TradeSide, Position, MarketData, MarketOI } from '../types/index.js';
import {
  formatUsd,
  formatPrice,
  colorPnl,
  colorPercent,
  colorSide,
  formatTable,
  humanizeSdkError,
} from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import { getProtocolFeeRates, calcFeeUsd, ProtocolParameterError } from '../utils/protocol-fees.js';
import { filterValidPositions } from '../core/invariants.js';
import { getSigningGuard } from '../security/signing-guard.js';
import { getTradingGate } from '../security/trading-gate.js';
import { getCircuitBreaker } from '../security/circuit-breaker.js';
import {
  logKillSwitchBlock,
  logExposureBlock,
  logCircuitBreakerBlock,
  logTradeStart,
  logTradeSuccess,
  logTradeFailure,
} from '../observability/trade-events.js';
import { getShadowEngine } from '../shadow/shadow-engine.js';
import { logShadowTrade } from '../observability/shadow-events.js';
import { getTradeJournal } from '../journal/trade-journal.js';
import chalk from 'chalk';
import { theme } from '../cli/theme.js';
import { resolveMarket } from '../utils/market-resolver.js';

// ─── Trade Helpers (extracted to trade-helpers.ts) ──────────────────────────

import {
  buildRiskPreview,
  buildPositionPreview,
  validateLiveTradeContext,
  buildLiveTradeWarnings,
  estimateLiqPrice,
} from './trade-helpers.js';

/** Scrub sensitive data (URLs, API keys) from error messages before displaying to the user. */
function scrubErrorMsg(msg: string): string {
  return msg
    .replace(/https?:\/\/[^\s"']+/g, (url) => {
      try { return new URL(url).origin + '/***'; } catch { return '***'; }
    })
    .replace(/sk-ant-[^\s"']+/g, 'sk-ant-***')
    .replace(/gsk_[^\s"']+/g, 'gsk_***')
    .replace(/api[_-]?key=[^&\s"]+/gi, 'api_key=***');
}

// ─── flash_open_position ─────────────────────────────────────────────────────

export const flashOpenPosition: ToolDefinition = {
  name: 'flash_open_position',
  description: 'Open a leveraged trading position on Flash Trade',
  parameters: z.object({
    market: z.string(),
    side: z.nativeEnum(TradeSide),
    collateral: z.number().positive().max(10_000_000),
    leverage: z.number().min(1).max(1000), // Absolute protocol max; per-market limits enforced below
    collateral_token: z.string().optional(),
    takeProfit: z.number().positive().optional(),
    stopLoss: z.number().positive().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { market, side, collateral, leverage, collateral_token, takeProfit, stopLoss } = params as {
      market: string;
      side: TradeSide;
      collateral: number;
      leverage: number;
      collateral_token?: string;
      takeProfit?: number;
      stopLoss?: number;
    };

    // Pre-trade validation for live mode
    const validationError = validateLiveTradeContext(context);
    if (validationError) {
      return { success: false, message: chalk.red(`  ${validationError}`) };
    }

    // Resolve pool for this market
    const { getPoolForMarket } = await import('../config/index.js');
    const pool = getPoolForMarket(market);
    if (!pool) {
      return { success: false, message: chalk.red(`  Market not supported on Flash Trade: ${market}`) };
    }

    // Check if virtual market is currently open
    const { getMarketStatus, formatMarketClosedMessage } = await import('../data/market-hours.js');
    const marketStatus = getMarketStatus(market);
    if (!marketStatus.isOpen) {
      return { success: false, message: chalk.yellow(formatMarketClosedMessage(market)) };
    }

    if (!Number.isFinite(collateral) || !Number.isFinite(leverage) || collateral <= 0 || leverage <= 0) {
      return {
        success: false,
        message: chalk.red('  Invalid trade parameters: collateral and leverage must be positive numbers.'),
      };
    }

    if (collateral < 10) {
      return { success: false, message: chalk.red(`  Minimum collateral is $10 (got $${collateral}).`) };
    }

    // Per-market leverage limit from Flash Trade protocol
    const { getMaxLeverage, hasDegenMode, getDegenMinLeverage } = await import('../config/index.js');
    const maxLev = getMaxLeverage(market, context.degenMode);
    if (leverage > maxLev) {
      if (!context.degenMode && hasDegenMode(market)) {
        const degenMax = getMaxLeverage(market, true);
        return {
          success: false,
          message: chalk.red(
            `  Maximum leverage for ${market}: ${maxLev}x. ` +
              `Enable degen mode for up to ${degenMax}x (min ${getDegenMinLeverage(market)}x).`,
          ),
        };
      }
      return { success: false, message: chalk.red(`  Maximum leverage for ${market}: ${maxLev}x`) };
    }

    // Degen mode: enforce minimum leverage requirement
    if (context.degenMode && hasDegenMode(market)) {
      const degenMin = getDegenMinLeverage(market);
      if (leverage > getMaxLeverage(market, false) && leverage < degenMin) {
        return {
          success: false,
          message: chalk.red(`  Degen mode on ${market} requires minimum ${degenMin}x leverage (got ${leverage}x).`),
        };
      }
    }

    const sizeUsd = collateral * leverage;
    const isLive = !context.simulationMode;

    // ── Trading Gate: Kill Switch ──
    const gate = getTradingGate();
    const killCheck = gate.checkKillSwitch();
    if (!killCheck.allowed) {
      logKillSwitchBlock(market, side);
      return { success: false, message: chalk.red(`  ${killCheck.reason}`) };
    }

    // ── Trading Gate: Exposure Check ──
    const exposureCheck = await gate.checkExposure(sizeUsd, context.flashClient);
    if (!exposureCheck.allowed) {
      logExposureBlock(market, side, sizeUsd, 0, gate.maxPortfolioExposure);
      return { success: false, message: chalk.red(`  ${exposureCheck.reason}`) };
    }

    // ── Circuit Breaker ──
    const breaker = getCircuitBreaker();
    const breakerCheck = breaker.check();
    if (!breakerCheck.allowed) {
      logCircuitBreakerBlock(market, side, breakerCheck.reason ?? 'unknown');
      return { success: false, message: chalk.red(`  ${breakerCheck.reason}`) };
    }

    const guard = getSigningGuard();
    const walletAddr = context.walletAddress ?? 'unknown';

    // Fetch fee rate from CustodyAccount via Flash SDK (cached, 60s TTL)
    const perpClient = context.simulationMode
      ? null
      : ((context.flashClient as unknown as Record<string, unknown>).perpClient ?? null);
    let feeRates;
    try {
      feeRates = await getProtocolFeeRates(market, perpClient);
    } catch (err) {
      if (err instanceof ProtocolParameterError) {
        return {
          success: false,
          message: [
            '',
            chalk.red(`  Protocol parameter error detected for ${market}`),
            chalk.red('  CustodyAccount data invalid or RPC corrupted.'),
            chalk.red('  Please verify RPC integrity.'),
            chalk.dim(`  Detail: ${err.message}`),
            '',
          ].join('\n'),
        };
      }
      throw err;
    }
    const estimatedFeeRate = feeRates.openFeeRate;
    const estimatedFee = calcFeeUsd(sizeUsd, estimatedFeeRate);

    // ── Signing Guard: Trade Limit Check ──
    const limitCheck = guard.checkTradeLimits({ collateral, leverage, sizeUsd, market });
    if (!limitCheck.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'open',
        market,
        side,
        collateral,
        leverage,
        sizeUsd,
        walletAddress: walletAddr,
        result: 'rejected',
        reason: limitCheck.reason,
      });
      return { success: false, message: chalk.red(`  Trade rejected: ${limitCheck.reason}`) };
    }

    // ── Signing Guard: Rate Limit Check ──
    const rateCheck = guard.checkRateLimit();
    if (!rateCheck.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'open',
        market,
        side,
        collateral,
        leverage,
        sizeUsd,
        walletAddress: walletAddr,
        result: 'rate_limited',
        reason: rateCheck.reason,
      });
      return { success: false, message: chalk.red(`  ${rateCheck.reason}`) };
    }

    // ── Build Confirmation Summary ──
    const lines = [
      '',
      isLive ? chalk.red.bold('  CONFIRM TRANSACTION') : chalk.yellow('  CONFIRM TRANSACTION'),
      chalk.dim('  ─────────────────────────────────'),
      `  Market:      ${chalk.bold(market)} ${colorSide(side)}`,
      `  Pool:        ${chalk.cyan(pool)}`,
      `  Leverage:    ${chalk.bold(leverage + 'x')}`,
      `  Collateral:  ${chalk.bold(formatUsd(collateral))} ${chalk.dim('USDC')}`,
      `  Size:        ${chalk.bold(formatUsd(sizeUsd))}`,
      `  Wallet:      ${chalk.dim(walletAddr)}`,
    ];

    // Fee breakdown: open fee + estimated close fee
    const estCloseFee = calcFeeUsd(sizeUsd, feeRates.closeFeeRate ?? estimatedFeeRate);
    if (Number.isFinite(estimatedFee) && Number.isFinite(estCloseFee)) {
      lines.push(
        `  Fees:        ${chalk.dim(`Open: $${estimatedFee.toFixed(4)} | Est. close: $${estCloseFee.toFixed(4)}`)}`,
      );
    } else {
      lines.push(
        `  Est. Fee:    ${chalk.dim('$' + estimatedFee.toFixed(4))}  ${chalk.dim(`(${(estimatedFeeRate * 100).toFixed(2)}%)`)}`,
      );
    }

    // Risk preview: entry estimate, liquidation estimate, distance, risk level, portfolio impact
    const riskLines = await buildRiskPreview(context, market, side, leverage, sizeUsd);
    lines.push(...riskLines);

    // Distance to liquidation (uses data from risk preview computation)
    try {
      const marketData = await context.flashClient.getMarketData(market);
      const md = marketData.find((m) => m.symbol.toUpperCase() === market.toUpperCase());
      if (md && Number.isFinite(md.price) && md.price > 0) {
        const perpClient = context.simulationMode
          ? null
          : ((context.flashClient as unknown as Record<string, unknown>).perpClient ?? null);
        const liqEst = await estimateLiqPrice(md.price, leverage, side, market, perpClient);
        if (Number.isFinite(liqEst) && liqEst > 0) {
          const distToLiq = (Math.abs(md.price - liqEst) / md.price) * 100;
          if (Number.isFinite(distToLiq)) {
            const distColor = distToLiq < 10 ? chalk.red : distToLiq < 30 ? chalk.yellow : chalk.green;
            lines.push(
              `  Liq Distance: ${distColor(distToLiq.toFixed(1) + '%')} ${chalk.dim(`(${formatPrice(Math.abs(md.price - liqEst))} from entry)`)}`,
            );
          }
        }
      }
    } catch {
      // Best effort — don't block trade if liq distance calc fails
    }

    // Show configured limits
    const limits = guard.limits;
    if (limits.maxCollateralPerTrade > 0 || limits.maxPositionSize > 0 || limits.maxLeverage > 0) {
      lines.push('');
      lines.push(chalk.dim('  Limits:'));
      if (limits.maxCollateralPerTrade > 0)
        lines.push(chalk.dim(`    Max Collateral: ${formatUsd(limits.maxCollateralPerTrade)}`));
      if (limits.maxPositionSize > 0) lines.push(chalk.dim(`    Max Position:   ${formatUsd(limits.maxPositionSize)}`));
      if (limits.maxLeverage > 0) lines.push(chalk.dim(`    Max Leverage:   ${limits.maxLeverage}x`));
    }

    // Show TP/SL targets in confirmation summary if provided inline
    if (takeProfit !== undefined || stopLoss !== undefined) {
      lines.push('');
      if (takeProfit !== undefined) lines.push(`  Take Profit: ${chalk.green('$' + takeProfit.toFixed(2))}`);
      if (stopLoss !== undefined) lines.push(`  Stop Loss:   ${chalk.red('$' + stopLoss.toFixed(2))}`);
    }

    if (isLive) {
      const warnings = buildLiveTradeWarnings(market, leverage, collateral);
      if (warnings.length > 0) {
        lines.push('');
        for (const w of warnings) {
          lines.push(`  ${chalk.yellow('!')} ${chalk.yellow(w)}`);
        }
      }
      lines.push('');
      lines.push(chalk.red('  This will execute a REAL on-chain transaction.'));
    }

    lines.push('');

    return {
      success: true,
      message: lines.join('\n'),
      requiresConfirmation: true,
      confirmationPrompt: isLive ? 'Type "yes" to sign or "no" to cancel' : 'Execute trade?',
      data: {
        executeAction: async (): Promise<ToolResult> => {
          logTradeStart('open', market, side, { collateral, leverage, sizeUsd });
          // Journal: record pending BEFORE broadcast
          const journal = getTradeJournal();
          const journalId = journal.recordPending({
            market,
            side: side.toString(),
            action: 'open',
            collateral,
            leverage,
            sizeUsd,
          });
          try {
            // Use atomic method when TP/SL are provided (single transaction)
            const useAtomic =
              (takeProfit !== undefined || stopLoss !== undefined) &&
              context.flashClient.openPositionAtomic &&
              !context.simulationMode;

            const result = useAtomic
              ? await context.flashClient.openPositionAtomic!(
                  market,
                  side,
                  collateral,
                  leverage,
                  collateral_token,
                  takeProfit,
                  stopLoss,
                )
              : await context.flashClient.openPosition(market, side, collateral, leverage, collateral_token);

            // Journal: mark confirmed and remove
            journal.recordSent(journalId, result.txSignature);
            journal.recordConfirmed(journalId);
            journal.remove(journalId);

            // Record trade open in circuit breaker
            getCircuitBreaker().recordOpen();

            // Record signing AFTER successful confirmation (not before)
            guard.recordSigning();

            // Audit log — successful
            guard.logAudit({
              timestamp: new Date().toISOString(),
              type: 'open',
              market,
              side,
              collateral,
              leverage,
              sizeUsd,
              walletAddress: walletAddr,
              result: 'confirmed',
            });

            const txLink = context.simulationMode ? result.txSignature : `https://solscan.io/tx/${result.txSignature}`;

            // Liquidation price from SDK (protocol math)
            const liqPrice = result.liquidationPrice ?? 0;

            // Fee from protocol — use pre-trade estimate (actual fee captured in position.totalFees)
            const executionFee = sizeUsd * estimatedFeeRate;

            // Log session trade (store openFeePaid for fee visibility)
            if (context.sessionTrades) {
              // Cap session trades to prevent unbounded memory growth in long sessions
              if (context.sessionTrades.length >= 500) context.sessionTrades.shift();
              context.sessionTrades.push({
                action: 'open',
                market,
                side,
                leverage,
                collateral,
                sizeUsd: result.sizeUsd,
                entryPrice: result.entryPrice,
                openFeePaid: executionFee,
                txSignature: result.txSignature,
                timestamp: Date.now(),
              });
            }

            // Re-read position from protocol for actual on-chain values
            let actualSize = result.sizeUsd;
            let actualCollateral = collateral;
            let actualLiq = liqPrice;
            if (!context.simulationMode) {
              try {
                const freshPositions = await context.flashClient.getPositions();
                const pos = freshPositions.find((p) => (p.market ?? '').toUpperCase() === market.toUpperCase() && p.side === side);
                if (pos) {
                  actualSize = pos.sizeUsd;
                  actualCollateral = pos.collateralUsd;
                  actualLiq = pos.liquidationPrice;
                }
              } catch {
                // Non-critical: fall back to SDK response values
              }
            }

            logTradeSuccess('open', market, side, {
              txSignature: result.txSignature,
              entryPrice: result.entryPrice,
              sizeUsd: actualSize,
            });

            // Shadow trade — fire-and-forget, completely isolated
            try {
              const shadowResult = await getShadowEngine().shadowOpen(market, side, collateral, leverage);
              if (shadowResult) logShadowTrade(shadowResult);
            } catch {
              /* shadow must never affect live pipeline */
            }

            // TP/SL display lines
            const tpSlLines: string[] = [];
            const atomicIncluded = (result as unknown as Record<string, unknown>).triggerOrdersIncluded === true;

            if (atomicIncluded) {
              // TP/SL were included in the atomic transaction
              if (takeProfit !== undefined) {
                tpSlLines.push(
                  `  Take Profit:       ${chalk.green('$' + takeProfit.toFixed(2))} ${chalk.dim('(on-chain, atomic)')}`,
                );
              }
              if (stopLoss !== undefined) {
                tpSlLines.push(
                  `  Stop Loss:         ${chalk.red('$' + stopLoss.toFixed(2))} ${chalk.dim('(on-chain, atomic)')}`,
                );
              }
            } else if (takeProfit !== undefined || stopLoss !== undefined) {
              // Sequential fallback — place TP/SL as separate transactions
              const client = context.flashClient;
              if (client.placeTriggerOrder && !context.simulationMode) {
                if (takeProfit !== undefined) {
                  try {
                    await client.placeTriggerOrder(market, side, takeProfit, false);
                    tpSlLines.push(
                      `  Take Profit:       ${chalk.green('$' + takeProfit.toFixed(2))} ${chalk.dim('(on-chain)')}`,
                    );
                  } catch {
                    /* TP is non-critical */
                  }
                }
                if (stopLoss !== undefined) {
                  try {
                    await client.placeTriggerOrder(market, side, stopLoss, true);
                    tpSlLines.push(
                      `  Stop Loss:         ${chalk.red('$' + stopLoss.toFixed(2))} ${chalk.dim('(on-chain)')}`,
                    );
                  } catch {
                    /* SL is non-critical */
                  }
                }
              }
            }

            return {
              success: true,
              message: [
                '',
                chalk.green('  Position Opened'),
                chalk.dim('  ─────────────────'),
                `  Entry Price:       ${formatPrice(result.entryPrice)}`,
                `  Size:              ${formatUsd(actualSize)}`,
                `  Collateral:        ${formatUsd(actualCollateral)}`,
                `  Liquidation Price: ${actualLiq && actualLiq > 0 ? chalk.yellow(formatPrice(actualLiq)) : chalk.dim('N/A')}`,
                `  Est. Fee:          ${chalk.dim('$' + executionFee.toFixed(4))}`,
                ...tpSlLines,
                `  TX: ${chalk.dim(txLink)}`,
                '',
              ].join('\n'),
              txSignature: result.txSignature,
            };
          } catch (error: unknown) {
            // Journal: remove on failure (trade did not land)
            journal.remove(journalId);
            logTradeFailure('open', market, side, getErrorMessage(error));
            // Audit log — failed
            guard.logAudit({
              timestamp: new Date().toISOString(),
              type: 'open',
              market,
              side,
              collateral,
              leverage,
              sizeUsd,
              walletAddress: walletAddr,
              result: 'failed',
              reason: getErrorMessage(error),
            });
            return {
              success: false,
              message: `  Failed to open position: ${humanizeSdkError(scrubErrorMsg(getErrorMessage(error)), collateral, leverage)}`,
            };
          }
        },
      },
    };
  },
};

// ─── flash_close_position ────────────────────────────────────────────────────

export const flashClosePosition: ToolDefinition = {
  name: 'flash_close_position',
  description: 'Close an existing trading position (full or partial)',
  parameters: z.object({
    market: z.string(),
    side: z.nativeEnum(TradeSide),
    closePercent: z.number().min(1).max(100).optional(),
    closeAmount: z.number().positive().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { market, side, closePercent, closeAmount } = params as {
      market: string;
      side: TradeSide;
      closePercent?: number;
      closeAmount?: number;
    };

    if (closePercent !== undefined && (!Number.isFinite(closePercent) || closePercent < 1 || closePercent > 100)) {
      return { success: false, message: chalk.red('  Invalid close percentage. Must be 1-100.') };
    }
    if (closeAmount !== undefined && (!Number.isFinite(closeAmount) || closeAmount <= 0)) {
      return { success: false, message: chalk.red('  Invalid close amount. Must be positive.') };
    }

    const validationError = validateLiveTradeContext(context);
    if (validationError) {
      return { success: false, message: chalk.red(`  ${validationError}`) };
    }

    const { getPoolForMarket } = await import('../config/index.js');
    const pool = getPoolForMarket(market);
    if (!pool) {
      return { success: false, message: chalk.red(`  Market not supported on Flash Trade: ${market}`) };
    }

    // Check if virtual market is currently open
    const { getMarketStatus, formatMarketClosedMessage } = await import('../data/market-hours.js');
    const mktStatus = getMarketStatus(market);
    if (!mktStatus.isOpen) {
      return { success: false, message: chalk.yellow(formatMarketClosedMessage(market)) };
    }

    const isLive = !context.simulationMode;

    // ── Trading Gate: Kill Switch ──
    const gate = getTradingGate();
    const killCheck = gate.checkKillSwitch();
    if (!killCheck.allowed) {
      logKillSwitchBlock(market, side);
      return { success: false, message: chalk.red(`  ${killCheck.reason}`) };
    }

    // ── Circuit Breaker ──
    const breaker = getCircuitBreaker();
    const breakerCheck = breaker.check();
    if (!breakerCheck.allowed) {
      logCircuitBreakerBlock(market, side, breakerCheck.reason ?? 'unknown');
      return { success: false, message: chalk.red(`  ${breakerCheck.reason}`) };
    }

    const guard = getSigningGuard();
    const walletAddr = context.walletAddress ?? 'unknown';

    // Rate limit check
    const rateCheck = guard.checkRateLimit();
    if (!rateCheck.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'close',
        market,
        side,
        walletAddress: walletAddr,
        result: 'rate_limited',
        reason: rateCheck.reason,
      });
      return { success: false, message: chalk.red(`  ${rateCheck.reason}`) };
    }

    // Pre-check: verify position exists and validate partial close
    try {
      const positions = await context.flashClient.getPositions();
      const pos = positions.find((p) => (p.market ?? '').toUpperCase() === market.toUpperCase() && p.side === side);
      if (!pos) {
        return { success: false, message: chalk.red(`  No open ${side} position on ${market}.`) };
      }
      const positionSizeUsd = pos.sizeUsd;

      // Validate partial close amount
      if (closePercent !== undefined) {
        if (closePercent > 100) {
          return { success: false, message: chalk.red(`  Close percentage cannot exceed 100%.`) };
        }
      }
      if (closeAmount !== undefined && closeAmount > positionSizeUsd) {
        return {
          success: false,
          message: chalk.red(
            `  Close amount $${closeAmount.toFixed(2)} exceeds position size $${positionSizeUsd.toFixed(2)}.`,
          ),
        };
      }
    } catch {
      // Non-critical: let the close attempt handle the error
    }

    // Build close description
    const isPartialClose = (closePercent !== undefined && closePercent < 100) || closeAmount !== undefined;
    let closeDesc = 'Full Close';
    if (closePercent !== undefined && closePercent < 100) {
      closeDesc = `Partial Close — ${closePercent}%`;
    } else if (closeAmount !== undefined) {
      closeDesc = `Partial Close — $${closeAmount.toFixed(2)}`;
    }

    // Position details for close confirmation
    const posLines = await buildPositionPreview(context, market, side);
    const titleLabel = isPartialClose ? 'Partial Close Position' : 'Close Position';
    const closeLines = [
      '',
      isLive
        ? chalk.red.bold(`  CONFIRM TRANSACTION — ${titleLabel}`)
        : chalk.yellow(`  CONFIRM TRANSACTION — ${titleLabel}`),
      chalk.dim('  ─────────────────────────────────'),
      `  Market:      ${chalk.bold(market)} ${colorSide(side)}`,
      `  Pool:        ${chalk.cyan(pool)}`,
      `  Action:      ${chalk.bold(closeDesc)}`,
      ...posLines,
      `  Wallet:      ${chalk.dim(walletAddr)}`,
      isLive ? `\n${chalk.red('  This will execute a REAL on-chain transaction.')}` : '',
      '',
    ];

    return {
      success: true,
      message: closeLines.join('\n'),
      requiresConfirmation: true,
      confirmationPrompt: isLive ? 'Type "yes" to sign or "no" to cancel' : 'Confirm close?',
      data: {
        executeAction: async (): Promise<ToolResult> => {
          logTradeStart('close', market, side);
          const journal = getTradeJournal();
          const journalId = journal.recordPending({ market, side: side.toString(), action: 'close' });
          try {
            const result = await context.flashClient.closePosition(market, side, undefined, closePercent, closeAmount);

            // Journal: confirmed
            journal.recordSent(journalId, result.txSignature);
            journal.recordConfirmed(journalId);
            journal.remove(journalId);

            // Record PnL in circuit breaker
            if (Number.isFinite(result.pnl)) {
              getCircuitBreaker().recordTrade(result.pnl);
            }

            guard.recordSigning();
            guard.logAudit({
              timestamp: new Date().toISOString(),
              type: result.isPartial ? 'partial_close' : 'close',
              market,
              side,
              walletAddress: walletAddr,
              result: 'confirmed',
            });

            // Log session trade
            if (context.sessionTrades) {
              if (context.sessionTrades.length >= 500) context.sessionTrades.shift();
              context.sessionTrades.push({
                action: result.isPartial ? 'partial_close' : 'close',
                market,
                side,
                exitPrice: result.exitPrice,
                pnl: result.pnl,
                txSignature: result.txSignature,
                timestamp: Date.now(),
              });
            }

            const pnlStr = result.pnl !== undefined ? `  PnL: ${colorPnl(result.pnl)}\n` : '';
            const txLink = context.simulationMode ? result.txSignature : `https://solscan.io/tx/${result.txSignature}`;
            const tradeType = result.isPartial ? 'partial_close' : 'close';
            logTradeSuccess(tradeType, market, side, {
              txSignature: result.txSignature,
              exitPrice: result.exitPrice,
              pnl: result.pnl,
            });

            // Shadow trade — fire-and-forget, completely isolated
            if (!result.isPartial) {
              try {
                const shadowResult = await getShadowEngine().shadowClose(market, side);
                if (shadowResult) logShadowTrade(shadowResult);
              } catch {
                /* shadow must never affect live pipeline */
              }
            }

            // Build output message
            const outputLines = [''];
            if (result.isPartial) {
              outputLines.push(chalk.green('  Partial Close Executed'));
              outputLines.push(chalk.dim('  ─────────────────'));
              outputLines.push(`  Market:            ${chalk.bold(market)} ${colorSide(side)}`);
              outputLines.push(`  Closed:            ${formatUsd(result.closedSizeUsd ?? 0)}`);
              outputLines.push(`  Remaining:         ${formatUsd(result.remainingSizeUsd ?? 0)}`);
              outputLines.push(`  Exit Price:        ${formatPrice(result.exitPrice)}`);
              if (pnlStr) outputLines.push(pnlStr.trimEnd());
              outputLines.push(`  TX: ${chalk.dim(txLink)}`);
            } else {
              outputLines.push(chalk.green('  Position Closed'));
              outputLines.push(chalk.dim('  ─────────────────'));
              outputLines.push(`  Exit Price:        ${formatPrice(result.exitPrice)}`);
              if (pnlStr) outputLines.push(pnlStr.trimEnd());
              outputLines.push(`  TX: ${chalk.dim(txLink)}`);
            }
            outputLines.push('');

            return {
              success: true,
              message: outputLines.join('\n'),
              txSignature: result.txSignature,
            };
          } catch (error: unknown) {
            journal.remove(journalId);
            logTradeFailure('close', market, side, getErrorMessage(error));
            guard.logAudit({
              timestamp: new Date().toISOString(),
              type: 'close',
              market,
              side,
              walletAddress: walletAddr,
              result: 'failed',
              reason: getErrorMessage(error),
            });
            return { success: false, message: `  Failed to close position: ${humanizeSdkError(scrubErrorMsg(getErrorMessage(error)))}` };
          }
        },
      },
    };
  },
};

// ─── flash_add_collateral ────────────────────────────────────────────────────

export const flashAddCollateral: ToolDefinition = {
  name: 'flash_add_collateral',
  description: 'Add collateral to an existing position',
  parameters: z.object({
    market: z.string(),
    side: z.nativeEnum(TradeSide),
    amount: z.number().positive().max(10_000_000),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { market, side, amount } = params as { market: string; side: TradeSide; amount: number };

    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: chalk.red('  Amount must be a positive number.') };
    }

    const validationError = validateLiveTradeContext(context);
    if (validationError) {
      return { success: false, message: chalk.red(`  ${validationError}`) };
    }

    const { getPoolForMarket } = await import('../config/index.js');
    const pool = getPoolForMarket(market);
    if (!pool) {
      return { success: false, message: chalk.red(`  Market not supported on Flash Trade: ${market}`) };
    }

    // Check if virtual market is currently open
    const { getMarketStatus, formatMarketClosedMessage } = await import('../data/market-hours.js');
    const mktStatus = getMarketStatus(market);
    if (!mktStatus.isOpen) {
      return { success: false, message: chalk.yellow(formatMarketClosedMessage(market)) };
    }

    const isLive = !context.simulationMode;

    // ── Trading Gate: Kill Switch ──
    const gate = getTradingGate();
    const killCheck = gate.checkKillSwitch();
    if (!killCheck.allowed) {
      logKillSwitchBlock(market, side);
      return { success: false, message: chalk.red(`  ${killCheck.reason}`) };
    }

    // ── Circuit Breaker ──
    const breaker = getCircuitBreaker();
    const breakerCheck = breaker.check();
    if (!breakerCheck.allowed) {
      logCircuitBreakerBlock(market, side, breakerCheck.reason ?? 'unknown');
      return { success: false, message: chalk.red(`  ${breakerCheck.reason}`) };
    }

    const guard = getSigningGuard();
    const walletAddr = context.walletAddress ?? 'unknown';

    const rateCheck = guard.checkRateLimit();
    if (!rateCheck.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'add_collateral',
        market,
        side,
        collateral: amount,
        walletAddress: walletAddr,
        result: 'rate_limited',
        reason: rateCheck.reason,
      });
      return { success: false, message: chalk.red(`  ${rateCheck.reason}`) };
    }

    // Pre-check: verify position exists before showing confirmation
    try {
      const positions = await context.flashClient.getPositions();
      const exists = positions.some((p) => (p.market ?? '').toUpperCase() === market.toUpperCase() && p.side === side);
      if (!exists) {
        return { success: false, message: chalk.red(`  No open ${side} position on ${market}.`) };
      }
    } catch {
      // Non-critical: let the add attempt handle the error
    }

    const addPosLines = await buildPositionPreview(context, market, side);
    return {
      success: true,
      message: [
        '',
        isLive
          ? chalk.red.bold('  CONFIRM TRANSACTION — Add Collateral')
          : chalk.yellow('  CONFIRM TRANSACTION — Add Collateral'),
        chalk.dim('  ─────────────────────────────────'),
        `  Market:      ${chalk.bold(market)} ${colorSide(side)}`,
        ...addPosLines,
        `  Add:         ${formatUsd(amount)} ${chalk.dim('USDC')}`,
        `  Wallet:      ${chalk.dim(walletAddr)}`,
        '',
      ].join('\n'),
      requiresConfirmation: true,
      confirmationPrompt: isLive ? 'Type "yes" to sign or "no" to cancel' : 'Confirm?',
      data: {
        executeAction: async (): Promise<ToolResult> => {
          const journal = getTradeJournal();
          const journalId = journal.recordPending({
            market,
            side: side.toString(),
            action: 'add_collateral',
            collateral: amount,
          });
          try {
            const result = await context.flashClient.addCollateral(market, side, amount);
            journal.recordSent(journalId, result.txSignature);
            journal.recordConfirmed(journalId);
            journal.remove(journalId);
            guard.recordSigning();
            guard.logAudit({
              timestamp: new Date().toISOString(),
              type: 'add_collateral',
              market,
              side,
              collateral: amount,
              walletAddress: walletAddr,
              result: 'confirmed',
            });
            // Log session trade
            if (context.sessionTrades) {
              // Cap session trades to prevent unbounded memory growth in long sessions
              if (context.sessionTrades.length >= 500) context.sessionTrades.shift();
              context.sessionTrades.push({
                action: 'add_collateral',
                market,
                side,
                collateral: amount,
                txSignature: result.txSignature,
                timestamp: Date.now(),
              });
            }

            // Shadow trade — fire-and-forget, completely isolated
            try {
              const shadowResult = await getShadowEngine().shadowAddCollateral(market, side, amount);
              if (shadowResult) logShadowTrade(shadowResult);
            } catch {
              /* shadow must never affect live pipeline */
            }

            const txDisplay = context.simulationMode
              ? result.txSignature
              : `https://solscan.io/tx/${result.txSignature}`;
            return {
              success: true,
              message: chalk.green(`  Collateral added. TX: ${chalk.dim(txDisplay)}`),
              txSignature: result.txSignature,
            };
          } catch (error: unknown) {
            journal.remove(journalId);
            guard.logAudit({
              timestamp: new Date().toISOString(),
              type: 'add_collateral',
              market,
              side,
              collateral: amount,
              walletAddress: walletAddr,
              result: 'failed',
              reason: getErrorMessage(error),
            });
            return { success: false, message: `  Failed to add collateral: ${humanizeSdkError(scrubErrorMsg(getErrorMessage(error)), amount)}` };
          }
        },
      },
    };
  },
};

// ─── flash_remove_collateral ─────────────────────────────────────────────────

export const flashRemoveCollateral: ToolDefinition = {
  name: 'flash_remove_collateral',
  description: 'Remove collateral from an existing position',
  parameters: z.object({
    market: z.string(),
    side: z.nativeEnum(TradeSide),
    amount: z.number().positive().max(10_000_000),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { market, side, amount } = params as { market: string; side: TradeSide; amount: number };

    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: chalk.red('  Amount must be a positive number.') };
    }

    const validationError = validateLiveTradeContext(context);
    if (validationError) {
      return { success: false, message: chalk.red(`  ${validationError}`) };
    }

    const { getPoolForMarket } = await import('../config/index.js');
    const pool = getPoolForMarket(market);
    if (!pool) {
      return { success: false, message: chalk.red(`  Market not supported on Flash Trade: ${market}`) };
    }

    // Check if virtual market is currently open
    const { getMarketStatus, formatMarketClosedMessage } = await import('../data/market-hours.js');
    const mktStatus2 = getMarketStatus(market);
    if (!mktStatus2.isOpen) {
      return { success: false, message: chalk.yellow(formatMarketClosedMessage(market)) };
    }

    const isLive = !context.simulationMode;

    // ── Trading Gate: Kill Switch ──
    const gate = getTradingGate();
    const killCheck = gate.checkKillSwitch();
    if (!killCheck.allowed) {
      logKillSwitchBlock(market, side);
      return { success: false, message: chalk.red(`  ${killCheck.reason}`) };
    }

    // ── Circuit Breaker ──
    const breaker = getCircuitBreaker();
    const breakerCheck = breaker.check();
    if (!breakerCheck.allowed) {
      logCircuitBreakerBlock(market, side, breakerCheck.reason ?? 'unknown');
      return { success: false, message: chalk.red(`  ${breakerCheck.reason}`) };
    }

    const guard = getSigningGuard();
    const walletAddr = context.walletAddress ?? 'unknown';

    const rateCheck = guard.checkRateLimit();
    if (!rateCheck.allowed) {
      guard.logAudit({
        timestamp: new Date().toISOString(),
        type: 'remove_collateral',
        market,
        side,
        collateral: amount,
        walletAddress: walletAddr,
        result: 'rate_limited',
        reason: rateCheck.reason,
      });
      return { success: false, message: chalk.red(`  ${rateCheck.reason}`) };
    }

    // Pre-check: verify position exists before showing confirmation
    try {
      const positions = await context.flashClient.getPositions();
      const pos = positions.find((p) => (p.market ?? '').toUpperCase() === market.toUpperCase() && p.side === side);
      if (!pos) {
        return { success: false, message: chalk.red(`  No open ${side} position on ${market}.`) };
      }
      // Check if remove amount exceeds collateral
      if (pos.collateralUsd && amount >= pos.collateralUsd) {
        return {
          success: false,
          message: chalk.red(
            `  Cannot remove ${formatUsd(amount)} — position only has ${formatUsd(pos.collateralUsd)} collateral. Close position instead.`,
          ),
        };
      }
    } catch {
      // Non-critical: let the remove attempt handle the error
    }

    const rmPosLines = await buildPositionPreview(context, market, side);
    return {
      success: true,
      message: [
        '',
        isLive
          ? chalk.red.bold('  CONFIRM TRANSACTION — Remove Collateral')
          : chalk.yellow('  CONFIRM TRANSACTION — Remove Collateral'),
        chalk.dim('  ─────────────────────────────────'),
        `  Market:      ${chalk.bold(market)} ${colorSide(side)}`,
        ...rmPosLines,
        `  Remove:      ${formatUsd(amount)}`,
        `  Wallet:      ${chalk.dim(walletAddr)}`,
        '',
      ].join('\n'),
      requiresConfirmation: true,
      confirmationPrompt: isLive ? 'Type "yes" to sign or "no" to cancel' : 'Confirm?',
      data: {
        executeAction: async (): Promise<ToolResult> => {
          const journal = getTradeJournal();
          const journalId = journal.recordPending({
            market,
            side: side.toString(),
            action: 'remove_collateral',
            collateral: amount,
          });
          try {
            const result = await context.flashClient.removeCollateral(market, side, amount);
            journal.recordSent(journalId, result.txSignature);
            journal.recordConfirmed(journalId);
            journal.remove(journalId);
            guard.recordSigning();
            guard.logAudit({
              timestamp: new Date().toISOString(),
              type: 'remove_collateral',
              market,
              side,
              collateral: amount,
              walletAddress: walletAddr,
              result: 'confirmed',
            });

            // Log session trade
            if (context.sessionTrades) {
              // Cap session trades to prevent unbounded memory growth in long sessions
              if (context.sessionTrades.length >= 500) context.sessionTrades.shift();
              context.sessionTrades.push({
                action: 'remove_collateral',
                market,
                side,
                collateral: amount,
                txSignature: result.txSignature,
                timestamp: Date.now(),
              });
            }

            // Shadow trade — fire-and-forget, completely isolated
            try {
              const shadowResult = await getShadowEngine().shadowRemoveCollateral(market, side, amount);
              if (shadowResult) logShadowTrade(shadowResult);
            } catch {
              /* shadow must never affect live pipeline */
            }

            const txDisplay = context.simulationMode
              ? result.txSignature
              : `https://solscan.io/tx/${result.txSignature}`;
            return {
              success: true,
              message: chalk.green(`  Collateral removed. TX: ${chalk.dim(txDisplay)}`),
              txSignature: result.txSignature,
            };
          } catch (error: unknown) {
            journal.remove(journalId);
            guard.logAudit({
              timestamp: new Date().toISOString(),
              type: 'remove_collateral',
              market,
              side,
              collateral: amount,
              walletAddress: walletAddr,
              result: 'failed',
              reason: getErrorMessage(error),
            });
            return { success: false, message: `  Failed to remove collateral: ${humanizeSdkError(scrubErrorMsg(getErrorMessage(error)), amount)}` };
          }
        },
      },
    };
  },
};

// ─── flash_get_positions ─────────────────────────────────────────────────────

export const flashGetPositions: ToolDefinition = {
  name: 'flash_get_positions',
  description: 'Get all open positions',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const rawPositions = await context.flashClient.getPositions();
    const positions = filterValidPositions(rawPositions);
    if (positions.length === 0) {
      return { success: true, message: theme.dim('\n  No open positions.\n') };
    }

    // Build fee lookup from session trades for fee visibility
    // (protocol settles open fees immediately, so on-chain unsettledFees may read 0)
    const sessionFeeLookup = new Map<string, number>();
    if (context.sessionTrades) {
      for (const t of context.sessionTrades) {
        if (t.action === 'open' && t.openFeePaid && t.openFeePaid > 0) {
          sessionFeeLookup.set(`${t.market}:${t.side}`, t.openFeePaid);
        }
      }
    }

    const headers = ['Market', 'Side', 'Lev', 'Size', 'Collateral', 'Entry', 'Mark', 'PnL', 'Fees', 'Liq'];
    const rows = positions.map((p: Position) => {
      const pnlSign = p.unrealizedPnl >= 0 ? '+' : '';
      const liqDist =
        p.markPrice > 0 && p.liquidationPrice > 0
          ? Math.abs((p.markPrice - p.liquidationPrice) / p.markPrice) * 100
          : 0;
      const liqStr =
        p.liquidationPrice > 0
          ? `${formatPrice(p.liquidationPrice)} ${theme.dim(`(${liqDist.toFixed(1)}%)`)}`
          : theme.dim('—');
      // Total fees = on-chain unsettled fees + session-tracked open fee
      const sessionFee = sessionFeeLookup.get(`${p.market}:${p.side}`) ?? 0;
      const displayFees = p.totalFees > 0 ? p.totalFees : sessionFee;
      return [
        chalk.bold(p.market),
        colorSide(p.side),
        `${p.leverage.toFixed(1)}x`,
        formatUsd(p.sizeUsd),
        formatUsd(p.collateralUsd),
        formatPrice(p.entryPrice),
        formatPrice(p.markPrice),
        `${pnlSign}${colorPnl(p.unrealizedPnl)} ${theme.dim(`(${colorPercent(p.unrealizedPnlPercent)})`)}`,
        formatUsd(displayFees),
        liqStr,
      ];
    });

    const totalPnl = positions.reduce((s: number, p: Position) => s + p.unrealizedPnl, 0);
    const totalExposure = positions.reduce((s: number, p: Position) => s + p.sizeUsd, 0);

    return {
      success: true,
      message: [
        theme.titleBlock('POSITIONS'),
        '',
        formatTable(headers, rows),
        '',
        `  ${theme.dim('Total PnL:')} ${colorPnl(totalPnl)}  ${theme.dim('|  Exposure:')} ${formatUsd(totalExposure)}  ${theme.dim('|  Open:')} ${positions.length}`,
        '',
      ].join('\n'),
      data: { positions },
    };
  },
};

// ─── flash_get_market_data ───────────────────────────────────────────────────

export const flashGetMarketData: ToolDefinition = {
  name: 'flash_get_market_data',
  description: 'Get market prices and data',
  parameters: z.object({
    market: z.string().optional(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { market: rawMarket } = params as { market?: string };
    const market = rawMarket ? resolveMarket(rawMarket) : undefined;
    const markets = await context.flashClient.getMarketData(market);
    if (markets.length === 0) {
      return { success: true, message: theme.dim('\n  Market data unavailable. Try again later.\n') };
    }

    // Enrich with fstats OI data and Pyth 24h change
    try {
      const { PriceService } = await import('../data/prices.js');
      const priceSvc = new PriceService();
      const [oi, pythPrices] = await Promise.all([
        context.dataClient.getOpenInterest().catch(() => ({ markets: [] as MarketOI[] })),
        priceSvc.getPrices(markets.map((m) => m.symbol)).catch(() => new Map()),
      ]);
      for (const m of markets) {
        const oiData = oi.markets.find((o: MarketOI) => o.market.includes(m.symbol));
        if (oiData) {
          m.openInterestLong = oiData.longOi;
          m.openInterestShort = oiData.shortOi;
        }
        const pythPrice = pythPrices.get(m.symbol);
        if (pythPrice && m.priceChange24h === 0) {
          m.priceChange24h = pythPrice.priceChange24h;
        }
      }
    } catch {
      /* ignore enrichment errors */
    }

    const headers = ['Market', 'Price', '24h Change', 'OI Long', 'OI Short', 'Max Lev'];
    const rows = markets.map((m: MarketData) => [
      chalk.bold(m.symbol),
      formatPrice(m.price),
      colorPercent(m.priceChange24h),
      formatUsd(m.openInterestLong),
      formatUsd(m.openInterestShort),
      `${m.maxLeverage}x`,
    ]);

    return {
      success: true,
      message: [theme.titleBlock('MARKET DATA'), '', formatTable(headers, rows), ''].join('\n'),
      data: { markets },
    };
  },
};

// ─── flash_get_portfolio ─────────────────────────────────────────────────────

export const flashGetPortfolio: ToolDefinition = {
  name: 'flash_get_portfolio',
  description: 'Get portfolio overview',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    const portfolio = await context.flashClient.getPortfolio();

    // Compute directional bias
    let longExposure = 0;
    let shortExposure = 0;
    for (const p of portfolio.positions) {
      if (p.side === TradeSide.Long) longExposure += p.sizeUsd;
      else shortExposure += p.sizeUsd;
    }
    const totalExposure = longExposure + shortExposure;
    const longPct = totalExposure > 0 ? ((longExposure / totalExposure) * 100).toFixed(0) : '0';
    const shortPct = totalExposure > 0 ? ((shortExposure / totalExposure) * 100).toFixed(0) : '0';

    const lines = [
      theme.titleBlock('PORTFOLIO'),
      '',
      theme.pair('Positions', String(portfolio.positions.length)),
      theme.pair('Exposure', formatUsd(totalExposure)),
      '',
    ];

    if (portfolio.positions.length > 0) {
      lines.push(`  ${theme.section('Directional Bias')}`);
      lines.push(theme.pair('LONG', theme.positive(`${longPct}%`)));
      lines.push(theme.pair('SHORT', theme.negative(`${shortPct}%`)));
      lines.push('');
    }

    lines.push(
      `  ${portfolio.balanceLabel}`,
      portfolio.usdcBalance !== undefined
        ? theme.pair('USDC Available', theme.positive('$' + portfolio.usdcBalance.toFixed(2)))
        : '',
      theme.pair('Collateral', formatUsd(portfolio.totalCollateralUsd)),
      theme.pair('Unrealized PnL', colorPnl(portfolio.totalUnrealizedPnl)),
      theme.pair('Realized PnL', colorPnl(portfolio.totalRealizedPnl)),
      portfolio.totalFees > 0 ? theme.pair('Fees Paid', formatUsd(portfolio.totalFees)) : '',
      '',
    );

    return {
      success: true,
      message: lines.join('\n'),
      data: { portfolio },
    };
  },
};

// ─── Re-export tools from split modules ─────────────────────────────────────

import { allAnalyticsTools } from './analytics-tools.js';
import { allWalletTools } from './wallet-tools.js';
import { allProtocolTools } from './protocol-tools.js';
import { allOrderTools } from './order-tools.js';

// Re-export individual tools for backward compatibility
export {
  flashGetVolume,
  flashGetOpenInterest,
  flashGetLeaderboard,
  flashGetFees,
  flashGetTraderProfile,
} from './analytics-tools.js';
export {
  walletImport,
  walletList,
  walletUse,
  walletRemove,
  walletStatus,
  walletDisconnect,
  walletAddress,
  walletBalance,
  walletTokens,
  flashMarkets,
  walletConnect,
} from './wallet-tools.js';
export {
  inspectProtocol,
  inspectPool,
  inspectMarketTool,
  systemStatusTool,
  protocolStatusTool,
  rpcStatusTool,
  rpcTestTool,
  rpcListTool,
  txInspectTool,
  txDebugTool,
  tradeHistoryTool,
  liquidationMapTool,
  fundingDashboardTool,
  liquidityDepthTool,
  protocolHealthTool,
  systemAuditTool,
  txMetricsTool,
} from './protocol-tools.js';
export {
  flashCloseAll,
  setTpSlTool,
  removeTpSlTool,
  tpSlStatusTool,
  limitOrderPlaceTool,
  limitOrderCancelTool,
  limitOrderEditTool,
  limitOrderListTool,
} from './order-tools.js';

export const allFlashTools: ToolDefinition[] = [
  flashOpenPosition,
  flashClosePosition,
  flashAddCollateral,
  flashRemoveCollateral,
  flashGetPositions,
  flashGetMarketData,
  flashGetPortfolio,
  ...allAnalyticsTools,
  ...allWalletTools,
  ...allProtocolTools,
  ...allOrderTools,
];
