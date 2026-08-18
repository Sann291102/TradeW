# The watch is an option PAIR — and a strike number is not an instrument

**Read before touching `lib/sentinel/watchState.ts`, `StrikeCombobox`,
`WatchCreator`, `useOptionInstruments`, `app/watch/router.py`,
`app/watch/store.py`, `app/watch/poller.py`, or the `WatchSession` option-pair
columns.** Related:
[[2026-08-18 - One canonical watch state (the controls were wired to nothing)]]
(which made `WatchSelection` the single editor of market/strike — this widens
what that state *holds*),
[[2026-08-16 - Selecting a market starts the watch (three charts read, trading days only)]]
(which made `/observe` read three series and established that naming which of
two legs MOVED is a description while ranking a ladder is a recommendation), and
[[2026-08-15 - Sentinel-py personal strategy watcher (additive Python runtime)]]
(the service whose `WatchSession` this changes).

## What was wrong

The workspace has drawn an index, a CALL and a PUT side by side since
2026-08-05, and since 2026-08-18 `WatchSelection` has held `callStrike` and
`putStrike` independently. But the **watch** — the thing the engine actually
runs — named ONE leg:

```ts
{ strategyId, symbol, strike: '24200', optionType: 'CE', expiry }
```

`WatchCreator` had one strike dropdown, and the CE/PE segmented control decided
which leg it edited. **So the toggle silently decided which single leg reached
the engine**, while the screen showed two charts throughout.

Sentinel's job on this surface is to read the underlying as market context and
decide which of two candidate expressions of its move — the call or the put — is
presenting the stronger structure. **It cannot be asked that question about one
leg.** The panel was drawing a comparison the engine had never been given the
inputs for.

## Two separate fixes, and the second is the one people skip

### 1. The pair travels

`WatchSelection` gained `callInstrument`/`putInstrument`; `optionType` was
**renamed `focusedSide`** — under the old name it read as "the option type of
the watch", which is precisely how it came to be load-bearing. It now decides
which leg the rule set evaluates on and which card is emphasised, and creates
nothing.

`CreateWatchInput` is now `{ symbol, expiry, ce, pe, focusedSide, watchMode,
timeframe }`. There is no `strike` field for a request to fall back to, so the
typechecker refuses the old shape rather than a reviewer having to notice it.

### 2. ⚠️ A STRIKE NUMBER IS NOT AN ADDRESS

This is the half that is easy to leave out, and the more dangerous one. Before
this change, **every consumer that needed the actual contract re-derived it from
(symbol, expiry, strike, side) on its own** — the chart's candle fetch, the
premium poll, the sweep's candle fetch, the price map. Four independent lookups
of one fact, agreeing by luck rather than by construction.

A re-derivation that finds nothing draws an empty chart, which is visible. **A
re-derivation that finds the WRONG row draws a confident, wrong chart, which is
not.**

Both legs now carry the bridge's `/instrument/option` response — securityId,
exchange segment, instrument class, trading symbol, lot, tick — stored as
columns on `WatchSession`, and the token is passed to `/candles/option`, which
**verifies it against its own scrip-master resolution and fails on a mismatch**
rather than serving another contract's bars under the caller's label.

**Reuse, not a new path.** `/instrument/option` already existed (the paper-OMS
work), was already on the web origin's proxy allowlist, and is already how
`services/api`'s `resolveOptionInstrument` resolves contracts. The Sentinel
workspace was the only surface addressing option contracts *without* it.

## The property that needs three guards

> **A CE control must never be able to select a PE instrument, or vice versa.**

Guarded three times, because the consequence — Sentinel observing a put while
every screen says call — is invisible from the outside:

1. **`StrikeCombobox` is handed ONE side's ladder** (`chain.ce` or `chain.pe`).
   Every option it offers, filters or accepts comes out of that single array, so
   no path — default list, search, typed input, keyboard — reaches the other leg.
2. **`fetchDhanOptionInstrument` rejects** a bridge response whose `optionType`
   is not the one requested.
3. **`instrumentDescribes` refuses to attach** such a token to a leg, and
   `_validate_pair` in `app/watch/router.py` refuses a payload that got past
   both.

The tests use **deliberately asymmetric ladders** (24500 listed only as a call,
23900 only as a put). Two identical ladders let every cross-side bug pass.

## Decisions worth not re-litigating

**The six-strike window is 3 below the ATM, the ATM, and 2 above.** The brief
asked for "3 ITM and 3 OTM" and pinned it with an example — at spot 24500:
24350, 24400, 24450, 24500, 24550, 24600 — and specified **the same six for both
sides**. A per-side moneyness split reproduces that for CE and contradicts it
for PE (it would put the put ladder on 24400…24650). So it is one shared window
centred on the ATM. It is a **default view, never a cap**: the combobox searches
the whole real ladder, because "searchable" and "only currently available
strikes" are both requirements and six rows would make the search decorative.

**A typed strike is accepted or refused, never adjusted.** `resolveTypedStrike`
does not snap to the nearest. Typing 24337 leaves the selection where it was and
says why. Same class of fault as the ATM fallback that made the old charts look
connected to controls they were not.

**`selectionFromWatch` no longer mirrors one strike onto both legs.** It used
to, because the panel had to draw two charts out of one number. With a real pair
that guess would overwrite a put the operator deliberately chose. The old
assertions were **inverted rather than deleted** — a deleted test cannot fail if
someone restores the mirror. One subtlety found while doing it: the unnamed leg
of a legacy row is kept **only when the watch is on the same symbol and
expiry**, or a NIFTY put strike ends up sitting in a BANKNIFTY selection,
looking plausible and blocking the form with a fault nobody caused.

**The legacy `strike`/`optionType` columns stay.** Rows created before this
carry only those; dropping them destroys every pre-existing watch. New rows keep
them mirrored from the focused leg. **`watchLegs()` (apps/web) and `_legs_of()`
(sentinel-py) are the ONLY readers** — that is what keeps the legacy shape a
migration shim with one call site's worth of surface instead of a second live
single-strike path. A reconstructed legacy leg has an **empty securityId, never
a fabricated one**: the row never held a token, and inventing one makes it
indistinguishable from a resolved leg.

**Rule 2 line, restated.** Nothing anywhere in this change ranks the two legs.
The pair is configured, both legs are handed to the engine, and the observation
records both — `optionPair` in the sweep metadata is *recorded, not scored*.
Which side is the stronger setup is the agents' evaluation of live structure,
momentum, volatility, premium behaviour and liquidity. **A "bullish → CE"
shortcut anywhere in this flow would pre-empt exactly the judgement the agents
exist to make**, and a stored ranking is a recommendation by another name.

## The cost that was accepted

`_read_pair` fetches BOTH legs every sweep, where `_candles_for` fetched one.
The bridge caches candles per `(securityId, interval, days)` for **60s** and the
sweep runs every 15s, so this is **one additional upstream call per minute per
option watch** — paid once per contract, not once per sweep. That is the price
of being able to compare the legs at all.

`useWatchPrices` prices both legs for **no extra requests**: both are rows in
the same chain response its fetch plan already retrieves once per
symbol+expiry. Its `focused` field is what the position arithmetic uses — the
R-multiple must be measured against the contract the user actually declared an
entry on, never silently substituted with the opposite leg's price.

## Two bugs the work surfaced

- **`readsContract` was single-strike logic left in place.** It compares against
  `reading.strike` — the one strike a focus was about. With a pair focus the PUT
  panel was being asked whether the CALL leg's strike matched it, so both legs
  could never be badged. Split into `readsLeg(focusStrike, drawnStrike)`.
- **The notification named one leg.** `instrument_label()` printed the focused
  leg only, so an alert said the strategy fired on "NIFTY 24200 CE" while the
  watch is a pair. Widened to both — and **the expiry was added at the same
  time**, because `NIFTY 24200 CE` names two different contracts across two
  series. `watchModel.instrumentLabel` and `instrument_label()` are documented
  as producing the same string, so both moved together; the Python tag is
  hand-formatted rather than `strftime('%b')`, which is locale-dependent and
  would silently break that guarantee under a non-English locale.

## Found on the way: the Strategy Feed rendered nothing at all

Reported as **"the strategy feed is missing"** — the dashboard band showed a
card, a card, and a hole where the feed belongs. Not caused by the pair work;
`StrategyTimelineFeed` opened with:

```tsx
if (loading) return null;
```

`Shell` carries the "Strategy Feed" heading, so during the watch-list fetch the
component rendered an **empty string**, and the grid column collapsed. A request
that never settles (sentinel-py down behind the 8s `SENTINEL_PY_TIMEOUT_MS`, a
stalled poll) is then **indistinguishable from a feature that does not exist**.

The second half is worse than a hole. `useWatchSessions` has always returned
`fault`/`reconnecting`; this panel **destructured neither**. So a failed
`/sentinel-py/watch` fell back to `watches: []` and the feed said:

> "Start watching a strategy to see live updates."

— instructing the user to create a watch when the truth was that the service
could not be reached, and hiding the watches they may already have had running.
Same shape as the 2026-08-17 "NIFTY has no live option chain" message that
contradicted itself while the real fault was a refused credential: **the UI had
no way to say "I could not find out", so it said the only other thing it knew
how to say.** `SentinelStrategyWorkspace` already split these three states for
the same query — this panel now does too, in the same words, so one fault does
not read as two different problems.

⚠️ **Rule: a panel in a fixed layout slot must render its shell in every state.**
`return null` from a component that owns a grid cell is a layout hole, and a
layout hole is unattributable — the user cannot tell it from a missing feature,
a crash, or a permission they lack. Pinned by `strategyFeedStates.test.tsx`,
which asserts `html !== ''` for the loading branch specifically.

## Deliberately NOT changed

`services/sentinel/src/sentinel-intelligence/visual/workspace.service.ts` still
has a `selectedStrike`. It is a **read-only chain table** rendered around
whatever strike a natural-language question mentioned, in the TS Sentinel's
intelligence workspace — it creates no watch, subscribes no data and feeds no
chart. It never carried a pair, so it is not a place the pair collapses.

## Verified / not verified

- `apps/web`: **601 passed** (36 new `optionPair`, 16 new `StrikeCombobox`, 9
  new `strategyFeedStates`, 7 new `SentinelLiveCharts`, 21 extended
  `optionChain`), `tsc --noEmit` clean,
  `next lint` clean (one pre-existing unrelated warning), `next build` clean.
- `services/sentinel-py`: **304 passed** (25 new in `test_watch_pair.py`).
- `services/api`: **455 passed**, unchanged — the proxy is a transparent JSON
  pass-through (`body: unknown`), so the pair travels untouched and
  sentinel-py's 400 is forwarded as a real 400.
- `packages/database`: `prisma validate` clean; migration
  `20260818120000_watch_session_option_pair` is **additive only**, every column
  nullable or defaulted, no backfill required.
- ⚠️ **Not driven in a browser and not run against a live chain.** The live path
  needs Postgres + api(4000) + sentinel-py(4011) + the Dhan bridge on a 24h
  token, and the chain reads only return during market hours on a trading day.
  What is asserted is the state arithmetic, the validation, the rendering
  (`renderToStaticMarkup`) and the request/persistence contracts; what is **not**
  asserted is that a real `/instrument/option` response resolves for every
  strike the chain lists. **First live session on a trading day is the check
  that matters** — specifically whether a strike present in the option chain can
  be absent from the scrip-master snapshot the bridge booted with, which is the
  `unresolvable` branch and would block "Start watching" for a leg that visibly
  exists in the dropdown.
- ⚠️ The dropdown's **open list is not render-asserted** — `renderToStaticMarkup`
  runs no effects and the combobox starts closed, so list contents are asserted
  through the pure `strikeOptions`, and the readout through rendering.
