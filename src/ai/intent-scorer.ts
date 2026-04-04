/**
 * Intent Confidence Scorer
 *
 * Computes confidence scores for parsed trade commands and resolves
 * ambiguous inputs using trade history defaults.
 *
 * Confidence factors:
 *   - All explicit params present → 1.0
 *   - Leverage defaulted from history → 0.85
 *   - Leverage defaulted to 2x → 0.75
 *   - Collateral defaulted from history → 0.70
 *   - Multiple defaults applied → compounding reduction
 *
 * When confidence < 0.8, the terminal shows a confirmation prompt
 * before execution.
 */

import { ActionType, ParsedIntent, TradeSide } from '../types/index.js';
import { getPreferredLeverage } from '../cli/trade-predictor.js';
import { getAllMarkets } from '../config/index.js';
import { resolveMarket } from '../utils/market-resolver.js';

export interface ScoredIntent {
  intent: ParsedIntent;
  confidence: number;
  /** Which fields were auto-filled (not explicitly provided) */
  defaults: string[];
}

const CONFIDENCE_THRESHOLD = 0.8;

/**
 * Score a parsed intent based on how explicitly the user specified parameters.
 */
export function scoreIntent(intent: ParsedIntent, inputTokens: string[]): ScoredIntent {
  let confidence = 1.0;
  const defaults: string[] = [];

  if (intent.action !== ActionType.OpenPosition) {
    return { intent, confidence: 1.0, defaults: [] };
  }

  const i = intent as Record<string, unknown>;
  const inputLower = inputTokens.join(' ').toLowerCase();

  // Check if leverage was explicitly provided (contains Nx pattern)
  const hasExplicitLeverage = /\d+(?:\.\d+)?\s*x\b/.test(inputLower) || /\bleverage\s+\d/.test(inputLower);
  if (!hasExplicitLeverage && typeof i.leverage === 'number') {
    defaults.push('leverage');
    confidence *= 0.85;
  }

  // Collateral is always explicit (user provides the number) — no deduction needed.
  // Only $ prefix vs bare number is a style difference, not ambiguity.

  // Check market confidence
  const market = i.market as string;
  if (market && !getAllMarkets().includes(market)) {
    confidence *= 0.5; // Unknown market — should not happen after resolver
  }

  return { intent, confidence: Math.round(confidence * 100) / 100, defaults };
}

/**
 * Try to resolve an ambiguous command by filling defaults from trade history.
 *
 * Handles cases like:
 *   "long sol"    → fill leverage=preferred, collateral=last used
 *   "short btc"   → fill leverage=preferred, collateral=last used
 *   "long sol 10" → already works (defaults to 2x)
 *
 * Returns null if the command can't be resolved.
 */
export function resolveAmbiguous(
  input: string,
  lastMarket?: string,
  lastSide?: TradeSide,
  lastLeverage?: number,
  lastCollateral?: number,
): ScoredIntent | null {
  const lower = input.toLowerCase().trim();
  const tokens = lower.split(/\s+/);

  // Pattern: "long <market>" or "short <market>" — missing leverage and collateral
  if (tokens.length === 2) {
    const sideWord = tokens[0];
    const marketWord = tokens[1];
    let side: TradeSide | null = null;
    if (sideWord === 'long' || sideWord === 'buy' || sideWord === 'l') side = TradeSide.Long;
    else if (sideWord === 'short' || sideWord === 'sell' || sideWord === 's') side = TradeSide.Short;
    if (!side) return null;

    const market = resolveMarket(marketWord);
    if (!getAllMarkets().includes(market)) return null;

    // Fill from history or defaults
    const defaults: string[] = [];
    let leverage = getPreferredLeverage(market);
    if (!leverage) {
      leverage = lastLeverage ?? 2;
      defaults.push('leverage');
    }
    const collateral = lastCollateral ?? 10;
    defaults.push('collateral');

    const confidence = defaults.length === 2 ? 0.6 : defaults.length === 1 ? 0.75 : 0.85;

    return {
      intent: {
        action: ActionType.OpenPosition,
        market,
        side,
        leverage,
        collateral,
      } as ParsedIntent,
      confidence,
      defaults,
    };
  }

  return null;
}

/** Check if a scored intent needs user confirmation. */
export function needsConfirmation(scored: ScoredIntent): boolean {
  return scored.confidence < CONFIDENCE_THRESHOLD && scored.defaults.length > 0;
}

/** Format a confirmation message for an ambiguous intent. */
export function formatConfirmation(scored: ScoredIntent): string {
  const i = scored.intent as Record<string, unknown>;
  const parts: string[] = [];

  parts.push(`  Interpreted as: ${(i.side as string).toUpperCase()} ${i.market} ${i.leverage}x $${i.collateral}`);

  if (scored.defaults.length > 0) {
    parts.push(`  Auto-filled: ${scored.defaults.join(', ')}`);
  }

  parts.push(`  Confidence: ${(scored.confidence * 100).toFixed(0)}%`);

  return parts.join('\n');
}
