/**
 * The bucket a Dhan bar belongs to.
 *
 * ── WHY THIS IS NOT `new Date(timestamp * 1000)` ───────────────────────────
 * Because a daily bar is not an instant. It is a calendar day, and Dhan stamps
 * it at IST midnight — so the naive conversion produces 18:30 UTC on the
 * PREVIOUS day. Tuesday's session gets filed under Monday, Monday's under
 * Sunday, and the table acquires trading sessions on days the exchange is shut.
 *
 * That is not hypothetical. Measured 2026-08-19, before this existed:
 *   * 13 distinct "Sunday" daily sessions in `Candle`;
 *   * all 61 of RELIANCE's and COALINDIA's Dhan daily bars sitting exactly
 *     5h30m before the `nse-bhavcopy` bar for the same session, with
 *     byte-identical open, high, low, close and volume — 0 rows disagreed;
 *   * RELIANCE therefore reporting 205 distinct daily buckets across its
 *     52-week window where only 144 real sessions existed.
 *
 * The unique index on (instrumentId, timeframe, bucketStart) cannot catch it:
 * the two rows differ in bucketStart, so both are accepted. Prices stayed
 * correct — the duplicate carries the same values — but every per-session count
 * and average silently covered half the days it claimed.
 *
 * INTRADAY bars are genuine instants and pass through untouched. Only the daily
 * timeframe is a calendar bucket, and it is normalised to UTC midnight of the
 * IST session date, which is the convention the NSE bhavcopy ingest writes. One
 * column, one meaning.
 *
 * Pure and dependency-free so it is testable without a network or a database.
 */

const IST_OFFSET_SECONDS = 5.5 * 3600;

export function dhanBucketStart(epochSeconds: number, isDaily: boolean): Date {
  if (!isDaily) return new Date(epochSeconds * 1000);

  // Shift into IST to read the session's calendar date off the clock, then
  // rebuild that date at UTC midnight.
  const ist = new Date((epochSeconds + IST_OFFSET_SECONDS) * 1000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}
