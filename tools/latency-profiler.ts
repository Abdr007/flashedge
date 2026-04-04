/**
 * Latency Profiler — measures RPC and transaction timing.
 *
 * Profiles key operations against configured RPC endpoints:
 *   - getSlot latency
 *   - getRecentBlockhash latency
 *   - getBalance latency
 *   - connection establishment time
 *
 * Usage:
 *   npx tsx tools/latency-profiler.ts [rpc-url]
 *
 * Runs OUTSIDE the production pipeline.
 */

import { Connection } from '@solana/web3.js';

interface LatencyResult {
  operation: string;
  samples: number[];
  avg: number;
  min: number;
  max: number;
  p95: number;
}

async function measureLatency(
  label: string,
  fn: () => Promise<void>,
  iterations = 10,
): Promise<LatencyResult> {
  const samples: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    try {
      await fn();
    } catch {
      // Record failure as -1
      samples.push(-1);
      continue;
    }
    samples.push(performance.now() - start);
  }

  const valid = samples.filter(s => s >= 0);
  if (valid.length === 0) {
    return { operation: label, samples, avg: -1, min: -1, max: -1, p95: -1 };
  }

  const sorted = [...valid].sort((a, b) => a - b);
  return {
    operation: label,
    samples,
    avg: sorted.reduce((s, v) => s + v, 0) / sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p95: sorted[Math.floor(sorted.length * 0.95)],
  };
}

async function profile(rpcUrl: string): Promise<void> {
  console.log(`\n  Latency Profiler`);
  console.log(`  ─────────────────────────`);
  console.log(`  RPC: ${rpcUrl}`);
  console.log(`  Iterations: 10 per operation\n`);

  const conn = new Connection(rpcUrl, 'confirmed');

  const results: LatencyResult[] = [];

  // getSlot
  console.log('  Profiling getSlot...');
  results.push(await measureLatency('getSlot', () => conn.getSlot().then(() => {})));

  // getLatestBlockhash
  console.log('  Profiling getLatestBlockhash...');
  results.push(await measureLatency('getLatestBlockhash', () => conn.getLatestBlockhash().then(() => {})));

  // getBlockHeight
  console.log('  Profiling getBlockHeight...');
  results.push(await measureLatency('getBlockHeight', () => conn.getBlockHeight().then(() => {})));

  // getRecentPrioritizationFees
  console.log('  Profiling getPrioritizationFees...');
  results.push(await measureLatency('getRecentPrioritizationFees', () =>
    conn.getRecentPrioritizationFees().then(() => {}), 5));

  // Print results
  console.log(`\n  ─────────────────────────`);
  console.log('  Results:\n');
  console.log('  Operation                       Avg      Min      Max      p95    Errors');
  console.log('  ─────────────────────────────────────────────────────────────────────────');

  for (const r of results) {
    const errors = r.samples.filter(s => s < 0).length;
    if (r.avg < 0) {
      console.log(`  ${r.operation.padEnd(32)} ALL FAILED`);
    } else {
      console.log(
        `  ${r.operation.padEnd(32)} ${r.avg.toFixed(0).padStart(5)}ms  ${r.min.toFixed(0).padStart(5)}ms  ${r.max.toFixed(0).padStart(5)}ms  ${r.p95.toFixed(0).padStart(5)}ms  ${errors > 0 ? errors + ' err' : '  ok'}`
      );
    }
  }

  console.log('');
}

// CLI entry point
const rpcUrl = process.argv[2] || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
profile(rpcUrl).catch(err => {
  console.error(`Profiler failed: ${err}`);
  process.exit(1);
});
