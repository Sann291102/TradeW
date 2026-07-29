/**
 * IST market clock — one place that knows NSE session boundaries.
 *
 * Sentinel runs on servers that are frequently UTC, so every module that
 * reasons about "late in the session" or renders a timeline stamp must agree
 * on the same India-time conversion. `Intl` does the zone maths, so DST-free
 * IST needs no table and no dependency.
 */

import { SessionPhase } from './domain';

export const MARKET_OPEN_MIN = 9 * 60 + 15; // 09:15 IST
export const MARKET_CLOSE_MIN = 15 * 60 + 30; // 15:30 IST
/** Brokers begin intraday square-off around here; risk rises into it. */
export const SQUARE_OFF_MIN = 14 * 60 + 45; // 14:45 IST

const IST_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const IST_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 'HH:mm' in IST. */
export function istTimeLabel(at: Date = new Date()): string {
  return IST_TIME.format(at);
}

/** 'YYYY-MM-DD' in IST — the session key. */
export function istDateKey(at: Date = new Date()): string {
  return IST_DATE.format(at);
}

/** Minutes since IST midnight. */
export function istMinutesOfDay(at: Date = new Date()): number {
  const [h, m] = istTimeLabel(at).split(':').map(Number);
  return h * 60 + m;
}

/** True when `at` falls inside NSE regular trading hours. */
export function isMarketOpen(at: Date = new Date()): boolean {
  const mins = istMinutesOfDay(at);
  return mins >= MARKET_OPEN_MIN && mins <= MARKET_CLOSE_MIN;
}

/** Minutes remaining until the close; negative once the session has ended. */
export function minutesToClose(at: Date = new Date()): number {
  return MARKET_CLOSE_MIN - istMinutesOfDay(at);
}

/** How far through the session we are, clamped to 0..1. */
export function sessionProgress(at: Date = new Date()): number {
  const mins = istMinutesOfDay(at);
  const span = MARKET_CLOSE_MIN - MARKET_OPEN_MIN;
  return Math.max(0, Math.min(1, (mins - MARKET_OPEN_MIN) / span));
}

export function sessionPhaseAt(at: Date = new Date()): SessionPhase {
  const mins = istMinutesOfDay(at);
  if (mins < MARKET_OPEN_MIN) return 'pre-market';
  if (mins > MARKET_CLOSE_MIN) return 'closed';
  if (mins >= SQUARE_OFF_MIN) return 'closing';
  return 'active';
}

/**
 * Parse an 'HH:mm-HH:mm' IST window and test membership.
 * An unparsable window is treated as "always", so a malformed user strategy
 * config never silently disables the strategy without explanation.
 */
export function isWithinSession(window: string | undefined, at: Date = new Date()): boolean {
  if (!window) return true;
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(window.trim());
  if (!match) return true;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  const now = istMinutesOfDay(at);
  return now >= start && now <= end;
}
