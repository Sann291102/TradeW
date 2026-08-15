# Sentinel autonomy — the browser was the heartbeat

**Read before touching `MarketWatchService.register`/`expiryFor`,
`SentinelIntelligenceService.watchSymbol`/`scheduleCorpusWarmup`, or
`StrategyEngineService.scan`'s timestamps.** Related and partly corrected by
this note:
[[2026-08-04 - SentinelIntelligence continuous market watch (polling, not a sixth WebSocket)]]
(built the loop this note finally connects),
[[2026-08-04 - SentinelIntelligence continuous reasoning (the watch asks the questions)]]
(the background reasoning path that had never once run),
[[2026-08-12 - Sentinel event contract (notifications consume a gated event, never the response)]]
(its closing caveat — "durable but not yet generated with the tab closed" — is
the gap closed here),
[[2026-08-04 - SentinelIntelligence live-performance gate (books must be proven live)]]
(the gate whose evidence could never accumulate while this was broken).

Branch `main`. 9 source files + 2 new specs.

## The correction

The 2026-08-04 note says the watch list is filled "from the request path". That
was true of exactly one request path — and not the one any app calls.

Verified against the running service, mid-session, on a live Dhan feed:

```
watch: { enabled: true, running: true, tradingTime: true,
         watching: [], sweeps: 0, occurrencesRecorded: 0,
         reasoningRuns: 0, lastSweepAt: null }
corpus: { documents: 0, chunks: 0, concepts: 0, indexedAt: null }
```

Enabled, running, inside trading hours, and it had swept **zero times all day**.
`watch.register()` had exactly one production caller —
`SentinelIntelligenceService.reason()`, reachable only via
`POST /intelligence/reason`, a route no app calls. `/observe` never touched the
watch list, so every 60 s tick exited at the `no-symbols` guard before the
`sweeps` counter incremented. The ten agents had done no autonomous work at all.

Two independent faults compounded it:

- **`indexOnBoot` was declared, parsed, and read by nothing.** `grep` found the
  field in `si.config.ts` twice and nowhere else. The corpus was therefore only
  ever built by `reason()`'s lazy `ensureCorpus()` — and `reasonInBackground()`
  *declines* on an empty index specifically to avoid a 223-document ingest from
  inside a timer callback. So even with symbols watched, background reasoning
  would have returned null forever.
- **`detectedAt` was the scan's clock, not the market's.**
  `detectedAt: at.toISOString()` where `at` is the `/observe` request time, so
  every detection from one poll shared the poll's timestamp. A trader opening a
  chart at 14:59 saw three setups "detected at 14:59" regardless of which bars
  they formed on.

## What the three fixes actually are

**1. `/observe` registers the symbol it observed.** One call in
`runObservation`, placed *after* the snapshot so a symbol whose data could not
be fetched is never watched, delegating through a new
`SentinelIntelligenceService.watchSymbol()` to the existing `register()`. A thin
delegation on purpose: the orchestrator already injects the intelligence service,
so this needed no new DI edge, and reusing `register()` keeps **one**
idempotency rule, **one** expiry policy and **one** symbol cap rather than a
second set of all three. Wrapped in try/catch — watch bookkeeping must never be
able to fail an observation.

**2. A watch is held to the market close, not to the TTL.** This is the
load-bearing change, and the reason is subtle enough to be worth stating: the
plain TTL was not a cost control in practice, it was a *browser dependency*. The
dashboard polls `/observe` every 45 s, so an open tab refreshed the TTL forever
and a closed tab retired the symbol 30 minutes later. "Continuous watch" meant
"watched while somebody is looking" — the precise thing the service exists not
to be. `expiryFor()` now returns `max(at + ttl, today's close)`, computed from
`MARKET_CLOSE_MIN` + `istMinutesOfDay` so it cannot disagree with the guard that
decides whether to sweep. Registering outside the session falls back to the TTL,
so an after-hours request cannot pin a symbol overnight, and nothing carries into
tomorrow.

The two controls that actually bound cost are untouched and independent:
`isTradingTime()` (no sweep outside the session) and `watchMaxSymbols` (12). A
test pins the case where they diverge — a watch registered at 15:29 keeps a TTL
that outlives the session, so the *clock*, not the expiry, is what must stop the
sweep.

**3. The corpus warms at boot, deferred.** `indexOnBoot` is now read, and
flipped to opt-out. The original "indexing is I/O heavy" reason is real and is
answered by running off the boot path — `setTimeout(5s).unref()` — rather than by
leaving the corpus empty. Idempotent at three levels, which is what makes it safe
to run on every restart: `ensureCorpus()` returns immediately once index and
graph are populated, `ingest()` shares one in-flight run between concurrent
callers, and it skips any document whose checksum is already indexed — including
the ~2.6 MB persisted index restored from disk. Live result: 223 documents /
2229 chunks / 66 concepts, indexed at boot, with nobody having called `/reason`.

**4. Market time and execution time are now separate fields.** `detectedAt` is
the newest bar in the snapshot (new exported `latestBarAt()`, preferring session
bars, falling back to history, null only when there are no candles at all);
`observedAt` is the scan clock. Both ride to the client and into the timeline
entry's `data`. Nothing is fabricated: with no candle there is no market event to
point at, and the scan clock is then the honest answer.

Note what this does **not** do — within one scan every detection still shares one
timestamp, because every rule in `strategy-rules.ts` is a pure function of the
same snapshot, so they genuinely were all evaluated against the same bar. The
fix is that the shared timestamp is now the bar's, not the poll's. Spreading
detections across *earlier* bars would mean re-evaluating rules over truncated
snapshots or keeping a first-seen ledger; the timeline's existing 12-entry
`dedupeKey` window already preserves the first recording of a persisting setup,
which is the property that mattered.

`isWithinSession(def.idealSession, at)` deliberately still uses the scan clock.
Switching it to bar time would change *which strategies scan*, which is a
detection-behaviour change, not a timestamp fix.

## Verification, and what could not be verified

Live, market-closed, no browser polling:

- `/observe` → `watching: ["NIFTY"]`, `watchedUntil` = observe time + 30 min
  (the after-close TTL fallback, correctly not pinning overnight).
- `lastSkipReason` moved from `no-symbols` to `market-closed` — the watch list is
  no longer the blocker; only the session clock is.
- `lastTickAt` advanced on an exact 60 s cadence across five samples while
  `watchedUntil` stayed frozen. That pair is the browser-independence proof: if
  anything were polling `/observe`, `watchedUntil` would move; the loop ran
  anyway.
- `strategyMatches[].detectedAt = 10:00:00Z` (15:30 IST, the session's last bar)
  against `observedAt = 10:17:24Z` (15:47 IST, the scan). Pre-fix, both would
  have read 15:47.

**Not verified live, and not claimed:** `sweeps > 0`,
`occurrencesRecorded > 0`, `reasoningRuns > 0`. Those need the market open, and
the work landed after the 15:30 close. They are covered by deterministic
clock-injected tests (`sweep(at)` is public precisely so a timer-driven loop is
testable), but the first genuine autonomous sweep is the next session open. Two
new observability fields exist specifically so that is checkable without
guesswork: `lastTickAt` (the loop ticked) and `lastSkipReason` (why it declined).
`lastSweepAt: null` + `sweeps: 0` alone read identically whether a loop is dead
or merely idle — the ambiguity that hid this fault for a whole trading day.

## Gotchas

- **`sweeps` does not count declined ticks.** The counter increments in the
  `finally` of the block *after* the three early returns, so a loop that always
  declines reports `sweeps: 0` forever. Use `lastTickAt` for liveness.
- **A test that pinned the old TTL behaviour had to change.** "stops watching a
  symbol once its watch lapses" now runs with
  `SI_WATCH_PERSIST_SESSION=false`; the session-persistence case is covered
  separately. A test asserting a deliberately-changed behaviour is the one place
  where editing the test is the correct move — but say so out loud.
- **`vitest.config.ts` `include` is an allowlist.** A new spec file does not run
  until it is listed there. Two were added with this work.
- **`observedAt` had to be optional** on `StrategyMatch`: `pattern-recognition`,
  `market-close-analysis` and a script all construct the shape, and a required
  field would have forced edits into four unrelated call sites.
