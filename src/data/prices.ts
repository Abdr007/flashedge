import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';
import { getServiceBreaker } from '../core/circuit-breaker-service.js';
import { atomicWriteFileSync } from '../system/safe-file.js';

export interface TokenPrice {
  symbol: string;
  price: number;
  priceChange24h: number;
  timestamp: number;
  isFallback: boolean;
}

// Pyth Hermes feed IDs — loaded dynamically from Market Registry (SDK source of truth).
// No hardcoded feed IDs. New markets added via `npm update flash-sdk` are auto-discovered.
import { getAllPythFeedIds, getPythFeedIdFromRegistry } from '../markets/index.js';

/** Lazily-loaded Pyth feed ID map from SDK PoolConfig.json. */
let _pythFeedIds: Record<string, string> | null = null;
function getPythFeedIds(): Record<string, string> {
  if (!_pythFeedIds) _pythFeedIds = getAllPythFeedIds();
  return _pythFeedIds;
}

const FETCH_TIMEOUT_MS = 8_000;
const MAX_PRICE_CACHE_ENTRIES = 500;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1MB max

// 24h price history: record Pyth price snapshots, compute 24h change from oracle data.
// This is the ONLY source of 24h price change — no external APIs.
const HISTORY_INTERVAL_MS = 60_000; // record every 1 minute
const HISTORY_WINDOW_MS = 24 * 60 * 60_000; // 24 hours
const MAX_HISTORY_PER_SYMBOL = 1440; // 24h at 1min intervals
const DISK_SAVE_INTERVAL_MS = 30_000; // persist to disk every 30 seconds
const HISTORY_FILE = join(homedir(), '.flash', 'price-history.json');
const MAX_HISTORY_FILE_BYTES = 5 * 1024 * 1024; // 5MB max file size

interface PythParsedPrice {
  id: string;
  price: { price: string; expo: number; publish_time: number };
  ema_price: { price: string; expo: number };
}

interface PriceSnapshot {
  price: number;
  timestamp: number;
}

// Disk format: { version, lastSaved, symbols: { SYM: [{ price, timestamp }, ...] } }
interface HistoryFile {
  version: 1;
  lastSaved: number;
  symbols: Record<string, PriceSnapshot[]>;
}

// Module-level shared state — all PriceService instances share the same history.
// This ensures history accumulates regardless of which instance records/reads it,
// and any instance can flush to disk on shutdown.
const _sharedHistory: Map<string, PriceSnapshot[]> = new Map();
let _lastHistoryRecord = 0;
let _lastDiskSave = 0;
let _historyLoaded = false;

/** Get the Pyth feed ID for a market symbol (for diagnostics). */
export function getPythFeedId(symbol: string): string | null {
  return getPythFeedIdFromRegistry(symbol.toUpperCase()) ?? null;
}

export class PriceService {
  private cache: Map<string, { data: TokenPrice; expiry: number }> = new Map();
  private cacheTtlMs = 5_000; // 5s cache — Pyth is free, no rate limiting concern
  private lastMissingWarnTime = 0;
  private static readonly MISSING_WARN_INTERVAL_MS = 60_000;

  async getPrices(symbols: string[]): Promise<Map<string, TokenPrice>> {
    const priceMap = new Map<string, TokenPrice>();
    const now = Date.now();
    const logger = getLogger();

    // Load persisted history on first call (shared across all instances)
    if (!_historyLoaded) {
      this.loadHistoryFromDisk();
      _historyLoaded = true;
    }

    // Check cache first
    const uncached: string[] = [];
    for (const sym of symbols) {
      const upper = sym.toUpperCase();
      const cached = this.cache.get(upper);
      if (cached && cached.expiry > now) {
        priceMap.set(upper, cached.data);
      } else {
        uncached.push(upper);
      }
    }

    if (uncached.length === 0) return priceMap;

    // Bounded LRU eviction: remove oldest entries regardless of expiry
    if (this.cache.size >= MAX_PRICE_CACHE_ENTRIES) {
      const entries = Array.from(this.cache.entries()).sort(([, a], [, b]) => a.expiry - b.expiry);
      const toEvict = entries.slice(0, Math.max(10, this.cache.size - Math.floor(MAX_PRICE_CACHE_ENTRIES / 2)));
      for (const [k] of toEvict) this.cache.delete(k);
    }

    // Fetch from Pyth Hermes
    try {
      logger.debug('PRICE', `Fetching prices from Pyth Hermes for: ${uncached.join(', ')}`);
      const fetched = await this.fetchFromPyth(uncached);
      for (const tp of fetched) {
        priceMap.set(tp.symbol, tp);
        this.cache.set(tp.symbol, { data: tp, expiry: now + this.cacheTtlMs });
      }
      logger.info('PRICE', `Fetched ${fetched.length} prices from Pyth Hermes`);
    } catch (error: unknown) {
      logger.warn('PRICE', `Pyth Hermes fetch failed: ${getErrorMessage(error)}`);
    }

    // Record price history for 24h change computation
    this.recordPriceHistory(priceMap, now);

    // Force immediate disk save on first fetch (ensures all symbols persist across restarts)
    if (_lastDiskSave === 0 && priceMap.size > 0) {
      this.saveHistoryToDisk();
      _lastDiskSave = now;
    }

    // Stale cache fallback for missing symbols
    const missing = uncached.filter((sym) => !priceMap.has(sym));
    if (missing.length > 0) {
      for (const sym of missing) {
        const stale = this.cache.get(sym);
        if (stale) {
          priceMap.set(sym, stale.data);
        }
      }

      const trulyMissing = missing.filter((sym) => !priceMap.has(sym));
      if (trulyMissing.length > 0 && now - this.lastMissingWarnTime >= PriceService.MISSING_WARN_INTERVAL_MS) {
        logger.warn(
          'PRICE',
          `No live price for ${trulyMissing.length} market(s): ${trulyMissing.join(', ')} — excluded from analysis`,
        );
        this.lastMissingWarnTime = now;
      }
    }

    return priceMap;
  }

  async getPrice(symbol: string): Promise<TokenPrice | null> {
    const prices = await this.getPrices([symbol]);
    return prices.get(symbol.toUpperCase()) ?? null;
  }

  private async fetchFromPyth(symbols: string[]): Promise<TokenPrice[]> {
    const feedIds: string[] = [];
    const idToSymbol = new Map<string, string>();
    for (const sym of symbols) {
      const feedId = getPythFeedIds()[sym];
      if (feedId) {
        feedIds.push(feedId);
        idToSymbol.set(feedId.slice(2), sym);
      }
    }

    if (feedIds.length === 0) return [];

    const cb = getServiceBreaker('pyth-hermes', { failureThreshold: 3, cooldownMs: 15_000, maxCooldownMs: 60_000, cooldownMultiplier: 2 });
    if (!cb.allowRequest()) return []; // Circuit open — return empty, use cache

    const params = feedIds.map((id) => `ids[]=${id}`).join('&');
    const url = `https://hermes.pyth.network/v2/updates/price/latest?${params}&parsed=true`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });

      if (!res.ok) {
        throw new Error(`Pyth Hermes ${res.status}: ${res.statusText}`);
      }

      const contentLength = res.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
        throw new Error(`Pyth response too large: ${contentLength} bytes`);
      }

      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new Error(`Pyth response body too large: ${text.length} bytes`);
      }

      const data = JSON.parse(text) as { parsed?: PythParsedPrice[] };
      const results: TokenPrice[] = [];
      const now = Date.now();

      for (const entry of data.parsed ?? []) {
        const sym = idToSymbol.get(entry.id);
        if (!sym) continue;

        const price = parseInt(entry.price.price, 10) * Math.pow(10, entry.price.expo);
        if (!Number.isFinite(price) || price <= 0) continue;

        // Price deviation circuit breaker — reject >50% jumps from cached value
        const cached = this.cache.get(sym);
        if (cached && cached.data.price > 0) {
          const deviation = Math.abs(price - cached.data.price) / cached.data.price;
          if (deviation > 0.5) {
            getLogger().warn(
              'PRICE',
              `Rejecting suspicious price for ${sym}: $${price} vs cached $${cached.data.price.toFixed(2)} (${(deviation * 100).toFixed(0)}% deviation)`,
            );
            continue;
          }
        }

        const priceChange24h = this.compute24hChange(sym, price);

        results.push({
          symbol: sym,
          price,
          priceChange24h,
          timestamp: now,
          isFallback: false,
        });
      }

      cb.recordSuccess();
      return results;
    } catch (err) {
      cb.recordFailure();
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private recordPriceHistory(prices: Map<string, TokenPrice>, now: number): void {
    // Only record every HISTORY_INTERVAL_MS to keep memory bounded
    if (now - _lastHistoryRecord < HISTORY_INTERVAL_MS) return;
    _lastHistoryRecord = now;

    for (const [sym, tp] of prices) {
      if (!Number.isFinite(tp.price) || tp.price <= 0) continue;

      let history = _sharedHistory.get(sym);
      if (!history) {
        history = [];
        _sharedHistory.set(sym, history);
      }

      history.push({ price: tp.price, timestamp: now });

      // Prune: evict entries older than 24h + trim to max size
      this.pruneHistory(history);
    }

    // Bound total symbols tracked in history
    if (_sharedHistory.size > MAX_PRICE_CACHE_ENTRIES) {
      const keys = Array.from(_sharedHistory.keys());
      for (let i = 0; i < keys.length - MAX_PRICE_CACHE_ENTRIES; i++) {
        _sharedHistory.delete(keys[i]);
      }
    }

    // Persist to disk periodically
    if (now - _lastDiskSave >= DISK_SAVE_INTERVAL_MS) {
      this.saveHistoryToDisk();
      _lastDiskSave = now;
    }
  }

  /**
   * Prune a history array: remove entries older than 24h and cap at MAX_HISTORY_PER_SYMBOL.
   */
  private pruneHistory(history: PriceSnapshot[]): void {
    const cutoff = Date.now() - HISTORY_WINDOW_MS;
    while (history.length > 0 && history[0].timestamp < cutoff) {
      history.shift();
    }
    if (history.length > MAX_HISTORY_PER_SYMBOL) {
      history.splice(0, history.length - MAX_HISTORY_PER_SYMBOL);
    }
  }

  /**
   * Compute 24h price change from Pyth oracle history.
   *
   * Algorithm:
   *   1. Look up history for symbol
   *   2. Find entry closest to (now - 24h)
   *   3. Compute: ((current - historical) / historical) * 100
   *   4. Return NaN if insufficient history (callers render as "N/A")
   *
   * Data source: Pyth Hermes only — no external price APIs.
   */
  private compute24hChange(symbol: string, currentPrice: number): number {
    const history = _sharedHistory.get(symbol);

    // Need at least 2 entries
    if (!history || history.length < 2) {
      return NaN;
    }

    const oldestTimestamp = history[0].timestamp;
    const historyAgeMs = Date.now() - oldestTimestamp;

    // Require at least 2 minutes of history
    if (historyAgeMs < 2 * 60_000) {
      return NaN;
    }

    // Find entry closest to 24h ago (or oldest available if <24h of history)
    const target = Date.now() - HISTORY_WINDOW_MS;
    let closest = history[0];
    for (const snap of history) {
      if (Math.abs(snap.timestamp - target) < Math.abs(closest.timestamp - target)) {
        closest = snap;
      }
    }

    if (closest.price > 0 && Number.isFinite(closest.price)) {
      const change = ((currentPrice - closest.price) / closest.price) * 100;
      if (Number.isFinite(change)) return change;
    }

    return NaN;
  }

  // ─── Disk Persistence ──────────────────────────────────────────────────────

  private loadHistoryFromDisk(): void {
    try {
      if (!existsSync(HISTORY_FILE)) return;

      const raw = readFileSync(HISTORY_FILE, 'utf-8');
      if (raw.length > MAX_HISTORY_FILE_BYTES) {
        getLogger().warn('PRICE', `Price history file too large (${raw.length} bytes), starting fresh`);
        return;
      }

      const data = JSON.parse(raw) as HistoryFile;
      if (data.version !== 1 || !data.symbols) return;

      const now = Date.now();
      let loaded = 0;

      for (const [sym, snapshots] of Object.entries(data.symbols)) {
        if (!Array.isArray(snapshots)) continue;

        // Only keep snapshots within the 24h window
        const valid = snapshots.filter(
          (s): s is PriceSnapshot =>
            typeof s.price === 'number' &&
            typeof s.timestamp === 'number' &&
            Number.isFinite(s.price) &&
            s.price > 0 &&
            s.timestamp > now - HISTORY_WINDOW_MS,
        );

        if (valid.length > 0) {
          // Sort by timestamp ascending
          valid.sort((a, b) => a.timestamp - b.timestamp);
          // Trim to max
          if (valid.length > MAX_HISTORY_PER_SYMBOL) {
            valid.splice(0, valid.length - MAX_HISTORY_PER_SYMBOL);
          }
          _sharedHistory.set(sym.toUpperCase(), valid);
          loaded++;
        }
      }

      if (loaded > 0) {
        getLogger().info('PRICE', `Loaded 24h price history for ${loaded} markets from disk`);
      }
    } catch (error: unknown) {
      getLogger().debug('PRICE', `Failed to load price history: ${getErrorMessage(error)}`);
    }
  }

  private saveHistoryToDisk(): void {
    try {
      const dir = join(homedir(), '.flash');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      const symbols: Record<string, PriceSnapshot[]> = {};
      for (const [sym, snapshots] of _sharedHistory) {
        if (snapshots.length > 0) {
          symbols[sym] = snapshots;
        }
      }

      const data: HistoryFile = {
        version: 1,
        lastSaved: Date.now(),
        symbols,
      };

      const json = JSON.stringify(data);

      // Safety: don't write if too large
      let toWrite = json;
      if (json.length > MAX_HISTORY_FILE_BYTES) {
        getLogger().warn('PRICE', `Price history too large to save (${json.length} bytes), trimming`);
        // Keep only the most recent half of entries per symbol
        for (const snaps of Object.values(symbols)) {
          if (snaps.length > MAX_HISTORY_PER_SYMBOL / 2) {
            snaps.splice(0, snaps.length - Math.floor(MAX_HISTORY_PER_SYMBOL / 2));
          }
        }
        toWrite = JSON.stringify({ ...data, symbols });
      }

      // Atomic write: temp file → rename (original untouched on failure)
      atomicWriteFileSync(HISTORY_FILE, toWrite);

      getLogger().debug('PRICE', `Saved price history for ${Object.keys(symbols).length} markets to disk`);
    } catch (error: unknown) {
      getLogger().debug('PRICE', `Failed to save price history: ${getErrorMessage(error)}`);
    }
  }

  /** Save history to disk immediately (call on shutdown). */
  flushHistory(): void {
    this.saveHistoryToDisk();
  }

  clearCache(): void {
    this.cache.clear();
    _sharedHistory.clear();
    _lastHistoryRecord = 0;
    _lastDiskSave = 0;
  }
}
