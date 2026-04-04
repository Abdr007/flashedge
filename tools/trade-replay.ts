/**
 * Trade Replay Tool — deterministic trade event replay for debugging.
 *
 * Loads recorded trade events (from log files or JSON exports) and
 * replays them through the simulation client to verify PnL calculations
 * and reproduce production incidents.
 *
 * Usage:
 *   npx tsx tools/trade-replay.ts <events-file.json>
 *
 * Event file format:
 *   [
 *     { "action": "open", "market": "SOL", "side": "long", "collateral": 100, "leverage": 5 },
 *     { "action": "close", "market": "SOL", "side": "long" }
 *   ]
 *
 * Runs OUTSIDE the live trading pipeline.
 */

import { readFileSync } from 'fs';

interface ReplayEvent {
  action: 'open' | 'close' | 'add_collateral' | 'remove_collateral';
  market: string;
  side: 'long' | 'short';
  collateral?: number;
  leverage?: number;
  amount?: number;
}

interface ReplayResult {
  event: ReplayEvent;
  success: boolean;
  balance?: number;
  pnl?: number;
  error?: string;
}

async function replay(eventsFile: string): Promise<void> {
  console.log(`\n  Trade Replay Tool`);
  console.log(`  ─────────────────────────`);
  console.log(`  Loading: ${eventsFile}\n`);

  let events: ReplayEvent[];
  try {
    const raw = readFileSync(eventsFile, 'utf-8');
    events = JSON.parse(raw);
  } catch (err) {
    console.error(`  Error loading events file: ${err}`);
    process.exit(1);
  }

  if (!Array.isArray(events) || events.length === 0) {
    console.error('  Events file must be a non-empty JSON array.');
    process.exit(1);
  }

  // Dynamically import simulation client (avoids loading full app)
  const { SimulatedFlashClient } = await import('../src/client/simulation.js');
  const client = new SimulatedFlashClient(10_000);

  console.log(`  Starting balance: $${client.getBalance().toFixed(2)}`);
  console.log(`  Events to replay: ${events.length}\n`);

  const results: ReplayResult[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const result: ReplayResult = { event, success: false };

    try {
      switch (event.action) {
        case 'open': {
          const r = await client.openPosition(
            event.market,
            event.side as any,
            event.collateral ?? 100,
            event.leverage ?? 5,
          );
          result.success = true;
          result.balance = client.getBalance();
          console.log(`  [${i + 1}] OPEN ${event.market} ${event.side} ${event.leverage}x $${event.collateral} → entry=${r.entryPrice.toFixed(2)} bal=$${client.getBalance().toFixed(2)}`);
          break;
        }
        case 'close': {
          const r = await client.closePosition(event.market, event.side as any);
          result.success = true;
          result.pnl = r.pnl;
          result.balance = client.getBalance();
          console.log(`  [${i + 1}] CLOSE ${event.market} ${event.side} → pnl=${r.pnl.toFixed(4)} bal=$${client.getBalance().toFixed(2)}`);
          break;
        }
        case 'add_collateral': {
          await client.addCollateral(event.market, event.side as any, event.amount ?? 50);
          result.success = true;
          result.balance = client.getBalance();
          console.log(`  [${i + 1}] ADD $${event.amount} to ${event.market} ${event.side} → bal=$${client.getBalance().toFixed(2)}`);
          break;
        }
        case 'remove_collateral': {
          await client.removeCollateral(event.market, event.side as any, event.amount ?? 20);
          result.success = true;
          result.balance = client.getBalance();
          console.log(`  [${i + 1}] REMOVE $${event.amount} from ${event.market} ${event.side} → bal=$${client.getBalance().toFixed(2)}`);
          break;
        }
      }
    } catch (err: any) {
      result.error = err.message;
      console.log(`  [${i + 1}] ERROR ${event.action} ${event.market}: ${err.message}`);
    }

    results.push(result);
  }

  // Summary
  const successes = results.filter(r => r.success).length;
  const failures = results.filter(r => !r.success).length;
  const totalPnl = results.reduce((sum, r) => sum + (r.pnl ?? 0), 0);

  console.log(`\n  ─────────────────────────`);
  console.log(`  Replay Complete`);
  console.log(`  Events:   ${events.length} (${successes} ok, ${failures} errors)`);
  console.log(`  Final:    $${client.getBalance().toFixed(2)}`);
  console.log(`  Total PnL: $${totalPnl.toFixed(4)}`);
  console.log('');
}

// CLI entry point
const file = process.argv[2];
if (!file) {
  console.log('Usage: npx tsx tools/trade-replay.ts <events-file.json>');
  process.exit(1);
}
replay(file).catch(err => {
  console.error(`Replay failed: ${err}`);
  process.exit(1);
});
