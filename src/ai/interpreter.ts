import { ParsedIntent, ActionType, TradeSide } from '../types/index.js';
import { getAllMarkets } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { resolveMarket, normalizeAssetText, getMarketAliases } from '../utils/market-resolver.js';
import { expandLearnedAlias } from '../cli/learned-aliases.js';
import { expandTemplate } from '../cli/trade-templates.js';
import { getPreferredLeverage } from '../cli/trade-predictor.js';
import {
  detectMalformedCommand,
  invalidLeverageAlert,
  invalidCollateralAlert,
  invalidPercentageAlert,
  invalidPriceAlert,
  unknownMarketAlert,
  type CommandAlert,
} from '../utils/command-alerts.js';



function parseSide(raw: string): TradeSide | null {
  if (raw === 'long') return TradeSide.Long;
  if (raw === 'short') return TradeSide.Short;
  return null;
}

/** Parse optional "tp $X sl $Y" suffix from an open command.
 * Accepts: tp $95 sl $80, set tp 2300 and sl 1950, tp 2300 sl 1950, etc.
 */
function parseTpSlSuffix(suffix: string, result: Record<string, unknown>): void {
  if (!suffix) return;
  const tpMatch = suffix.match(/\btp\s+(?:to\s+|at\s+)?\$?(\d+(?:\.\d+)?)/);
  if (tpMatch) result.takeProfit = parseFloat(tpMatch[1]);
  const slMatch = suffix.match(/\bsl\s+(?:to\s+|at\s+)?\$?(\d+(?:\.\d+)?)/);
  if (slMatch) result.stopLoss = parseFloat(slMatch[1]);
}

/**
 * Flexible limit order parser — extracts components regardless of word order.
 *
 * Requires "limit" prefix and all of: side, market, leverage, collateral, price.
 * Accepts many phrasings:
 *   limit long SOL 2x $100 @ $82
 *   limit order sol 2x for 10 dollars long at 82
 *   limit short btc 3x $200 at $72000
 *   limit order long sol 2x $100 @ $82
 *   limit sol long 2x $100 at $82
 *   limit long sol $100 2x at $82
 */
function parseLimitOrder(input: string): ParsedIntent | null {
  // Must start with "limit"
  if (!input.startsWith('limit')) return null;

  // Strip "limit" or "limit order" prefix
  let body = input.replace(/^limit\s+(?:order\s+)?/, '');

  // Extract price: "@ $82" or "at $82" or "at 82" — must be present
  const priceMatch = body.match(/(?:@|at)\s+\$?(\d+(?:\.\d+)?)\s*$/);
  if (!priceMatch) return null;
  const limitPrice = parseFloat(priceMatch[1]);
  body = body.slice(0, priceMatch.index).trim();

  // Extract side: "long" or "short"
  const sideMatch = body.match(/\b(long|short)\b/);
  if (!sideMatch) return null;
  const side = parseSide(sideMatch[1]);
  if (!side) return null;
  body = body
    .replace(/\b(long|short)\b/, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Extract leverage: "2x", "2.5x", "2 x"
  const levMatch = body.match(/\b(\d+(?:\.\d+)?)\s*x\b/);
  if (!levMatch) return null;
  const leverage = parseFloat(levMatch[1]);
  body = body
    .replace(/\b\d+(?:\.\d+)?\s*x\b/, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Extract collateral: "$100", "100", "100 dollars", "for $100", "with $100", "for 100 dollars"
  const colMatch = body.match(/(?:(?:for|with)\s+)?\$?(\d+(?:\.\d+)?)\s*(?:dollars?|usd|usdc)?/);
  if (!colMatch) return null;
  const collateral = parseFloat(colMatch[1]);
  body = body.replace(colMatch[0], ' ').replace(/\s+/g, ' ').trim();

  // Remaining text should be the market (strip filler words)
  const market = body
    .replace(/\b(for|with|on|a|an|the|order|position)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!market || market.length > 20) return null;

  if (!Number.isFinite(limitPrice) || limitPrice <= 0) return null;
  if (!Number.isFinite(collateral) || collateral <= 0) return null;
  if (!Number.isFinite(leverage) || leverage < 1) return null;

  return {
    action: ActionType.LimitOrder,
    market: resolveMarket(market),
    side,
    leverage,
    collateral,
    limitPrice,
  } as ParsedIntent;
}

/** Levenshtein edit distance (max 3 for performance). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > 3) return 4; // early exit
  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) matrix[i] = [i];
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[a.length][b.length];
}

/** Fuzzy-correct side keywords: "lon" → "long", "lng" → "long", "shor" → "short". */
function fuzzySide(token: string): string | null {
  if (token === 'long' || token === 'short') return token;
  const sides = ['long', 'short'];
  for (const s of sides) {
    if (editDistance(token, s) <= 2) return s;
  }
  return null;
}

/** Fuzzy-correct market names: "solan" → "sol", "bitcoi" → "btc", "etherum" → "eth". */
function fuzzyMarket(token: string): string | null {
  // Direct resolution first
  const direct = resolveMarket(token);
  if (getAllMarkets().includes(direct)) return direct;
  // Try fuzzy against all known markets (distance 1 for short symbols, 2 for longer)
  const all = getAllMarkets();
  for (const m of all) {
    const maxDist = m.length <= 3 ? 1 : 2;
    if (editDistance(token, m.toLowerCase()) <= maxDist) return m;
  }
  // Try against market aliases (longer names → distance 2 allowed)
  const aliases = getMarketAliases();
  for (const [alias, symbol] of aliases) {
    if (editDistance(token, alias) <= 2) return symbol;
  }
  return null;
}

/**
 * Pre-process input with fuzzy correction on each token.
 * Corrects typos in side keywords and market names.
 */
function fuzzyCorrectTokens(input: string): string {
  const tokens = input.split(/\s+/);
  return tokens
    .map((t) => {
      // Try fuzzy side correction
      const correctedSide = fuzzySide(t);
      if (correctedSide && t !== correctedSide) return correctedSide;
      // Try fuzzy market correction (only for alphabetic tokens, not numbers)
      if (/^[a-z]+$/.test(t) && t.length >= 3) {
        const correctedMarket = fuzzyMarket(t);
        if (correctedMarket) return correctedMarket.toLowerCase();
      }
      return t;
    })
    .join(' ');
}

/**
 * Flexible open position parser — extracts entities regardless of word order.
 *
 * Accepts any combination of: prefix (open/buy/enter), side (long/short),
 * market (sol/btc/eth/...), leverage (2x/2.5x), collateral ($10/10/10 dollars).
 * Also extracts optional TP/SL suffixes.
 *
 * All of these parse identically:
 *   open 2x long sol $10     long sol 2x 10        buy sol 2x 10
 *   sol long 2x 10           long 10 sol 2x        open sol long $10 2x
 *   short btc 3x 50          long 2x sol 10        short 3x btc 50
 */
function flexParseOpen(input: string): ParsedIntent | null {
  // Split TP/SL suffix before main parse — find first occurrence of tp or sl keyword
  let mainPart = input;
  let tpSlPart = '';
  const tpSlSplit = input.match(/^(.*?)\b((?:set\s+)?(?:tp|sl)\b.*)$/);
  if (tpSlSplit) {
    mainPart = tpSlSplit[1].trim();
    tpSlPart = tpSlSplit[2];
  }

  let body = mainPart;

  // Strip greeting/filler prefixes and verbs (iterative — handles chains like "yo i want to go")
  for (let i = 0; i < 3; i++) {
    const before = body;
    body = body.replace(
      /^(?:yo|hey|please|pls|ok|okay|i\s+want\s+to|let\s+me|let\s+us|can\s+you|go|just|i\s+wanna)\s+/,
      '',
    );
    body = body.replace(/^(?:open|buy|enter)\s+(?:a\s+)?/, '');
    body = body.replace(/^(?:a|an|the)\s+/, '');
    if (body === before) break;
  }
  // Normalize "@" to "$" so "@10" and "@$10" are treated as collateral amounts
  body = body.replace(/@\$?(\d)/g, '$$$1');
  // Strip filler words (aggressive — keeps only meaningful tokens)
  body = body.replace(
    /\b(?:with|for|on|at|to|in|of|using|and|the|a|an|my|position|collateral|dollars?|bucks?|usd|usdc)\b/g,
    ' ',
  );
  // "leverage two" / "leverage 2" → "2x"
  body = body.replace(/\bleverage\s+(\d+(?:\.\d+)?)\b/g, '$1x');
  body = body.replace(/\s+/g, ' ').trim();

  // Extract side: long/short
  let side: TradeSide | null = null;
  const sideMatch = body.match(/\b(long|short)\b/);
  if (sideMatch) {
    side = parseSide(sideMatch[1]);
    body = body
      .replace(/\b(long|short)\b/, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // If original input started with a side-implying keyword, use that
  if (!side) {
    if (input.startsWith('long')) side = TradeSide.Long;
    else if (input.startsWith('short')) side = TradeSide.Short;
    // "open" without explicit side → default to long (matches "buy" alias behavior)
    else if (input.startsWith('open') || input.startsWith('enter')) side = TradeSide.Long;
  }

  if (!side) return null;

  // Extract leverage: "2x", "2.5x", "3 x"
  let leverage: number | null = null;
  const levMatch = body.match(/\b(\d+(?:\.\d+)?)\s*x\b/);
  if (levMatch) {
    leverage = parseFloat(levMatch[1]);
    body = body
      .replace(/\b\d+(?:\.\d+)?\s*x\b/, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Extract collateral: "$10", "10" — take the number that's NOT the leverage
  let collateral: number | null = null;
  const dollarMatch = body.match(/\$(\d+(?:\.\d+)?)/);
  if (dollarMatch) {
    collateral = parseFloat(dollarMatch[1]);
    body = body
      .replace(/\$\d+(?:\.\d+)?/, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } else {
    // Find remaining numbers — the one that looks like collateral (not leverage)
    const numbers = [...body.matchAll(/\b(\d+(?:\.\d+)?)\b/g)].map((m) => parseFloat(m[1]));
    if (numbers.length === 1) {
      collateral = numbers[0];
      body = body
        .replace(/\b\d+(?:\.\d+)?\b/, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    } else if (numbers.length >= 2 && !leverage) {
      // Two numbers, no leverage yet — one is leverage, one is collateral
      // The one with 'x' was already extracted; if both are bare numbers,
      // smaller is likely leverage, larger is collateral
      const sorted = [...numbers].sort((a, b) => a - b);
      leverage = sorted[0];
      collateral = sorted[1];
      body = body
        .replace(/\b\d+(?:\.\d+)?\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  // Remaining text should be the market
  body = body
    .replace(/\b(?:the|a|an|my|with|for|on)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!body) return null;

  // Resolve market — try direct first, then fuzzy correction for typos
  let market = resolveMarket(body);
  if (!getAllMarkets().includes(market)) {
    const fuzzyResult = fuzzyMarket(body);
    if (fuzzyResult) {
      market = fuzzyResult;
    } else {
      return null;
    }
  }

  if (!collateral || !Number.isFinite(collateral) || collateral <= 0) return null;
  // If no leverage found, try preferred from history, then default (2x)
  let _leverageDefaulted = false;
  if (!leverage) {
    const historyLev = getPreferredLeverage(market ?? '');
    leverage = historyLev ?? 2;
    _leverageDefaulted = true;
  }
  if (!Number.isFinite(leverage) || leverage < 1) return null;

  const result: Record<string, unknown> = {
    action: ActionType.OpenPosition,
    market,
    side,
    collateral,
    leverage,
  };

  if (tpSlPart) {
    parseTpSlSuffix(tpSlPart, result);
  }

  return result as ParsedIntent;
}

// ─── Flexible TP/SL Shortcut Parser ──────────────────────────────────────
// "tp sol 160" → set_tp_sl, "sl btc 60000" → set_tp_sl
function flexParseTpSl(input: string): ParsedIntent | null {
  const match = input.match(/^(tp|sl)\s+([a-z]+)\s+\$?(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const market = resolveMarket(match[2]);
  if (!market || !getAllMarkets().includes(market)) return null;
  const price = parseFloat(match[3]);
  if (!Number.isFinite(price) || price <= 0) return null;
  // Side omitted — terminal will auto-detect from open positions
  return {
    action: ActionType.SetTpSl,
    market,
    type: match[1] as 'tp' | 'sl',
    price,
  } as ParsedIntent;
}

// ─── Number Word Normalization ────────────────────────────────────────────

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
  thousand: 1000,
};

/** Convert number words to digits: "ten" → "10", "twenty five" → "25" */
function normalizeNumberWords(text: string): string {
  let result = text;
  // Handle compound forms: "twenty five" → "25"
  result = result.replace(
    /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(one|two|three|four|five|six|seven|eight|nine)\b/gi,
    (_match, tens: string, ones: string) => {
      const t = NUMBER_WORDS[tens.toLowerCase()] ?? 0;
      const o = NUMBER_WORDS[ones.toLowerCase()] ?? 0;
      return String(t + o);
    },
  );
  // Handle "X hundred" multiplier
  result = result.replace(
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+hundred\b/gi,
    (_match, n: string) => {
      const val = NUMBER_WORDS[n.toLowerCase()] ?? parseInt(n, 10);
      return Number.isFinite(val) ? String(val * 100) : n;
    },
  );
  // Handle "X thousand" multiplier
  result = result.replace(
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+thousand\b/gi,
    (_match, n: string) => {
      const val = NUMBER_WORDS[n.toLowerCase()] ?? parseInt(n, 10);
      return Number.isFinite(val) ? String(val * 1000) : n;
    },
  );
  // Handle standalone number words
  for (const [word, num] of Object.entries(NUMBER_WORDS)) {
    if (num >= 100) continue; // multipliers handled above
    result = result.replace(new RegExp(`\\b${word}\\b`, 'gi'), String(num));
  }
  return result;
}

/** Normalize asset aliases: "solana" → "SOL", "crude oil" → "crudeoil" */
function normalizeAssetAliases(text: string): string {
  return normalizeAssetText(text);
}

// ─── Command Aliases ──────────────────────────────────────────────────────
// Short aliases expand to full command prefixes before parsing.
// Only applied when the alias is the first token.
const COMMAND_ALIASES: Record<string, string> = {
  o: 'open',
  c: 'close',
  l: 'long',
  s: 'short',
  p: 'positions',
  pos: 'positions',
  m: 'monitor',
  w: 'wallet',
  d: 'dashboard',
  b: 'portfolio', // "b" for balance
  bal: 'portfolio',
  ca: 'close all',
  buy: 'open', // "buy sol 2x 10" → "open sol 2x 10"
  sell: 'close', // "sell sol" → "close sol"
};

/** Expand single-letter/short command aliases at the start of input. */
function expandAliases(input: string): string {
  const spaceIdx = input.indexOf(' ');
  const firstToken = spaceIdx === -1 ? input : input.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? '' : input.slice(spaceIdx);
  const expanded = COMMAND_ALIASES[firstToken.toLowerCase()];
  if (expanded) return expanded + rest;
  return input;
}

// ─── Post-Parse Validation ────────────────────────────────────────────────
// Validates parsed intent parameters and returns an alert if invalid.

/** Validate a parsed intent's parameters. Returns an alert if invalid, null if ok. */
export function validateIntent(intent: ParsedIntent): CommandAlert | null {
  const i = intent as Record<string, unknown>;

  // Leverage validation — basic sanity check only.
  // Per-market limits (including degen mode) are enforced in flash-tools.ts.
  if (typeof i.leverage === 'number') {
    if (!Number.isFinite(i.leverage) || i.leverage < 1.1 || i.leverage > 1000) {
      return invalidLeverageAlert(i.leverage);
    }
  }

  // Collateral validation
  if (typeof i.collateral === 'number') {
    if (!Number.isFinite(i.collateral) || i.collateral <= 0) {
      return invalidCollateralAlert(i.collateral);
    }
  }

  // Amount validation (add/remove collateral)
  if (typeof i.amount === 'number') {
    if (!Number.isFinite(i.amount) || i.amount <= 0) {
      return invalidCollateralAlert(i.amount);
    }
  }

  // Close percentage validation
  if (typeof i.closePercent === 'number') {
    if (!Number.isFinite(i.closePercent) || i.closePercent < 1 || i.closePercent > 100) {
      return invalidPercentageAlert(i.closePercent);
    }
  }

  // Close amount validation
  if (typeof i.closeAmount === 'number') {
    if (!Number.isFinite(i.closeAmount) || i.closeAmount <= 0) {
      return invalidCollateralAlert(i.closeAmount);
    }
  }

  // Price validation (TP/SL, limit orders)
  if (typeof i.price === 'number') {
    if (!Number.isFinite(i.price) || i.price <= 0) {
      return invalidPriceAlert(i.price);
    }
  }
  if (typeof i.limitPrice === 'number') {
    if (!Number.isFinite(i.limitPrice) || i.limitPrice <= 0) {
      return invalidPriceAlert(i.limitPrice);
    }
  }
  if (typeof i.takeProfit === 'number') {
    if (!Number.isFinite(i.takeProfit) || i.takeProfit <= 0) {
      return invalidPriceAlert(i.takeProfit);
    }
  }
  if (typeof i.stopLoss === 'number') {
    if (!Number.isFinite(i.stopLoss) || i.stopLoss <= 0) {
      return invalidPriceAlert(i.stopLoss);
    }
  }

  // Market validation (only for trading actions that require a valid market)
  if (typeof i.market === 'string' && i.market) {
    const tradingActions = [
      ActionType.OpenPosition,
      ActionType.ClosePosition,
      ActionType.AddCollateral,
      ActionType.RemoveCollateral,
      ActionType.SetTpSl,
      ActionType.RemoveTpSl,
      ActionType.LimitOrder,
    ];
    if (tradingActions.includes(intent.action as ActionType)) {
      const allMarkets = getAllMarkets();
      if (!allMarkets.includes(i.market as string)) {
        return unknownMarketAlert(i.market as string);
      }
    }
  }

  return null;
}

/**
 * Fast local regex-based parser for common commands.
 * Exported so it can be used by both AIInterpreter and OfflineInterpreter.
 */
export function localParse(input: string): ParsedIntent | null {
  // Sanitize: collapse whitespace (tabs, newlines, etc.) to single spaces, strip control chars
  const sanitized = input
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Expand trade templates first (e.g. "scalp" → "long sol 3x 50")
  const templateExpanded = expandTemplate(sanitized) ?? sanitized;
  // Expand learned user aliases (e.g. "lsol" → "long sol")
  const userExpanded = expandLearnedAlias(templateExpanded);
  // Expand command aliases: "o" → "open", "c" → "close", etc.
  const aliased = expandAliases(userExpanded);
  // Pre-process: normalize number words and asset aliases
  const normalized = normalizeAssetAliases(normalizeNumberWords(aliased));
  const lower = normalized.toLowerCase();

  // Fuzzy correction is applied later in the flex parser section only,
  // to avoid interfering with deterministic regex patterns above.

  // Help
  if (/^(help|commands|\?)$/.test(lower)) {
    return { action: ActionType.Help };
  }

  // Wallet commands
  // "wallet import <name> <path>" — register a wallet file path
  const walletImportMatch = lower.match(/^wallet\s+import\s+(\S+)\s+(.+)$/);
  if (walletImportMatch) {
    return { action: ActionType.WalletImport, name: walletImportMatch[1], path: walletImportMatch[2].trim() };
  }
  // "wallet import-key" — no longer supported, show usage
  if (/^wallet\s+import-key/.test(lower)) {
    return { action: ActionType.WalletImport, name: '', path: '' };
  }
  // Bare "wallet import" without args — show usage
  if (/^wallet\s+import$/.test(lower)) {
    return { action: ActionType.WalletImport, name: '', path: '' };
  }
  if (/^wallet\s+list$/.test(lower)) {
    return { action: ActionType.WalletList };
  }
  const walletUseMatch = lower.match(/^wallet\s+use\s+(\S+)$/);
  if (walletUseMatch) {
    // Preserve original case — wallet names are case-sensitive
    const origMatch = normalized.match(/^wallet\s+use\s+(\S+)$/i);
    return { action: ActionType.WalletUse, name: origMatch?.[1] ?? walletUseMatch[1] };
  }
  const walletRemoveMatch = lower.match(/^wallet\s+remove\s+(\S+)$/);
  if (walletRemoveMatch) {
    const origMatch = normalized.match(/^wallet\s+remove\s+(\S+)$/i);
    return { action: ActionType.WalletRemove, name: origMatch?.[1] ?? walletRemoveMatch[1] };
  }
  if (/^wallet\s+disconnect$/.test(lower)) {
    return { action: ActionType.WalletDisconnect };
  }
  const walletConnectMatch = lower.match(/^wallet\s+connect\s+(.+)$/);
  if (walletConnectMatch) {
    return { action: ActionType.WalletConnect, path: walletConnectMatch[1].trim() };
  }
  // Bare "wallet connect" without path — still route to connect tool with empty path so it shows usage
  if (/^wallet\s+connect$/.test(lower)) {
    return { action: ActionType.WalletConnect, path: '' };
  }
  if (/^wallet\s+(address|addr)$/.test(lower)) {
    return { action: ActionType.WalletAddress };
  }
  if (/^wallet\s+(balance|bal)$/.test(lower)) {
    return { action: ActionType.WalletBalance };
  }
  if (/^wallet\s+tokens?$/.test(lower)) {
    return { action: ActionType.WalletTokens };
  }
  // Bare "wallet" → wallet status
  if (/^wallet$/.test(lower)) {
    return { action: ActionType.WalletStatus };
  }

  // Portfolio / balance
  if (/^(portfolio|balance|account)$/.test(lower)) {
    return { action: ActionType.GetPortfolio };
  }

  // Positions
  if (/^(positions?|my positions?|show positions?|open positions?)$/.test(lower)) {
    return { action: ActionType.GetPositions };
  }

  // Volume
  if (/^(volume|trading volume|show volume)$/.test(lower)) {
    return { action: ActionType.GetVolume };
  }

  // Open interest
  if (/^(open interest|oi|show oi)$/.test(lower)) {
    return { action: ActionType.GetOpenInterest };
  }

  // Leaderboard
  if (/^(leaderboard|top traders?|rankings?)$/.test(lower)) {
    return { action: ActionType.GetLeaderboard };
  }

  // Fees
  if (/^(fees?|trading fees?|show fees?)$/.test(lower)) {
    return { action: ActionType.GetFees };
  }

  // Flash markets list
  if (/^(?:flash\s+)?markets$/.test(lower)) {
    return { action: ActionType.FlashMarkets };
  }

  // Market data: "SOL price", "price of BTC", "all markets"
  if (/^(all markets)$/.test(lower)) {
    return { action: ActionType.GetMarketData };
  }
  const priceMatch = lower.match(/^(?:price of\s+)?([a-z\s]+?)\s*(?:price)?$/);
  if (priceMatch) {
    const resolved = resolveMarket(priceMatch[1]);
    if (getAllMarkets().includes(resolved)) {
      return { action: ActionType.GetMarketData, market: resolved };
    }
  }

  // ─── Flexible Open Position Parser ────────────────────────────────────────
  // Extracts entities (side, market, leverage, collateral) from ANY position
  // in the input. Supports all natural orderings and tolerates typos.
  {
    const hasSide = /\b(long|short)\b/.test(lower);
    const hasNumbers = /\d/.test(lower);
    const openPrefixes = /^(?:open|enter|long|short|please|pls|yo|hey|ok|okay|i|just)\b/.test(lower);
    const marketSidePattern = /^[a-z]+\s+(?:long|short)\b/.test(lower);
    // Also trigger on number-first patterns: "10 usd sol long 2x"
    const numberFirst = /^\d/.test(lower);

    const hasLevPattern = /\d+\s*x\b/.test(lower);
    if (hasNumbers && (openPrefixes || marketSidePattern || (numberFirst && hasSide) || hasLevPattern)) {
      // Try direct parse first
      let parsed = flexParseOpen(lower);
      if (parsed) return parsed;

      // Try with fuzzy correction (typos: "lon" → "long", "solan" → "sol")
      const corrected = fuzzyCorrectTokens(lower);
      if (corrected !== lower) {
        parsed = flexParseOpen(corrected);
        if (parsed) return parsed;
      }
    }

    // Fallback: try fuzzy correction on inputs that didn't trigger above
    // (e.g., "solan long 2x 10" where "solan" isn't a known prefix)
    if (hasNumbers && !hasSide) {
      const corrected = fuzzyCorrectTokens(lower);
      if (corrected !== lower) {
        const parsed = flexParseOpen(corrected);
        if (parsed) return parsed;
      }
    }
  }

  // TP/SL shortcut: "tp sol 160", "sl btc 60000" (side auto-detected from positions)
  if (/^(tp|sl)\s+[a-z]/.test(lower)) {
    const tpSlShortcut = flexParseTpSl(lower);
    if (tpSlShortcut) return tpSlShortcut;
  }

  // Set TP/SL: "set tp SOL long $95", "set sl SOL long $80", "set tp btc long to 75000"
  const setTpSlMatch = lower.match(/^set\s+(tp|sl)\s+([a-z]+)\s+(long|short)\s+(?:to\s+|at\s+)?\$?(\d+(?:\.\d+)?)$/);
  if (setTpSlMatch) {
    const side = parseSide(setTpSlMatch[3]);
    if (side) {
      return {
        action: ActionType.SetTpSl,
        market: resolveMarket(setTpSlMatch[2]),
        side,
        type: setTpSlMatch[1] as 'tp' | 'sl',
        price: parseFloat(setTpSlMatch[4]),
      };
    }
  }

  // Set TP/SL alternate: "set tp 95 for SOL long", "set sl 80 for SOL long", "set tp $95 on SOL long"
  const setTpSlAltMatch = lower.match(
    /^set\s+(tp|sl)\s+\$?(\d+(?:\.\d+)?)\s+(?:for|on|to)?\s*([a-z]+)\s+(long|short)$/,
  );
  if (setTpSlAltMatch) {
    const side = parseSide(setTpSlAltMatch[4]);
    if (side) {
      return {
        action: ActionType.SetTpSl,
        market: resolveMarket(setTpSlAltMatch[3]),
        side,
        type: setTpSlAltMatch[1] as 'tp' | 'sl',
        price: parseFloat(setTpSlAltMatch[2]),
      };
    }
  }

  // Catch-all: if input starts with "set tp" or "set sl", never fall through
  if (/^set\s+(tp|sl)\b/.test(lower)) {
    return { action: ActionType.Help } as ParsedIntent;
  }

  // Remove TP/SL: "remove tp SOL long", "remove sl SOL long"
  const removeTpSlMatch = lower.match(/^remove\s+(tp|sl)\s+([a-z]+)\s+(long|short)$/);
  if (removeTpSlMatch) {
    const side = parseSide(removeTpSlMatch[3]);
    if (side) {
      return {
        action: ActionType.RemoveTpSl,
        market: resolveMarket(removeTpSlMatch[2]),
        side,
        type: removeTpSlMatch[1] as 'tp' | 'sl',
      };
    }
  }

  // Limit order — flexible parser that extracts components from any ordering.
  // Accepts "limit" or "limit order" prefix, then any combination of:
  //   side: long/short
  //   market: sol/btc/eth/...
  //   leverage: 2x / 2 x
  //   collateral: $100 / 100 / 100 dollars / for $100 / for 100 / with $100
  //   price: @ $82 / at $82 / at 82 / @ 82
  // Limit order — if input starts with "limit", it must be a limit order.
  // Never fall through to open command parser or AI interpreter.
  if (/^limit\b/.test(lower)) {
    const limitParsed = parseLimitOrder(lower);
    if (limitParsed) return limitParsed;
    // Failed to parse — return help instead of falling through
    return { action: ActionType.Help } as ParsedIntent;
  }

  // Edit limit order: "edit limit 0 price $85", "edit limit #0 sol long $85"
  const editMatch = lower.match(
    /^edit\s+limit\s+(?:order\s+)?#?(\d+)\s+(?:([a-z]+)\s+(long|short)\s+)?(?:price\s+)?\$?([\d.]+)$/,
  );
  if (editMatch) {
    const orderId = parseInt(editMatch[1], 10);
    const market = editMatch[2] ? resolveMarket(editMatch[2]) : '';
    const side = editMatch[3] ? parseSide(editMatch[3]) : undefined;
    const limitPrice = parseFloat(editMatch[4]);
    if (Number.isFinite(orderId) && Number.isFinite(limitPrice)) {
      return {
        action: ActionType.EditLimitOrder,
        orderId,
        market: market || 'SOL', // default — will be resolved from order if needed
        side: side || TradeSide.Long,
        limitPrice,
      };
    }
  }

  // Cancel order: "cancel order order-1", "cancel order-1", "cancel order 1", "cancel order #1"
  const cancelMatch = lower.match(/^cancel\s+(?:order\s+)?#?(?:order-)?(\d+)$/);
  if (cancelMatch) {
    return {
      action: ActionType.CancelOrder,
      orderId: cancelMatch[1],
    };
  }

  // Close position with amount/percent before market: "close 50% of SOL long", "close $20 of BTC short"
  const closePrefixMatch = lower.match(
    /^(?:close|exit|sell)\s+(\d+(?:\.\d+)?)\s*(%|percent)\s+(?:of\s+)?(?:my\s+)?([a-z]+)\s+(long|short)/,
  );
  if (closePrefixMatch) {
    const side = parseSide(closePrefixMatch[4]);
    if (side) {
      return {
        action: ActionType.ClosePosition,
        market: resolveMarket(closePrefixMatch[3]),
        side,
        closePercent: parseFloat(closePrefixMatch[1]),
      } as ParsedIntent;
    }
  }
  const closePrefixAmtMatch = lower.match(
    /^(?:close|exit|sell)\s+\$(\d+(?:\.\d+)?)\s+(?:of\s+|from\s+)?(?:my\s+)?([a-z]+)\s+(long|short)/,
  );
  if (closePrefixAmtMatch) {
    const side = parseSide(closePrefixAmtMatch[3]);
    if (side) {
      return {
        action: ActionType.ClosePosition,
        market: resolveMarket(closePrefixAmtMatch[2]),
        side,
        closeAmount: parseFloat(closePrefixAmtMatch[1]),
      } as ParsedIntent;
    }
  }

  // Close position: "close SOL long", "close SOL long 50%", "close SOL long $20"
  const closeMatch = lower.match(/^(?:close|exit|sell)\s+(?:my\s+)?([a-z]+)\s+(long|short)(?:\s+position)?\s*(.*)$/);
  if (closeMatch) {
    const side = parseSide(closeMatch[2]);
    if (side) {
      const result: Record<string, unknown> = {
        action: ActionType.ClosePosition,
        market: resolveMarket(closeMatch[1]),
        side,
      };
      // Parse optional partial close suffix: "50%", "$20", "25 percent"
      const suffix = closeMatch[3].trim();
      if (suffix) {
        const pctMatch = suffix.match(/^(\d+(?:\.\d+)?)\s*(?:%|percent)$/);
        const amtMatch = suffix.match(/^\$(\d+(?:\.\d+)?)$/);
        if (pctMatch) result.closePercent = parseFloat(pctMatch[1]);
        else if (amtMatch) result.closeAmount = parseFloat(amtMatch[1]);
      }
      return result as ParsedIntent;
    }
  }

  // Close position without side: "close SOL" — side will be auto-detected at execution
  const closeNoSideMatch = lower.match(/^(?:close|exit|sell)\s+(?:my\s+)?([a-z]+)(?:\s+position)?$/);
  if (closeNoSideMatch) {
    const resolved = resolveMarket(closeNoSideMatch[1]);
    if (getAllMarkets().includes(resolved)) {
      return {
        action: ActionType.ClosePosition,
        market: resolved,
        // side omitted — terminal will auto-detect from open positions
      } as ParsedIntent;
    }
  }

  // Add collateral: "add $200 to SOL long", "add collateral of $50 to SOL long", "add $200 to SOL"
  // Also: "add 5 dollar collateral on crude oil long" (after normalization: "add 5 dollar collateral on crudeoil long")
  const addCollMatch = lower.match(
    /^add\s+(?:collateral\s+(?:of\s+)?)?\$?(\d+(?:\.\d+)?)\s+(?:dollars?\s+)?(?:collateral\s+)?(?:to\s+|on\s+)?(?:my\s+)?([a-z]+)\s+(long|short)$/,
  );
  if (addCollMatch) {
    const side = parseSide(addCollMatch[3]);
    if (side) {
      return {
        action: ActionType.AddCollateral,
        market: resolveMarket(addCollMatch[2]),
        side,
        amount: parseFloat(addCollMatch[1]),
      };
    }
  }

  // Add collateral without side: "add $200 to SOL" — side will be auto-detected
  // Also: "add 5 dollar collateral on crude oil" (after normalization: "add 5 dollar collateral on crudeoil")
  const addCollNoSideMatch = lower.match(
    /^add\s+(?:collateral\s+(?:of\s+)?)?\$?(\d+(?:\.\d+)?)\s+(?:dollars?\s+)?(?:collateral\s+)?(?:to\s+|on\s+)?(?:my\s+)?([a-z]+)$/,
  );
  if (addCollNoSideMatch) {
    const resolved = resolveMarket(addCollNoSideMatch[2]);
    if (getAllMarkets().includes(resolved)) {
      return {
        action: ActionType.AddCollateral,
        market: resolved,
        amount: parseFloat(addCollNoSideMatch[1]),
      } as ParsedIntent;
    }
  }

  // Remove collateral: "remove $100 from ETH long", "remove $100 from ETH"
  const rmCollMatch = lower.match(
    /^remove\s+\$?(\d+(?:\.\d+)?)\s+(?:dollars?\s+)?(?:collateral\s+)?(?:from\s+|on\s+)?(?:my\s+)?([a-z]+)\s+(long|short)$/,
  );
  if (rmCollMatch) {
    const side = parseSide(rmCollMatch[3]);
    if (side) {
      return {
        action: ActionType.RemoveCollateral,
        market: resolveMarket(rmCollMatch[2]),
        side,
        amount: parseFloat(rmCollMatch[1]),
      };
    }
  }

  // Remove collateral without side: "remove $100 from SOL" — side will be auto-detected
  const rmCollNoSideMatch = lower.match(
    /^remove\s+\$?(\d+(?:\.\d+)?)\s+(?:dollars?\s+)?(?:collateral\s+)?(?:from\s+|on\s+)?(?:my\s+)?([a-z]+)$/,
  );
  if (rmCollNoSideMatch) {
    const resolved = resolveMarket(rmCollNoSideMatch[2]);
    if (getAllMarkets().includes(resolved)) {
      return {
        action: ActionType.RemoveCollateral,
        market: resolved,
        amount: parseFloat(rmCollNoSideMatch[1]),
      } as ParsedIntent;
    }
  }

  // ─── AI Agent Commands ──────────────────────────────────────────────────

  // Analyze: "analyze SOL", "analyze BTC", "analyze crude oil" (→ "analyze crudeoil" after normalization)
  // Also match "analyse" (British spelling)
  const analyzeMatch = lower.match(/^analy[sz]e\s+(.+)$/);
  if (analyzeMatch) {
    const market = resolveMarket(analyzeMatch[1]);
    return { action: ActionType.Analyze, market };
  }

  // Risk report: "risk report", "risk"
  if (/^(risk report|risk)$/.test(lower)) {
    return { action: ActionType.RiskReport };
  }

  // Dashboard: "dashboard", "dash"
  if (/^(dashboard|dash)$/.test(lower)) {
    return { action: ActionType.Dashboard };
  }

  // Whale activity: "whale activity", "whales", "whale activity SOL"
  const whaleMatch = lower.match(/^(?:whale\s+activity|whales?)(?:\s+(.+))?$/);
  if (whaleMatch) {
    return {
      action: ActionType.WhaleActivity,
      ...(whaleMatch[1] ? { market: resolveMarket(whaleMatch[1]) } : {}),
    };
  }

  // Liquidation map: "liquidations SOL", "liquidation BTC", "liquidations crude oil"
  const liqMatch = lower.match(/^liquidations?\s+(.+)$/);
  if (liqMatch) {
    const market = resolveMarket(liqMatch[1]);
    return { action: ActionType.LiquidationMap, market };
  }
  if (/^liquidations?$/.test(lower)) {
    return { action: ActionType.LiquidationMap };
  }

  // Funding: "funding SOL", "funding", "funding crude oil"
  const fundingMatch = lower.match(/^funding\s+(.+)$/);
  if (fundingMatch) {
    const market = resolveMarket(fundingMatch[1]);
    return { action: ActionType.FundingDashboard, market };
  }
  if (/^funding$/.test(lower)) {
    return { action: ActionType.FundingDashboard };
  }

  // Depth: "depth SOL", "depth", "depth crude oil"
  const depthMatch = lower.match(/^depth\s+(.+)$/);
  if (depthMatch) {
    const market = resolveMarket(depthMatch[1]);
    return { action: ActionType.LiquidityDepth, market };
  }
  if (/^depth$/.test(lower)) {
    return { action: ActionType.LiquidityDepth };
  }

  // Protocol health
  if (/^protocol\s+health$/.test(lower)) {
    return { action: ActionType.ProtocolHealth };
  }

  // scan command removed — CLI must not suggest trades

  // Trade History / Journal
  if (/^(?:trade\s+history|trades|journal|trade\s+journal|history)$/.test(lower)) {
    return { action: ActionType.TradeHistory };
  }

  // Market Monitor
  if (/^(?:market\s+monitor|monitor)$/.test(lower)) {
    return { action: ActionType.MarketMonitor };
  }

  // ─── Dry Run Command ────────────────────────────────────────────────────

  const dryrunMatch = lower.match(/^(?:dryrun|dry-run|dry\s+run)\s+(.+)$/);
  if (dryrunMatch) {
    return { action: ActionType.DryRun, innerCommand: dryrunMatch[1] };
  }

  // ─── Portfolio Intelligence Commands ──────────────────────────────────────

  if (/^(?:portfolio\s+state|portfolio\s+status|capital)$/.test(lower)) {
    return { action: ActionType.PortfolioState };
  }

  if (/^(?:portfolio\s+exposure|exposure)$/.test(lower)) {
    return { action: ActionType.PortfolioExposure };
  }

  if (/^(?:portfolio\s+rebalance|rebalance)$/.test(lower)) {
    return { action: ActionType.PortfolioRebalance };
  }

  // ─── Close All ─────────────────────────────────────────────────────────

  if (/^(?:close\s+all|close-all|closeall|exit\s+all)(?:\s+positions?)?$/.test(lower)) {
    return { action: ActionType.CloseAll };
  }

  // ─── Swap ──────────────────────────────────────────────────────────────
  // "swap SOL USDC $10", "swap 10 SOL to USDC", "swap SOL to USDC $10", "swap $50 USDC to SOL"
  const swapMatch1 = lower.match(/^swap\s+\$?(\d+(?:\.\d+)?)\s+([a-z]+)\s+(?:to|for|into)\s+([a-z]+)$/);
  if (swapMatch1) {
    return {
      action: ActionType.Swap,
      inputToken: resolveMarket(swapMatch1[2]),
      outputToken: resolveMarket(swapMatch1[3]),
      amount: parseFloat(swapMatch1[1]),
    } as ParsedIntent;
  }

  const swapMatch2 = lower.match(/^swap\s+([a-z]+)\s+(?:to|for|into)\s+([a-z]+)\s+\$?(\d+(?:\.\d+)?)$/);
  if (swapMatch2) {
    return {
      action: ActionType.Swap,
      inputToken: resolveMarket(swapMatch2[1]),
      outputToken: resolveMarket(swapMatch2[2]),
      amount: parseFloat(swapMatch2[3]),
    } as ParsedIntent;
  }

  const swapMatch3 = lower.match(/^swap\s+([a-z]+)\s+([a-z]+)\s+\$?(\d+(?:\.\d+)?)$/);
  if (swapMatch3) {
    return {
      action: ActionType.Swap,
      inputToken: resolveMarket(swapMatch3[1]),
      outputToken: resolveMarket(swapMatch3[2]),
      amount: parseFloat(swapMatch3[3]),
    } as ParsedIntent;
  }

  // Bare "swap" — show usage
  if (/^swap$/.test(lower)) {
    return { action: ActionType.Help } as ParsedIntent;
  }

  // ─── FAF Token Commands ────────────────────────────────────────────────
  if (/^faf\b/.test(lower)) {
    // "faf" or "faf status"
    if (/^faf(?:\s+status)?$/.test(lower)) {
      return { action: ActionType.FafStatus };
    }
    // "faf stake 1000"
    const fafStakeMatch = lower.match(/^faf\s+stake\s+\$?(\d+(?:\.\d+)?)$/);
    if (fafStakeMatch) {
      return { action: ActionType.FafStake, amount: parseFloat(fafStakeMatch[1]) } as ParsedIntent;
    }
    // "faf unstake 1000"
    const fafUnstakeMatch = lower.match(/^faf\s+unstake\s+\$?(\d+(?:\.\d+)?)$/);
    if (fafUnstakeMatch) {
      return { action: ActionType.FafUnstake, amount: parseFloat(fafUnstakeMatch[1]) } as ParsedIntent;
    }
    // "faf claim" / "faf claim rewards" / "faf claim revenue" / "faf claim rebate"
    if (/^faf\s+claim\s+rewards?$/.test(lower)) {
      return { action: ActionType.FafClaim, type: 'rewards' } as ParsedIntent;
    }
    if (/^faf\s+claim\s+revenue$/.test(lower)) {
      return { action: ActionType.FafClaim, type: 'revenue' } as ParsedIntent;
    }
    if (/^faf\s+claim\s+rebate$/.test(lower)) {
      return { action: ActionType.FafClaim, type: 'rebate' } as ParsedIntent;
    }
    if (/^faf\s+claim$/.test(lower)) {
      return { action: ActionType.FafClaim, type: 'all' } as ParsedIntent;
    }
    // "faf tier" / "faf tiers" / "faf vip"
    if (/^faf\s+(?:tiers?|vip|levels?)$/.test(lower)) {
      return { action: ActionType.FafTier };
    }
    // "faf rewards"
    if (/^faf\s+rewards?$/.test(lower)) {
      return { action: ActionType.FafRewards };
    }
    // "faf referral" (+ common misspellings: referal, refferal, referrals)
    if (/^faf\s+ref{1,2}er{1,2}als?$/.test(lower)) {
      return { action: ActionType.FafReferral };
    }
    // "faf points" / "faf voltage"
    if (/^faf\s+(?:points?|voltage)$/.test(lower)) {
      return { action: ActionType.FafPoints };
    }
    // "faf unstake requests" / "faf requests" / "faf pending"
    if (/^faf\s+(?:unstake\s+requests?|requests?|pending)$/.test(lower)) {
      return { action: ActionType.FafUnstakeRequests };
    }
    // "faf cancel <number>"
    const fafCancelMatch = lower.match(/^faf\s+cancel\s+(\d+)$/);
    if (fafCancelMatch) {
      return { action: ActionType.FafCancelUnstake, requestId: parseInt(fafCancelMatch[1], 10) } as ParsedIntent;
    }
    // Unknown faf subcommand → show status
    return { action: ActionType.FafStatus };
  }

  // ─── Earn Commands ─────────────────────────────────────────────────────
  // Natural language pool aliases — users type "crypto", system resolves to "Crypto.1"

  const EARN_POOL_ALIASES: Record<string, string> = {
    crypto: 'Crypto.1',
    main: 'Crypto.1',
    bluechip: 'Crypto.1',
    gold: 'Virtual.1',
    xau: 'Virtual.1',
    virtual: 'Virtual.1',
    forex: 'Virtual.1',
    commodities: 'Virtual.1',
    defi: 'Governance.1',
    governance: 'Governance.1',
    gov: 'Governance.1',
    meme: 'Community.1',
    community: 'Community.1',
    wif: 'Community.2',
    fart: 'Trump.1',
    fartcoin: 'Trump.1',
    trump: 'Trump.1',
    ore: 'Ore.1',
  };

  /** Resolve a pool alias to protocol pool name. Also accepts pool:Name for backward compat. */
  function resolveEarnPool(alias?: string): string | undefined {
    if (!alias) return undefined;
    // Support legacy pool:Crypto.1 syntax
    if (alias.startsWith('pool:')) return alias.slice(5);
    return EARN_POOL_ALIASES[alias.toLowerCase()] ?? undefined;
  }

  /** Extract the last token as a pool alias if it matches. Returns [cleaned, poolName|undefined]. */
  function extractEarnPool(text: string, originalText?: string): [string, string | undefined] {
    const tokens = text.trim().split(/\s+/);
    if (tokens.length < 2) return [text, undefined];
    const last = tokens[tokens.length - 1];
    // For pool: syntax, use original casing from originalText
    const origTokens = originalText?.trim().split(/\s+/);
    const lastOrig = origTokens?.[origTokens.length - 1] ?? last;
    // Check if last token is a pool alias or pool:X
    if (EARN_POOL_ALIASES[last] || last.startsWith('pool:')) {
      const pool = resolveEarnPool(last.startsWith('pool:') ? lastOrig : last);
      return [tokens.slice(0, -1).join(' '), pool];
    }
    return [text, undefined];
  }

  // Only process if input starts with "earn"
  if (/^earn\b/.test(lower)) {
    const [earnBody, earnPool] = extractEarnPool(lower, normalized);

    // "earn add $100", "earn add $100 crypto", "earn add-liquidity $100 governance"
    const earnAddMatch = earnBody.match(/^earn\s+add(?:[- ]?liquidity)?\s+\$?(\d+(?:\.\d+)?)$/);
    if (earnAddMatch) {
      return {
        action: ActionType.EarnAddLiquidity,
        amount: parseFloat(earnAddMatch[1]),
        token: 'USDC',
        pool: earnPool ?? EARN_POOL_ALIASES['crypto'],
      } as ParsedIntent;
    }

    // "earn remove 50%", "earn remove 50% crypto", "earn remove-liquidity 25% governance"
    const earnRemoveMatch = earnBody.match(/^earn\s+remove(?:[- ]?liquidity)?\s+(\d+(?:\.\d+)?)\s*%?$/);
    if (earnRemoveMatch) {
      return {
        action: ActionType.EarnRemoveLiquidity,
        percent: parseFloat(earnRemoveMatch[1]),
        token: 'USDC',
        pool: earnPool ?? EARN_POOL_ALIASES['crypto'],
      } as ParsedIntent;
    }

    // "earn stake $200", "earn stake $200 governance"
    const earnStakeMatch = earnBody.match(/^earn\s+stake(?:[- ]?flp)?\s+\$?(\d+(?:\.\d+)?)$/);
    if (earnStakeMatch) {
      return {
        action: ActionType.EarnStake,
        amount: parseFloat(earnStakeMatch[1]),
        pool: earnPool ?? EARN_POOL_ALIASES['crypto'],
      } as ParsedIntent;
    }

    // "earn unstake 25%", "earn unstake 50% governance"
    const earnUnstakeMatch = earnBody.match(/^earn\s+unstake(?:[- ]?flp)?\s+(\d+(?:\.\d+)?)\s*%?$/);
    if (earnUnstakeMatch) {
      return {
        action: ActionType.EarnUnstake,
        percent: parseFloat(earnUnstakeMatch[1]),
        pool: earnPool ?? EARN_POOL_ALIASES['crypto'],
      } as ParsedIntent;
    }

    // "earn claim", "earn claim crypto", "earn claim governance"
    if (/^earn\s+claim(?:[- ]?rewards?)?$/.test(earnBody)) {
      return { action: ActionType.EarnClaimRewards, pool: earnPool } as ParsedIntent;
    }

    // "earn info crypto", "earn info gold"
    const earnInfoMatch = earnBody.match(/^earn\s+info(?:\s+(.+))?$/);
    if (earnInfoMatch) {
      const pool = earnInfoMatch[1] ? (resolveEarnPool(earnInfoMatch[1]) ?? earnInfoMatch[1]) : earnPool;
      return { action: ActionType.EarnInfo, pool } as ParsedIntent;
    }

    // "earn deposit $100 crypto", "earn deposit 50 gold"
    const earnDepositMatch = earnBody.match(/^earn\s+deposit\s+\$?(\d+(?:\.\d+)?)$/);
    if (earnDepositMatch) {
      return {
        action: ActionType.EarnAddLiquidity,
        amount: parseFloat(earnDepositMatch[1]),
        token: 'USDC',
        pool: earnPool ?? EARN_POOL_ALIASES['crypto'],
      } as ParsedIntent;
    }

    // "earn withdraw 50% crypto", "earn withdraw 100% gold"
    const earnWithdrawMatch = earnBody.match(/^earn\s+withdraw\s+(\d+(?:\.\d+)?)\s*%?$/);
    if (earnWithdrawMatch) {
      return {
        action: ActionType.EarnRemoveLiquidity,
        percent: parseFloat(earnWithdrawMatch[1]),
        token: 'USDC',
        pool: earnPool ?? EARN_POOL_ALIASES['crypto'],
      } as ParsedIntent;
    }

    // "earn best" — pool ranking; "earn best 500" → auto-route deposit
    if (/^earn\s+best$/.test(earnBody)) {
      return { action: ActionType.EarnBest };
    }
    const earnBestAmtMatch = earnBody.match(/^earn\s+best\s+\$?(\d+(?:\.\d+)?)$/);
    if (earnBestAmtMatch) {
      return {
        action: ActionType.EarnAddLiquidity,
        amount: parseFloat(earnBestAmtMatch[1]),
        token: 'USDC',
        pool: '__best__', // sentinel — tool resolves to top-ranked pool
      } as ParsedIntent;
    }

    // "earn pnl" / "earn profit" / "earn performance"
    if (/^earn\s+(?:pnl|profit|performance|returns?)$/.test(earnBody)) {
      return { action: ActionType.EarnPnl };
    }

    // "earn demand" / "earn utilization"
    if (/^earn\s+(?:demand|utilization|usage)$/.test(earnBody)) {
      return { action: ActionType.EarnDemand };
    }

    // "earn rotate" / "earn optimize" / "earn rebalance"
    if (/^earn\s+(?:rotate|optimize|rebalance)$/.test(earnBody)) {
      return { action: ActionType.EarnRotate };
    }

    // "earn simulate crypto 1000", "earn sim gold 500"
    const earnSimMatch = earnBody.match(/^earn\s+sim(?:ulate)?\s+\$?(\d+(?:\.\d+)?)$/);
    if (earnSimMatch) {
      return {
        action: ActionType.EarnSimulate,
        amount: parseFloat(earnSimMatch[1]),
        pool: earnPool ?? EARN_POOL_ALIASES['crypto'],
      } as ParsedIntent;
    }

    // "earn dashboard", "earn dash"
    if (/^earn\s+(?:dashboard|dash)$/.test(earnBody)) {
      return { action: ActionType.EarnDashboard };
    }

    // "earn positions", "earn pos"
    if (/^earn\s+(?:positions?|pos)$/.test(earnBody)) {
      return { action: ActionType.EarnPositions };
    }

    // "earn integrations" / "earn partners"
    if (/^earn\s+(?:integrations?|partners?)$/.test(earnBody)) {
      return { action: ActionType.EarnIntegrations };
    }

    // "earn history crypto" / "earn apy history"
    const earnHistMatch = earnBody.match(/^earn\s+(?:history|apy)\s*$/);
    if (earnHistMatch) {
      return { action: ActionType.EarnHistory, pool: earnPool } as ParsedIntent;
    }

    // "earn pools" — same as earn status
    if (/^earn\s+pools?$/.test(earnBody)) {
      return { action: ActionType.EarnStatus };
    }

    // Smart shortcut: "earn 500 crypto" → earn deposit crypto 500
    const earnShortcut = earnBody.match(/^earn\s+\$?(\d+(?:\.\d+)?)$/);
    if (earnShortcut && earnPool) {
      return {
        action: ActionType.EarnAddLiquidity,
        amount: parseFloat(earnShortcut[1]),
        token: 'USDC',
        pool: earnPool,
      } as ParsedIntent;
    }

    // "earn status" or bare "earn"
    if (/^earn(?:\s+status)?$/.test(earnBody)) {
      return { action: ActionType.EarnStatus };
    }

    // Unknown earn subcommand — show earn help
    return { action: ActionType.EarnStatus };
  }

  return null;
}

// ─── Conversation Context for Follow-Up Commands ──────────────────────────

interface CommandContext {
  lastMarket?: string;
  lastSide?: TradeSide;
  lastLeverage?: number;
  lastCollateral?: number;
  lastAction?: ActionType;
  updatedAt: number;
}

const CONTEXT_TTL_MS = 120_000; // 2 minutes

/**
 * Offline interpreter that only uses local regex parsing.
 * Used when no API key is configured.
 */
export class OfflineInterpreter {
  private context: CommandContext = { updatedAt: 0 };

  /** Update conversation context after a successful parse. */
  private updateContext(intent: ParsedIntent): void {
    const now = Date.now();
    if ('market' in intent && intent.market) this.context.lastMarket = intent.market as string;
    if ('side' in intent) this.context.lastSide = intent.side as TradeSide;
    if ('leverage' in intent) this.context.lastLeverage = intent.leverage as number;
    if ('collateral' in intent) this.context.lastCollateral = intent.collateral as number;
    this.context.lastAction = intent.action;
    this.context.updatedAt = now;
  }

  /** Get fresh context (returns undefined if expired). */
  private getContext(): CommandContext | undefined {
    if (Date.now() - this.context.updatedAt > CONTEXT_TTL_MS) return undefined;
    return this.context;
  }

  /** Try to resolve follow-up commands using conversation context. */
  private tryContextualParse(userInput: string): ParsedIntent | null {
    const ctx = this.getContext();
    if (!ctx) return null;

    const lower = normalizeAssetAliases(normalizeNumberWords(userInput))
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    if (/^close\s+(it|that|the\s+position)$/.test(lower) && ctx.lastMarket && ctx.lastSide) {
      return { action: ActionType.ClosePosition, market: ctx.lastMarket, side: ctx.lastSide };
    }

    const increaseMatch = lower.match(
      /^(?:increase|change|set)\s+(?:it\s+)?(?:collateral\s+)?to\s+\$?(\d+(?:\.\d+)?)$/,
    );
    if (increaseMatch && ctx.lastMarket && ctx.lastSide && ctx.lastCollateral) {
      const newAmount = parseFloat(increaseMatch[1]);
      const diff = newAmount - ctx.lastCollateral;
      if (diff > 0) {
        return { action: ActionType.AddCollateral, market: ctx.lastMarket, side: ctx.lastSide, amount: diff };
      }
    }

    const addMatch = lower.match(/^add\s+\$?(\d+(?:\.\d+)?)\s+(?:to\s+it|more|to\s+that)$/);
    if (addMatch && ctx.lastMarket && ctx.lastSide) {
      return {
        action: ActionType.AddCollateral,
        market: ctx.lastMarket,
        side: ctx.lastSide,
        amount: parseFloat(addMatch[1]),
      };
    }

    if (/^(?:analyze\s+it|what\s+about\s+it)$/.test(lower) && ctx.lastMarket) {
      return { action: ActionType.Analyze, market: ctx.lastMarket };
    }

    return null;
  }

  async parseIntent(userInput: string): Promise<ParsedIntent> {
    const result = localParse(userInput);
    if (result) {
      // Validate parameters
      const alert = validateIntent(result);
      if (alert) {
        return { action: ActionType.Help, _alert: alert } as ParsedIntent;
      }
      this.updateContext(result);
      return result;
    }

    const contextResult = this.tryContextualParse(userInput);
    if (contextResult) {
      const alert = validateIntent(contextResult);
      if (alert) {
        return { action: ActionType.Help, _alert: alert } as ParsedIntent;
      }
      this.updateContext(contextResult);
      return contextResult;
    }

    // Check for malformed known commands
    const malformed = detectMalformedCommand(userInput);
    if (malformed) {
      return { action: ActionType.Help, _alert: malformed } as ParsedIntent;
    }

    getLogger().warn('AI', 'Could not parse locally. Set an AI API key for AI-powered parsing.');
    return { action: ActionType.Help };
  }
}
