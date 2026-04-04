import dotenv from 'dotenv';
import { FlashConfig, VALID_NETWORKS, Network, injectLeverageFn } from '../types/index.js';
import { homedir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
import { safeJsonParse } from '../utils/safe-json.js';

// Load .env from multiple locations (merged, highest priority first):
// Priority: environment variables > cwd/.env > ~/.flash/.env > package dir/.env
// dotenv's default behavior: does NOT overwrite existing process.env values.
// So the first file to set a key wins → load highest priority first.
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPaths = [
  resolve(process.cwd(), '.env'), // 1. Current working directory (highest)
  resolve(homedir(), '.flash', '.env'), // 2. ~/.flash/.env (user config)
  resolve(__dirname, '..', '.env'), // 3. Package install directory (lowest)
];
for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

function resolveHome(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return resolve(homedir(), filepath.slice(2));
  }
  if (filepath === '~') {
    return homedir();
  }
  return resolve(filepath);
}

function parseIntSafe(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseNetwork(value: string | undefined): Network {
  if (value && (VALID_NETWORKS as readonly string[]).includes(value)) {
    return value as Network;
  }
  return 'mainnet-beta';
}

export function validateRpcUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // If URL is unparseable, let it fail later at connection time
    return url;
  }

  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
    throw new Error(`RPC URL must use HTTPS (got ${parsed.protocol}). Only localhost/127.0.0.1 may use HTTP.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('RPC URL must not contain embedded credentials — use headers instead');
  }

  // Block internal/metadata IP ranges (SSRF protection)
  const host = parsed.hostname.replace(/^\[|\]$/g, ''); // Strip IPv6 brackets
  if (!isLocal) {
    // IPv4 private ranges
    if (
      host.startsWith('169.254.') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host === '0.0.0.0' ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      throw new Error(`RPC URL points to a private/internal IP (${host}). This is not allowed.`);
    }
    // IPv6 private/internal ranges
    if (
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') || // unique-local (fc00::/7)
      host.startsWith('fe80') || // link-local (fe80::/10)
      host.startsWith('::ffff:') // IPv4-mapped IPv6 (check mapped addr)
    ) {
      throw new Error(`RPC URL points to a private/internal IP (${host}). This is not allowed.`);
    }
    // IPv4-mapped IPv6 with dotted notation (e.g., ::ffff:169.254.169.254)
    const v4Mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (v4Mapped) {
      const ipv4 = v4Mapped[1];
      if (
        ipv4.startsWith('169.254.') ||
        ipv4.startsWith('10.') ||
        ipv4.startsWith('192.168.') ||
        ipv4 === '0.0.0.0' ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(ipv4)
      ) {
        throw new Error(`RPC URL points to a private/internal IP (${host}). This is not allowed.`);
      }
    }
  }

  return url;
}

// ─── Config File Support (~/.flash/config.json) ──────────────────────────────
// Priority: CLI flags > environment variables > config.json > defaults

interface ConfigFileData {
  rpc_url?: string;
  backup_rpc_urls?: string[];
  default_pool?: string;
  network?: string;
  default_slippage_bps?: number;
  compute_unit_limit?: number;
  compute_unit_price?: number;
  dynamic_compute?: boolean;
  compute_buffer_percent?: number;
  default_leverage?: number;
  max_collateral_per_trade?: number;
  max_position_size?: number;
  max_leverage?: number;
  max_trades_per_minute?: number;
  min_delay_between_trades_ms?: number;
  log_level?: string;
  referrer_address?: string;
}

function loadConfigFile(): ConfigFileData {
  try {
    const configPath = resolve(homedir(), '.flash', 'config.json');
    if (!existsSync(configPath)) return {};
    const raw = readFileSync(configPath, 'utf8');
    const data = safeJsonParse<unknown>(raw, {}, 'config.json');
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return {};
    return data as ConfigFileData;
  } catch {
    return {};
  }
}

/** Persist a single field to ~/.flash/config.json (merge with existing) */
export function saveConfigField(key: string, value: string | number | boolean | string[] | undefined): void {
  const configPath = resolve(homedir(), '.flash', 'config.json');
  let data: Record<string, unknown> = {};
  try {
    if (existsSync(configPath)) {
      const parsed = safeJsonParse<unknown>(readFileSync(configPath, 'utf8'), {}, 'config.json');
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    }
  } catch {
    /* start fresh */
  }

  if (value === undefined) {
    delete data[key];
  } else {
    data[key] = value;
  }

  mkdirSync(resolve(homedir(), '.flash'), { recursive: true });
  writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function loadConfig(): FlashConfig {
  const file = loadConfigFile();

  const backupRpcUrls: string[] = [];
  if (process.env.BACKUP_RPC_1) backupRpcUrls.push(validateRpcUrl(process.env.BACKUP_RPC_1));
  if (process.env.BACKUP_RPC_2) backupRpcUrls.push(validateRpcUrl(process.env.BACKUP_RPC_2));
  if (backupRpcUrls.length === 0 && Array.isArray(file.backup_rpc_urls)) {
    for (const url of file.backup_rpc_urls) {
      if (typeof url === 'string' && url.length > 0) {
        backupRpcUrls.push(validateRpcUrl(url));
      }
    }
  }

  const rpcDefault =
    typeof file.rpc_url === 'string' && file.rpc_url.length > 0
      ? validateRpcUrl(file.rpc_url)
      : 'https://api.mainnet-beta.solana.com';

  return {
    rpcUrl: validateRpcUrl(process.env.RPC_URL || rpcDefault),
    backupRpcUrls,
    pythnetUrl: validateRpcUrl(process.env.PYTHNET_URL || 'https://pythnet.rpcpool.com'),
    walletPath: resolveHome(process.env.WALLET_PATH || '~/.config/solana/id.json'),
    defaultPool: process.env.DEFAULT_POOL || (typeof file.default_pool === 'string' ? file.default_pool : 'Crypto.1'),
    network: parseNetwork(process.env.NETWORK || (typeof file.network === 'string' ? file.network : undefined)),
    simulationMode: (process.env.SIMULATION_MODE ?? 'true').toLowerCase() !== 'false',
    defaultSlippageBps: parseIntSafe(
      process.env.DEFAULT_SLIPPAGE_BPS,
      typeof file.default_slippage_bps === 'number' ? file.default_slippage_bps : 150,
    ),
    computeUnitLimit: parseIntSafe(
      process.env.COMPUTE_UNIT_LIMIT,
      typeof file.compute_unit_limit === 'number' ? file.compute_unit_limit : 220000,
    ),
    computeUnitPrice: parseIntSafe(
      process.env.COMPUTE_UNIT_PRICE,
      typeof file.compute_unit_price === 'number' ? file.compute_unit_price : 100000,
    ),
    logFile: process.env.LOG_FILE || null,
    // Signing guard limits (0 = unlimited / use market defaults)
    maxCollateralPerTrade: parseIntSafe(
      process.env.MAX_COLLATERAL_PER_TRADE,
      typeof file.max_collateral_per_trade === 'number' ? file.max_collateral_per_trade : 0,
    ),
    maxPositionSize: parseIntSafe(
      process.env.MAX_POSITION_SIZE,
      typeof file.max_position_size === 'number' ? file.max_position_size : 0,
    ),
    maxLeverage: parseIntSafe(process.env.MAX_LEVERAGE, typeof file.max_leverage === 'number' ? file.max_leverage : 0),
    maxTradesPerMinute: parseIntSafe(
      process.env.MAX_TRADES_PER_MINUTE,
      typeof file.max_trades_per_minute === 'number' ? file.max_trades_per_minute : 10,
    ),
    minDelayBetweenTradesMs: parseIntSafe(
      process.env.MIN_DELAY_BETWEEN_TRADES_MS,
      typeof file.min_delay_between_trades_ms === 'number' ? file.min_delay_between_trades_ms : 3000,
    ),
    defaultLeverage: parseIntSafe(
      process.env.DEFAULT_LEVERAGE,
      typeof file.default_leverage === 'number' ? file.default_leverage : 2,
    ),
    dynamicCompute:
      (
        process.env.FLASH_DYNAMIC_CU ?? (file.dynamic_compute !== undefined ? String(file.dynamic_compute) : 'true')
      ).toLowerCase() !== 'false',
    computeBufferPercent: parseIntSafe(
      process.env.FLASH_CU_BUFFER_PCT,
      typeof file.compute_buffer_percent === 'number' ? file.compute_buffer_percent : 20,
    ),
    leaderRouting:
      (process.env.FLASH_LEADER_ROUTING ?? '1').toLowerCase() !== '0' &&
      (process.env.FLASH_LEADER_ROUTING ?? '1').toLowerCase() !== 'false',
    rebroadcastIntervalMs: parseIntSafe(process.env.FLASH_REBROADCAST_MS, 800),
    referrerAddress:
      process.env.REFERRER_ADDRESS || (typeof file.referrer_address === 'string' ? file.referrer_address : DEFAULT_REFERRER_ADDRESS),
  };
}

// ─── Default Referrer ─────────────────────────────────────────────────────────
// All CLI trades are referred by this wallet. Earns rebates on every trade.
export const DEFAULT_REFERRER_ADDRESS = 'Dvvzg9rwaNfUqBSscoMZJa5CHFv8Lm94ngZrRyLGLfmK';

// Flash program constants
export const FLASH_PROGRAM_ID = 'FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn';
export const FLASH_COMPOSABILITY_PROGRAM_ID = 'FSWAPViR8ny5K96hezav8jynVubP2dJ2L7SbKzds2hwm';
export const FLASH_REWARD_PROGRAM_ID = 'FARNT7LL119pmy9vSkN9q1ApZESPaKHuuX5Acz1oBoME';

// fstats.io API
export const FSTATS_BASE_URL = 'https://fstats.io/api/v1';

// ─── Pool & Market Discovery (loaded from Flash SDK PoolConfig) ───────────────
// Reads pools and markets directly from the SDK's PoolConfig.json.
// New pools/markets added by Flash Trade are picked up on `npm update flash-sdk`.

const SKIP_TOKENS = new Set(['USDC', 'USDT', 'WSOL', 'XAUT', 'JITOSOL']);
const SKIP_POOL_PREFIXES = ['devnet.', 'Remora.'];

interface SdkPoolData {
  pools: Array<{
    poolName: string;
    tokens: Array<{ symbol: string; mintKey: string }>;
    markets: Array<{ targetMint: string; maxLev: number; degenMinLev: number; degenMaxLev: number }>;
  }>;
}

function discoverPoolsFromSdk(): { names: string[]; markets: Record<string, string[]> } {
  try {
    const require = createRequire(import.meta.url);
    const configPath = require.resolve('flash-sdk/dist/PoolConfig.json');
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as SdkPoolData;

    const names: string[] = [];
    const markets: Record<string, string[]> = {};

    const seen = new Set<string>();
    for (const pool of raw.pools) {
      if (SKIP_POOL_PREFIXES.some((p) => pool.poolName.startsWith(p))) continue;
      if (seen.has(pool.poolName)) continue; // Deduplicate (SDK JSON has duplicates)
      seen.add(pool.poolName);
      const syms = (pool.tokens || []).map((t) => t.symbol.toUpperCase()).filter((s) => !SKIP_TOKENS.has(s));
      if (syms.length === 0) continue;
      names.push(pool.poolName);
      markets[pool.poolName] = syms;
    }

    if (names.length > 0) return { names, markets };
  } catch {
    // SDK file unreadable — fall through to hardcoded fallback
  }

  // Hardcoded fallback (last known good state)
  return {
    names: ['Crypto.1', 'Virtual.1', 'Governance.1', 'Community.1', 'Community.2', 'Trump.1', 'Ore.1', 'Ondo.1'],
    markets: {
      'Crypto.1': ['SOL', 'BTC', 'ETH', 'ZEC', 'BNB'],
      'Virtual.1': ['XAG', 'XAU', 'CRUDEOIL', 'NATGAS', 'EUR', 'GBP', 'USDJPY', 'USDCNH'],
      'Governance.1': ['JTO', 'JUP', 'PYTH', 'RAY', 'HYPE', 'MET', 'KMNO'],
      'Community.1': ['PUMP', 'BONK', 'PENGU'],
      'Community.2': ['WIF'],
      'Trump.1': ['FARTCOIN'],
      'Ore.1': ['ORE'],
      'Ondo.1': ['SPY', 'NVDA', 'TSLA', 'AAPL', 'AMD', 'AMZN', 'PLTR'],
    },
  };
}

const _poolData = discoverPoolsFromSdk();

// Validate which pools are actually tradeable (PoolConfig.fromIdsByName works)
const _tradeablePools = new Set<string>();
for (const name of _poolData.names) {
  try {
    PoolConfig.fromIdsByName(name, 'mainnet-beta');
    _tradeablePools.add(name);
  } catch {
    // Pool exists in JSON but SDK can't load it yet — mark as view-only
  }
}

export const POOL_NAMES: string[] = _poolData.names;
export const POOL_MARKETS: Record<string, string[]> = _poolData.markets;

/** Check if a pool is tradeable (SDK can load it). View-only pools show in markets list but can't trade. */
export function isTradeablePool(poolName: string): boolean {
  return _tradeablePools.has(poolName);
}

export function getPoolForMarket(symbol: string): string | null {
  const upper = symbol.toUpperCase();
  for (const [pool, markets] of Object.entries(POOL_MARKETS)) {
    if (markets.some((m) => m.toUpperCase() === upper)) {
      return pool;
    }
  }
  return null;
}

export function getAllMarkets(): string[] {
  return Object.values(POOL_MARKETS)
    .flat()
    .map((m) => m.toUpperCase());
}

// ─── Per-Market Leverage Limits (loaded dynamically from Flash SDK PoolConfig) ─
// Reads leverage directly from the SDK so limits stay in sync with protocol updates.
// Just run `npm update flash-sdk` to pick up new leverage changes — no code edits needed.

import { PoolConfig } from 'flash-sdk';

interface MarketLeverage {
  maxLev: number;
  degenMaxLev: number;
  degenMinLev: number;
}

/** Lazily-built cache of per-market leverage from SDK PoolConfig. */
let _sdkLeverageCache: Record<string, MarketLeverage> | null = null;

function loadSdkLeverage(): Record<string, MarketLeverage> {
  if (_sdkLeverageCache) return _sdkLeverageCache;

  const cache: Record<string, MarketLeverage> = {};

  // Read directly from SDK's PoolConfig.json — covers ALL pools including those
  // not yet registered in PoolConfig.fromIdsByName (e.g. newly added pools)
  try {
    const require = createRequire(import.meta.url);
    const configPath = require.resolve('flash-sdk/dist/PoolConfig.json');
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as SdkPoolData;

    for (const pool of raw.pools) {
      if (SKIP_POOL_PREFIXES.some((p) => pool.poolName.startsWith(p))) continue;
      for (const m of pool.markets) {
        const token = (pool.tokens || []).find((t) => t.mintKey === m.targetMint);
        if (!token) continue;
        const sym = token.symbol.toUpperCase();
        if (SKIP_TOKENS.has(sym)) continue;
        const existing = cache[sym];
        if (existing) {
          existing.maxLev = Math.max(existing.maxLev, m.maxLev);
          existing.degenMaxLev = Math.max(existing.degenMaxLev, m.degenMaxLev);
          existing.degenMinLev = Math.min(existing.degenMinLev, m.degenMinLev);
        } else {
          cache[sym] = {
            maxLev: m.maxLev,
            degenMaxLev: m.degenMaxLev,
            degenMinLev: m.degenMinLev,
          };
        }
      }
    }
  } catch {
    // JSON read failed — fall back to PoolConfig.fromIdsByName for registered pools
    for (const poolName of POOL_NAMES) {
      try {
        const pc = PoolConfig.fromIdsByName(poolName, 'mainnet-beta');
        const markets = pc.markets as unknown as Array<{
          targetMint: { toBase58(): string };
          maxLev: number;
          degenMinLev: number;
          degenMaxLev: number;
        }>;
        const tokens = pc.tokens as unknown as Array<{
          symbol: string;
          mintKey: { toBase58(): string };
        }>;
        for (const m of markets) {
          const targetMintStr = m.targetMint.toBase58();
          const token = tokens.find((t) => t.mintKey.toBase58() === targetMintStr);
          if (!token) continue;
          const sym = token.symbol.toUpperCase();
          if (SKIP_TOKENS.has(sym)) continue;
          const existing = cache[sym];
          if (existing) {
            existing.maxLev = Math.max(existing.maxLev, m.maxLev);
            existing.degenMaxLev = Math.max(existing.degenMaxLev, m.degenMaxLev);
            existing.degenMinLev = Math.min(existing.degenMinLev, m.degenMinLev);
          } else {
            cache[sym] = { maxLev: m.maxLev, degenMaxLev: m.degenMaxLev, degenMinLev: m.degenMinLev };
          }
        }
      } catch {
        // Pool not available — skip
      }
    }
  }

  _sdkLeverageCache = cache;
  return cache;
}

/** Force refresh leverage cache (e.g. after SDK update). */
export function refreshLeverageCache(): void {
  _sdkLeverageCache = null;
}

/** Get the max allowed leverage for a market. Returns degenMaxLev if degen mode is on. */
export function getMaxLeverage(market: string, degenMode = false): number {
  const upper = market.toUpperCase();
  const lev = loadSdkLeverage()[upper];
  if (!lev) return 100; // safe default for unknown markets
  return degenMode ? lev.degenMaxLev : lev.maxLev;
}

/** Get the minimum leverage to enter degen mode for a market (125x for SOL/BTC/ETH). */
export function getDegenMinLeverage(market: string): number {
  const lev = loadSdkLeverage()[market.toUpperCase()];
  return lev?.degenMinLev ?? 1;
}

/** Check if a market supports degen mode (degenMaxLev > maxLev). */
export function hasDegenMode(market: string): boolean {
  const lev = loadSdkLeverage()[market.toUpperCase()];
  return lev ? lev.degenMaxLev > lev.maxLev : false;
}

/** Get all leverage data for display purposes. */
export function getAllLeverage(): Record<string, MarketLeverage> {
  return { ...loadSdkLeverage() };
}

// Inject SDK-based leverage into types module (avoids circular import)
injectLeverageFn(getMaxLeverage);
