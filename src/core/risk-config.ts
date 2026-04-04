/**
 * Unified Risk & Threshold Configuration
 *
 * Single source of truth for all risk thresholds used across the CLI.
 * No module may hardcode its own thresholds — all must reference this file.
 *
 * Consumers:
 *   - allocation-engine.ts  (portfolio constraints)
 *   - rebalance.ts          (rebalance triggers)
 *   - agent-tools.ts        (exposure warnings)
 *   - portfolio-risk.ts     (risk checks)
 */

/** Maximum exposure to a single market as fraction of total capital */
export const MAX_MARKET_EXPOSURE = 0.3;

/** Concentration level that triggers rebalance suggestions */
export const REBALANCE_CONCENTRATION_TRIGGER = 0.4;

/** Directional imbalance threshold (%) that triggers rebalance */
export const REBALANCE_DIRECTIONAL_TRIGGER = 70;

/** Maximum directional exposure as fraction of total capital */
export const MAX_DIRECTIONAL_EXPOSURE = 0.6;

/** Maximum correlated market exposure as fraction of total capital */
export const MAX_CORRELATED_EXPOSURE = 0.3;

/** Maximum position allocation as fraction of total capital */
export const MAX_POSITION_ALLOCATION = 0.2;

/** Maximum number of concurrent positions */
export const MAX_POSITIONS = 5;

/** Concentration warning threshold for exposure display (fraction) */
export const CONCENTRATION_WARNING_THRESHOLD = 0.3;

/** Protocol data staleness warning threshold (seconds) */
export const DATA_STALENESS_WARNING_SECONDS = 30;

/** Protocol cache TTL (milliseconds) */
export const PROTOCOL_CACHE_TTL_MS = 15_000;
