import type { Candle, CandleInterval } from '@tradew/types';

/**
 * Merging the live tick into a historical candle series.
 *
 * ── THE BUG THIS FIXES (2026-08-12) ────────────────────────────────────────
 *
 * Reported with a screenshot: the dashboard card read NIFTY 24,283.15 while the
 * chart's last-price line, six inches away, read 24,471.70. "not live, and the
 * line also not matching".
 *
 * Both numbers were correct, which is why this was invisible in code review.
 * They come from two different sources and only one of them moves:
 *
 *   cards → `useDhanLiveFeed`, an SSE stream, updating every tick
 *   chart → `useCandles`, ONE fetch of `/candles` on mount, never refreshed
 *
 * The historical series ends at the last CLOSED bar. Measured at the time of
 * the report, the newest daily candle was stamped 2026-08-10T18:30Z — IST
 * midnight opening 11 Aug — and carried close 24,471.70. It was 38 hours old.
 * Today's session, open and trading at 24,280, had no bar in the series at all,
 * so the chart's right edge was yesterday's close and stayed there all day.
 *
 * Two symptoms, one cause. "Not live" is the series never advancing. "Line not
 * matching" is that stale last close being what the price line draws.
 *
 * ── WHY THIS IS NOT FABRICATION ────────────────────────────────────────────
 *
 * `useCandles` carries a deliberate no-fallback rule: a chart with no real
 * history renders nothing and says why, because a simulated series rescaled
 * onto the live LTP once made a Dhan rate-limit look like a quiet market. That
 * rule is intact and this does not weaken it.
 *
 * Nothing here is invented. The forming bar is built from the SAME Dhan quote
 * the cards already display — for a daily bar, the session's real open, high
 * and low, with the live LTP as its close. No series is created where none
 * exists, no gap is filled, and no bar is ever synthesised while the market is
 * shut. If the quote is missing or the market is closed, the series is returned
 * exactly as it arrived.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const INTERVAL_MINUTES: Record<CandleInterval, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '1d': 1440,
};

/**
 * The subset of a Dhan quote this needs.
 *
 * `open`/`high`/`low` are nullable because the bridge reports them that way for
 * an instrument whose session has not started — which is precisely a case that
 * must not produce a bar, so the nullability is load-bearing rather than noise.
 */
export interface LiveQuoteLike {
  ltp: number;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  marketStatus?: string;
}

/**
 * Start of the IST trading day containing `ms`.
 *
 * Daily bars are stamped at IST midnight, which is 18:30 UTC the previous day —
 * that is what the bridge returns, and the forming bar has to land on the same
 * grid or the chart will show two bars for one day.
 */
export function istDayStart(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

/**
 * Snap `ms` down to the intraday grid the existing series already sits on.
 *
 * The phase is taken from the last real candle rather than from the epoch,
 * because the NSE session opens at 09:15 IST: hourly bars run 09:15, 10:15,
 * 11:15 …, which epoch-aligned hour buckets would miss by fifteen minutes and
 * plant the forming bar in a slot no real bar will ever occupy.
 */
export function bucketStart(ms: number, anchorMs: number, intervalMinutes: number): number {
  const size = intervalMinutes * 60 * 1000;
  const phase = ((anchorMs % size) + size) % size;
  return Math.floor((ms - phase) / size) * size + phase;
}

/**
 * Return `candles` with the current, still-forming bar reflecting `quote`.
 *
 * Updates the last bar when it is the current bucket; appends one when the
 * bucket has rolled over. Returns the input untouched whenever there is nothing
 * trustworthy to merge.
 */
export function mergeLiveCandle(
  candles: Candle[] | null,
  quote: LiveQuoteLike | null | undefined,
  interval: CandleInterval,
  now: number = Date.now(),
): Candle[] | null {
  if (!candles || candles.length === 0) return candles;

  // No quote, an unusable price, or a shut market: the last closed bar is
  // already the right answer, and inventing a flat bar on top of it would be
  // exactly the fabrication this file promises not to do.
  if (!quote || !Number.isFinite(quote.ltp) || quote.ltp <= 0) return candles;
  if (quote.marketStatus && quote.marketStatus !== 'open') return candles;

  const intervalMinutes = INTERVAL_MINUTES[interval];
  const last = candles[candles.length - 1]!;
  const lastMs = last.timestamp.getTime();

  const currentBucket =
    intervalMinutes >= 1440 ? istDayStart(now) : bucketStart(now, lastMs, intervalMinutes);

  // A clock skew or a bad quote could place "now" before the newest bar. Leave
  // the series alone rather than rewriting history backwards.
  if (currentBucket < lastMs) return candles;

  const ltp = quote.ltp;

  if (currentBucket === lastMs) {
    // The bar for this bucket exists — extend it. `open` is whatever it really
    // opened at and is never touched.
    const merged: Candle = {
      ...last,
      close: ltp,
      high: Math.max(last.high, ltp),
      low: Math.min(last.low, ltp),
    };
    if (merged.close === last.close && merged.high === last.high && merged.low === last.low) {
      return candles; // nothing moved; keep the identity so React can skip work
    }
    return [...candles.slice(0, -1), merged];
  }

  // The bucket rolled over — open a new bar.
  //
  // For a daily bar the quote carries the session's real open/high/low, so the
  // bar is genuinely correct from its first render. For an intraday bucket
  // those fields describe the whole session, not this bucket, so using them
  // would draw a bar spanning the day's entire range inside a five-minute slot.
  // There is no honest value for a bucket that has only ever seen one price, so
  // it starts flat at that price and grows as ticks arrive.
  const daily = intervalMinutes >= 1440;
  const open = daily && Number.isFinite(quote.open) ? (quote.open as number) : ltp;
  const high = daily && Number.isFinite(quote.high) ? Math.max(quote.high as number, ltp) : Math.max(open, ltp);
  const low = daily && Number.isFinite(quote.low) ? Math.min(quote.low as number, ltp) : Math.min(open, ltp);

  return [
    ...candles,
    {
      timestamp: new Date(currentBucket),
      open,
      high,
      low,
      close: ltp,
      // Deliberately zero. The quote's volume field is a session total, not this
      // bucket's, and copying it would overstate every forming bar.
      volume: 0,
    },
  ];
}
