import chalk from 'chalk';
import { IFlashClient, Position, TradeSide } from '../types/index.js';
import { formatUsd, formatPrice, colorSide } from '../utils/format.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';
import { getScheduler } from '../core/scheduler.js';
import { TaskPriority } from '../core/runtime-state.js';
import { safeNumber } from '../utils/safe-math.js';
import { computeSimulationLiquidationPrice } from '../utils/protocol-liq.js';

// ─── Singleton Access ────────────────────────────────────────────────────────

let _instance: RiskMonitor | null = null;

/** Get or create the risk monitor singleton */
export function getRiskMonitor(client: IFlashClient): RiskMonitor {
  if (!_instance) {
    _instance = new RiskMonitor(client);
  } else {
    _instance.setClient(client);
  }
  return _instance;
}

/** Get the active risk monitor (if it exists) */
export function getActiveRiskMonitor(): RiskMonitor | null {
  return _instance;
}

// ─── Risk Levels ─────────────────────────────────────────────────────────────

export enum RiskLevel {
  Safe = 'SAFE',
  Warning = 'WARNING',
  Critical = 'CRITICAL',
}

// ─── Hysteresis Thresholds ───────────────────────────────────────────────────
// Upward thresholds (entering risk level) and recovery thresholds (exiting)
// prevent oscillation when distance hovers near a boundary.
const SAFE_ENTER = 0.3; // enters WARNING when distance < 30%
const SAFE_RECOVER = 0.35; // recovers to SAFE when distance > 35%
const WARNING_ENTER = 0.15; // enters CRITICAL when distance < 15%
const WARNING_RECOVER = 0.18; // recovers to WARNING when distance > 18%
const TARGET_SAFE_DISTANCE = 0.35; // collateral suggestion target

// Tiered refresh intervals
const PRICE_INTERVAL_MS = 5_000; // price/risk checks every 5s
const POSITION_INTERVAL_MS = 20_000; // full position refresh every 20s
const MAX_POSITION_STALE_MS = 120_000; // cached positions expire after 2 minutes

const BINARY_SEARCH_MAX_ITER = 20;
const BINARY_SEARCH_TOLERANCE = 0.005; // 0.5% tolerance for early break

// ─── Risk Assessment Per Position ────────────────────────────────────────────

export interface PositionRisk {
  market: string;
  side: TradeSide;
  leverage: number;
  entryPrice: number;
  currentPrice: number;
  liquidationPrice: number;
  collateralUsd: number;
  sizeUsd: number;
  distanceToLiquidation: number; // 0..1 ratio
  riskLevel: RiskLevel;
  suggestedCollateral: number; // extra $ to restore safe distance
}

export interface PortfolioRiskSnapshot {
  positions: PositionRisk[];
  totalExposure: number;
  leverageWeightedRisk: number;
  worstPosition: PositionRisk | null;
  timestamp: number;
}

// ─── Risk Monitor Engine ─────────────────────────────────────────────────────

export class RiskMonitor {
  private client: IFlashClient;
  private timer: ReturnType<typeof setInterval> | null = null;
  private _active = false;
  private lastSnapshot: PortfolioRiskSnapshot | null = null;
  /** Track last alert level per position to avoid spamming */
  private lastAlertLevel = new Map<string, RiskLevel>();
  /** Cached positions for tiered refresh */
  private cachedPositions: Position[] = [];
  private lastPositionFetch = 0;
  private tickCount = 0;
  private tickInProgress = false;
  private lastHeartbeat = 0;
  private static readonly HEARTBEAT_INTERVAL_MS = 60_000; // status output every 60s

  constructor(client: IFlashClient) {
    this.client = client;
  }

  get active(): boolean {
    return this._active;
  }

  get snapshot(): PortfolioRiskSnapshot | null {
    return this.lastSnapshot;
  }

  /** Update the client reference (e.g. after wallet reconnect) */
  setClient(client: IFlashClient): void {
    this.client = client;
  }

  start(): string {
    if (this._active) {
      return chalk.yellow('  Risk monitor is already running.');
    }
    this._active = true;
    this.lastAlertLevel.clear();
    this.cachedPositions = [];
    this.lastPositionFetch = 0;
    this.tickCount = 0;
    this.lastHeartbeat = 0;
    const tickFn = (): void => {
      this.tick().catch((err) => {
        getLogger().warn('RISK_MONITOR', `Tick error: ${getErrorMessage(err)}`);
      });
    };
    const scheduler = getScheduler();
    if (scheduler) {
      scheduler.register({
        name: 'risk-monitor-tick',
        fn: tickFn,
        baseIntervalMs: PRICE_INTERVAL_MS,
        priority: TaskPriority.NORMAL,
      });
    } else {
      this.timer = setInterval(tickFn, PRICE_INTERVAL_MS);
      this.timer.unref();
    }
    // Run first tick immediately
    this.tick().catch((err) => {
      getLogger().warn('RISK_MONITOR', `Initial tick error: ${getErrorMessage(err)}`);
    });
    return chalk.green('  Risk monitor started.') + chalk.dim(' (prices every 5s, positions every 20s)');
  }

  stop(): string {
    if (!this._active) {
      return chalk.yellow('  Risk monitor is not running.');
    }
    this._active = false;
    const scheduler = getScheduler();
    if (scheduler) scheduler.unregister('risk-monitor-tick');
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lastAlertLevel.clear();
    this.lastSnapshot = null;
    this.cachedPositions = [];
    this.lastPositionFetch = 0;
    return chalk.green('  Risk monitor stopped.');
  }

  // ─── Core Monitoring Tick ────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (!this._active || this.tickInProgress) return;
    this.tickInProgress = true;
    try {
      await this._tick();
    } finally {
      this.tickInProgress = false;
    }
  }

  private async _tick(): Promise<void> {
    const logger = getLogger();
    this.tickCount++;

    // Skip ticks when system is in CRITICAL state — reduce load during resource pressure
    try {
      const { getHealth } = await import('../system/health.js');
      const health = getHealth();
      if (health?.state === 'CRITICAL') {
        // Only run every 4th tick (20s instead of 5s) during CRITICAL
        if (this.tickCount % 4 !== 0) {
          logger.debug('RISK_MONITOR', 'Skipping tick — system CRITICAL');
          return;
        }
      }
    } catch { /* health not initialized */ }

    try {
      // Tiered refresh: full position fetch every POSITION_INTERVAL_MS, use cache otherwise
      const now = Date.now();
      const positionAge = now - this.lastPositionFetch;
      const needsFullRefresh = positionAge >= POSITION_INTERVAL_MS || this.cachedPositions.length === 0;
      let positions: Position[];

      if (needsFullRefresh) {
        try {
          positions = await this.client.getPositions();
          this.cachedPositions = positions;
          this.lastPositionFetch = now;
        } catch (fetchErr: unknown) {
          // If fetch fails and cached data is stale beyond the hard limit,
          // skip this tick entirely — don't assess risk with ancient data
          if (positionAge > MAX_POSITION_STALE_MS) {
            logger.warn(
              'RISK_MONITOR',
              `Position data stale (${Math.round(positionAge / 1000)}s) and refresh failed — skipping tick`,
            );
            return;
          }
          // Use cached data for now — it's still within the staleness window
          positions = this.cachedPositions;
          logger.debug(
            'RISK_MONITOR',
            `Position refresh failed, using cached data (${Math.round(positionAge / 1000)}s old): ${getErrorMessage(fetchErr)}`,
          );
        }
      } else {
        positions = this.cachedPositions;
      }

      // Auto-stop when no positions
      if (positions.length === 0) {
        if (this.lastSnapshot && this.lastSnapshot.positions.length > 0) {
          process.stdout.write(chalk.dim('\n  Risk monitor: no open positions, pausing.\n'));
        }
        this.lastSnapshot = {
          positions: [],
          totalExposure: 0,
          leverageWeightedRisk: 0,
          worstPosition: null,
          timestamp: Date.now(),
        };
        return;
      }

      // Skip positions with invalid numeric data
      const valid = positions.filter(
        (p) =>
          Number.isFinite(p.sizeUsd) &&
          p.sizeUsd > 0 &&
          Number.isFinite(p.collateralUsd) &&
          p.collateralUsd > 0 &&
          Number.isFinite(p.entryPrice) &&
          p.entryPrice > 0,
      );
      const assessed = await Promise.all(valid.map((p) => this.assessPosition(p)));
      const totalExposure = assessed.reduce((sum, r) => sum + r.sizeUsd, 0);

      // Leverage-weighted risk: sum(leverage * sizeWeight * (1 - distance))
      let leverageWeightedRisk = 0;
      if (totalExposure > 0) {
        for (const r of assessed) {
          const weight = r.sizeUsd / totalExposure;
          const riskFactor = 1 - r.distanceToLiquidation; // already clamped 0..1
          leverageWeightedRisk += r.leverage * weight * riskFactor;
        }
      }
      // Clamp to prevent NaN/Infinity propagation
      leverageWeightedRisk = safeNumber(leverageWeightedRisk, 0);

      const worstPosition = assessed.reduce<PositionRisk | null>((worst, r) => {
        if (!worst || r.distanceToLiquidation < worst.distanceToLiquidation) return r;
        return worst;
      }, null);

      this.lastSnapshot = {
        positions: assessed,
        totalExposure,
        leverageWeightedRisk,
        worstPosition,
        timestamp: Date.now(),
      };

      // Emit alerts for positions that changed risk level
      this.emitAlerts(assessed);

      // TP/SL and limit orders are now on-chain via Flash SDK.
      // No local evaluation needed — the protocol handles trigger execution.

      // Periodic heartbeat so user knows monitor is alive
      const now2 = Date.now();
      if (this.tickCount === 1 || now2 - this.lastHeartbeat >= RiskMonitor.HEARTBEAT_INTERVAL_MS) {
        this.lastHeartbeat = now2;
        const worstDist = worstPosition ? `${(worstPosition.distanceToLiquidation * 100).toFixed(0)}%` : '—';
        const overallLevel = assessed.some((r) => r.riskLevel === RiskLevel.Critical)
          ? chalk.red('CRITICAL')
          : assessed.some((r) => r.riskLevel === RiskLevel.Warning)
            ? chalk.yellow('WARNING')
            : chalk.green('SAFE');
        process.stdout.write(
          chalk.dim(`\n  [Risk Monitor] ${assessed.length} position(s) monitored | `) +
            `Risk: ${overallLevel}` +
            chalk.dim(` | Closest liq: ${worstDist}\n`),
        );
      }
    } catch (error: unknown) {
      logger.warn('RISK_MONITOR', `Tick failed: ${getErrorMessage(error)}`);
    }
  }

  // ─── Position Risk Assessment ────────────────────────────────────────

  private async assessPosition(pos: Position): Promise<PositionRisk> {
    const currentPrice = safeNumber(pos.markPrice > 0 ? pos.markPrice : pos.currentPrice, 0);
    const entryPrice = safeNumber(pos.entryPrice, 0);
    const liqPrice = safeNumber(pos.liquidationPrice, 0);
    const leverage = safeNumber(pos.leverage, 1);
    const collateralUsd = safeNumber(pos.collateralUsd, 0);
    const sizeUsd = safeNumber(pos.sizeUsd, 0);

    // Skip assessment if critical values are zero — cannot compute meaningful risk
    if (currentPrice <= 0 || entryPrice <= 0 || sizeUsd <= 0) {
      return {
        market: pos.market,
        side: pos.side,
        leverage,
        entryPrice,
        currentPrice,
        liquidationPrice: liqPrice,
        collateralUsd,
        sizeUsd,
        distanceToLiquidation: 1, // assume safe when data is missing
        riskLevel: RiskLevel.Safe,
        suggestedCollateral: 0,
      };
    }

    // Distance to liquidation: normalized by entry price (not liq price)
    // This gives a consistent percentage regardless of price direction
    let distance = 1; // default safe
    if (liqPrice > 0 && currentPrice > 0 && entryPrice > 0) {
      distance = Math.abs(currentPrice - liqPrice) / entryPrice;
    }
    distance = Math.min(Math.max(distance, 0), 1); // clamp 0..1

    // Hysteresis-aware risk level: use previous level to pick threshold
    const key = `${pos.market}:${pos.side}`;
    const prevLevel = this.lastAlertLevel.get(key) ?? RiskLevel.Safe;
    const riskLevel = this.classifyRiskWithHysteresis(distance, prevLevel);

    // Calculate collateral needed to restore safe distance
    const suggestedCollateral = await this.calcCollateralToRestore(pos, currentPrice, liqPrice);

    return {
      market: pos.market,
      side: pos.side,
      leverage,
      entryPrice,
      currentPrice,
      liquidationPrice: liqPrice,
      collateralUsd,
      sizeUsd,
      distanceToLiquidation: distance,
      riskLevel,
      suggestedCollateral,
    };
  }

  /**
   * Classify risk level with hysteresis to prevent oscillation.
   * Entering a worse level uses stricter thresholds, recovering uses looser ones.
   */
  private classifyRiskWithHysteresis(distance: number, prevLevel: RiskLevel): RiskLevel {
    switch (prevLevel) {
      case RiskLevel.Safe:
        // From SAFE: enter WARNING at < 30%, enter CRITICAL at < 15%
        if (distance < WARNING_ENTER) return RiskLevel.Critical;
        if (distance < SAFE_ENTER) return RiskLevel.Warning;
        return RiskLevel.Safe;

      case RiskLevel.Warning:
        // From WARNING: enter CRITICAL at < 15%, recover to SAFE at > 35%
        if (distance < WARNING_ENTER) return RiskLevel.Critical;
        if (distance > SAFE_RECOVER) return RiskLevel.Safe;
        return RiskLevel.Warning;

      case RiskLevel.Critical:
        // From CRITICAL: recover to WARNING at > 18%, recover to SAFE at > 35%
        if (distance > SAFE_RECOVER) return RiskLevel.Safe;
        if (distance > WARNING_RECOVER) return RiskLevel.Warning;
        return RiskLevel.Critical;

      default:
        return RiskLevel.Safe;
    }
  }

  /**
   * Estimate additional collateral needed to restore safe liquidation distance.
   * NOTE: Uses an approximation for the search. Actual liquidation prices
   * are computed by the Flash SDK using on-chain CustodyAccount parameters.
   * Adding collateral reduces effective leverage → moves liq price further.
   *
   * Simplified: newLeverage = sizeUsd / (collateral + extra)
   *   target distance: abs(currentPrice - newLiqPrice) / entryPrice >= TARGET_SAFE_DISTANCE
   */
  private async calcCollateralToRestore(pos: Position, currentPrice: number, liqPrice: number): Promise<number> {
    const entryPrice = safeNumber(pos.entryPrice, 0);
    const sizeUsd = safeNumber(pos.sizeUsd, 0);
    const collateralUsd = safeNumber(pos.collateralUsd, 0);

    if (liqPrice <= 0 || currentPrice <= 0 || entryPrice <= 0 || sizeUsd <= 0 || collateralUsd <= 0) return 0;

    // Use entryPrice as denominator (consistent with assessPosition)
    const currentDistance = Math.abs(currentPrice - liqPrice) / entryPrice;
    if (currentDistance >= TARGET_SAFE_DISTANCE) return 0; // already safe

    // Fetch protocol rates for this market
    const { getProtocolFeeRates } = await import('../utils/protocol-fees.js');
    const feeRates = await getProtocolFeeRates(pos.market, null);

    // Binary search for the right extra collateral
    let lo = 0;
    let hi = sizeUsd; // upper bound: full position size
    for (let i = 0; i < BINARY_SEARCH_MAX_ITER; i++) {
      const mid = (lo + hi) / 2;
      const newCollateral = collateralUsd + mid;
      // Use protocol-aligned liquidation formula with on-chain rates
      const newLiqPrice = computeSimulationLiquidationPrice(
        entryPrice,
        sizeUsd,
        newCollateral,
        pos.side,
        feeRates.maintenanceMarginRate,
        feeRates.closeFeeRate,
      );
      // Use entryPrice as denominator (consistent)
      const newDistance = Math.abs(currentPrice - newLiqPrice) / entryPrice;
      if (newDistance < TARGET_SAFE_DISTANCE) {
        lo = mid;
      } else {
        hi = mid;
      }
      // Early break when converged within tolerance
      if (Math.abs(hi - lo) < BINARY_SEARCH_TOLERANCE * sizeUsd) break;
    }
    const extra = Math.ceil(hi); // round up to nearest dollar
    return extra > 0 ? extra : 0;
  }

  // ─── Alert Emission ──────────────────────────────────────────────────

  private emitAlerts(positions: PositionRisk[]): void {
    // Collect current position keys to prune stale entries
    const currentKeys = new Set<string>();

    for (const r of positions) {
      const key = `${r.market}:${r.side}`;
      currentKeys.add(key);
      const prevLevel = this.lastAlertLevel.get(key);

      // Only emit if risk level worsened or is first check
      if (r.riskLevel === RiskLevel.Safe) {
        // Clear alert tracking if position recovered
        if (prevLevel && prevLevel !== RiskLevel.Safe) {
          process.stdout.write(
            chalk.green(
              `\n  ✓ ${r.market} ${r.side} recovered to safe distance (${(r.distanceToLiquidation * 100).toFixed(0)}%)\n`,
            ),
          );
        }
        this.lastAlertLevel.set(key, RiskLevel.Safe);
        continue;
      }

      // Skip if same or better level than last alert
      if (prevLevel === r.riskLevel) continue;
      if (prevLevel === RiskLevel.Critical && r.riskLevel === RiskLevel.Warning) continue;

      this.lastAlertLevel.set(key, r.riskLevel);

      if (r.riskLevel === RiskLevel.Critical) {
        this.emitCriticalAlert(r);
      } else if (r.riskLevel === RiskLevel.Warning) {
        this.emitWarningAlert(r);
      }
    }

    // Prune stale entries for positions that no longer exist (closed/liquidated)
    for (const key of this.lastAlertLevel.keys()) {
      if (!currentKeys.has(key)) {
        this.lastAlertLevel.delete(key);
      }
    }
  }

  private emitWarningAlert(r: PositionRisk): void {
    const distPct = (r.distanceToLiquidation * 100).toFixed(0);
    const lines = [
      '',
      chalk.yellow.bold('  ⚠ RISK WARNING'),
      chalk.dim('  ─────────────────────────────────'),
      `  ${chalk.bold(r.market)} ${colorSide(r.side)} ${chalk.dim(r.leverage + 'x')}`,
      `  Entry:       ${formatPrice(r.entryPrice)}`,
      `  Current:     ${formatPrice(r.currentPrice)}`,
      `  Liquidation: ${formatPrice(r.liquidationPrice)}`,
      '',
      `  Distance to liquidation: ${chalk.yellow.bold(distPct + '%')}`,
    ];

    if (r.suggestedCollateral > 0) {
      lines.push('');
      lines.push(chalk.cyan(`  Add ${formatUsd(r.suggestedCollateral)} collateral to restore distance to 35%.`));
    }

    lines.push('');
    process.stdout.write(lines.join('\n') + '\n');
  }

  private emitCriticalAlert(r: PositionRisk): void {
    const distPct = (r.distanceToLiquidation * 100).toFixed(0);
    const lines = [
      '',
      chalk.red.bold('  🚨 CRITICAL LIQUIDATION RISK'),
      chalk.red('  ═════════════════════════════════'),
      `  ${chalk.bold(r.market)} ${colorSide(r.side)} ${chalk.dim(r.leverage + 'x')}`,
      `  Entry:       ${formatPrice(r.entryPrice)}`,
      `  Current:     ${formatPrice(r.currentPrice)}`,
      `  Liquidation: ${formatPrice(r.liquidationPrice)}`,
      '',
      `  Distance to liquidation: ${chalk.red.bold(distPct + '%')}`,
      '',
      chalk.red.bold('  Add collateral or reduce position immediately.'),
    ];

    if (r.suggestedCollateral > 0) {
      lines.push('');
      lines.push(chalk.cyan.bold(`  Add ${formatUsd(r.suggestedCollateral)} collateral to restore distance to 35%.`));
    }

    lines.push('');
    process.stdout.write(lines.join('\n') + '\n');
  }
}
