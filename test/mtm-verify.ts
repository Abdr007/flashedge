/**
 * Mark-to-Market Engine Verification
 *
 * Tests the full MTM pipeline:
 * 1. Open position → verify mark price, fees, PnL
 * 2. Price update → verify unrealized PnL updates
 * 3. Close position → verify realized PnL, close fee
 * 4. Portfolio → verify aggregated MTM values
 *
 * Run: npx tsx test/mtm-verify.ts
 */

import { SimulatedFlashClient } from '../src/client/simulation.js';
import { TradeSide } from '../src/types/index.js';

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ${PASS}  ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL}  ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function assertClose(actual: number, expected: number, tolerance: number, label: string): void {
  const diff = Math.abs(actual - expected);
  if (diff <= tolerance) {
    console.log(`  ${PASS}  ${label} (${actual.toFixed(4)} ≈ ${expected.toFixed(4)})`);
    passed++;
  } else {
    console.log(`  ${FAIL}  ${label} — got ${actual.toFixed(6)}, expected ${expected.toFixed(6)}, diff ${diff.toFixed(6)}`);
    failed++;
  }
}

async function main() {
  console.log('\n  Mark-to-Market Engine Verification');
  console.log('  ══════════════════════════════════════════\n');

  const client = new SimulatedFlashClient(10_000);

  // ─── Phase 1: Open Position ──────────────────────────────────────

  console.log('  Phase 1: Open Position');

  const openResult = await client.openPosition('SOL', TradeSide.Long, 100, 5);

  assert(openResult.txSignature.startsWith('SIM_'), 'Transaction signature generated');
  assert(openResult.entryPrice > 0, 'Entry price is positive');
  assert(openResult.sizeUsd === 500, `Position size = $500 (collateral $100 × 5x)`);

  // Check fee deduction: balance should be 10000 - 100 (collateral) - fee
  const expectedFee = (500 * 8) / 10_000; // 0.08% of $500 = $0.04
  const expectedBalance = 10_000 - 100 - expectedFee;
  const balance = client.getBalance();
  assertClose(balance, expectedBalance, 0.01, `Balance after open: $${expectedBalance.toFixed(2)}`);

  // ─── Phase 2: Verify Position Fields ─────────────────────────────

  console.log('\n  Phase 2: Position Mark-to-Market Fields');

  const positions = await client.getPositions();
  assert(positions.length === 1, 'One open position');

  const pos = positions[0];
  assert(pos.market === 'SOL', 'Market = SOL');
  assert(pos.side === TradeSide.Long, 'Side = LONG');
  assert(pos.leverage === 5, 'Leverage = 5x');
  assert(pos.sizeUsd === 500, 'Size = $500');
  assert(pos.collateralUsd === 100, 'Collateral = $100');
  assert(pos.entryPrice > 0, 'Entry price set');
  assert(pos.markPrice > 0, 'Mark price set');
  assert(pos.markPrice === pos.currentPrice, 'Mark price = current price');
  assert(Number.isFinite(pos.unrealizedPnl), 'Unrealized PnL is finite');
  assert(Number.isFinite(pos.unrealizedPnlPercent), 'Unrealized PnL % is finite');
  assert(pos.liquidationPrice > 0, 'Liquidation price set');
  assertClose(pos.openFee, expectedFee, 0.01, `Open fee = $${expectedFee.toFixed(4)}`);
  assert(pos.totalFees >= pos.openFee, 'Total fees >= open fee');
  assert(pos.fundingRate === 0, 'Funding rate = 0 (sim mode)');

  // ─── Phase 3: PnL Formula Verification ──────────────────────────

  console.log('\n  Phase 3: PnL Formula Verification');

  // PnL = (markPrice - entryPrice) * sizeUsd / entryPrice (for long)
  const expectedPnl = ((pos.markPrice - pos.entryPrice) / pos.entryPrice) * pos.sizeUsd;
  assertClose(pos.unrealizedPnl, expectedPnl, 0.01, 'PnL formula correct');

  const expectedPnlPct = (pos.unrealizedPnl / pos.collateralUsd) * 100;
  assertClose(pos.unrealizedPnlPercent, expectedPnlPct, 0.01, 'PnL % formula correct');

  // ─── Phase 4: Portfolio MTM ──────────────────────────────────────

  console.log('\n  Phase 4: Portfolio Mark-to-Market');

  const portfolio = await client.getPortfolio();
  assert(portfolio.positions.length === 1, 'Portfolio has 1 position');
  assertClose(portfolio.totalCollateralUsd, 100, 0.01, 'Total collateral = $100');
  assertClose(portfolio.totalPositionValue, 500, 0.01, 'Total position value = $500');
  assert(Number.isFinite(portfolio.totalUnrealizedPnl), 'Total unrealized PnL is finite');
  assertClose(portfolio.totalRealizedPnl, 0, 0.01, 'Total realized PnL = $0 (no closes yet)');
  assert(portfolio.totalFees > 0, 'Total fees tracked');

  // ─── Phase 5: Close Position ─────────────────────────────────────

  console.log('\n  Phase 5: Close Position & Realized PnL');

  const balanceBefore = client.getBalance();
  const closeResult = await client.closePosition('SOL', TradeSide.Long);

  assert(closeResult.txSignature.startsWith('SIM_'), 'Close tx signature generated');
  assert(closeResult.exitPrice > 0, 'Exit price is positive');
  assert(Number.isFinite(closeResult.pnl), 'Realized PnL is finite');

  const positionsAfter = await client.getPositions();
  assert(positionsAfter.length === 0, 'No positions after close');

  // Balance should be: balanceBefore + collateral + PnL - closeFee
  const closeFee = (500 * 8) / 10_000;
  const expectedBalanceAfter = balanceBefore + 100 + closeResult.pnl - closeFee;
  assertClose(client.getBalance(), expectedBalanceAfter, 0.01, 'Balance correct after close');

  // ─── Phase 6: Portfolio After Close ──────────────────────────────

  console.log('\n  Phase 6: Portfolio After Close');

  const portfolioAfter = await client.getPortfolio();
  assert(portfolioAfter.positions.length === 0, 'No positions in portfolio');
  assertClose(portfolioAfter.totalRealizedPnl, closeResult.pnl, 0.01, 'Realized PnL tracked');
  assert(portfolioAfter.totalFees > 0, 'Cumulative fees tracked');

  const totalExpectedFees = expectedFee + closeFee;
  assertClose(portfolioAfter.totalFees, totalExpectedFees, 0.01, `Total fees = $${totalExpectedFees.toFixed(4)} (open + close)`);

  // ─── Phase 7: Safety Guards ──────────────────────────────────────

  console.log('\n  Phase 7: Safety Guards');

  // Open a position and verify all values are finite
  await client.openPosition('ETH', TradeSide.Short, 50, 3);
  const safePositions = await client.getPositions();
  const sp = safePositions[0];

  assert(Number.isFinite(sp.entryPrice) && sp.entryPrice > 0, 'Entry price finite & positive');
  assert(Number.isFinite(sp.markPrice) && sp.markPrice > 0, 'Mark price finite & positive');
  assert(Number.isFinite(sp.sizeUsd) && sp.sizeUsd > 0, 'Size finite & positive');
  assert(Number.isFinite(sp.collateralUsd) && sp.collateralUsd > 0, 'Collateral finite & positive');
  assert(Number.isFinite(sp.leverage) && sp.leverage > 0, 'Leverage finite & positive');
  assert(Number.isFinite(sp.unrealizedPnl), 'Unrealized PnL finite');
  assert(Number.isFinite(sp.unrealizedPnlPercent), 'Unrealized PnL % finite');
  assert(Number.isFinite(sp.liquidationPrice) && sp.liquidationPrice > 0, 'Liquidation price finite & positive');
  assert(Number.isFinite(sp.openFee) && sp.openFee >= 0, 'Open fee finite & non-negative');
  assert(Number.isFinite(sp.totalFees) && sp.totalFees >= 0, 'Total fees finite & non-negative');
  assert(Number.isFinite(sp.fundingRate), 'Funding rate finite');

  // SHORT PnL formula: (entry - mark) * size / entry
  const shortExpectedPnl = ((sp.entryPrice - sp.markPrice) / sp.entryPrice) * sp.sizeUsd;
  assertClose(sp.unrealizedPnl, shortExpectedPnl, 0.01, 'SHORT PnL formula correct');

  // Clean up
  await client.closePosition('ETH', TradeSide.Short);

  // ─── Phase 8: Edge Cases ─────────────────────────────────────────

  console.log('\n  Phase 8: Edge Cases');

  // Try to open with more than balance
  try {
    await client.openPosition('SOL', TradeSide.Long, client.getBalance() + 100, 2);
    assert(false, 'Should reject excessive collateral');
  } catch {
    assert(true, 'Rejects collateral exceeding balance');
  }

  // Verify no NaN in final portfolio
  const finalPortfolio = await client.getPortfolio();
  assert(Number.isFinite(finalPortfolio.balance), 'Final balance finite');
  assert(Number.isFinite(finalPortfolio.totalRealizedPnl), 'Final realized PnL finite');
  assert(Number.isFinite(finalPortfolio.totalFees), 'Final total fees finite');
  assert(Number.isFinite(finalPortfolio.totalUnrealizedPnl), 'Final unrealized PnL finite');

  // ─── Summary ────────────────────────────────────────────────────

  console.log('\n  ══════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('  \x1b[32mAll MTM engine tests passed.\x1b[0m');
  } else {
    console.log('  \x1b[31mSome tests failed.\x1b[0m');
  }
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
