/**
 * Basic Trading Bot — Flash SDK Example
 *
 * Simple bot that:
 * 1. Checks current positions
 * 2. If no positions, opens a SOL long
 * 3. If positions exist, checks PnL and closes winners
 *
 * Usage:
 *   npx tsx examples/basic-bot.ts
 */

import { FlashSDK, FlashError } from '../src/sdk/index.js';

const flash = new FlashSDK({
  timeout: 20_000,
  env: { SIMULATION_MODE: 'true' },
});

async function main(): Promise<void> {
  console.log('--- Flash Basic Bot ---\n');

  // Step 1: Check positions
  console.log('Checking positions...');
  const posResponse = await flash.positions();
  const positions = posResponse.data.positions ?? [];

  console.log(`  Found ${positions.length} open position(s)\n`);

  if (positions.length === 0) {
    // Step 2: No positions — open a SOL long
    console.log('Opening SOL long: 3x leverage, $50 collateral...');
    try {
      const result = await flash.open({
        market: 'SOL',
        side: 'long',
        leverage: 3,
        collateral: 50,
      });
      console.log('  Trade submitted:', result.data);
    } catch (error: unknown) {
      if (error instanceof FlashError) {
        console.error(`  Trade failed [${error.code}]: ${error.message}`);
      } else {
        throw error;
      }
    }
  } else {
    // Step 3: Check PnL on existing positions
    for (const pos of positions) {
      const pnl = pos.pnl ?? 0;
      const pnlPct = pos.pnlPercent ?? 0;

      console.log(`  ${pos.market} ${pos.side}: PnL $${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`);

      // Close positions with > 5% profit
      if (pnlPct > 5) {
        console.log(`  Closing ${pos.market} ${pos.side} (taking profit)...`);
        try {
          await flash.close({ market: pos.market, side: pos.side });
          console.log('  Closed successfully');
        } catch (error: unknown) {
          if (error instanceof FlashError) {
            console.error(`  Close failed [${error.code}]: ${error.message}`);
          }
        }
      }
    }
  }

  // Step 4: Show portfolio summary
  console.log('\nPortfolio summary:');
  try {
    const portfolio = await flash.portfolio();
    console.log('  ', portfolio.data);
  } catch {
    console.log('  (Could not fetch portfolio)');
  }

  console.log('\n--- Bot complete ---');
}

main().catch(console.error);
