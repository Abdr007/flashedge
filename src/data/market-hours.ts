import { POOL_MARKETS } from '../config/index.js';

// ─── Virtual Market Configuration ─────────────────────────────────────────────
// Virtual pools contain real-world commodities and FX pairs that follow
// traditional market trading sessions and are NOT available 24/7.

const VIRTUAL_POOLS = ['Virtual.1'] as const;

// Pre-compute the set of virtual market symbols for O(1) lookup
const VIRTUAL_MARKETS: ReadonlySet<string> = new Set(
  VIRTUAL_POOLS.flatMap((pool) => (POOL_MARKETS[pool] ?? []).map((s) => s.toUpperCase())),
);

/**
 * Check if a market belongs to a Virtual pool (commodity/FX).
 * Virtual markets follow real-world trading sessions and may be closed.
 */
export function isVirtualMarket(symbol: string): boolean {
  return VIRTUAL_MARKETS.has(symbol.toUpperCase());
}

/**
 * Get the pool name for a virtual market, or null if it's not virtual.
 */
export function getVirtualPool(symbol: string): string | null {
  const upper = symbol.toUpperCase();
  for (const pool of VIRTUAL_POOLS) {
    const markets = POOL_MARKETS[pool];
    if (markets && markets.some((m) => m.toUpperCase() === upper)) {
      return pool;
    }
  }
  return null;
}

// ─── Trading Session Schedule ─────────────────────────────────────────────────
// Commodity and FX markets generally follow these hours (approximate):
//
//  Metals (XAU, XAG):
//    Sunday 17:00 CT – Friday 16:00 CT (with daily break 16:00–17:00 CT Mon–Thu)
//
//  Crude Oil (CRUDEOIL):
//    Sunday 17:00 CT – Friday 16:00 CT (with daily break 16:00–17:00 CT Mon–Thu)
//
//  FX (EUR, GBP, USDJPY, USDCNH):
//    Sunday 17:00 ET – Friday 17:00 ET (nearly 24/5)
//
// The Flash Trade protocol enforces market hours on-chain via oracle staleness.
// When the oracle price is too stale (market closed), the program rejects with
// Custom error 3012. We check schedules client-side for a better UX.
//
// All times are approximate. The on-chain check is authoritative.

/** Day-of-week: 0=Sunday, 1=Monday, ..., 6=Saturday */
type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

interface TradingSchedule {
  /** Label for display */
  label: string;
  /** Check if the market is open at the given UTC time */
  isOpen: (utcHour: number, utcMinute: number, dayOfWeek: DayOfWeek) => boolean;
}

/**
 * Commodity schedule: Sunday 22:00 UTC – Friday 21:00 UTC
 * Daily maintenance break: 21:00–22:00 UTC (Mon–Thu)
 * Closed all day Saturday and most of Sunday (opens Sunday 22:00 UTC)
 */
const COMMODITY_SCHEDULE: TradingSchedule = {
  label: 'Sun 22:00 – Fri 21:00 UTC (break 21:00–22:00 daily)',
  isOpen(utcHour: number, _utcMinute: number, day: DayOfWeek): boolean {
    // Saturday: always closed
    if (day === 6) return false;
    // Sunday: open only from 22:00 UTC onward
    if (day === 0) return utcHour >= 22;
    // Friday: open until 21:00 UTC
    if (day === 5) return utcHour < 21;
    // Monday–Thursday: open except 21:00–21:59 (maintenance break)
    return utcHour !== 21;
  },
};

/**
 * FX schedule: Sunday 22:00 UTC – Friday 22:00 UTC
 * Nearly 24/5, closed Saturday and most of Sunday.
 */
const FX_SCHEDULE: TradingSchedule = {
  label: 'Sun 22:00 – Fri 22:00 UTC (24/5)',
  isOpen(utcHour: number, _utcMinute: number, day: DayOfWeek): boolean {
    // Saturday: always closed
    if (day === 6) return false;
    // Sunday: open only from 22:00 UTC onward
    if (day === 0) return utcHour >= 22;
    // Friday: open until 22:00 UTC
    if (day === 5) return utcHour < 22;
    // Monday–Thursday: always open
    return true;
  },
};

/** Map each virtual market to its schedule */
const MARKET_SCHEDULES: Record<string, TradingSchedule> = {
  XAU: COMMODITY_SCHEDULE,
  XAG: COMMODITY_SCHEDULE,
  CRUDEOIL: COMMODITY_SCHEDULE,
  EUR: FX_SCHEDULE,
  GBP: FX_SCHEDULE,
  USDJPY: FX_SCHEDULE,
  USDCNH: FX_SCHEDULE,
};

export interface MarketStatus {
  isOpen: boolean;
  isVirtual: boolean;
  schedule: string | null;
}

/**
 * Check whether a market is currently open for trading.
 *
 * - Crypto markets: always open (24/7).
 * - Virtual markets: checked against their real-world trading schedule.
 *
 * Note: this is an approximate client-side check for user experience.
 * The on-chain program is the authoritative source — it will reject
 * transactions with Custom 3012 if the oracle price is too stale.
 */
export function getMarketStatus(symbol: string): MarketStatus {
  const upper = symbol.toUpperCase();

  if (!isVirtualMarket(upper)) {
    return { isOpen: true, isVirtual: false, schedule: null };
  }

  const schedule = MARKET_SCHEDULES[upper];
  if (!schedule) {
    // Virtual market without a known schedule — assume open, let on-chain check decide
    return { isOpen: true, isVirtual: true, schedule: null };
  }

  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const dayOfWeek = now.getUTCDay() as DayOfWeek;

  return {
    isOpen: schedule.isOpen(utcHour, utcMinute, dayOfWeek),
    isVirtual: true,
    schedule: schedule.label,
  };
}

/**
 * Compute the next UTC time this market's session will open.
 * Returns a Date, or null if the market is already open or has no schedule.
 */
export function getNextSessionOpen(symbol: string): Date | null {
  const upper = symbol.toUpperCase();
  const schedule = MARKET_SCHEDULES[upper];
  if (!schedule) return null;

  const now = new Date();
  // Scan forward minute-by-minute up to 7 days to find the next open slot
  const probe = new Date(now.getTime());
  // Jump to next full hour for efficiency
  probe.setUTCMinutes(0, 0, 0);
  if (probe.getTime() <= now.getTime()) {
    probe.setTime(probe.getTime() + 3_600_000);
  }
  for (let i = 0; i < 7 * 24; i++) {
    const h = probe.getUTCHours();
    const m = probe.getUTCMinutes();
    const d = probe.getUTCDay() as DayOfWeek;
    if (schedule.isOpen(h, m, d)) {
      return probe;
    }
    probe.setTime(probe.getTime() + 3_600_000); // +1 hour
  }
  return null;
}

/**
 * Get detailed schedule info for display purposes.
 */
export function getScheduleDetails(symbol: string): {
  sessionHours: string;
  dailyBreak: string | null;
  type: 'commodity' | 'fx' | null;
} | null {
  const upper = symbol.toUpperCase();
  const schedule = MARKET_SCHEDULES[upper];
  if (!schedule) return null;

  const isCommodity = ['XAU', 'XAG', 'CRUDEOIL'].includes(upper);
  if (isCommodity) {
    return {
      sessionHours: 'Sun 22:00 UTC → Fri 21:00 UTC',
      dailyBreak: '21:00 → 22:00 UTC',
      type: 'commodity',
    };
  }
  return {
    sessionHours: 'Sun 22:00 UTC → Fri 22:00 UTC',
    dailyBreak: null,
    type: 'fx',
  };
}

/**
 * Format a human-readable "market closed" message for display.
 */
export function formatMarketClosedMessage(symbol: string): string {
  const upper = symbol.toUpperCase();
  const schedule = MARKET_SCHEDULES[upper];
  const lines = [
    '',
    `  ${upper} market is currently CLOSED.`,
    '',
    '  Virtual markets follow real-world trading sessions.',
    '  Trading is temporarily unavailable.',
  ];
  if (schedule) {
    lines.push('');
    lines.push(`  Trading hours: ${schedule.label}`);
  }
  const nextOpen = getNextSessionOpen(upper);
  if (nextOpen) {
    lines.push('');
    lines.push(`  Next session opens at: ${nextOpen.toUTCString()}`);
  }
  lines.push('');
  lines.push('  Please try again when the market reopens.');
  lines.push('');
  return lines.join('\n');
}
