# Flash Agent SDK

Programmatic interface to Flash Terminal for bots, AI agents, and automation.

## Installation

```bash
npm install bolt-terminal
```

## Quick Start

```typescript
import { FlashSDK } from 'bolt-terminal/sdk';

const flash = new FlashSDK();

// Get open positions
const { data } = await flash.positions();
console.log(data.positions);

// Open a trade
await flash.open({ market: 'SOL', side: 'long', leverage: 3, collateral: 50 });

// Close a trade
await flash.close({ market: 'SOL', side: 'long' });
```

## Configuration

```typescript
const flash = new FlashSDK({
  binPath: '/usr/local/bin/flash',  // Path to flash CLI (default: auto-detect)
  timeout: 15000,                    // Command timeout in ms (default: 15000)
  maxRetries: 1,                     // Retries for transient failures (default: 1)
  env: { SIMULATION_MODE: 'true' },  // Environment variables
  cwd: '/path/to/project',          // Working directory
});
```

## API Reference

### Core

| Method | Description |
|--------|-------------|
| `execute(command)` | Execute any command, return typed response |
| `executeRaw(command)` | Execute without throwing on failure |

### Trading

| Method | Description |
|--------|-------------|
| `positions()` | Get all open positions |
| `portfolio()` | Get portfolio overview |
| `open(params)` | Open a new position |
| `close(params)` | Close a position |
| `addCollateral(params)` | Add collateral to position |
| `removeCollateral(params)` | Remove collateral from position |
| `limitOrder(params)` | Place a limit order |
| `orders()` | List open limit orders |
| `closeAll()` | Close all positions |
| `tradeHistory()` | Get trade history |

### Market Data

| Method | Description |
|--------|-------------|
| `markets()` | List all available markets |
| `volume()` | Get 24h volume data |
| `openInterest()` | Get open interest data |
| `analyze(market)` | Analyze a specific market |
| `funding(market)` | Get funding rates |

### Earn / LP

| Method | Description |
|--------|-------------|
| `earn()` | Get earn pool status |
| `earnInfo(pool)` | Get pool details |
| `earnDeposit(params)` | Add liquidity |
| `earnWithdraw(params)` | Remove liquidity |
| `earnStake(params)` | Stake FLP |
| `earnUnstake(params)` | Unstake FLP |
| `earnClaim()` | Claim rewards |
| `earnDashboard()` | Get earn dashboard |

### FAF Token

| Method | Description |
|--------|-------------|
| `faf()` | Get FAF status |
| `fafStake(params)` | Stake FAF |
| `fafUnstake(params)` | Unstake FAF |
| `fafClaim()` | Claim FAF rewards |
| `fafTier()` | Get VIP tier info |

### Wallet

| Method | Description |
|--------|-------------|
| `walletBalance()` | Get SOL + USDC balance |
| `walletTokens()` | Get all token balances |
| `walletStatus()` | Get wallet status |
| `walletList()` | List saved wallets |

### System

| Method | Description |
|--------|-------------|
| `health()` | Run health check |
| `metrics()` | Get session metrics |
| `rpcStatus()` | Get RPC status |
| `systemStatus()` | Get system status |

### Protocol Inspection

| Method | Description |
|--------|-------------|
| `inspectProtocol()` | Protocol overview |
| `inspectPool(pool)` | Inspect a pool |
| `inspectMarket(market)` | Inspect a market |

### Risk & Analytics

| Method | Description |
|--------|-------------|
| `dashboard()` | Portfolio dashboard |
| `riskReport()` | Risk report |
| `exposure()` | Portfolio exposure |

## Response Schema

Every method returns a `FlashResponse<T>`:

```typescript
{
  success: true,
  command: "get_positions",
  timestamp: "2026-03-18T12:00:00.000Z",
  version: "v1",
  data: { positions: [...] },
  error: null
}
```

On failure:

```typescript
{
  success: false,
  command: "open_position",
  timestamp: "2026-03-18T12:00:00.000Z",
  version: "v1",
  data: {},
  error: {
    code: "INSUFFICIENT_BALANCE",
    message: "Not enough USDC to open position",
    details: { required: 100, available: 50 }
  }
}
```

## Error Handling

The SDK throws typed exceptions:

```typescript
import { FlashSDK, FlashError, FlashTimeoutError } from 'bolt-terminal/sdk';

try {
  await flash.open({ market: 'SOL', side: 'long', leverage: 3, collateral: 50 });
} catch (error) {
  if (error instanceof FlashTimeoutError) {
    console.log('Command timed out');
  } else if (error instanceof FlashError) {
    console.log(`Error [${error.code}]: ${error.message}`);
    console.log('Details:', error.details);
  }
}
```

Error classes:

| Class | When |
|-------|------|
| `FlashError` | Command returned an error (e.g. insufficient balance) |
| `FlashTimeoutError` | Command exceeded timeout |
| `FlashParseError` | CLI output was not valid JSON |
| `FlashProcessError` | CLI process crashed or exited with error |

### Error Codes

Common codes from `FlashError.code`:

- `INSUFFICIENT_BALANCE` — Not enough funds
- `MARKET_NOT_FOUND` — Invalid market name
- `POSITION_NOT_FOUND` — No position to close
- `DUPLICATE_POSITION` — Position already exists
- `RATE_LIMIT_EXCEEDED` — Too many trades
- `COMMAND_TIMEOUT` — Command timed out
- `DEGRADED_MODE` — RPC unavailable
- `PARSE_ERROR` — Invalid command syntax

## Watch Mode (Event Loop)

Poll a command at an interval with change detection:

```typescript
const handle = flash.watch('positions', (response, iteration) => {
  console.log(`Tick ${iteration}:`, response.data.positions);
}, {
  interval: 5000,       // Poll every 5 seconds
  deduplicate: true,    // Only emit on change (default)
  maxIterations: 100,   // Stop after 100 iterations (0 = unlimited)
});

// Stop the loop
handle.stop();
```

## Examples

### Basic Bot

```typescript
const flash = new FlashSDK({ env: { SIMULATION_MODE: 'true' } });

const { data } = await flash.positions();
if (data.positions.length === 0) {
  await flash.open({ market: 'SOL', side: 'long', leverage: 3, collateral: 50 });
}
```

### Risk Management Loop

```typescript
flash.watch('positions', async (response) => {
  for (const pos of response.data.positions ?? []) {
    if ((pos.pnlPercent ?? 0) < -10) {
      await flash.close({ market: pos.market, side: pos.side });
    }
  }
}, { interval: 10_000 });
```

### Arbitrary Command

```typescript
// Any CLI command works via execute()
const result = await flash.execute('earn info crypto');
console.log(result.data);
```

See `examples/` directory for complete, runnable examples:

- `basic-bot.ts` — Simple position management
- `strategy-loop.ts` — Continuous strategy with watch mode
- `risk-checker.ts` — Portfolio risk analysis with auto-fix

## Schema Version

The SDK uses the **v1** response contract. The `version` field in every response confirms the schema version. Breaking changes will increment the version.

## Architecture

```
Your Code
  └── FlashSDK (thin wrapper)
        └── flash exec "<command>" --format json (CLI subprocess)
              └── Flash Terminal (all business logic)
                    └── Solana / Flash Trade Protocol
```

The SDK does not duplicate any business logic. CLI is the source of truth.
