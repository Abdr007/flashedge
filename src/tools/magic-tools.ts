/**
 * Magic-mode CLI tools — bound to the new SDK-backed MagicTradeClient.
 *
 * Network-aware: defaults follow `config.magicNetwork` (mainnet-beta or devnet).
 * Mainnet uses Pool.0 on Flash's L1 program (FTv2…hrzV) delegated to the ER;
 * devnet uses Pool.1 on FMT (FMTgs…txvj).
 *
 * Categories:
 *   - inspection: `magic inspect`, `magic markets`, `magic portfolio`, `magic delegation`
 *   - lifecycle:  `magic status`, `magic setup`, `magic deposit`, `magic faucet`
 *   - trading:    `magic open`, `magic close`, `magic add-collateral`, `magic remove-collateral`
 *   - sessions:   `magic session start|stop|status` (P3 — wired in next pass)
 */

import { z } from 'zod';
import chalk from 'chalk';
import { Connection, PublicKey } from '@solana/web3.js';
import { ToolDefinition, ToolContext, ToolResult, TradeSide } from '../types/index.js';
import { MagicTradeClient } from '../client/magic-client.js';
import { formatPrice, formatUsd } from '../utils/format.js';

/** Truncate a long base58 string for display: "5oZL8a…m9KJ". */
function shortSig(s: string): string {
  return s.length > 16 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

/** USDC mints — mainnet vs devnet test stable. */
const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_MINT_DEVNET = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';

/** Build a Solscan tx URL with cluster query for devnet. */
function solscanTx(sig: string, network: 'mainnet-beta' | 'devnet'): string {
  return network === 'devnet'
    ? `https://solscan.io/tx/${sig}?cluster=devnet`
    : `https://solscan.io/tx/${sig}`;
}

/** Build a Solscan account URL. */
function solscanAcct(addr: string, network: 'mainnet-beta' | 'devnet'): string {
  return network === 'devnet'
    ? `https://solscan.io/account/${addr}?cluster=devnet`
    : `https://solscan.io/account/${addr}`;
}

/** Flash UI URL — opens in the user's connected-wallet view. */
function flashUiUrl(): string {
  return 'https://app.flash.trade/';
}

/** Resolve the stable mint for the active network. */
function stableMintFor(network: 'mainnet-beta' | 'devnet'): string {
  return network === 'mainnet-beta' ? USDC_MINT_MAINNET : USDC_MINT_DEVNET;
}

/** Surface program logs from anchor errors — they carry the real reason. */
function formatAnchorError(err: unknown): string {
  const e = err as { message?: string; logs?: string[]; transactionLogs?: string[] };
  const base = e.message ?? String(err);
  const logs = e.logs ?? e.transactionLogs;
  if (logs && logs.length > 0) {
    const trimmed = logs.slice(0, 8).join(' | ');
    return `${base} [logs: ${trimmed}${logs.length > 8 ? '...' : ''}]`;
  }
  return base;
}

/** Lazy client builder — defers ER connection until first magic command. */
function buildMagicClient(context: ToolContext): MagicTradeClient {
  const kp = context.walletManager.getKeypair();
  if (!kp) {
    throw new Error(
      'magic mode requires a loaded wallet — run `wallet load <path>` first. ' +
        'The wallet is used to derive per-user PDAs (basket, user_deposit_ledger).',
    );
  }
  const network = context.config?.magicNetwork ?? 'mainnet-beta';
  const poolName = context.config?.magicPoolName ?? (network === 'mainnet-beta' ? 'Pool.0' : 'Pool.1');
  const erEndpoint = context.config?.magicRpcUrl ?? 'https://flashtrade.magicblock.app/';
  const l1Url =
    context.config?.magicL1RpcUrl ??
    (network === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
  const l1Connection = new Connection(l1Url, 'confirmed');
  return new MagicTradeClient({
    wallet: kp,
    l1Connection,
    network,
    poolName,
    erEndpoint,
    programIdOverride: context.config?.magicProgramId,
    prioritizationFee: context.config?.computeUnitPrice,
    fastConfirm: context.config?.magicFastConfirm ?? true,
  });
}

export const magicInspect: ToolDefinition = {
  name: 'magicInspect',
  description: 'Show the active Magic Trade pool — markets, custodies, delegation, network.',
  parameters: z.object({}),
  async execute(_params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);

    const [platform, delegation, basket, udl] = await Promise.all([
      client.fetchPlatform(),
      client.getDelegationStatus(),
      client.fetchBasket(),
      client.fetchUserDepositLedger(),
    ]);
    const pools = client.listPools();
    const markets = client.listMarkets();
    const custodies = client.listCustodies();
    const allConfigs = client.listPoolConfigsAvailable();

    const lines: string[] = [];
    lines.push(`Network:  ${client.network}`);
    lines.push(`Pool:     ${client.poolConfig.poolName} @ ${client.poolConfig.poolAddress.toBase58()}`);
    lines.push(`Program:  ${client.programId.toBase58()}`);
    lines.push(`Wallet:   ${client.walletAddress}`);
    lines.push('');
    lines.push(`Platform: ${platform ? 'initialised' : 'NOT INITIALISED — pool may not be live on this RPC'}`);
    lines.push(`Basket:   ${client.basketPda.toBase58()} (delegated=${delegation.basketDelegated})`);
    lines.push(`UDL:      ${udl ? 'initialised' : 'NOT initialised — run `magic setup`'}`);
    lines.push('');
    lines.push(`Pools enumerated:    ${pools.length} (active pool only — full list via SDK PoolConfig)`);
    lines.push(`Markets:    ${markets.length}`);
    markets.slice(0, 12).forEach((m) =>
      lines.push(`  ${m.symbol.padEnd(10)} ${m.side.padEnd(5)}  maxLev=${m.maxLev}  ${m.pubkey.slice(0, 8)}…`),
    );
    if (markets.length > 12) lines.push(`  ... +${markets.length - 12} more`);
    lines.push('');
    lines.push(`Custodies:  ${custodies.length}`);
    custodies.slice(0, 12).forEach((c) =>
      lines.push(`  ${c.symbol.padEnd(10)} stable=${c.isStable} decimals=${c.decimals} ${c.pubkey.slice(0, 8)}…`),
    );
    if (custodies.length > 12) lines.push(`  ... +${custodies.length - 12} more`);
    lines.push('');
    lines.push('Other Magic-Block pools (SDK PoolConfig):');
    allConfigs.forEach((p) => lines.push(`  ${p.cluster.padEnd(14)} ${p.poolName}${p.isActive ? ' ← active' : ''}`));

    return {
      success: true,
      message: lines.join('\n'),
      data: {
        network: client.network,
        poolName: client.poolConfig.poolName,
        platformInitialised: platform !== null,
        basketInitialised: basket !== null,
        basketDelegated: delegation.basketDelegated,
        marketCount: markets.length,
        custodyCount: custodies.length,
      },
    };
  },
};

export const magicDelegation: ToolDefinition = {
  name: 'magicDelegation',
  description: 'Show basket delegation status (whether trades route to ER or L1).',
  async execute(_params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const status = await client.getDelegationStatus();
    return {
      success: true,
      message: `basket=${client.basketPda.toBase58()} delegated=${status.basketDelegated}`,
      data: { basketDelegated: status.basketDelegated },
    };
  },
};

export const magicPortfolio: ToolDefinition = {
  name: 'magicPortfolio',
  description: 'Fetch user portfolio from the ER (real on-chain basket + user_deposit_ledger).',
  async execute(_params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const portfolio = await client.getPortfolio();
    const lines = [
      `wallet:        ${portfolio.walletAddress}`,
      `basket:        ${client.basketPda.toBase58()}`,
      `  → solscan:   ${solscanAcct(client.basketPda.toBase58(), client.network)}`,
      `balance:       ${portfolio.balance.toFixed(2)} ${portfolio.balanceLabel}`,
      `collateral:    $${portfolio.totalCollateralUsd.toFixed(2)}`,
      `unrealized:    $${portfolio.totalUnrealizedPnl.toFixed(2)}`,
      `positions:     ${portfolio.positions.length}`,
    ];
    if (portfolio.positions.length > 0) {
      lines.push('');
      portfolio.positions.forEach((p) => {
        lines.push(
          `  ${p.market.padEnd(8)} ${p.side.padEnd(5)} ${p.leverage.toFixed(1)}x ` +
            `size=$${p.sizeUsd.toFixed(2)} entry=$${p.entryPrice.toFixed(4)} mark=$${p.markPrice.toFixed(4)} ` +
            `pnl=$${p.unrealizedPnl.toFixed(2)} liq=$${p.liquidationPrice.toFixed(4)}`,
        );
        lines.push(`    market: ${p.pubkey}  → ${solscanAcct(p.pubkey, client.network)}`);
      });
      lines.push('');
      lines.push(`UI: ${flashUiUrl()}  (connect ${portfolio.walletAddress.slice(0, 8)}… to see same positions)`);
    }
    return {
      success: true,
      message: lines.join('\n'),
      data: { portfolio, basketPda: client.basketPda.toBase58() },
    };
  },
};

/**
 * Read the on-chain basket directly and verify it matches what the UI sees.
 * Useful when the user wants to confirm CLI/UI parity.
 */
export const magicVerify: ToolDefinition = {
  name: 'magicVerify',
  description: 'Verify on-chain state matches what the Flash UI sees (basket, positions, deposits).',
  async execute(_params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const [basket, udl, delegation] = await Promise.all([
      client.fetchBasket(),
      client.fetchUserDepositLedger(),
      client.getDelegationStatus(),
    ]);
    const positionCount = (basket as { positions?: unknown[] } | null)?.positions?.length ?? 0;
    const orderCount = (basket as { orders?: unknown[] } | null)?.orders?.length ?? 0;
    const depositEntries = ((udl as { deposits?: Array<{ mint: PublicKey; amount: { toString(): string } }> } | null)
      ?.deposits ?? []) as Array<{ mint: PublicKey; amount: { toString(): string } }>;
    const depositCount = depositEntries.length;
    // Resolve each entry's mint → token symbol/decimals from PoolConfig and
    // sum into a USD-equivalent (stables only — non-stable balances reported raw).
    const depositLines: string[] = [];
    let totalDepositUsd = 0;
    for (const e of depositEntries) {
      const tok = client.poolConfig.custodies.find((c) => c.mintKey.equals(e.mint));
      const sym = tok?.symbol ?? '?';
      const decimals = tok?.decimals ?? 0;
      const amt = Number(e.amount.toString()) / 10 ** decimals;
      depositLines.push(`    ${sym.padEnd(10)} ${amt.toFixed(decimals === 6 ? 2 : 6)} ${sym}  (mint ${e.mint.toBase58().slice(0, 8)}…)`);
      if (tok?.isStable) totalDepositUsd += amt;
    }

    const lines = [
      `Verification — same accounts the Flash UI reads:`,
      ``,
      `  Network:        ${client.network}`,
      `  Pool:           ${client.poolConfig.poolName} (${client.poolConfig.poolAddress.toBase58()})`,
      `  Program:        ${client.programId.toBase58()}`,
      `  Wallet:         ${client.walletAddress}`,
      ``,
      `  Basket PDA:     ${client.basketPda.toBase58()}`,
      `    on-chain:     ${basket ? '✓ exists' : '✗ NOT FOUND — UI will show no positions'}`,
      `    delegated:    ${delegation.basketDelegated ? '✓ to ER (UI must read flashtrade.magicblock.app)' : '✗ on L1'}`,
      `    positions:    ${positionCount}`,
      `    orders:       ${orderCount}`,
      `    solscan:      ${solscanAcct(client.basketPda.toBase58(), client.network)}`,
      ``,
      `  UDL PDA:        ${client.userDepositLedgerPda.toBase58()}`,
      `    on-chain:     ${udl ? '✓ exists' : '✗ NOT FOUND'}`,
      `    deposits:     ${depositCount} ${depositCount === 0 ? chalk.yellow('(VAULT EMPTY — run `magic deposit USDC <amount>` before trading)') : ''}`,
      ...(depositLines.length > 0 ? depositLines : []),
      ...(depositCount > 0 ? [`    total stable: ${formatUsd(totalDepositUsd)}`] : []),
      `    solscan:      ${solscanAcct(client.userDepositLedgerPda.toBase58(), client.network)}`,
      ``,
      `  Open in UI:     ${flashUiUrl()}    (connect wallet ${client.walletAddress.slice(0, 8)}…)`,
      ``,
      `Every CLI trade writes to these accounts. Anything you see here is what the UI sees.`,
    ];
    return {
      success: true,
      message: lines.join('\n'),
      data: {
        basketPda: client.basketPda.toBase58(),
        udlPda: client.userDepositLedgerPda.toBase58(),
        positionCount,
        orderCount,
        depositCount,
        delegated: delegation.basketDelegated,
      },
    };
  },
};

export const magicMarkets: ToolDefinition = {
  name: 'magicMarkets',
  description: 'List all markets in the active Magic Trade pool with leverage caps.',
  async execute(_params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const markets = client.listMarkets();
    const lines = markets.length
      ? markets.map((m) => `  ${m.symbol.padEnd(10)} ${m.side.padEnd(5)}  maxLev=${m.maxLev.toString().padStart(4)}x  ${m.pubkey.slice(0, 8)}…`)
      : ['(no markets in active pool)'];
    return {
      success: true,
      message: lines.join('\n'),
      data: { marketCount: markets.length, rawMarkets: markets },
    };
  },
};

/** Preflight — show everything needed to decide "can I trade right now?" */
export const magicStatus: ToolDefinition = {
  name: 'magicStatus',
  description: 'Show wallet + basket + deposit state. Preflight before trading.',
  async execute(_params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const stable = stableMintFor(client.network);
    const p = await client.preflight(new PublicKey(stable));
    const minSol = client.network === 'mainnet-beta' ? 0.005 : 0.01;
    const faucetHint = client.network === 'mainnet-beta'
      ? '← top up SOL on mainnet'
      : '← run `magic faucet` for devnet SOL';
    const lines = [
      `network:           ${p.network}`,
      `pool:              ${p.poolName}`,
      `wallet:            ${p.walletAddress}`,
      `L1 SOL balance:    ${p.l1SolBalance.toFixed(4)} SOL  ${p.l1SolBalance < minSol ? faucetHint : ''}`,
      `UDL initialised:   ${p.udlInitialised}  ${!p.udlInitialised ? '← run `magic setup`' : ''}`,
      `basket init:       ${p.basketInitialised}  ${!p.basketInitialised ? '← run `magic setup`' : ''}`,
      `basket delegated:  ${p.basketDelegated}  ${p.basketInitialised && !p.basketDelegated ? '← run `magic setup` or `magic delegate`' : ''}`,
      `stable ATA:        ${p.stableAtaExists ? `exists (raw balance=${p.stableAtaBalance ?? '?'})` : 'does not exist — auto-created on deposit'}`,
      `deposits in UDL:   ${p.depositCount}  ${p.depositCount === 0 ? '← run `magic deposit ' + stable + ' <amount>`' : ''}`,
    ];
    return { success: true, message: lines.join('\n'), data: { preflight: p } };
  },
};

export const magicFaucet: ToolDefinition = {
  name: 'magicFaucet',
  description: 'Show faucet URLs for devnet SOL and Flash Magic Trade test tokens (devnet only).',
  async execute(_params, context): Promise<ToolResult> {
    const network = context.config?.magicNetwork ?? 'mainnet-beta';
    if (network === 'mainnet-beta') {
      return {
        success: true,
        message:
          'Mainnet has no faucet — fund your wallet with real SOL + USDC.\n' +
          'For testing, switch to devnet by setting `MAGIC_NETWORK=devnet` in your .env.',
      };
    }
    const msg = [
      'Devnet SOL:',
      '  https://faucet.solana.com/     (captcha-gated, 1 SOL per request)',
      '  https://faucet.triangleplatform.com/solana/devnet',
      '  solana airdrop 2 --url devnet   (CLI; often rate-limited)',
      '',
      `Devnet stable mint (Magic Trade collateral): ${USDC_MINT_DEVNET}`,
      '  No public faucet — coordinate via Flash team.',
    ].join('\n');
    return { success: true, message: msg };
  },
};

/** One-time per-wallet setup: init UDL, init basket, delegate basket. Idempotent. */
export const magicSetup: ToolDefinition = {
  name: 'magicSetup',
  description: 'One-time setup: initialize user deposit ledger, basket, and delegate basket to the ER.',
  async execute(_params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const steps: string[] = [];

    const pre = await client.preflight();
    const minSol = client.network === 'mainnet-beta' ? 0.005 : 0.01;
    if (pre.l1SolBalance < minSol) {
      return {
        success: false,
        message:
          `✗ wallet L1 SOL balance is ${pre.l1SolBalance.toFixed(6)} — need at least ${minSol} to pay for init+delegate.\n` +
          (client.network === 'mainnet-beta'
            ? '  Top up SOL on mainnet from any exchange/wallet.'
            : '  Get devnet SOL: https://faucet.solana.com/  (or run `magic faucet` for more options)'),
      };
    }
    steps.push(`preflight ok (L1 SOL: ${pre.l1SolBalance.toFixed(4)})`);

    try {
      const udlSig = await client.initializeUserDepositLedger();
      steps.push(udlSig === 'already_initialised' ? '✓ UserDepositLedger: already initialised' : `✓ UserDepositLedger initialised: ${udlSig}`);
    } catch (err) {
      steps.push(`✗ initializeUserDepositLedger: ${formatAnchorError(err)}`);
    }

    try {
      const basketSig = await client.initializeBasket();
      steps.push(basketSig === 'already_initialised' ? '✓ Basket: already initialised' : `✓ Basket initialised: ${basketSig}`);
    } catch (err) {
      steps.push(`✗ initializeBasket: ${formatAnchorError(err)}`);
    }

    try {
      const del = await client.getDelegationStatus();
      if (del.basketDelegated) {
        steps.push('✓ Basket: already delegated to ER');
      } else {
        const sig = await client.delegateBasket();
        steps.push(`✓ Basket delegated to ER: ${sig}`);
      }
    } catch (err) {
      steps.push(`✗ delegateBasket: ${formatAnchorError(err)}`);
    }

    return {
      success: true,
      message: steps.join('\n'),
      data: { steps },
    };
  },
};

/**
 * Deposit tokens into the UserDepositLedger (vault) on L1.
 * Accepts a symbol (USDC, SOL, etc.) OR a raw mint pubkey, and a human amount.
 * Examples:
 *   magic deposit USDC 50          → $50 USDC into vault
 *   magic deposit SOL 0.1          → 0.1 SOL into vault
 */
export const magicDeposit: ToolDefinition = {
  name: 'magicDeposit',
  description: 'Deposit collateral to the vault (UDL on L1). args: symbol-or-mint, amount (human units).',
  parameters: z.object({ token: z.string(), amount: z.number().positive() }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const tokenArg = String(params.token);
    const amountHuman = params.amount as number;

    // Resolve symbol → mint via PoolConfig; fall back to treating tokenArg as a raw mint.
    let mintPk: PublicKey;
    let decimals: number;
    let symbol: string;
    const cust = client.poolConfig.custodies.find((c) => c.symbol === tokenArg.toUpperCase());
    if (cust) {
      mintPk = cust.mintKey;
      decimals = cust.decimals;
      symbol = cust.symbol;
    } else {
      try {
        mintPk = new PublicKey(tokenArg);
      } catch {
        return { success: false, message: `Unknown token '${tokenArg}'. Use a symbol (USDC, SOL, BTC…) or a valid mint pubkey.` };
      }
      const resolved = client.poolConfig.custodies.find((c) => c.mintKey.equals(mintPk));
      if (!resolved) {
        return { success: false, message: `Mint ${mintPk.toBase58()} is not a custody in Pool.0. Run \`magic inspect\` to see supported tokens.` };
      }
      decimals = resolved.decimals;
      symbol = resolved.symbol;
    }

    const amountRaw = BigInt(Math.floor(amountHuman * 10 ** decimals));
    const sig = await client.depositDirect(mintPk, amountRaw);
    return {
      success: true,
      message: [
        '',
        chalk.green('  Deposit Complete'),
        chalk.dim('  ─────────────────'),
        `  Token:             ${chalk.cyan(symbol)}`,
        `  Amount:            ${amountHuman} ${symbol}`,
        `  Mint:              ${mintPk.toBase58()}`,
        `  TX: ${chalk.dim(shortSig(sig))}  ${chalk.dim(solscanTx(sig, client.network))}`,
        '',
      ].join('\n'),
      txSignature: sig,
    };
  },
};

/**
 * Withdraw tokens from the vault — 2-step process: queue request via the ER,
 * then settle on L1. Bundled into one CLI command.
 */
export const magicWithdraw: ToolDefinition = {
  name: 'magicWithdraw',
  description: 'Withdraw from the vault. args: symbol-or-mint, amount (human units).',
  parameters: z.object({ token: z.string(), amount: z.number().positive() }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const tokenArg = String(params.token);
    const amountHuman = params.amount as number;

    let mintPk: PublicKey;
    let decimals: number;
    let symbol: string;
    const cust = client.poolConfig.custodies.find((c) => c.symbol === tokenArg.toUpperCase());
    if (cust) {
      mintPk = cust.mintKey;
      decimals = cust.decimals;
      symbol = cust.symbol;
    } else {
      try {
        mintPk = new PublicKey(tokenArg);
      } catch {
        return { success: false, message: `Unknown token '${tokenArg}'.` };
      }
      const resolved = client.poolConfig.custodies.find((c) => c.mintKey.equals(mintPk));
      if (!resolved) {
        return { success: false, message: `Mint ${mintPk.toBase58()} is not a custody in Pool.0.` };
      }
      decimals = resolved.decimals;
      symbol = resolved.symbol;
    }

    const amountRaw = BigInt(Math.floor(amountHuman * 10 ** decimals));
    const result = await client.withdraw(mintPk, amountRaw);
    return {
      success: true,
      message: [
        '',
        chalk.green('  Withdrawal Complete'),
        chalk.dim('  ─────────────────'),
        `  Token:             ${chalk.cyan(symbol)}`,
        `  Amount:            ${amountHuman} ${symbol}`,
        `  Mint:              ${mintPk.toBase58()}`,
        `  Request TX: ${chalk.dim(shortSig(result.requestSig))}  ${chalk.dim(solscanTx(result.requestSig, client.network))}`,
        `  Settle  TX: ${chalk.dim(shortSig(result.settleSig))}  ${chalk.dim(solscanTx(result.settleSig, client.network))}`,
        '',
      ].join('\n'),
      txSignature: result.settleSig,
    };
  },
};

/**
 * Open a position — symbol-driven via the SDK.
 * Args:
 *   - market: target asset symbol (e.g. "SOL")
 *   - side: "long" or "short"
 *   - collateral: USDC amount in human units (e.g. 100 = $100 USDC)
 *   - leverage: integer multiplier (e.g. 5 = 5x)
 *   - collateralToken (optional): default "USDC"
 */
export const magicOpen: ToolDefinition = {
  name: 'magicOpen',
  description: 'Open a position by symbol. args: market, side, collateral (USDC), leverage, collateralToken?.',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    collateral: z.number().positive(),
    leverage: z.number().positive(),
    collateralToken: z.string().optional(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const result = await client.openPosition(
      params.market as string,
      params.side as TradeSide,
      params.collateral as number,
      params.leverage as number,
      params.collateralToken as string | undefined,
    );
    const liqStr = result.liquidationPrice && result.liquidationPrice > 0 ? chalk.yellow(formatPrice(result.liquidationPrice)) : chalk.dim('N/A');
    return {
      success: true,
      message: [
        '',
        chalk.green('  Position Opened'),
        chalk.dim('  ─────────────────'),
        `  Market:            ${chalk.cyan(String(params.market).toUpperCase())} ${chalk.bold(String(params.side))} ${chalk.dim(`${params.leverage}x`)}`,
        `  Entry Price:       ${formatPrice(result.entryPrice)}`,
        `  Size:              ${formatUsd(result.sizeUsd)}`,
        `  Collateral:        ${formatUsd(params.collateral as number)}`,
        `  Liquidation Price: ${liqStr}`,
        `  TX: ${chalk.dim(shortSig(result.txSignature))}  ${chalk.dim(solscanTx(result.txSignature, client.network))}`,
        '',
      ].join('\n'),
      txSignature: result.txSignature,
      data: { result },
    };
  },
};

export const magicClose: ToolDefinition = {
  name: 'magicClose',
  description: 'Close a position by symbol. args: market, side, receiveToken?.',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    receiveToken: z.string().optional(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const result = await client.closePosition(
      params.market as string,
      params.side as TradeSide,
      params.receiveToken as string | undefined,
    );
    const pnlColor = result.pnl >= 0 ? chalk.green : chalk.red;
    return {
      success: true,
      message: [
        '',
        chalk.green('  Position Closed'),
        chalk.dim('  ─────────────────'),
        `  Market:            ${chalk.cyan(String(params.market).toUpperCase())} ${chalk.bold(String(params.side))}`,
        `  PnL:               ${pnlColor(formatUsd(result.pnl))}`,
        `  TX: ${chalk.dim(shortSig(result.txSignature))}  ${chalk.dim(solscanTx(result.txSignature, client.network))}`,
        '',
      ].join('\n'),
      txSignature: result.txSignature,
      data: { result },
    };
  },
};

export const magicAddCollateral: ToolDefinition = {
  name: 'magicAddCollateral',
  description: 'Add USDC collateral to an open position. args: market, side, amount (USDC).',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    amount: z.number().positive(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const result = await client.addCollateral(params.market as string, params.side as TradeSide, params.amount as number);
    return {
      success: true,
      message: [
        '',
        chalk.green('  Collateral Added'),
        chalk.dim('  ─────────────────'),
        `  Market:            ${chalk.cyan(String(params.market).toUpperCase())} ${chalk.bold(String(params.side))}`,
        `  Amount:            ${formatUsd(params.amount as number)}`,
        `  TX: ${chalk.dim(shortSig(result.txSignature))}  ${chalk.dim(solscanTx(result.txSignature, client.network))}`,
        '',
      ].join('\n'),
      txSignature: result.txSignature,
    };
  },
};

export const magicRemoveCollateral: ToolDefinition = {
  name: 'magicRemoveCollateral',
  description: 'Remove USD collateral from an open position. args: market, side, amount (USD).',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    amount: z.number().positive(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const result = await client.removeCollateral(
      params.market as string,
      params.side as TradeSide,
      params.amount as number,
    );
    return {
      success: true,
      message: [
        '',
        chalk.green('  Collateral Removed'),
        chalk.dim('  ─────────────────'),
        `  Market:            ${chalk.cyan(String(params.market).toUpperCase())} ${chalk.bold(String(params.side))}`,
        `  Amount:            ${formatUsd(params.amount as number)}`,
        `  TX: ${chalk.dim(shortSig(result.txSignature))}  ${chalk.dim(solscanTx(result.txSignature, client.network))}`,
        '',
      ].join('\n'),
      txSignature: result.txSignature,
    };
  },
};

/**
 * Report the spot price for a market via the on-chain oracle, plus the oracle
 * account pubkey so the user can cross-check on Solscan/Pyth/etc.
 */
export const magicPrice: ToolDefinition = {
  name: 'magicPrice',
  description: 'Query on-chain oracle price for a market and show the oracle account so it can be verified externally.',
  parameters: z.object({ market: z.string() }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const sym = String(params.market).toUpperCase();
    const cust = client.poolConfig.custodies.find((c) => c.symbol === sym);
    if (!cust) {
      return { success: false, message: `Unknown market '${sym}'. Run \`magic markets\` to see available symbols.` };
    }
    const price = await client.fetchOraclePrice(sym).catch((err) => {
      throw new Error(`oracle read failed: ${(err as Error).message}`);
    });
    const lines = [
      '',
      chalk.cyan(`  ${sym} on Pool.0`),
      chalk.dim('  ─────────────────'),
      `  Spot Price:        ${formatPrice(price)}`,
      `  Custody:           ${cust.custodyAccount.toBase58()}`,
      `    → solscan:       ${solscanAcct(cust.custodyAccount.toBase58(), client.network)}`,
      `  Internal Oracle:   ${cust.intOracleAccount.toBase58()}`,
      `    → solscan:       ${solscanAcct(cust.intOracleAccount.toBase58(), client.network)}`,
      `  External Oracle:   ${cust.extOracleAccount.toBase58()}  ${chalk.dim(`(${cust.pythTicker})`)}`,
      `    → solscan:       ${solscanAcct(cust.extOracleAccount.toBase58(), client.network)}`,
      '',
      chalk.dim('  Cross-check: paste the oracle account into pyth.network or solscan to see the same price.'),
      '',
    ];
    return { success: true, message: lines.join('\n'), data: { symbol: sym, price, custody: cust.custodyAccount.toBase58() } };
  },
};

/**
 * Show the user's vault state per token: gross deposit, locked in positions,
 * and what's actually available for new trades. Faster + more focused than
 * `magic verify` which is the full audit view.
 */
export const magicVault: ToolDefinition = {
  name: 'magicVault',
  description: 'Show vault balance per token (deposits, locked, available).',
  async execute(_params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const balances = await client.getAvailableBalances();
    const sep = chalk.dim('  ─────────────────────────────────────');

    if (balances.size === 0) {
      return {
        success: true,
        message: [
          '',
          chalk.cyan('  💰 Vault'),
          sep,
          chalk.dim('  empty — run `magic deposit USDC <amount>` to fund'),
          '',
        ].join('\n'),
      };
    }

    const lines: string[] = ['', chalk.cyan('  💰 Vault'), sep];
    lines.push(
      `  ${chalk.dim('Token').padEnd(8)}${chalk.dim('Deposits').padEnd(20)}${chalk.dim('Locked').padEnd(20)}${chalk.dim('Available')}`,
    );
    let totalAvailUsd = 0;
    for (const [sym, bal] of balances) {
      const dec = bal.decimals;
      const fmt = (n: number) => (dec === 6 ? n.toFixed(2) : n.toFixed(6));
      const locked = bal.debits - bal.pendingCredits;
      const availColor = bal.available > 0.01 ? chalk.green : chalk.red;
      lines.push(
        `  ${chalk.bold(sym.padEnd(6))}  ${fmt(bal.deposits).padEnd(18)}${fmt(Math.max(locked, 0)).padEnd(18)}${availColor(fmt(bal.available))}`,
      );
      // Tally USD-equivalent for stables only.
      const isStable = client.poolConfig.tokens.find((t) => t.symbol === sym)?.isStable;
      if (isStable) totalAvailUsd += bal.available;
    }
    lines.push(sep);
    lines.push(`  ${chalk.dim('Available stable')} ${chalk.bold(formatUsd(totalAvailUsd))}`);
    lines.push('');
    return { success: true, message: lines.join('\n'), data: { balances: Object.fromEntries(balances) } };
  },
};

/**
 * Drain pendingCredits → deposits on the basket. Run this if `magic verify`
 * shows pendingCredits > 0 — those credits don't count as fully usable until
 * they're settled into the deposit pool.
 */
export const magicSettle: ToolDefinition = {
  name: 'magicSettle',
  description: 'Settle pending credits/debits in the basket. args: symbol? (default: settle every custody with pending state).',
  parameters: z.object({ symbol: z.string().optional() }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const symbol = (params.symbol as string | undefined)?.toUpperCase();
    if (symbol) {
      const sig = await client.settleCustody(symbol);
      return {
        success: true,
        message: [
          '',
          chalk.green(`  Settled ${symbol}`),
          chalk.dim('  ─────────────────'),
          `  TX: ${chalk.dim(shortSig(sig))}  ${chalk.dim(solscanTx(sig, client.network))}`,
          '',
        ].join('\n'),
        txSignature: sig,
      };
    }
    const results = await client.settleAll();
    if (results.length === 0) {
      return { success: true, message: 'no pending credits/debits — nothing to settle' };
    }
    const lines = ['', chalk.green('  Settle Complete'), chalk.dim('  ─────────────────')];
    for (const r of results) {
      if (r.sig) lines.push(`  ${chalk.cyan(r.symbol.padEnd(6))} ${chalk.dim(shortSig(r.sig))}  ${chalk.dim(solscanTx(r.sig, client.network))}`);
      else lines.push(`  ${chalk.red(r.symbol.padEnd(6))} ${chalk.red('failed:')} ${r.err}`);
    }
    lines.push('');
    return { success: true, message: lines.join('\n'), data: { results } };
  },
};

export const magicTools: ToolDefinition[] = [
  magicVault,
  magicSettle,
  magicInspect,
  magicStatus,
  magicDelegation,
  magicPortfolio,
  magicVerify,
  magicPrice,
  magicMarkets,
  magicSetup,
  magicDeposit,
  magicWithdraw,
  magicOpen,
  magicClose,
  magicAddCollateral,
  magicRemoveCollateral,
  magicFaucet,
];
