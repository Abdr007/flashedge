/**
 * Structured Execution Error
 *
 * All execution-layer failures throw this error type.
 * Provides deterministic, machine-readable context for every failure.
 *
 * Design principles:
 *   - Fail fast, fail explicitly — no silent degradation
 *   - Every error carries endpoint, action, and diagnostic context
 *   - No fallback logic — if the API fails, execution stops
 */

export type ExecutionAction =
  | 'openPosition'
  | 'closePosition'
  | 'addCollateral'
  | 'removeCollateral'
  | 'cancelTriggerOrder'
  | 'placeTriggerOrder'
  | 'getPositions'
  | 'getPrices'
  | 'healthCheck'
  | 'signTransaction'
  | 'broadcastTransaction'
  | 'confirmTransaction';

export type ExecutionErrorCode =
  | 'API_UNREACHABLE'
  | 'API_TIMEOUT'
  | 'API_RATE_LIMITED'
  | 'API_ERROR'
  | 'API_EMPTY_RESPONSE'
  | 'API_INVALID_RESPONSE'
  | 'TX_BUILD_FAILED'
  | 'TX_SIGN_FAILED'
  | 'TX_BROADCAST_FAILED'
  | 'TX_CONFIRMATION_TIMEOUT'
  | 'TX_ON_CHAIN_ERROR'
  | 'TX_VALIDATION_FAILED'
  | 'HEALTH_CHECK_FAILED'
  | 'POSITION_NOT_FOUND';

export interface ExecutionErrorContext {
  action: ExecutionAction;
  endpoint?: string;
  errorCode: ExecutionErrorCode;
  /** Safe subset of request params (never includes keys/secrets) */
  params?: Record<string, unknown>;
  /** API error message if available */
  apiError?: string;
  /** Latency in ms at time of failure */
  latencyMs?: number;
  /** Execution tracking ID */
  executionId?: string;
}

export class ExecutionError extends Error {
  public readonly context: ExecutionErrorContext;

  constructor(message: string, context: ExecutionErrorContext) {
    super(message);
    this.name = 'ExecutionError';
    this.context = context;
    // Fix prototype chain for transpiled environments (Babel, older TypeScript targets).
    // Without this, `instanceof ExecutionError` may return false in bundled code.
    Object.setPrototypeOf(this, ExecutionError.prototype);
  }

  /** Human-readable summary for CLI display */
  get displayMessage(): string {
    return this.message;
  }

  /** Machine-readable diagnostic payload for logging */
  get diagnostic(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      ...this.context,
    };
  }
}

// ─── Factory helpers ────────────────────────────────────────────────────────

export function apiUnreachableError(action: ExecutionAction, endpoint: string, executionId?: string): ExecutionError {
  return new ExecutionError(
    'Flash API unavailable. Check network connectivity and try again.',
    { action, endpoint, errorCode: 'API_UNREACHABLE', executionId },
  );
}

export function apiErrorResponse(
  action: ExecutionAction,
  endpoint: string,
  apiError: string,
  executionId?: string,
): ExecutionError {
  return new ExecutionError(
    `Trade rejected: ${apiError}`,
    { action, endpoint, errorCode: 'API_ERROR', apiError, executionId },
  );
}

export function apiEmptyTransaction(action: ExecutionAction, endpoint: string, executionId?: string): ExecutionError {
  return new ExecutionError(
    'Flash API returned empty transaction. Try again.',
    { action, endpoint, errorCode: 'TX_BUILD_FAILED', executionId },
  );
}

export function txConfirmationTimeout(
  action: ExecutionAction,
  signature: string,
  timeoutMs: number,
  executionId?: string,
): ExecutionError {
  return new ExecutionError(
    `Transaction not confirmed within ${timeoutMs / 1000}s.\n  Signature: ${signature}\n  Check https://solscan.io/tx/${signature}`,
    { action, endpoint: 'broadcast', errorCode: 'TX_CONFIRMATION_TIMEOUT', params: { signature, timeoutMs }, executionId },
  );
}

export function txOnChainError(action: ExecutionAction, signature: string, err: unknown, executionId?: string): ExecutionError {
  return new ExecutionError(
    `Transaction failed on-chain: ${JSON.stringify(err)}`,
    { action, endpoint: 'broadcast', errorCode: 'TX_ON_CHAIN_ERROR', params: { signature }, executionId },
  );
}

export function healthCheckFailed(reason: string, latencyMs?: number): ExecutionError {
  return new ExecutionError(
    `Flash API health check failed: ${reason}`,
    { action: 'healthCheck', errorCode: 'HEALTH_CHECK_FAILED', latencyMs },
  );
}
