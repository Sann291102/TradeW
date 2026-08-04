# SentinelIntelligence continuous market watch — polling, not a sixth WebSocket

**Read before adding any background loop to `services/sentinel`, and before
wiring `packages/market-data`'s `MarketFeed` into it.** Related:
[[2026-08-04 - SentinelIntelligence live-performance gate (books must be proven live)]]
(this is what makes that gate's evidence accumulate),
[[2026-08-03 - SentinelIntelligence (second reasoning engine, citation-grounded)]],
[[2026-07-24 - Sentinel live data across the full universe]] (the bridge this polls),
[[2026-07-21 - Market data Phase 1 (ingestion runtime, pure reads)]].

Branch `feat/knowledge-workspace`. One new service + spec, ~5 files touched.

## The correction that started it

Both Sentinel engines were described — including in this vault's framing — as
if the orchestrator continuously watched the market. **It never did.** Verified:
`SentinelOrchestratorService` calls `market.snapshot()` once per `/observe`
(`sentinel-orchestrator.service.ts:169`), `useSentinel.ts:94` fires `/observe`
only on mount/symbol-change with **no interval**, and SentinelIntelligence
called the identical `snapshot()` once per request. The data was genuinely live;
nothing was continuously watching it. What made it *feel* always-on was the
state machine persisting session state across repeated calls.

So a setup that formed at 11:04 and resolved by 11:20 did not exist to the
system unless a trader happened to refresh during it.

## Why polling, and not the WebSocket that already exists

`packages/market-data` has a real, working `DhanMarketFeed`
(`providers/dhan/dhan.feed.ts:59`) and `services/market-data` already runs it.
That is precisely the argument **against** a Sentinel-side feed:

- Dhan allows **5 WebSocket connections per account** and evicts the oldest with
  code `805`. `services/market-data`'s README declares the ingestor a singleton
  — "do not scale horizontally" — for exactly this reason.
- A Sentinel-side feed would be a **sixth consumer** of that budget and could
  evict the running ingestor, trading a read-only convenience for an outage in
  the service everything else depends on.
- Sentinel has no `ws` dependency and imports `@tradew/market-data` nowhere in
  `src/` today.

**The push feed is already one hop away.** The bridge's `GET /quotes` is served
straight from its WebSocket-fed in-memory tick map — no upstream call, no rate
limit, effectively free. Polling it reads genuinely push-fed ticks without
becoming a sixth connection. `GET /candles` is the metered path (Dhan's charged
Data API, 5 req/s, behind a 60 s bridge cache), and that is what the cost
controls below exist to respect.

**Do not "upgrade" this to a WebSocket without first resolving the
5-connection budget with `services/market-data`.** It looks like an obvious
improvement and is a production risk.

## Cost controls, and why each number is what it is

One `snapshot()` = 3 bridge HTTP calls (2 × `/candles`, 1 × `/quotes`),
sequential (`market-intelligence.service.ts:73-97`).

| Control | Default | Why that value |
|---|---|---|
| `watchIntervalMs` | 60 s, **floored** | The bridge caches `/candles` for 60 s. Polling faster returns the identical cached body while still costing a round trip — pure waste, so the floor is enforced in config, not documented and hoped for. |
| `watchMaxSymbols` | 12 | 12 × 2 candle calls per sweep stays well inside Dhan's 5 req/s even with every cache entry cold. |
| `watchTtlMs` | 30 min | A board nobody has touched stops costing anything, with no unregister call a crashed tab would never send. |
| `watchRecordCooldownMs` | 15 min | Matches `OutcomeLearningService.MIN_AGE_MS` — see below. |

Sweeps are **sequential, not `Promise.all`** — a parallel sweep would breach the
rate limit in a burst for no benefit, since nothing waits on it — and a sweep
that overruns its interval refuses to let a second stack on top of it.

## The watch list is the user's board, not the universe

There are ~219 selectable symbols (`apps/web/src/lib/sentinel/markets.ts` +
210 F&O stocks). Sweeping all of them would spend the candle budget almost
entirely on instruments nobody is looking at.

Instead `register()` is called from `SentinelIntelligenceService.reason()` — the
path the workspace endpoint also routes through — so **the watch list is
exactly the charts traders have open**, and lapses on its own via TTL. This was
a direct user correction: the three charts are the market and strike charts
selected on the Sentinel board, not a fixed set.

## The cooldown is load-bearing, not hygiene

A setup stays valid across many consecutive ticks, and **the orchestrator
writes to the same store on every `/observe`**. Without a cooldown, one setup
that persisted for an hour would be recorded as dozens of independent
occurrences — inflating exactly the sample
[[2026-08-04 - SentinelIntelligence live-performance gate (books must be proven live)]]
reads, and making an unproven pattern read as proven. The gate would then be
worse than useless: it would look like validation while certifying noise.

The window matches `OutcomeLearningService.MIN_AGE_MS` (15 min), so a pattern
is only counted again once the previous occurrence is old enough to have been
outcome-tagged — every counted occurrence is one that could resolve
independently.

The recorded pattern name is derived **identically** to the orchestrator's
`strategySignals` (`strategyId` with dashes as underscores), because
`StrategyIntelligenceService.baseRateFor` matches on that exact string. Two
writers naming the same setup differently would silently halve the evidence.

## Weekday check lives in the watcher, deliberately

`isMarketOpen()` is time-of-day only — it returns **true at 11:00 on a Sunday**,
a gap `market-clock.spec.ts:178-224` pins on purpose (`'KNOWN GAP: the clock is
day-of-week and holiday blind'`) because seven services key off current
semantics. Fixing it there is the clock-unification change and is out of scope.
Inheriting it would mean sweeping the metered API every weekend, so the weekday
check is **local and additive** in `MarketWatchService.isTradingTime`.

Still holiday-blind: an NSE holiday sweeps and finds nothing, costing cached
calls rather than producing wrong data. Acceptable; not invisible.

## What it deliberately does NOT do

**It does not run the ten reasoning agents.** Ten agents against the BM25 corpus
per symbol per tick would cost orders of magnitude more than the detection
itself and produce reasoning nobody asked for. **Detection is continuous;
reasoning stays on demand.** The watch closes the "nobody was looking" gap; it
does not make the engine continuously *reason*.

## Verified, and not

Verified: 19 new watch tests, 131 across `services/sentinel`. **`AppModule`
boots with the full DI graph resolving — `npm run verify:runtime`, 15/15 PASS**,
including the untouched orchestrator path. `tsc` error count unchanged (40, all
pre-existing).

**Not verified:** never run against a live bridge during market hours. The
interval loop itself is exercised only through direct `sweep()` calls — no test
waits on a timer. Cost estimates are arithmetic from the bridge's documented
cache TTLs, not measured.

## Two things found on the way

- **`services/sentinel/src/market-clock.spec.ts` never runs.** It exists
  (~200 lines, including the pinned KNOWN-GAP assertions this note relies on)
  but is absent from `vitest.config.ts`'s `include` allowlist. The allowlist is
  a deliberate convention, so this is an omission, not a design choice — the
  same discoverability failure
  [[2026-08-03 - Test infrastructure pass (runners made discoverable, money math covered)]]
  was written about.
- **`@tradew/ai-core` ships unbuilt in a fresh workspace**, so
  `npm run verify:runtime` dies with `runAgentRun is not a function` before it
  boots anything. `npm run build -w @tradew/ai-core` first. Pre-existing.
