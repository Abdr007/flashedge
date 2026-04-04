# Changelog

All notable changes to Flash Terminal are documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

---

## [1.1.1] — 2026-03-25

### Production Hardening

- **Runtime State Machine** — ACTIVE/IDLE/DEGRADED states with automatic idle detection (60s inactivity)
- **Central Scheduler** — All background polling loops managed with priority-based throttling (CRITICAL/NORMAL/LOW)
- **Idle Mode** — LOW tasks suspended, NORMAL tasks throttled 5x when user is inactive
- **Circuit Breakers** — Generic `ServiceCircuitBreaker` (CLOSED→OPEN→HALF_OPEN) wired into fstats and Pyth Hermes
- **Event Loop Protection** — Scheduler actively drops tasks when lag >2s, only CRITICAL runs at >5s
- **Memory Backpressure** — RSS-based load shedding at 1.8GB (warning) and 2.5GB (critical)
- **Watchdog** — Detects stuck tasks (>60s) and force-releases them
- **Health Score** — Unified 0-100 score (lag 30pts, errors 25pts, RPC 25pts, memory 20pts)

### Observability

- **`system metrics` command** — Shows health score, scheduler status, circuit breaker states, retry budget
- **`update` command** — Works inside interactive terminal (not just CLI)

### Bug Fixes

- **Timer leak** — `clearTimeout` moved to `finally` block in slack-consumer.ts and webhook-consumer.ts
- **Background noise** — HEALTH/RETRY/ORACLE/MEMORY errors suppressed from terminal prompt (log file only)
- **Memory thresholds** — Raised to 1.8GB (warn) and 2.5GB (critical) for realistic flash-sdk usage
- **Event loop lag thresholds** — Raised to 500ms (warn) and 2s (critical)

### CLI Polish

- Install section added to README top
- Debug commands hidden from help (engine status, benchmark engine)
- Removed FAF typo aliases

---

## [1.1.0] — 2026-03-25

### Background Error Suppression

- HEALTH, RETRY, MEMORY, ORACLE, MAINTENANCE, RECONCILER errors no longer print to terminal prompt — written to log file only

### Threshold Adjustments

- Memory warning: 1.2GB → 1.8GB, critical: 1.8GB → 2.5GB
- Event loop lag warning: 200ms → 500ms, critical: 1s → 2s

---

## [1.0.9] — 2026-03-25

### In-Terminal Update

- `update` command works inside the interactive terminal (previously CLI-only)

---

## [1.0.8] — 2026-03-25

### RPC Management

- **`rpc set <url>`** — Set primary RPC endpoint, persists to `~/.flash/config.json`
- **`rpc add <url>`** — Add backup RPC endpoint for failover
- **`rpc remove <url>`** — Remove a backup endpoint
- **`rpc list`** — Show all configured endpoints with active marker

### Parser Fix

- `@` symbol now treated as `$` in trade commands — `2x sol long @10` works

### Duplicate Trade Cache Removed

- Removed 120-second duplicate trade cache that blocked intentional same-market trades

### Startup Update Check

- Terminal shows update notification on launch when a newer version is available

### Package Fix

- `.env.example` now shipped with npm package

---

## [1.0.7] — 2026-03-25

### Package Fix

- Added `.env.example` to `files` field in package.json

---

## [1.0.6] — 2026-03-25

### Critical Fix

- **Removed circular self-dependency** — `bolt-terminal` was listed as its own dependency, causing install failures

---

## [1.0.1] — 2026-03-16

### Architecture Refinement

- **CLI Modularization** — Extracted `terminal.ts` (4,418 → 2,434 lines) into 4 focused modules: `wallet-flows.ts`, `protocol-views.ts`, `market-monitor.ts`, `dryrun-handler.ts`
- **Tool Modularization** — Split `flash-tools.ts` (3,415 → 1,176 lines) into `wallet-tools.ts`, `analytics-tools.ts`, `protocol-tools.ts`, `order-tools.ts`
- **ESLint max-lines rule** — Warns at 1,200 lines per file to prevent future monoliths

### Limit Order Oracle Reliability

- **Oracle retry on staleness** — If `placeLimitOrder` fails with `ConstraintRaw` (0x7d3), automatically re-fetches fresh Pyth oracle data and retries once before failing

### Latency Optimization

- **Adaptive slot polling** — Leader router switches from 2s to 1s polling during active trade execution for tighter leader awareness
- **RPC connection pre-warming** — Backup endpoints are pre-warmed on startup via lightweight `getSlot` calls for instant failover
- **Broadcast latency profiling** — Per-endpoint `sendRawTransaction` latency is recorded via MetricsCollector

### Observability

- **6 new metrics** — `command_latency_ms`, `cache_hit_total`, `cache_miss_total`, `error_parse_total`, `error_rpc_total`, `error_sdk_total`
- **Request ID correlation** — Each CLI command gets a unique request ID propagated through structured logs
- **Trade structured logging** — `tradeStructured()` method with market/side/leverage/collateral/txSignature fields

### CLI UX

- **Deposit preview** — Earn deposit now shows estimated yearly return at current APY
- **Error humanization** — Better messages for `InsufficientFunds`, `InsufficientBalance`, and `MarketClosed` errors

### Test Suite

- **1,610 tests passing** (65 files, 5 devnet-only skipped)
- **Updated wallet-session tests** — Adapted to new modular file structure

---

## [1.0.0] — 2026-03-15

### Initial Release

Flash Terminal is a production-grade Solana perpetual futures trading CLI for the [Flash Trade](https://www.flash.trade/) protocol.

### Core Features

- **Live Trading** — Open, close, and manage leveraged positions on Flash Trade via Solana mainnet
- **Simulation Mode** — Paper trading with real Pyth oracle prices, no on-chain transactions
- **TP/SL Automation** — Take-profit and stop-loss targets with spike protection (2-tick confirmation)
- **Limit Orders** — Conditional order engine with oracle price constraints
- **Real-Time Monitoring** — Live market tables refreshed every 5 seconds
- **AI Command Parser** — Natural language interpretation with deterministic regex fallback
- **Multi-Pool Support** — Crypto, Virtual, Governance, and Community pools

### Earn System

- **Liquidity Provision** — Deposit USDC to mint FLP (auto-compounding) across all pools
- **FLP Staking** — Stake FLP tokens for USDC rewards (hourly distribution)
- **Yield Analytics** — Pool comparison, yield simulation, demand analysis, rotation suggestions
- **Portfolio Dashboard** — Track LP positions, PnL, and historical APY

### FAF Token Integration

- **Governance Staking** — Stake FAF tokens for VIP tier benefits and revenue sharing
- **Revenue Sharing** — 50% of protocol revenue distributed to stakers in USDC
- **VIP Tiers** — Level 0–5 with fee discounts, referral rebates, and DCA discounts
- **Unstake Management** — 90-day linear unlock with progress tracking

### Safety Systems

- **Signing Guard** — Pre-sign confirmation gate with full trade summary and configurable limits
- **Circuit Breaker** — Automatic trading halt on session/daily loss thresholds
- **Trading Gate (Kill Switch)** — Master switch to disable all trade execution
- **Transaction Simulation** — On-chain simulation before broadcast
- **Program Whitelist** — Only approved Solana programs can be targeted
- **Instruction Freeze** — `Object.freeze()` prevents mutation after validation
- **Duplicate Detection** — Signature cache (120s TTL) prevents resubmission
- **Rate Limiting** — Configurable max trades/min and minimum delay between trades

### Infrastructure

- **RPC Failover** — Multi-endpoint monitoring with automatic switching on slot lag, latency, or failure
- **Crash Recovery** — Trade journal records pending transactions; recovery engine verifies on-chain status on restart
- **State Reconciliation** — Periodic sync with blockchain; on-chain state is always authoritative
- **Dynamic Compute Tuning** — Simulate transactions to estimate CU usage with configurable buffer
- **Structured Logging** — JSON or text format with auto-rotation (10MB), API key scrubbing
- **Alert Webhooks** — Slack and HTTP webhook support for trade events, risk alerts, and system events
- **Shadow Trading** — Mirror trades to parallel risk engine for strategy validation

### Risk Management

- **Risk Monitor** — Background liquidation monitoring with tiered alerts (SAFE / WARNING / CRITICAL)
- **Portfolio Exposure** — Configurable max portfolio exposure limits
- **Liquidation Analysis** — On-chain liquidation price computation with protocol math
- **Market Regime Detection** — Volatility, trend, and liquidity regime classification

### Developer Tooling

- **Plugin System** — Dynamic plugin loading with core tool protection
- **Performance Profiling** — `FLASH_PROFILE=1` enables command/RPC/TX latency tracking
- **Test Suite** — 1505 automated tests covering all systems
- **Coverage Reporting** — V8 coverage with text, LCOV, and HTML reports
- **Pre-Commit Hooks** — Husky + lint-staged enforcing lint, build, and tests
- **CI Pipeline** — GitHub Actions running lint, build, coverage on every push/PR
- **ESLint** — Zero warnings with strict TypeScript rules (no-explicit-any, no-unused-vars)

### Protocol Integration

- **Flash SDK** — Direct integration with Flash Trade on-chain program
- **Pyth Hermes** — Real-time oracle prices with staleness, confidence, and deviation validation
- **fstats API** — Protocol analytics (OI, volume, leaderboard, fees) with response size limits
- **CoinGecko** — Market data for monitoring and regime detection
- **Solana RPC** — Direct blockchain interaction with retry logic and timeout handling

### Documentation

- **README** — Installation, configuration, commands, architecture, security
- **COMMANDS.md** — Complete command reference with examples and aliases
- **ARCHITECTURE.md** — System design, data flow, and subsystem documentation
- **SECURITY.md** — Security policy, threat model, and vulnerability reporting
- **CONTRIBUTING.md** — Development setup, code style, and PR guidelines
- **Plugin API** — Plugin development guide with example plugin
