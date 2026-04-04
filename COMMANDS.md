# Flash Terminal — Command Reference

Flash Terminal is a deterministic protocol interaction tool for Flash Trade on Solana.

Every command operates on **live blockchain data**. There are no predictions, no automated strategies, and no AI-driven trade execution. The terminal provides transparent access to protocol state, market data, and trade execution — nothing more.

---

## Philosophy

- **Deterministic execution** — commands produce the same result given the same protocol state.
- **Protocol interaction** — direct access to Flash Trade smart contracts via Solana RPC.
- **Data transparency** — all displayed data comes from on-chain state or verified off-chain APIs (fstats, CoinGecko, Pyth).
- **Risk awareness** — risk metrics are computed from real position data, never estimated or projected.

---

## Command Categories

| # | Category | Purpose |
|---|---|---|
| 1 | **Trading** | Execute and manage leveraged positions, limit orders, TP/SL |
| 2 | **Earn (Liquidity)** | Provide liquidity, stake FLP, earn yield |
| 3 | **FAF Token** | Governance staking, revenue sharing, VIP tiers |
| 4 | **Market Data & Analytics** | Inspect live market conditions |
| 5 | **Portfolio & Risk** | Assess portfolio state and risk exposure |
| 6 | **Protocol Inspection** | Inspect Flash Trade protocol internals |
| 7 | **Wallet** | Manage wallet connections and balances |
| 8 | **Swap** | Token swaps via Flash Trade pools |
| 9 | **Utilities** | System tools, monitoring, diagnostics |

---

## 1. Trading

Commands that interact directly with Flash Trade smart contracts.

### Positions

| Command | Description | Example |
|---|---|---|
| `open` | Open a leveraged position | `open 5x long SOL $500` |
| `close` | Close an existing position | `close SOL long` |
| `close all` | Close all open positions | `close all` |
| `add` | Add collateral to a position | `add $200 to SOL long` |
| `remove` | Remove collateral from a position | `remove $100 from ETH long` |
| `positions` | View all open positions | `positions` |
| `position debug` | Protocol-level position inspection | `position debug SOL` |
| `markets` | List all available trading markets | `markets` |
| `trade history` | View recent trade journal | `trade history` |

### Parameters

**open** `<leverage>x <long|short> <market> $<collateral> [tp $<price>] [sl $<price>]`
- `leverage` — multiplier (e.g. `2x`, `5x`, `10x`). Per-market limits enforced.
- `long` / `short` — trade direction.
- `market` — asset symbol (e.g. `SOL`, `BTC`, `ETH`, `XAU`).
- `collateral` — USD amount to deposit as collateral.
- `tp` / `sl` — optional take-profit and stop-loss price targets.

**close** `<market> <long|short>`
- Closes the position on the specified market and side.

**add** `$<amount> to <market> <long|short>`
- Increases collateral, reducing effective leverage.

**remove** `$<amount> from <market> <long|short>`
- Withdraws collateral, increasing effective leverage.

### TP/SL Automation

| Command | Description | Example |
|---|---|---|
| `set tp` | Set take-profit target | `set tp SOL long $160` |
| `set sl` | Set stop-loss target | `set sl SOL long $120` |
| `remove tp` | Remove take-profit target | `remove tp SOL long` |
| `remove sl` | Remove stop-loss target | `remove sl SOL long` |
| `tp status` | View all active TP/SL targets | `tp status` |

The TP/SL engine evaluates targets every 5 seconds using live Pyth oracle prices. Spike protection requires 2 consecutive confirmation ticks before triggering a close.

### Limit Orders

| Command | Description | Example |
|---|---|---|
| `limit` | Place a limit order | `limit long SOL 2x $100 @ $82` |
| `orders` | View active limit orders | `orders` |
| `cancel order` | Cancel a limit order by ID | `cancel order 1` |
| `edit limit` | Edit a limit order price | `edit limit 1 $85` |

### Aliases

| Input | Resolves to |
|---|---|
| `position` | `positions` |
| `trades`, `journal`, `history` | `trade history` |
| `market` | `markets` |
| `tpsl status`, `tpsl` | `tp status` |
| `close-all`, `closeall`, `exit all` | `close all` |
| `order list`, `limit orders` | `orders` |

---

## 2. Earn (Liquidity)

Commands for providing liquidity to Flash Trade pools and earning yield.

| Command | Description | Example |
|---|---|---|
| `earn` | View all pools with live yield metrics | `earn` |
| `earn info` | Detailed pool information | `earn info crypto` |
| `earn deposit` | Deposit USDC → mint FLP (auto-compound) | `earn deposit $100 crypto` |
| `earn withdraw` | Burn FLP → receive USDC | `earn withdraw 100% crypto` |
| `earn add` | Add liquidity to a pool | `earn add $500 governance` |
| `earn remove` | Remove liquidity from a pool | `earn remove 50% crypto` |
| `earn stake` | Stake FLP tokens for USDC rewards | `earn stake $200 governance` |
| `earn unstake` | Unstake FLP tokens | `earn unstake 25% governance` |
| `earn claim` | Claim LP/staking USDC rewards | `earn claim` |
| `earn positions` | View your active LP positions | `earn positions` |
| `earn best` | Rank pools by yield + risk | `earn best` |
| `earn simulate` | Project yield returns for a deposit | `earn simulate $1000 crypto` |
| `earn dashboard` | Liquidity portfolio overview | `earn dashboard` |
| `earn pnl` | Earn profit & loss tracking | `earn pnl` |
| `earn demand` | Liquidity demand / utilization analysis | `earn demand` |
| `earn rotate` | Suggest liquidity rotation strategy | `earn rotate` |
| `earn integrations` | FLP integration partners | `earn integrations` |
| `earn history` | Historical APY data for a pool | `earn history crypto` |

### Details

**FLP** — Auto-compounding liquidity token. Fees are reinvested automatically, growing the token value.

**sFLP** — Staked FLP. Fees are paid out in USDC hourly rather than compounded.

### Aliases

| Input | Resolves to |
|---|---|
| `earn status`, `earn pools` | `earn` |
| `earn pos` | `earn positions` |
| `earn dash` | `earn dashboard` |
| `earn profit`, `earn performance` | `earn pnl` |
| `earn utilization` | `earn demand` |
| `earn optimize`, `earn rebalance` | `earn rotate` |
| `earn partners` | `earn integrations` |
| `earn add-liquidity` | `earn add` |
| `earn remove-liquidity` | `earn remove` |
| `earn claim-rewards` | `earn claim` |

---

## 3. FAF Token

Commands for FAF governance token staking, revenue sharing, and VIP tier management.

| Command | Description | Example |
|---|---|---|
| `faf` | FAF staking dashboard (stake, rewards, VIP tier) | `faf` |
| `faf stake` | Stake FAF for revenue sharing + VIP | `faf stake 1000` |
| `faf unstake` | Request FAF unstake (90-day linear unlock) | `faf unstake 500` |
| `faf claim` | Claim FAF rewards + USDC revenue | `faf claim` |
| `faf tier` | View VIP tier levels and benefits | `faf tier` |
| `faf rewards` | Show pending FAF rewards + USDC revenue | `faf rewards` |
| `faf referral` | Referral status + claimable rebates | `faf referral` |
| `faf points` | Voltage points tier + multiplier | `faf points` |
| `faf requests` | Pending unstake requests + progress | `faf requests` |
| `faf cancel` | Cancel an unstake request by index | `faf cancel 0` |

### Details

**VIP Tiers** — Staking FAF tokens unlocks fee discounts, higher referral rebates, and spot limit order / DCA discounts. Tiers range from Level 0 (no stake) to Level 5.

**Revenue Sharing** — 50% of protocol revenue is distributed to FAF stakers in USDC.

**Unstaking** — Tokens unlock linearly over 90 days. You continue earning revenue during the unlock period.

### Aliases

| Input | Resolves to |
|---|---|
| `faf status` | `faf` |
| `faf tiers`, `faf vip`, `faf levels` | `faf tier` |
| `faf referrals` | `faf referral` |
| `faf voltage` | `faf points` |
| `faf unstake requests`, `faf pending` | `faf requests` |
| `faf claim rewards`, `faf claim revenue`, `faf claim rebate` | `faf claim` |

---

## 4. Market Data & Analytics

Commands that display live market data. All data sourced from on-chain state, fstats API, CoinGecko, and Pyth oracles.

| Command | Description | Example |
|---|---|---|
| `scan` | Scan all markets for conditions | `scan` |
| `analyze` | Deep analysis with strategy signals | `analyze SOL` |
| `volume` | Protocol-wide trading volume | `volume` |
| `open interest` | Open interest breakdown by market | `open interest` |
| `leaderboard` | Top traders ranked by PnL or volume | `leaderboard` |
| `whale activity` | Recent large positions across markets | `whale activity` |
| `fees` | Protocol fee data | `fees` |
| `liquidations` | Liquidation clusters around current price | `liquidations SOL` |
| `funding` | Funding rate dashboard | `funding SOL` |
| `depth` | Liquidity depth around current price | `depth SOL` |
| `protocol health` | Protocol-wide health metrics | `protocol health` |

### Details

**scan** — Evaluates all markets using momentum, mean reversion, and whale-follow signals. Returns ranked opportunities with confidence scores and regime labels.

**analyze** — Single-market deep dive. Shows price action, 24h change, open interest, funding rate, and computed strategy signals.

**volume** — Aggregated trading volume with daily breakdown. Supports period filtering.

**leaderboard** — Top traders by PnL or volume. Supports metric and period filtering.

**liquidations** — Estimates liquidation price clusters by distributing open interest across leverage bands (2x-50x). Includes whale position liquidation levels. Shows distance from current price.

**funding** — Single-market view: current funding rate, projected 1h/4h/24h accumulation, OI balance with imbalance detection. Without a market argument, shows funding rate overview for all markets.

**depth** — Estimates liquidity distribution around current price using OI and exponential decay modeling. Displays bid/ask depth bands with visual bar chart.

**protocol health** — Aggregated protocol view: active markets, total OI, long/short ratio, 30d activity stats, top markets by OI, infrastructure metrics.

### Aliases

| Input | Resolves to |
|---|---|
| `oi` | `open interest` |
| `whales` | `whale activity` |
| `fee` | `fees` |
| `rankings` | `leaderboard` |

---

## 5. Portfolio & Risk

Commands that assess current portfolio state and risk metrics. All calculations use live position data.

| Command | Description | Example |
|---|---|---|
| `portfolio` | Portfolio overview (balance, positions, PnL) | `portfolio` |
| `dashboard` | Full system dashboard (portfolio + markets + risk) | `dashboard` |
| `risk report` | Position-level liquidation risk assessment | `risk report` |
| `exposure` | Portfolio exposure breakdown by market and direction | `exposure` |
| `rebalance` | Analyze portfolio for rebalancing opportunities | `rebalance` |

### Details

**risk report** — For each open position: distance to liquidation, risk level (healthy / warning / critical), and exposure summary.

**exposure** — Breaks down notional exposure by market and direction. Flags concentration risk when a single market exceeds 30% of total capital.

**dashboard** — Combined view: portfolio state, top markets, position table, risk summary.

### Aliases

| Input | Resolves to |
|---|---|
| `balance`, `account` | `portfolio` |
| `dash` | `dashboard` |
| `risk` | `risk report` |
| `capital`, `portfolio state` | Portfolio capital state |
| `portfolio exposure` | `exposure` |
| `portfolio rebalance` | `rebalance` |

---

## 6. Protocol Inspection

Commands for inspecting Flash Trade protocol state on-chain.

| Command | Description | Example |
|---|---|---|
| `inspect protocol` | Flash Trade protocol overview | `inspect protocol` |
| `inspect pool` | Inspect a specific liquidity pool | `inspect pool Crypto.1` |
| `inspect market` | Deep inspection of a market | `inspect market SOL` |
| `protocol fees` | On-chain fee rate verification | `protocol fees SOL` |
| `protocol verify` | Full protocol alignment audit | `protocol verify` |
| `source verify` | Verify data provenance for a market | `source verify SOL` |

### Returns

**inspect protocol** — Program ID, pool list, aggregate open interest, long/short ratio, risk metrics.

**inspect pool** — Pool configuration, supported markets, total OI, utilization.

**inspect market** — Market parameters, funding rate, liquidity depth, open interest breakdown, whale positions.

### Aliases

| Input | Resolves to |
|---|---|
| `inspect` | `inspect protocol` |
| `verify source` | `source verify` |

---

## 7. Wallet

Commands for managing Solana wallet connections.

| Command | Description | Example |
|---|---|---|
| `wallet` | Show wallet connection status | `wallet` |
| `wallet tokens` | View all token balances | `wallet tokens` |
| `wallet balance` | Show SOL balance | `wallet balance` |
| `wallet list` | List saved wallets | `wallet list` |
| `wallet import` | Import and store a wallet | `wallet import main /path/to/key.json` |
| `wallet use` | Switch to a saved wallet | `wallet use main` |
| `wallet connect` | Connect a wallet file directly | `wallet connect /path/to/key.json` |
| `wallet disconnect` | Disconnect the active wallet | `wallet disconnect` |

### Aliases

| Input | Resolves to |
|---|---|
| `wallet status` | `wallet` |
| `wallet address` | Show wallet public key |

---

## 8. Swap

| Command | Description | Example |
|---|---|---|
| `swap` | Swap tokens via Flash Trade pools | `swap SOL USDC $10` |

Swaps are executed through Flash Trade's pool liquidity. Only available in live mode with a connected wallet.

---

## 9. Utilities

System tools and operational commands.

| Command | Description | Example |
|---|---|---|
| `dryrun` | Preview a trade without signing | `dryrun open 2x long SOL $10` |
| `monitor` | Live-updating market table (5s refresh) | `monitor` |
| `system status` | System health overview | `system status` |
| `system audit` | Verify protocol data integrity | `system audit` |
| `protocol status` | Protocol connection overview | `protocol status` |
| `rpc status` | Active RPC endpoint info | `rpc status` |
| `rpc test` | Test all configured RPC endpoints | `rpc test` |
| `tx inspect` | Inspect a transaction by signature | `tx inspect 4xK...` |
| `tx debug` | Debug transaction with protocol context | `tx debug 4xK...` |
| `tx metrics` | TX engine performance stats | `tx metrics` |
| `engine status` | Show execution engine info | `engine status` |
| `benchmark engine` | Benchmark execution engines | `benchmark engine` |
| `doctor` | Run terminal diagnostic checks | `doctor` |
| `degen` | Toggle degen mode (high leverage) | `degen` |
| `help` | Show command reference | `help` |
| `exit` | Close the terminal | `exit` |

### Details

**dryrun** — Parses the trade command, resolves the market and pool, computes fees, and displays a full transaction preview. No transaction is signed or broadcast.

**monitor** — Full-screen live market table showing price, 24h change, open interest, and long/short ratio for all markets. Sorted by OI. Press any key to exit.

**doctor** — Runs connectivity, configuration, and health checks. Reports issues with RPC, wallet, or SDK configuration.

**degen** — Enables extended leverage limits (up to 500x on SOL/BTC/ETH) per protocol configuration. Use with extreme caution.

### Aliases

| Input | Resolves to |
|---|---|
| `system` | `system status` |
| `market monitor` | `monitor` |
| `commands`, `?` | `help` |
| `quit` | `exit` |
| `protocol` | `protocol status` |
| `engine` | `engine status` |
| `engine benchmark` | `benchmark engine` |
| `tx stats`, `tx perf`, `tx engine` | `tx metrics` |

---

## Natural Language

The terminal also accepts natural language input, parsed via AI or regex patterns.

Examples:
- `what's the price of SOL?` → market data lookup
- `show me BTC analysis` → `analyze BTC`
- `how are my positions doing?` → `positions`

Natural language is a convenience layer. All commands above work deterministically without AI.

---

## Non-Interactive CLI Commands

Flash Terminal also supports non-interactive commands for scripting and automation:

```bash
flash markets          # List all markets
flash stats            # Show protocol stats
flash leaderboard      # Trader leaderboard
flash doctor           # System diagnostics
flash price <market>   # Get current price
flash version          # Version and build info
flash update           # Check for updates
flash completion <sh>  # Shell completion script (bash/zsh/fish)
```

These commands execute and exit immediately — no interactive session required.
