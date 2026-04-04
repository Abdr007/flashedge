# Hardening

Adversarial audit findings and fixes applied to FlashEdge.

---

## Audit Methodology

Line-by-line static analysis of all execution-critical code:
- `src/client/flash-client.ts` — execution pipeline
- `src/data/flash-api.ts` — API client
- `src/core/execution-circuit-breaker.ts` — circuit breaker
- `src/core/api-health-guard.ts` — health guard
- `src/core/execution-error.ts` — error classes
- `src/observability/execution-tracker.ts` — telemetry
- `src/observability/execution-store.ts` — persistence

Focus areas: crash paths, resource leaks, race conditions, input validation gaps.

---

## Vulnerabilities Found and Fixed

### Critical

| # | File | Issue | Fix |
|---|---|---|---|
| 1 | `flash-api.ts` | `getServiceBreaker()` not in try-catch — init failure crashes entire API pipeline | Wrapped in try-catch with fail-open stub |
| 2 | `flash-api.ts` | Empty string `transactionBase64: ""` could pass type check | Added explicit `.length === 0` guard |

### High

| # | File | Issue | Fix |
|---|---|---|---|
| 3 | `flash-client.ts` | `vtx.sign()` unhandled throw leaves executionId leaked in active map | Wrapped in try-catch with `TX_SIGN_FAILED` error |
| 4 | `flash-client.ts` | `new Connection()` per broadcast endpoint — socket leak over time | Changed to fire-and-forget pattern for backups only |
| 5 | `flash-client.ts` | `msg.staticAccountKeys` could be undefined — TypeError crash | Added explicit null + Array.isArray guard |
| 6 | `execution-error.ts` | `instanceof ExecutionError` fails in transpiled code | Added `Object.setPrototypeOf(this, ExecutionError.prototype)` |

### Medium

| # | File | Issue | Fix |
|---|---|---|---|
| 7 | `api-health-guard.ts` | `accounts.pools` not validated as number — NaN propagation | Added `typeof !== 'number'` check |
| 8 | `execution-store.ts` | Corrupted JSON file persists across restarts | Added `unlinkSync` to delete corrupted file |
| 9 | `execution-circuit-breaker.ts` | HALF_OPEN allows unlimited concurrent probes | Added `halfOpenProbeInFlight` boolean guard |

---

## Stress Test Results

| Scenario | Result |
|---|---|
| 100 rapid executions | No memory leak, circuit breaker stable |
| 5 consecutive failures | Circuit opens correctly, blocks execution |
| Malformed base64 transaction | TX_VALIDATION_FAILED thrown, no crash |
| Empty API response | API_UNREACHABLE thrown, telemetry recorded |
| Corrupted execution-history.json | File deleted, fresh start, warning logged |
| Concurrent HALF_OPEN probes | Second probe blocked with structured error |
| getServiceBreaker() crash | Fail-open stub used, pipeline continues |
| vtx.sign() exception | TX_SIGN_FAILED thrown, execution tracked |

---

## Remaining Attack Surface

| Vector | Mitigation | Residual Risk |
|---|---|---|
| Compromised API returns valid-looking but malicious transaction | Program ID whitelist check (warn-only) | Low: would need Flash program IDs |
| DNS poisoning of flashapi.trade | HTTPS certificate validation (Node TLS) | Low: requires CA compromise |
| Local process memory dump | Keys zeroed on disconnect | Medium: in-memory during session |
| RPC endpoint returning forged confirmations | Multiple endpoint cross-validation not implemented | Low: would need majority compromise |
