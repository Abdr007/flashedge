# Security

Threat model and mitigations for FlashEdge.

---

## Threat Model

FlashEdge operates in a hostile environment:
- The API server may be compromised or degraded
- RPC endpoints may be malicious or man-in-the-middle
- Network responses may be corrupted or forged
- The local process may be observed by other processes

### Trust Boundaries

| Component | Trust Level | Mitigation |
|---|---|---|
| Flash API | Partially trusted | Response validation, circuit breaker |
| RPC endpoints | Partially trusted | Program ID whitelist, transaction validation |
| Local keypair | Fully trusted | Never transmitted, integrity verified before use |
| CLI input | Untrusted | Parser validation, bounds checking, sanitization |

---

## Pre-Sign Transaction Validation

Every transaction from the API is validated before the wallet signs it:

| Check | What | Failure Mode |
|---|---|---|
| 1. Size bounds | Base64 string >= 10 chars | Throw TX_VALIDATION_FAILED |
| 2. Deserialize | Valid VersionedTransaction bytes | Throw TX_VALIDATION_FAILED |
| 3. Instructions | Count > 0 | Throw TX_VALIDATION_FAILED |
| 4. Accounts | staticAccountKeys is array, count in [1, 256] | Throw TX_VALIDATION_FAILED |
| 5. Programs | At least one known program ID in whitelist | Warn (log) |
| 6. Byte size | Raw bytes <= 1232 (Solana max) | Debug log (ALTs may compress) |

The whitelist includes: System Program, Token Program, Token-2022, ATA, Compute Budget, and all Flash Trade program IDs loaded from SDK PoolConfig.

---

## Signing Safety

- **Keypair integrity**: `walletMgr.verifyKeypairIntegrity()` called before every sign operation
- **Sign wrapped**: `vtx.sign()` is wrapped in try-catch — signing failure produces structured `TX_SIGN_FAILED` error
- **No key transmission**: Private key never leaves the local process. All signing is local Ed25519.
- **Prototype chain**: `ExecutionError` uses `Object.setPrototypeOf` to ensure `instanceof` works in transpiled code

---

## Network Security

- **RPC URL validation**: SSRF protection blocks private/internal IP ranges (10.x, 172.16-31.x, 192.168.x, 169.254.x, link-local IPv6)
- **HTTPS enforcement**: RPC and API URLs must use HTTPS (HTTP allowed only for localhost)
- **No embedded credentials**: RPC URLs with username:password rejected
- **Response size cap**: 2MB max for API responses, 1MB for price data
- **Connection reuse**: HTTPS keep-alive with bounded socket pool (6 max, 3 idle)

---

## API Response Validation

- **Circuit breaker**: 5 consecutive failures → circuit opens, blocks requests for 15-60s
- **JSON validation**: Non-JSON responses from HTTP 200 are caught and logged
- **Empty transaction guard**: Empty string, null, undefined, and non-string transactionBase64 all rejected explicitly
- **Service breaker init**: `getServiceBreaker()` wrapped in try-catch — init failure produces fail-open stub, never crashes pipeline

---

## Log Scrubbing

All log output is scrubbed for:
- API keys (`sk-ant-*`, `gsk_*`)
- Private key material
- RPC credentials
- Wallet paths containing sensitive directories

---

## Rate Limiting

- **Trade rate**: Configurable `MAX_TRADES_PER_MINUTE` (default 10)
- **Trade delay**: Configurable `MIN_DELAY_BETWEEN_TRADES_MS` (default 3000ms)
- **Signing audit log**: Every trade attempt recorded to `~/.flash/signing-audit.log`
