/**
 * The snapshot every strategy rule reads, and the regime types it carries.
 *
 * MOVED here verbatim from `services/sentinel/src/intelligence/*` so that the
 * decision core has no Sentinel dependency. The Sentinel modules now re-export
 * these, so nothing that imported them from the old paths had to change and
 * Sentinel's behaviour is bit-identical.
 *
 * Nothing in this file does I/O or knows about a venue. `MarketSnapshot` is the
 * whole contract between "how the bars were obtained" and "what the strategy
 * decides" — which is exactly what lets one strategy implementation serve a
 * live feed, a backtest replay and Sentinel's analysis without branching.
 */

import type { Candle, OptionChainEntry } from '@tradew/types';


// ---------------------------------------------------------------- Module 1
// Market Intelligence Engine — today's regime and structural profile.

export type MarketProfileType =
  | 'Bullish Trend Day'
  | 'Bearish Trend Day'
  | 'High Volatility Range'
  | 'Low Volatility Compression'
  | 'Gap & Go'
  | 'Gap Fill / Mean Reversion'
  | 'Inside Day'
  | 'Outside Day / Expansion'
  | 'Rally Continuation'
  | 'Descent Continuation';

export interface MarketProfile {
  type: MarketProfileType;
  description: string;
  trend: 'bullish' | 'bearish' | 'neutral' | 'choppy';
  volatility: 'high' | 'low' | 'normal';
  structure: 'trending' | 'ranging' | 'consolidating' | 'breaking-out';
  /** the observations that led to this classification */
  evidence: string[];
}

export interface TrendAnalysis {
  /** session change from the first bar in view, in percent */
  sessionChangePct: number;
  /** 0..1 — how one-directional the recent bars are */
  momentumScore: number;
  /** last bar volume / 20-bar average */
  volumeStrength: number;
  direction: 'bullish' | 'bearish' | 'neutral';
}

export interface OptionChainRead {
  /** total put OI / total call OI */
  pcr: number;
  /** the strike at which option writers lose least, i.e. the pin */
  maxPain: number;
  /** the strike carrying the most call OI above spot */
  callOIWall: number | null;
  /** the strike carrying the most put OI below spot */
  putOIWall: number | null;
  strikesAnalysed: number;
  /**
   * The expiry every entry below belongs to. `readOptionChain` already narrows
   * to the front expiry before computing anything (mixing expiries makes both
   * PCR and max pain meaningless) — this names the one it picked, so a reader
   * never has to infer it from the entries.
   */
  frontExpiry: Date;
  /**
   * The front-expiry strikes themselves, ascending.
   *
   * Exposed because the aggregates above answer "what is positioning doing?"
   * and cannot answer "what does one specific contract cost right now?" — the
   * question strike-candidate evaluation is made of. Carrying them here rather
   * than re-reading the chain keeps the observation on ONE chain read: a second
   * fetch would be a second point in time, so a candidate's premium could
   * disagree with the PCR computed beside it.
   */
  entries: OptionChainEntry[];
}

export interface MarketSnapshot {
  symbol: string;
  /**
   * The most recent traded price — the LIVE one, taken from the forming bar
   * when there is one.
   *
   * Deliberately the one field on this snapshot that reads the in-progress
   * bar. Everything else here is computed from closed bars only (see
   * `splitClosedAndForming`), but `lastPrice` is the spot: it picks the ATM
   * strike, prices a candidate contract and answers the data-quality gate's
   * "is there a usable index price?". A spot that lagged by up to a full
   * 15-minute bar would be a worse number for every one of those, and none of
   * them is a bar measurement.
   */
  lastPrice: number;
  rsi14: number | null;
  ema20: number | null;
  ema50: number | null;
  vwap: number | null;
  macdHistogram: number | null;
  cpr: { pivot: number; bc: number; tc: number } | null;
  volumeVsAvg: number | null; // last volume / 20-period average
  oiTrend: 'rising' | 'falling' | 'flat' | 'unknown';
  realizedVolPct: number | null;
  vix: number | null;
  breadthRatio: number | null; // advances / declines
  support: number | null;
  resistance: number | null;
  /**
   * CLOSED bars only — the bar currently forming is never in here.
   *
   * Every rule in `strategy-rules.ts` reads this array, and a rule that
   * measures the newest bar's range or volume is measuring a finished fact or
   * it is measuring nothing. The bar being dropped is not lost: it is
   * `formingCandle` below, for the few consumers that genuinely want it.
   */
  candles: Candle[];
  /** the bars belonging to the most recent session in `candles` — closed only */
  sessionCandles: Candle[];
  /**
   * The still-forming bar the bridge returned, or null.
   *
   * Null out of hours, on stored history, and in backtest replay — anywhere
   * the trailing bar is genuinely finished. Present only during market hours,
   * which makes it also the honest answer to "is this a live read?".
   *
   * Read it for freshness, for a live price, or to draw a chart. Never to
   * measure a range, a volume or a wick: that is precisely what it cannot yet
   * tell you.
   */
  formingCandle: Candle | null;
  /** the prior completed daily bar, when history reaches back that far */
  priorDay: Candle | null;
  /** Module 1 — today's regime classification */
  marketProfile: MarketProfile | null;
  /** Module 1 — directional read of the current session */
  trendAnalysis: TrendAnalysis | null;
  /** opening range (first 30 minutes of the session), when derivable */
  openingRange: { high: number; low: number; establishedAt: Date } | null;
  /** front-expiry option chain analytics — null when the instrument has no chain */
  optionChain: OptionChainRead | null;
}

/** Normalise a candle timestamp that may have survived a JSON hop. */
function barTime(bar: Candle | null | undefined): Date | null {
  if (!bar) return null;
  // Declared as a Date, but the provider chain includes JSON hops where it
  // arrives as an ISO string or epoch ms. Normalising here keeps every caller
  // from having to know that.
  const at = bar.timestamp instanceof Date ? bar.timestamp : new Date(bar.timestamp);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The bar this snapshot was built on — the market-event time of anything
 * derived from it.
 *
 * Every rule in `strategy-rules.ts` is a pure function of the snapshot, so the
 * newest bar in it IS the moment the market did whatever a detection describes.
 * The scan's own clock is a poll clock and says nothing about the market.
 *
 * Prefers the session's newest bar (what the session narrative is ordered by)
 * and falls back to the newest bar of the wider history, so a pre-market
 * snapshot with no session bars yet still reports the last real bar instead of
 * the wall clock. Returns null only when the snapshot carries no candles at
 * all — the one case where a caller genuinely has nothing but its own clock.
 *
 * CLOSED bars only, because those arrays are closed-only. That is the right
 * reading for its callers: a detection is about the bar that finished, so a
 * setup found at 11:47 is dated to the 11:30 bar it actually formed on rather
 * than to a bar the market has not finished writing. For "how fresh is this
 * data?" — a different question — use `latestDataAt`.
 */
export function latestBarAt(
  snapshot: Pick<MarketSnapshot, 'candles' | 'sessionCandles'>,
): Date | null {
  const session = snapshot.sessionCandles ?? [];
  const history = snapshot.candles ?? [];
  return barTime(session[session.length - 1] ?? history[history.length - 1] ?? null);
}

/**
 * The newest market time in this snapshot, forming bar INCLUDED.
 *
 * The freshness question, as opposed to `latestBarAt`'s market-event question.
 * "Is this a live read or is it stored history?" is answered by the newest
 * data of any kind, and during market hours the newest data is the bar still
 * being written — so measuring staleness against the last CLOSED bar would
 * charge every live observation up to a full bar of age it does not have. At
 * 15m against a 30-minute allowance that is most of the budget spent on
 * nothing, and a late poll would then report a live market as `stale-data`.
 */
export function latestDataAt(
  snapshot: Pick<MarketSnapshot, 'candles' | 'sessionCandles' | 'formingCandle'>,
): Date | null {
  return barTime(snapshot.formingCandle) ?? latestBarAt(snapshot);
}

/**
 * The snapshot's bars with the forming one put back on the end.
 *
 * For the two consumers that want the market as it looks RIGHT NOW rather than
 * as it has finished happening: drawing a chart, and comparing the index
 * series against the CE/PE legs (which are read raw and therefore carry their
 * own forming bars — dropping it from only one of the three would compare
 * different amounts of time and call the difference divergence).
 */
export function liveCandles(
  snapshot: Pick<MarketSnapshot, 'candles' | 'formingCandle'>,
): Candle[] {
  const bars = snapshot.candles ?? [];
  return snapshot.formingCandle ? [...bars, snapshot.formingCandle] : bars;
}
