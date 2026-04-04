/**
 * Deterministic Market Simulator — replay recorded price data.
 *
 * Replays a series of price ticks through the SimulatedFlashClient
 * to measure strategy performance, slippage impact, and PnL accuracy.
 *
 * Usage:
 *   npx tsx tools/market-simulator/simulator.ts <scenario.json>
 *
 * Scenario format:
 *   {
 *     "market": "SOL",
 *     "startBalance": 10000,
 *     "ticks": [
 *       { "price": 150.0, "action": "open", "side": "long", "collateral": 100, "leverage": 5 },
 *       { "price": 155.0 },
 *       { "price": 148.0, "action": "close", "side": "long" }
 *     ]
 *   }
 *
 * Runs OUTSIDE the live trading pipeline.
 */

import { readFileSync } from 'fs';

interface PriceTick {
  price: number;
  action?: 'open' | 'close';
  side?: 'long' | 'short';
  collateral?: number;
  leverage?: number;
}

interface Scenario {
  market: string;
  startBalance: number;
  ticks: PriceTick[];
}

interface SimResult {
  tickIndex: number;
  price: number;
  action?: string;
  balance: number;
  pnl?: number;
  unrealizedPnl?: number;
}

async function simulate(scenarioFile: string): Promise<void> {
  console.log(`\n  Market Simulator`);
  console.log(`  ─────────────────────────`);
  console.log(`  Scenario: ${scenarioFile}\n`);

  let scenario: Scenario;
  try {
    scenario = JSON.parse(readFileSync(scenarioFile, 'utf-8'));
  } catch (err) {
    console.error(`  Error loading scenario: ${err}`);
    process.exit(1);
  }

  if (!scenario.ticks || scenario.ticks.length === 0) {
    console.error('  Scenario must have at least one tick.');
    process.exit(1);
  }

  const { SimulatedFlashClient } = await import('../../src/client/simulation.js');
  const client = new SimulatedFlashClient(scenario.startBalance);
  const results: SimResult[] = [];

  console.log(`  Market: ${scenario.market}`);
  console.log(`  Start Balance: $${scenario.startBalance}`);
  console.log(`  Ticks: ${scenario.ticks.length}\n`);

  let maxDrawdown = 0;
  let peakBalance = scenario.startBalance;

  for (let i = 0; i < scenario.ticks.length; i++) {
    const tick = scenario.ticks[i];
    const result: SimResult = {
      tickIndex: i,
      price: tick.price,
      balance: client.getBalance(),
    };

    if (tick.action === 'open' && tick.side) {
      try {
        await client.openPosition(
          scenario.market,
          tick.side as any,
          tick.collateral ?? 100,
          tick.leverage ?? 5,
        );
        result.action = `OPEN ${tick.side} ${tick.leverage ?? 5}x $${tick.collateral ?? 100}`;
        result.balance = client.getBalance();
      } catch (err: any) {
        result.action = `OPEN FAILED: ${err.message}`;
      }
    } else if (tick.action === 'close' && tick.side) {
      try {
        const closeResult = await client.closePosition(scenario.market, tick.side as any);
        result.action = `CLOSE ${tick.side}`;
        result.pnl = closeResult.pnl;
        result.balance = client.getBalance();
      } catch (err: any) {
        result.action = `CLOSE FAILED: ${err.message}`;
      }
    }

    // Track drawdown
    if (result.balance > peakBalance) peakBalance = result.balance;
    const drawdown = ((peakBalance - result.balance) / peakBalance) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    // Get unrealized PnL
    const positions = await client.getPositions();
    if (positions.length > 0) {
      result.unrealizedPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    }

    results.push(result);

    // Print tick
    const actionStr = result.action ? ` | ${result.action}` : '';
    const pnlStr = result.pnl !== undefined ? ` | PnL: $${result.pnl.toFixed(4)}` : '';
    const unrealStr = result.unrealizedPnl !== undefined ? ` | UPnL: $${result.unrealizedPnl.toFixed(4)}` : '';
    console.log(`  [${String(i).padStart(3)}] $${tick.price.toFixed(2)} | bal=$${result.balance.toFixed(2)}${actionStr}${pnlStr}${unrealStr}`);
  }

  // Summary
  const finalBalance = client.getBalance();
  const totalReturn = ((finalBalance - scenario.startBalance) / scenario.startBalance) * 100;
  const trades = results.filter(r => r.action?.startsWith('OPEN') || r.action?.startsWith('CLOSE'));
  const realizedPnl = results.reduce((s, r) => s + (r.pnl ?? 0), 0);

  console.log(`\n  ─────────────────────────`);
  console.log(`  Simulation Complete`);
  console.log(`  Final Balance:   $${finalBalance.toFixed(2)}`);
  console.log(`  Total Return:    ${totalReturn.toFixed(2)}%`);
  console.log(`  Realized PnL:    $${realizedPnl.toFixed(4)}`);
  console.log(`  Max Drawdown:    ${maxDrawdown.toFixed(2)}%`);
  console.log(`  Trade Actions:   ${trades.length}`);
  console.log('');
}

const file = process.argv[2];
if (!file) {
  console.log('Usage: npx tsx tools/market-simulator/simulator.ts <scenario.json>');
  process.exit(1);
}
simulate(file).catch(err => {
  console.error(`Simulation failed: ${err}`);
  process.exit(1);
});
