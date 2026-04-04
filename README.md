<p align="center">
  <img src="assets/logo.svg" width="80" height="80" alt="Flash Terminal" />
</p>

<h1 align="center">Flash Terminal</h1>

<p align="center">
  <strong>Deterministic, production-grade CLI for trading Solana perpetual futures.</strong>
</p>

<p align="center">
  <a href="https://solana.com"><img src="https://img.shields.io/badge/Solana-Mainnet-9945FF?style=flat-square&logo=solana&logoColor=white" alt="Solana" /></a>&nbsp;
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-Strict-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>&nbsp;
  <a href="https://www.flash.trade"><img src="https://img.shields.io/badge/Flash_Trade-SDK-26d97f?style=flat-square" alt="Flash SDK" /></a>&nbsp;
  <img src="https://img.shields.io/badge/Tests-1743_passing-brightgreen?style=flat-square" alt="Tests" />&nbsp;
  <a href="https://github.com/Abdr007/bolt-terminal/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="https://bolt-terminal-docs.vercel.app">Docs</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="https://bolt-terminal-docs.vercel.app/guide/quick-start">Quick Start</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="https://bolt-terminal-docs.vercel.app/reference/trading-commands">Commands</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="https://github.com/Abdr007/bolt-terminal/releases">Releases</a>
</p>

---

## Overview

Flash Terminal is a command-line interface for trading perpetual futures on [Flash Trade](https://www.flash.trade/), a derivatives protocol on Solana. It connects directly to the protocol through the official Flash SDK and provides a structured execution pipeline with built-in safety controls.

97 commands. 32+ markets across 8 pools. Simulation mode by default.

```bash
npm install -g bolt-terminal
flash
```

---

## Key Features

**Deterministic Execution.** Every command is parsed by a regex-based engine with zero ambiguity. No AI in the execution path. The same input produces the same output, every time.

**32+ Markets.** Crypto, equities, commodities, forex, governance tokens, and memecoins — all sourced from Flash Trade pools via the Flash SDK.

**Simulation Mode.** Paper trading with real Pyth oracle prices. No wallet required, no transactions signed. Enabled by default.

**Safety Stack.** Signing guard, rate limiter, circuit breaker, kill switch, exposure control, pre-flight simulation, program whitelist, instruction freeze, and trade mutex. All active on every live trade.

**RPC Resilience.** Multi-endpoint failover with health monitoring, slot lag detection, and automatic recovery. Degrades to read-only mode when connectivity is lost.

**Earn & Staking.** Provide liquidity, stake FLP/FAF tokens, claim rewards, simulate yield — all from the terminal.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  CLI Layer                                                      │
│  Command registry · Regex parser · Fuzzy correction · Theme     │
├─────────────────────────────────────────────────────────────────┤
│  Risk & Safety Layer                                            │
│  Signing guard · Rate limiter · Circuit breaker · Kill switch   │
│  Exposure control · Program whitelist · Instruction freeze      │
├─────────────────────────────────────────────────────────────────┤
│  Execution Engine                                               │
│  TX builder · Pre-flight simulation · Dynamic CU · Rebroadcast  │
├─────────────────────────────────────────────────────────────────┤
│  Data Layer                                                     │
│  Pyth oracle prices · Protocol stats · State cache · Balances   │
├─────────────────────────────────────────────────────────────────┤
│  Network Layer                                                  │
│  RPC manager · Multi-endpoint failover · Slot lag detection     │
│  Health monitoring · Leader routing · Connection warmup          │
├─────────────────────────────────────────────────────────────────┤
│  Flash Trade Protocol (Solana)                                  │
│  On-chain execution · CustodyAccount state · Position accounts  │
└─────────────────────────────────────────────────────────────────┘
```

All trade commands flow top-to-bottom through every layer. Each safety gate can reject. No bypass path exists.

---

## Installation

Requires **Node.js 20+**.

```bash
npm install -g bolt-terminal
```

Or from source:

```bash
git clone https://github.com/Abdr007/bolt-terminal.git
cd bolt-terminal && npm install && npm run build
```

---

## Quick Start

```bash
flash
```

Select **Simulation** mode. Open a position:

```
flash [sim] > open 2x long SOL $100
```

Check your positions:

```
flash [sim] > positions
```

Close it:

```
flash [sim] > close SOL long
```

Full documentation: [bolt-terminal-docs.vercel.app](https://bolt-terminal-docs.vercel.app/guide/quick-start)

---

## Configuration

Create a `.env` file in the project root:

```bash
# Solana RPC endpoint
RPC_URL=https://api.mainnet-beta.solana.com

# Wallet keypair path (required for live trading)
WALLET_PATH=~/.config/solana/id.json

# Paper trading (default: true)
SIMULATION_MODE=true
```

<details>
<summary><strong>Trade Limits</strong></summary>

```bash
MAX_COLLATERAL_PER_TRADE=1000     # Max USD per trade (0 = unlimited)
MAX_POSITION_SIZE=50000           # Max position size (0 = unlimited)
MAX_LEVERAGE=50                   # Max leverage (0 = market default)
MAX_TRADES_PER_MINUTE=10          # Rate limit
MIN_DELAY_BETWEEN_TRADES_MS=3000  # Minimum delay between trades
```

</details>

<details>
<summary><strong>Risk Controls</strong></summary>

```bash
MAX_SESSION_LOSS_USD=500          # Halt trading on session loss
MAX_DAILY_LOSS_USD=1000           # Halt trading on daily loss
MAX_PORTFOLIO_EXPOSURE=10000      # Max total exposure
TRADING_ENABLED=true              # Master kill switch
```

</details>

<details>
<summary><strong>RPC & Network</strong></summary>

```bash
BACKUP_RPC_1=https://...          # Failover endpoint 1
BACKUP_RPC_2=https://...          # Failover endpoint 2
FLASH_DYNAMIC_CU=true             # Dynamic compute unit estimation
FLASH_CU_BUFFER_PCT=20            # CU buffer percentage
COMPUTE_UNIT_PRICE=100000         # Priority fee (micro-lamports)
FLASH_LEADER_ROUTING=true         # Leader-aware broadcast
FLASH_REBROADCAST_MS=800          # Rebroadcast interval
```

</details>

---

## Commands

### Trading

```
open 5x long SOL $500             Open leveraged position
close BTC short                   Close position
close 50% of SOL long             Partial close
add $200 to SOL long              Add collateral
remove $100 from ETH long         Remove collateral
dryrun open 10x long ETH $250     Preview without executing
close all                         Close all positions
limit long SOL 2x $100 @ $130     Limit order
orders                            View on-chain orders
swap SOL USDC $10                 Token swap
```

### Earn & Staking

```
earn                              View pools with live yield
earn add $100 crypto              Add liquidity
earn stake $200 governance        Stake FLP
earn claim                        Claim rewards
faf                               FAF staking dashboard
faf stake 1000                    Stake FAF
faf claim                         Claim FAF + USDC rewards
faf tier                          VIP levels + benefits
```

### Market Data

```
price SOL                         Current oracle price
monitor                           Live market table (5s refresh)
open interest                     OI breakdown by market
whale activity                    Large position tracking
funding SOL                       Funding rate + OI imbalance
depth SOL                         Liquidity depth
inspect protocol                  Protocol overview
inspect pool Crypto.1             Pool inspection
```

### Portfolio & Risk

```
positions                         Open positions with PnL
portfolio                         Portfolio overview
risk report                       Risk assessment
exposure                          Exposure breakdown
history                           Trade journal
set tp SOL long $160              Take-profit
set sl SOL long $130              Stop-loss
```

### System

```
wallet                            Wallet status
wallet tokens                     Token balances
rpc status                        RPC health
doctor                            Full diagnostics
system health                     Runtime metrics
help                              All commands
```

---

## Markets

32+ assets across 8 Flash Trade pools:

| Pool | Markets |
|:-----|:--------|
| Crypto.1 | SOL, BTC, ETH, ZEC, BNB |
| Ondo.1 | SPY, NVDA, TSLA, AAPL, AMD, AMZN, PLTR |
| Virtual.1 | XAU, XAG, CRUDEOIL, NATGAS, EUR, GBP, USDJPY, USDCNH |
| Governance.1 | JTO, JUP, PYTH, RAY, HYPE, MET, KMNO |
| Community.1 | PUMP, BONK, PENGU |
| Community.2 | WIF |
| Trump.1 | FARTCOIN |
| Ore.1 | ORE |

Markets are discovered dynamically from the Flash SDK. New markets appear after updating the SDK dependency.

---

## Design Principles

**No hidden logic.** Every fee, margin, and liquidation price is derived from on-chain `CustodyAccount` state. Prices come from Pyth Hermes with staleness and confidence validation.

**No AI in the trade path.** The command parser is deterministic (regex + fuzzy correction). Natural language processing is available for read-only queries when an API key is configured, but it never touches trade execution.

**Safety is infrastructure.** The signing guard, circuit breaker, and kill switch are not optional features. They run on every trade, enforce configurable limits, and cannot be bypassed.

**Fail safe.** When RPC connectivity is lost, the terminal enters read-only mode automatically. Trading commands are blocked until connectivity is restored. The system retries silently and recovers without user intervention.

---

## Safety & Reliability

| Layer | Purpose |
|:------|:--------|
| **Signing Guard** | Per-trade limits on collateral, position size, leverage. Rate limiter. Audit log. |
| **Circuit Breaker** | Halts trading on session/daily loss thresholds. Manual restart required. |
| **Kill Switch** | `TRADING_ENABLED=false` disables all trades instantly. |
| **Exposure Control** | Portfolio-level exposure cap. |
| **Pre-flight Simulation** | Every transaction simulated on-chain before broadcast. |
| **Program Whitelist** | Only Flash Trade and Solana system programs permitted. |
| **Instruction Freeze** | `Object.freeze()` on instructions after validation. |
| **Trade Mutex** | Prevents concurrent transaction submissions. |
| **Duplicate Detection** | Signature cache blocks re-submission of landed transactions. |
| **State Reconciliation** | Syncs local state with blockchain every 60 seconds. |

---

## Project Structure

```
src/
├── cli/            Command processing, terminal REPL, theme
├── client/         Flash SDK integration (live + simulation)
├── config/         Configuration loading and validation
├── core/           Runtime infrastructure, scheduler, TX engine
├── data/           Price service, analytics, protocol stats
├── earn/           Liquidity pools, FLP/sFLP management
├── journal/        Trade journal with SQLite persistence
├── markets/        Market registry and qualification
├── monitor/        Risk monitoring and alerts
├── network/        RPC manager, failover, health checks
├── observability/  Metrics, logging, alert hooks
├── orders/         Limit orders, TP/SL engine
├── portfolio/      Portfolio tracking and rebalancing
├── protocol/       Protocol inspection tools
├── risk/           Risk calculations, liquidation math
├── security/       Signing guard, circuit breaker, kill switch
├── system/         Diagnostics, maintenance, update checker
├── token/          FAF governance token integration
├── tools/          Tool definitions and dispatch (97 commands)
├── transaction/    Transaction construction, ATA handling
├── types/          TypeScript types and Zod schemas
├── utils/          Logger, formatting, retry, market resolver
└── wallet/         Wallet management, session lifecycle
```

156 TypeScript source files. 48,000+ lines. Strict mode, zero errors.

---

## Testing

```bash
npm test
```

71 test files. 1,743 assertions. Covers trading execution, simulation fidelity, command parsing, signing guard, circuit breaker, TP/SL automation, market resolution, protocol fee validation, earn/liquidity, FAF staking, swap, chaos resilience, and infrastructure hardening.

---

## Docker

```bash
docker build -t bolt-terminal .
docker run -it --env-file .env bolt-terminal
```

---

## Disclaimer

Flash Terminal executes real blockchain transactions on Solana mainnet in live mode. Leveraged perpetual futures trading carries significant risk of total loss. This software is provided as-is. It is not financial advice. Use at your own risk.

---

## License

MIT — see [LICENSE](LICENSE) for details.
