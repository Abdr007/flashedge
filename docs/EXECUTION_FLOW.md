# Execution Flow

Step-by-step lifecycle of every trade execution in FlashEdge.

---

## The Pipeline

Every trade follows exactly this sequence. No branches. No fallback. One path.

```
User Input
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 1. PARSE                                            │
│    Natural language → TradeObject AST                │
│    "open 5x long SOL $100" →                        │
│    { action: OPEN, market: SOL, side: LONG,         │
│      leverage: 5, collateral: 100 }                 │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│ 2. VALIDATE                                         │
│    - Leverage within market limits                   │
│    - Collateral >= $10 minimum                       │
│    - Market is tradeable (pool exists)               │
│    - Market hours check (for virtual markets)        │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│ 3. HEALTH CHECK                     [0ms if cached] │
│    checkApiHealth()                                  │
│    - Fresh cache (<10s): return immediately          │
│    - Stale cache (<30s): return + bg refresh         │
│    - Cold/unhealthy: blocking check                  │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│ 4. CIRCUIT BREAKER CHECK            [<0.1ms]        │
│    checkCircuitBreaker()                             │
│    - CLOSED: proceed                                 │
│    - OPEN: throw ExecutionError (with retry timer)   │
│    - HALF_OPEN: allow one probe (guarded)            │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│ 5. BUILD TRANSACTION                [100-300ms]     │
│    buildTransaction(action, params)                  │
│    - POST /transaction-builder/open-position         │
│    - HTTP keep-alive connection reuse                │
│    - Transient network retry (1 attempt, 500ms)      │
│    - Validates: no err, transactionBase64 present    │
│    - Returns: { transactionBase64, data }            │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│ 6. VALIDATE TRANSACTION             [<1ms]          │
│    validateTransactionBeforeSign()                   │
│    - Deserialize base64 → VersionedTransaction       │
│    - Instruction count > 0                           │
│    - Account count in [1, 256]                       │
│    - Known program IDs present                       │
│    - Byte size sanity                                │
│    - Returns pre-parsed {vtx, rawBytes}              │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│ 7. SIGN                             [<0.5ms]        │
│    sendApiTransaction(tx, preValidated)               │
│    - Verify keypair integrity                        │
│    - vtx.sign([wallet]) — local Ed25519              │
│    - Reuses pre-parsed vtx (no re-deserialization)   │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│ 8. BROADCAST                        [50-150ms]      │
│    Parallel to all healthy RPC endpoints              │
│    - Primary endpoint: awaited                       │
│    - Backup endpoints: fire-and-forget               │
│    - skipPreflight: true (validation already done)   │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│ 9. CONFIRM                          [variable]      │
│    Adaptive polling:                                 │
│    - 0-10s: poll every 1s (aggressive)               │
│    - 10s+: poll every 2s (standard)                  │
│    - Rebroadcast every 3rd poll                      │
│    - Timeout: max(30s, p95 × 2), cap 90s             │
│    - Immediate exit on confirmed/finalized           │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│ 10. POST-EXECUTION                  [non-blocking]  │
│    - trackExecutionSuccess(executionId, signature)   │
│    - circuitBreaker.recordSuccess(latencyMs)         │
│    - queueMicrotask → persistExecution() → disk      │
│    - walletMgr.clearBalanceCache()                   │
└─────────────────────────────────────────────────────┘
```

## On Failure

At ANY step, if an error occurs:

```
Error thrown
  │
  ├─ circuitBreaker.recordFailure(errorCode, latencyMs)
  ├─ trackExecutionFailure(executionId, errorCode, message)
  ├─ queueMicrotask → persistExecution() → disk
  └─ throw ExecutionError (with structured context)
```

The error propagates to the CLI layer, which displays it to the user. The circuit breaker updates its failure window. If the failure rate exceeds 40% or 5 consecutive failures occur, the circuit opens and blocks subsequent executions until cooldown expires.
