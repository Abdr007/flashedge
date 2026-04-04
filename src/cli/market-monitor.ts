/**
 * Market Monitor TUI — extracted from FlashTerminal.handleMarketMonitor()
 *
 * Self-contained TUI mode with its own event loop, data fetching,
 * rendering, and keyboard handling.
 */

import type { Interface } from 'readline';
import chalk from 'chalk';
import type { RpcManager } from '../network/rpc-manager.js';
import type { FStatsClient } from '../data/fstats.js';
import type { FlashConfig } from '../types/index.js';
import { formatUsd, formatPrice, formatPercent } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import { isDivergenceOk } from '../utils/protocol-liq.js';
import { IS_AGENT, agentOutput, agentError } from '../no-dna.js';
import { theme } from './theme.js';

export interface MarketMonitorDeps {
  rl: Interface;
  rpcManager: RpcManager;
  fstats: FStatsClient;
  config: FlashConfig;
}

export async function runMarketMonitor(deps: MarketMonitorDeps, filterMarket?: string): Promise<void> {
  // NO_DNA: TUI monitor is not compatible with agent mode — return snapshot instead
  if (IS_AGENT) {
    const { PriceService } = await import('../data/prices.js');
    const { POOL_MARKETS } = await import('../config/index.js');
    const priceSvc = new PriceService();
    const allSymbols = [
      ...new Set(
        Object.values(POOL_MARKETS)
          .flat()
          .map((s) => s.toUpperCase()),
      ),
    ];
    try {
      const prices = await priceSvc.getPrices(allSymbols);
      const snapshot = allSymbols.map((sym) => {
        const p = prices.get(sym);
        return { symbol: sym, price: p?.price ?? null, change_24h: p?.priceChange24h ?? null };
      });
      agentOutput({ action: 'market_monitor', markets: snapshot });
    } catch (err: unknown) {
      agentError('market_monitor_failed', { detail: getErrorMessage(err) });
    }
    return;
  }

  const { PriceService } = await import('../data/prices.js');
  const { TermRenderer } = await import('./renderer.js');
  const priceSvc = new PriceService();
  const { POOL_MARKETS } = await import('../config/index.js');

  // All unique market symbols from Flash SDK pool config
  let allSymbols = [
    ...new Set(
      Object.values(POOL_MARKETS)
        .flat()
        .map((s) => s.toUpperCase()),
    ),
  ];
  if (filterMarket) {
    allSymbols = allSymbols.filter((s) => s === filterMarket.toUpperCase());
  }

  let running = true;
  const REFRESH_MS = 5_000;
  const renderer = new TermRenderer();

  // ─── STEP 1: Isolate input BEFORE any rendering ──────────────
  deps.rl.pause();
  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  // Drain any buffered stdin (e.g. the Enter key from the command)
  // to prevent stale bytes from triggering the exit handler
  await new Promise<void>((resolve) => {
    const drain = () => {
      /* discard */
    };
    process.stdin.on('data', drain);
    setTimeout(() => {
      process.stdin.removeListener('data', drain);
      resolve();
    }, 50);
  });

  // ─── In-memory state for event detection ───────────────────────
  const prevPrices = new Map<string, number>();
  const prevOi = new Map<string, number>();
  const prevLongPct = new Map<string, number>();

  // Event thresholds — only fire on meaningful changes
  const PRICE_MOVE_PCT = 1.0; // 1% price move between cycles
  const OI_CHANGE_USD = 10_000; // $10k OI change between cycles
  const RATIO_SHIFT_PCT = 5; // 5pp long/short ratio shift

  // ─── Rolling history buffer for velocity tracking ──────────────
  const HISTORY_DEPTH = 12;

  interface MarketSnapshot {
    timestamp: number;
    price: number;
    totalOi: number;
    longPct: number;
  }

  const marketHistory = new Map<string, MarketSnapshot[]>();

  const pushSnapshot = (sym: string, snap: MarketSnapshot) => {
    let buf = marketHistory.get(sym);
    if (!buf) {
      buf = [];
      marketHistory.set(sym, buf);
    }
    buf.push(snap);
    if (buf.length > HISTORY_DEPTH) {
      buf.splice(0, buf.length - HISTORY_DEPTH);
    }
  };

  const velocityLabel = (sym: string): string => {
    const buf = marketHistory.get(sym);
    if (!buf || buf.length < 2) return `${REFRESH_MS / 1000}s`;
    const elapsed = Math.round((buf[buf.length - 1].timestamp - buf[buf.length - 2].timestamp) / 1000);
    return `${elapsed > 0 ? elapsed : REFRESH_MS / 1000}s`;
  };

  interface MarketRow {
    symbol: string;
    price: number;
    change: number;
    totalOi: number;
    longPct: number;
    shortPct: number;
    priceDirection: 'up' | 'down' | 'flat';
  }

  interface MarketEvent {
    message: string;
    color: 'green' | 'red' | 'yellow';
    timestamp: number;
  }

  const MAX_EVENTS = 6;
  let recentEvents: MarketEvent[] = [];

  // ─── Telemetry state ────────────────────────────────────────────
  interface Telemetry {
    rpcLatencyMs: number;
    oracleLatencyMs: number;
    slot: number;
    slotLag: number;
    renderTimeMs: number;
  }
  const telemetry: Telemetry = { rpcLatencyMs: -1, oracleLatencyMs: -1, slot: -1, slotLag: -1, renderTimeMs: 0 };

  // Slot freeze detection — tracks consecutive cycles where slot doesn't advance
  let previousSlot = -1;
  let slotFreezeCount = 0;

  const fetchData = async (): Promise<MarketRow[]> => {
    const now = Date.now();

    // Measure oracle latency (prices) and fetch OI in parallel
    const oracleStart = performance.now();
    const [priceMap, oi] = await Promise.all([
      priceSvc.getPrices(allSymbols).catch(() => new Map()),
      deps.fstats.getOpenInterest().catch(() => ({ markets: [] })),
    ]);

    // Fallback: for markets missing from Pyth (e.g. Lazer-only), read on-chain internal oracle
    if (deps.rpcManager) {
      const missingSymbols = allSymbols.filter((s) => !priceMap.has(s));
      for (const sym of missingSymbols) {
        try {
          const { PoolConfig } = await import('flash-sdk');
          const { getPoolForMarket } = await import('../config/index.js');
          const poolName = getPoolForMarket(sym);
          if (!poolName) continue;
          const pc = PoolConfig.fromIdsByName(poolName, 'mainnet-beta');
          const custody = pc.custodies.find((c: { symbol: string }) => c.symbol === sym);
          if (!custody?.intOracleAccount) continue;
          const info = await deps.rpcManager.connection.getAccountInfo(custody.intOracleAccount);
          if (!info || info.data.length < 28) continue;
          const rawPrice = info.data.readBigInt64LE(8);
          const exponent = info.data.readInt32LE(16);
          const price = Number(rawPrice) * Math.pow(10, exponent);
          if (Number.isFinite(price) && price > 0) {
            priceMap.set(sym, { symbol: sym, price, priceChange24h: 0, timestamp: Date.now(), isFallback: true });
          }
        } catch { /* best-effort — skip this symbol */ }
      }
    }

    telemetry.oracleLatencyMs = Math.round(performance.now() - oracleStart);

    // Measure RPC latency + get slot (lightweight — reuses cached values)
    if (deps.rpcManager) {
      // If slot is unknown, trigger a health check to populate slot data
      if (deps.rpcManager.activeSlot < 0) {
        await deps.rpcManager.checkHealth(deps.rpcManager.activeEndpoint).catch(() => {});
      }
      telemetry.rpcLatencyMs = deps.rpcManager.activeLatencyMs;
      telemetry.slot = deps.rpcManager.activeSlot;
      telemetry.slotLag = deps.rpcManager.activeSlotLag;

      // Slot freeze detection
      if (telemetry.slot > 0) {
        if (telemetry.slot === previousSlot) {
          slotFreezeCount++;
        } else {
          slotFreezeCount = 0;
        }
        previousSlot = telemetry.slot;
      }
    }

    const rows: MarketRow[] = [];

    for (const sym of allSymbols) {
      const tp = priceMap.get(sym);
      if (!tp) continue;
      // Aggregate OI across all pool entries for this symbol
      let longOi = 0;
      let shortOi = 0;
      for (const oiEntry of oi.markets) {
        if (oiEntry.market.toUpperCase().includes(sym)) {
          longOi += oiEntry.longOi ?? 0;
          shortOi += oiEntry.shortOi ?? 0;
        }
      }
      const totalOi = longOi + shortOi;

      // Show all markets — new markets may not have OI data yet

      const longPct = totalOi > 0 ? Math.round((longOi / totalOi) * 100) : 50;
      const shortPct = totalOi > 0 ? 100 - longPct : 50;

      const prev = prevPrices.get(sym);
      let priceDirection: 'up' | 'down' | 'flat' = 'flat';
      if (prev !== undefined) {
        if (tp.price > prev) priceDirection = 'up';
        else if (tp.price < prev) priceDirection = 'down';
      }

      // Event detection
      const vLabel = velocityLabel(sym);

      if (prev !== undefined && prev > 0) {
        const pricePctChange = ((tp.price - prev) / prev) * 100;
        if (Math.abs(pricePctChange) >= PRICE_MOVE_PCT) {
          const dir = pricePctChange > 0 ? '+' : '';
          recentEvents.push({
            message: `${sym} price moved ${dir}${pricePctChange.toFixed(2)}% (${vLabel})`,
            color: pricePctChange > 0 ? 'green' : 'red',
            timestamp: now,
          });
        }
      }

      const prevOiVal = prevOi.get(sym);
      if (prevOiVal !== undefined && prevOiVal > 0) {
        const oiDelta = totalOi - prevOiVal;
        if (Math.abs(oiDelta) >= OI_CHANGE_USD) {
          const dir = oiDelta > 0 ? '+' : '-';
          recentEvents.push({
            message: `${sym} OI ${dir}${formatUsd(Math.abs(oiDelta))} (${vLabel})`,
            color: oiDelta > 0 ? 'green' : 'yellow',
            timestamp: now,
          });
        }
      }

      const prevLong = prevLongPct.get(sym);
      if (prevLong !== undefined) {
        const shift = longPct - prevLong;
        if (Math.abs(shift) >= RATIO_SHIFT_PCT) {
          const desc = shift > 0 ? `longs +${shift}pp` : `shorts +${Math.abs(shift)}pp`;
          recentEvents.push({
            message: `${sym} ratio shifted: ${desc} (${vLabel})`,
            color: 'yellow',
            timestamp: now,
          });
        }
      }

      prevPrices.set(sym, tp.price);
      prevOi.set(sym, totalOi);
      prevLongPct.set(sym, longPct);
      pushSnapshot(sym, { timestamp: now, price: tp.price, totalOi, longPct });

      rows.push({
        symbol: sym,
        price: tp.price,
        change: tp.priceChange24h,
        totalOi,
        longPct,
        shortPct,
        priceDirection,
      });
    }

    // Evict stale events (>60s old) and cap size
    const eventNow = Date.now();
    recentEvents = recentEvents.filter((e) => eventNow - e.timestamp < 60_000);
    if (recentEvents.length > MAX_EVENTS) {
      recentEvents = recentEvents.slice(-MAX_EVENTS);
    }

    rows.sort((a, b) => b.totalOi - a.totalOi);
    return rows;
  };

  const _format1mMomentum = (sym: string): string | null => {
    const buf = marketHistory.get(sym);
    if (!buf || buf.length < 2) return null;

    const latest = buf[buf.length - 1];
    const oldest = buf[0];
    const elapsedSec = (latest.timestamp - oldest.timestamp) / 1000;
    if (elapsedSec < 10) return null;

    const priceDelta = oldest.price > 0 ? ((latest.price - oldest.price) / oldest.price) * 100 : 0;
    const oiDelta = latest.totalOi - oldest.totalOi;
    const ratioDelta = latest.longPct - oldest.longPct;

    const hasPriceMove = Math.abs(priceDelta) >= 0.1;
    const hasOiMove = Math.abs(oiDelta) >= 1000;
    const hasRatioMove = Math.abs(ratioDelta) >= 1;

    if (!hasPriceMove && !hasOiMove && !hasRatioMove) return null;

    const windowLabel = elapsedSec >= 55 ? '1m' : `${Math.round(elapsedSec)}s`;
    const parts: string[] = [];

    if (hasPriceMove) {
      const dir = priceDelta > 0 ? '+' : '';
      const pStr = `${dir}${priceDelta.toFixed(2)}%`;
      parts.push(priceDelta > 0 ? chalk.green(pStr) : chalk.red(pStr));
    }
    if (hasOiMove) {
      const dir = oiDelta > 0 ? '+' : '-';
      parts.push(chalk.cyan(`OI ${dir}${formatUsd(Math.abs(oiDelta))}`));
    }
    if (hasRatioMove) {
      const dir = ratioDelta > 0 ? `L+${ratioDelta}pp` : `S+${Math.abs(ratioDelta)}pp`;
      parts.push(chalk.yellow(dir));
    }

    return `  ${chalk.bold(sym.padEnd(6))} ${theme.dim(windowLabel.padEnd(4))} ${parts.join(theme.dim(' | '))}`;
  };

  /** Build frame — fits within terminal height, no scrolling */
  const buildFrame = (rows: MarketRow[]): string[] => {
    const termHeight = process.stdout.rows || 24;
    const now = new Date().toLocaleTimeString();

    // ── Telemetry status bar with health coloring ──
    const rpcMs = telemetry.rpcLatencyMs;
    const rpcStr =
      rpcMs < 0
        ? theme.dim('RPC N/A')
        : rpcMs < 150
          ? chalk.green(`RPC ${rpcMs}ms`)
          : rpcMs < 400
            ? chalk.yellow(`RPC ${rpcMs}ms`)
            : chalk.red(`RPC ${rpcMs}ms`);

    const oMs = telemetry.oracleLatencyMs;
    const oracleStr =
      oMs < 0
        ? theme.dim('Oracle N/A')
        : oMs <= 3000
          ? chalk.green(`Oracle ${oMs}ms`)
          : oMs <= 5000
            ? chalk.yellow(`Oracle ${oMs}ms ⚠`)
            : chalk.red(`Oracle ${oMs}ms ⚠`);

    const slotStr =
      telemetry.slot < 0
        ? theme.dim('Slot N/A')
        : slotFreezeCount >= 2
          ? chalk.red(`Slot ${telemetry.slot} ⚠`)
          : chalk.green(`Slot ${telemetry.slot}`);

    const lag = telemetry.slotLag;
    const lagStr =
      lag < 0
        ? theme.dim('Lag N/A')
        : lag === 0
          ? chalk.green('Lag 0')
          : lag <= 5
            ? chalk.yellow(`Lag ${lag}`)
            : chalk.red(`Lag ${lag}`);

    const renderStr = theme.dim(`Render ${telemetry.renderTimeMs}ms`);
    const _refreshStr = theme.dim(`Refresh ${REFRESH_MS / 1000}s`);

    // Divergence status from protocol-liq module (sync — no await needed)
    const divStr = isDivergenceOk() ? chalk.green('Divergence OK') : chalk.yellow('Divergence ⚠');

    const telemetryLine = `  ${rpcStr}  ${theme.dim('|')}  ${oracleStr}  ${theme.dim('|')}  ${slotStr}  ${theme.dim('|')}  ${lagStr}  ${theme.dim('|')}  ${renderStr}  ${theme.dim('|')}  ${divStr}`;

    // Chrome: title(1) + telemetry(1) + time(1) + separator(1) + header(1) + separator(1) + footer separator(1) + source(1) = 8 fixed lines
    const CHROME_LINES = 8;
    const maxMarketRows = Math.max(5, termHeight - CHROME_LINES);
    const visibleRows = rows.slice(0, maxMarketRows);
    const truncated = rows.length > maxMarketRows;

    const hdr = [
      theme.tableHeader('  Asset'.padEnd(14)),
      theme.tableHeader('Price'.padStart(14)),
      theme.tableHeader('24h Change'.padStart(12)),
      theme.tableHeader('Open Interest'.padStart(16)),
      theme.tableHeader('Long / Short'.padStart(14)),
    ].join('');

    const lines: string[] = [
      `  ${theme.accentBold('FLASH TERMINAL')} ${theme.dim('—')} ${theme.accentBold('MARKET MONITOR')}`,
      telemetryLine,
      theme.dim(`  ${now}  |  Press ${chalk.bold('q')} to exit`),
      `  ${theme.separator(72)}`,
      hdr,
      `  ${theme.separator(72)}`,
    ];

    // Data rows
    for (const r of visibleRows) {
      const sym = chalk.bold(('  ' + r.symbol).padEnd(14));
      const priceStr = formatPrice(r.price).padStart(14);
      const coloredPrice =
        r.priceDirection === 'up'
          ? chalk.green(priceStr)
          : r.priceDirection === 'down'
            ? chalk.red(priceStr)
            : priceStr;
      const changeRaw = !Number.isFinite(r.change)
        ? 'N/A'.padStart(12)
        : r.change === 0
          ? '+0.00%'.padStart(12)
          : formatPercent(r.change).padStart(12);
      const change = !Number.isFinite(r.change)
        ? theme.dim(changeRaw)
        : r.change > 0
          ? theme.positive(changeRaw)
          : r.change < 0
            ? theme.negative(changeRaw)
            : theme.dim(changeRaw);
      const oiStr = formatUsd(r.totalOi).padStart(16);
      const ratio = `${r.longPct} / ${r.shortPct}`.padStart(14);
      const ratioColored =
        r.longPct > 60 ? theme.positive(ratio) : r.shortPct > 60 ? theme.negative(ratio) : theme.dim(ratio);
      lines.push(`${sym}${coloredPrice}${change}${oiStr}${ratioColored}`);
    }

    if (visibleRows.length === 0) {
      lines.push(theme.dim('  No active markets found.'));
    }
    if (truncated) {
      lines.push(theme.dim(`  ... +${rows.length - maxMarketRows} more (resize terminal to see all)`));
    }

    // Footer
    lines.push(`  ${theme.separator(72)}`);
    lines.push(theme.dim(`  Source: Pyth Hermes (oracle) | fstats (open interest)`));

    return lines;
  };

  // ─── STEP 2: Enter alternate screen and show loading ──────────
  renderer.enterAltScreen();
  renderer.clear();
  const loadingFrame = [
    '',
    `  ${theme.accentBold('FLASH TERMINAL')} ${theme.dim('—')} ${theme.accentBold('MARKET MONITOR')}`,
    '',
    theme.dim('  Loading market data...'),
    '',
  ];
  renderer.render(loadingFrame);

  // ─── STEP 3: Fetch first dataset (block until data arrives) ───
  let initialRows: MarketRow[];
  try {
    initialRows = await fetchData();
  } catch {
    renderer.leaveAltScreen();
    console.log(chalk.red('  Failed to fetch market data.'));
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw ?? false);
    }
    deps.rl.resume();
    return;
  }

  // ─── STEP 4: Render initial frame (with data) ─────────────────
  renderer.clear();
  const renderStart0 = performance.now();
  const initialFrame = buildFrame(initialRows);
  renderer.render(initialFrame);
  telemetry.renderTimeMs = Math.round(performance.now() - renderStart0);

  // ─── STEP 5: Start refresh loop ──────────────────────────────
  let refreshInProgress = false;
  const interval = setInterval(async () => {
    if (!running || refreshInProgress) return;
    refreshInProgress = true;
    try {
      const rows = await fetchData();
      if (!running) return;
      const renderStart = performance.now();
      const frame = buildFrame(rows);
      // Skip render if nothing changed (diff check)
      if (renderer.hasChanged(frame)) {
        renderer.render(frame);
      }
      telemetry.renderTimeMs = Math.round(performance.now() - renderStart);
    } catch {
      // Skip failed refresh — keep last good render
    } finally {
      refreshInProgress = false;
    }
  }, REFRESH_MS);

  // ─── STEP 6: Exit on 'q' keypress ────────────────────────────
  await new Promise<void>((resolve) => {
    let exited = false;

    const cleanup = () => {
      if (exited) return;
      exited = true;

      process.stdin.removeListener('data', onKey);
      process.stdin.removeListener('error', onStdinError);
      process.stdin.removeListener('end', onStdinEnd);
      running = false;
      clearInterval(interval);

      // Leave alternate screen — restores original terminal content
      renderer.leaveAltScreen();
      renderer.reset();

      // Pause stdin FIRST to stop any further data events, then
      // switch out of raw mode so the 'q' keypress is not echoed
      // back into readline's buffer.
      process.stdin.pause();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(wasRaw ?? false);
      }

      // Drain any remaining stdin bytes before restoring readline.
      // Use a longer drain window to prevent the exit key from
      // leaking into the CLI prompt.
      const drainHandler = () => {
        /* discard */
      };
      process.stdin.resume();
      process.stdin.on('data', drainHandler);
      setTimeout(() => {
        process.stdin.removeListener('data', drainHandler);
        process.stdin.pause();

        // Resume readline and clear any buffered partial line
        deps.rl.resume();
        // Write an empty line reset to discard any leaked characters
        if (deps.rl.terminal) {
          (deps.rl as unknown as { line: string }).line = '';
          (deps.rl as unknown as { cursor: number }).cursor = 0;
          deps.rl.prompt();
        }
        resolve();
      }, 100);
    };

    const onKey = (buf: Buffer) => {
      const key = buf.toString();
      if (key !== 'q' && key !== 'Q' && key !== '\x03') return;
      cleanup();
    };

    const onStdinError = () => cleanup();
    const onStdinEnd = () => cleanup();

    process.stdin.on('data', onKey);
    process.stdin.on('error', onStdinError);
    process.stdin.on('end', onStdinEnd);
  });
}
