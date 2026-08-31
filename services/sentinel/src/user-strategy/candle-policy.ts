/**
 * The canonical candle policy for autonomous strategy evaluation.
 *
 * Two rules, and the whole autonomous path depends on both:
 *
 *   1. EVALUATE ONLY CLOSED BARS. A 5-minute bar that is two minutes old has
 *      less range and less volume than it will have at minute five, so a rule
 *      gated on range or volume gives a different answer depending on where in
 *      the window the poll landed. `services/sentinel-py` drops the forming bar
 *      explicitly (`closed_candles` is `candles[:-1]`, docstring: "the bridge
 *      returns the in-progress bar as the final element during market hours").
 *      Nothing on the TypeScript side did, which is a pre-existing defect in
 *      the agents already running and a correctness requirement here.
 *
 *   2. EVALUATE EACH CLOSED BAR AT MOST ONCE. The agent polls far faster than
 *      a bar closes, so without this a satisfied condition would re-fire on
 *      every poll for the rest of the bar. This is the primary defence against
 *      duplicate entries, and — because the marker is persisted — it is also
 *      what makes restart recovery deterministic.
 *
 * ## Why the drop is conditional rather than an unconditional `slice(0, -1)`
 *
 * Python can slice unconditionally because its poller only ever runs live. The
 * TypeScript snapshot is also built after hours, on holidays, and over stored
 * history for replay, where the newest bar is genuinely closed and dropping it
 * would silently discard the most recent real data — the opposite failure, and
 * a harder one to notice. So the decision is made from the bar's own coverage
 * window against the clock, not from its position in the array.
 */
import type { Candle, CandleInterval } from '@tradew/types';

/** Milliseconds one bar of each interval covers. */
const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

/** Intervals a user strategy may declare. Anything else is refused, not coerced. */
export const SUPPORTED_INTERVALS: readonly CandleInterval[] = ['1m', '5m', '15m', '1h'] as const;

export function intervalMs(interval: CandleInterval): number {
  return INTERVAL_MS[interval];
}

/**
 * Resolve a strategy's declared timeframe into a supported interval.
 *
 * Returns null rather than a default. A strategy whose timeframe cannot be
 * honoured must be refused, never quietly run on a different clock — that is
 * the whole reason this function exists rather than a `?? '15m'` at the call
 * site.
 */
export function resolveInterval(timeframe: string | null | undefined): CandleInterval | null {
  if (!timeframe) return null;
  const normalised = timeframe.trim().toLowerCase();
  return (SUPPORTED_INTERVALS as readonly string[]).includes(normalised)
    ? (normalised as CandleInterval)
    : null;
}

/**
 * True when `candle` is still being built at time `now`.
 *
 * A bar stamped T covers [T, T + interval). It is closed once `now` has
 * reached the end of that window. A bar stamped in the future — clock skew, a
 * provider using close-stamped bars — is treated as forming, because the safe
 * failure is to wait one more poll rather than to trade a partial bar.
 */
export function isForming(candle: Candle, interval: CandleInterval, now: Date): boolean {
  const opensAt = candle.timestamp.getTime();
  const closesAt = opensAt + intervalMs(interval);
  return now.getTime() < closesAt;
}

/**
 * The candles safe to evaluate: everything up to and including the newest bar
 * that has finished forming.
 *
 * Only the trailing bar is ever in question — the bridge appends the forming
 * bar at the end — but the check walks back from the tail rather than assuming
 * exactly one, so a provider that returns two unfinished bars cannot slip one
 * through.
 */
export function closedCandles(candles: Candle[], interval: CandleInterval, now: Date): Candle[] {
  let end = candles.length;
  while (end > 0 && isForming(candles[end - 1], interval, now)) end -= 1;
  return end === candles.length ? candles : candles.slice(0, end);
}

/** The bar an evaluation is *about*: the newest closed one. */
export function newestClosedBar(
  candles: Candle[],
  interval: CandleInterval,
  now: Date,
): Candle | null {
  const closed = closedCandles(candles, interval, now);
  return closed.length ? closed[closed.length - 1] : null;
}

export type BarGateReason =
  | 'no-candles'
  | 'no-closed-bar'
  | 'insufficient-history'
  | 'already-evaluated'
  | 'stale-bar';

export interface BarGateResult {
  /** True only when this is a NEW closed bar with enough history behind it. */
  eligible: boolean;
  reason: BarGateReason | null;
  /** The bar the evaluation would be about. */
  bar: Candle | null;
  /** The closed series to evaluate against. */
  candles: Candle[];
  /** Human-readable statement of the gate's decision. */
  detail: string;
}

export interface BarGateInput {
  candles: Candle[];
  interval: CandleInterval;
  now: Date;
  /**
   * Timestamp of the newest bar this strategy has already been evaluated on,
   * persisted across restarts. Null on the first ever evaluation.
   */
  lastEvaluatedBarTime: Date | null;
  /** Minimum closed bars the strategy's own conditions need. */
  minBars: number;
  /**
   * How far behind `now` the newest closed bar may be before the data is
   * treated as stale. Defaults to three bars, which tolerates one missed poll
   * and a provider hiccup without tolerating a dead feed.
   */
  maxBarAgeMs?: number;
}

/**
 * The single gate that decides whether an evaluation may run at all.
 *
 * Refuses rather than guesses in every branch. In particular `stale-bar` is a
 * refusal and not a warning: acting on the last bar a dead feed produced is
 * how an agent trades a market that has moved on without it.
 */
export function gateBar(input: BarGateInput): BarGateResult {
  const { candles, interval, now, lastEvaluatedBarTime, minBars } = input;
  const maxBarAgeMs = input.maxBarAgeMs ?? intervalMs(interval) * 3;

  if (candles.length === 0) {
    return { eligible: false, reason: 'no-candles', bar: null, candles: [], detail: 'No candles were returned for this instrument.' };
  }

  const closed = closedCandles(candles, interval, now);
  if (closed.length === 0) {
    return {
      eligible: false,
      reason: 'no-closed-bar',
      bar: null,
      candles: [],
      detail: `No ${interval} bar has finished forming yet.`,
    };
  }

  const bar = closed[closed.length - 1];

  if (closed.length < minBars) {
    return {
      eligible: false,
      reason: 'insufficient-history',
      bar,
      candles: closed,
      detail: `Only ${closed.length} closed ${interval} bars available; this strategy needs ${minBars}.`,
    };
  }

  // Staleness is measured from the END of the bar's window, not its start —
  // a 5m bar stamped 10:00 is not 6 minutes stale at 10:06, it closed at 10:05.
  const barClosedAt = bar.timestamp.getTime() + intervalMs(interval);
  const ageMs = now.getTime() - barClosedAt;
  if (ageMs > maxBarAgeMs) {
    return {
      eligible: false,
      reason: 'stale-bar',
      bar,
      candles: closed,
      detail: `The newest closed ${interval} bar is ${Math.round(ageMs / 1000)}s old, past the ${Math.round(maxBarAgeMs / 1000)}s limit.`,
    };
  }

  if (lastEvaluatedBarTime !== null && bar.timestamp.getTime() <= lastEvaluatedBarTime.getTime()) {
    return {
      eligible: false,
      reason: 'already-evaluated',
      bar,
      candles: closed,
      detail: `Bar ${bar.timestamp.toISOString()} has already been evaluated.`,
    };
  }

  return {
    eligible: true,
    reason: null,
    bar,
    candles: closed,
    detail: `Evaluating the ${interval} bar that closed at ${new Date(barClosedAt).toISOString()}.`,
  };
}
