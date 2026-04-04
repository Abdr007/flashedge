<div style="display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 85vh; text-align: center;">
  <img src="assets/logo.svg" width="100" height="100" alt="Flash Terminal" style="margin-bottom: 30px;" />
  <h1 style="font-size: 36px; margin: 0 0 8px 0;">FLASH TERMINAL</h1>
  <h3 style="font-size: 16px; font-weight: 400; color: #586069; margin: 0 0 30px 0;">Study Notes for Showcase</h3>
  <p style="font-size: 12px; color: #6a737d;">March 2026</p>
</div>

<div style="page-break-after: always;"></div>

# What is Flash Terminal?

Flash Terminal is a **command-line trading app** that lets you trade perpetual futures on **Solana blockchain** using the **Flash Trade protocol**.

Think of it like this:

> You type a command like `open 5x long SOL $100` → the app figures out what you want → checks if it's safe → builds a transaction → sends it to Solana → confirms it landed.

**Key numbers:**
- ~28,000 lines of TypeScript
- 462 automated tests
- 40+ tradeable markets (crypto, commodities, forex, stocks)
- Works in simulation mode (fake money) and live mode (real money on mainnet)

---

# The Big Picture — How Everything Connects

```
YOU (type a command)
  │
  ▼
┌─────────────────────────┐
│  CLI Terminal (REPL)     │  ← The screen you type into
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│  Command Parser          │  ← Understands what you typed
│  (regex first, AI later) │
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│  Tool Engine             │  ← Picks the right action
│  (dispatch + middleware)  │
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│  Safety Gates            │  ← Checks before executing
│  (circuit breaker,       │
│   signing guard,         │
│   rate limiter)          │
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│  Flash Client            │  ← Builds & sends transaction
│  (11-stage pipeline)     │
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│  Solana Blockchain       │  ← Where the trade actually happens
│  (Flash Trade program)   │
└─────────────────────────┘
```

**Background services running at the same time:**
- **Risk Monitor** — checks your positions every 5 seconds
- **TP/SL Engine** — auto-closes positions when price hits your target
- **RPC Health Monitor** — checks if your Solana connection is healthy
- **State Reconciliation** — syncs your local state with blockchain every 60s

---

<div style="page-break-before: always;"></div>

# 1. The Terminal (CLI)

**What it is:** An interactive command prompt. You type, it responds.

**How it works:**

1. You type something like `"positions"` or `"open 5x long SOL $100"`
2. First check: **FAST_DISPATCH** — a lookup table with ~50 common commands
   - If found → instant response (no AI needed)
   - Example: `"positions"` → immediately shows your positions
3. If not found → **regex parser** tries to match your input
   - Pattern: `open [leverage] [long/short] [market] [$amount]`
   - 30+ regex patterns for different commands
4. If regex fails → **AI fallback** (Anthropic/Groq) interprets your text
   - Only for read-only queries, NEVER for trades
5. Result goes to **Tool Engine** for execution

**Why this matters:** Commands are parsed deterministically (same input = same action, every time). AI never touches your money.

**Key commands to demo:**
| Command | What it does |
|:--------|:-------------|
| `open 5x long SOL $100` | Open a leveraged long position |
| `close SOL long` | Close that position |
| `positions` | Show all open positions |
| `portfolio` | Show balance, PnL, exposure |
| `tp SOL long $200` | Set take-profit at $200 |
| `sl SOL long $80` | Set stop-loss at $80 |
| `monitor` | Live market dashboard |
| `risk monitor on` | Start background risk alerts |
| `doctor` | System health check |

---

<div style="page-break-before: always;"></div>

# 2. Command Parser (Interpreter)

**What it is:** Translates your English into a structured command the system understands.

**The flow:**

```
"open 5x long SOL $100"
        │
        ▼
  Regex Match Found!
        │
        ▼
  ParsedIntent = {
    action: "open_position",
    market: "SOL",
    side: "long",
    leverage: 5,
    collateral: 100
  }
```

**Smart features:**
- **Asset aliases:** "solana" → SOL, "bitcoin" → BTC, "gold" → XAU
- **Number words:** "twenty five" → 25
- **Context memory:** If you say `"analyze SOL"` then `"close it"`, it remembers SOL
- **Validation:** Rejects negative amounts, impossible leverage, NaN values

**Why deterministic?** If AI parsed trades, it could hallucinate wrong values. Regex is predictable — `"open 5x long SOL $100"` will ALWAYS parse to exactly those values.

---

# 3. Tool Engine (Dispatch)

**What it is:** The routing layer. Takes a parsed command and runs the right tool.

**How it works:**

```
ParsedIntent {action: "open_position"}
        │
        ▼
  Switch on action type
        │
        ▼
  Maps to tool: "flash_open_position"
        │
        ▼
  But first... run middleware:
    ✓ Circuit breaker — not tripped?
    ✓ Signing guard — within limits?
    ✓ Rate limiter — not too fast?
        │
        ▼
  Execute tool → return result
```

**50+ tools available:**
- **Trading:** open, close, add collateral, remove collateral
- **Data:** prices, positions, portfolio, volume, open interest
- **Risk:** TP/SL, circuit breaker status, risk monitor
- **Wallet:** connect, import, switch, balance, tokens
- **System:** diagnostics, RPC status, trade history

---

<div style="page-break-before: always;"></div>

# 4. The Trade Pipeline (Most Important!)

**What it is:** The 11 stages a trade goes through from your command to landing on Solana.

This is the core of the system. Every trade follows these exact steps:

### Stage 1 — Validation
- Is the wallet connected and not corrupted?
- Do all instructions target **approved programs only**? (whitelist)
- Freeze the instruction array (can't be tampered with after validation)

### Stage 2 — Route Check
- If Ultra-TX engine is available, use it (advanced multi-endpoint broadcast)

### Stage 3 — Setup
- Prepare for up to 3 attempts
- Build compute budget instructions (priority fees)

### Stage 4 — Check Previous Attempt
- If this is retry #2 or #3, first check: did the last attempt actually land?
- This prevents sending duplicate transactions

### Stage 5 — Get Blockhash
- Fetch latest blockhash from Solana (like a "valid until" timestamp)
- First attempt uses cache (faster), retries always fetch fresh

### Stage 6 — Build Transaction
- Compile all instructions into a Solana MessageV0
- Sign with your wallet keypair

### Stage 7 — Simulate First
- On attempt #1: simulate the transaction without broadcasting
- If simulation shows a program error → stop immediately (save fees)
- If simulation fails for network reasons → try broadcasting anyway

### Stage 8 — Broadcast
- Send raw transaction to Solana with `maxRetries: 3`
- Log the signature

### Stage 9 — Wait for Confirmation
- Poll every 2 seconds for up to 45 seconds
- Every 4 seconds: resend transaction (in case first broadcast was lost)
- If confirmed → done!

### Stage 10 — Final Check
- If 45s timeout: one last status check before giving up
- Sometimes transactions land just after the timeout

### Stage 11 — Retry or Fail
- If failed: go back to Stage 4 with next attempt
- After 3 failed attempts: throw error with Solscan link for debugging

---

<div style="page-break-before: always;"></div>

# 5. Safety Systems

### Circuit Breaker
**What:** Emergency stop that halts ALL trading when you lose too much.

```
You lose $500... keep trading...
You lose $1000... circuit breaker TRIPS
→ All trades blocked until you manually reset
```

**Tracks:**
- Session loss (since you started the app)
- Daily loss (resets at midnight)
- Trade count (max trades per session)

**Config:** `MAX_SESSION_LOSS_USD`, `MAX_DAILY_LOSS_USD`, `MAX_TRADES_PER_SESSION`

---

### Signing Guard
**What:** Security gate that checks every trade before you sign it.

**Checks:**
1. **Trade size limits** — collateral and position size within allowed max
2. **Leverage limits** — not exceeding maximum leverage
3. **Rate limiting** — min 3 seconds between trades, max 10 trades/minute
4. **Audit log** — every trade attempt logged to `~/.flash/signing-audit.log`

**Why rate limiting?** Prevents accidental rapid-fire trades (e.g., pressing enter too fast)

---

### Kill Switch
**What:** Master toggle. When ON, no trades can execute. Period.

```
kill switch on  → all trading blocked instantly
kill switch off → trading resumes
```

---

### Program Whitelist
**What:** Only approved Solana programs can be in your transaction.

This prevents malicious instructions from sneaking in. The whitelist includes:
- Solana system programs (System, Token, ComputeBudget)
- Flash Trade programs (loaded from each pool's config)

After validation, instructions are **frozen** (`Object.freeze`) — they can't be modified between validation and signing.

---

<div style="page-break-before: always;"></div>

# 6. Simulation vs Live Mode

### Simulation Mode (Default)
- Uses **real prices** from Pyth oracle (same data as live)
- Trades happen **in memory only** (no real transactions)
- Starts with $10,000 fake balance
- Fees simulated at 0.08% of position size
- PnL tracked realistically
- Perfect for testing strategies

### Live Mode
- Real wallet, real SOL, real transactions on Solana mainnet
- Goes through the full 11-stage pipeline
- Every trade costs real gas fees + protocol fees
- Requires wallet connection with funded keypair

**Both modes use the same interface** — same commands, same output format. The only difference is whether transactions are real.

**Switch between them:**
```
SIMULATION_MODE=true   → simulation (default)
SIMULATION_MODE=false  → live trading
```

---

# 7. Price System (Pyth Oracle)

**What:** All prices come from **Pyth Hermes** — a decentralized oracle network.

**How it works:**
1. App requests prices from `hermes.pyth.network`
2. Each market has a unique **feed ID** (hardcoded for 40+ markets)
3. Prices cached for 5 seconds (Pyth is free, no rate limits)
4. Price recorded every 1 minute into history file
5. 24h change calculated from historical data

**Why Pyth?**
- Same oracle that Flash Trade protocol uses on-chain
- Free API, no rate limits
- Sub-second price updates
- Covers crypto, commodities, forex, and equities

**Coverage:** SOL, BTC, ETH, BNB, Gold, Silver, Crude Oil, EUR, GBP, SPY, NVDA, TSLA, and 30+ more

---

<div style="page-break-before: always;"></div>

# 8. Risk Monitoring

### Background Risk Monitor
**What:** Watches your positions every 5 seconds for liquidation risk.

**How risk is measured:**
```
distance = how far current price is from liquidation price

SAFE      → distance > 35%   (green, you're fine)
WARNING   → distance 15-30%  (yellow, add collateral?)
CRITICAL  → distance < 15%   (red, about to get liquidated!)
```

**Hysteresis** (prevents alert spam):
- Enter WARNING at 30%, recover to SAFE at 35%
- Enter CRITICAL at 15%, recover to WARNING at 18%
- This gap prevents flickering between states

**Auto-suggestion:** When risk is high, it calculates exactly how much collateral to add using binary search.

### TP/SL Engine (Take-Profit / Stop-Loss)
**What:** Automatically closes your position when price hits a target.

```
You set: tp SOL long $200
         sl SOL long $80

Price hits $200 → position auto-closed (profit taken!)
Price hits $80  → position auto-closed (loss limited!)
```

**Spike protection:** Requires **2 consecutive ticks** above the threshold before triggering. This prevents closing on a 1-second price spike that immediately reverses.

---

# 9. RPC Failover

**What:** If your Solana connection dies, the system automatically switches to a backup.

**How it works:**
1. You configure up to 3 RPC endpoints (primary + 2 backups)
2. Background health check runs every 30 seconds
3. Tracks: latency, failure rate, slot lag
4. If active endpoint fails:
   - Record failure
   - If failure rate > 50% → auto-failover to next endpoint
   - If slot lag > 50 → auto-failover (endpoint is behind)
5. Cooldown: minimum 60 seconds between failovers (prevents bouncing)

**Slot lag:** Measures how many blocks behind an endpoint is. If it's 50+ blocks behind the best endpoint, it's too stale to use.

---

<div style="page-break-before: always;"></div>

# 10. State Reconciliation

**What:** Syncs your app's state with the actual blockchain state.

**Why needed:** Your app might think a position is open, but on-chain it was already liquidated. Or you closed a position from another app. Reconciliation fixes this.

**When it runs:**
- On startup
- After wallet connect/switch
- After every confirmed trade
- Every 60 seconds in the background

**How it handles mismatches:**
1. First mismatch → retry RPC (might be transient)
2. Still mismatched → increment counter
3. After 3 consecutive mismatches → accept blockchain as truth, update local state

**Rule:** Blockchain is always authoritative. If there's a conflict, blockchain wins.

---

# 11. Security Highlights

| Threat | Protection |
|:-------|:-----------|
| Malicious instructions in transaction | Program whitelist + instruction freeze |
| Rapid-fire accidental trades | Rate limiter (3s min gap, 10/min max) |
| Excessive losses | Circuit breaker (session + daily limits) |
| Wallet key corruption | Keypair integrity check before every sign |
| RPC endpoint injection | URL validation (HTTPS only, no private IPs) |
| Log file disk exhaustion | 10MB rotation with .old/.old.2 backups |
| API response OOM | Max response size (2MB fstats, 1MB CoinGecko) |
| Duplicate transactions | Signature cache (60s TTL) + pre-send check |
| Concurrent trade race condition | Trade mutex per market/side |
| API keys in logs | Log scrubbing (masks sk-ant-***, gsk_***) |

---

<div style="page-break-before: always;"></div>

# 12. Key Architecture Decisions (Why We Built It This Way)

### "Why not let AI parse all commands?"
AI can hallucinate. If AI misreads `"open 5x long SOL $100"` as `"open 50x long SOL $1000"`, you lose real money. Regex is deterministic — same input, same output, every time. AI is only used for read-only queries where mistakes are harmless.

### "Why simulation mode by default?"
Safety. New users shouldn't accidentally trade real money. Simulation uses real oracle prices so strategies transfer directly to live mode.

### "Why a 11-stage pipeline instead of just send and pray?"
Solana transactions can fail silently — you get a signature back but the transaction never lands. The pipeline handles: simulation before broadcast, confirmation polling, late-delivery detection, automatic retries, and RPC failover. Without this, you'd lose track of your money.

### "Why freeze instructions after validation?"
Time-of-check-to-time-of-use (TOCTOU) attack. Between validating instructions and signing them, something could modify the array. `Object.freeze()` prevents this.

### "Why hysteresis in risk monitoring?"
Without it, if your distance to liquidation is at exactly 30%, alerts would flip between WARNING and SAFE every tick. Hysteresis uses separate thresholds (enter at 30%, exit at 35%) to prevent this oscillation.

### "Why 3 consecutive mismatches before reconciliation?"
RPC endpoints sometimes return stale data. If we removed positions after one mismatch, a single slow RPC response could wipe your local state. Three consecutive mismatches confirms it's real.

---

<div style="page-break-before: always;"></div>

# 13. Demo Flow — What to Show Tomorrow

### Step 1: Start in Simulation Mode
```bash
npm start
# Select: Simulation Mode
```

### Step 2: Show Basic Commands
```
help                    → see all commands
markets                 → show tradeable markets
SOL price               → get current price
```

### Step 3: Open a Trade
```
open 5x long SOL $100   → opens leveraged position
positions                → see your position with live PnL
portfolio                → see balance and exposure
```

### Step 4: Risk Management
```
tp SOL long $200         → set take-profit
sl SOL long $80          → set stop-loss
tp status                → see active TP/SL targets
risk monitor on          → start background monitoring
```

### Step 5: Market Intelligence
```
monitor                  → live market dashboard (press any key to exit)
inspect protocol         → protocol-wide stats
analyze SOL              → AI analysis of SOL market
```

### Step 6: System Health
```
doctor                   → full system diagnostics
rpc status               → RPC endpoint health
tx metrics               → transaction performance stats
```

### Step 7: Close and Review
```
close SOL long           → close position
portfolio                → see updated balance with PnL
trade history            → see all trades this session
```

---

<div style="page-break-before: always;"></div>

# 14. Quick Stats to Mention

| Metric | Value |
|:-------|:------|
| Total codebase | ~28,000 lines TypeScript |
| Automated tests | 462 passing |
| Tradeable markets | 40+ (crypto, commodities, forex, equities) |
| Trade pipeline stages | 11 |
| Safety gates | 6 (circuit breaker, signing guard, kill switch, whitelist, mutex, rate limiter) |
| RPC endpoints | Up to 3 with auto-failover |
| Price source | Pyth Hermes (same oracle as Flash Trade on-chain) |
| Risk monitoring | Every 5 seconds |
| State reconciliation | Every 60 seconds |
| Confirmation polling | Every 2 seconds, up to 45 seconds |
| Security vulnerabilities found & fixed | 6 |
| Production readiness score | 96/100 |

---

# 15. If They Ask Tough Questions

**"How do you handle RPC failures mid-transaction?"**
→ The pipeline has 3 attempts. If an RPC fails, it records the failure, triggers failover to a backup endpoint, and retries. Before retrying, it checks if the previous attempt actually landed (late-delivery detection).

**"What prevents duplicate trades?"**
→ Three layers: trade mutex (one trade per market/side at a time), signature cache (60s TTL blocks same trade), and pre-send check for existing positions on-chain.

**"How do you know the liquidation price is correct?"**
→ In live mode, we use Flash SDK's `getLiquidationPriceContractHelper()` which mirrors the exact on-chain calculation. In simulation, we replicate the formula with the same parameters.

**"What happens if the app crashes mid-trade?"**
→ State reconciliation on next startup. It fetches all positions from blockchain and syncs local state. Blockchain is always the source of truth.

**"Why TypeScript and not Rust?"**
→ Flash SDK is JavaScript-based. TypeScript gives us type safety (Zod schemas, strict mode) while maintaining SDK compatibility. The performance-critical part (transaction execution) happens on-chain in Rust — our job is to build and submit transactions correctly.

**"How fast are trades?"**
→ Typical: 2-5 seconds from command to confirmation. Blockhash cached, instructions pre-built, priority fees set. The bottleneck is Solana confirmation time, not our code.

---

<div style="page-break-before: always;"></div>

# 16. Complete Transaction Lifecycle — What Actually Happens

This is the full story of what happens when you type `open 5x long SOL $100` from start to finish.

### Phase 1: Your Command Becomes an Intent
```
You type: "open 5x long SOL $100"
                │
                ▼
Terminal receives the text
                │
                ▼
Check FAST_DISPATCH table → not found (it's a trade, not a keyword)
                │
                ▼
Regex parser matches pattern:
  open [5]x [long] [SOL] [$100]
                │
                ▼
Creates ParsedIntent:
  { action: OpenPosition,
    market: "SOL",
    side: "long",
    leverage: 5,
    collateral: 100 }
```

### Phase 2: Safety Gates (Before Anything Happens)
```
ParsedIntent arrives at Tool Engine
                │
                ▼
Gate 1: Kill Switch → is it ON? → if yes, BLOCK. done.
                │ (no)
                ▼
Gate 2: Circuit Breaker → has loss limit been hit? → if yes, BLOCK.
                │ (no)
                ▼
Gate 3: Signing Guard
  → Is collateral ($100) within max limit? ✓
  → Is leverage (5x) within max limit? ✓
  → Is position size ($500) within max limit? ✓
  → Rate limit: was last trade >3s ago? ✓
  → Trades this minute < 10? ✓
                │ (all pass)
                ▼
Gate 4: Trade Mutex → is there already a SOL-long trade in-flight? → if yes, WAIT.
                │ (no)
                ▼
Proceed to execution
```

### Phase 3: Building the Transaction
```
Tool: flash_open_position executes
                │
                ▼
Look up pool: SOL is in "Crypto.1" pool
                │
                ▼
Check: does a SOL long position already exist on-chain?
  → Query Flash SDK getUserPositions()
  → If yes: BLOCK ("duplicate position")
                │ (no existing)
                ▼
Build instructions using Flash SDK:
  1. ComputeBudget instruction (set priority fee)
  2. Flash Trade openPosition instruction
     → pool address, market index, collateral, leverage, side
                │
                ▼
Validate all instructions:
  → Every program ID must be in WHITELIST
  → Whitelist = Solana system programs + Flash Trade programs
  → If unknown program found → BLOCK immediately
                │ (all whitelisted)
                ▼
FREEZE instructions (Object.freeze)
  → Nobody can modify them after this point
```

### Phase 4: Signing & Broadcasting (The 11 Stages)
```
Attempt 1 of 3:
                │
                ▼
Verify keypair integrity
  → Is the secret key still valid? (not zeroed/corrupted)
  → If corrupted → BLOCK ("wallet disconnected")
                │ (valid)
                ▼
Get blockhash (cached if fresh, otherwise fetch from Solana)
  → Blockhash = "this transaction is valid until block X"
  → Background refreshes every 5s so it's usually cached
                │
                ▼
Build VersionedTransaction (MessageV0)
  → Compile instructions + blockhash + payer
  → Sign with your wallet keypair
                │
                ▼
Pre-send simulation (attempt 1 only)
  → Solana simulates without broadcasting
  → If program error → STOP (saves gas fees)
  → If network error → continue anyway (might work)
                │ (simulation OK)
                ▼
BROADCAST → sendRawTransaction to Solana
  → skipPreflight: true (we already simulated)
  → maxRetries: 3 (Solana node retries internally too)
  → Get back: signature string (e.g., "4xK8j...")
                │
                ▼
Confirmation polling loop (every 2 seconds, up to 45 seconds):
  → getSignatureStatuses([signature])
  → Status = null? → not processed yet, keep waiting
  → Status = {err: ...}? → on-chain error, THROW
  → Status = confirmed? → SUCCESS! 🎉
  → Every 4 seconds: resend transaction (delivery insurance)
                │
         ┌──────┴──────┐
    Confirmed?      Timeout (45s)?
         │               │
         ▼               ▼
    Return           Final status check (one more try)
    signature           │
                   ┌────┴────┐
              Confirmed?   Still nothing?
                   │           │
                   ▼           ▼
              Return      Go to Attempt 2
              signature    (back to blockhash step)
```

### Phase 5: After Confirmation
```
Transaction confirmed on Solana!
                │
                ▼
Log to signing audit: timestamp, market, side, result=confirmed
                │
                ▼
Record in signature cache (60s TTL, prevents re-submission)
                │
                ▼
Clear wallet balance cache (balance changed)
                │
                ▼
Release trade mutex (SOL-long slot now free)
                │
                ▼
Display to user:
  "Opened 5x long SOL — $500 size, $100 collateral
   Entry: $142.50 | Liq: $119.20
   Signature: 4xK8j... (solscan link)"
                │
                ▼
Background systems pick up the new position:
  → Risk Monitor (next 5s tick): sees new position, starts tracking
  → TP/SL Engine: if targets were set, starts monitoring price
  → State Reconciler (next 60s cycle): confirms position on-chain
```

### What If It Fails?
```
Attempt 1 fails (timeout)
  → Check: did previous signature actually land? (late delivery check)
  → If yes → return that signature (no duplicate!)
  → If no → Attempt 2 with FRESH blockhash

Attempt 2 fails (RPC error)
  → Record failure in RPC manager
  → Trigger failover to backup endpoint
  → Attempt 3 on new RPC endpoint

Attempt 3 fails
  → THROW error with:
    - Last known signature
    - Solscan link (so you can check manually)
    - "Transaction may still land — check Solscan"
```

---

<div style="page-break-before: always;"></div>

# 17. Flash Trade Protocol Primer — How the On-Chain Program Works

### What is a Perpetual Future?

A **perpetual future** (or "perp") is a contract that lets you bet on whether an asset's price will go up or down, with **leverage**, and it **never expires**.

**Real-world analogy:**
> Imagine you have $100. You want to bet that SOL price goes up.
> With 5x leverage, the protocol lets you control $500 worth of SOL.
> You only risk your $100 (your "collateral").
>
> SOL goes up 10%: Your $500 position gains $50. You made 50% on your $100.
> SOL goes down 20%: Your $500 position loses $100. You're liquidated. Collateral gone.

### Key Concepts

**Long** = you profit when price goes UP
**Short** = you profit when price goes DOWN

**Collateral** = the money you put up as margin (your risk)
**Leverage** = the multiplier (5x means you control 5× your collateral)
**Position Size** = collateral × leverage ($100 × 5x = $500)

**Entry Price** = the price when you opened the trade
**Mark Price** = the current oracle price (from Pyth)
**Liquidation Price** = if mark price hits this, you lose everything

**PnL (Profit & Loss):**
```
Long:  PnL = (markPrice - entryPrice) / entryPrice × positionSize
Short: PnL = (entryPrice - markPrice) / entryPrice × positionSize
```

**Example:**
```
Open: 5x long SOL at $140, collateral $100
Position size = $500

SOL goes to $154 (+10%):
  PnL = ($154 - $140) / $140 × $500 = $50 profit
  Your $100 is now worth $150 (50% return!)

SOL drops to $126 (-10%):
  PnL = ($126 - $140) / $140 × $500 = -$50 loss
  Your $100 is now worth $50

SOL drops to ~$114 (-18.5%):
  PnL ≈ -$92.50
  Approaching liquidation (collateral nearly wiped out)
  Protocol force-closes your position to protect the pool
```

### How Flash Trade Works On-Chain

```
┌─────────────────────────────────┐
│         LIQUIDITY POOL          │
│  (Crypto.1, Virtual.1, etc.)   │
│                                 │
│  Funded by liquidity providers  │
│  who deposit USDC              │
│  They earn fees from traders    │
└──────────┬──────────────────────┘
           │
    Traders trade AGAINST the pool
    (not against each other)
           │
    ┌──────┴──────┐
    │             │
  Trader A     Trader B
  Long SOL     Short BTC
  5x, $100     3x, $200
```

**The pool is the counterparty.** When you go long and profit, the pool pays you. When you lose, the pool keeps your collateral.

### Pool Structure

Each pool has **custody accounts** that store:
- Fee rates (open fee, close fee, borrow fee)
- Maximum leverage per market
- Current open interest (total longs vs shorts)

**Flash Terminal reads these on-chain accounts** to get accurate fee rates and leverage limits.

### How a Trade Executes On-Chain

```
1. Your terminal builds a transaction with Flash SDK
2. Transaction contains an "openPosition" instruction
3. Instruction says: pool=Crypto.1, market=SOL, side=long,
   collateral=100 USDC, leverage=5x
4. Transaction is signed with your wallet key
5. Sent to Solana validators
6. Flash Trade program executes:
   a. Checks: is leverage within limits? ✓
   b. Checks: does pool have capacity? ✓
   c. Gets oracle price from Pyth (on-chain feed)
   d. Calculates position size, entry price, liquidation price
   e. Deducts collateral from your token account
   f. Opens position record on-chain
   g. Charges open fee (taken from collateral)
7. Transaction confirmed in a Solana block (~400ms)
8. Your terminal detects confirmation and shows result
```

### Fees

| Fee | When | Typical Rate |
|:----|:-----|:-------------|
| **Open fee** | When you open a position | ~0.08% of position size |
| **Close fee** | When you close a position | ~0.08% of position size |
| **Borrow fee** | While position is open (per hour) | Variable, based on utilization |

Example: $500 position size → ~$0.40 open fee + ~$0.40 close fee = $0.80 total

### Liquidation

```
When does liquidation happen?
  → When your losses eat through most of your collateral
  → Specifically: when remaining collateral < maintenance margin

Maintenance margin = position size / max leverage
  → $500 size, 100x max leverage → $5 maintenance margin
  → You get liquidated when your collateral drops to ~$5

What happens at liquidation?
  → Protocol closes your position automatically
  → Your remaining collateral goes to the pool
  → You lose everything you put in
  → This protects the pool from going into debt
```

### Oracle (Pyth)

Both Flash Trade and Flash Terminal use **Pyth Network** for prices:
- **On-chain:** Flash Trade reads Pyth price accounts directly on Solana
- **Off-chain:** Flash Terminal calls Pyth Hermes API (HTTP) for display prices
- **Same source, same prices** — what you see in terminal matches what the protocol uses

### Markets Available

| Pool | Markets |
|:-----|:--------|
| Crypto.1 | SOL, BTC, ETH, ZEC, BNB |
| Virtual.1 | Gold, Silver, Crude Oil, EUR, GBP, JPY, CNH |
| Governance.1 | JTO, JUP, PYTH, RAY, HYPE, MET, KMNO |
| Community.1 | PUMP, BONK, PENGU |
| Community.2 | FARTCOIN, WIF |
| Equities | SPY, NVDA, TSLA, AAPL, AMD, AMZN, PLTR |

---

<div style="page-break-before: always;"></div>

# 18. Cheat Sheet — Memorize This

```
┌────────────────────────────────────────────────────┐
│              FLASH TERMINAL IN 30 SECONDS           │
├────────────────────────────────────────────────────┤
│                                                     │
│  WHAT: CLI for trading perps on Solana via Flash    │
│  HOW:  Command → Parse → Safety → Build → Sign →   │
│        Broadcast → Confirm → Done                   │
│  WHY:  Deterministic (no AI in trade path)          │
│        Safe (6 safety gates before every trade)     │
│        Reliable (11-stage pipeline, 3 retries)      │
│                                                     │
├────────────────────────────────────────────────────┤
│  PARSING: regex first, AI only for read-only        │
│  SAFETY:  kill switch → circuit breaker →           │
│           signing guard → rate limit → mutex →      │
│           program whitelist → instruction freeze    │
│  PRICES:  Pyth Hermes (same oracle as on-chain)     │
│  FAILOVER: 3 RPC endpoints, auto-switch on failure  │
│  SYNC:    blockchain is truth, reconcile every 60s  │
│  RISK:    monitor every 5s, TP/SL with spike guard  │
│                                                     │
├────────────────────────────────────────────────────┤
│  PERPS IN 10 SECONDS:                               │
│  → Bet on price up (long) or down (short)           │
│  → Leverage multiplies gains AND losses             │
│  → Collateral = your risk, lose it all at liq       │
│  → Trade against the pool, not other traders        │
│  → Fees: ~0.08% open + 0.08% close                 │
│                                                     │
├────────────────────────────────────────────────────┤
│  NUMBERS TO REMEMBER:                               │
│  28K lines │ 462 tests │ 40+ markets │ 11 stages   │
│  6 safety gates │ 3 RPC endpoints │ 5s risk check   │
│  3 retry attempts │ 45s confirm timeout │ 96/100    │
└────────────────────────────────────────────────────┘
```
