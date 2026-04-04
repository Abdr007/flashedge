import { Connection, type Commitment } from '@solana/web3.js';

/** RPC timeout for regular queries (120s — must exceed confirm timeout to avoid killing confirmTransaction). */
const RPC_FETCH_TIMEOUT_MS = 120_000;

/** Timeout for transaction confirmation (90s — blockhash validity window). */
const TX_CONFIRM_TIMEOUT_MS = 90_000;

/**
 * Validate an RPC URL: must be well-formed HTTPS (or localhost for development).
 * Rejects: HTTP (non-local), malformed URLs, non-HTTP schemes, embedded credentials.
 */
function validateRpcUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid RPC URL: ${url}`);
  }

  // Reject embedded credentials
  if (parsed.username || parsed.password) {
    throw new Error('RPC URL must not contain embedded credentials');
  }

  // Allow localhost/127.0.0.1 over HTTP for development
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol === 'http:' && !isLocalhost) {
    throw new Error(`RPC URL must use HTTPS (got HTTP). Refusing to send signed transactions over plaintext: ${url}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`RPC URL must use HTTPS protocol (got ${parsed.protocol}): ${url}`);
  }
}

/**
 * Derive WebSocket endpoint from RPC URL using proper URL parsing.
 * Only replaces the protocol — preserves path, query params, and fragment.
 */
function deriveWsEndpoint(rpcUrl: string): string {
  const parsed = new URL(rpcUrl);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return parsed.toString();
}

export function createConnection(rpcUrl: string, config?: { commitment?: Commitment }): Connection {
  validateRpcUrl(rpcUrl);

  const wsEndpoint = deriveWsEndpoint(rpcUrl);

  return new Connection(rpcUrl, {
    commitment: config?.commitment ?? 'confirmed',
    confirmTransactionInitialTimeout: TX_CONFIRM_TIMEOUT_MS,
    wsEndpoint,
    fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(RPC_FETCH_TIMEOUT_MS) }),
  });
}
