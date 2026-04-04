# Architecture

## System Overview

Flash Terminal is a CLI-based trading interface for the Flash Trade perpetual futures protocol on Solana. It combines an a structured command interpreter, a tool engine, real-time risk monitoring, and on-chain state reconciliation.

## Command Flow

```
User Input
    |
    v
FlashTerminal (REPL)
    |
    +-- FAST_DISPATCH (single-token commands — instant, no parsing)
    |
    +-- Regex Parser (structured commands — deterministic)
    |
    +-- LLM Engine (natural language — fallback for conversational input)
            |
            v
      ParsedIntent
            |
            v
      ExecutionMiddleware
            |  (logging -> wallet check -> readOnly guard)
            v
      ToolEngine.dispatch()
            |
            +-- flash-tools (trading, wallet, market data)
            +-- agent-tools (analysis, scanner, dashboard)
            +-- plugin tools (dynamically loaded at startup)
            |
            v
      IFlashClient
            |
            +-- FlashClient (live: Flash SDK + Solana transactions)
            +-- SimulatedFlashClient (paper trading, in-memory state)
```

## Subsystems

### CLI Interface (`src/cli/`)

Interactive REPL built on Node.js `readline`. Manages command history, confirmation prompts, mode selection, and prompt rendering. Commands timeout after 120 seconds.

### AI Command Parser (`src/ai/`)

Three-tier intent resolution:

1. **Fast dispatch** — Static lookup table for single-token commands (`positions`, `dashboard`, etc.)
2. **Regex parser** — Deterministic patterns for structured commands (`open 2x long SOL $10`)
3. **LLM engine** — Falls back to an LLM for natural language input when regex fails

Output is always a `ParsedIntent` struct consumed by the tool engine.

### Tool Engine (`src/tools/`)

Maps `ActionType` enums to registered tool functions. The `ToolRegistry` holds all tool definitions with Zod parameter schemas. Tools are registered at startup from built-in modules and dynamically from plugins.

### Execution Engine (`src/client/`)

Two implementations of the `IFlashClient` interface:

- **FlashClient** — Builds and signs Solana transactions via Flash SDK. Manual `MessageV0.compile`, `sendRawTransaction` with retry, HTTP polling for confirmation.
- **SimulatedFlashClient** — In-memory paper trading with fee model, PnL tracking, and mark-to-market pricing.

All tools interact exclusively through `IFlashClient`. They never know which mode is active.

### Risk Monitor (`src/monitor/`)

Background engine that checks liquidation distance on a tiered schedule:

- Price checks every 5 seconds
- Full position refresh every 20 seconds

Uses hysteresis thresholds to prevent alert oscillation:

- Warning: triggers at < 30% distance, recovers at > 35%
- Critical: triggers at < 15% distance, recovers at > 18%

Auto-calculates collateral needed to restore safe distance via binary search.

### State Reconciler (`src/core/`)

Ensures local position state matches blockchain. Runs on:

1. Startup (initial sync)
2. After wallet connect/switch
3. After confirmed transactions (trade verification)
4. Every 60 seconds in live mode (background sync)

Blockchain state is always authoritative. Discrepancies are logged and auto-corrected.

### Protocol Inspector (`src/protocol/`)

Reads Flash Trade protocol state: pools, markets, open interest, utilization. Uses fstats API with 15-second cache and stale-cache fallback on API failure.

### Plugin System (`src/plugins/`)

Plugins are `.ts`/`.js` files in `src/plugins/` that export a `FlashPlugin` object. Loaded dynamically at startup via ESM `import()`. Can register tools, lifecycle hooks (`onInit`, `onShutdown`).

### Scanner & Strategies (`src/scanner/`, `src/strategies/`)

Multi-strategy scanner runs three independent strategies across all markets:

- Momentum (price changes, volume trends)
- Mean reversion (price deviation, open interest)
- Whale follow (on-chain position clustering)

The regime detector classifies current market conditions and adjusts strategy weights.

### Network Layer (`src/network/`)

RPC endpoint management with failover. Validates HTTPS, derives WebSocket URLs, tracks latency.

### Security (`src/security/`)

Signing guard with:

- Confirmation gate before every trade
- Configurable per-trade limits
- Rate limiter (trades per minute, minimum delay)
- Audit log (`~/.flash/signing-audit.log`)

## Directory Structure

```
src/
  index.ts              Entry point, signal handlers, mode selection
  cli/
    terminal.ts         Interactive REPL, confirmation flow, history
  ai/
    interpreter.ts      Intent parsing (regex + LLM fallback)
  types/
    index.ts            All types, enums, interfaces, Zod schemas
  tools/
    engine.ts           Intent -> tool dispatch
    registry.ts         Tool registration and execution
    flash-tools.ts      Trading, wallet, market data tools
  agent/
    agent-tools.ts      Analysis, scanner, dashboard
  client/
    flash-client.ts     Live trading via Flash SDK
    simulation.ts       Paper trading client (in-memory)
  wallet/
    walletManager.ts    Keypair loading, token balance detection
    wallet-store.ts     Persistent wallet storage (~/.flash/wallets/)
    session.ts          Last-used wallet tracking
  config/
    index.ts            Config loader, pool/market mapping
  core/
    execution-middleware.ts  Pre-execution checks
    state-reconciliation.ts  On-chain state sync
  monitor/
    risk-monitor.ts     Real-time liquidation risk monitoring
  risk/
    liquidation-risk.ts Distance-to-liquidation calculations
    exposure.ts         Portfolio exposure analysis
  regime/
    regime-detector.ts  Market regime classification
  protocol/
    protocol-inspector.ts  Protocol state inspection
  network/
    rpc-manager.ts      RPC endpoint management
  system/
    system-diagnostics.ts  System health, tx inspection
  security/
    signing-guard.ts    Transaction signing rate limits
  plugins/
    plugin-loader.ts    Dynamic plugin discovery
  data/
    fstats.ts           Flash Trade stats API client
    coingecko.ts        CoinGecko price data
  utils/
    format.ts           Formatting utilities
    logger.ts           File logger with rotation and key scrubbing
    retry.ts            Retry logic
    safe-math.ts        NaN/Infinity guard
```

## Key Design Decisions

### Dual Client Architecture
`IFlashClient` is the shared interface. `FlashClient` talks to Solana; `SimulatedFlashClient` runs entirely in-memory. All tools use `IFlashClient` — they never know which mode they're in.

### USD Decimal Handling
All USD values from the Flash SDK use `USD_DECIMALS = 6` (not token decimals). This is hardcoded because the SDK reports token decimals for USD fields.

### Numeric Safety
All financial calculations use `safeNumber(value, fallback)` to guard against NaN/Infinity propagation. Every numeric field is validated with `Number.isFinite()` before use.

### Transaction Pipeline
Manual `MessageV0.compile` + `sendRawTransaction` (maxRetries:3) with HTTP polling confirmation. No Address Lookup Tables needed — Flash Trade transactions fit within the 1232-byte limit.
