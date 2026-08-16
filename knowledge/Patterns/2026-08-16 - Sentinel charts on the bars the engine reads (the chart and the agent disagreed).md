# Sentinel charts on the bars the engine reads — the chart and the agent disagreed

**Read before touching `SentinelLiveCharts`, `lib/sentinel/chartFocus.ts`,
`StrategyTimelineFeed`'s selection, or `build_timeline` in
`services/sentinel-py/app/watch/timeline.py`.** Related:
[[2026-08-05 - Sentinel workspace premium redesign (two-column rail layout)]]
(where the three-chart panel was built, and last used),
[[2026-08-11 - Sentinel dashboard redesign]] context in
`archive/apps-web-sentinel-dashboard-redesign-2026-08-11/` (the redesign that
orphaned it), and
[[2026-08-15 - Sentinel-py personal strategy watcher (additive Python runtime)]]
(the engine whose bars this aligns to).

## The state this fixed

Three separate facts, each individually defensible, that added up to an engine
nobody could check:

1. **`SentinelLiveCharts` was dead code.** The 2026-08-11 dashboard redesign
   replaced the two-column rail with `SentinelDashboard`, and the three-chart
   panel (index + CE + PE) was never re-imported. It sat in
   `apps/web/src/components/sentinel/` with **zero importers** — a grep for its
   own name returned its definition and one unrelated comment.
2. **The charts and the engine were on different timeframes.** The panel
   hardcoded a 5m index and 1m contracts. `services/sentinel-py`'s poller
   evaluates on `rules.timeframe` (default 15m). Nothing connected the two, so
   even when the panel was mounted the user was looking at bars the sweep had
   never read.
3. **The sweep's measurements were write-only.** `poller.py` has always
   recorded `pullback`/`vwap`/`flip`/`flag`/`zone`/`liquidity` into every
   `WatchObservation`. **Nothing had ever read them back out.** The workspace
   could say *which* of the user's conditions were met and never *what was
   measured* to decide that.

Together: the user saw a chart, Sentinel saw a chart, and there was no way to
establish they were the same chart — or that Sentinel had read one at all.

## The rule this establishes

> A chart captioned "what Sentinel is reading" must be drawn on the series the
> engine actually receives — not the one the strategy asked for, and not a
> display default.

Those three can all differ, which is the next section.

## The bridge substitutes silently, so the browser must reproduce it

`services/market-data/scripts/live-feed-server.ts`:

```ts
const INTRADAY_INTERVAL: Record<string, string> = { '1m':'1', '5m':'5', '15m':'15', '1h':'60' };
// …
if (!isDaily) body.interval = INTRADAY_INTERVAL[interval] ?? '5';
```

A strategy saved as `3m` makes the poller request 3m, receive **5m bars**, and
evaluate them as if they were 3m. No error is raised anywhere in the chain —
not in the bridge, not in `feed.py`, not in the sweep.

`resolveSeries()` in `lib/sentinel/chartFocus.ts` therefore **mirrors the
`?? '5'` fallback deliberately** and returns `substituted: true`. Drawing the
requested 3m would be drawing bars the engine never read; drawing 5m silently
would repeat the bug one layer up. So it draws 5m and *says so*
(`seriesNote()`).

⚠️ **This is a latent data-correctness bug in the bridge, not just a display
concern.** A `3m`/`30m`/`60m` strategy is being evaluated on 5m bars right now.
The fix belongs in the bridge or in `parser.py`'s timeframe vocabulary
(reject/normalise what cannot be served); the UI change only makes it visible.

Note `1h` is servable but `60m` is not — the map keys are literal strings.

## The default lives in exactly one place

`build_timeline` returns `timeframe: null` when the strategy names none — it
does **not** substitute the poller's 15m default. The browser's
`ENGINE_DEFAULT_TIMEFRAME` is the single place that assumes it, pointing at
`_timeframe_of()` by name. Two copies of a default is how a chart starts
disagreeing with an engine again after someone changes one of them.

## Selection lives where the watches already are

`StrategyTimelineFeed` owns the watch `<select>`, so it publishes upward
(`onObservationChange`) rather than the dashboard fetching a second list. Two
lists would eventually disagree about which watch is selected.

The gotcha: the feed re-polls every 10 s and produces a **fresh `Timeline`
object each time**. Publishing on object identity restarts the charts' data
hooks every poll. Guarded with a string `observationKey` + a ref — and
`reading.at` is in that key because it moves whenever the engine has measured a
new sweep, so it covers the measurements without enumerating them.

## Three panels, one of which is actually being evaluated

`readingPanel` marks exactly one tile "Sentinel reads this", mirroring
`_candles_for` in the poller: **a watch with a strike reads the contract, a
watch without one reads the index.** The other two panels are context. Marking
all three the same would claim the engine is reading three instruments when it
reads one — the same class of error as the CE-fabrication gotcha in
[[2026-08-12 - Sentinel event contract (notifications consume a gated event, never the response)]].

For the same reason `focusFromTimeline` keeps an index watch **strikeless**
rather than defaulting an ATM strike in.

## The reading strip states staleness before the numbers

`_reading()` answers two questions from **different observations on purpose**:

- measurements ← newest *readable* (`watch-engine`, non-skipped) sweep
- "could it read the market" ← newest sweep **of any kind**

A bridge that died five minutes ago must not leave five-minute-old levels
looking current. The numbers stay (they are still the last thing that was true)
and `unreadable` says the latest attempt failed. `SentinelChartReading` renders
that warning *above* the rows and asserts the ordering in a test — a user
reading top-down must not take a stale level as current.

Also load-bearing: **"measured nothing" and "could not read" are different
sentences.** A clean sweep that found no structure is a reading, not a failure.

Measurement shapes are treated as **opaque labelled values** in the browser
(`Record<string, unknown>` + narrowing helpers). Re-typing `measure_zone`'s
fields field-by-field would create a second definition to drift from the
evaluator's.

## Verified / not verified

- `services/sentinel-py`: **246 passed** (6 new in `test_timeline.py`).
- `apps/web`: **352 passed** (10 new `chartFocus`, 8 new `SentinelChartReading`),
  typecheck clean, lint clean.
- ⚠️ **Not driven in a browser.** The live path needs Postgres + api(4000) +
  sentinel(4010) + sentinel-py + the Dhan bridge on a 24h token (browser-2FA,
  see the Dhan token architecture) **and at least one active watch** — and the
  whole reason this work started is that no watch has ever run. The rendering
  is pinned by `renderToStaticMarkup` tests instead.

## What this does not do

It does not make the evaluators see live candles — they already do, via
`feed.py`, whenever a watch is active during market hours. What was missing was
that **no watch had ever run**, so every segment sat at zero samples. This work
removes the excuse (the surface now exists, on the right bars, showing the
engine's own reading) but the samples still require a real watch on a real
session.
