import { describe, expect, it } from 'vitest';
import { dhanBucketStart } from './dhan-bar-bucket';

/**
 * Regression for a defect that produced trading sessions on Sundays and a
 * duplicate of every daily bar for instruments backfilled from both Dhan and
 * the NSE bhavcopy. Found 2026-08-19 by day-of-week auditing the Candle table,
 * not by a failing test — so these are the assertions that would have caught it.
 */

/** IST midnight for a calendar date, as Dhan stamps a daily bar. */
const istMidnight = (iso: string): number => Date.parse(`${iso}T00:00:00+05:30`) / 1000;

describe('dhanBucketStart — daily bars', () => {
  it('files a session under its own calendar date, not the previous one', () => {
    // THE BUG. `new Date(epoch * 1000)` on this input yields 2026-07-13T18:30Z,
    // so the 14 July session was stored under 13 July.
    const bucket = dhanBucketStart(istMidnight('2026-07-14'), true);
    expect(bucket.toISOString()).toBe('2026-07-14T00:00:00.000Z');
  });

  it('never lands a weekday session on a weekend', () => {
    // Monday sessions were the ones that became Sundays, which is how the
    // defect first became visible.
    for (const monday of ['2026-07-13', '2026-07-20', '2026-07-27']) {
      const bucket = dhanBucketStart(istMidnight(monday), true);
      expect(bucket.getUTCDay(), monday).toBe(1); // Monday
      expect(bucket.toISOString().slice(0, 10)).toBe(monday);
    }
  });

  it('normalises to midnight UTC so it matches what the bhavcopy ingest writes', () => {
    // The two sources must agree on the bucket or the same session is stored
    // twice and no unique index can tell.
    const bucket = dhanBucketStart(istMidnight('2026-01-02'), true);
    expect(bucket.getUTCHours()).toBe(0);
    expect(bucket.getUTCMinutes()).toBe(0);
    expect(bucket.getUTCSeconds()).toBe(0);
  });

  it('is stable if Dhan stamps a daily bar mid-session rather than at midnight', () => {
    // 09:15 IST on the 14th is still the 14th's bar. Reading the date off an
    // IST clock keeps that true; truncating the raw UTC instant would not.
    const midSession = Date.parse('2026-07-14T09:15:00+05:30') / 1000;
    expect(dhanBucketStart(midSession, true).toISOString()).toBe('2026-07-14T00:00:00.000Z');
  });

  it('handles a session on the far side of a month and year boundary', () => {
    expect(dhanBucketStart(istMidnight('2026-01-01'), true).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(dhanBucketStart(istMidnight('2025-12-31'), true).toISOString()).toBe('2025-12-31T00:00:00.000Z');
    expect(dhanBucketStart(istMidnight('2026-03-01'), true).toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('dhanBucketStart — intraday bars', () => {
  it('passes the instant through untouched', () => {
    // An intraday bar IS an instant. Normalising it to a calendar day would
    // collapse every bar of a session onto one bucket and destroy the series.
    const nineFifteen = Date.parse('2026-07-14T09:15:00+05:30') / 1000;
    expect(dhanBucketStart(nineFifteen, false).toISOString()).toBe('2026-07-14T03:45:00.000Z');

    const threeThirty = Date.parse('2026-07-14T15:30:00+05:30') / 1000;
    expect(dhanBucketStart(threeThirty, false).toISOString()).toBe('2026-07-14T10:00:00.000Z');
  });

  it('keeps distinct intraday bars distinct', () => {
    const base = Date.parse('2026-07-14T09:15:00+05:30') / 1000;
    const buckets = [0, 60, 300, 900].map((offset) => dhanBucketStart(base + offset, false).getTime());
    expect(new Set(buckets).size).toBe(4);
  });
});
