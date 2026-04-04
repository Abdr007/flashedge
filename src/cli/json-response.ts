/**
 * JSON Response Builder — Standardized JSON output for agentic interface.
 *
 * Every command using --format json returns this exact schema:
 *
 * {
 *   "success": true | false,
 *   "command": "earn deposit",
 *   "timestamp": "2026-03-18T12:00:00.000Z",
 *   "version": "v1",
 *   "data": { ... },
 *   "error": null | { "code": "ERROR_CODE", "message": "...", "details": { ... } }
 * }
 *
 * Rules:
 * - success MUST always exist
 * - data MUST always exist (even if empty object)
 * - error MUST be null OR structured object
 * - NO undefined fields
 * - Numeric values are always numbers, never strings
 * - Timestamps are always ISO-8601
 */

// ─── Schema Version ──────────────────────────────────────────────────────────

export const JSON_SCHEMA_VERSION = 'v1';

// ─── Error Codes ─────────────────────────────────────────────────────────────

export const ErrorCode = {
  // General
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  COMMAND_NOT_FOUND: 'COMMAND_NOT_FOUND',
  COMMAND_TIMEOUT: 'COMMAND_TIMEOUT',
  INVALID_PARAMETERS: 'INVALID_PARAMETERS',
  PARSE_ERROR: 'PARSE_ERROR',

  // Wallet
  NO_WALLET: 'NO_WALLET',
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  WALLET_DISCONNECTED: 'WALLET_DISCONNECTED',
  WALLET_OVERRIDE_FAILED: 'WALLET_OVERRIDE_FAILED',
  KEYPAIR_INTEGRITY_FAILED: 'KEYPAIR_INTEGRITY_FAILED',

  // Trading
  TRADE_REJECTED: 'TRADE_REJECTED',
  TRADE_TIMEOUT: 'TRADE_TIMEOUT',
  TRADE_FAILED: 'TRADE_FAILED',
  DUPLICATE_POSITION: 'DUPLICATE_POSITION',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  MAX_COLLATERAL_EXCEEDED: 'MAX_COLLATERAL_EXCEEDED',
  MAX_LEVERAGE_EXCEEDED: 'MAX_LEVERAGE_EXCEEDED',
  MAX_POSITION_SIZE_EXCEEDED: 'MAX_POSITION_SIZE_EXCEEDED',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  POSITION_NOT_FOUND: 'POSITION_NOT_FOUND',
  MARKET_NOT_FOUND: 'MARKET_NOT_FOUND',
  POOL_NOT_FOUND: 'POOL_NOT_FOUND',

  // Earn / LP
  NO_FLP_BALANCE: 'NO_FLP_BALANCE',
  NO_SFLP_BALANCE: 'NO_SFLP_BALANCE',
  NO_REWARDS: 'NO_REWARDS',
  POOL_UNAVAILABLE: 'POOL_UNAVAILABLE',
  EARN_OPERATION_FAILED: 'EARN_OPERATION_FAILED',

  // FAF
  NO_FAF_BALANCE: 'NO_FAF_BALANCE',
  FAF_OPERATION_FAILED: 'FAF_OPERATION_FAILED',
  NO_UNSTAKE_REQUESTS: 'NO_UNSTAKE_REQUESTS',

  // Network / RPC
  RPC_UNAVAILABLE: 'RPC_UNAVAILABLE',
  DEGRADED_MODE: 'DEGRADED_MODE',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TRANSACTION_FAILED: 'TRANSACTION_FAILED',
  SIMULATION_FAILED: 'SIMULATION_FAILED',

  // System
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

// ─── Response Types ──────────────────────────────────────────────────────────

export interface JsonError {
  code: ErrorCodeType | string;
  message: string;
  details: Record<string, unknown>;
}

export interface JsonResponse {
  success: boolean;
  command: string;
  timestamp: string;
  version: string;
  data: Record<string, unknown>;
  error: JsonError | null;
}

// ─── Builders ────────────────────────────────────────────────────────────────

/**
 * Build a successful JSON response.
 */
export function jsonSuccess(command: string, data: Record<string, unknown> = {}): JsonResponse {
  return {
    success: true,
    command,
    timestamp: new Date().toISOString(),
    version: JSON_SCHEMA_VERSION,
    data: sanitizeData(data),
    error: null,
  };
}

/**
 * Build a failed JSON response with structured error.
 */
export function jsonError(
  command: string,
  code: ErrorCodeType | string,
  message: string,
  details: Record<string, unknown> = {},
): JsonResponse {
  return {
    success: false,
    command,
    timestamp: new Date().toISOString(),
    version: JSON_SCHEMA_VERSION,
    data: {},
    error: {
      code,
      message,
      details: sanitizeData(details),
    },
  };
}

/**
 * Build a JSON response from a ToolResult.
 * Tries to parse structured data from message (IS_AGENT JSON) or falls back to result.data.
 */
export function jsonFromToolResult(
  command: string,
  result: { success: boolean; message: string; data?: Record<string, unknown>; txSignature?: string },
): JsonResponse {
  let data: Record<string, unknown> = {};

  // Try to parse structured data from message (tools return JSON strings in IS_AGENT mode)
  try {
    const parsed = JSON.parse(result.message);
    if (typeof parsed === 'object' && parsed !== null) {
      // Remove internal fields that shouldn't be in the public schema
      const { timestamp: _ts, action: _act, ...rest } = parsed;
      data = rest;
    }
  } catch {
    // Not JSON — use result.data if available
    if (result.data) {
      const { executeAction: _ea, ...safeData } = result.data;
      data = safeData;
    }
  }

  if (result.txSignature) {
    data.tx_signature = result.txSignature;
  }

  if (result.success) {
    return jsonSuccess(command, data);
  }

  // Extract error info from message for failed results
  const errorMessage = tryExtractErrorMessage(result.message) || 'Command failed';
  return jsonError(command, inferErrorCode(errorMessage), errorMessage, data);
}

/**
 * Serialize a JsonResponse to a clean JSON string (no ANSI, no extra whitespace noise).
 */
export function jsonStringify(response: JsonResponse): string {
  return JSON.stringify(response, null, 2);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Sanitize data: ensure no undefined values, no functions, no circular refs.
 * Convert numeric strings to numbers where safe.
 */
function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || typeof value === 'function') continue;
    if (value === null) {
      result[key] = null;
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === 'object' && item !== null ? sanitizeData(item as Record<string, unknown>) : item,
      );
    } else if (typeof value === 'object') {
      result[key] = sanitizeData(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Try to extract a human-readable error message from a tool's message string.
 * Strips ANSI codes and formatting artifacts.
 */
function tryExtractErrorMessage(message: string): string | null {
  if (!message) return null;
  // Strip ANSI escape codes
  // eslint-disable-next-line no-control-regex
  const clean = message.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!clean) return null;

  // Try to parse as JSON and extract error/message field
  try {
    const parsed = JSON.parse(clean);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed.error || parsed.message || null;
    }
  } catch {
    // Not JSON — return cleaned string, truncated
  }

  // Strip common prefixes
  const stripped = clean.replace(/^\s*[✖✗×]\s*/g, '').replace(/^\s*Error:\s*/i, '');
  return stripped.slice(0, 500) || null;
}

/**
 * Infer an error code from an error message.
 * Maps common error patterns to structured codes.
 */
function inferErrorCode(message: string): ErrorCodeType {
  const lower = message.toLowerCase();

  if (lower.includes('wallet') && lower.includes('not found')) return ErrorCode.WALLET_NOT_FOUND;
  if (lower.includes('wallet') && lower.includes('disconnect')) return ErrorCode.WALLET_DISCONNECTED;
  if (lower.includes('no wallet')) return ErrorCode.NO_WALLET;
  if (lower.includes('keypair')) return ErrorCode.KEYPAIR_INTEGRITY_FAILED;

  if (lower.includes('insufficient') || lower.includes('not enough')) return ErrorCode.INSUFFICIENT_BALANCE;
  if (lower.includes('duplicate position')) return ErrorCode.DUPLICATE_POSITION;
  if (lower.includes('position not found') || lower.includes('no position')) return ErrorCode.POSITION_NOT_FOUND;
  if (lower.includes('market not found') || lower.includes('unknown market')) return ErrorCode.MARKET_NOT_FOUND;
  if (lower.includes('pool not found') || lower.includes('no pool')) return ErrorCode.POOL_NOT_FOUND;
  if (lower.includes('rate limit')) return ErrorCode.RATE_LIMIT_EXCEEDED;
  if (lower.includes('max collateral')) return ErrorCode.MAX_COLLATERAL_EXCEEDED;
  if (lower.includes('max leverage')) return ErrorCode.MAX_LEVERAGE_EXCEEDED;

  if (lower.includes('no sflp') || lower.includes('no staked flp')) return ErrorCode.NO_SFLP_BALANCE;
  if (lower.includes('no flp')) return ErrorCode.NO_FLP_BALANCE;
  if (lower.includes('no rewards')) return ErrorCode.NO_REWARDS;
  if (lower.includes('no faf')) return ErrorCode.NO_FAF_BALANCE;

  if (lower.includes('rpc') && (lower.includes('unavail') || lower.includes('down'))) return ErrorCode.RPC_UNAVAILABLE;
  if (lower.includes('timeout')) return ErrorCode.COMMAND_TIMEOUT;
  if (lower.includes('network')) return ErrorCode.NETWORK_ERROR;
  if (lower.includes('simulation')) return ErrorCode.SIMULATION_FAILED;
  if (lower.includes('transaction failed')) return ErrorCode.TRANSACTION_FAILED;

  if (lower.includes('not found') || lower.includes('unknown command')) return ErrorCode.COMMAND_NOT_FOUND;
  if (lower.includes('invalid') || lower.includes('parameter')) return ErrorCode.INVALID_PARAMETERS;

  return ErrorCode.UNKNOWN_ERROR;
}
