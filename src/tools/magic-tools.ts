/* eslint-disable max-lines -- magic-mode tool definitions live here as a
   single file for ToolDefinition co-location; splitting per-tool would
   scatter shared helpers (build client, format helpers, journaling). */
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
import { readMagicHistory, recordMagicTrade } from '../security/magic-history.js';
import { startErHealthMonitor, getErHealthMonitor } from '../monitor/magic-er-health.js';
import { startMagicAlerts, stopMagicAlerts, getMagicAlerts } from '../monitor/magic-alerts.js';
import { renderCard, bar, marketHeader } from '../cli/magic-theme.js';

/** Truncate a long base58 string for display: "5oZL8a…m9KJ". */
function shortSig(s: string): string {
  return s.length > 16 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

/** USDC mints — mainnet vs devnet test stable. */
const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_MINT_DEVNET = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';

/**
 * Pick the explorer base host. Default: Solana Explorer.
 * Override via FLASH_EXPLORER=solscan (or =explorer to be explicit).
 *
 * For magic-mode mainnet trades, all writes hit the ER, so the tx is only
 * visible to clients pointed at the ER's RPC. Both Solscan and Solana Explorer
 * accept `?cluster=custom&customUrl=<er>`. URL-encoded so the link copies
 * cleanly into a browser bar without breaking on `://`.
 */
function explorerBase(): { tx: string; acct: string } {
  const which = (process.env.FLASH_EXPLORER ?? 'explorer').toLowerCase();
  if (which === 'solscan') return { tx: 'https://solscan.io/tx', acct: 'https://solscan.io/account' };
  return { tx: 'https://explorer.solana.com/tx', acct: 'https://explorer.solana.com/address' };
}

/** ER router URL — magic-mode trades land here on mainnet. */
const MAGIC_ER_URL = 'https://flashtrade.magicblock.app/';

/** Build a tx explorer URL. For magic mainnet, includes the ER customUrl. */
function solscanTx(sig: string, network: 'mainnet-beta' | 'devnet'): string {
  const { tx } = explorerBase();
  if (network === 'devnet') return `${tx}/${sig}?cluster=devnet`;
  // Magic mainnet — point at the ER router so the tx resolves.
  return `${tx}/${sig}?cluster=custom&customUrl=${encodeURIComponent(MAGIC_ER_URL)}`;
}

/** Build an account explorer URL. */
function solscanAcct(addr: string, network: 'mainnet-beta' | 'devnet'): string {
  const { acct } = explorerBase();
  if (network === 'devnet') return `${acct}/${addr}?cluster=devnet`;
  // For accounts on magic-mode mainnet, the on-chain account is also on L1
  // (UDL is L1-only, basket is delegated). Keep the link to L1 mainnet so
  // the user always sees the canonical state.
  return `${acct}/${addr}`;
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

/** Infer category from a custody's pyth ticker (Crypto.SOL/USD, FX.EUR/USD, etc.). */
function categoryOf(pythTicker?: string): 'Crypto' | 'Equity' | 'FX' | 'Metal' | 'Commodity' | 'Other' {
  if (!pythTicker) return 'Other';
  if (pythTicker.startsWith('Crypto.')) return 'Crypto';
  if (pythTicker.startsWith('Equity.')) return 'Equity';
  if (pythTicker.startsWith('FX.')) return 'FX';
  if (pythTicker.startsWith('Metal.')) return 'Metal';
  if (pythTicker.startsWith('Commodities.')) return 'Commodity';
  return 'Other';
}

export const magicMarkets: ToolDefinition = {
  name: 'magicMarkets',
  description: 'List all markets in the active Magic Trade pool grouped by category, with leverage caps.',
  parameters: z.object({ category: z.string().optional(), filter: z.string().optional() }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const filterCat = (params.category as string | undefined)?.toLowerCase();
    const filterSym = (params.filter as string | undefined)?.toUpperCase();
    const pool = client.poolConfig;

    // Build per-symbol summary: side(s) available, maxLev, degenMaxLev, lock, category.
    type Row = {
      symbol: string;
      pair: string;
      category: ReturnType<typeof categoryOf>;
      sides: { side: 'long' | 'short'; lockSymbol: string; maxLev: number; degenMaxLev: number; pubkey: string }[];
    };
    const bySym = new Map<string, Row>();
    for (const m of pool.markets) {
      const target = pool.custodies.find((c) => c.custodyAccount.equals(m.targetCustody));
      const lock = pool.custodies.find((c) => c.custodyAccount.equals(m.collateralCustody));
      if (!target) continue;
      if (filterSym && target.symbol !== filterSym) continue;
      const tok = pool.tokens.find((t) => t.symbol === target.symbol);
      const cat = categoryOf(tok?.pythTicker);
      if (filterCat && cat.toLowerCase() !== filterCat) continue;
      let row = bySym.get(target.symbol);
      if (!row) {
        const pair = (tok?.pythTicker?.split('.').pop() ?? `${target.symbol}/USD`).replace(/\/USD$/, '/USD');
        row = { symbol: target.symbol, pair, category: cat, sides: [] };
        bySym.set(target.symbol, row);
      }
      const sideStr = (typeof m.side === 'string' ? m.side : Object.keys(m.side as object)[0]) as 'long' | 'short';
      row.sides.push({
        side: sideStr,
        lockSymbol: lock?.symbol ?? '?',
        maxLev: m.maxLev,
        degenMaxLev: m.degenMaxLev,
        pubkey: m.marketAccount.toBase58(),
      });
    }

    // Group by category, render as a single tight table.
    const CATS: ReturnType<typeof categoryOf>[] = ['Crypto', 'Equity', 'FX', 'Metal', 'Commodity', 'Other'];
    const out: string[] = [
      '',
      `  ${chalk.cyan.bold(`MARKETS`)}  ${chalk.dim(`${bySym.size} symbols · ${Array.from(bySym.values()).reduce((n, r) => n + r.sides.length, 0)} markets · pool ${pool.poolName}`)}`,
      `  ${chalk.dim('─'.repeat(74))}`,
    ];
    for (const cat of CATS) {
      const rows = Array.from(bySym.values()).filter((r) => r.category === cat);
      if (rows.length === 0) continue;
      out.push('');
      out.push(`  ${chalk.cyan(cat.toUpperCase())}  ${chalk.dim(`(${rows.length})`)}`);
      out.push(
        '    ' +
          chalk.dim('Symbol'.padEnd(8)) +
          chalk.dim('Pair'.padEnd(14)) +
          chalk.dim('L lock'.padEnd(8)) +
          chalk.dim('S lock'.padEnd(8)) +
          chalk.dim('Max'.padEnd(8)) +
          chalk.dim('Degen'.padEnd(8)),
      );
      for (const r of rows.sort((a, b) => a.symbol.localeCompare(b.symbol))) {
        const longSide = r.sides.find((s) => s.side === 'long');
        const shortSide = r.sides.find((s) => s.side === 'short');
        const maxLev = Math.max(longSide?.maxLev ?? 0, shortSide?.maxLev ?? 0);
        const degenLev = Math.max(longSide?.degenMaxLev ?? 0, shortSide?.degenMaxLev ?? 0);
        out.push(
          '    ' +
            chalk.bold(r.symbol.padEnd(8)) +
            chalk.dim(r.pair.padEnd(14)) +
            (longSide?.lockSymbol ?? '-').padEnd(8) +
            (shortSide?.lockSymbol ?? '-').padEnd(8) +
            chalk.green(`${maxLev}x`.padEnd(8)) +
            chalk.yellow(`${degenLev}x`.padEnd(8)),
        );
      }
    }
    out.push('');
    out.push(chalk.dim('  Filter: `magic markets crypto`, `magic markets fx`, `magic markets sol`'));
    out.push('');
    return {
      success: true,
      message: out.join('\n'),
      data: { count: bySym.size, totalMarkets: Array.from(bySym.values()).reduce((n, r) => n + r.sides.length, 0) },
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
    const card = renderCard({
      status: 'Position Opened',
      tone: 'open',
      subtitle: marketHeader(String(params.market), String(params.side), params.leverage as number),
      rows: [
        { label: 'Entry', value: chalk.bold(formatPrice(result.entryPrice)) },
        { label: 'Liquidation', value: liqStr },
        { label: 'Size', value: chalk.bold(formatUsd(result.sizeUsd)) },
        { label: 'Collateral', value: formatUsd(params.collateral as number) },
      ],
      sig: shortSig(result.txSignature),
      url: solscanTx(result.txSignature, client.network),
    });
    return {
      success: true,
      message: card,
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
    const card = renderCard({
      status: 'Position Closed',
      tone: 'close',
      subtitle: marketHeader(String(params.market), String(params.side)),
      rows: [{ label: 'PnL', value: chalk.bold(pnlColor(formatUsd(result.pnl))) }],
      sig: shortSig(result.txSignature),
      url: solscanTx(result.txSignature, client.network),
    });
    return {
      success: true,
      message: card,
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

    // Magic vault rendered with bar charts inside a bordered card.
    let totalAvailUsd = 0;
    const rows: Array<{ label: string; value: string }> = [];
    for (const [sym, bal] of balances) {
      const dec = bal.decimals;
      const fmt = (n: number) => (dec === 6 ? n.toFixed(2) : n.toFixed(6));
      const locked = Math.max(bal.debits - bal.pendingCredits, 0);
      const availColor = bal.available > 0.01 ? chalk.green : chalk.red;
      const utilization = bar(locked, bal.deposits, 14);
      rows.push({
        label: chalk.bold(sym),
        value: `${utilization}  ${chalk.dim('avail')} ${availColor(fmt(bal.available))} ${chalk.dim('/')} ${chalk.dim('total')} ${fmt(bal.deposits)}`,
      });
      const isStable = client.poolConfig.tokens.find((t) => t.symbol === sym)?.isStable;
      if (isStable) totalAvailUsd += bal.available;
    }
    rows.push({ label: '', value: '' });
    rows.push({
      label: chalk.dim('Stable USD'),
      value: chalk.bold(formatUsd(totalAvailUsd)) + chalk.dim(' available across stables'),
    });
    const lines = [
      renderCard({
        status: 'Vault',
        tone: 'info',
        subtitle: chalk.dim(`${balances.size} tokens · ${client.network}`),
        rows,
      }),
    ];
    lines.push('');
    return { success: true, message: lines.join('\n'), data: { balances: Object.fromEntries(balances) } };
  },
};

export const magicReverse: ToolDefinition = {
  name: 'magicReverse',
  description: 'Close current position and open opposite side with same collateral. args: market, side, collateral, leverage.',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    collateral: z.number().positive(),
    leverage: z.number().positive(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const result = await client.flipPosition(
      params.market as string,
      params.side as TradeSide,
      params.collateral as number,
      params.leverage as number,
    );
    return {
      success: true,
      message: [
        '',
        chalk.green('  Position Reversed'),
        chalk.dim('  ─────────────────'),
        `  Market:           ${chalk.cyan(String(params.market).toUpperCase())} ${chalk.dim('→')} ${chalk.bold(result.newSide)}`,
        `  Close TX:         ${chalk.dim(shortSig(result.closeSig))}  ${chalk.dim(solscanTx(result.closeSig, client.network))}`,
        `  Open  TX:         ${chalk.dim(shortSig(result.openSig))}  ${chalk.dim(solscanTx(result.openSig, client.network))}`,
        '',
      ].join('\n'),
      txSignature: result.openSig,
    };
  },
};

export const magicPartialClose: ToolDefinition = {
  name: 'magicPartialClose',
  description: 'Close part of a position by USD amount. args: market, side, sizeUsd.',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    sizeUsd: z.number().positive(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const r = await client.decreasePosition(params.market as string, params.side as TradeSide, params.sizeUsd as number);
    return {
      success: true,
      message: [
        '',
        chalk.green('  Position Partial Close'),
        chalk.dim('  ─────────────────'),
        `  Market:           ${chalk.cyan(String(params.market).toUpperCase())} ${chalk.bold(String(params.side))}`,
        `  Closed:           ${formatUsd(params.sizeUsd as number)}`,
        `  TX: ${chalk.dim(shortSig(r.txSignature))}  ${chalk.dim(solscanTx(r.txSignature, client.network))}`,
        '',
      ].join('\n'),
      txSignature: r.txSignature,
    };
  },
};

export const magicIncrease: ToolDefinition = {
  name: 'magicIncrease',
  description: 'Add to position size. args: market, side, sizeUsd, addCollateralUsd?.',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    sizeUsd: z.number().positive(),
    addCollateralUsd: z.number().nonnegative().optional(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const r = await client.increasePosition(
      params.market as string,
      params.side as TradeSide,
      params.sizeUsd as number,
      (params.addCollateralUsd as number | undefined) ?? 0,
    );
    return {
      success: true,
      message: [
        '',
        chalk.green('  Position Increased'),
        chalk.dim('  ─────────────────'),
        `  Market:           ${chalk.cyan(String(params.market).toUpperCase())} ${chalk.bold(String(params.side))}`,
        `  Added size:       ${formatUsd(params.sizeUsd as number)}`,
        ...(params.addCollateralUsd ? [`  Added collateral: ${formatUsd(params.addCollateralUsd as number)}`] : []),
        `  TX: ${chalk.dim(shortSig(r.txSignature))}  ${chalk.dim(solscanTx(r.txSignature, client.network))}`,
        '',
      ].join('\n'),
      txSignature: r.txSignature,
    };
  },
};

export const magicPlaceLimit: ToolDefinition = {
  name: 'magicPlaceLimit',
  description: 'Place a limit order. args: market, side, limitPrice, collateral, leverage, tp?, sl?',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    limitPrice: z.number().positive(),
    collateral: z.number().positive(),
    leverage: z.number().positive(),
    tp: z.number().positive().optional(),
    sl: z.number().positive().optional(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const r = await client.placeLimit(
      params.market as string,
      params.side as TradeSide,
      params.limitPrice as number,
      params.collateral as number,
      params.leverage as number,
      params.tp as number | undefined,
      params.sl as number | undefined,
    );
    return {
      success: true,
      message: [
        '',
        chalk.green('  Limit Order Placed'),
        chalk.dim('  ─────────────────'),
        `  Market:        ${chalk.cyan(String(params.market).toUpperCase())} ${chalk.bold(String(params.side))} ${chalk.dim(`${params.leverage}x`)}`,
        `  Limit Price:   ${formatPrice(params.limitPrice as number)}`,
        `  Collateral:    ${formatUsd(params.collateral as number)}`,
        ...(params.tp ? [`  Take Profit:   ${formatPrice(params.tp as number)}`] : []),
        ...(params.sl ? [`  Stop Loss:     ${formatPrice(params.sl as number)}`] : []),
        `  TX: ${chalk.dim(shortSig(r.txSignature))}  ${chalk.dim(solscanTx(r.txSignature, client.network))}`,
        '',
      ].join('\n'),
      txSignature: r.txSignature,
    };
  },
};

export const magicCancelLimit: ToolDefinition = {
  name: 'magicCancelLimit',
  description: 'Cancel a limit order. args: market, side, orderId.',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    orderId: z.number().int().nonnegative(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const r = await client.cancelLimit(params.market as string, params.side as TradeSide, params.orderId as number);
    return {
      success: true,
      message: `✓ Cancelled limit order #${params.orderId}\n  TX: ${chalk.dim(shortSig(r.txSignature))}  ${chalk.dim(solscanTx(r.txSignature, client.network))}`,
      txSignature: r.txSignature,
    };
  },
};

export const magicCancelTrigger: ToolDefinition = {
  name: 'magicCancelTrigger',
  description: 'Cancel a TP or SL trigger order. args: market, orderId, isStopLoss.',
  parameters: z.object({
    market: z.string(),
    orderId: z.number().int().nonnegative(),
    isStopLoss: z.boolean(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const r = await client.cancelTrigger(params.market as string, params.orderId as number, params.isStopLoss as boolean);
    const label = params.isStopLoss ? 'stop-loss' : 'take-profit';
    return {
      success: true,
      message: `✓ Cancelled ${label} #${params.orderId}\n  TX: ${chalk.dim(shortSig(r.txSignature))}  ${chalk.dim(solscanTx(r.txSignature, client.network))}`,
      txSignature: r.txSignature,
    };
  },
};

export const magicLiquidate: ToolDefinition = {
  name: 'magicLiquidate',
  description: 'Liquidate an underwater position. args: positionOwner (pubkey), market, side.',
  parameters: z.object({
    positionOwner: z.string(),
    market: z.string(),
    side: z.enum(['long', 'short']),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const r = await client.liquidatePosition(
      new PublicKey(params.positionOwner as string),
      params.market as string,
      params.side as TradeSide,
    );
    return {
      success: true,
      message: [
        '',
        chalk.green('  Liquidation Sent'),
        chalk.dim('  ─────────────────'),
        `  Owner:    ${chalk.dim(String(params.positionOwner).slice(0, 8) + '…')}`,
        `  Market:   ${chalk.cyan(String(params.market).toUpperCase())} ${chalk.bold(String(params.side))}`,
        `  TX: ${chalk.dim(shortSig(r.txSignature))}  ${chalk.dim(solscanTx(r.txSignature, client.network))}`,
        '',
      ].join('\n'),
      txSignature: r.txSignature,
    };
  },
};

export const magicTriggerOrder: ToolDefinition = {
  name: 'magicTriggerOrder',
  description: 'Place TP or SL on a position. args: market, side, price, isStopLoss, sizeUsd?',
  parameters: z.object({
    market: z.string(),
    side: z.enum(['long', 'short']),
    price: z.number().positive(),
    isStopLoss: z.boolean(),
    sizeUsd: z.number().positive().optional(),
  }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const r = await client.placeTrigger(
      params.market as string,
      params.side as TradeSide,
      params.price as number,
      params.isStopLoss as boolean,
      params.sizeUsd as number | undefined,
    );
    const label = params.isStopLoss ? 'Stop Loss' : 'Take Profit';
    return {
      success: true,
      message: [
        '',
        chalk.green(`  ${label} Set`),
        chalk.dim('  ─────────────────'),
        `  Market:           ${chalk.cyan(String(params.market).toUpperCase())} ${chalk.bold(String(params.side))}`,
        `  Trigger:          ${formatPrice(params.price as number)}`,
        ...(params.sizeUsd ? [`  Size at trigger:  ${formatUsd(params.sizeUsd as number)}`] : ['  Size at trigger:  full position']),
        `  TX: ${chalk.dim(shortSig(r.txSignature))}  ${chalk.dim(solscanTx(r.txSignature, client.network))}`,
        '',
      ].join('\n'),
      txSignature: r.txSignature,
    };
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

export const magicHistory: ToolDefinition = {
  name: 'magicHistory',
  description: 'Show recent magic-mode trade history (local journal).',
  parameters: z.object({ limit: z.number().int().positive().optional() }),
  async execute(params, context): Promise<ToolResult> {
    const kp = context.walletManager.getKeypair();
    const wallet = kp?.publicKey.toBase58();
    const limit = (params.limit as number | undefined) ?? 20;
    const entries = readMagicHistory(limit, wallet);
    if (entries.length === 0) {
      return { success: true, message: chalk.dim('  no magic trades recorded yet') };
    }
    const lines = ['', chalk.cyan('  📜 Magic History'), chalk.dim('  ─────────────────────────────────────')];
    for (const e of entries) {
      const t = new Date(e.ts).toLocaleString();
      const sym = e.market ? chalk.bold(e.market) : '';
      const sd = e.side ? (e.side === 'short' ? chalk.red(e.side) : chalk.green(e.side)) : '';
      const detail =
        e.collateralUsd !== undefined
          ? ` $${e.collateralUsd}${e.leverage ? ` ${e.leverage}x` : ''}`
          : e.sizeUsd !== undefined
            ? ` $${e.sizeUsd}`
            : e.triggerPriceUsd !== undefined
              ? ` @ $${e.triggerPriceUsd}`
              : '';
      lines.push(`  ${chalk.dim(t.padEnd(22))}${e.type.padEnd(16)}${sym} ${sd}${detail}  ${chalk.dim(e.txSignature.slice(0, 8) + '…')}`);
    }
    lines.push('');
    return { success: true, message: lines.join('\n'), data: { entries } };
  },
};

export const magicDashboard: ToolDefinition = {
  name: 'magicDashboard',
  description: 'At-a-glance: vault, positions, ER health, recent trades.',
  async execute(_params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const er = startErHealthMonitor(client['erEndpoint'] ?? 'https://flashtrade.magicblock.app/');
    void er; // ensure it's running
    const [balances, portfolio] = await Promise.all([
      client.getAvailableBalances(),
      client.getPortfolio(),
    ]);
    const recent = readMagicHistory(5, context.walletManager.getKeypair()?.publicKey.toBase58());
    const health = getErHealthMonitor()?.snapshot();
    const sep = chalk.dim('  ─────────────────────────────────────');
    const lines: string[] = [];
    lines.push('', chalk.cyan('  ⚡ Magic Dashboard'), sep);

    // Vault summary
    let stableUsd = 0;
    for (const [sym, b] of balances) {
      if (client.poolConfig.tokens.find((t) => t.symbol === sym)?.isStable) stableUsd += b.available;
    }
    lines.push(`  ${chalk.dim('Vault')}            available stable ${chalk.bold(formatUsd(stableUsd))}`);
    lines.push(`  ${chalk.dim('Wallet')}           ${chalk.dim(client.walletAddress.slice(0, 8) + '…')}`);

    // Positions summary
    lines.push('');
    lines.push(`  ${chalk.dim('Positions')}        ${portfolio.positions.length}`);
    for (const p of portfolio.positions) {
      const pnlColor = p.unrealizedPnl >= 0 ? chalk.green : chalk.red;
      lines.push(
        `    ${chalk.bold(p.market.padEnd(8))} ${p.side === 'short' ? chalk.red(p.side.padEnd(5)) : chalk.green(p.side.padEnd(5))} ${p.leverage.toFixed(1)}x  size ${formatUsd(p.sizeUsd)}  pnl ${pnlColor(formatUsd(p.unrealizedPnl))}`,
      );
    }

    // ER health
    lines.push('');
    if (health) {
      const dot = health.healthy ? chalk.green('●') : chalk.red('●');
      lines.push(`  ${chalk.dim('ER status')}        ${dot} ${health.healthy ? 'healthy' : 'degraded'}  ${chalk.dim(`${health.lastRttMs}ms`)}${health.consecutiveFailures > 0 ? chalk.red(`  ${health.consecutiveFailures} consecutive failures`) : ''}`);
    } else {
      lines.push(`  ${chalk.dim('ER status')}        ${chalk.dim('probe not started yet')}`);
    }

    // Recent trades
    if (recent.length > 0) {
      lines.push('');
      lines.push(`  ${chalk.dim('Recent')}`);
      for (const e of recent) {
        const t = new Date(e.ts).toLocaleTimeString();
        lines.push(`    ${chalk.dim(t.padEnd(10))} ${e.type.padEnd(14)} ${e.market ?? ''}`);
      }
    }
    lines.push('');
    return { success: true, message: lines.join('\n'), data: { stableUsd, positions: portfolio.positions, health } };
  },
};

export const magicErHealth: ToolDefinition = {
  name: 'magicErHealth',
  description: 'Show ER router health (latency, last error, consecutive failures).',
  async execute(_params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const mon = startErHealthMonitor(client['erEndpoint'] ?? 'https://flashtrade.magicblock.app/');
    // Wait for first tick (up to 2s) so we don't show empty stats.
    if (mon.snapshot().lastCheckAt === 0) await new Promise((r) => setTimeout(r, 1500));
    const s = mon.snapshot();
    const sep = chalk.dim('  ─────────────────────────────────────');
    const dot = s.healthy ? chalk.green('●') : chalk.red('●');
    return {
      success: true,
      message: [
        '',
        chalk.cyan('  📡 ER Health'),
        sep,
        `  Endpoint:        ${s.endpoint}`,
        `  Status:          ${dot} ${s.healthy ? chalk.green('healthy') : chalk.red('degraded')}`,
        `  Last RTT:        ${s.lastRttMs}ms`,
        `  Last block:      ${s.lastBlockHeight}`,
        `  Last check:      ${s.lastCheckAt ? new Date(s.lastCheckAt).toLocaleTimeString() : 'pending'}`,
        ...(s.lastErr ? [`  Last error:      ${chalk.red(s.lastErr)}`] : []),
        ...(s.consecutiveFailures > 0 ? [`  Failures:        ${chalk.red(String(s.consecutiveFailures))} consecutive`] : []),
        '',
      ].join('\n'),
      data: { ...s } as Record<string, unknown>,
    };
  },
};

export const magicAlerts: ToolDefinition = {
  name: 'magicAlerts',
  description: 'Toggle Telegram/Discord liq-risk alerts. args: action (on|off|status).',
  parameters: z.object({ action: z.enum(['on', 'off', 'status']) }),
  async execute(params, context): Promise<ToolResult> {
    const action = params.action as 'on' | 'off' | 'status';
    if (action === 'status') {
      const mon = getMagicAlerts();
      if (!mon) return { success: true, message: chalk.dim('  alerts: off') };
      const snap = mon.snapshot();
      const lines = ['', chalk.cyan('  📡 Magic Alerts'), chalk.dim('  ─────────────────────────────────────')];
      lines.push(`  Outbound: ${mon.hasOutbound() ? chalk.green('configured') : chalk.yellow('NO webhooks set')}`);
      lines.push(`  Tracked positions: ${snap.length}`);
      for (const s of snap) {
        const lvl = s.level === 'CRITICAL' ? chalk.red(s.level) : s.level === 'WARNING' ? chalk.yellow(s.level) : chalk.green(s.level);
        lines.push(`    ${chalk.bold(s.key.padEnd(14))} ${lvl}  distance=${(s.lastDistance * 100).toFixed(1)}%`);
      }
      lines.push('');
      return { success: true, message: lines.join('\n') };
    }
    if (action === 'off') {
      stopMagicAlerts();
      return { success: true, message: chalk.dim('  alerts stopped') };
    }
    // action === 'on'
    const client = buildMagicClient(context);
    const mon = startMagicAlerts(client);
    if (!mon.hasOutbound()) {
      return {
        success: true,
        message:
          chalk.yellow('  alerts started, but no webhooks are configured.\n') +
          chalk.dim('  Set MAGIC_ALERTS_TG_BOT_TOKEN + MAGIC_ALERTS_TG_CHAT_ID,\n  and/or MAGIC_ALERTS_DISCORD_WEBHOOK in your .env.'),
      };
    }
    return { success: true, message: chalk.green('  alerts started — webhooks configured. Will fire on WARNING / CRITICAL liq distance.') };
  },
};

/** Helper used by other magic tools to journal trades. */
export function journalMagicTrade(
  context: ToolContext,
  type: import('../security/magic-history.js').MagicTradeEntry['type'],
  details: Partial<import('../security/magic-history.js').MagicTradeEntry>,
): void {
  const kp = context.walletManager.getKeypair();
  const network = (context.config?.magicNetwork ?? 'mainnet-beta') as 'mainnet-beta' | 'devnet';
  if (!kp || !details.txSignature) return;
  recordMagicTrade({
    ts: new Date().toISOString(),
    type,
    walletAddress: kp.publicKey.toBase58(),
    network,
    txSignature: details.txSignature,
    market: details.market,
    side: details.side,
    collateralUsd: details.collateralUsd,
    sizeUsd: details.sizeUsd,
    leverage: details.leverage,
    triggerPriceUsd: details.triggerPriceUsd,
  });
}

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
  magicReverse,
  magicPartialClose,
  magicIncrease,
  magicTriggerOrder,
  magicPlaceLimit,
  magicCancelLimit,
  magicCancelTrigger,
  magicLiquidate,
  magicHistory,
  magicDashboard,
  magicErHealth,
  magicAlerts,
  magicFaucet,
];
