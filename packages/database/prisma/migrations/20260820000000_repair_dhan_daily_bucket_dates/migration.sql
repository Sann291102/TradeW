-- Repair: Dhan daily candles were stored one calendar day early.
--
-- THE BUG
-- `services/market-data/scripts/backfill-candles.ts` built a bar's bucket with
-- `new Date(timestamp * 1000)`. For INTRADAY bars that is correct — they are
-- genuine instants. For DAILY bars it is not: a daily bar is a calendar day,
-- and Dhan stamps it at IST midnight, so the conversion lands on 18:30 UTC of
-- the PREVIOUS day. Tuesday's session was filed under Monday, and Monday's
-- under Sunday.
--
-- Measured on 2026-08-19, before this repair:
--   * 13 distinct "Sunday" sessions in Candle, which NSE does not trade;
--   * every one of RELIANCE's and COALINDIA's 61 daily Dhan bars sat exactly
--     5h30m before the `nse-bhavcopy` bar for the same session, carrying
--     byte-identical open, high, low, close AND volume (0 rows disagreed);
--   * so those two instruments reported 205 distinct daily buckets across the
--     52-week window where only 144 real sessions existed.
--
-- The unique index (instrumentId, timeframe, bucketStart) cannot catch this:
-- the two rows have different bucketStarts, so both are accepted and the series
-- silently gains a duplicate for every session. Prices were never wrong — the
-- duplicate carries the same values — but any per-session count or average is,
-- and "20-day average volume" over a duplicated range covers ten real days.
--
-- The root cause is fixed in the script; this repairs what it already wrote.
-- Written as a migration rather than a one-off script because every environment
-- that ran the old backfill holds the same rows.
--
-- SAFETY
-- Both statements are scoped to `timeframe = '1d' AND source = 'dhan'` and to
-- rows whose time component is exactly 18:30, which is the fingerprint of the
-- defect. A correctly-stored daily bar is at 00:00 and is untouched. Both are
-- idempotent: re-running finds nothing left to change.

-- ── Step 1: remove bars that duplicate a bhavcopy session ───────────────────
-- ONLY where the bhavcopy row for the same session exists AND every value is
-- identical. A Dhan bar that disagreed with bhavcopy would be a source conflict
-- to record and reconcile, never something to silently drop, so the equality
-- test is part of the WHERE clause rather than an assumption stated in a
-- comment. Verified before writing this: 122 rows matched, 0 disagreed.
DELETE FROM "Candle" d
WHERE d."timeframe" = '1d'
  AND d."source" = 'dhan'
  AND d."bucketStart"::time = '18:30:00'
  AND EXISTS (
    SELECT 1 FROM "Candle" b
    WHERE b."instrumentId" = d."instrumentId"
      AND b."timeframe" = '1d'
      AND b."source" = 'nse-bhavcopy'
      AND b."bucketStart" = date_trunc('day', d."bucketStart" + interval '5.5 hours')
      AND b."open" = d."open"
      AND b."high" = d."high"
      AND b."low" = d."low"
      AND b."close" = d."close"
      AND b."volume" = d."volume"
  );

-- ── Step 2: re-stamp what remains ──────────────────────────────────────────
-- The survivors are the index series — NIFTY, BANKNIFTY, FINNIFTY — which have
-- no bhavcopy equivalent because the equity bhavcopy does not carry indices.
-- They are the ONLY daily history we hold for those instruments, so they are
-- corrected in place rather than deleted.
--
-- The NOT EXISTS guard keeps the update from colliding with the unique index if
-- a correctly-stamped bar for that session somehow already exists; such a row
-- would be left for a human rather than overwritten.
UPDATE "Candle" d
SET "bucketStart" = date_trunc('day', d."bucketStart" + interval '5.5 hours')
WHERE d."timeframe" = '1d'
  AND d."source" = 'dhan'
  AND d."bucketStart"::time = '18:30:00'
  AND NOT EXISTS (
    SELECT 1 FROM "Candle" x
    WHERE x."instrumentId" = d."instrumentId"
      AND x."timeframe" = '1d'
      AND x."bucketStart" = date_trunc('day', d."bucketStart" + interval '5.5 hours')
  );
