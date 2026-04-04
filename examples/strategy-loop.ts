/**
 * Strategy Loop — Flash SDK Example
 *
 * Continuous trading strategy that:
 * 1. Monitors positions every 10 seconds
 * 2. Enforces a max drawdown limit
 * 3. Auto-closes losing positions beyond threshold
 * 4. Logs all decisions
 *
 * Usage:
 *   npx tsx examples/strategy-loop.ts
 */

import { FlashSDK, type Position, type FlashResponse, type PositionsData } from '../src/sdk/index.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const MAX_DRAWDOWN_PCT = -10; // Close if PnL drops below -10%
const POLL_INTERVAL_MS = 10_000; // Check every 10 seconds
const MAX_ITERATIONS = 30; // Run for ~5 minutes

const flash = new FlashSDK({
  timeout: 15_000,
  env: { SIMULATION_MODE: 'true' },
});

// ─── Strategy Logic ──────────────────────────────────────────────────────────

function shouldClose(position: Position): { close: boolean; reason: string } {
  const pnlPct = position.pnlPercent ?? 0;

  // Stop loss: close if drawdown exceeds threshold
  if (pnlPct < MAX_DRAWDOWN_PCT) {
    return { close: true, reason: `Drawdown ${pnlPct.toFixed(1)}% exceeds limit ${MAX_DRAWDOWN_PCT}%` };
  }

  // Take profit: close if > 15% profit
  if (pnlPct > 15) {
    return { close: true, reason: `Taking profit at ${pnlPct.toFixed(1)}%` };
  }

  return { close: false, reason: 'Hold' };
}

function logPosition(pos: Position): void {
  const pnl = pos.pnl ?? 0;
  const pnlPct = pos.pnlPercent ?? 0;
  const icon = pnl >= 0 ? '+' : '';
  console.log(
    `  ${pos.market.padEnd(6)} ${pos.side.padEnd(5)} ${pos.leverage}x | ` +
      `Size: $${(pos.sizeUsd ?? 0).toFixed(0).padStart(6)} | ` +
      `PnL: ${icon}$${pnl.toFixed(2)} (${icon}${pnlPct.toFixed(1)}%)`,
  );
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

async function onTick(response: FlashResponse<PositionsData>, iteration: number): Promise<void> {
  const timestamp = new Date().toISOString().slice(11, 19);
  const positions = response.data.positions ?? [];

  console.log(`\n[${timestamp}] Tick #${iteration} — ${positions.length} position(s)`);

  if (positions.length === 0) {
    console.log('  No positions open.');
    return;
  }

  for (const pos of positions) {
    logPosition(pos);

    const decision = shouldClose(pos);
    if (decision.close) {
      console.log(`  >> CLOSING ${pos.market} ${pos.side}: ${decision.reason}`);
      try {
        await flash.close({ market: pos.market, side: pos.side });
        console.log(`  >> Closed successfully`);
      } catch (error: unknown) {
        console.error(`  >> Close failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}

async function main(): Promise<void> {
  console.log('=== Flash Strategy Loop ===');
  console.log(`Max drawdown: ${MAX_DRAWDOWN_PCT}%`);
  console.log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`Max iterations: ${MAX_ITERATIONS}`);
  console.log('Press Ctrl+C to stop\n');

  const handle = flash.watch<PositionsData>('positions', (response, iteration) => {
    onTick(response, iteration).catch(console.error);
  }, {
    interval: POLL_INTERVAL_MS,
    deduplicate: false, // Always process even if unchanged
    maxIterations: MAX_ITERATIONS,
  });

  // Keep process alive until watch completes
  const checkInterval = setInterval(() => {
    if (!handle.running) {
      clearInterval(checkInterval);
      console.log('\n=== Strategy loop completed ===');
    }
  }, 1000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nStopping strategy loop...');
    handle.stop();
    clearInterval(checkInterval);
  });
}

main().catch(console.error);
