<p align="center">
  <img src="assets/logo.svg" width="80" height="80" alt="FlashEdge" />
</p>

<h1 align="center">FlashEdge</h1>

<p align="center">
  <strong>Deterministic. Ultra-Low Latency. API-Dominant.</strong>
</p>

<p align="center">
  A production-grade trading execution engine for Solana perpetual futures.<br/>
  Built for precision, speed, and resilience. Zero compromise.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/execution_path-single_deterministic-blue?style=flat-square" alt="Single Path" />
  <img src="https://img.shields.io/badge/tests-1743_passed-brightgreen?style=flat-square" alt="Tests" />
  <img src="https://img.shields.io/badge/fallback_paths-0-red?style=flat-square" alt="Zero Fallback" />
  <img src="https://img.shields.io/badge/latency-sub_200ms-orange?style=flat-square" alt="Latency" />
  <img src="https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square" alt="License" />
</p>

---

## What is FlashEdge?

FlashEdge is a CLI trading engine that executes perpetual futures trades on [Flash Trade](https://www.flash.trade/) via the Solana blockchain. It replaces manual web UI interaction with a deterministic, scriptable, and observable execution pipeline.

Every trade follows exactly one path:

```
Flash API  →  Validate  →  Sign  →  Broadcast
```

No fallback. No SDK-driven execution. No hidden branching. One path, every time.

---

## Key Capabilities

| Capability | Detail |
|---|---|
| **Single Execution Path** | Flash API transaction builder is the sole execution source. Zero SDK fallback. |
| **Sub-200ms Pipeline** | Health check (0ms cached) → API call → validate → sign → parallel broadcast |
| **Circuit Breaker** | Self-protecting gate: halts execution at >40% failure rate or 5 consecutive failures |
| **Adaptive Timeout** | Confirmation timeout scales with p95 latency: `max(30s, p95 × 2)`, capped at 90s |
| **Parallel Broadcast** | Transaction sent to all healthy RPC endpoints simultaneously. Fastest wins. |
| **6-Point TX Validation** | Instruction count, account bounds, program ID whitelist, byte size — before signing |
| **Execution Telemetry** | Every trade tracked: UUID, latency, endpoint, success/failure, error code |
| **Persistent History** | Last 100 executions persisted to disk with async debounced writes |
| **API Health Guard** | Background refresh with 10s fresh / 30s stale cache. Zero blocking on hot path. |
| **Structured Errors** | Every failure carries action, endpoint, errorCode — machine-readable diagnostics |

---

## Architecture

```
                          ┌─────────────────────┐
                          │    CLI Terminal      │
                          │  (Natural Language)  │
                          └─────────┬───────────┘
                                    │
                          ┌─────────▼───────────┐
                          │   Parser / AST       │
                          │  (Regex Grammar)     │
                          └─────────┬───────────┘
                                    │
                          ┌─────────▼───────────┐
                          │    Validation        │
                          │  (Leverage, Limits)  │
                          └─────────┬───────────┘
                                    │
               ┌────────────────────▼────────────────────┐
               │           EXECUTION LAYER               │
               │                                         │
               │  ┌─────────────┐  ┌──────────────────┐ │
               │  │ Health Guard│  │ Circuit Breaker   │ │
               │  │ (cached)    │  │ (20-window)       │ │
               │  └──────┬──────┘  └────────┬──────────┘ │
               │         │                  │            │
               │  ┌──────▼──────────────────▼──────────┐ │
               │  │     Flash API Transaction Builder  │ │
               │  │     POST /transaction-builder/*    │ │
               │  └──────────────────┬─────────────────┘ │
               │                     │                   │
               │  ┌──────────────────▼─────────────────┐ │
               │  │    Transaction Validation           │ │
               │  │    (6-point pre-sign check)         │ │
               │  └──────────────────┬─────────────────┘ │
               │                     │                   │
               │  ┌──────────────────▼─────────────────┐ │
               │  │    Local Signing (Keypair)          │ │
               │  └──────────────────┬─────────────────┘ │
               │                     │                   │
               │  ┌──────────────────▼─────────────────┐ │
               │  │    Parallel Broadcast              │ │
               │  │    (all RPC endpoints, race)       │ │
               │  └──────────────────┬─────────────────┘ │
               │                     │                   │
               │  ┌──────────────────▼─────────────────┐ │
               │  │    Adaptive Confirmation           │ │
               │  │    (1s/2s polling tiers)            │ │
               │  └──────────────────────────────────────┘ │
               │                                         │
               │  ┌──────────────────────────────────────┐ │
               │  │  Telemetry + Circuit Breaker Update │ │
               │  │  (fire-and-forget, non-blocking)    │ │
               │  └──────────────────────────────────────┘ │
               └─────────────────────────────────────────┘
```

For full module breakdown, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Performance

### Latency Budget

| Stage | Time | Notes |
|---|---|---|
| Health check | 0ms | Cached (10s TTL, background refresh) |
| Circuit breaker | <0.1ms | Synchronous O(1) window check |
| API transaction build | 100-300ms | HTTP keep-alive, connection reuse |
| TX validation | <1ms | Pre-parsed buffer reuse |
| Signing | <0.5ms | Ed25519 local |
| Broadcast | 50-150ms | Parallel race across all endpoints |
| **Total to network** | **~150-450ms** | CLI input → transaction on-chain |

### Optimizations Applied

- **Zero-blocking health check**: cached status returned instantly; stale cache triggers background async refresh
- **HTTP keep-alive**: persistent TCP connections to Flash API eliminate per-request TLS handshake (~100ms saved)
- **Single deserialization**: `validateTransactionBeforeSign` returns pre-parsed `{vtx, rawBytes}` reused by `sendApiTransaction` — no double `Buffer.from` + `VersionedTransaction.deserialize`
- **Parallel broadcast**: `Promise.any` race to all RPC endpoints — fastest endpoint wins
- **Adaptive confirmation**: 1s polling for first 10s (catches fast confirms), 2s after (reduces RPC load)
- **Fire-and-forget telemetry**: `queueMicrotask` for persistence — never blocks the execution path
- **Static imports only**: no `require()` in hot path — all modules resolved at startup

See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for detailed analysis.

---

## Reliability

### Circuit Breaker

```
    ┌──────────┐     ≥5 consecutive      ┌──────────┐
    │  CLOSED  │────failures OR───────▶  │   OPEN   │
    │          │    >40% fail rate        │          │
    └──────────┘                          └────┬─────┘
         ▲                                     │
         │ probe succeeds                      │ cooldown elapsed
         │                                ┌────▼─────┐
         └────────────────────────────────│HALF_OPEN │
                                          │ (1 probe)│
              probe fails ───────────────▶└──────────┘
              (re-open + increase cooldown)
```

- **Window**: last 20 executions
- **Threshold**: >40% failure rate OR 5 consecutive failures
- **Cooldown**: 30s initial, 1.5x exponential backoff, 120s cap
- **HALF_OPEN**: exactly one probe allowed (concurrency guarded)

### Health Guard

- GET /health before every execution
- 10s fresh cache → return immediately (0ms)
- 30s stale cache → return immediately + async background refresh
- Cold/unhealthy → blocking check (fail-fast on failure)

### Structured Errors

Every failure is an `ExecutionError` with machine-readable context:

```typescript
{
  action: 'openPosition',
  endpoint: '/transaction-builder/open-position',
  errorCode: 'API_UNREACHABLE',
  executionId: '8f3a2b1c-...',
  latencyMs: 5023
}
```

See [docs/HARDENING.md](docs/HARDENING.md) for the full vulnerability audit.

---

## Security

### Pre-Sign Transaction Validation (6 checks)

| Check | Threshold | On Failure |
|---|---|---|
| Base64 size | < 10 chars | Throw `TX_VALIDATION_FAILED` |
| Deserialization | Malformed bytes | Throw `TX_VALIDATION_FAILED` |
| Instruction count | 0 | Throw `TX_VALIDATION_FAILED` |
| Account count | 0 or > 256 | Throw `TX_VALIDATION_FAILED` |
| Known program IDs | None found | Warn (log only) |
| Byte size | > 1232 bytes | Debug log (ALTs may compress) |

### Signing Safety

- Keypair integrity verified before every sign operation
- `vtx.sign()` wrapped in try-catch with structured `TX_SIGN_FAILED` error
- Private keys never transmitted — all signing is local

### Additional

- RPC URL SSRF protection (blocks private/internal IPs)
- API response size limits (2MB cap)
- Log scrubbing for API keys and secrets
- Program ID whitelist for instruction validation

See [docs/SECURITY.md](docs/SECURITY.md) for the full threat model.

---

## Installation

```bash
# Clone
git clone https://github.com/Abdr007/bolt-terminal.git
cd bolt-terminal

# Install dependencies
npm install

# Configure
cp .env.example .env
# Edit .env: set RPC_URL, WALLET_PATH

# Build
npm run build

# Run
npm start
```

**Requirements**: Node.js >= 20, Solana wallet keypair

---

## Usage

```bash
# Open a 5x long position on SOL with $100 collateral
open 5x long SOL $100

# Close full position
close SOL

# Partial close (50%)
close 50% SOL

# Add collateral
add $50 collateral SOL long

# Remove collateral
remove $20 collateral SOL long

# Set TP/SL on open
open 3x long ETH $50 tp 4000 sl 3200

# View positions
positions

# View portfolio
portfolio

# Market data
markets
```

FlashEdge supports natural language input. The parser handles variations:

```bash
long BTC 10x $200        # same as: open 10x long BTC $200
short SOL 5x $100        # same as: open 5x short SOL $100
close all                 # close all positions
```

---

## Magic Trading (v2 — MagicBlock ER)

Sub-second confirms via the Flash Trade Magic ER. Sign trades from your
keypair file; positions update on the same on-chain accounts the
official UI reads at https://app.flash.trade/.

### Switching modes

Pick mode 3 at startup, or set `TRADING_MODE=magic` in your env.
Network defaults to mainnet-beta (Pool.0 on `FTv2…hrzV`); set
`MAGIC_NETWORK=devnet` to use Pool.1.

### Daily flow

```bash
flashedge                       # mode 3, your wallet

vault                           # see what's in the vault per token
deposit USDC 100                # fund the vault from your wallet
open SOL long 10 2              # open SOL long, $10 collateral, 2x lev
                                # → preview card, Y/N to confirm
portfolio                       # live PnL + mark + liq per position
close SOL long                  # close it, payout in USDC
withdraw USDC 50                # pull back to your wallet
```

`magic ` prefix is optional in this mode — bare verbs auto-prefix.

### Trading verbs

| Command | Action |
|---|---|
| `open SOL long 10 2` | Open SOL long, $10 coll, 2x lev |
| `close SOL long` | Full close |
| `partial-close SOL long 5` | Close $5 of size, keep the rest |
| `reverse SOL long 10 2` | Close + open opposite atomically |
| `increase SOL long 10` | Add $10 of size at current price |
| `add SOL long 25` | Add $25 collateral (lower leverage) |
| `remove SOL long 10` | Remove $10 collateral (raise leverage) |
| `tp SOL long 95` | Set Take-Profit at $95 |
| `sl SOL long 80` | Set Stop-Loss at $80 |
| `limit SOL long 80 10 2` | Limit order: open at $80, $10 coll, 2x |
| `cancel-limit SOL long <id>` | Cancel a pending limit order |
| `cancel-tp SOL <id>` / `cancel-sl SOL <id>` | Cancel TP/SL |
| `liquidate <owner> SOL long` | Liquidate someone else's underwater position |

### Inspect / status

| Command | Action |
|---|---|
| `vault` | Vault balance per token (deposits / locked / available) |
| `portfolio` | Open positions with live PnL/mark/liq |
| `verify` | CLI ↔ UI parity check (basket + UDL PDAs + Solscan/Explorer links) |
| `price SOL` | Current oracle price for a market |
| `markets` | All 52 markets + leverage caps |
| `status` | Wallet preflight (SOL, UDL, basket, deposits) |
| `inspect` | Network + pool + program + custodies |
| `history` | Recent magic trades (local journal at `~/.flash/magic-history.jsonl`) |
| `dashboard` | At-a-glance: vault + positions + ER health + recent trades |
| `er` | ER router health (latency, last error) |
| `watch` | Live position table with 1s refresh (Enter to exit) |

### UX

- **Y/N preview** before every signed trade. Set `MAGIC_AUTO_CONFIRM=true` to skip.
- **⚡ Latency display** after each command — green <0.5s, yellow <2s, red ≥2s. Timer measures only the post-confirm machine work; the time you spend reading the preview is not counted.
- **Solana Explorer URLs** are copy/paste-safe (URL-encoded customUrl). Override to Solscan with `FLASH_EXPLORER=solscan`.
- **Flexible parsing** — same parser as v1: `open sol long 2x $10`, `open 5x short btc $50`, `add 25 to SOL long` all work.

### Safety

Every magic-mode signing path runs through:
- Program-ID whitelist (`validateInstructionPrograms`)
- Trade caps + rate limit + audit log (`signing-guard.ts`)
- Per-market trade mutex
- Recent-tx signature dedupe (60s)
- Owner keypair integrity check before each sign

The program ID `FTv2RxXarPfNta45HTTMVaGvjzsGg27FXJ3hEKWBhrzV` (mainnet)
and `FMTgsEDaPPfJi1PKD67McLTC5n833T4irbBP53LLxtvj` (devnet) are
already in the base whitelist.

### Performance

- ER blockhash pre-warmer (400ms refresh) — saves a roundtrip per tx.
- Quote cache between preview + open — skips a duplicate simulate after Y/N.
- Auto-settle skipped on hot path (settle has ER-side delegation race issues; manual `settle` still available).

---

## Testing

```bash
npm test
```

```
Test Files:  71 passed | 1 skipped (72)
Tests:       1743 passed | 5 skipped (1748)
Duration:    4.07s
```

Every test runs against deterministic inputs. No network calls. No flaky tests.

---

## Project Structure

```
src/
├── cli/           # Terminal UI, command dispatch, rendering
├── client/        # Flash API client, transaction pipeline
├── core/          # Circuit breaker, health guard, execution errors
├── data/          # Flash API wrapper, price service, analytics
├── observability/ # Telemetry, execution store, metrics
├── network/       # RPC manager, TPU client, leader routing
├── security/      # Signing guard, trading gate, circuit breaker
├── risk/          # Exposure, liquidation, TP/SL engine
├── orders/        # Limit order engine
├── portfolio/     # Allocation, correlation, rebalance
├── scanner/       # Market scanner
├── strategies/    # Momentum, mean-reversion, whale-follow
├── wallet/        # Keypair management, session, balance
└── types/         # All TypeScript interfaces and schemas
```

162 source files. 50,000+ lines. 73 test files. 1,743 tests.

---

## Design Philosophy

> This system prioritizes **determinism**, **safety**, and **performance** over convenience.

- One execution path. Not two with a fallback. One.
- Every failure is structured, traceable, and machine-readable.
- Telemetry never blocks. Disk writes never block. Only the API call and broadcast are on the critical path.
- The system protects itself: circuit breaker trips before cascading failures reach the user.
- No silent degradation. If something fails, it fails loudly and immediately.

---

## Documentation

| Document | Description |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Full system module breakdown |
| [EXECUTION_FLOW.md](docs/EXECUTION_FLOW.md) | Step-by-step execution lifecycle |
| [PERFORMANCE.md](docs/PERFORMANCE.md) | Latency analysis and optimization decisions |
| [SECURITY.md](docs/SECURITY.md) | Threat model and mitigations |
| [HARDENING.md](docs/HARDENING.md) | Adversarial audit findings and fixes |

---

## License

MIT

---

<p align="center">
  <sub>Built for traders who measure in milliseconds.</sub>
</p>
