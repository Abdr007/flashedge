/**
 * Risk Checker — Flash SDK Example
 *
 * Portfolio risk analysis tool that:
 * 1. Fetches all open positions
 * 2. Calculates total exposure, concentration, leverage risk
 * 3. Generates a risk score and actionable alerts
 * 4. Optionally auto-reduces risky positions
 *
 * Usage:
 *   npx tsx examples/risk-checker.ts
 *   npx tsx examples/risk-checker.ts --auto-fix
 */

import { FlashSDK, FlashError, type Position } from '../src/sdk/index.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const MAX_SINGLE_POSITION_PCT = 40; // No single position > 40% of portfolio
const MAX_TOTAL_LEVERAGE = 5; // Portfolio-weighted average leverage cap
const MAX_TOTAL_EXPOSURE_USD = 5_000; // Total exposure cap
const AUTO_FIX = process.argv.includes('--auto-fix');

const flash = new FlashSDK({
  timeout: 15_000,
  env: { SIMULATION_MODE: 'true' },
});

// ─── Risk Analysis ───────────────────────────────────────────────────────────

interface RiskAlert {
  level: 'WARNING' | 'CRITICAL';
  message: string;
  position?: Position;
  action?: string;
}

function analyzeRisk(positions: Position[]): { score: number; alerts: RiskAlert[] } {
  const alerts: RiskAlert[] = [];

  if (positions.length === 0) {
    return { score: 100, alerts: [] };
  }

  const totalExposure = positions.reduce((sum, p) => sum + (p.sizeUsd ?? 0), 0);
  const totalCollateral = positions.reduce((sum, p) => sum + (p.collateralUsd ?? 0), 0);
  const avgLeverage = totalCollateral > 0 ? totalExposure / totalCollateral : 0;

  let score = 100;

  // Check total exposure
  if (totalExposure > MAX_TOTAL_EXPOSURE_USD) {
    const pctOver = ((totalExposure / MAX_TOTAL_EXPOSURE_USD - 1) * 100).toFixed(0);
    alerts.push({
      level: 'CRITICAL',
      message: `Total exposure $${totalExposure.toFixed(0)} exceeds limit $${MAX_TOTAL_EXPOSURE_USD} (+${pctOver}%)`,
      action: 'Reduce position sizes',
    });
    score -= 30;
  }

  // Check average leverage
  if (avgLeverage > MAX_TOTAL_LEVERAGE) {
    alerts.push({
      level: 'WARNING',
      message: `Average leverage ${avgLeverage.toFixed(1)}x exceeds ${MAX_TOTAL_LEVERAGE}x threshold`,
      action: 'Add collateral or close high-leverage positions',
    });
    score -= 15;
  }

  // Check concentration
  for (const pos of positions) {
    const posSize = pos.sizeUsd ?? 0;
    const posPercent = totalExposure > 0 ? (posSize / totalExposure) * 100 : 0;

    if (posPercent > MAX_SINGLE_POSITION_PCT) {
      alerts.push({
        level: 'WARNING',
        message: `${pos.market} ${pos.side} is ${posPercent.toFixed(0)}% of portfolio (limit: ${MAX_SINGLE_POSITION_PCT}%)`,
        position: pos,
        action: `Reduce ${pos.market} ${pos.side} position`,
      });
      score -= 10;
    }

    // Check liquidation proximity
    if (pos.liquidationPrice && pos.markPrice) {
      const distance = Math.abs(pos.markPrice - pos.liquidationPrice) / pos.markPrice * 100;
      if (distance < 10) {
        alerts.push({
          level: 'CRITICAL',
          message: `${pos.market} ${pos.side} is ${distance.toFixed(1)}% from liquidation`,
          position: pos,
          action: `Add collateral to ${pos.market} ${pos.side}`,
        });
        score -= 25;
      }
    }
  }

  return { score: Math.max(0, score), alerts };
}

// ─── Auto-Fix ────────────────────────────────────────────────────────────────

async function autoFix(alerts: RiskAlert[]): Promise<void> {
  const criticals = alerts.filter((a) => a.level === 'CRITICAL' && a.position);

  if (criticals.length === 0) {
    console.log('\n  No auto-fixable critical alerts.');
    return;
  }

  console.log(`\n  Auto-fixing ${criticals.length} critical alert(s)...`);

  for (const alert of criticals) {
    if (!alert.position) continue;
    const pos = alert.position;

    // Strategy: close 50% of the critical position to reduce risk
    console.log(`  Closing 50% of ${pos.market} ${pos.side}...`);
    try {
      await flash.close({ market: pos.market, side: pos.side, percent: 50 });
      console.log(`  Reduced ${pos.market} ${pos.side} by 50%`);
    } catch (error: unknown) {
      if (error instanceof FlashError) {
        console.error(`  Failed [${error.code}]: ${error.message}`);
      }
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Flash Risk Checker ===\n');

  // Fetch positions
  console.log('Fetching positions...');
  let positions: Position[];
  try {
    const response = await flash.positions();
    positions = response.data.positions ?? [];
  } catch (error: unknown) {
    if (error instanceof FlashError) {
      console.error(`Failed to fetch positions [${error.code}]: ${error.message}`);
    }
    return;
  }

  console.log(`Found ${positions.length} position(s)\n`);

  if (positions.length === 0) {
    console.log('No positions to analyze. Risk score: 100/100');
    return;
  }

  // Display positions
  console.log('POSITIONS:');
  const totalExposure = positions.reduce((sum, p) => sum + (p.sizeUsd ?? 0), 0);
  for (const pos of positions) {
    const pct = totalExposure > 0 ? ((pos.sizeUsd ?? 0) / totalExposure * 100).toFixed(0) : '0';
    console.log(
      `  ${pos.market.padEnd(6)} ${pos.side.padEnd(5)} ${pos.leverage}x | ` +
        `$${(pos.sizeUsd ?? 0).toFixed(0).padStart(6)} (${pct}% of portfolio)`,
    );
  }

  // Run analysis
  const { score, alerts } = analyzeRisk(positions);

  console.log(`\nRISK SCORE: ${score}/100 ${score >= 80 ? 'SAFE' : score >= 50 ? 'WARNING' : 'CRITICAL'}`);

  if (alerts.length > 0) {
    console.log(`\nALERTS (${alerts.length}):`);
    for (const alert of alerts) {
      const icon = alert.level === 'CRITICAL' ? 'CRIT' : 'WARN';
      console.log(`  [${icon}] ${alert.message}`);
      if (alert.action) {
        console.log(`         Action: ${alert.action}`);
      }
    }
  } else {
    console.log('\nNo risk alerts. Portfolio looks healthy.');
  }

  // Auto-fix if enabled
  if (AUTO_FIX) {
    await autoFix(alerts);
  } else if (alerts.some((a) => a.level === 'CRITICAL')) {
    console.log('\n  Run with --auto-fix to automatically reduce critical risks.');
  }

  console.log('\n=== Risk check complete ===');
}

main().catch(console.error);
