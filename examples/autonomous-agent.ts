/**
 * Autonomous Trading Agent — Flash Agent Builder Example
 *
 * A fully autonomous agent that:
 * 1. Monitors SOL, BTC, ETH markets
 * 2. Uses trend continuation + breakout strategies
 * 3. Enforces strict risk controls
 * 4. Logs every decision to a trade journal
 * 5. Stops on anomalies
 *
 * Usage:
 *   npx tsx examples/autonomous-agent.ts
 *   npx tsx examples/autonomous-agent.ts --dry-run
 */

import {
  TradingAgent,
  TrendContinuation,
  BreakoutStrategy,
  MeanReversionStrategy,
} from '../src/agent-builder/index.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const isDryRun = process.argv.includes('--dry-run');

const agent = new TradingAgent(
  // Strategies (evaluated in order, best confidence wins)
  [
    new TrendContinuation(),
    new BreakoutStrategy(),
    new MeanReversionStrategy(),
  ],
  // Agent config
  {
    name: 'flash-alpha',
    markets: ['SOL', 'BTC', 'ETH'],
    pollIntervalMs: 15_000,
    maxIterations: 50,
    dryRun: isDryRun,
    logLevel: 'normal',
    risk: {
      maxPositions: 2,
      maxLeverage: 3,
      positionSizePct: 0.02,         // 2% of capital per trade
      maxDailyLossPct: 0.05,         // 5% daily loss limit
      cooldownAfterLossMs: 300_000,  // 5 min cooldown after loss
      minConfidence: 0.6,            // 60% minimum confidence
      allowedMarkets: ['SOL', 'BTC', 'ETH'],
    },
  },
  // SDK options
  {
    timeout: 20_000,
    env: { SIMULATION_MODE: 'true' },
  },
  // Callbacks
  {
    onDecision: (decision) => {
      if (decision.action === 'open') {
        console.log(`\n  SIGNAL: ${decision.side?.toUpperCase()} ${decision.market}`);
        console.log(`  Strategy: ${decision.strategy}`);
        console.log(`  Confidence: ${(decision.confidence * 100).toFixed(0)}%`);
        console.log(`  Risk: ${decision.riskLevel}`);
        console.log(`  Reason: ${decision.reasoning}`);
        if (decision.tp) console.log(`  TP: $${decision.tp}`);
        if (decision.sl) console.log(`  SL: $${decision.sl}`);
      }
    },
    onTrade: (entry) => {
      console.log(`  TRADE #${entry.id}: ${entry.action} ${entry.market} ${entry.side ?? ''}`);
      if (entry.pnl !== undefined) {
        console.log(`  PnL: $${entry.pnl.toFixed(2)}`);
      }
    },
    onSafetyStop: (reason) => {
      console.log(`\n  *** SAFETY STOP: ${reason} ***\n`);
    },
    onStatusChange: (status, prev) => {
      console.log(`  Status: ${prev} → ${status}`);
    },
    onError: (error, context) => {
      console.error(`  Error in ${context}: ${error.message}`);
    },
  },
);

// ─── Run ─────────────────────────────────────────────────────────────────────

console.log('=== Flash Autonomous Agent ===');
console.log(`Mode: ${isDryRun ? 'DRY RUN' : 'LIVE SIMULATION'}`);
console.log('Press Ctrl+C to stop\n');

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down agent...');
  agent.stop();
});

// Start agent
agent.start().then(() => {
  // Print final journal stats
  const stats = agent.getJournal().getStats();
  console.log('\n=== Final Report ===');
  console.log(agent.getJournal().formatStats());

  if (stats.totalTrades > 0) {
    console.log(`\nRecent trades:`);
    for (const entry of agent.getJournal().getRecent(5)) {
      const icon = entry.outcome === 'win' ? 'W' : entry.outcome === 'loss' ? 'L' : '-';
      console.log(`  [${icon}] ${entry.market} ${entry.side ?? ''} | ${entry.strategy} | conf=${(entry.confidence * 100).toFixed(0)}%`);
    }
  }

  console.log('\n=== Agent terminated ===');
}).catch(console.error);
