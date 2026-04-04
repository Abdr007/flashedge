/**
 * Flash Trade REST API Client — PRIMARY execution layer
 *
 * This is the AUTHORITATIVE source for:
 *   - Trade execution (POST /transaction-builder/*)
 *   - Price data (GET /prices)
 *   - Position data (GET /positions/owner/{owner})
 *   - Pool/earn data (GET /pool-data)
 *   - Fee rates (via GET /pool-data custody stats)
 *   - Order data (GET /orders/owner/{owner})
 *
 * SDK is used ONLY for: wallet signing, placeTriggerOrder (no API endpoint),
 * PoolConfig (program IDs), and UltraTxEngine (multi-endpoint broadcast).
 *
 * Base URL: https://flashapi.trade
 * Rate limit: 10 req/s per owner (REST)
 *
 * IMPORTANT: Transaction builder endpoints return HTTP 200 even on failure.
 * Always check the `err` field in responses.
 */

import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';
import { getServiceBreaker } from '../core/circuit-breaker-service.js';
import {
  ExecutionError,
  apiUnreachableError,
  apiErrorResponse,
  apiEmptyTransaction,
  type ExecutionAction,
} from '../core/execution-error.js';
import {
  trackExecutionStart,
  trackExecutionFailure,
} from '../observability/execution-tracker.js';

// ─── Configuration ─────────────────────────────────────────────────────────────

const FLASH_API_BASE = process.env.FLASH_API_URL || 'https://flashapi.trade';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB max response body
const CIRCUIT_BREAKER_KEY = 'flash-api';
const TRANSIENT_RETRY_COUNT = 1; // Single retry for transient network errors only
const TRANSIENT_RETRY_DELAY_MS = 500;

// ─── HTTP Keep-Alive Agent ──────────────────────────────────────────────────
// Reuse TCP connections across requests to eliminate per-request TLS handshake.
// Node 18+ undici fetch reuses connections by default, but we make it explicit.
// This saves ~50-150ms per request on subsequent calls to the same host.
import { Agent as HttpsAgent } from 'https';

const _keepAliveAgent = new HttpsAgent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 6,        // Max concurrent connections to Flash API
  maxFreeSockets: 3,    // Keep 3 idle connections warm
  timeout: FETCH_TIMEOUT_MS,
});

// For Node 18+ undici-based fetch, set the keep-alive header explicitly
const KEEP_ALIVE_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Connection: 'keep-alive',
};

// ─── Price Types ───────────────────────────────────────────────────────────────

/** GET /prices returns object keyed by symbol */
export interface FlashApiPriceMap {
  [symbol: string]: FlashApiPriceEntry;
}

export interface FlashApiPriceEntry {
  price: number;
  exponent: number;
  confidence: number;
  priceUi: number;
  timestampUs: number;
  marketSession: string; // "regular" or "closed"
}

// Legacy alias for backward compat
export interface FlashApiPrice {
  symbol: string;
  price: number;
  exponent: number;
  price_ui: number;
  timestamp_us: number;
}

// ─── Position Types ────────────────────────────────────────────────────────────

/** GET /positions/owner/{owner}?includePnlInLeverageDisplay=true */
export interface FlashApiEnrichedPosition {
  key: string; // position account pubkey
  sideUi: string; // "Long" or "Short"
  marketSymbol: string; // e.g. "SOL"
  entryPriceUi: string;
  sizeUsdUi: string;
  collateralUsdUi: string;
  pnl: string | number;
  liquidationPriceUi: string;
  leverageUi: string;
  markPriceUi: string;
  // Raw account data also available
  positionAccountData?: string; // base64 Anchor bytes
  [key: string]: unknown;
}

// Legacy alias
export interface FlashApiPosition {
  pubkey: string;
  owner: string;
  pool: string;
  custody: string;
  collateralCustody: string;
  side: 'long' | 'short';
  sizeUsd: number;
  collateralUsd: number;
  entryPrice: number;
  leverage: number;
  liquidationPrice: number;
  pnl: number;
  markPrice: number;
  openTime: number;
  updateTime: number;
}

// ─── Order Types ───────────────────────────────────────────────────────────────

/** GET /orders/owner/{owner} */
export interface FlashApiOrdersResponse {
  limitOrders: FlashApiOrderEntry[];
  takeProfitOrders: FlashApiOrderEntry[];
  stopLossOrders: FlashApiOrderEntry[];
}

export interface FlashApiOrderEntry {
  key: string;
  marketSymbol: string;
  side: string;
  triggerPriceUi: string;
  sizeUsdUi: string;
  [key: string]: unknown;
}

// Legacy alias
export interface FlashApiOrder {
  pubkey: string;
  owner: string;
  pool: string;
  market: string;
  side: 'long' | 'short';
  triggerPrice: number;
  sizeUsd: number;
  orderType: string;
  isActive: boolean;
  createdAt: number;
}

// ─── Market/Pool/Custody Types ─────────────────────────────────────────────────

export interface FlashApiMarket {
  pubkey: string;
  pool: string;
  targetCustody: string;
  collateralCustody: string;
  side: number;
  maxLeverage: number;
  [key: string]: unknown;
}

export interface FlashApiPool {
  pubkey: string;
  name: string;
  [key: string]: unknown;
}

export interface FlashApiCustody {
  pubkey: string;
  pool: string;
  mint: string;
  tokenAccount: string;
  [key: string]: unknown;
}

// ─── Pool Data Types (GET /pool-data) ──────────────────────────────────────────

export interface FlashApiPoolDataResponse {
  pools: FlashApiPoolDataEntry[];
}

export interface FlashApiPoolDataEntry {
  poolAddress: string;
  poolName: string;
  custodyStats: FlashApiCustodyStat[];
  lpStats: FlashApiLpStats;
}

export interface FlashApiCustodyStat {
  symbol: string;
  custodyAccount: string;
  priceUi: string;
  assetsOwnedAmountUi: string;
  lockedAmountUi: string;
  utilizationUi: string;
  currentRatioUi: string;
  targetRatioUi: string;
  totalUsdOwnedAmountUi: string;
  openPositionFeeRate: string; // native BPS
  closePositionFeeRate: string; // native BPS
  maxLeverage: string;
  maxDegenLeverage: string;
  availableToAddAmountUi: string;
  availableToAddUsdUi: string;
  availableToRemoveAmountUi: string;
  availableToRemoveUsdUi: string;
  [key: string]: unknown;
}

export interface FlashApiLpStats {
  lpPrice: string;
  lpTokenSupply: string;
  totalPoolValueUsd: string;
  maxAumUsd: string;
  stableCoinPercentage: string;
  [key: string]: unknown;
}

// Legacy compat for earn/pool-data.ts
export interface FlashApiPoolData {
  poolAddress: string;
  aum: string;
  flpPrice: string;
  sFlpPrice: string;
  flpDailyApy: number | null;
  flpWeeklyApy: number | null;
  sflpDailyApr: number | null;
  sflpWeeklyApr: number | null;
  flpTokenSymbol: string;
  sflpTokenSymbol: string;
}

// ─── Transaction Builder Types ──────────────────────────────────────────────────

export interface OpenPositionParams {
  owner?: string; // omit for preview-only
  inputTokenSymbol: string;
  outputTokenSymbol: string;
  inputAmountUi: string;
  leverage: number;
  tradeType: 'LONG' | 'SHORT' | 'SWAP';
  orderType?: 'MARKET' | 'LIMIT';
  limitPrice?: string;
  degenMode?: boolean;
  slippagePercentage?: string;
  takeProfit?: string;
  stopLoss?: string;
  tradingFeeDiscountPercent?: number;
  tokenStakeFafAccount?: string;
  userReferralAccount?: string;
  privilege?: 'NONE' | 'STAKE' | 'REFERRAL';
}

export interface OpenPositionResponse {
  newLeverage: string;
  newEntryPrice: string;
  newLiquidationPrice: string;
  entryFee: string;
  entryFeeBeforeDiscount: string;
  openPositionFeePercent: string;
  availableLiquidity: string;
  youPayUsdUi: string;
  youRecieveUsdUi: string; // sic — API typo preserved
  marginFeePercentage: string;
  outputAmount: string;
  outputAmountUi: string;
  transactionBase64: string | null;
  takeProfitQuote: TpSlQuote | null;
  stopLossQuote: TpSlQuote | null;
  // When increasing existing position:
  oldLeverage?: string;
  oldEntryPrice?: string;
  oldLiquidationPrice?: string;
  err: string | null;
}

export interface TpSlQuote {
  exitPriceUi: string;
  profitUsdUi: string;
  lossUsdUi: string;
  exitFeeUsdUi: string;
  receiveUsdUi: string;
  pnlPercentage: string;
}

export interface ClosePositionParams {
  owner?: string;
  positionKey: string;
  inputUsdUi: string;
  withdrawTokenSymbol: string;
  keepLeverageSame?: boolean;
  slippagePercentage?: string;
  tradingFeeDiscountPercent?: number;
  tokenStakeFafAccount?: string;
  userReferralAccount?: string;
  privilege?: 'NONE' | 'STAKE' | 'REFERRAL';
}

export interface ClosePositionResponse {
  receiveTokenSymbol: string;
  receiveTokenAmountUi: string;
  receiveTokenAmountUsdUi: string;
  markPrice: string;
  entryPrice: string;
  existingLiquidationPrice: string;
  newLiquidationPrice: string;
  existingSize: string;
  newSize: string;
  existingCollateral: string;
  newCollateral: string;
  existingLeverage: string;
  newLeverage: string;
  settledPnl: string;
  fees: string;
  feesBeforeDiscount: string;
  lockAndUnsettledFeeUsd?: string;
  transactionBase64: string | null;
  err: string | null;
}

export interface AddCollateralParams {
  owner: string; // always required
  positionKey: string;
  depositAmountUi: string;
  depositTokenSymbol: string;
  slippagePercentage?: string;
}

export interface AddCollateralResponse {
  existingCollateralUsd: string;
  newCollateralUsd: string;
  existingLeverage: string;
  newLeverage: string;
  existingLiquidationPrice: string;
  newLiquidationPrice: string;
  depositUsdValue: string;
  maxAddableUsd: string;
  transactionBase64: string | null;
  err: string | null;
}

export interface RemoveCollateralParams {
  owner: string; // always required
  positionKey: string;
  withdrawAmountUsdUi: string;
  withdrawTokenSymbol: string;
  slippagePercentage?: string;
}

export interface RemoveCollateralResponse {
  existingCollateralUsd: string;
  newCollateralUsd: string;
  existingLeverage: string;
  newLeverage: string;
  existingLiquidationPrice: string;
  newLiquidationPrice: string;
  receiveAmountUi: string;
  receiveAmountUsdUi: string;
  maxWithdrawableUsd: string;
  transactionBase64: string | null;
  err: string | null;
}

export interface ReversePositionParams {
  owner: string;
  positionKey: string;
  slippagePercentage?: string;
  tradingFeeDiscountPercent?: number;
  tokenStakeFafAccount?: string;
  userReferralAccount?: string;
  privilege?: 'NONE' | 'STAKE' | 'REFERRAL';
  degenMode?: boolean;
}

export interface ReversePositionResponse {
  closeReceiveUsd: string;
  closeFees: string;
  closeSettledPnl: string;
  newSide: string;
  newLeverage: string;
  newEntryPrice: string;
  newLiquidationPrice: string;
  newSizeUsd: string;
  newSizeAmountUi: string;
  newCollateralUsd: string;
  openEntryFee: string;
  transactionBase64: string | null;
  err: string | null;
}

export interface CancelTriggerOrderParams {
  owner: string;
  marketSymbol: string;
  side: 'LONG' | 'SHORT';
  orderId: number;
  isStopLoss: boolean;
}

export interface CancelTriggerOrderResponse {
  transactionBase64: string | null;
  err: string | null;
}

// ─── Preview Types ──────────────────────────────────────────────────────────────

export interface PreviewExitFeeParams {
  positionKey: string;
  inputUsdUi: string;
  withdrawTokenSymbol: string;
}

export interface PreviewExitFeeResponse {
  exitFee: number;
  exitFeeBeforeDiscount: number;
  markPrice: number;
  err: string | null;
}

export interface PreviewMarginParams {
  positionKey: string;
  marginDeltaUsdUi: string;
  action: 'ADD' | 'REMOVE';
}

export interface PreviewMarginResponse {
  newLeverageUi: string;
  newLiquidationPriceUi: string;
  maxAmountUsdUi: string;
  err: string | null;
}

export interface PreviewTpSlParams {
  positionKey: string;
  mode: 'TP' | 'SL';
  triggerPrice: string;
}

export interface PreviewTpSlResponse {
  exitPriceUi: string;
  profitUsdUi: string;
  lossUsdUi: string;
  pnlPercentage: string;
  err: string | null;
}

export interface FlashApiHealthResponse {
  status: string;
  accounts: {
    perpetuals: number;
    pools: number;
    custodies: number;
    markets: number;
    positions: number;
    orders: number;
  };
}

// ─── Core Fetch Helper ──────────────────────────────────────────────────────────

/**
 * Determines if an error is a transient network failure eligible for retry.
 * Only network-level issues (DNS, TCP, TLS) — NOT API-level errors (4xx, 5xx).
 */
function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('abort') ||
    msg.includes('socket hang up') ||
    msg.includes('dns')
  );
}

/**
 * Core API fetch with circuit breaker, size validation, and transient retry.
 *
 * Retry policy:
 *   - Retries ONLY on transient NETWORK errors (DNS, TCP, socket)
 *   - Does NOT retry on API errors (4xx, 5xx) — those are deterministic
 *   - Does NOT retry via SDK — Flash API is the sole execution path
 *   - Maximum 1 retry with 500ms delay
 */
async function flashApiFetch<T>(
  path: string,
  options?: { method?: 'GET' | 'POST'; body?: unknown },
): Promise<T | null> {
  // Circuit breaker init must never crash the fetch pipeline
  let cb: ReturnType<typeof getServiceBreaker>;
  try {
    cb = getServiceBreaker(CIRCUIT_BREAKER_KEY, {
      failureThreshold: 5,
      cooldownMs: 15_000,
      maxCooldownMs: 60_000,
      cooldownMultiplier: 2,
    });
    if (!cb.allowRequest()) return null;
  } catch {
    // Circuit breaker init failed — proceed without it (fail-open, not fail-closed)
    cb = { allowRequest: () => true, recordSuccess: () => {}, recordFailure: () => {} } as ReturnType<typeof getServiceBreaker>;
  }

  const url = `${FLASH_API_BASE}${path}`;
  const logger = getLogger();
  logger.api(url);

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= TRANSIENT_RETRY_COUNT; attempt++) {
    if (attempt > 0) {
      logger.debug('FLASH-API', `Transient retry ${attempt} for ${path}`);
      await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_DELAY_MS));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const fetchOpts: RequestInit = {
        method: options?.method ?? 'GET',
        signal: controller.signal,
        headers: KEEP_ALIVE_HEADERS,
      };
      if (options?.body) {
        fetchOpts.body = JSON.stringify(options.body);
      }

      const res = await fetch(url, fetchOpts);

      if (!res.ok) {
        if (res.status === 429) {
          logger.info('FLASH-API', `Rate limited (429) for ${path}`);
        }
        cb.recordFailure();
        logger.info('FLASH-API', `${res.status}: ${res.statusText} for ${path}`);
        return null; // API error — no retry
      }

      // Size guard
      const contentLength = res.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
        logger.info('FLASH-API', `Response too large for ${path}: ${contentLength} bytes`);
        return null;
      }

      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        logger.info('FLASH-API', `Response body too large for ${path}: ${text.length} bytes`);
        return null;
      }

      // Response validation: must be valid JSON
      let result: T;
      try {
        result = JSON.parse(text) as T;
      } catch {
        logger.warn('FLASH-API', `Invalid JSON response for ${path}`);
        cb.recordFailure();
        return null; // Malformed response — no retry
      }

      cb.recordSuccess();
      return result;
    } catch (error: unknown) {
      lastError = error;
      // Only retry on transient network errors
      if (attempt < TRANSIENT_RETRY_COUNT && isTransientNetworkError(error)) {
        continue; // Retry
      }
      break; // Non-transient error or retries exhausted
    } finally {
      clearTimeout(timeout);
    }
  }

  // All attempts failed
  cb.recordFailure();
  logger.info('FLASH-API', `Fetch failed for ${path}: ${getErrorMessage(lastError)}`);
  return null;
}

// ─── Transaction Builder Abstraction ──────────────────────────────────────────

interface TransactionBuildResult {
  transactionBase64: string;
  /** Parsed response data (action-specific fields) */
  data: Record<string, unknown>;
}

/**
 * Unified transaction builder — single entry point for all trade executions.
 *
 * Flow: POST /transaction-builder/{action} → validate response → return base64 tx
 *
 * This abstraction ensures:
 *   - Consistent error handling across all trade types
 *   - Execution telemetry for every transaction build
 *   - Future endpoints require minimal changes (just add action mapping)
 *
 * Does NOT sign or broadcast — that's the caller's responsibility.
 */
export async function buildTransaction(
  action: ExecutionAction,
  params: Record<string, unknown>,
): Promise<TransactionBuildResult> {
  const endpointMap: Partial<Record<ExecutionAction, string>> = {
    openPosition: '/transaction-builder/open-position',
    closePosition: '/transaction-builder/close-position',
    addCollateral: '/transaction-builder/add-collateral',
    removeCollateral: '/transaction-builder/remove-collateral',
    cancelTriggerOrder: '/transaction-builder/cancel-trigger-order',
  };

  const endpoint = endpointMap[action];
  if (!endpoint) {
    throw new ExecutionError(
      `No API transaction builder for action: ${action}`,
      { action, errorCode: 'API_ERROR' },
    );
  }

  const executionId = trackExecutionStart(action, endpoint, params);

  try {
    const response = await flashApiFetch<Record<string, unknown>>(endpoint, {
      method: 'POST',
      body: params,
    });

    if (!response) {
      const err = apiUnreachableError(action, endpoint, executionId);
      trackExecutionFailure(executionId, 'API_UNREACHABLE', err.message);
      throw err;
    }

    // Check API-level error
    if (response.err) {
      const err = apiErrorResponse(action, endpoint, String(response.err), executionId);
      trackExecutionFailure(executionId, 'API_ERROR', String(response.err));
      throw err;
    }

    // Validate transaction present — explicit checks for null, undefined, empty string, non-string
    const txBase64 = response.transactionBase64;
    if (txBase64 === null || txBase64 === undefined || typeof txBase64 !== 'string' || txBase64.length === 0) {
      const err = apiEmptyTransaction(action, endpoint, executionId);
      trackExecutionFailure(executionId, 'TX_BUILD_FAILED', err.message);
      throw err;
    }

    // Success — but don't track final success yet (signing + broadcast still pending)
    // Return executionId so caller can track success after broadcast
    return {
      transactionBase64: txBase64,
      data: { ...response, _executionId: executionId },
    };
  } catch (err) {
    if (err instanceof ExecutionError) throw err;
    // Unexpected error
    const msg = err instanceof Error ? err.message : 'Unknown error';
    trackExecutionFailure(executionId, 'API_UNREACHABLE', msg);
    throw apiUnreachableError(action, endpoint, executionId);
  }
}

// ─── Public API Client ──────────────────────────────────────────────────────────

export class FlashApiClient {
  // ─── Health ─────────────────────────────────────────────────────────────────

  async getHealth(): Promise<FlashApiHealthResponse | null> {
    return flashApiFetch<FlashApiHealthResponse>('/health');
  }

  // ─── Prices (PRIMARY price source) ──────────────────────────────────────────

  /** GET /prices — returns object keyed by symbol with priceUi, exponent, confidence */
  async getAllPrices(): Promise<FlashApiPriceMap | null> {
    return flashApiFetch<FlashApiPriceMap>('/prices');
  }

  /** GET /prices/{symbol} */
  async getPrice(symbol: string): Promise<FlashApiPriceEntry | null> {
    return flashApiFetch<FlashApiPriceEntry>(`/prices/${encodeURIComponent(symbol)}`);
  }

  // ─── Positions (PRIMARY position source) ────────────────────────────────────

  /** GET /positions/owner/{owner} — enriched with PnL, leverage, liquidation */
  async getPositionsByOwner(owner: string): Promise<FlashApiEnrichedPosition[] | null> {
    return flashApiFetch<FlashApiEnrichedPosition[]>(
      `/positions/owner/${encodeURIComponent(owner)}?includePnlInLeverageDisplay=true`,
    );
  }

  async getPosition(pubkey: string): Promise<FlashApiPosition | null> {
    return flashApiFetch<FlashApiPosition>(`/positions/${encodeURIComponent(pubkey)}`);
  }

  // ─── Orders ─────────────────────────────────────────────────────────────────

  /** GET /orders/owner/{owner} — grouped: limitOrders, takeProfitOrders, stopLossOrders */
  async getOrdersByOwner(owner: string): Promise<FlashApiOrdersResponse | null> {
    return flashApiFetch<FlashApiOrdersResponse>(`/orders/owner/${encodeURIComponent(owner)}`);
  }

  async getOrder(pubkey: string): Promise<FlashApiOrder | null> {
    return flashApiFetch<FlashApiOrder>(`/orders/${encodeURIComponent(pubkey)}`);
  }

  // ─── Markets ────────────────────────────────────────────────────────────────

  async getMarkets(): Promise<FlashApiMarket[] | null> {
    return flashApiFetch<FlashApiMarket[]>('/markets');
  }

  async getMarket(pubkey: string): Promise<FlashApiMarket | null> {
    return flashApiFetch<FlashApiMarket>(`/markets/${encodeURIComponent(pubkey)}`);
  }

  // ─── Pools ──────────────────────────────────────────────────────────────────

  async getPools(): Promise<FlashApiPool[] | null> {
    return flashApiFetch<FlashApiPool[]>('/pools');
  }

  async getPool(pubkey: string): Promise<FlashApiPool | null> {
    return flashApiFetch<FlashApiPool>(`/pools/${encodeURIComponent(pubkey)}`);
  }

  // ─── Custodies ──────────────────────────────────────────────────────────────

  async getCustodies(): Promise<FlashApiCustody[] | null> {
    return flashApiFetch<FlashApiCustody[]>('/custodies');
  }

  async getCustody(pubkey: string): Promise<FlashApiCustody | null> {
    return flashApiFetch<FlashApiCustody>(`/custodies/${encodeURIComponent(pubkey)}`);
  }

  // ─── Pool Data (PRIMARY for earn + fee rates) ──────────────────────────────

  /** GET /pool-data — full pool snapshots with custody stats and LP metrics */
  async getPoolData(): Promise<FlashApiPoolDataEntry[] | null> {
    const result = await flashApiFetch<FlashApiPoolDataResponse | FlashApiPoolDataEntry[]>('/pool-data');
    if (!result) return null;
    if (Array.isArray(result)) return result;
    return result.pools ?? null;
  }

  async getPoolDataByPubkey(pubkey: string): Promise<FlashApiPoolDataEntry | null> {
    return flashApiFetch<FlashApiPoolDataEntry>(`/pool-data/${encodeURIComponent(pubkey)}`);
  }

  /** Get legacy-format pool data for earn/pool-data.ts compat */
  async getPoolDataLegacy(): Promise<FlashApiPoolData[] | null> {
    const entries = await this.getPoolData();
    if (!entries) return null;
    return entries.map((e) => ({
      poolAddress: e.poolAddress,
      aum: e.lpStats?.totalPoolValueUsd ?? '0',
      flpPrice: e.lpStats?.lpPrice ?? '0',
      sFlpPrice: '0', // not directly in new format; compute if needed
      flpDailyApy: null,
      flpWeeklyApy: null,
      sflpDailyApr: null,
      sflpWeeklyApr: null,
      flpTokenSymbol: '',
      sflpTokenSymbol: '',
    }));
  }

  // ─── Transaction Builders (PRIMARY execution) ──────────────────────────────

  async openPosition(params: OpenPositionParams): Promise<OpenPositionResponse | null> {
    return flashApiFetch<OpenPositionResponse>('/transaction-builder/open-position', {
      method: 'POST',
      body: params,
    });
  }

  async closePosition(params: ClosePositionParams): Promise<ClosePositionResponse | null> {
    return flashApiFetch<ClosePositionResponse>('/transaction-builder/close-position', {
      method: 'POST',
      body: params,
    });
  }

  async addCollateral(params: AddCollateralParams): Promise<AddCollateralResponse | null> {
    return flashApiFetch<AddCollateralResponse>('/transaction-builder/add-collateral', {
      method: 'POST',
      body: params,
    });
  }

  async removeCollateral(params: RemoveCollateralParams): Promise<RemoveCollateralResponse | null> {
    return flashApiFetch<RemoveCollateralResponse>('/transaction-builder/remove-collateral', {
      method: 'POST',
      body: params,
    });
  }

  async reversePosition(params: ReversePositionParams): Promise<ReversePositionResponse | null> {
    return flashApiFetch<ReversePositionResponse>('/transaction-builder/reverse-position', {
      method: 'POST',
      body: params,
    });
  }

  async cancelTriggerOrder(params: CancelTriggerOrderParams): Promise<CancelTriggerOrderResponse | null> {
    return flashApiFetch<CancelTriggerOrderResponse>('/transaction-builder/cancel-trigger-order', {
      method: 'POST',
      body: params,
    });
  }

  // ─── Preview Endpoints ──────────────────────────────────────────────────────

  async previewExitFee(params: PreviewExitFeeParams): Promise<PreviewExitFeeResponse | null> {
    return flashApiFetch<PreviewExitFeeResponse>('/preview/exit-fee', {
      method: 'POST',
      body: params,
    });
  }

  async previewMargin(params: PreviewMarginParams): Promise<PreviewMarginResponse | null> {
    return flashApiFetch<PreviewMarginResponse>('/preview/margin', {
      method: 'POST',
      body: params,
    });
  }

  async previewTpSl(params: PreviewTpSlParams): Promise<PreviewTpSlResponse | null> {
    return flashApiFetch<PreviewTpSlResponse>('/preview/tp-sl', {
      method: 'POST',
      body: params,
    });
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────────

let _instance: FlashApiClient | null = null;

/** Get the global FlashApiClient instance. */
export function getFlashApiClient(): FlashApiClient {
  if (!_instance) _instance = new FlashApiClient();
  return _instance;
}

/** Check if the Flash API is reachable. */
export async function isFlashApiAvailable(): Promise<boolean> {
  try {
    const health = await getFlashApiClient().getHealth();
    return health !== null && health.status === 'ok';
  } catch {
    return false;
  }
}
