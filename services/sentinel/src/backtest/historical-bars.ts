/**
 * Coverage analysis for a replayed window — pure, so every claim it makes can
 * be asserted without a database.
 *
 * ## Why this exists at all
 *
 * A backtest whose window is half-covered is not a shorter backtest, it is a
 * different one, and the difference is invisible in the result: nine sessions
 * of a twenty-session request produce a perfectly plausible equity curve.
 * `CLAUDE.md` and this repo's own market-data provider already settled the
 * governing rule — no fabricated bars, ever, and say what is actually missing
 * rather than composing a plausible-sounding diagnosis. So the engine reports
 * coverage as a first-class part of the result and the UI renders it next to
 * the numbers, instead of an absent session silently becoming a flat day.
 *
 * Two different holes, deliberately reported separately:
 *
 *   · a MISSING SESSION is a trading date inside the window with no bars at
 *     all — usually the backfill simply does not reach that far;
 *   · an INTRA-SESSION GAP is a hole between two bars of the same session —
 *     a feed dropout, and a much stronger reason to distrust a result, because
 *     a strategy's stop could have been hit inside it.
 */

import { isTradingDay, istDateKey } from '../market-clock';
import type { ReplayCoverage } from './replay-contract';

/** Minutes per bar, for the timeframes `Candle.timeframe` can hold. */
export const TIMEFRAME_MINUTES: Record<string, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '1d': 1440,
};

/** The bar shape this module reasons about — a `Candle` row, narrowed. */
export interface StoredBar {
  bucketStart: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openInterest: number | null;
  source: string;
  createdAt: Date;
}

/**
 * How many bars a strategy needs before its indicators mean anything.
 *
 * `composeSnapshot` computes EMA(50) and a 20-bar swing window, so a detection
 * on bar 10 is a detection against an EMA that has seen ten values. Arming
 * before this point does not produce "more data", it produces noise that is
 * indistinguishable from signal in the result. Fifty is the slowest series the
 * snapshot builds; the extra ten give the swing/volume windows a full look-back.
 */
export const WARMUP_BARS = 60;

/**
 * Every IST trading date whose SESSION OPEN falls inside [from, to].
 *
 * The session open, not midnight, is the test that matters. IST is UTC+5:30, so
 * a request ending at 2026-05-10T23:59Z reaches 05:29 IST on 05-11 — and naming
 * 05-11 as a missing session because of that would report a hole in a day the
 * caller never asked about and the exchange never opened during. Keying on
 * 09:15 IST asks the only question coverage cares about: could this window have
 * contained that session's bars at all?
 *
 * Bounded so a mis-typed century cannot walk forever. The caller refuses an
 * over-wide window before this is reached; the guard here is the second line of
 * that defence rather than the only one.
 */
export function tradingDatesBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  if (!(from.getTime() <= to.getTime())) return out;
  const DAY = 86_400_000;
  const days = Math.floor((to.getTime() - from.getTime()) / DAY) + 3;
  if (days > 4_000) return out;

  const seen = new Set<string>();
  // Start a day early: the window may open mid-session, and that session's own
  // IST date is behind `from` in UTC terms.
  for (let i = -1; i < days; i++) {
    const probe = new Date(from.getTime() + i * DAY);
    const key = istDateKey(probe);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isTradingDay(probe)) continue;
    const open = sessionOpenUtc(key);
    if (open.getTime() < from.getTime() || open.getTime() > to.getTime()) continue;
    out.push(key);
  }
  return out.sort();
}

/** 09:15 IST on an IST date key (YYYY-MM-DD), as a UTC instant. */
export function sessionOpenUtc(dateKey: string): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  // 09:15 IST === 03:45 UTC.
  return new Date(Date.UTC(y, m - 1, d, 3, 45, 0, 0));
}

/**
 * Describe what a window actually contained.
 *
 * `bars` must be ascending by `bucketStart`; the loader orders them that way and
 * the replay depends on it, so this asserts rather than sorts — silently
 * re-sorting would hide a loader bug that would otherwise show up here.
 */
export function analyseCoverage(
  bars: StoredBar[],
  timeframe: string,
  requestedFrom: Date,
  requestedTo: Date,
): ReplayCoverage {
  const base: ReplayCoverage = {
    requestedFrom: requestedFrom.toISOString(),
    requestedTo: requestedTo.toISOString(),
    firstBarAt: null,
    lastBarAt: null,
    barCount: 0,
    sessionCount: 0,
    source: null,
    dataVersion: null,
    missingSessions: [],
    intraSessionGaps: [],
    empty: true,
  };
  if (!bars.length) {
    base.missingSessions = tradingDatesBetween(requestedFrom, requestedTo);
    return base;
  }

  for (let i = 1; i < bars.length; i++) {
    if (bars[i].bucketStart.getTime() < bars[i - 1].bucketStart.getTime()) {
      throw new Error('analyseCoverage received unordered bars — the loader must return them ascending.');
    }
  }

  const sessions = new Set<string>();
  for (const b of bars) sessions.add(istDateKey(b.bucketStart));

  const sources = Array.from(new Set(bars.map((b) => b.source))).sort();
  const newestWrite = bars.reduce((max, b) => (b.createdAt > max ? b.createdAt : max), bars[0].createdAt);

  // Only sessions the window asked for AND that are trading days count as
  // missing. A weekend is not a hole, and neither is a date outside the request.
  const expected = tradingDatesBetween(requestedFrom, requestedTo);
  const missing = expected.filter((d) => !sessions.has(d));

  return {
    ...base,
    firstBarAt: bars[0].bucketStart.toISOString(),
    lastBarAt: bars[bars.length - 1].bucketStart.toISOString(),
    barCount: bars.length,
    sessionCount: sessions.size,
    source: sources.join(','),
    // The count is part of the identity on purpose: a repair migration that
    // rewrites timestamps without inserting anything still moves `createdAt`,
    // but a pure insert into an untouched window moves only the count.
    dataVersion: `${newestWrite.toISOString()}:${bars.length}`,
    missingSessions: missing,
    intraSessionGaps: findIntraSessionGaps(bars, timeframe),
    empty: false,
  };
}

/**
 * Holes between consecutive bars of the SAME IST session.
 *
 * A gap across a session boundary is not a hole — it is the overnight break, and
 * counting it would report every backtest as riddled with missing data. Only
 * same-date neighbours are compared.
 */
export function findIntraSessionGaps(
  bars: StoredBar[],
  timeframe: string,
): { after: string; before: string; missingBars: number }[] {
  const stepMs = (TIMEFRAME_MINUTES[timeframe] ?? 0) * 60_000;
  if (!stepMs || stepMs >= 86_400_000) return [];

  const gaps: { after: string; before: string; missingBars: number }[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const cur = bars[i];
    if (istDateKey(prev.bucketStart) !== istDateKey(cur.bucketStart)) continue;
    const delta = cur.bucketStart.getTime() - prev.bucketStart.getTime();
    const missing = Math.round(delta / stepMs) - 1;
    if (missing > 0) {
      gaps.push({
        after: prev.bucketStart.toISOString(),
        before: cur.bucketStart.toISOString(),
        missingBars: missing,
      });
    }
  }
  return gaps;
}
