/**
 * Correlation control for portfolio diversification.
 * Prevents stacking trades in correlated markets.
 */

// Correlation groups: markets within the same group are considered correlated
const CORRELATION_GROUPS: string[][] = [
  ['SOL', 'JTO', 'JUP', 'PYTH', 'RAY', 'BONK', 'WIF', 'PENGU', 'PUMP'], // Solana ecosystem
  ['BTC'], // Bitcoin
  ['ETH'], // Ethereum
  ['BNB'], // BNB
  ['XAU', 'XAG'], // Precious metals
  ['EUR', 'GBP'], // Forex (vs USD)
  ['CRUDEOIL'], // Commodities
  ['HYPE'], // Standalone
  ['FARTCOIN'], // Standalone
  ['ORE'], // Standalone
];

// Pre-compute lookup: symbol → group index
const symbolToGroup = new Map<string, number>();
for (let i = 0; i < CORRELATION_GROUPS.length; i++) {
  for (const sym of CORRELATION_GROUPS[i]) {
    symbolToGroup.set(sym.toUpperCase(), i);
  }
}

/**
 * Get the correlation group index for a market symbol.
 * Returns -1 if no known group (treated as uncorrelated).
 */
export function getCorrelationGroup(symbol: string): number {
  return symbolToGroup.get(symbol.toUpperCase()) ?? -1;
}

/**
 * Get all correlated symbols for a given market.
 */
export function getCorrelatedMarkets(symbol: string): string[] {
  const groupIdx = getCorrelationGroup(symbol);
  if (groupIdx === -1) return [symbol.toUpperCase()];
  return CORRELATION_GROUPS[groupIdx].map((s) => s.toUpperCase());
}

/**
 * Check if two markets are correlated (in the same group).
 */
export function areCorrelated(symbolA: string, symbolB: string): boolean {
  const groupA = getCorrelationGroup(symbolA);
  const groupB = getCorrelationGroup(symbolB);
  if (groupA === -1 || groupB === -1) return false;
  return groupA === groupB;
}

export interface CorrelationCheck {
  passed: boolean;
  reason?: string;
  groupExposure: number;
  groupSymbols: string[];
}

/**
 * Check if adding a position in the given market would exceed
 * the correlated exposure limit.
 *
 * @param market - The market to check
 * @param exposureByMarket - Current exposure per market (notional USD)
 * @param totalCapital - Total portfolio capital
 * @param maxCorrelatedPct - Max correlated group exposure as fraction of capital (default 0.30 = 30%)
 * @param proposedNotional - Notional value of the proposed trade (included in check)
 */
export function checkCorrelation(
  market: string,
  exposureByMarket: Record<string, number>,
  totalCapital: number,
  maxCorrelatedPct = 0.3,
  proposedNotional = 0,
): CorrelationCheck {
  if (totalCapital <= 0) {
    return { passed: false, reason: 'Zero capital', groupExposure: 0, groupSymbols: [] };
  }

  const correlated = getCorrelatedMarkets(market);
  let groupExposure = 0;

  for (const sym of correlated) {
    groupExposure += exposureByMarket[sym.toUpperCase()] ?? 0;
  }

  // Include the proposed trade's notional in the check
  const projectedExposure = groupExposure + (Number.isFinite(proposedNotional) ? proposedNotional : 0);
  const maxAllowed = totalCapital * maxCorrelatedPct;

  if (projectedExposure > maxAllowed) {
    return {
      passed: false,
      reason: `Correlated group [${correlated.join(', ')}] exposure $${projectedExposure.toFixed(0)} > ${(maxCorrelatedPct * 100).toFixed(0)}% of capital ($${maxAllowed.toFixed(0)})`,
      groupExposure: projectedExposure,
      groupSymbols: correlated,
    };
  }

  return { passed: true, groupExposure: projectedExposure, groupSymbols: correlated };
}
