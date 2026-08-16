# Selecting a market starts the watch — three charts read, trading days only

**Read before touching `market-clock.ts`, `MarketWatchService.isTradingTime`,
`CandleMarketDataProvider.getOptionChain`, `MarketIntelligenceService.snapshot`
/`contracts`, `SentinelLiveCharts`, or `app/market/clock.py`.** Related:
[[2026-08-16 - Sentinel charts on the bars the engine reads (the chart and the agent disagreed)]]
(the same class of bug, one level down — that note fixed it for a *watch*, this
one fixes it for a *market selection*),
[[2026-08-13 - Sentinel autonomy (the browser was the heartbeat)]] (which made
`/observe` register the watch at all), and
[[2026-08-03 - Test infrastructure pass (runners made discoverable, money math covered)]]
(which pinned the clock gap this closes).

## What the product owner asked for

> Where users select their market — on selection, start Sentinel watching those
> charts, like the CE. And observations only on working days.

Both halves turned out to be the same finding twice: **a surface asserting an
engine that was not running.**

## Half one — the engine read one chart out of three

The workspace has drawn an index, a CALL and a PUT side by side since
2026-08-05. `MarketIntelligenceService.snapshot()` reads the underlying, and
every rule in `strategy-rules.ts` is a pure function of that snapshot. So two
of the three panels were decoration. The 2026-08-16 note above fixed the
*timeframe* mismatch for a selected watch; it did not, and could not, fix the
fact that the CE and PE panels were never read at all.

Underneath it was a stub nobody had revisited:

```ts
async getOptionChain(_symbol: string, _expiry?: Date): Promise<OptionChainEntry[]> {
  return [];  // "honest", pending the Phase 4 ingestion pipeline
}
```

⚠️ **The bridge had been serving `/optionchain` the whole time.** The web
workspace's chain panel, its strike pickers and its CE/PE charts all read it.
The ENGINE was the only part of TradeW that could not see the option market,
with a full chain rendered on the screen beside it. Consequences, all silent:
`snapshot.optionChain` was always null, so PCR / max pain / OI walls never
reached the confidence engine's option factor, `buildOptionContext` reported
`unavailable: true` on **every** observation ever run, and `positioningNotes`
never produced a line.

**Rule this establishes: before writing "not yet served", grep the bridge.**
"Honest degradation" is only honest while the data genuinely is not there;
after that it is a stub with a reassuring comment on it.

### Reading the leg, not inferring it

`intelligence/contract-alignment.ts` is pure and takes candles. It reads the
**traded premium series** for each leg rather than deriving leg behaviour from
the underlying, because the divergences are the observation: a call premium can
fall on a rising index (IV collapsing faster than delta pays, theta into the
afternoon), and both legs can rise together when volatility is bid ahead of an
event. Inferring from the index smooths away exactly the thing worth saying.

Three traps in that arithmetic, each pinned by a test:

- **Two flat bands, not one.** An index moving 0.05% is real drift (12 points
  on NIFTY); a premium moving 0.05% is nothing. One shared band reports every
  leg as "rising" all day and makes the read meaningless.
- **"Tracking" requires both halves.** On a rising index with both legs bid,
  the call *is* rising with the index — reporting that as directional
  confirmation reads an IV expansion as agreement. `classifyAlignment` requires
  the opposite leg to NOT also be rising, and has a `both-sides-bid` branch.
- **A leg that could not be read is never a leg that did not move.** `series:
  null` + a reason vs. `direction: 'flat'`. Collapsing them renders a dead
  bridge as a calm market — the same failure the reading strip guards against
  in the note above, and the render test asserts the PUT tile shows
  `unreadable`, never `0.00%`.

### The Rule 2 line, and where it is

This is the only surface in the workspace that names a strike and a side
together, so it is where a recommendation is easiest to imply by layout alone.
The boundary adopted: **naming which of two legs MOVED with the underlying is a
description; ranking a ladder of strikes by attractiveness is a recommendation
however it is worded.** So `alignment` is a small closed set and deliberately
**not a score** — a number invites ranking, ranking invites "which is best".
It reads ONE pair (the ATM CE and PE) and says so on screen, because a reading
that quietly covered one strike under a heading about option behaviour would
imply a ladder-wide search that never happened.

Asserted twice: every note is run through `hasDirectiveLanguage` (the same
probe the synthesis gate fails closed on), and both the notes and the rendered
panel are checked against `best`/`strongest`/`recommend`/`prefer`/`ideal`.

### The default that never matched

Found on the way, and it is the market-selection version of the whole problem:
`SentinelLiveCharts` defaulted to a **5m index and 1m contracts** while
`/observe` has *always* snapshotted **15m**. With no watch selected — which is
every user the moment they pick a market — the chart and the engine were on
different bars with nothing saying so. `SNAPSHOT_INTERVAL` is now an exported
constant and `engineFocusFrom` draws it, running `resolveSeries` over it so the
bridge's silent `?? '5'` substitution is reproduced and captioned rather than
repeated one layer up.

**Two focuses now, in precedence order**: a sentinel-py watch (more specific —
one contract, one panel badged) wins; `/observe`'s read of the selected market
is the fallback and may badge up to three panels, **each only if that series
actually came back**. `reads` is per panel and derived from evidence. A badge
that is always on says nothing.

## Half two — the clock believed the market was open on a Sunday

`market-clock.ts` was day-of-week AND holiday blind. `market-clock.spec.ts`
pinned that as a KNOWN GAP with assertions written to **flip from `true` to
`false`** when clock unification landed, and
`services/api/src/discipline/market-calendar.ts` carried the
`TODO(clock-unification)` naming this exact module. This is that change; the
block is kept and **inverted** rather than deleted, because the direction of
those particular assertions is the whole point and a deleted test cannot fail
if someone reverts the gate.

The calendar moved to `packages/market-data/src/calendar/nse-calendar.ts` —
`services/api`, `services/market-data` and `services/sentinel` all already
depend on that package, so it is the only place all three read one list from.
`services/api/src/discipline/market-calendar.ts` is now a re-export and keeps
its name, so none of its six importers changed and its spec still guards the
real data through the seam.

What each part gained:

- `isMarketOpen` / `sessionPhaseAt` — calendar-aware. A non-trading day is
  **`'closed'`, never `'pre-market'`**: the state machine seeds a fresh session
  as `PRE_MARKET` on the latter, and a Saturday that opens in PRE_MARKET spends
  all day waiting for a bell that will not ring.
- `MarketWatchService.isTradingTime` — its local `getUTCDay()` weekday hack is
  **gone**, not left as a second weaker copy. **The holiday half is the part
  that was costing money**: a holiday IS a weekday, so the old check let every
  sweep through and spent metered Dhan calls on a market that never opened.
- `shouldRunDailyPass` — skips non-trading days explicitly. It was previously
  unreachable for the *wrong* reason (`isMarketOpen` returned true at 11:00 on
  a Saturday, so the "market is open" branch caught it) and then ran anyway
  after 15:30, recalibrating on the previous session's sample a second time.
- `sentinel-py` — `app/market/calendar.py`, a documented port. Python cannot
  import the package; the alternative is a network call to learn "is today a
  trading day" on the exact path that decides whether to observe at all.
  `test_calendar.py` asserts the **whole list** by equality so a half-applied
  yearly update fails a test instead of leaving one engine watching on a day
  the other considers shut.

**Deliberately still day-blind:** `istMinutesOfDay`, `minutesToClose` and
`sessionProgress`. They are arithmetic, not gates — `MarketWatchService.expiryFor`
needs minutes-to-close whatever day it is asked on. Pinned by a test so the
next person does not "finish the job" and break the watch's expiry.

## Latency: started early, awaited last

`this.market.contracts(snapshot)` is kicked off right after the snapshot and
awaited at the bottom of `runObservation`. Two live bridge reads (one per leg,
4s abort each) on the critical path would add seconds to an observation that
runs ~1.6s, and nothing in the pipeline consumes this field. The `.catch` is
attached **immediately, not at the await** — a rejection in between would be an
unhandled rejection in the service rather than a caught one.

Chain reads are cached in the provider at 30s and expiry lists at 15 minutes.
The expiry cache is not a nicety: every chain read starts with that call, and
the bridge serialises option-family calls behind a **3.1s floor**, so an
uncached sweep over a dozen symbols would spend minutes waiting on a list that
had not changed.

## A behaviour change worth naming

The option-positioning dimension of `institutionalCrossValidation` and the
confidence engine's option factor **were abstaining because of a stub** and now
vote. That is the intent, but it is a real change in what can surface. Both
remain behind the unchanged four-condition publication gate, so the effect is
bounded to adding corroboration or conflict, never to publishing on its own.

## Verified / not verified

- `services/sentinel`: **366 passed** (24 new in `contract-alignment.spec.ts`,
  plus the inverted clock block and two new watch assertions), `nest build`
  clean, `tsc --noEmit` clean.
- `services/api`: **409 passed** — `market-calendar.spec.ts` runs unchanged
  against the re-exports.
- `services/sentinel-py`: **274 passed** (12 new in `test_calendar.py`).
- `apps/web`: **471 passed** (5 new `engineFocusFrom`, 16 new
  `SentinelContractReading`), typecheck clean.
- ⚠️ **Not driven in a browser, and not run against a live chain.** The live
  path needs Postgres + api(4000) + sentinel(4010) + the Dhan bridge on a 24h
  token, and the option-chain read is only exercised during market hours on a
  trading day. What is asserted is the arithmetic, the rendering
  (`renderToStaticMarkup`) and the gates; what is **not** asserted is that
  Dhan's chain payload maps cleanly onto `OptionChainEntry` for every
  instrument. First live session on a trading day is the check that matters.
