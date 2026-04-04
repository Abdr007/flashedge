# Quick Start Guide

Get running with Flash Terminal in under 5 minutes.

---

## 1. Install

```bash
git clone https://github.com/Abdr007/bolt-terminal.git
cd bolt-terminal
npm install
npm run build
npm link
```

## 2. Configure

```bash
cp .env.example .env
```

Edit `.env` and set your RPC URL:

```env
RPC_URL=https://api.mainnet-beta.solana.com
```

That's the only required setting. AI API keys are optional.

## 3. Verify

```bash
flash doctor
```

This checks your Node.js version, RPC connection, market data access, and wallet configuration.

## 4. Start the Terminal

```bash
flash
```

You'll see:

```
  Select mode:

  1 → Live Trading
  2 → Simulation
  3 → Exit
```

Choose **2 (Simulation)** to start with a $10,000 paper balance and live market prices.

## 5. Try These Commands

```
scan                        Scan all markets for opportunities
analyze SOL                 Deep analysis on SOL
portfolio                   Your portfolio summary
dashboard                   Full system overview
risk                        Liquidation risk report
markets                     All available trading markets
```

## 6. Make a Paper Trade

```
open 2x long SOL $50
```

This opens a 2x leveraged long position on SOL with $50 collateral in simulation mode.

Check your position:

```
positions
```

Close it:

```
close SOL long
```

## 7. Autopilot (Simulation Only)

Let the system scan and trade automatically:

```
autopilot start
autopilot status
autopilot stop
```

---

## Going Live

When you're ready for real trading:

1. Import your Solana wallet:

```
wallet import main ~/.config/solana/id.json
```

2. Set `SIMULATION_MODE=false` in `.env`

3. Restart the terminal and select **Live Trading**

4. Ensure your wallet has SOL (for transaction fees) and USDC (for collateral)

> Live trading executes real on-chain transactions. Start with small positions.

---

## Getting Help

Inside the terminal:

```
help
```

Check environment:

```bash
flash doctor
```

List available markets:

```bash
flash markets
```
