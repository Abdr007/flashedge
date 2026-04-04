<div style="display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 85vh; text-align: center; page-break-after: always;">
  <img src="assets/logo.svg" width="120" height="120" alt="Flash Terminal" style="margin-bottom: 40px;" />
  <h1 style="font-size: 42px; margin: 0 0 8px 0; letter-spacing: 2px;">FLASH TERMINAL</h1>
  <h3 style="font-size: 18px; font-weight: 400; color: #586069; margin: 0 0 40px 0;">Complete Technical Manual</h3>
  <p style="font-size: 13px; color: #24292e; max-width: 480px; line-height: 1.6;">Production-Grade Deterministic CLI Trading Interface<br/>for Flash Trade on Solana</p>
  <p style="font-size: 12px; color: #6a737d; margin-top: 40px;">v1.0.0 — March 2026</p>
</div>

# Table of Contents

- [PART I — INTRODUCTION](#part-i--introduction)
  - [Chapter 1 — What Flash Terminal Is](#chapter-1--what-bolt-terminal-is)
  - [Chapter 2 — The Flash Trade Protocol](#chapter-2--the-flash-trade-protocol)
  - [Chapter 3 — Deterministic Trading Interfaces](#chapter-3--deterministic-trading-interfaces)
- [PART II — SYSTEM ARCHITECTURE](#part-ii--system-architecture)
  - [Chapter 4 — High-Level Architecture](#chapter-4--high-level-architecture)
  - [Chapter 5 — System Components](#chapter-5--system-components)
- [PART III — CLI SYSTEM](#part-iii--cli-system)
  - [Chapter 6 — Command Line Interface Design](#chapter-6--command-line-interface-design)
  - [Chapter 7 — Natural Language Command Interpreter](#chapter-7--natural-language-command-interpreter)
- [PART IV — TRADING ENGINE](#part-iv--trading-engine)
  - [Chapter 8 — Trade Execution Pipeline](#chapter-8--trade-execution-pipeline)
  - [Chapter 9 — Transaction Safety](#chapter-9--transaction-safety)
- [PART V — PROTOCOL INTEGRATION](#part-v--protocol-integration)
  - [Chapter 10 — Flash SDK Integration](#chapter-10--flash-sdk-integration)
  - [Chapter 11 — CustodyAccount and PoolConfig](#chapter-11--custodyaccount-and-poolconfig)
- [PART VI — DATA SYSTEM](#part-vi--data-system)
  - [Chapter 12 — Oracle System](#chapter-12--oracle-system)
  - [Chapter 13 — Analytics Data](#chapter-13--analytics-data)
  - [Chapter 14 — Wallet and Balance System](#chapter-14--wallet-and-balance-system)
- [PART VII — RISK MANAGEMENT](#part-vii--risk-management)
  - [Chapter 15 — Circuit Breaker](#chapter-15--circuit-breaker)
  - [Chapter 16 — Kill Switch](#chapter-16--kill-switch)
  - [Chapter 17 — TP/SL Automation](#chapter-17--tpsl-automation)
- [PART VIII — INFRASTRUCTURE](#part-viii--infrastructure)
  - [Chapter 18 — RPC Failover System](#chapter-18--rpc-failover-system)
  - [Chapter 19 — Leader-Aware Routing](#chapter-19--leader-aware-routing)
  - [Chapter 20 — Crash Recovery](#chapter-20--crash-recovery)
  - [Chapter 21 — State Reconciliation](#chapter-21--state-reconciliation)
- [PART IX — MONITORING](#part-ix--monitoring)
  - [Chapter 22 — Market Monitor](#chapter-22--market-monitor)
  - [Chapter 23 — Protocol Analytics](#chapter-23--protocol-analytics)
- [PART X — TESTING](#part-x--testing)
  - [Chapter 24 — Test Architecture](#chapter-24--test-architecture)
  - [Chapter 25 — Test Strategy](#chapter-25--test-strategy)
- [PART XI — SECURITY](#part-xi--security)
  - [Chapter 26 — Key Management](#chapter-26--key-management)
  - [Chapter 27 — Signing Guard](#chapter-27--signing-guard)
- [PART XII — OPERATIONS](#part-xii--operations)
  - [Chapter 28 — Deployment](#chapter-28--deployment)
  - [Chapter 29 — Documentation System](#chapter-29--documentation-system)
  - [Chapter 30 — Release Process](#chapter-30--release-process)
- [PART XIII — APPENDIX](#part-xiii--appendix)
  - [Appendix A — CLI Command Reference](#appendix-a--cli-command-reference)
  - [Appendix B — Configuration](#appendix-b--configuration)
  - [Appendix C — Data Sources](#appendix-c--data-sources)
  - [Appendix D — System Glossary](#appendix-d--system-glossary)
  - [Appendix E — Troubleshooting Guide](#appendix-e--troubleshooting-guide)

---

<div style="page-break-before: always;"></div>

# PART I — INTRODUCTION

---

## Chapter 1 — What Flash Terminal Is

### 1.1 Purpose

Flash Terminal is a production-grade command line trading interface for the Flash Trade perpetual futures protocol on Solana. It connects directly to the on-chain program through the official Flash SDK, executes leveraged trades on Solana mainnet, and provides real-time position management, risk monitoring, and protocol analytics.

The terminal serves as the bridge between a human trader and the Flash Trade smart contract. Every operation — opening a position, closing a trade, inspecting protocol state — flows through a deterministic pipeline that ensures the same input always produces the same action.

### 1.2 Design Philosophy

Flash Terminal is built on four foundational principles:

```
1. Deterministic systems over probabilistic behavior.
2. Protocol-aligned calculations over reimplementation.
3. Defensive engineering over optimistic assumptions.
4. Blockchain state as the single source of truth.
```

**Deterministic systems** means that trade commands follow a fixed regex-based parsing pipeline. The AI natural language parser handles read-only queries only. No neural network decides whether to open or close a position.

**Protocol-aligned calculations** means that every fee rate, leverage limit, maintenance margin, and liquidation threshold is derived from the on-chain `CustodyAccount` state using Flash SDK helper functions. Nothing is approximated. Nothing is reimplemented.

**Defensive engineering** means that every numeric operation is guarded with `Number.isFinite()` checks. Every cache has a maximum size and TTL eviction. Every external fetch has a timeout. Every file write has a size limit.

**Blockchain state as the single source of truth** means that the state reconciler periodically fetches on-chain positions and overwrites local state when mismatches are detected. The terminal never assumes its local view is correct.

### 1.3 Engineering Profile

| Metric | Value |
|:-------|:------|
| Language | TypeScript (strict mode) |
| Module System | ESM (ECMAScript Modules) |
| Lines of Code | ~28,000 |
| Automated Tests | 462 (28 test files) |
| Test Duration | ~1.3 seconds |
| Compiler Errors | 0 |
| Audit Score | 94/100 |
| Critical Issues | 0 |

### 1.4 What Flash Terminal Is Not

Flash Terminal does not fabricate data. If a price feed is unreachable, the terminal shows an error — it does not generate a synthetic value. Flash Terminal does not provide financial advice, generate trading signals, or make autonomous trading decisions. Flash Terminal does not reimplement any protocol math — all calculations flow through the official Flash SDK.

---

<div style="page-break-before: always;"></div>

## Chapter 2 — The Flash Trade Protocol

### 2.1 Protocol Overview

Flash Trade is a decentralized perpetual futures protocol deployed on Solana. It allows traders to open leveraged long and short positions on a variety of assets including cryptocurrencies, commodities, forex pairs, and US equities.

The protocol operates through on-chain Solana programs that manage:

- **Pools** — Liquidity pools that group related markets (Crypto.1, Virtual.1, Governance.1, etc.)
- **Custodies** — Per-market accounts that store fee rates, leverage limits, and margin parameters
- **Positions** — Per-user accounts that track entry price, size, collateral, and side

### 2.2 Pool Architecture

Flash Trade organizes markets into pools. Each pool contains one or more custody accounts, each representing a tradeable market.

```
Flash Trade Protocol
├── Crypto.1        → SOL, BTC, ETH, ZEC, BNB
├── Virtual.1       → XAU, XAG, EUR, GBP, CRUDEOIL, USDJPY, USDCNH
├── Governance.1    → JUP, PYTH, JTO, RAY, KMNO, MET, HYPE
├── Community.1     → BONK, PENGU, PUMP
├── Community.2     → WIF
├── Trump.1         → FARTCOIN
├── Ore.1           → ORE
└── Ondo.1          → SPY, NVDA, TSLA, AAPL, AMD, AMZN, PLTR (coming soon)
```

### 2.3 Fee Model

Flash Trade uses a **borrow/lock fee model**, not periodic funding rates. Fees are deducted from collateral at the time of trade execution. The fee rates are stored on-chain in `CustodyAccount.fees` and normalized by `RATE_POWER`.

| Fee Type | Source | When Applied |
|:---------|:-------|:-------------|
| Open fee | `CustodyAccount.fees.openPosition` / `RATE_POWER` | At position open |
| Close fee | `CustodyAccount.fees.closePosition` / `RATE_POWER` | At position close |
| Borrow fee | `CustodyAccount.fees.borrowRate` | Ongoing, from collateral |

### 2.4 Oracle System

Flash Trade uses **Pyth Network** as its oracle provider. The same Pyth Hermes oracle feeds used by the on-chain program are used by Flash Terminal to display prices, calculate PnL, and estimate liquidation levels. This ensures price parity between what the terminal displays and what the protocol executes.

### 2.5 Position Mechanics

A perpetual futures position on Flash Trade consists of:

| Field | Description |
|:------|:------------|
| Market | The asset being traded (SOL, BTC, etc.) |
| Side | LONG (profit when price rises) or SHORT (profit when price falls) |
| Collateral | USD amount deposited as margin |
| Size | Leveraged position size (collateral × leverage) |
| Entry Price | Oracle price at time of position opening |
| Leverage | Multiplier applied to collateral |
| Liquidation Price | Price at which the position is forcibly closed |

The protocol enforces that only one position can exist per market per side per wallet. Attempting to open a duplicate position is rejected by the on-chain program.

---

<div style="page-break-before: always;"></div>

## Chapter 3 — Deterministic Trading Interfaces

### 3.1 The Problem with Probabilistic Trading

A probabilistic trading interface is one where the same input can produce different outputs depending on context, model state, or interpretation. When a user types "buy SOL," a probabilistic system might interpret this as opening a long position, adding to an existing position, or asking for a price quote — depending on the model's internal state.

In financial systems, this ambiguity is unacceptable. A trade command must be deterministic: the same input must always produce the same action.

### 3.2 Flash Terminal's Approach

Flash Terminal implements a **dual-path parsing architecture**:

```
User Input
    │
    ├──► Regex Parser (deterministic) ──► Trade Commands
    │    Same input → same output
    │    Handles: open, close, add, remove, set tp/sl
    │
    └──► AI Parser (read-only fallback) ──► Query Commands
         Natural language interpretation
         Handles: "what's the price of SOL?", "show me BTC analysis"
         NEVER handles: open, close, or any transaction-signing command
```

**Trade commands** are parsed by deterministic regex patterns. The string `open 5x long SOL $500` is always parsed into the same structured intent: `{ action: OpenPosition, leverage: 5, side: long, market: SOL, collateral: 500 }`.

**Read-only queries** may optionally pass through an AI parser (Anthropic Claude or Groq) when the regex parser does not match. The AI parser can only return read-only action types — it can never return a trade action.

### 3.3 The AI Boundary

The AI boundary is the line between deterministic and probabilistic processing. In Flash Terminal, this boundary is enforced structurally:

| Layer | AI Involved? | Description |
|:------|:-------------|:------------|
| CLI Interface | No | Keystrokes to raw string |
| Regex Parser | No | Deterministic intent extraction |
| AI Fallback | Read-only only | Natural language for queries |
| Tool Engine | No | Intent to tool dispatch |
| Safety Pipeline | Never | Validation, simulation, signing |
| Protocol Layer | Never | On-chain transaction execution |

No code path exists where an AI model can influence a transaction-signing operation. This is enforced at the type level through Zod schema validation — trade action types are only constructable through the regex parser.

---

<div style="page-break-before: always;"></div>

# PART II — SYSTEM ARCHITECTURE

---

## Chapter 4 — High-Level Architecture

### 4.1 Layer Diagram

Flash Terminal is organized into five distinct layers. Each layer communicates only with its adjacent layers. Data flows downward from user input to the blockchain.

```
┌─────────────────────────────────────────────────────┐
│  Layer 1 — Interface                                │
│  CLI REPL · readline · autocomplete · status bar    │
└──────────────────────┬──────────────────────────────┘
                       │ raw input string
┌──────────────────────▼──────────────────────────────┐
│  Layer 2 — Interpretation                           │
│  Regex parser (trades) · NLP fallback (read-only)   │
│  Zod schema validation · market resolution          │
└──────────────────────┬──────────────────────────────┘
                       │ ParsedIntent (typed, validated)
┌──────────────────────▼──────────────────────────────┐
│  Layer 3 — Execution                                │
│  Tool dispatch · flash-tools · agent-tools · plugins│
└──────────────────────┬──────────────────────────────┘
                       │ trade parameters
┌──────────────────────▼──────────────────────────────┐
│  Layer 4 — Safety Pipeline                          │
│  Trade limits · rate limiter · confirmation gate    │
│  Signing audit · program whitelist · instruction    │
│  freeze · pre-send simulation                       │
└──────────────────────┬──────────────────────────────┘
                       │ frozen, validated transaction
┌──────────────────────▼──────────────────────────────┐
│  Layer 5 — Protocol                                 │
│  Flash SDK · Solana RPC · failover · reconciliation │
└──────────────────────┬──────────────────────────────┘
                       │
                  [ Blockchain ]
```

### 4.2 Data Flow

```
                  ┌──────────────┐
                  │  Pyth Hermes │ ── Oracle prices (5s cache)
                  └──────┬───────┘
                         │
┌──────────┐    ┌────────▼────────┐    ┌──────────────┐
│ Flash SDK│────│  Flash Terminal │────│  fstats API  │
│          │    │                 │    │              │
│PoolConfig│    │  IFlashClient  │    │ OI, volume   │
│Custody   │    │  RPC Manager   │    │ whales, fees │
│Position  │    │  Risk Monitor  │    │ leaderboard  │
└──────────┘    └────────┬───────┘    └──────────────┘
                         │
                ┌────────▼────────┐
                │   Solana RPC    │
                │  (multi-endpoint│
                │   with failover)│
                └────────┬────────┘
                         │
                ┌────────▼────────┐
                │  Flash Trade    │
                │  Program        │
                └─────────────────┘
```

### 4.3 Layer Boundaries

| Layer | Input | Output | AI Involved? |
|:------|:------|:-------|:-------------|
| Interface | Keystrokes | Raw string | No |
| Interpretation | Raw string | `ParsedIntent` | Read-only queries only |
| Execution | `ParsedIntent` | Trade parameters | Analysis tools only |
| Safety Pipeline | Trade parameters | Frozen transaction | Never |
| Protocol | Transaction | On-chain state change | Never |

---

<div style="page-break-before: always;"></div>

## Chapter 5 — System Components

### 5.1 Directory Structure

```
src/
├── cli/              Terminal REPL, command registry, status bar, theme
├── ai/               Intent parsing (regex + NLP fallback)
├── tools/            Tool engine, tool registry, trading tools
├── agent/            Agent tools (analysis, dashboard, portfolio intelligence)
├── client/           FlashClient (live) and SimulatedFlashClient (paper)
├── core/             Transaction engine, state reconciliation, execution middleware
├── risk/             TP/SL engine, exposure analysis, liquidation risk
├── monitor/          Risk monitor, event monitor
├── security/         Signing guard, circuit breaker, trading gate
├── network/          RPC manager, multi-endpoint failover
├── protocol/         Protocol inspector (pool/market/OI inspection)
├── wallet/           Keypair management, wallet store, session persistence
├── journal/          Trade journal, crash recovery engine
├── data/             PriceService (Pyth Hermes), FStatsClient, protocol stats
├── config/           Configuration loader, pool mapping, market discovery
├── observability/    Metrics collector, alert hooks
├── plugins/          Dynamic plugin loader
├── types/            Types, enums, Zod schemas
└── utils/            Logger, formatting, safe math, protocol liquidation
```

### 5.2 Component Interaction Diagram

```
┌────────────────────────────────────────────────────────────────┐
│                        CLI TERMINAL                            │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌─────────────┐  │
│  │ readline │  │ completer │  │ statusbar│  │ theme       │  │
│  └────┬─────┘  └───────────┘  └──────────┘  └─────────────┘  │
│       │                                                        │
│       ▼                                                        │
│  ┌────────────────┐    ┌──────────────────┐                   │
│  │ Command        │    │ AI Interpreter   │                   │
│  │ Registry       │───▶│ (regex + NLP)    │                   │
│  │ (FAST_DISPATCH)│    │                  │                   │
│  └────────┬───────┘    └────────┬─────────┘                   │
│           │                     │                              │
│           ▼                     ▼                              │
│  ┌─────────────────────────────────────────┐                  │
│  │           TOOL ENGINE                   │                  │
│  │  ┌──────────────┐  ┌────────────────┐   │                  │
│  │  │ flash-tools  │  │ agent-tools    │   │                  │
│  │  │ (trading,    │  │ (analysis,     │   │                  │
│  │  │  wallet,     │  │  dashboard,    │   │                  │
│  │  │  protocol)   │  │  portfolio)    │   │                  │
│  │  └──────┬───────┘  └───────┬────────┘   │                  │
│  └─────────┼──────────────────┼────────────┘                  │
│            │                  │                                │
│            ▼                  ▼                                │
│  ┌──────────────────────────────────────────┐                 │
│  │         SAFETY PIPELINE                  │                 │
│  │  Trading Gate → Circuit Breaker →        │                 │
│  │  Signing Guard → Rate Limiter →          │                 │
│  │  Confirmation → Audit Log                │                 │
│  └──────────────────┬───────────────────────┘                 │
│                     │                                          │
│                     ▼                                          │
│  ┌──────────────────────────────────────────┐                 │
│  │         FLASH CLIENT                     │                 │
│  │  ┌────────────┐  ┌──────────────────┐    │                 │
│  │  │ FlashClient│  │ SimulatedFlash   │    │                 │
│  │  │ (live)     │  │ Client (paper)   │    │                 │
│  │  └──────┬─────┘  └──────────────────┘    │                 │
│  └─────────┼────────────────────────────────┘                 │
│            │                                                   │
└────────────┼───────────────────────────────────────────────────┘
             │
             ▼
    ┌─────────────────┐     ┌──────────────┐     ┌────────────┐
    │  Solana RPC     │     │ Pyth Hermes  │     │ fstats API │
    │  (with failover)│     │ (oracle)     │     │ (analytics)│
    └────────┬────────┘     └──────────────┘     └────────────┘
             │
    ┌────────▼────────┐
    │  Flash Trade    │
    │  On-Chain       │
    │  Program        │
    └─────────────────┘
```

### 5.3 Singleton Architecture

Several components are implemented as singletons to ensure consistent state across the application:

| Singleton | Accessor | Purpose |
|:----------|:---------|:--------|
| `RiskMonitor` | `getRiskMonitor()` | Background position risk monitoring |
| `TpSlEngine` | `getTpSlEngine()` | Take-profit / stop-loss automation |
| `CircuitBreaker` | `getCircuitBreaker()` | Loss-based trading halt |
| `TradingGate` | `getTradingGate()` | Kill switch and exposure control |
| `SigningGuard` | `getSigningGuard()` | Rate limiting and trade limits |
| `MetricsCollector` | `getMetrics()` | Counters and histograms |
| `StateReconciler` | `getReconciler()` | Blockchain state sync |
| `Logger` | `getLogger()` | Application-wide logging |

---

<div style="page-break-before: always;"></div>

# PART III — CLI SYSTEM

---

## Chapter 6 — Command Line Interface Design

### 6.1 Interactive REPL

Flash Terminal operates as an interactive Read-Eval-Print Loop (REPL) built on Node.js `readline`. The terminal presents a prompt that indicates the current operating mode:

```
flash [sim] >     # Simulation mode (paper trading)
flash [live] >    # Live trading mode (real transactions)
```

### 6.2 Startup Sequence

```
Application Start
    │
    ├──► Load configuration (.env)
    ├──► Validate RPC URL (HTTPS required, no internal IPs)
    ├──► Show mode selection (1: LIVE, 2: SIMULATION, 3: Exit)
    │
    ├──► If LIVE:
    │    ├──► Prompt wallet selection (saved, import, create)
    │    ├──► Load keypair with security validation
    │    ├──► Initialize FlashClient with Flash SDK
    │    └──► Start state reconciler (60s interval)
    │
    ├──► If SIMULATION:
    │    ├──► Initialize SimulatedFlashClient ($10,000 starting balance)
    │    └──► Fetch live Pyth oracle prices for paper trading
    │
    ├──► Initialize subsystems:
    │    ├──► RPC Manager (primary + backup endpoints)
    │    ├──► Tool Engine (register all tools)
    │    ├──► Signing Guard (rate limits, trade limits)
    │    ├──► TP/SL Engine (close executor callback)
    │    ├──► Plugin Loader (discover and register plugins)
    │    └──► Background maintenance timer
    │
    └──► Enter REPL loop
```

### 6.3 Command Dispatch

Every user input follows this dispatch pipeline:

```
Raw Input
    │
    ├──► Trim and normalize
    │
    ├──► Check FAST_DISPATCH map (exact match)
    │    │
    │    ├──► Match found → Create ParsedIntent → Tool Engine
    │    │
    │    └──► No match → Continue
    │
    ├──► Check special commands (exit, help, degen, doctor)
    │
    ├──► Interpreter.parse(input)
    │    │
    │    ├──► Regex patterns (deterministic)
    │    │    ├──► Trade commands (open, close, add, remove)
    │    │    ├──► TP/SL commands (set tp, set sl, remove tp)
    │    │    ├──► Parameterized commands (analyze, inspect, etc.)
    │    │    └──► Returns ParsedIntent or null
    │    │
    │    └──► AI fallback (if regex returns null AND API key configured)
    │         ├──► Anthropic Claude (haiku, temp=0)
    │         ├──► Groq (llama-3.3-70b) as secondary fallback
    │         └──► Returns read-only ParsedIntent or null
    │
    └──► Tool Engine.dispatch(intent)
         │
         ├──► Execution Middleware (wallet check, read-only check)
         ├──► Tool Mapping (intent → tool name + params)
         └──► Tool Registry.execute(tool, params, context)
```

### 6.4 Command Registry

The command registry (`src/cli/command-registry.ts`) is the single source of truth for all CLI commands. It is a pure data structure with no runtime dependencies.

Each command entry contains:

```typescript
interface CommandEntry {
  name: string;           // Primary command text
  action: ActionType | null; // Dispatch action (null = special routing)
  category: CommandCategory; // Help grouping
  description: string;    // Help text
  helpFormat?: string;    // Display format (e.g., 'open 5x long SOL $500')
  aliases?: string[];     // Alternative triggers
  dispatchAliases?: string[]; // Dispatch-only (hidden from autocomplete)
  hidden?: boolean;       // Hidden from help
  parameterized?: boolean; // Takes arguments
}
```

The `buildFastDispatch()` function constructs a lookup map from this registry for O(1) command resolution.

### 6.5 Confirmation Handling

All trade commands require explicit user confirmation before signing. The confirmation gate displays a full trade summary:

```
  CONFIRM TRANSACTION
  ─────────────────────────────────
  Market:      SOL LONG
  Pool:        Crypto.1
  Leverage:    2x
  Collateral:  $100.00 USDC
  Size:        $200.00
  Est. Fee:    $0.1600  (0.08%)
  Wallet:      Dvvzg9rwaNfUqBSscoMZJa5CHFv8Lm94ngZrRyLGLfmK

  This will execute a REAL on-chain transaction.

  Type "yes" to sign or "no" to cancel (yes/no)
```

In simulation mode, the wallet address displays a simulation identifier. In live mode, the full Solana public key is shown with an explicit warning about real transactions.

### 6.6 Autocomplete

The autocomplete system is driven by the command registry. All primary command names and their aliases are extracted via `getAutocompleteCommands()` and provided to the readline completer. Tab completion matches the beginning of any registered command.

---

<div style="page-break-before: always;"></div>

## Chapter 7 — Natural Language Command Interpreter

### 7.1 Architecture

The interpreter (`src/ai/interpreter.ts`) implements a three-stage parsing strategy:

```
Stage 1: Local Regex Parser (deterministic, <1ms)
    │
    ├──► Match found → Return ParsedIntent
    │
    └──► No match ↓

Stage 2: Contextual Follow-Up (deterministic, <1ms)
    │
    ├──► Recent context exists (2min TTL)?
    │    ├──► "close it" → use last market/side
    │    ├──► "add $X" → use last market/side
    │    └──► "analyze it" → use last market
    │
    └──► No match ↓

Stage 3: AI Parser (probabilistic, ~1-3s)
    │
    ├──► Anthropic Claude (claude-haiku-4-5-20251001, temp=0)
    ├──► Groq fallback (llama-3.3-70b-versatile)
    └──► Returns read-only ParsedIntent or null
```

### 7.2 Regex Parser

The regex parser handles all trade commands with deterministic patterns:

**Open Position:**
```
Pattern: /^(?:dryrun\s+)?open\s+(\d+(?:\.\d+)?)x?\s+(long|short)\s+([a-z]+)\s+\$?(\d+(?:\.\d+)?)/
Example: "open 5x long SOL $500"
Captures: leverage=5, side=long, market=SOL, collateral=500
```

**Close Position:**
```
Pattern: /^close\s+([a-z]+)\s+(long|short)$/
Example: "close SOL long"
Captures: market=SOL, side=long
```

**Add Collateral:**
```
Pattern: /^add\s+\$?(\d+(?:\.\d+)?)\s+(?:to\s+)?([a-z]+)\s+(long|short)$/
Example: "add $50 to SOL long"
Captures: amount=50, market=SOL, side=long
```

**Remove Collateral:**
```
Pattern: /^remove\s+\$?(\d+(?:\.\d+)?)\s+(?:from\s+)?([a-z]+)\s+(long|short)$/
Example: "remove $20 from ETH long"
Captures: amount=20, market=ETH, side=long
```

**Set TP/SL (two formats):**
```
Pattern 1: /^set\s+(tp|sl)\s+([a-z]+)\s+(long|short)\s+\$?(\d+(?:\.\d+)?)$/
Example: "set tp SOL long $160"

Pattern 2: /^set\s+(tp|sl)\s+\$?(\d+(?:\.\d+)?)\s+(?:for\s+)?([a-z]+)\s+(long|short)$/
Example: "set tp 160 for SOL long"
```

**Inline TP/SL on Open:**
```
Pattern: open 2x long SOL $100 tp $160 sl $120
Result: OpenPosition intent with takeProfit=160, stopLoss=120
```

### 7.3 Asset Normalization

The interpreter normalizes asset names before market resolution:

| Input | Normalized | Resolved |
|:------|:-----------|:---------|
| `solana` | `SOL` | SOL |
| `bitcoin` | `BTC` | BTC |
| `ethereum` | `ETH` | ETH |
| `crude oil` | `CRUDEOIL` | CRUDEOIL |
| `gold` | `XAU` | XAU |
| `silver` | `XAG` | XAG |

The market resolution function `resolveMarket()` from `src/utils/market-resolver.ts` handles case-insensitive matching and alias expansion.

### 7.4 AI Parser Constraints

When the AI parser is invoked, it operates under strict constraints:

- **Temperature**: 0 (fully deterministic for the same input)
- **Max tokens**: 256 (prevents verbose responses)
- **Input limit**: 500 characters
- **Timeout**: 15 seconds
- **Response validation**: Must be valid JSON matching a Zod schema
- **Positive values enforced**: Collateral and amounts must be positive
- **Read-only actions only**: The AI cannot return trade action types

### 7.5 Zod Schema Validation

Every parsed intent is validated through a Zod discriminated union before dispatch:

```typescript
export const ParsedIntentSchema = z.discriminatedUnion('action', [
  OpenPositionSchema,    // market, side, collateral (>0, ≤10M), leverage (1-100)
  ClosePositionSchema,   // market, side
  AddCollateralSchema,   // market, side, amount (>0, ≤10M)
  RemoveCollateralSchema,// market, side, amount (>0, ≤10M)
  // ... 40+ additional schemas
]);
```

If the Zod validation fails, the intent is rejected and the user sees a clear error message. This prevents malformed data from reaching the trading engine.

---

<div style="page-break-before: always;"></div>

# PART IV — TRADING ENGINE

---

## Chapter 8 — Trade Execution Pipeline

### 8.1 The 11-Stage Pipeline

Every trade passes through an 11-stage pipeline before reaching the blockchain. Each stage can independently reject the trade.

| Stage | Module | What It Does |
|:------|:-------|:-------------|
| **1. Regex Parse** | `interpreter.ts` | Extracts structured intent from user input using deterministic regex |
| **2. Zod Validate** | `types/index.ts` | Enforces parameter types and ranges (leverage 1–100x, collateral $10–$10M) |
| **3. Market Resolve** | `config/index.ts` | Maps symbol to Flash Trade pool via `getPoolForMarket()`, checks trading hours |
| **4. Trade Builder** | `flash-tools.ts` | Computes position size, estimates fees from on-chain `CustodyAccount` data |
| **5. Trade Limits** | `signing-guard.ts` | Enforces configurable caps (`MAX_COLLATERAL_PER_TRADE`, `MAX_POSITION_SIZE`, `MAX_LEVERAGE`) |
| **6. Rate Limiter** | `signing-guard.ts` | Prevents rapid submissions (default: 10/min, 3s minimum delay) |
| **7. Confirmation Gate** | `flash-tools.ts` | Displays full trade summary with risk preview, requires explicit `yes` |
| **8. Signing Audit** | `signing-guard.ts` | Logs trade attempt to `~/.flash/signing-audit.log` (never logs keys) |
| **9. Program Whitelist** | `flash-client.ts` | Validates all instructions against approved programs, then freezes with `Object.freeze()` |
| **10. Pre-Send Simulation** | `flash-client.ts` | Simulates transaction on-chain (~200ms). Program errors abort immediately |
| **11. Broadcast + Reconcile** | `flash-client.ts` | Sends transaction, polls confirmation for 45s, verifies position on-chain |

### 8.2 Sequence Diagram — Open Position

```
User                Terminal              Safety          FlashClient        Solana
 │                     │                    │                │                │
 │  "open 2x long     │                    │                │                │
 │   SOL $100"        │                    │                │                │
 │────────────────────▶│                    │                │                │
 │                     │                    │                │                │
 │                     │ Parse + Validate   │                │                │
 │                     │ (regex + Zod)      │                │                │
 │                     │                    │                │                │
 │                     │ Check Kill Switch ─▶│                │                │
 │                     │                    │──▶ OK          │                │
 │                     │                    │                │                │
 │                     │ Check Circuit     ─▶│                │                │
 │                     │ Breaker            │──▶ OK          │                │
 │                     │                    │                │                │
 │                     │ Check Trade Limits ▶│                │                │
 │                     │                    │──▶ OK          │                │
 │                     │                    │                │                │
 │                     │ Check Rate Limit  ─▶│                │                │
 │                     │                    │──▶ OK          │                │
 │                     │                    │                │                │
 │  CONFIRM TX         │                    │                │                │
 │  ──────────────     │                    │                │                │
 │  Market: SOL LONG   │                    │                │                │
 │  Leverage: 2x       │                    │                │                │
 │  Collateral: $100   │                    │                │                │
 │  Size: $200         │                    │                │                │
 │  Fee: $0.16         │                    │                │                │
 │◀────────────────────│                    │                │                │
 │                     │                    │                │                │
 │  "yes"              │                    │                │                │
 │────────────────────▶│                    │                │                │
 │                     │                    │                │                │
 │                     │ Audit Log ────────▶│                │                │
 │                     │                    │                │                │
 │                     │ Record in Journal  │                │                │
 │                     │ (pending)          │                │                │
 │                     │                    │                │                │
 │                     │ openPosition() ────────────────────▶│                │
 │                     │                    │                │                │
 │                     │                    │    Verify Keypair Integrity     │
 │                     │                    │    Check Duplicate Position     │
 │                     │                    │    Check USDC Balance           │
 │                     │                    │    Build TX Instructions        │
 │                     │                    │                │                │
 │                     │                    │    Validate Program IDs ──▶ ✓   │
 │                     │                    │    Object.freeze(instructions)  │
 │                     │                    │                │                │
 │                     │                    │    Simulate TX ────────────────▶│
 │                     │                    │                │◀───── OK ──────│
 │                     │                    │                │                │
 │                     │                    │    Sign + Broadcast ──────────▶│
 │                     │                    │                │                │
 │                     │                    │    Poll Confirmation ─────────▶│
 │                     │                    │                │◀── Confirmed ──│
 │                     │                    │                │                │
 │                     │ Update Journal     │                │                │
 │                     │ (confirmed)        │                │                │
 │                     │                    │                │                │
 │                     │ verifyTrade() ─────────────────────▶│                │
 │                     │                    │                │◀── Position ───│
 │                     │                    │                │    exists      │
 │                     │                    │                │                │
 │  Position Opened    │                    │                │                │
 │  Entry: $87.12      │                    │                │                │
 │  Liq: $43.65        │                    │                │                │
 │  TX: solscan.io/... │                    │                │                │
 │◀────────────────────│                    │                │                │
```

### 8.3 Transaction Construction

The `sendTx()` method in `FlashClient` constructs and sends transactions through a multi-attempt pipeline:

```
sendTx(instructions, signers)
    │
    ├──► Verify keypair integrity (non-zero secret key)
    │
    ├──► Validate instruction programs (whitelist check)
    │
    ├──► Object.freeze(instructions) — prevent mutation
    │
    └──► Attempt Loop (max 3 attempts)
         │
         ├──► Capture current connection reference
         │
         ├──► If retry: check if previous signature landed
         │    (prevents duplicate broadcast)
         │
         ├──► Fetch blockhash
         │    ├──► Attempt 1: use 10s cached if fresh
         │    └──► Retries: always fetch fresh
         │
         ├──► Compile MessageV0 (with compute budget)
         │
         ├──► If attempt 1: pre-send simulation
         │    ├──► Program error → throw immediately (no retry)
         │    └──► Non-critical failure → log and continue
         │
         ├──► sendRawTransaction(maxRetries: 3, skipPreflight: true)
         │
         ├──► Confirmation polling (45s timeout)
         │    ├──► Poll every 2s with getSignatureStatuses()
         │    ├──► Resend every 2nd poll
         │    └──► Late detection: final status check before timeout
         │
         └──► On network error: trigger RPC failover, retry
```

### 8.4 Trade Mutex

The `FlashClient` maintains a `Set<string>` of active trades keyed by `market:side`. This prevents concurrent trades on the same market and side:

```typescript
private activeTrades = new Set<string>();

// Before trade:
const key = `${market}:${side}`;
if (this.activeTrades.has(key)) {
  throw new Error('Trade already in progress for this market/side');
}
this.activeTrades.add(key);

try {
  // ... execute trade ...
} finally {
  this.activeTrades.delete(key);
}
```

### 8.5 Duplicate Trade Detection

A 120-second TTL cache prevents re-submission of recently broadcast transactions:

```typescript
private recentTrades = new Map<string, number>(); // key → timestamp

// Cache key format: "action:market:side[:amount]"
// Example: "open:SOL:long:100"

// Before broadcast:
const cacheKey = buildCacheKey(action, market, side, amount);
const lastTime = this.recentTrades.get(cacheKey);
if (lastTime && Date.now() - lastTime < TRADE_CACHE_TTL_MS) {
  throw new Error('Duplicate trade detected — recently submitted');
}
```

---

<div style="page-break-before: always;"></div>

## Chapter 9 — Transaction Safety

### 9.1 Program ID Whitelist

Before any transaction is signed, every instruction is validated against a whitelist of approved Solana programs:

**Approved Programs:**

| Program | Purpose |
|:--------|:--------|
| System Program | SOL transfers |
| Token Program | SPL token operations |
| Token 2022 Program | Token extensions |
| Associated Token Account | ATA creation |
| Compute Budget Program | CU limits and priority fees |
| Sysvar Programs | Clock, rent, etc. |
| Flash Trade Program(s) | Loaded dynamically per pool from `PoolConfig` |

If any instruction targets a program not in this whitelist, the transaction is rejected before signing.

```typescript
function validateInstructionPrograms(
  instructions: TransactionInstruction[],
  allowedPrograms: Set<string>
): void {
  for (const ix of instructions) {
    if (!allowedPrograms.has(ix.programId.toBase58())) {
      throw new Error(
        `Unauthorized program: ${ix.programId.toBase58()}`
      );
    }
  }
}
```

### 9.2 Instruction Freezing

After program validation, the instruction array is frozen to prevent mutation between validation and signing:

```typescript
// After validation:
const frozenInstructions = Object.freeze([...instructions]);

// Any attempt to modify frozenInstructions after this point
// will throw a TypeError in strict mode.
```

This prevents a class of attacks where instructions could be modified after validation but before the transaction is signed and broadcast.

### 9.3 Pre-Send Simulation

On the first attempt of every transaction, the terminal simulates the transaction on-chain before broadcasting:

```typescript
const simulation = await connection.simulateTransaction(tx, {
  sigVerify: false,
  commitment: 'confirmed',
});

if (simulation.value.err) {
  // Program error — abort immediately, do not retry
  throw new ProgramError(simulation.value.err, simulation.value.logs);
}
```

Simulation catches program errors (insufficient funds, invalid parameters, etc.) before any real transaction is broadcast. The simulation costs no SOL and takes approximately 200ms.

### 9.4 Compute Budget

Every transaction includes two compute budget instructions:

```typescript
// Set compute unit limit
ComputeBudgetProgram.setComputeUnitLimit({
  units: config.computeUnitLimit  // default: 600,000
});

// Set compute unit price (priority fee)
ComputeBudgetProgram.setComputeUnitPrice({
  microLamports: config.computeUnitPrice  // default: 500,000
});
```

The priority fee ensures transactions are processed during periods of network congestion.

---

<div style="page-break-before: always;"></div>

# PART V — PROTOCOL INTEGRATION

---

## Chapter 10 — Flash SDK Integration

### 10.1 SDK Usage

Flash Terminal uses the official `flash-sdk` package (v15.5.5+) for all protocol interactions. The SDK provides:

- `PerpetualsClient` — The primary client for position operations
- `PoolConfig` — Static pool and market configuration
- `getLiquidationPriceContractHelper()` — On-chain liquidation math
- `getUserPositions()` — Fetch all positions for a wallet

### 10.2 Client Interface

Both the live client and simulation client implement the `IFlashClient` interface:

```typescript
interface IFlashClient {
  openPosition(market: string, side: TradeSide, collateral: number,
               leverage: number, options?: TradeOptions): Promise<TradeResult>;
  closePosition(market: string, side: TradeSide): Promise<TradeResult>;
  addCollateral(market: string, side: TradeSide, amount: number): Promise<TradeResult>;
  removeCollateral(market: string, side: TradeSide, amount: number): Promise<TradeResult>;
  getPositions(): Promise<Position[]>;
  getMarketData(market: string): Promise<MarketData>;
  getPortfolio(): Promise<Portfolio>;
  getBalance(): Promise<number>;
  getTradeHistory?(): SimulatedTrade[];
  previewOpenPosition?(market: string, side: TradeSide,
                       collateral: number, leverage: number): Promise<DryRunPreview>;
}
```

### 10.3 Position Data

Positions are fetched from on-chain `PositionAccount` data via `perpClient.getUserPositions()`:

```typescript
interface Position {
  pubkey: string;          // On-chain account address
  market: string;          // Asset symbol
  side: TradeSide;         // 'long' or 'short'
  entryPrice: number;      // Oracle price at open
  currentPrice: number;    // Current oracle price
  markPrice: number;       // Mark price for PnL
  sizeUsd: number;         // Leveraged position size
  collateralUsd: number;   // Deposited margin
  leverage: number;        // Derived: sizeUsd / collateralUsd
  unrealizedPnlPercent: number;
  liquidationPrice: number;
  openFee: number;
  totalFees: number;
  fundingRate: number;
  timestamp: number;
}
```

### 10.4 USD Decimal Handling

A critical implementation detail: the Flash SDK encodes USD values using 6 decimal places (`USD_DECIMALS = 6`), not the token's native decimal count:

```typescript
const USD_DECIMALS = 6;

// Correct: divide by 10^6 for USD values
const sizeUsd = rawSizeUsd / Math.pow(10, USD_DECIMALS);
const collateralUsd = rawCollateralUsd / Math.pow(10, USD_DECIMALS);

// WRONG: dividing by token decimals (SOL=9) produces incorrect values
// $10 collateral would display as $0.01 (10M / 10^9 instead of 10M / 10^6)
```

### 10.5 Fee Calculation

Fee rates are read directly from on-chain `CustodyAccount` data:

```typescript
// Open fee rate
const openFeeRate = custodyAccount.fees.openPosition / RATE_POWER;

// Close fee rate
const closeFeeRate = custodyAccount.fees.closePosition / RATE_POWER;

// Fee amount
const openFee = sizeUsd * openFeeRate;
const closeFee = sizeUsd * closeFeeRate;
```

### 10.6 Liquidation Price

Liquidation prices are computed using the Flash SDK helper:

```typescript
const liquidationPrice = getLiquidationPriceContractHelper(
  entryPrice,
  sizeUsd,
  collateralUsd,
  side,
  maintenanceMarginRate,
  closeFeeRate
);
```

The `protocol verify` command runs 6 real-time checks comparing CLI calculations against on-chain state to confirm alignment.

---

<div style="page-break-before: always;"></div>

## Chapter 11 — CustodyAccount and PoolConfig

### 11.1 CustodyAccount

The `CustodyAccount` is the on-chain account that stores per-market parameters. Flash Terminal reads these parameters to ensure its display matches the protocol's execution logic.

| Parameter | Path | Description |
|:----------|:-----|:------------|
| Open fee rate | `custody.fees.openPosition / RATE_POWER` | Fee charged on position open |
| Close fee rate | `custody.fees.closePosition / RATE_POWER` | Fee charged on position close |
| Max leverage | `custody.pricing.maxLeverage / BPS_POWER` | Maximum allowed leverage |
| Maintenance margin | `1 / maxLeverage` | Margin below which liquidation occurs |

### 11.2 PoolConfig

The `PoolConfig` is loaded from the Flash SDK at startup. It maps pool names to their constituent markets and program IDs:

```typescript
// Pool discovery: reads from flash-sdk/dist/PoolConfig.json
// Fallback: hardcoded known pools
// Filters: skips devnet/Remora pools, deduplicates

function getPoolForMarket(symbol: string): string | null {
  for (const [pool, markets] of Object.entries(POOL_MARKETS)) {
    if (markets.includes(symbol.toUpperCase())) {
      return pool;
    }
  }
  return null;
}
```

### 11.3 Leverage Limits

Leverage limits are per-market and per-mode (normal vs. degen):

```typescript
function getMaxLeverage(market: string, degenMode: boolean): number {
  // Reads from SDK PoolConfig
  // Normal mode: protocol-default max
  // Degen mode: extended limits where available
}
```

The Zod schema caps leverage at 100x (the protocol maximum). Per-market limits are enforced at the tool level before the transaction is constructed.

---

<div style="page-break-before: always;"></div>

# PART VI — DATA SYSTEM

---

## Chapter 12 — Oracle System

### 12.1 Pyth Hermes Integration

Flash Terminal uses **Pyth Hermes** as its exclusive oracle source. Pyth Hermes provides the same price feeds used by the Flash Trade on-chain program, ensuring price parity.

**API Endpoint:** `https://hermes.pyth.network/v2/updates/price/latest`

**Request Format:**
```
GET /v2/updates/price/latest?ids[]=0xef0d8b6f...&ids[]=0xe62df6c8...&parsed=true
```

### 12.2 Feed ID Registry

Each tradeable asset has a corresponding Pyth feed ID hardcoded in `src/data/prices.ts`:

| Asset | Feed ID (truncated) |
|:------|:-------------------|
| SOL | `0xef0d8b6fda2ceba41da15d...` |
| BTC | `0xe62df6c8b4a85fe1a67db4...` |
| ETH | `0xff61491a931112ddf1bd81...` |
| XAU | `0x765d2ba906dbc32ca17cc1...` |
| XAG | `0xf2fb02c32b055c805e7238...` |

The complete registry covers 32 assets across crypto, commodities, forex, and equities.

### 12.3 Price Processing

```typescript
// Raw Pyth response:
// { price: "8714880000", expo: -8 }

// Parsed:
const price = parseInt(entry.price.price, 10) * Math.pow(10, entry.price.expo);
// = 8714880000 * 10^(-8) = $87.1488
```

### 12.4 Price Validation

Every price undergoes three validation checks:

| Check | Threshold | Action |
|:------|:----------|:-------|
| `Number.isFinite(price)` | Must be finite | Skip price |
| `price > 0` | Must be positive | Skip price |
| Deviation from cached | > 50% change | Reject with warning |

The deviation circuit breaker prevents corrupted or manipulated price data from entering the system.

### 12.5 24-Hour Price History

The `PriceService` maintains a rolling 24-hour price history for computing price change percentages:

| Parameter | Value |
|:----------|:------|
| Recording interval | Every 60 seconds |
| History window | 24 hours |
| Max snapshots per symbol | 1,440 |
| Minimum history for display | 10 minutes |
| Disk persistence | Every 2 minutes |
| Persistence file | `~/.flash/price-history.json` |
| Max file size | 5 MB |

The 24h change is computed by finding the price snapshot closest to 24 hours ago and calculating the percentage difference:

```typescript
const change = ((currentPrice - historicalPrice) / historicalPrice) * 100;
```

### 12.6 Caching Strategy

| Layer | TTL | Max Entries |
|:------|:----|:-----------|
| Price cache | 5 seconds | 100 symbols |
| Stale fallback | Indefinite | Same as cache |
| 24h history (memory) | 24 hours | 1,440 per symbol |
| 24h history (disk) | 24 hours | 5 MB total |

---

<div style="page-break-before: always;"></div>

## Chapter 13 — Analytics Data

### 13.1 fstats API Integration

The fstats API (`https://fstats.io/api/v1`) provides protocol-wide analytics data.

**Endpoints Used:**

| Endpoint | Data | Cache |
|:---------|:-----|:------|
| `/overview/stats` | Volume, trades, fees (30d) | 15s |
| `/volume/daily` | Daily volume breakdown by pool | 15s |
| `/positions/open-interest` | Per-market OI with long/short | 15s |
| `/positions/open` | Recent whale positions | 15s |
| `/fees/daily` | LP/token/team fee distribution | 15s |
| `/leaderboards/{metric}` | Top traders by PnL or volume | 15s |
| `/traders/{address}` | Individual trader profile | 15s |

### 13.2 Safety Measures

| Measure | Implementation |
|:--------|:---------------|
| Timeout | 10 seconds per request |
| Response size limit | 2 MB maximum with streaming validation |
| Query parameter encoding | `encodeURIComponent()` on all params |
| JSON validation | Parsed and validated before use |
| Stale cache fallback | Returns cached data on API failure |
| Rate limiting | Deduplication — concurrent requests merged |

### 13.3 Protocol Stats Service

The `ProtocolStatsService` (`src/data/protocol-stats.ts`) provides a unified, cached view of protocol metrics:

```
ProtocolStatsService
    │
    ├──► 15-second cache TTL
    ├──► Concurrent fetch deduplication
    ├──► Stale cache fallback on failure
    │
    └──► Aggregates:
         ├──► Market count (total, active, with OI, coming soon)
         ├──► Total OI (summed per market across pools)
         ├──► Long/short percentages
         └──► 30d stats (volume, traders, trades, fees)
```

---

<div style="page-break-before: always;"></div>

## Chapter 14 — Wallet and Balance System

### 14.1 Wallet Manager

The `WalletManager` (`src/wallet/walletManager.ts`) handles keypair loading, storage, and lifecycle:

**Keypair Loading Security:**

| Check | Purpose |
|:------|:--------|
| Path must be under home directory | Prevents directory traversal |
| Symlink resolution | Blocks link-based escape |
| File size max: 1 KB | Keypair files are <1 KB |
| Format validation | Must be 64-byte array of integers 0-255 |

### 14.2 Session Management

| Feature | Implementation |
|:--------|:---------------|
| Session persistence | Last wallet name saved to `~/.flash/session.json` |
| Idle timeout | 15 minutes — auto-disconnect with key zeroing |
| Timer management | Uses `.unref()` so timer doesn't prevent exit |
| Reconnect on failover | `setConnection()` called on RPC endpoint change |

### 14.3 Token Balance Caching

```
getTokenBalances()
    │
    ├──► Check cache (30s TTL)
    │    ├──► Hit → Return cached balances
    │    └──► Miss → Continue
    │
    ├──► Fetch SOL balance: connection.getBalance()
    ├──► Fetch SPL tokens: connection.getParsedTokenAccountsByOwner()
    │    ├──► USDC (mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
    │    └──► USDT (mint: Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB)
    │
    └──► Cache result, return
```

The cache is invalidated on post-trade and on connection change (RPC failover).

### 14.4 Keypair Integrity Verification

Before every signing operation, the keypair is verified:

```typescript
function verifyKeypairIntegrity(): boolean {
  // Check that secret key bytes are not zeroed
  // (Keypair.fromSecretKey holds a reference, not a copy)
  const secretKey = this.keypair.secretKey;
  for (let i = 0; i < 32; i++) {
    if (secretKey[i] !== 0) return true;
  }
  return false; // All zeros — keypair has been disconnected
}
```

This check exists because `Keypair.fromSecretKey()` in Solana's web3.js holds a **reference** to the input byte array, not a copy. If the key is zeroed (during disconnect), the keypair becomes unusable and any signing attempt must be rejected.

---

<div style="page-break-before: always;"></div>

# PART VII — RISK MANAGEMENT

---

## Chapter 15 — Circuit Breaker

### 15.1 Purpose

The circuit breaker (`src/security/circuit-breaker.ts`) halts all trading when cumulative losses exceed configurable thresholds. Once tripped, it requires a manual reset — profits do not un-trip the breaker.

### 15.2 Configuration

| Parameter | Env Variable | Default | Description |
|:----------|:-------------|:--------|:------------|
| Session loss limit | `MAX_SESSION_LOSS_USD` | 0 (disabled) | Max cumulative loss per session |
| Daily loss limit | `MAX_DAILY_LOSS_USD` | 0 (disabled) | Max cumulative loss per calendar day |
| Trade count limit | `MAX_TRADES_PER_SESSION` | 0 (disabled) | Max trade executions per session |

### 15.3 State Machine

```
                    ┌──────────┐
                    │  ACTIVE  │
                    └────┬─────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
  Session Loss      Daily Loss       Trade Count
  Exceeded          Exceeded         Exceeded
        │                │                │
        └────────────────┼────────────────┘
                         │
                         ▼
                    ┌──────────┐
                    │ TRIPPED  │ ←── All trades blocked
                    └────┬─────┘
                         │
                    Manual reset()
                         │
                         ▼
                    ┌──────────┐
                    │  ACTIVE  │
                    └──────────┘
```

### 15.4 Loss Tracking

The circuit breaker tracks losses (not profits). Only negative PnL values contribute to the loss counters:

```typescript
recordTrade(pnl: number): void {
  this.state.sessionTradeCount++;
  if (pnl < 0) {
    const loss = Math.abs(pnl);
    this.state.sessionLossUsd += loss;
    this.state.dailyLossUsd += loss;
  }
  this.check(); // Evaluate trip conditions immediately
}
```

Daily loss resets at the start of each calendar day (UTC). Session loss persists until the terminal is restarted or manually reset.

---

<div style="page-break-before: always;"></div>

## Chapter 16 — Kill Switch

### 16.1 Purpose

The trading gate (`src/security/trading-gate.ts`) provides a master kill switch that instantly blocks all trade execution. It also enforces portfolio-wide exposure limits.

### 16.2 Kill Switch Operation

```typescript
// Disable all trading immediately
tradingGate.disable('Manual emergency stop');

// Re-enable trading
tradingGate.enable();

// Check before any trade
if (!tradingGate.isEnabled()) {
  return { success: false, message: 'Trading disabled: ' + tradingGate.getReason() };
}
```

When the kill switch is active, the terminal continues to operate in monitoring-only mode. All read-only commands (positions, dashboard, analytics) remain functional.

### 16.3 Exposure Control

The trading gate also enforces portfolio-wide exposure limits:

```typescript
interface TradingGateConfig {
  tradingEnabled: boolean;       // Master kill switch
  maxPortfolioExposure: number;  // $0 = unlimited
}

// Before opening a new position:
const currentExposure = positions.reduce((sum, p) => sum + p.sizeUsd, 0);
if (currentExposure + newPositionSizeUsd > maxPortfolioExposure) {
  return reject('Would exceed portfolio exposure limit');
}
```

---

<div style="page-break-before: always;"></div>

## Chapter 17 — TP/SL Automation

### 17.1 Architecture

The TP/SL engine (`src/risk/tp-sl-engine.ts`) monitors positions against user-defined price targets and automatically triggers position closes when targets are reached.

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐
│ User sets    │     │ Engine polls │     │ Close executor│
│ TP/SL target│────▶│ every 5s     │────▶│ (if triggered)│
└─────────────┘     └──────┬───────┘     └───────────────┘
                           │
                    ┌──────▼───────┐
                    │ Spike        │
                    │ Protection   │
                    │ (2 ticks)    │
                    └──────────────┘
```

### 17.2 Trigger Logic

| Position | Take Profit | Stop Loss |
|:---------|:------------|:----------|
| LONG | Price ≥ TP target | Price ≤ SL target |
| SHORT | Price ≤ TP target | Price ≥ SL target |

### 17.3 Spike Protection

To prevent false triggers on momentary price wicks, the engine requires **2 consecutive confirmation ticks** before executing a close:

```
Tick 1: Price crosses target → confirmationTicks = 1
Tick 2: Price still past target → confirmationTicks = 2 → TRIGGER CLOSE

If price bounces back before tick 2:
Tick 1: Price crosses target → confirmationTicks = 1
Tick 2: Price recovers → confirmationTicks = 0 → No trigger
```

### 17.4 Pre-Trigger Validation

Before executing an automated close, the engine validates:

1. **Position still exists** — May have been manually closed
2. **Circuit breaker clear** — Trading not halted by loss limits
3. **Kill switch inactive** — Emergency stop not engaged
4. **Not already closing** — Prevents duplicate close attempts

### 17.5 Target Management

```typescript
// Set take-profit
engine.setTarget('SOL', 'long', 160, undefined); // TP at $160

// Set stop-loss
engine.setTarget('SOL', 'long', undefined, 120); // SL at $120

// Both can coexist on the same position
engine.setTarget('SOL', 'long', 160, 120); // TP $160, SL $120

// Remove individual target
engine.removeTarget('SOL', 'long', 'tp'); // Remove only TP

// View all active targets
engine.getTargets(); // Map<"SOL-long", TpSlTarget>
```

### 17.6 Self-Polling

The engine starts polling when targets are set and stops when all targets are cleared. The poll timer uses `.unref()` to prevent keeping the process alive:

```
Targets set → ensurePolling() → setInterval(5000)
Targets cleared → maybeStopPolling() → clearInterval()
```

---

<div style="page-break-before: always;"></div>

# PART VIII — INFRASTRUCTURE

---

## Chapter 18 — RPC Failover System

### 18.1 Architecture

The RPC Manager (`src/network/rpc-manager.ts`) provides multi-endpoint failover with health monitoring:

```
┌────────────────────────────────────────┐
│            RPC MANAGER                 │
│                                        │
│  Primary ──► Helius (active)           │
│  Backup 1 ──► QuickNode (standby)     │
│  Backup 2 ──► Triton (standby)        │
│                                        │
│  Health Monitor (every 30s)            │
│  ├── Latency check                    │
│  ├── Slot lag detection               │
│  └── Failure rate tracking            │
│                                        │
│  Failover Logic                        │
│  ├── 60s cooldown between switches    │
│  ├── Concurrent failover guard        │
│  └── Connection change callback       │
└────────────────────────────────────────┘
```

### 18.2 Health Metrics

| Metric | Threshold | Action |
|:-------|:----------|:-------|
| Latency | > 3,000 ms | Mark unhealthy, failover if backup available |
| Slot lag | > 50 slots behind | Mark endpoint as stale |
| Failure rate | > 50% | Trigger failover |

### 18.3 Slot Lag Detection

The manager tracks the latest slot from each endpoint and detects when an endpoint falls behind:

```typescript
// Track slot per endpoint
slotHistory.set(endpointUrl, latestSlot);

// Compute lag vs. highest known slot
const maxSlot = Math.max(...slotHistory.values());
const lag = maxSlot - endpointSlot;

if (lag > 50) {
  // Endpoint is stale — trigger failover
}
```

### 18.4 Failover Safety

| Safety | Implementation |
|:-------|:---------------|
| Cooldown | 60-second minimum between failover events |
| Guard | `failoverInProgress` flag prevents concurrent switches |
| Callback | `FlashClient` notified via `setConnectionChangeCallback()` |
| Suspicious slot | Jumps > 1,000 slots rejected (prevents invalid slot data) |

---

<div style="page-break-before: always;"></div>

## Chapter 19 — Leader-Aware Routing

### 19.1 Concept

In Solana, transactions are processed by the current slot leader. When multiple RPC endpoints are available, the terminal can route transactions to the endpoint that is closest (in network terms) to the current leader.

### 19.2 Implementation

Leader-aware routing is available when the ultra-TX engine is active and multiple RPC endpoints are configured. The engine tracks:

- Current slot leaders from each endpoint
- Historical endpoint performance per leader
- Broadcast timing relative to leader rotation

When only a single RPC endpoint is configured (the common case), leader routing metrics show `N/A` in the `tx metrics` output:

```
LEADER ROUTING
────────────────────────────────────────
Leader Routed             0%
Avg Slot Delay            n/a
Fastest Endpoint          n/a
```

Adding backup RPC endpoints via `BACKUP_RPC_1` and `BACKUP_RPC_2` enables leader-aware routing.

---

<div style="page-break-before: always;"></div>

## Chapter 20 — Crash Recovery

### 20.1 Trade Journal

The trade journal (`src/journal/trade-journal.ts`) records the lifecycle of every transaction for crash recovery:

```
                     recordPending()
User confirms ──────────────────────▶ { status: 'pending' }
                                           │
                     recordSent()          │
Signature received ─────────────────▶ { status: 'sent', signature }
                                           │
                     recordConfirmed()     │
On-chain confirmed ─────────────────▶ { status: 'confirmed' }
                                           │
                     remove()              │
Cleanup ────────────────────────────▶ Entry deleted
```

### 20.2 Persistence

| Parameter | Value |
|:----------|:------|
| File path | `~/.flash/pending-trades.json` |
| Max entries | 100 |
| Max file size | 512 KB |
| Write strategy | Atomic (write → temp → rename) |
| Corruption handling | Rebuild as empty with warning |

### 20.3 Recovery Process

On startup, the recovery engine:

1. Reads `pending-trades.json`
2. Filters entries with status `pending` or `sent`
3. For each entry with a signature: checks on-chain status
4. If confirmed on-chain: marks as confirmed and removes
5. If not found on-chain: logs as failed/expired

### 20.4 Journal Entry Schema

```typescript
interface JournalEntry {
  id: string;
  market: string;
  side: string;
  action: 'open' | 'close' | 'add_collateral' | 'remove_collateral';
  signature?: string;
  status: 'pending' | 'sent' | 'confirmed';
  createdAt: number;  // Unix timestamp
  updatedAt: number;  // Unix timestamp
}
```

---

<div style="page-break-before: always;"></div>

## Chapter 21 — State Reconciliation

### 21.1 Purpose

The state reconciler (`src/core/state-reconciliation.ts`) ensures the terminal's view of positions matches the blockchain. On-chain state is always authoritative.

### 21.2 Reconciliation Triggers

| Trigger | When |
|:--------|:-----|
| Startup | After client initialization |
| Wallet switch | On `wallet use` or `wallet connect` |
| Post-trade | After every trade execution |
| Periodic | Every 60 seconds (live mode) |

### 21.3 Mismatch Handling

```
Fetch on-chain positions
    │
    ├──► Compare with local cache
    │
    ├──► If RPC returns fewer positions:
    │    │
    │    ├──► Wait 400ms, retry RPC once
    │    │
    │    ├──► If retry matches: accept, reset counter
    │    │
    │    └──► If still fewer: increment mismatch counter
    │         │
    │         ├──► Counter < 3: keep local state (transient RPC issue)
    │         │
    │         └──► Counter ≥ 3: accept RPC state (position closed/liquidated)
    │              Show single CLI warning (anti-spam)
    │
    ├──► Added positions: new on-chain, not locally tracked
    │
    └──► Removed positions: local but not on-chain (closed/liquidated)
```

### 21.4 Numeric Validation

Before accepting positions from the reconciler, every field is validated:

```typescript
// Skip positions with invalid values
if (!Number.isFinite(pos.entryPrice) || pos.entryPrice <= 0) continue;
if (!Number.isFinite(pos.sizeUsd) || pos.sizeUsd <= 0) continue;
if (!Number.isFinite(pos.collateralUsd) || pos.collateralUsd <= 0) continue;
```

### 21.5 Post-Trade Verification

After every trade, the reconciler verifies the expected result:

```typescript
// After opening a position:
const verified = await reconciler.verifyTrade(market, side);
// Returns true if position exists on-chain

// After closing:
const verified = await reconciler.verifyTrade(market, side);
// Returns true if position no longer exists
```

### 21.6 Logging

Reconciliation events are logged to `~/.flash/logs/reconcile.log` with 2 MB rotation.

---

<div style="page-break-before: always;"></div>

# PART IX — MONITORING

---

## Chapter 22 — Market Monitor

### 22.1 Real-Time Display

The market monitor (`monitor` command) provides a full-screen, auto-refreshing market table:

```
FLASH TERMINAL — MARKET MONITOR
RPC 309ms  |  Oracle 1135ms  |  Slot 405763630  |  Lag 0  |  Render 0ms
1:31:24 AM  |  Press q to exit
────────────────────────────────────────────────────────────────────────
Asset                Price  24h Change   Open Interest  Long / Short
────────────────────────────────────────────────────────────────────────
BTC             $70,528.67         N/A          $1.13M       71 / 29
SOL               $87.0458         N/A     $728,861.33       30 / 70
XAG               $86.0413         N/A     $253,895.41        96 / 4
ETH              $2,072.40         N/A     $242,032.22       13 / 87
...
```

### 22.2 Refresh Cycle

| Data | Source | Refresh Rate |
|:-----|:-------|:-------------|
| Prices | Pyth Hermes | Every 5 seconds |
| Open interest | fstats API | Every 15 seconds (cached) |
| Long/short ratio | fstats API | Every 15 seconds (cached) |

### 22.3 Status Bar

The top status bar shows infrastructure health at a glance:

| Field | Source | Description |
|:------|:-------|:------------|
| RPC | `rpcManager.getLatency()` | Active endpoint latency |
| Oracle | Last Pyth fetch time | Oracle data freshness |
| Slot | Solana `getSlot()` | Current block height |
| Lag | `rpcManager.getSlotLag()` | Slots behind network tip |
| Render | Timer | Monitor render time |
| Divergence | Price validation | OK if prices consistent |

### 22.4 Sorting

Markets are sorted by open interest (descending), placing the most actively traded markets at the top.

---

<div style="page-break-before: always;"></div>

## Chapter 23 — Protocol Analytics

### 23.1 Risk Monitor

The background risk monitor (`src/monitor/risk-monitor.ts`) continuously evaluates position health:

**Tiered Refresh:**

| Data | Interval |
|:-----|:---------|
| Price check | Every 5 seconds |
| Full position fetch | Every 20 seconds |
| Max stale data | 2 minutes |

**Risk Levels with Hysteresis:**

```
SAFE ──────────────► WARNING
      distance < 30%
                     │
WARNING ──────────► SAFE
      distance > 35%
                     │
WARNING ──────────► CRITICAL
      distance < 15%
                     │
CRITICAL ──────────► WARNING
      distance > 18%
```

The hysteresis prevents alert oscillation when a position hovers near a threshold boundary.

### 23.2 Event Monitor

The event monitor (`src/monitor/event-monitor.ts`) detects threshold-based changes across multiple dimensions:

| Event Type | Threshold | Description |
|:-----------|:----------|:------------|
| Price change | 0.5% move | Significant price movement |
| OI change | 5% or $10k | Open interest shift |
| Funding flip | Sign change | Funding rate direction reversal |
| Whale position | $50k+ size | Large position detected |
| PnL change | $5 delta | Portfolio PnL movement |
| Liquidation proximity | 2% change | Approaching liquidation |
| RPC latency | 300ms spike | Infrastructure degradation |
| Oracle lag | 10s delay | Stale price data |

**Throttling:** Maximum 15 events per 7-second cycle to prevent output flooding.

### 23.3 Protocol Inspector

The protocol inspector (`src/protocol/protocol-inspector.ts`) provides deep visibility into Flash Trade state:

```
flash [live] > inspect protocol     # Full protocol overview
flash [live] > inspect pool Crypto.1  # Pool-level inspection
flash [live] > inspect market SOL   # Market-level deep dive
flash [live] > protocol verify      # 6-point alignment audit
flash [live] > protocol fees SOL    # On-chain fee verification
flash [live] > source verify SOL    # Data provenance check
```

### 23.4 Dashboard

The dashboard (`dashboard` command) provides a consolidated view:

```
╭──────────────── Protocol Health ─────────────────╮
│  Active Markets:         25                      │
│  Total Open Interest:    $2.77M                  │
│  30d Volume:             $353.66M                │
│  Fee Model:              Borrow/Lock fees        │
│  Oracle Latency:         ~999ms                  │
│  RPC Latency:            202ms                   │
│  Current Slot:           405,764,004             │
│  Slot Lag:               0                       │
╰──────────────────────────────────────────────────╯

╭───────────────── Your Portfolio ─────────────────╮
│  Positions:              2                       │
│  Balance:                $393.76                 │
│  Exposure:               $800.00                 │
│  Unrealized PnL:         -$0.06                  │
│  Fees Paid:              $0.64                   │
│  Risk Level:             HEALTHY                 │
╰──────────────────────────────────────────────────╯
```

---

<div style="page-break-before: always;"></div>

# PART X — TESTING

---

## Chapter 24 — Test Architecture

### 24.1 Test Suite Overview

Flash Terminal has 462 automated tests across 28 test files. All tests run in ~1.3 seconds.

```
Test Files:  28 passed | 1 skipped (29)
Tests:       462 passed | 5 skipped (467)
Duration:    1.26s
```

The 5 skipped tests are devnet smoke tests gated by an environment flag — they do not affect production logic.

### 24.2 Test Files by Category

**Trading & Execution (97 tests):**

| File | Tests | Coverage |
|:-----|:------|:---------|
| `simulation.test.ts` | 22 | Paper trading, PnL, balance, fees |
| `flash-client.test.ts` | 17 | TX validation, whitelist, freeze |
| `trade-helpers.test.ts` | 16 | Position math, leverage calc |
| `execute-action.test.ts` | 15 | Command execution, AI parsing |
| `trade-history-lifecycle.test.ts` | 18 | Trade recording, journal |
| `integration-lifecycle.test.ts` | 11 | Full OPEN → manage → CLOSE workflow |

**Safety & Security (79 tests):**

| File | Tests | Coverage |
|:-----|:------|:---------|
| `tp-sl-engine.test.ts` | 31 | TP/SL triggers, spike protection |
| `circuit-breaker.test.ts` | 18 | Loss limits, daily reset |
| `signing-guard.test.ts` | 17 | Rate limits, trade limits, audit log |
| `trading-gate.test.ts` | 13 | Kill switch, exposure control |

**Infrastructure & Risk (88 tests):**

| File | Tests | Coverage |
|:-----|:------|:---------|
| `market-resolver.test.ts` | 36 | Alias resolution, normalization |
| `ultra-tx-engine.test.ts` | 24 | TX pipeline, routing |
| `risk-monitor.test.ts` | 12 | Risk levels, liquidation distance |
| `chaos-resilience.test.ts` | 15 | Failure recovery, fault tolerance |
| `config-validator.test.ts` | 12 | Config parsing, env validation |

**Analytics & Monitoring (90 tests):**

| File | Tests | Coverage |
|:-----|:------|:---------|
| `dashboard.test.ts` | 33 | Dashboard rendering, metrics |
| `event-monitor.test.ts` | 26 | Event tracking, state changes |
| `production-refactor.test.ts` | 23 | Production stability, edge cases |
| `protocol-fees.test.ts` | 8 | Fee calculations |

**Observability (58 tests):**

| File | Tests | Coverage |
|:-----|:------|:---------|
| `shadow-engine.test.ts` | 15 | Position mirroring |
| `risk-mirror.test.ts` | 13 | Risk state sync |
| `metrics.test.ts` | 13 | Performance metrics |
| `trade-events.test.ts` | 12 | Event emission |
| `alert-hooks.test.ts` | 11 | Notification hooks |
| `metrics-export.test.ts` | 8 | Data export formats |
| `shadow-events.test.ts` | 6 | Shadow event recording |

**Protocol (21 tests):**

| File | Tests | Coverage |
|:-----|:------|:---------|
| `protocol-liq.test.ts` | 13 | Liquidation calculations |
| `protocol-fees.test.ts` | 8 | Fee rate verification |

---

<div style="page-break-before: always;"></div>

## Chapter 25 — Test Strategy

### 25.1 Testing Principles

1. **Behavior-Locking Tests** — Verify that financial logic (PnL, fees, balance deductions) does not silently change. These tests lock in expected numerical outputs.

2. **Deterministic Mocking** — All external dependencies (Pyth prices, RPC, fstats) are mocked with fixed values:
   ```typescript
   // Deterministic mock prices:
   // SOL = $150, BTC = $60,000, ETH = $3,500
   ```

3. **Numeric Safety** — Every test verifies that calculations produce finite numbers:
   ```typescript
   expect(Number.isFinite(result.pnl)).toBe(true);
   expect(Number.isFinite(result.liquidationPrice)).toBe(true);
   ```

4. **State Isolation** — Each test gets fresh instances via `beforeEach` to prevent test pollution.

5. **Edge Case Coverage** — Tests explicitly verify behavior for:
   - `NaN` and `Infinity` inputs
   - Zero and negative values
   - Boundary conditions (min collateral, max leverage)
   - Concurrent operations (trade mutex, rate limiter)

### 25.2 Mock Pattern

```typescript
vi.mock('../src/data/prices.js', () => ({
  PriceService: class {
    async getPrices(symbols: string[]) {
      const map = new Map();
      map.set('SOL', { symbol: 'SOL', price: 150, priceChange24h: 2.5 });
      map.set('BTC', { symbol: 'BTC', price: 60000, priceChange24h: -1.2 });
      return map;
    }
  }
}));
```

### 25.3 Assertion Patterns

```typescript
// Numeric tolerance for floating-point
expect(result.fee).toBeCloseTo(0.16, 2);

// Financial safety
expect(Number.isFinite(result.balance)).toBe(true);

// State verification
expect(circuitBreaker.isTripped()).toBe(true);

// Error messages
expect(() => signingGuard.checkRateLimit()).toThrow(/rate limit/i);
```

### 25.4 Test Runner

Tests are executed with **Vitest** (`vitest run`) with the following configuration:

```json
{
  "test": "vitest run",
  "test:watch": "vitest"
}
```

---

<div style="page-break-before: always;"></div>

# PART XI — SECURITY

---

## Chapter 26 — Key Management

### 26.1 Keypair Lifecycle

```
┌────────────────┐     ┌──────────────┐     ┌────────────────┐
│ Load from file │────▶│ Validate     │────▶│ In-memory      │
│ (JSON array)   │     │ (format,     │     │ Keypair object │
│                │     │  size, path) │     │                │
└────────────────┘     └──────────────┘     └───────┬────────┘
                                                     │
                                              ┌──────▼──────┐
                                              │ Active use  │
                                              │ (signing)   │
                                              └──────┬──────┘
                                                     │
                                     ┌───────────────┼───────────────┐
                                     │               │               │
                              Idle timeout     Manual         Process
                              (15 min)        disconnect      exit
                                     │               │               │
                                     └───────────────┼───────────────┘
                                                     │
                                              ┌──────▼──────┐
                                              │ Zero secret │
                                              │ key bytes   │
                                              └─────────────┘
```

### 26.2 Security Measures

| Measure | Implementation |
|:--------|:---------------|
| File path validation | Must be under home directory |
| Symlink resolution | `realpath()` before access |
| File size limit | Maximum 1 KB |
| Format validation | 64-byte array, values 0-255 |
| Integrity check | Non-zero verification before signing |
| Idle timeout | 15-minute auto-disconnect |
| Key zeroing | Secret key bytes filled with 0 on disconnect |
| Log scrubbing | Keys never appear in logs |

### 26.3 Log Scrubbing

All log output is scrubbed to prevent key leakage:

```typescript
// Patterns scrubbed:
'sk-ant-*'     → 'sk-ant-***'      // Anthropic API keys
'gsk_*'        → 'gsk_***'         // Groq API keys
base58 strings → masked            // Potential private keys
'api_key=*'    → 'api_key=***'     // URL parameters
```

Log files are created with `0o600` permissions (owner read/write only).

### 26.4 RPC URL Validation

RPC URLs are validated on startup to prevent security issues:

| Check | Description |
|:------|:------------|
| HTTPS required | HTTP only allowed for localhost |
| No credentials | Rejects URLs with embedded user:pass |
| No internal IPs | Blocks 10.x, 192.168.x, 169.254.x, IPv6 private |
| Valid URL format | Must parse as valid URL |

---

<div style="page-break-before: always;"></div>

## Chapter 27 — Signing Guard

### 27.1 Architecture

The signing guard (`src/security/signing-guard.ts`) is the central pre-signing security gate:

```
Trade Request
    │
    ├──► Check Trade Limits
    │    ├──► Collateral ≤ MAX_COLLATERAL_PER_TRADE?
    │    ├──► Position size ≤ MAX_POSITION_SIZE?
    │    └──► Leverage ≤ MAX_LEVERAGE?
    │
    ├──► Check Rate Limit
    │    ├──► Delay ≥ MIN_DELAY_BETWEEN_TRADES_MS?
    │    └──► Count < MAX_TRADES_PER_MINUTE?
    │
    ├──► Reserve Rate Limit Slot (atomic)
    │    (prevents TOCTOU race condition)
    │
    ├──► Display Confirmation Gate
    │
    ├──► On confirm: Record in Audit Log
    │
    └──► Proceed to signing
```

### 27.2 Rate Limiter

The rate limiter uses atomic slot reservation to prevent time-of-check-to-time-of-use (TOCTOU) race conditions:

```typescript
checkRateLimit(): void {
  const now = Date.now();

  // Minimum delay between trades
  if (now - this.lastTradeTimestamp < this.config.minDelayBetweenTradesMs) {
    throw new Error('Rate limit: minimum delay not met');
  }

  // Maximum trades per minute
  const oneMinuteAgo = now - 60_000;
  const recentCount = this.tradeTimestamps.filter(t => t > oneMinuteAgo).length;
  if (recentCount >= this.config.maxTradesPerMinute) {
    throw new Error('Rate limit: maximum trades per minute exceeded');
  }

  // Reserve slot atomically (prevents double-submit)
  this.tradeTimestamps.push(now);
  this.lastTradeTimestamp = now;
}
```

### 27.3 Audit Log

Every trade attempt is recorded in `~/.flash/signing-audit.log`:

```json
{
  "timestamp": "2026-03-12T01:26:58.123Z",
  "type": "open_position",
  "market": "SOL",
  "side": "long",
  "collateral": 10,
  "leverage": 2,
  "sizeUsd": 20,
  "walletAddress": "Dvvzg9rw...LfmK",
  "result": "confirmed"
}
```

| Field | Description |
|:------|:------------|
| Result codes | `confirmed`, `rejected`, `failed`, `rate_limited` |
| Never logged | Private keys, signatures, raw transaction data |
| Rotation | 5 MB max, rotates to `.old` / `.old.2` |
| Permissions | `0o600` (owner read/write only) |

---

<div style="page-break-before: always;"></div>

# PART XII — OPERATIONS

---

## Chapter 28 — Deployment

### 28.1 Prerequisites

| Requirement | Version |
|:------------|:--------|
| Node.js | ≥ 20.0.0 |
| npm | ≥ 9.0.0 |
| Solana RPC | Mainnet-beta endpoint |

### 28.2 Installation

```bash
git clone https://github.com/Abdr007/bolt-terminal.git
cd bolt-terminal
npm install
npm run build
```

### 28.3 Configuration

```bash
cp .env.example .env
```

Edit `.env` with required values:

```bash
# Required
RPC_URL=https://your-rpc-endpoint.com

# Optional — wallet path for live trading
WALLET_PATH=/path/to/keypair.json

# Optional — defaults to true (simulation mode)
SIMULATION_MODE=true

# Optional — enables AI natural language commands
ANTHROPIC_API_KEY=sk-ant-...
```

### 28.4 Running

```bash
# Production
npm start

# Development
npm run dev
```

### 28.5 Build Process

The build process:

1. Generates build info (commit hash, branch, timestamp) via `scripts/generate-build-info.sh`
2. Compiles TypeScript with `tsc` (strict mode, ES2022 target, NodeNext modules)
3. Sets executable permission on entry point: `chmod +x dist/index.js`

```json
{
  "build": "sh scripts/generate-build-info.sh && tsc && chmod +x dist/index.js"
}
```

### 28.6 File System Layout

```
~/.flash/
├── signing-audit.log         # Trade audit log (5MB rotation)
├── signing-audit.log.old
├── signing-audit.log.old.2
├── pending-trades.json       # Trade journal for crash recovery (512KB)
├── price-history.json        # 24h oracle price snapshots (5MB)
├── session.json              # Last connected wallet name
├── wallets/                  # Stored wallet metadata (no private keys)
└── logs/
    └── reconcile.log         # State reconciliation events (2MB rotation)
```

---

<div style="page-break-before: always;"></div>

## Chapter 29 — Documentation System

### 29.1 VitePress Documentation Site

The documentation is hosted at [bolt-terminal-docs.vercel.app](https://bolt-terminal-docs.vercel.app) and built with VitePress.

### 29.2 Documentation Structure

**Guide (13 pages) — Concepts, workflows, and system design:**

| Page | Content |
|:-----|:--------|
| Introduction | System purpose, design philosophy |
| Getting Started | Installation, configuration, first session |
| Terminal Features | REPL, autocomplete, modes |
| Trading Commands | Open, close, manage positions |
| Simulation Mode | Paper trading with real oracle prices |
| Security Model | Full safety pipeline |
| Market Analytics | Monitoring and analytics tools |
| Protocol Inspection | Pool/market/OI inspection |
| Risk & Liquidation | Trade previews, liquidation math |
| Protocol Alignment | How calculations match the protocol |
| Data Sources | Caching, validation, fallback behavior |
| Infrastructure | RPC failover, crash recovery |
| Architecture | System design overview |

**Reference (6 pages) — Complete command documentation:**

| Page | Content |
|:-----|:--------|
| Trading Commands | open, close, add, remove collateral |
| Market Data | monitor, scan, analyze, volume, OI |
| Portfolio & Risk | dashboard, risk report, exposure |
| Protocol Inspector | inspect, verify, fees |
| Wallet | wallet management and balances |
| System | diagnostics, RPC status, health checks |

---

## Chapter 30 — Release Process

### 30.1 Version Tagging

Flash Terminal uses semantic versioning. The v1.0.0 release represents:

- Complete trading lifecycle (open, close, add/remove collateral)
- Full safety pipeline (11 stages)
- 462 passing automated tests
- Pre-production audit score: 94/100
- Zero critical issues

### 30.2 Build Verification

Before release, the following checks are performed:

```bash
# Clean build
npm run build          # Must complete with 0 TypeScript errors

# Full test suite
npm test               # Must show 462 passed, 0 failed

# System diagnostic
flash > doctor         # Must show all categories PASS
```

### 30.3 Release Artifacts

| Artifact | Location |
|:---------|:---------|
| Source code | GitHub: `Abdr007/bolt-terminal` |
| Documentation | Vercel: `bolt-terminal-docs.vercel.app` |
| Build info | Embedded in `dist/build-info.json` at compile time |

---

<div style="page-break-before: always;"></div>

# PART XIII — APPENDIX

---

## Appendix A — CLI Command Reference

### Trading Commands

| Command | Description | Example |
|:--------|:------------|:--------|
| `open` | Open a leveraged position | `open 5x long SOL $500` |
| `close` | Close a position | `close SOL long` |
| `add` | Add collateral to position | `add $200 to SOL long` |
| `remove` | Remove collateral | `remove $100 from ETH long` |
| `positions` | View open positions | `positions` |
| `markets` | List available markets | `markets` |
| `trade history` | View recent trades | `trade history` |
| `tp status` | View active TP/SL targets | `tp status` |
| `set tp` | Set take-profit target | `set tp SOL long $160` |
| `set sl` | Set stop-loss target | `set sl SOL long $120` |
| `remove tp` | Remove take-profit | `remove tp SOL long` |
| `remove sl` | Remove stop-loss | `remove sl SOL long` |
| `dryrun` | Preview trade without executing | `dryrun open 5x long SOL $100` |

### Market Data & Analytics

| Command | Description |
|:--------|:------------|
| `analyze <asset>` | Deep market analysis |
| `volume` | Protocol trading volume |
| `open interest` | OI breakdown by market |
| `leaderboard` | Top traders by PnL or volume |
| `whale activity` | Recent large positions |
| `fees` | Protocol fee data |
| `liquidations <asset>` | Liquidation risk data |
| `funding <asset>` | OI imbalance & fee dashboard |
| `depth <asset>` | Liquidity depth around price |
| `protocol health` | Protocol health overview |

### Portfolio & Risk

| Command | Description |
|:--------|:------------|
| `portfolio` | Portfolio overview |
| `dashboard` | Full system dashboard |
| `risk report` | Position risk assessment |
| `exposure` | Portfolio exposure breakdown |
| `rebalance` | Portfolio rebalance analysis |

### Protocol Inspection

| Command | Description |
|:--------|:------------|
| `inspect protocol` | Flash Trade protocol overview |
| `inspect pool <name>` | Inspect a specific pool |
| `inspect market <asset>` | Deep market inspection |
| `protocol fees <market>` | On-chain fee rate verification |
| `protocol verify` | Full protocol alignment audit |
| `source verify <asset>` | Verify data provenance |

### Wallet

| Command | Description |
|:--------|:------------|
| `wallet` | Wallet status |
| `wallet tokens` | View all token balances |
| `wallet balance` | Show SOL balance |
| `wallet list` | List saved wallets |
| `wallet import` | Import & store a wallet |
| `wallet use <name>` | Switch to a saved wallet |
| `wallet connect <path>` | Connect wallet file |
| `wallet disconnect` | Disconnect active wallet |

### Utilities

| Command | Description |
|:--------|:------------|
| `monitor` | Live market monitor |
| `doctor` | Run terminal diagnostic |
| `system status` | System health overview |
| `system audit` | Verify protocol data integrity |
| `rpc status` | Active RPC endpoint info |
| `rpc test` | Test all RPC endpoints |
| `tx metrics` | TX engine performance stats |
| `tx inspect <sig>` | Inspect a transaction |
| `tx debug <sig>` | Debug with protocol context |
| `help` | Show command reference |
| `exit` | Close the terminal |

---

<div style="page-break-before: always;"></div>

## Appendix B — Configuration

### Environment Variables

| Variable | Required | Default | Description |
|:---------|:---------|:--------|:------------|
| `RPC_URL` | Yes | Public mainnet | Solana mainnet RPC endpoint |
| `BACKUP_RPC_1` | No | — | First backup RPC endpoint |
| `BACKUP_RPC_2` | No | — | Second backup RPC endpoint |
| `WALLET_PATH` | No | — | Path to Solana keypair file |
| `SIMULATION_MODE` | No | `true` | `true` for paper trading, `false` for live |
| `ANTHROPIC_API_KEY` | No | — | Enables AI natural language commands |
| `GROQ_API_KEY` | No | — | Alternative LLM for NLP |
| `DEFAULT_POOL` | No | `Crypto.1` | Default trading pool |
| `NETWORK` | No | `mainnet-beta` | Solana network |
| `DEFAULT_SLIPPAGE_BPS` | No | `150` | Slippage tolerance (basis points) |
| `COMPUTE_UNIT_LIMIT` | No | `600000` | Transaction compute unit limit |
| `COMPUTE_UNIT_PRICE` | No | `500000` | Priority fee (microLamports) |
| `MAX_COLLATERAL_PER_TRADE` | No | `0` | Max USD per trade (0 = unlimited) |
| `MAX_POSITION_SIZE` | No | `0` | Max leveraged USD (0 = unlimited) |
| `MAX_LEVERAGE` | No | `0` | Max leverage multiplier (0 = market default) |
| `MAX_TRADES_PER_MINUTE` | No | `10` | Rate limit |
| `MIN_DELAY_BETWEEN_TRADES_MS` | No | `3000` | Minimum delay between trades |
| `LOG_FILE` | No | — | Application log path |

### TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "lib": ["ES2022"],
    "outDir": "dist",
    "sourceMap": true,
    "declaration": true,
    "isolatedModules": true
  }
}
```

---

<div style="page-break-before: always;"></div>

## Appendix C — Data Sources

| Data | Source | Cache TTL | Validation |
|:-----|:-------|:----------|:-----------|
| Oracle prices | Pyth Hermes | 5 seconds | Staleness <30s, confidence <2%, deviation <50% |
| Positions | Flash SDK `getUserPositions()` | Real-time | `Number.isFinite()` on all fields |
| Liquidation prices | Flash SDK `getLiquidationPriceContractHelper()` | Real-time | 0.5% divergence detection |
| Fee rates | On-chain `CustodyAccount` | ~60s (slot-based) | `ProtocolParameterError` on corruption |
| Wallet balances | Solana RPC (`getBalance`, `getParsedTokenAccountsByOwner`) | 30 seconds | Invalidated post-trade |
| Open interest | fstats API | 15 seconds | Response size <2 MB |
| Volume data | fstats API | 15 seconds | Parameter sanitization |
| Whale positions | fstats API | 15 seconds | Size threshold validation |
| Leaderboard | fstats API | 15 seconds | Response format validation |
| Pool/market config | Flash SDK `PoolConfig` | Static | Loaded from SDK at startup |

---

## Appendix D — System Glossary

| Term | Definition |
|:-----|:-----------|
| **ATA** | Associated Token Account — Solana's standard way to map tokens to wallets |
| **BPS** | Basis Points — 1 BPS = 0.01%. 150 BPS = 1.5% |
| **Circuit Breaker** | Safety system that halts all trading when loss thresholds are exceeded |
| **Collateral** | USD margin deposited as backing for a leveraged position |
| **Compute Budget** | Solana transaction parameter controlling compute unit allocation and priority fee |
| **CU** | Compute Units — Solana's measure of transaction computational cost |
| **CustodyAccount** | On-chain Flash Trade account storing per-market fee rates, leverage limits, and margins |
| **Degen Mode** | Optional mode allowing higher leverage limits on supported markets |
| **Deterministic Parsing** | Command interpretation using fixed regex patterns that always produce the same output |
| **Dry Run** | Transaction simulation without signing or broadcasting |
| **FAST_DISPATCH** | O(1) lookup map from command text to ActionType for instant command resolution |
| **Flash SDK** | Official JavaScript SDK for the Flash Trade protocol |
| **Flash Trade** | Decentralized perpetual futures protocol deployed on Solana |
| **Hysteresis** | Technique using separate enter/exit thresholds to prevent state oscillation |
| **IFlashClient** | Interface implemented by both live and simulation trading clients |
| **Instruction Freeze** | `Object.freeze()` applied to transaction instructions after validation |
| **Kill Switch** | Master toggle that instantly blocks all trade execution |
| **Leverage** | Multiplier applied to collateral to determine position size (e.g., 5x = 5× collateral) |
| **Liquidation Price** | Price level at which a position is forcibly closed to prevent negative equity |
| **Long** | Position that profits when the asset price increases |
| **Maintenance Margin** | Minimum collateral ratio required to keep a position open (= 1/maxLeverage) |
| **Mark Price** | Current oracle price used for PnL and liquidation calculations |
| **Mutex** | Mutual exclusion lock preventing concurrent trades on the same market/side |
| **ParsedIntent** | Typed, Zod-validated object representing a user's command intention |
| **Perpetual Futures** | Leveraged derivatives contracts with no expiration date |
| **PnL** | Profit and Loss — the difference between position value and entry cost |
| **PoolConfig** | Flash SDK configuration mapping pools to their constituent markets |
| **Program Whitelist** | Set of approved Solana program IDs that transaction instructions may target |
| **Pyth Hermes** | Oracle network providing real-time price feeds for on-chain protocols |
| **RATE_POWER** | Divisor used to normalize fee rates from `CustodyAccount` storage |
| **REPL** | Read-Eval-Print Loop — the interactive command prompt |
| **Short** | Position that profits when the asset price decreases |
| **Signing Guard** | Pre-signing security gate enforcing rate limits, trade limits, and audit logging |
| **Simulation Mode** | Paper trading mode using real oracle prices but no real transactions |
| **Slot** | Solana's unit of time (~400ms), during which a leader validator produces a block |
| **Slot Lag** | Number of slots an RPC endpoint is behind the network tip |
| **Spike Protection** | TP/SL safety requiring 2 consecutive confirmation ticks before trigger |
| **State Reconciliation** | Periodic sync ensuring CLI state matches blockchain state |
| **TOCTOU** | Time-of-Check-to-Time-of-Use — a race condition prevented by atomic slot reservation |
| **Tool Engine** | System that maps ParsedIntents to ToolDefinitions and executes them |
| **TP/SL** | Take-Profit / Stop-Loss — automated price-based position closing |
| **Trade Journal** | Persistent record of pending transactions for crash recovery |
| **USD_DECIMALS** | Constant value 6, representing the decimal places for all USD values in the Flash SDK |

---

<div style="page-break-before: always;"></div>

## Appendix E — Troubleshooting Guide

### Connection Issues

**Symptom:** "RPC reachable" fails in `doctor`

```
Verify:
1. RPC_URL is set correctly in .env
2. Endpoint is HTTPS (HTTP only for localhost)
3. Endpoint is accessible from your network
4. Try: rpc test (tests all configured endpoints)
```

**Symptom:** High slot lag (>50)

```
The active RPC is falling behind. The system will auto-failover
if backup endpoints are configured. Add BACKUP_RPC_1 to .env.
```

### Trading Issues

**Symptom:** "Duplicate position" error

```
Flash Trade allows only one position per market per side per wallet.
Use "positions" to see existing positions.
Close the existing position before opening a new one.
```

**Symptom:** "Rate limit exceeded"

```
Default: 10 trades/minute, 3-second minimum delay.
Wait for the specified time, or adjust:
  MAX_TRADES_PER_MINUTE=20
  MIN_DELAY_BETWEEN_TRADES_MS=1000
```

**Symptom:** Transaction times out but funds moved

```
The trade journal tracks pending transactions.
On next startup, the recovery engine checks if the tx landed on-chain.
Use "tx inspect <signature>" to check manually.
```

**Symptom:** "Keypair integrity check failed"

```
The wallet has been disconnected or the session timed out (15min idle).
Reconnect: wallet use <name>
```

### Data Issues

**Symptom:** 24h change shows "N/A" in monitor

```
The terminal builds price history from Pyth oracle data.
After 10 minutes of running, the 24h change will start displaying.
History persists across restarts via ~/.flash/price-history.json.
```

**Symptom:** "No whale activity detected"

```
Whale threshold is $10,000+. If no positions exceed this on the
queried market, the display is empty. This is expected for
smaller markets.
```

### Safety System Issues

**Symptom:** "Circuit breaker tripped"

```
Cumulative losses exceeded the configured threshold.
Check state: the circuit breaker requires manual reset.
Review positions and close risky trades before resetting.
```

**Symptom:** "Trading disabled"

```
The kill switch is active. Check:
1. TRADING_ENABLED env var (must be "true")
2. The kill switch may have been triggered at runtime
3. The circuit breaker may have tripped
```

### Diagnostic Commands

| Command | Purpose |
|:--------|:--------|
| `doctor` | Full system diagnostic (6 categories) |
| `system status` | Version, RPC, memory, uptime |
| `rpc status` | Active endpoint, latency, failovers |
| `rpc test` | Test all configured endpoints |
| `tx metrics` | Transaction engine performance |
| `system audit` | Verify protocol data integrity |
| `protocol verify` | 6-point protocol alignment check |

---

<p align="center">
  <strong>Flash Terminal v1.0.0</strong><br/>
  A production-grade Solana perpetual futures trading CLI.<br/>
  Built with strict TypeScript. Verified with 462 automated tests. Shipped with zero critical issues.
</p>

<p align="center">
  <em>End of Technical Manual</em>
</p>
