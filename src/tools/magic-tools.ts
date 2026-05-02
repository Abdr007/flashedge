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
import { Connection, PublicKey, Transaction, sendAndConfirmTransaction, type Keypair } from '@solana/web3.js';
import { ToolDefinition, ToolContext, ToolResult, TradeSide } from '../types/index.js';
import { MagicTradeClient } from '../client/magic-client.js';
import { loadSession, saveSession, clearSession, listSessions } from '../security/magic-session-store.js';

/** USDC mints — mainnet vs devnet test stable. */
const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_MINT_DEVNET = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';

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
  const client = new MagicTradeClient({
    wallet: kp,
    l1Connection,
    network,
    poolName,
    erEndpoint,
    programIdOverride: context.config?.magicProgramId,
    prioritizationFee: context.config?.computeUnitPrice,
    fastConfirm: context.config?.magicFastConfirm ?? true,
  });

  // Auto-resume a previously-persisted session if one is still valid.
  const stored = loadSession(network, kp.publicKey.toBase58());
  if (stored) {
    client.useSession(stored.keypair, stored.expiresAt);
  }
  return client;
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
            `pnl=$${p.unrealizedPnl.toFixed(2)}`,
        );
      });
    }
    return {
      success: true,
      message: lines.join('\n'),
      data: { portfolio },
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

export const magicDeposit: ToolDefinition = {
  name: 'magicDeposit',
  description: 'Deposit collateral to the UserDepositLedger (L1). args: mint, amount (raw u64).',
  parameters: z.object({ mint: z.string(), amount: z.string() }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const sig = await client.depositDirect(new PublicKey(params.mint as string), BigInt(params.amount as string));
    return {
      success: true,
      message: `✓ Deposited ${params.amount} of ${params.mint}\n  tx: ${sig}`,
      txSignature: sig,
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
    return {
      success: true,
      message:
        `✓ Opened ${params.market} ${params.side} ${params.leverage}x  $${params.collateral} collateral\n` +
        `  entry: $${result.entryPrice.toFixed(4)}  liq: $${result.liquidationPrice.toFixed(4)}  size: $${result.sizeUsd.toFixed(2)}\n` +
        `  tx: ${result.txSignature}`,
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
    return {
      success: true,
      message: `✓ Closed ${params.market} ${params.side}\n  pnl: $${result.pnl.toFixed(2)}  tx: ${result.txSignature}`,
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
      message: `✓ Added $${params.amount} collateral to ${params.market} ${params.side}\n  tx: ${result.txSignature}`,
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
      message: `✓ Removed $${params.amount} collateral from ${params.market} ${params.side}\n  tx: ${result.txSignature}`,
      txSignature: result.txSignature,
    };
  },
};

/**
 * Mint a fresh session keypair, build the L1 createSession ix, sign it (owner +
 * session both required), and persist the keypair to disk so subsequent CLI
 * runs auto-resume it.
 */
export const magicSessionStart: ToolDefinition = {
  name: 'magicSessionStart',
  description: 'Mint a session key for fast ER trades. args: durationSec? (default from config).',
  parameters: z.object({ durationSec: z.number().int().positive().optional() }),
  async execute(params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const kp = context.walletManager.getKeypair();
    if (!kp) throw new Error('wallet not loaded');

    if (client.hasActiveSession()) {
      return {
        success: true,
        message: `session already active — run \`magic session stop\` first to rotate`,
      };
    }

    const durationSec = (params.durationSec as number | undefined) ?? context.config?.magicSessionDurationSec ?? 7200;
    const built = await client.buildCreateSessionIxs(durationSec);

    // L1-sign the createSession tx with both owner + session keys.
    const l1Url =
      context.config?.magicL1RpcUrl ??
      (client.network === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
    const l1Connection = new Connection(l1Url, 'confirmed');
    const tx = new Transaction();
    for (const ix of built.instructions) tx.add(ix);
    const extraSigners = built.additionalSigners.filter((s): s is Keypair => 'secretKey' in s);
    const sig = await sendAndConfirmTransaction(l1Connection, tx, [kp, built.sessionKeypair, ...extraSigners], {
      commitment: 'confirmed',
      skipPreflight: false,
    });

    // Activate + persist.
    client.useSession(built.sessionKeypair, built.expiresAt);
    saveSession({
      network: client.network,
      ownerPubkey: kp.publicKey.toBase58(),
      sessionPubkey: built.sessionKeypair.publicKey.toBase58(),
      secretKey: Array.from(built.sessionKeypair.secretKey),
      expiresAt: built.expiresAt,
    });

    return {
      success: true,
      message:
        `✓ Session active — ER trades now sign with the session key (no owner-wallet prompts).\n` +
        `  session pubkey:  ${built.sessionKeypair.publicKey.toBase58()}\n` +
        `  expires at:      ${new Date(built.expiresAt * 1000).toISOString()}\n` +
        `  duration:        ${durationSec}s\n` +
        `  L1 tx:           ${sig}`,
      txSignature: sig,
    };
  },
};

export const magicSessionStop: ToolDefinition = {
  name: 'magicSessionStop',
  description: 'Revoke the active session key (rent returns to owner).',
  async execute(_params, context): Promise<ToolResult> {
    const client = buildMagicClient(context);
    const kp = context.walletManager.getKeypair();
    if (!kp) throw new Error('wallet not loaded');

    if (!client.hasActiveSession()) {
      // Always sweep on-disk state — handles the case where it was on disk but expired.
      clearSession(client.network, kp.publicKey.toBase58());
      return { success: true, message: 'no active session — nothing to revoke' };
    }
    const sig = await client.revokeSession();
    clearSession(client.network, kp.publicKey.toBase58());
    return {
      success: true,
      message: sig ? `✓ Session revoked\n  tx: ${sig}` : '✓ Session cleared (no on-chain revocation needed)',
      txSignature: sig ?? undefined,
    };
  },
};

export const magicSessionStatus: ToolDefinition = {
  name: 'magicSessionStatus',
  description: 'Show active session keys per wallet/network.',
  async execute(_params, _context): Promise<ToolResult> {
    const all = listSessions();
    if (all.length === 0) {
      return { success: true, message: 'no sessions stored — run `magic session start` to mint one' };
    }
    const now = Date.now() / 1000;
    const lines = all.map((s) => {
      const remaining = s.expiresAt - now;
      const fresh = remaining > 30;
      const tag = fresh ? '✓ active' : '✗ expired';
      const remStr = fresh
        ? `expires in ${Math.floor(remaining / 60)}m ${Math.floor(remaining % 60)}s`
        : 'expired — clean up via `magic session stop`';
      return `  ${tag} ${s.network.padEnd(13)} owner=${s.ownerPubkey.slice(0, 8)}… session=${s.sessionPubkey.slice(0, 8)}… ${remStr}`;
    });
    return { success: true, message: lines.join('\n'), data: { sessions: all } };
  },
};

export const magicTools: ToolDefinition[] = [
  magicInspect,
  magicStatus,
  magicDelegation,
  magicPortfolio,
  magicMarkets,
  magicSetup,
  magicDeposit,
  magicOpen,
  magicClose,
  magicAddCollateral,
  magicRemoveCollateral,
  magicSessionStart,
  magicSessionStop,
  magicSessionStatus,
  magicFaucet,
];
