# Architecture

Flash Terminal is a layered system that transforms natural language commands into executed trades on the Solana blockchain through Flash Trade smart contracts.

---

## System Overview

```
┌─────────────────────────────────────────────────────────┐
│                     CLI Layer                           │
│  readline REPL · command history · mode selection       │
│  SIGINT/SIGTERM handlers · timeout protection           │
└──────────────────────┬──────────────────────────────────┘
                       │ user input
                       ▼
┌─────────────────────────────────────────────────────────┐
│                   AI Layer                              │
│  Fast dispatch (exact match) → Local regex parser       │
│  → AI API → Groq API → fallback                        │
│  Zod schema validation on all parsed intents            │
└──────────────────────┬──────────────────────────────────┘
                       │ ParsedIntent
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Tool Dispatch Layer                        │
│  ToolEngine maps ActionType → registered tool           │
│  ToolRegistry executes with try/catch safety            │
│  Autopilot blocked in live mode                         │
└───────┬──────────┬──────────┬───────────────────────────┘
        │          │          │
        ▼          ▼          ▼
┌────────────┐ ┌────────┐ ┌──────────────────────────────┐
│  Market    │ │Portfolio│ │     Trading Tools            │
│  Scanner   │ │ Engine  │ │  open/close/add/remove       │
│            │ │         │ │  pool validation              │
│ Scan mutex │ │Exposure │ │  leverage limits              │
│ Capped     │ │Rebalance│ │  trade mutex                  │
│ results    │ │Allocator│ │                               │
└─────┬──────┘ └────┬───┘ └──────────────┬────────────────┘
      │             │                    │
      ▼             ▼                    ▼
┌─────────────────────────────────────────────────────────┐
│                Strategy Engine                          │
│                                                         │
│  ┌──────────┐  ┌───────────────┐  ┌──────────────┐     │
│  │ Momentum │  │Mean Reversion │  │ Whale Follow │     │
│  └────┬─────┘  └──────┬────────┘  └──────┬───────┘     │
│       └───────────────┼──────────────────┘              │
│                       ▼                                 │
│              Signal Aggregator                          │
│       (regime-weighted confidence scoring)              │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                Regime Detector                          │
│                                                         │
│  Trend · Volatility · Liquidity · Whale Dominance       │
│                                                         │
│  Classifications:                                       │
│    TRENDING · RANGING · HIGH_VOLATILITY                 │
│    LOW_VOLATILITY · WHALE_DOMINATED · LOW_LIQUIDITY     │
│                                                         │
│  Output: RegimeWeights (strategy multipliers)           │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                Risk Engine                              │
│                                                         │
│  Liquidation risk · Exposure limits                     │
│  Position count caps · Directional limits               │
│  Correlation constraints · Regime-adjusted sizing       │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│              Execution Engine                           │
│                                                         │
│  ┌────────────────────┐  ┌─────────────────────────┐    │
│  │ SimulatedFlashClient│  │   FlashClient (live)   │    │
│  │ Paper balance       │  │   Flash SDK            │    │
│  │ Local state         │  │   Pyth oracle prices   │    │
│  │ No blockchain       │  │   Solana transactions  │    │
│  └────────────────────┘  └────────────┬────────────┘    │
│                                       │                 │
└───────────────────────────────────────┼─────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────┐
│              Wallet & RPC Layer                         │
│                                                         │
│  WalletManager · WalletStore                            │
│  Keypair loading · key zeroing · 0600 permissions       │
│  Connection factory · HTTPS validation                  │
│  WebSocket endpoint derivation                          │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                Data Sources                             │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐            │
│  │CoinGecko │  │fstats.io │  │ Pyth Oracle│            │
│  │ prices   │  │ volume   │  │  on-chain  │            │
│  │ 24h chg  │  │ OI       │  │  prices    │            │
│  │          │  │ whales   │  │            │            │
│  │          │  │ leaders  │  │            │            │
│  └──────────┘  └──────────┘  └────────────┘            │
│                                                         │
│  SolanaInspector: cached aggregator with                │
│  graceful degradation (Promise.allSettled)              │
└─────────────────────────────────────────────────────────┘
```

---

## Data Flow

### Command Execution

```
User types "open 2x long SOL $50"
  │
  ▼
Terminal.handleInput()
  │
  ├── FAST_DISPATCH lookup (exact match) ── miss
  │
  ▼
Interpreter.parse()
  │
  ├── 1. Local regex match ── match found
  │   (or AI API → Groq API → fallback)
  │
  ▼
ParsedIntent { action: OpenPosition, market: "SOL", side: "long", leverage: 2, collateral: 50 }
  │
  ▼ (Zod schema validation)
  │
ToolEngine.dispatch()
  │
  ▼
flash_open_position tool
  │
  ├── validateLiveTradeContext()
  ├── getPoolForMarket("SOL") → "Crypto.1"
  ├── Number.isFinite() checks
  │
  ▼
User confirms → executeAction()
  │
  ▼
FlashClient.openPosition() (or SimulatedFlashClient)
  │
  ├── acquireTradeLock("SOL:long")
  ├── Pre-trade checks (SOL balance, USDC balance, leverage limits)
  ├── Duplicate position check (getUserPositions)
  ├── Fetch fresh blockhash
  ├── Build instructions via Flash SDK
  ├── MessageV0.compile + sign
  ├── sendRawTransaction (maxRetries: 3)
  ├── Poll getSignatureStatuses every 2s (45s timeout)
  ├── Periodic resend during polling
  ├── releaseTradeLock()
  │
  ▼
ToolResult { success, message, txSignature }
```

### Market Scan

```
User types "scan"
  │
  ▼
Market Scanner (with scan mutex — prevents overlapping scans)
  │
  ├── SolanaInspector.getFullSnapshot()
  │     ├── getMarkets()
  │     ├── getVolume()
  │     ├── getOpenInterest()
  │     ├── getOpenPositions() → whale data
  │     └── (all with 30-60s cache + graceful degradation)
  │
  ├── RegimeDetector.detectAll() → per-market regime
  │
  ├── For each market:
  │     ├── aggregateSignals() with regime weights
  │     └── Filter: confidence >= 0.4, valid price
  │
  ├── Sort by confidence, cap at 10 results
  │
  ▼
Opportunities[] → portfolio filter → display
```

---

## Caching Architecture

All caches are bounded with maximum entry counts and TTL-based eviction:

| Cache | Location | Max Entries | TTL |
|-------|----------|-------------|-----|
| Market data | SolanaInspector | 50 | 30s |
| Analytics | SolanaInspector | 50 | 60s |
| Regime state | RegimeDetector | 50 | 30s |
| Pyth oracles | FlashClient | 50 | 5s |
| CoinGecko prices | PriceService | 100 | 15s |

When a cache exceeds its limit, expired entries are evicted first, then oldest entries are removed.

---

## Error Handling

- **Global handlers** — `unhandledRejection`, `uncaughtException`, `SIGTERM` in entry point
- **Signal handlers** — `SIGINT`, `SIGTERM` in terminal with graceful shutdown
- **Command timeout** — 120s timeout wrapper on all dispatched commands
- **API failures** — `safeFetchJson` returns null on failure; `Promise.allSettled` for parallel fetches
- **Trade failures** — Try/catch with error message propagation; trade lock always released in `finally`
- **Retry logic** — Exponential backoff with jitter for transient RPC failures
