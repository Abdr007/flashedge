# Project Structure

Flash Terminal is organized into focused modules, each with a single responsibility.

---

## Directory Layout

```
src/
├── index.ts                 Entry point, CLI commands, global error handlers
│
├── cli/
│   └── terminal.ts          Interactive REPL, mode selection, command routing
│
├── ai/
│   ├── interpreter.ts       Natural language → ParsedIntent (AI/Groq/regex)
│   └── signal-aggregator.ts Strategy signal aggregation with regime weights
│
├── tools/
│   ├── engine.ts            Intent → tool dispatch routing
│   ├── registry.ts          Tool registration and execution wrapper
│   └── flash-tools.ts       All tool definitions (trading, wallet, market, data)
│
├── agent/
│   ├── agent-core.ts        AI API client for trade reasoning
│   ├── agent-tools.ts       Analysis, scanner, dashboard tools
│   └── solana-inspector.ts  Cached data aggregator with graceful degradation
│
├── client/
│   ├── flash-client.ts      Live trading client (Flash SDK, Pyth, Solana RPC)
│   └── simulation.ts        Paper trading client with local state
│
├── strategies/
│   ├── momentum.ts          Momentum strategy signal computation
│   ├── mean-reversion.ts    Mean-reversion strategy signal computation
│   └── whale-follow.ts      Whale-follow strategy from on-chain data
│
├── portfolio/
│   ├── allocation-engine.ts Position sizing and portfolio constraint filtering
│   ├── correlation.ts       Cross-market correlation checks
│   ├── portfolio-manager.ts Portfolio state aggregation
│   ├── portfolio-risk.ts    Portfolio-level risk scoring
│   └── rebalance.ts         Directional bias detection and rebalance suggestions
│
├── risk/
│   ├── exposure.ts          Portfolio exposure computation
│   └── liquidation-risk.ts  Per-position liquidation distance calculation
│
├── regime/
│   ├── regime-detector.ts   Market regime classifier (6 regimes)
│   ├── regime-types.ts      Regime enums, weights, state types
│   ├── trend.ts             Trend strength detection
│   ├── volatility.ts        Volatility estimation from price data
│   └── liquidity.ts         Liquidity scoring from volume/OI
│
├── scanner/
│   └── market-scanner.ts    Multi-market opportunity scanner with mutex
│
├── automation/
│   └── autopilot.ts         Automated scan-and-trade loop (simulation only)
│
├── wallet/
│   ├── walletManager.ts     Keypair loading, token balance detection
│   ├── wallet-store.ts      Persistent wallet storage with encryption
│   └── connection.ts        Solana RPC connection factory
│
├── data/
│   ├── prices.ts            CoinGecko price service with bounded cache
│   └── fstats.ts            fstats.io API client (volume, OI, whales, leaderboard)
│
├── config/
│   ├── index.ts             Environment config, pool/market mapping
│   └── risk-config.ts       Autopilot risk parameters
│
├── types/
│   └── index.ts             All types, enums, interfaces, Zod schemas
│
└── utils/
    ├── format.ts            USD/price formatting, table rendering, colors
    ├── logger.ts            Singleton logger with file output and log scrubbing
    ├── retry.ts             Exponential backoff with jitter
    └── safe-math.ts         Defensive numeric helpers
```

---

## Module Responsibilities

### `src/cli/` — Terminal Layer

The interactive REPL that accepts user input, displays output, and manages the session lifecycle. Handles mode selection (simulation vs live), command history, timeouts, and graceful shutdown.

### `src/ai/` — Intelligence Layer

**Interpreter** parses natural language into structured intents using a three-tier fallback: fast dispatch (exact match) → local regex → AI API → Groq API.

**Signal Aggregator** combines strategy signals into a single confidence score using regime-adjusted weights.

### `src/tools/` — Dispatch Layer

Maps parsed intents to tool implementations. Each tool is a self-contained function with Zod parameter validation, execution logic, and formatted output. The registry wraps all tool execution in try/catch.

### `src/agent/` — AI Agent Layer

Higher-level tools that combine multiple data sources: market analysis, portfolio dashboards, risk reports, whale activity displays. The Solana Inspector provides cached access to all data sources with graceful degradation when APIs fail.

### `src/client/` — Execution Layer

**FlashClient** handles live trading through the Flash Trade SDK: transaction building, Pyth oracle prices, simulation, submission, and confirmation with retry logic.

**SimulatedFlashClient** maintains a local paper trading state that mirrors the FlashClient interface.

### `src/strategies/` — Signal Generation

Three independent strategy modules, each producing a `StrategySignal` with direction (bullish/bearish/neutral) and confidence score. Pure functions with no side effects.

### `src/portfolio/` — Portfolio Intelligence

Position sizing, exposure tracking, correlation-aware allocation filtering, and rebalance analysis. Enforces portfolio-level constraints on top of per-trade risk limits.

### `src/risk/` — Risk Assessment

Computes liquidation distances and aggregates portfolio exposure by market and direction.

### `src/regime/` — Market Classification

Detects market conditions (trending, ranging, volatile, etc.) and outputs strategy weight multipliers. Pure computation from cached market data.

### `src/scanner/` — Market Discovery

Scans all available markets, runs strategy signals, and ranks opportunities. Uses a promise-latch mutex to prevent overlapping scans.

### `src/wallet/` — Key Management

Secure keypair storage with sanitized names, owner-only file permissions, key zeroing after use, and path traversal prevention.

### `src/data/` — External Data

API clients for CoinGecko (prices) and fstats.io (volume, open interest, whale activity, leaderboard). Both use bounded caches, timeouts, and null-safe response parsing.

### `src/config/` — Configuration

Environment variable loading with validation, pool-to-market mapping, and autopilot risk parameter definitions.

### `src/utils/` — Shared Utilities

Formatting helpers, structured logger with log scrubbing, retry with exponential backoff, and defensive numeric guards.
