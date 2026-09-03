/**
 * Is the data this decision would be made on good enough to decide on?
 *
 * ## The gap this closes
 *
 * `CandleMarketDataProvider` refuses to *invent* data — it raises rather than
 * simulate, and that is the right rule. But refusing to invent is not the same
 * as refusing to be stale. Its second tier reads the persisted `Candle` table
 * for any row inside the snapshot's five-day window, so a live-bridge outage
 * degrades silently from "live bars" to "bars from Tuesday" with nothing in
 * the response saying which one happened. Every indicator downstream computes
 * happily on Tuesday's bars and produces a confident-looking read of a market
 * that has since moved.
 *
 * That is tolerable for a trader looking at a workspace — they can see the
 * chart. It is not tolerable for an agent that will place an order on it, so
 * this module states, in the response, how old the newest bar actually is and
 * refuses when it is older than the caller allows.
 *
 * ## Pure, like every other gate in this feature
 *
 * `execution-policy.ts` and `execution-account.ts` are both dependency-free
 * deciders that a caller gathers facts for. This is the third, and it is
 * evaluated on the SENTINEL side rather than the API side because only
 * Sentinel knows what it actually read — the API sees a verdict, not a bar.
 *
 * The complementary check on the API side is quote freshness
 * (`execution-freshness.ts`): the bar tells you how current the ANALYSIS is,
 * the quote tells you how current the PRICE is, and they fail independently.
 * A live bridge with a dead Dhan credential serves a fresh-looking quote map
 * that has not ticked in an hour, which no candle check would notice.
 */

export interface DataQualityCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface DataQualityRead {
  ok: boolean;
  checks: DataQualityCheck[];
  /** Bars the snapshot's indicators were computed from. */
  candles: number;
  /** Newest bar in the snapshot, ISO. Null when there were no bars at all. */
  newestBarAt: string | null;
  /** Age of that bar in whole minutes at `now`. Null when there was no bar. */
  barAgeMinutes: number | null;
  spot: number | null;
  optionChainStrikes: number;
  /** The first failing check's id, or null. Groupable, like `rejectCheckId`. */
  failedCheckId: string | null;
  /** The first failing check's detail, or null. */
  reason: string | null;
}

export interface DataQualityInput {
  now: Date;
  /** Bars in the snapshot. */
  candles: number;
  newestBarAt: Date | null;
  /** Underlying spot the decision would be located against. */
  spot: number | null;
  /** Strikes in the front-expiry chain. 0 when no chain was published. */
  optionChainStrikes: number;

  /** ---- Floors, supplied by the caller (the profile's own columns). ---- */
  minCandles: number;
  maxBarAgeMinutes: number;
  /** When false, a missing option chain is reported but does not fail. */
  requireOptionChain: boolean;
}

/**
 * Why the default bar-age allowance is generous.
 *
 * The engine reads 15-minute bars, and a bar is stamped with its bucket START.
 * So the newest bar of a perfectly healthy live feed is, at the moment just
 * before the next one closes, already ~15 minutes old by that stamp — and a
 * feed that has just missed one print is ~30. Anything tighter than 30 would
 * reject a healthy market for being 15-minute-bar-shaped, which is the failure
 * mode that teaches an operator to raise the limit until it stops meaning
 * anything.
 */
export const DEFAULT_MAX_BAR_AGE_MINUTES = 30;

/**
 * Why 40 bars.
 *
 * `composeSnapshot` computes a 50-period EMA and a 26-bar VWAP window, and
 * `ema()` returns a series from whatever it is given rather than refusing —
 * so a 12-bar history yields an `ema50` that is arithmetically real and
 * economically meaningless. 40 is below 50 deliberately: EMA converges well
 * before its nominal period, and demanding 50 would idle the agent through the
 * first two hours of every session for a number that is already stable. It IS
 * above the 26-bar VWAP window and above the 20-bar volume average, so every
 * other input is fully formed.
 */
export const DEFAULT_MIN_CANDLES = 40;

export function assessDataQuality(input: DataQualityInput): DataQualityRead {
  const checks: DataQualityCheck[] = [];
  const push = (id: string, label: string, passed: boolean, detail: string) =>
    checks.push({ id, label, passed, detail });

  const barAgeMinutes =
    input.newestBarAt != null
      ? Math.max(0, Math.floor((input.now.getTime() - input.newestBarAt.getTime()) / 60_000))
      : null;

  const enoughHistory = input.candles >= input.minCandles;
  push(
    'candle-history',
    'Sufficient candle history',
    enoughHistory,
    enoughHistory
      ? `${input.candles} bars, at or above the ${input.minCandles}-bar floor.`
      : `Only ${input.candles} bars against a ${input.minCandles}-bar floor — the indicators are not yet fully formed.`,
  );

  // A snapshot with no bars at all is a distinct failure from a stale one, and
  // collapsing them would report "0 minutes old" for the emptier of the two.
  if (input.newestBarAt == null) {
    push('bar-freshness', 'Market data is current', false, 'The snapshot carried no bars, so there is no market time to check.');
  } else {
    const fresh = (barAgeMinutes ?? Number.MAX_SAFE_INTEGER) <= input.maxBarAgeMinutes;
    push(
      'bar-freshness',
      'Market data is current',
      fresh,
      fresh
        ? `Newest bar is ${barAgeMinutes} min old, inside the ${input.maxBarAgeMinutes} min allowance.`
        : `Newest bar is ${barAgeMinutes} min old, past the ${input.maxBarAgeMinutes} min allowance — this is stored history, not a live read.`,
    );
  }

  const spotOk = input.spot != null && Number.isFinite(input.spot) && input.spot > 0;
  push(
    'index-spot',
    'Index price available',
    spotOk,
    spotOk
      ? `Underlying at ${input.spot!.toFixed(2)}.`
      : 'No underlying spot price, so no strike can be located and no direction measured.',
  );

  const chainOk = input.optionChainStrikes > 0;
  push(
    'option-chain',
    'Option chain published',
    input.requireOptionChain ? chainOk : true,
    chainOk
      ? `${input.optionChainStrikes} front-expiry strikes read.`
      : input.requireOptionChain
        ? 'No option chain was published, so no contract can be priced.'
        : 'No option chain was published; not required for this read.',
  );

  const failed = checks.find((c) => !c.passed) ?? null;
  return {
    ok: !failed,
    checks,
    candles: input.candles,
    newestBarAt: input.newestBarAt ? input.newestBarAt.toISOString() : null,
    barAgeMinutes,
    spot: input.spot,
    optionChainStrikes: input.optionChainStrikes,
    failedCheckId: failed ? failed.id : null,
    reason: failed ? failed.detail : null,
  };
}
