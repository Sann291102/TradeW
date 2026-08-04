# SentinelIntelligence continuous reasoning — the watch asks the questions

**Read before changing `MarketWatchService`'s trigger policy or
`SentinelIntelligenceService.reason()`'s signature.** Related:
[[2026-08-04 - SentinelIntelligence continuous market watch (polling, not a sixth WebSocket)]]
(the loop this hangs off),
[[2026-08-04 - SentinelIntelligence live-performance gate (books must be proven live)]]
(the gate both paths pass through),
[[2026-08-03 - SentinelIntelligence (second reasoning engine, citation-grounded)]].

Branch `feat/knowledge-workspace`. Phase 3 of three.

## The cost estimate that was wrong

Phase 2 was scoped on the assumption that running the ten agents continuously
would be "orders of magnitude" more expensive than detection. **That was
wrong, and worth recording as wrong**, because it nearly cost a phase.

The entire SentinelIntelligence pipeline is deterministic — **no LLM on any
path**. Verified by grep: the only mentions of providers or LLMs anywhere under
`sentinel-intelligence/` are doc comments describing what the *orchestrator*
does. Agents are pure functions over shared state plus an in-memory BM25
retrieval.

So a run's real cost is entirely its `computeSharedState` — three bridge HTTP
calls, two of them Dhan's metered `/candles`. The agents themselves are CPU.

**And the watch has already paid that cost.** Reusing the sweep's snapshot
makes background reasoning free at the data layer. `computeSharedState` was
split into a fetch and a `composeSharedState(symbol, snapshot, …)` so the
watch can hand in the snapshot it holds. That is also a correctness win: the
detection and the reasoning about it can no longer read ticks a second apart
and disagree.

The remaining bound is latency, not spend — hence
`watchMaxReasoningPerSweep = 3`, sized to stop a sweep where every symbol fires
at once from overrunning its own interval. Deferred symbols are logged and
retried next sweep, never silently dropped.

## The trigger policy, and the filter deliberately not applied

Reasoning fires when a setup is **new** — one that just cleared its
`claimCooldown`. A validated setup stays valid across many consecutive sweeps;
re-reasoning an unchanged picture every minute would burn CPU reproducing
identical verdicts.

**What is deliberately NOT checked: whether the pattern has live performance.**
Pre-filtering on that looks like free savings — why reason about something the
gate will silence? — and is a trap. Risk-elevated readings are *exempt* from
the live-performance gate precisely because a safety warning matters without a
track record. Pre-filtering would make that exemption unreachable from the
background path, silently removing the warnings that matter most on exactly the
unproven patterns where they matter most. The gate must not be used as a cost
optimiser for the thing it is gating.

## Two footguns avoided

- **The TTL loop.** If a background run called `watch.register()` the way a
  real request does, the watch would refresh the TTL that exists to retire it,
  and a board would stay watched forever after the trader closed it. Hence
  `ReasonOptions.register`, defaulting true, passed `false` by the watch.
- **The DI cycle.** `SentinelIntelligenceService` already depends on
  `MarketWatchService` for `register()`. Injecting it back would need
  `forwardRef` — which fails at runtime, not compile time, whenever the graph is
  later rearranged. Instead the watch exposes `setReasoner()` and the engine
  wires itself in `onModuleInit`. One direction of injection, no cycle.

## Cold corpus: decline, do not ingest

`reason()` calls `ensureCorpus()`, which lazily ingests 194 documents. Doing
that from inside a timer callback would stall a sweep behind heavy disk I/O, so
the background path checks `index.size`/`graph.size` first and **returns null**
rather than triggering ingestion. A real request warms the corpus; the
background path never pays that cost.

## No trader behind the run

Background runs carry `userId: WATCH_USER_ID` (`'sentinel-watch'`) rather than
borrowing whichever trader happened to put the symbol on the list, and pass no
`recentTrades` or `account` at all. The emotion and risk agents therefore see
no personal position data on this path by construction: **background reasoning
is about the market, never about somebody's book.**

## What this is not

- **Not a UI change.** Runs are held in a bounded per-symbol map
  (`latestRun(symbol)`), capped by the watch's own symbol cap. Nothing is
  pushed anywhere; `/sentinel` is untouched.
- **Not persisted.** One run per symbol, newest wins — "what does the engine
  currently make of this symbol", not an audit log. Persisting every background
  run is a schema decision and is deliberately not made here.
- **Not trap-triggered.** The watch scans strategies only, so a trap or risk
  signal forming with no strategy detection does not currently wake the
  reasoner. That is the obvious next extension and is not built.

## Verified, and not

Verified: 139 tests pass across `services/sentinel` (8 new for the trigger
policy, cost bound, and the off/unwired states). **`AppModule` boots with the
full DI graph resolving including the `onModuleInit` hand-off —
`npm run verify:runtime` 15/15 PASS.** `tsc` error count unchanged at 37, all
pre-existing.

**Not verified:** never run against a live bridge during market hours. No test
waits on the real timer — `sweep()` is driven directly throughout. The claim
that a background run costs no additional HTTP is verified by assertion on the
snapshot call count, not by measurement against the bridge.
