# One canonical watch state — the controls were wired to nothing

**Read before touching `lib/sentinel/watchState.ts`, `lib/sentinel/WatchContext.tsx`,
`SentinelLiveCharts`, `WatchCreator`, `StrategyTimelineFeed`'s selection, or
before adding ANY market/strike control to `/sentinel`.** Related:
[[2026-08-16 - Selecting a market starts the watch (three charts read, trading days only)]]
(which made `/observe` read three series and gave the panel its `engineRead`),
[[2026-08-16 - Sentinel charts on the bars the engine reads (the chart and the agent disagreed)]]
(which established that a chart captioned "what Sentinel is reading" must be
drawn on the bars the engine received), and
[[2026-08-05 - Sentinel workspace premium redesign (two-column rail layout)]]
(where the three-chart panel was built).

## The bug, and the exact commits

> "The market and strike selectors no longer control the charts. They used to."

They did, and the wiring was removed in two steps, neither of which looked like
a removal:

1. **`5c651e2` (2026-08-11, reference-design dashboard)** rebuilt the page and
   dropped `SentinelLiveCharts` from it. That deleted the lifted state and the
   line that fed it:
   ```tsx
   const [ceStrike, setCeStrike] = useState<number | null>(null);
   <OptionChainPanel symbol={symbol}
     onSelectionChange={({ ce, pe }) => { setCeStrike(ce); setPeStrike(pe); }} />
   <SentinelLiveCharts … ceStrike={ceStrike} peStrike={peStrike} />
   ```
   `OptionChainPanel` **stayed in the toolbar** with `onSelectionChange` no
   longer passed. It is an optional prop, so nothing failed: the panel kept
   rendering, kept polling, kept letting the operator pick strikes, and wrote
   them to state no one read. For five days there was no chart to be wrong.

2. **`5349103` (2026-08-16)** put the charts back — inside `SentinelDashboard`,
   with `ceStrike={null} peStrike={null}` as literals. `SentinelLiveCharts` has
   an ATM fallback for exactly that null (`ceStrike ?? chain.ce[chain.atmIndex]`),
   so it silently resolved its own nearest expiry and its own at-the-money pair
   off its own chain poll. **The panel worked perfectly and was answering a
   different question from the one the operator was asking.**

⚠️ **The failure mode to learn from: an optional prop that was load-bearing.**
Dropping `onSelectionChange` was a silent behaviour deletion, and the fallback
one layer down converted "nobody told me the strike" into a confident, wrong
answer. A default that makes a disconnected component look connected is worse
than a crash.

## Four copies of one fact

By 2026-08-18 the page held four independent market/strike states:

| Where | What it held | What it drove |
| --- | --- | --- |
| `SentinelWorkspace` | `useState(DEFAULT_MARKET)` | `/observe`, toolbar `MarketSelector` |
| `OptionChainPanel` | own `ceStrike`/`peStrike` | **nothing** |
| `WatchCreator` | own symbol/expiry/side/strike, behind a SECOND `MarketSelector` | the watch it created |
| `SentinelLiveCharts` | own chain poll → nearest expiry + ATM | the three charts |

Two market dropdowns that could not agree, a strike picker connected to
nothing, and charts listening to neither.

## The rule this establishes

> **A surface may have one editor of a fact and any number of readouts. It may
> not have two editors.** If a second control is genuinely wanted, it binds to
> the same state — it does not get its own copy.

`WatchSelection` (`watchState.ts`) is that one fact: symbol, expiry, side, call
strike, put strike, underlying-only, selected watch id. `WatchContext.tsx` owns
it, and "Watch market" is the editor. The freed toolbar space became
`WatchContextBadge` — a **readout**, deliberately not a control.

### Timeframe is in the resolved context, not in the state

The brief asked for `timeframe` in the canonical state. It is **not** there, on
purpose: the series is whatever the ENGINE reads — `SNAPSHOT_INTERVAL` (15m) for
`/observe`, `rules.timeframe` for a sentinel-py watch — resolved through
`chartFocus.resolveSeries`, which also reproduces the bridge's silent `?? '5'`
substitution. A user-settable timeframe here would put the chart back on bars
the engine never read, undoing the 2026-08-16 work one level up.

### "What is drawn" and "what is read" are different questions

The subtle half of the fix. `SentinelLiveCharts` resolved both from one
expression:

```ts
const reading = focus ?? engineRead;
const effectiveCe = reading?.strike ?? ceStrike ?? chain.ce[chain.atmIndex]?.strike;
```

So even after the strike controls were reconnected, `/observe`'s own ATM read
would still have overridden the operator's pick the moment an observation
landed. Now:

- **drawn** = the canonical selection, always.
- **read** = whichever engine reported, and it supplies only the SERIES and the
  per-panel badges.
- `readsContract()` withholds "Sentinel reads this" when the engine's contract
  is not the one on screen, and an amber line **names the strike the engine
  actually read**.

That is also where the three-strike distinction lives. `/observe` resolves its
own ATM pair and `execution/strike-candidates.ts` resolves ITM/ATM/OTM from the
real chain; neither is the operator's watch context, and both are allowed to
differ. **The requirement is that the difference is stated, not that it is
eliminated** — collapsing them would either hide an evaluation or fake one.

## One chain poll, not three

`useOptionChainStrikes` polls every 4s against a bridge that serialises
option-family calls behind a **3.1s floor**. Three components called it on
`/sentinel` simultaneously. It is now called **once**, in the provider, and
fanned out — the same fix `useSentinel` documents for `/observe` and
`useDhanLiveFeed` for the tick stream. **Do not add a second call site.**

## Stale instrument data, found on the way

Three hooks kept the PREVIOUS instrument's data while loading the next one's.
Two were invisible (a gated `status` meant nothing drew), but the third was not:

`useOptionQuote` held the old contract's LTP across a strike change, and
`SentinelLiveCharts` feeds that LTP to `sanitizeOptionCandles`, which **rescales
the entire series against it**. A stale quote did not merely mislabel the last
price — it silently re-priced every bar of the new contract's chart. All three
now clear on instrument change. Note the distinction preserved inside
`useOptionQuote`: a row vanishing from the chain for the SAME contract still
keeps the last value, which is a different and correct behaviour.

## Verified / not verified

- `apps/web`: **519 passed** (34 new `watchState`, 14 new `SentinelLiveCharts`),
  typecheck clean, lint clean, `next build` clean.
- **Driven against the live Dhan bridge**, via a scratchpad harness that mounts
  the real provider, the real `WatchCreator` and the real chart panel (the
  `/sentinel` route itself is behind a login the agent session could not pass).
  Confirmed on a live session: expiry auto-resolved to the real nearest
  (NIFTY 18 AUG, SENSEX 20 AUG); ATM resolved from the real ladder to a LISTED
  strike (NIFTY 24150 at spot 24154.9; SENSEX 77200 at spot 77235.46); strike →
  chart, expiry → chart and market → chart all propagated; the created watch's
  payload carried the identical instrument.
- **Subscription lifecycle observed in the network log**: a strike change
  refetched ONLY that leg — the opposite leg and the index feed were untouched;
  an expiry change refetched both legs and not the index; a market change
  retired the previous symbol's chain poll immediately and started exactly one
  new one. No duplicate subscriptions in any transition, and a reload restored
  the same instruments.
- ⚠️ **Not verified with a signed-in browser on `/sentinel` itself**, so the
  entitlement path, the `/observe` engine badge and the Strategy Feed's
  reconciliation against real server watches are covered by unit/render tests
  and by reading, not by a live session.
- ⚠️ **`useOptionCandles` has no refresh timer** — pre-existing, unchanged here.
  Contract history is fetched once per contract; the live premium reaches the
  chart only through `liveLast`. The index series refreshes every 60s. Worth
  fixing separately.
