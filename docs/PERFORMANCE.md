# Performance

Latency analysis and optimization decisions for FlashEdge.

---

## Latency Budget

| Stage | Time | Blocking? | Notes |
|---|---|---|---|
| Health check | 0ms | No | Cached (10s fresh, 30s stale with bg refresh) |
| Circuit breaker | <0.1ms | Yes (sync) | O(1) array length check |
| API transaction build | 100-300ms | Yes | HTTP POST with keep-alive |
| TX validation | <1ms | Yes (sync) | Deserialized once, reused |
| Signing | <0.5ms | Yes (sync) | Ed25519 local |
| Broadcast | 50-150ms | Yes | Primary awaited, backups fire-and-forget |
| Confirmation | 1-45s | Yes | Adaptive polling (1s/2s tiers) |
| Telemetry | 0ms | No | queueMicrotask, non-blocking |
| Persistence | 0ms | No | Debounced 2s async write |
| **Total to broadcast** | **~150-450ms** | | CLI input to transaction on Solana |

## Optimizations

### 1. Zero-Blocking Health Check

**Problem**: Health check adds 100-500ms per trade if blocking.

**Solution**: Three-tier cache strategy.
- Fresh cache (<10s): return immediately, 0ms added
- Stale cache (<30s): return immediately + trigger background async refresh
- Cold/unhealthy: blocking check (only on first trade or after failure)

**Impact**: 0ms on hot path (99% of trades).

### 2. HTTP Keep-Alive

**Problem**: Each fetch to Flash API requires TLS handshake (~100-150ms).

**Solution**: Persistent HTTPS agent with keep-alive:
```
keepAlive: true
keepAliveMsecs: 30_000
maxSockets: 6
maxFreeSockets: 3
```
Plus explicit `Connection: keep-alive` header on every request.

**Impact**: ~100ms saved per API call after first request.

### 3. Single Deserialization

**Problem**: Transaction is deserialized twice: once in validation, once in sendApiTransaction.

**Solution**: `validateTransactionBeforeSign()` returns `{ vtx, rawBytes }`. `sendApiTransaction()` accepts a `preValidated` parameter and reuses the already-parsed transaction.

**Impact**: ~1-3ms saved per trade (Buffer.from + VersionedTransaction.deserialize eliminated).

### 4. Parallel Broadcast

**Problem**: Single-endpoint broadcast creates a bottleneck on that endpoint's latency.

**Solution**: Send to primary endpoint (awaited) + all backup endpoints (fire-and-forget). Fastest propagation path wins.

**Impact**: 50-200ms improvement when backup endpoints are faster than primary.

### 5. Adaptive Confirmation Polling

**Problem**: Fixed 2s polling either misses fast confirmations or wastes RPC quota.

**Solution**: Two-tier polling:
- First 10s: poll every 1s (catches ~80% of confirmations)
- After 10s: poll every 2s (reduces RPC load for slow confirmations)

**Impact**: ~1s faster confirmation detection for average trades.

### 6. Adaptive Timeout

**Problem**: Fixed 45s timeout is too long for healthy networks, too short for congested ones.

**Solution**: `timeout = max(30s, p95_latency * 2)`, capped at 90s. P95 computed from last 10 minutes of execution history.

**Impact**: Prevents premature timeouts during congestion while avoiding unnecessary waits during healthy periods.

### 7. Fire-and-Forget Telemetry

**Problem**: Telemetry writes (circuit breaker + disk persistence) on the execution path add latency.

**Solution**:
- Circuit breaker update: synchronous O(1) — safe to inline
- Disk persistence: scheduled via `queueMicrotask` with 2s debounced `setTimeout`
- Timer uses `.unref()` so it never blocks process exit

**Impact**: 0ms added to execution path for all telemetry operations.

### 8. Static Imports Only

**Problem**: `require()` in hot path resolves modules at call time (~5ms).

**Solution**: All modules used in execute* methods are imported statically at file top via ESM `import`. No dynamic `require()` in the execution path.

**Impact**: ~5ms saved per trade.

## Non-Optimizations (Deliberate)

| What we DON'T do | Why |
|---|---|
| Skip health check entirely | Risk executing against a dead API |
| Skip TX validation | Risk signing malformed transactions |
| Remove circuit breaker | Risk cascading failures |
| Use WebSocket for confirmation | Adds connection complexity; HTTP polling is reliable enough |
| Pre-build transactions | Stale blockhash would cause failures |
