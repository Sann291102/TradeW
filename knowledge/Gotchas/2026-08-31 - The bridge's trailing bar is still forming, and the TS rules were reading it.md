---
type: gotcha
date: 2026-08-31
tags: [gotcha, sentinel, market-data, strategy-rules, candles, paper-trading]
---

# The bridge's trailing bar is still forming, and the TS rules were reading it

The market-data bridge returns the **in-progress candle as the final element**
of every intraday series during market hours. `services/sentinel-py` has known
this since it was written; `services/sentinel` did not, and every rule that
measures the newest bar was measuring a bar the market had not finished writing.

## The failure

A partially-formed 15m bar has a narrower range and a lower volume than the
finished bar will have. So a rule reading `candles[candles.length - 1]` was
reading a number that **grows as the bar fills in**:

- `displacement_bar` — range against the average of the previous five
- `rejection_bar` — wick-to-body of the bar
- `volume_supports_move`, `sweep_volume_spike`, `vwap_lost_on_volume`,
  `breakout_sustained`, `breakout_volume_fading`
- `liquidity_pool_swept`, via `detectSweep`'s 20-bar extreme

Two minutes into a bar the tape has posted a fraction of its volume, so
`volume_supports_move` said no. Fourteen minutes in it had posted twice the
average, so the same rule said yes — **about the same unfinished bar**. The
autonomous paper agents evaluate on a 30-second tick, so an entry decision
depended on where in the fifteen-minute window the tick happened to land. That
is not a market fact, and no amount of confirmations downstream can repair an
input that changes underneath them.

Nothing crashed and nothing logged. The rule notes even cited real numbers —
they were real numbers about an incomplete bar.

## The fix, and why it is one line in one place

Dropped where the snapshot is built (`composeSnapshot`), not per rule. A
per-rule fix is one the next rule forgets. `MarketSnapshot.candles` and
`sessionCandles` now carry **closed bars only**, so every indicator, swing
level, profile, trend read, signal and agent downstream inherits it.

## Three things that are easy to get wrong here

**1. It is not an unconditional `slice(0, -1)`.** The Python
`closed_candles()` slices unconditionally, and is right to: its poller only
ever runs live. The TS path is not so lucky — `composeSnapshot` is also the
Module 12 backtest replay's entry point, and `snapshot()` is polled out of
hours and against stored history. In all of those the trailing bar is a real,
closed bar. The test is against the **clock**, not the position in the array:
a bar that opened at `T` is finished once `now >= T + INTERVAL_MS[interval]`.

**2. Candle timestamps are bar OPEN times.** Dhan's intraday chart API
timestamps bars at their start and the whole bridge inherits it. The existing
`computeOpeningRange` only works under that reading — its 30-minute window
catches two 15m bars because they sit at offsets 0 and 15. Get this backwards
and the drop is off by a full bar in the wrong direction.

**3. Three fields must still see the forming bar,** and each for a different
reason:

| Consumer | Why it needs the live bar |
|---|---|
| `MarketSnapshot.lastPrice` | It is the **spot**. It picks the ATM strike, prices the candidate contract, and answers the data-quality gate's "is there a usable index price?". A spot lagging a full bar is the wrong number for all three. |
| Freshness (`latestDataAt`) | "Is this a live read?" is answered by the newest data of any kind. Measuring against the last *closed* bar charges a live observation up to 15 minutes of age it does not have — against a 30-minute allowance, that leaves almost nothing for a genuinely late poll and a live market starts reporting `stale-data`. |
| `contracts()` / chart annotations (`liveCandles`) | The CE/PE legs are fetched raw and carry their own forming bars. Dropping it from only the index would compare different amounts of time and call the difference divergence — the exact failure the shared `SNAPSHOT_INTERVAL` exists to prevent. |

So the snapshot ended up carrying **two clocks**, deliberately:
`latestBarAt` = when the market did this (closed bar, stamps detections);
`latestDataAt` = how live is this read (forming bar, gates freshness). They
were one function answering two questions, which is why the split was needed.

## Related

- [[Decisions/2026-08-15 - Sentinel-py personal strategy watcher (additive Python runtime)]] —
  where `closed_candles()` and the "confirmation before notification" rule live.
- `services/sentinel/src/intelligence/forming-candle.spec.ts` pins both halves:
  a live snapshot drops the bar, an out-of-hours or replayed one keeps it.

## Still open

`readLegCandles` does not drop the forming bar from the CE/PE premium series.
Today that is *correct* — it keeps the three series symmetric for
`readSeries`, which is a session-level change comparison and measures no single
bar. It would become wrong the moment anything starts reading a **single
premium bar's** range or volume. If that day comes, drop it on all three at
once, not on one.
