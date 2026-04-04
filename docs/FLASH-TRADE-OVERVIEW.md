# Flash Terminal -- Technical Overview

**Version:** 1.0.0
**License:** MIT
**Repository:** https://github.com/Abdr007/bolt-terminal

---

## Project Summary

Flash Terminal is a command-line trading interface for the Flash Trade perpetual futures protocol on Solana. It provides on-chain trade execution, natural language command parsing, multi-strategy market scanning, real-time liquidation risk monitoring, and protocol state inspection through a single CLI tool. The system operates in two modes: simulation (paper trading against live prices with a virtual balance) and live (signing and submitting real Solana transactions via the Flash SDK). All market data is sourced live from Pyth oracles, CoinGecko, and fstats.io. The terminal covers 8 Flash Trade pools spanning crypto majors, governance tokens, community tokens, commodities, forex, and tokenized equities.

---

## Key Capabilities

### On-Chain Trading Execution

The terminal builds, signs, and submits Solana transactions for opening and closing leveraged perpetual positions, as well as adding and removing collateral. Transactions use `MessageV0.compile` with manual construction. The pipeline provides `sendRawTransaction` with `maxRetries: 3`, confirmation polling every 2 seconds with periodic resends, a 45-second timeout per attempt with 3 attempts total, and a per-market trade mutex to prevent concurrent submissions.

### AI-Powered Command Interpretation

User input is resolved through a three-tier parser:

1. **Fast dispatch** -- Static lookup table for single-token commands. Zero latency, no external calls.
2. **Regex parser** -- Deterministic pattern matching with number word normalization and asset alias resolution.
3. **LLM fallback** -- Natural language input sent to an LLM when regex fails. Optional -- all commands work without AI keys.

All tiers produce a `ParsedIntent` struct validated by Zod schemas before execution.

### Market Scanning

Three independent strategies run across all markets with regime-weighted scoring:

- **Momentum** -- Detects strong directional moves from price changes and volume trends.
- **Mean Reversion** -- Identifies oversold/overbought conditions from price deviation and open interest.
- **Whale Follow** -- Detects large position clustering from on-chain whale activity.

A regime detector classifies current market conditions and dynamically adjusts strategy weights.

### Portfolio Monitoring

The portfolio engine tracks total exposure, directional bias, capital allocation, unrealized and realized PnL, and total fees. Position tables display market, side, leverage, size, collateral, entry price, mark price, PnL, fees, and liquidation price.

### Real-Time Risk Monitoring

A background engine checks liquidation distance on a tiered schedule (prices every 5 seconds, full position refresh every 20 seconds). Hysteresis thresholds prevent alert oscillation. The monitor auto-calculates the exact collateral needed to restore a safe liquidation distance.

### Protocol Inspection

Three levels of on-chain protocol inspection:

- `inspect protocol` -- Program ID, pool count, total open interest.
- `inspect pool <name>` -- Pool assets, utilization, OI breakdown.
- `inspect market <asset>` -- Long/short ratio, open interest, whale positions.

### Transaction Dry Run

The `dryrun` command compiles a transaction without signing or sending, runs Solana simulation, and displays program logs, compute units, account count, and estimated fees. Designed for protocol developers and security auditors.

---

## System Architecture

```
User Input
    |
    v
CLI REPL (readline)
    |
    +-- FAST_DISPATCH (51 exact-match commands)
    +-- Regex Parser (30+ patterns, number/alias normalization)
    +-- Context Tracker (follow-up command resolution)
    +-- LLM Engine (Anthropic/Groq, fallback only)
            |
            v
      ParsedIntent { action, params }
            |
            v
      Execution Middleware (logging, wallet check, readOnly guard)
            |
            v
      Tool Engine (tool dispatch + Zod validation)
            |
            +-- flash-tools (trading, wallet, market data)
            +-- agent-tools (analysis, scanner, autopilot)
            +-- plugin-tools (dynamically loaded)
            |
            v
      IFlashClient interface
            |
            +-- FlashClient (live: Flash SDK + Solana RPC)
            +-- SimulatedFlashClient (paper: in-memory)
            |
            v
      Flash Trade Protocol (Solana mainnet-beta)
```

---

## Security Model

- **Confirmation gates**: Every trade requires explicit `yes/no` confirmation. No bypass mechanism exists.
- **Wallet key protection**: Keys stored with `0600` permissions, never printed or logged. Path traversal prevention on wallet import.
- **Rate limiting**: Configurable trades-per-minute and minimum delay between trades.
- **Trade mutex**: Per-market/side locks prevent concurrent transaction submissions on all trade operations.
- **Audit logging**: All trade attempts logged with timestamp, market, side, size, and result. API keys auto-redacted from logs.
- **Response size limits**: 2MB for fstats, 1MB for CoinGecko responses.

---

## Design Goals

- **Developer-friendly CLI** -- Standard REPL with command history, no GUI required.
- **Transparent execution** -- Full trade details shown before signing. Blockchain state is always authoritative.
- **Defensive error handling** -- `Number.isFinite()` guards on all arithmetic, try/catch on all external calls, timeout enforcement.
- **Modular architecture** -- `IFlashClient` interface decouples tools from execution mode. Plugin system for extensibility.

---

## Future Extensions

- Hardware wallet signing (Ledger/Trezor via Solana wallet adapter)
- User-defined strategy plugins with `IStrategy` interface
- Trade history export and performance attribution
- WebSocket subscriptions for real-time position/OI updates
- Multi-protocol support behind the `IFlashClient` interface

---

## Repository Files

| File | Purpose |
|------|---------|
| `README.md` | Installation, configuration, usage, architecture overview |
| `LICENSE` | MIT License |
| `SECURITY.md` | Security policy and vulnerability reporting |
| `ARCHITECTURE.md` | System architecture and design decisions |
| `CONTRIBUTING.md` | Development setup, coding style, PR guidelines |
| `.env.example` | Environment configuration template |

---

## Message to Flash Trade Developers

Subject: Flash Terminal -- CLI Trading Interface for Flash Trade

To the Flash Trade team,

I am sharing Flash Terminal, an open-source command-line trading interface built on top of the Flash Trade protocol.

The project provides on-chain trade execution (open, close, add/remove collateral), multi-strategy market scanning, real-time liquidation risk monitoring, and protocol state inspection -- all from a terminal. It operates in both simulation and live modes, with live mode signing and submitting real transactions via the Flash SDK.

The codebase is TypeScript (strict mode, ESM), MIT-licensed, and includes full documentation: architecture guide, security policy, contributing guidelines, and environment configuration.

Repository: https://github.com/Abdr007/bolt-terminal

I would welcome any feedback on the integration approach, particularly around transaction construction, position lifecycle management, and pool/market resolution. If there are aspects of the Flash SDK or protocol that could be used more effectively, I am interested in hearing about them.

Thank you for building Flash Trade.

Best regards,
Abdulrahman
