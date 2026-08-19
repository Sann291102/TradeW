---
type: gotcha
date: 2026-08-20
tags: [gotcha, market-data, candles, dhan, timezone, data-integrity]
---

# Daily candles are calendar buckets, not instants

**Read before writing anything into `Candle`, and before trusting a per-session
count or average computed from it.**

`Candle.bucketStart` means two different things depending on timeframe, and the
distinction is silent when you get it wrong:

- an **intraday** bar IS an instant — 09:15 IST is a moment;
- a **daily** bar is a **calendar day**, and a calendar day is not an instant.

`services/market-data/scripts/backfill-candles.ts` stored both the same way:
`new Date(timestamp * 1000)`. Dhan stamps a daily bar at **IST midnight**, so
that conversion produces **18:30 UTC on the previous day**. Tuesday's session
was filed under Monday. Monday's under **Sunday**.

## How it presented

Nothing failed. No exception, no constraint violation, no wrong price. It was
found on 2026-08-19 only by grouping `Candle` by day-of-week and noticing
sessions on days NSE does not trade:

| Source | Sat/Sun sessions | Note |
|---|---|---|
| `dhan` | **13 Sundays** | every Monday session, shifted back |
| `nse-bhavcopy` | 0 | writes UTC midnight of the session date |

And, for the two equities backfilled from both sources, **every** Dhan daily bar
sat exactly 5h30m before the bhavcopy bar for the same session, carrying
**byte-identical open, high, low, close and volume** — 122 pairs, 0 disagreeing.

**The unique index cannot catch this.** `@@unique([instrumentId, timeframe,
bucketStart])` sees two different `bucketStart` values, so it accepts both. The
series silently gains a duplicate for every session.

## Why it matters even though prices were right

The duplicate carries the same values, so a chart looks fine and a 52-week
high/low is still correct. What breaks is anything that **counts** or
**averages** sessions:

- RELIANCE reported **205 distinct daily buckets** in its 52-week window where
  only **144 real sessions** existed;
- a "20-day average volume" over a duplicated range covers **ten** real days;
- a "computed over N sessions" freshness flag *under*-reports the shortfall,
  which is worse than no flag — it asserts more coverage than exists.

## The rule

**Normalise a daily bucket to UTC midnight of the exchange-local session date.**
Read the calendar date off an IST clock, then rebuild it at UTC midnight — do
not truncate the raw UTC instant, which is the same bug one step later.

`dhanBucketStart(epochSeconds, isDaily)` in
`packages/market-data/src/providers/dhan/dhan-bar-bucket.ts` is the shared
implementation, with regressions in its spec. It lives in the package rather
than the script so both the backfill and any future ingest agree.

The repair for rows already written is
`packages/database/prisma/migrations/20260820000000_repair_dhan_daily_bucket_dates`
— it deletes only bars that duplicate a bhavcopy session **with every value
identical** (a disagreement is a source conflict to record, never something to
drop silently) and re-stamps the rest in place. The index series
(NIFTY/BANKNIFTY/FINNIFTY) had no bhavcopy equivalent and are the only daily
history held for those instruments, so they were corrected, not removed.

## The general shape

Two writers, one column, two conventions. Both "worked". Related:
[[API/2026-08-19 - NSE corporate filings and XBRL fundamentals (verified)]]
records the same shape twice more on the same day — a bhavcopy file whose
**filename is not its session date**, and an XBRL context whose **declared
period is not the fact's period**. In all three the data was valid, nothing
threw, and only an explicit cross-check against a second source exposed it.

When a value can be derived two ways, assert that both agree rather than
trusting whichever one you wrote first.
