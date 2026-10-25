---
type: decision
date: 2026-09-07
tags: [decision, architecture, charts, crypto, commodities, paper-execution, multi-market]
---

# Multi-market experiment (BTC, Gold) — architecture findings and the chart-reuse verdict

Audit performed before writing code, to answer: can the same strategy framework
trade Indian equities/options, BTC and Gold, and can the "advanced crypto chart"
be reused for NSE?

## The chart question, answered first — the premise was inverted

The brief assumed there is an advanced crypto chart that Indian markets lack, and
asked whether it can be reused for NSE. **It is the other way round.**

There are exactly two chart implementations in the repo, and only one charting
library in any `package.json`: `lightweight-charts@4.2.3` in `apps/web`.

1. **`components/charts/TradeChart.tsx`** — lightweight-charts, Apache-2.0. Draws
   OUR bars, our price lines, our themed tokens, plus a custom series primitive
   (`ChartDrawingsPrimitive`) for zones and trendlines. This is the Indian-market
   chart **and it already renders BTC natively today**: `lib/hooks/useCandles.ts`
   routes on `InstrumentRef.candleSource`, and `binance` goes to
   `GET /crypto/candles/:symbol`, which returns the same `Candle[]` shape.
2. **`components/charts/TradingViewWidget.tsx`** — TradingView's embed widget, a
   **cross-origin iframe** used on the /markets board for crypto and spot FX. It
   is fed by TradingView's data, not ours.

So the "advanced crypto chart" is #2, and the verdict is:

> **It cannot be reused for Indian markets, and it must not be — but nothing is
> lost, because #1 already serves both markets.**

Why #2 cannot be reused, precisely — the limitation is **architectural
(cross-origin isolation), not data format, and not licensing of #1**:

- The widget is an iframe on `tradingview.com`. Nothing on our side can read a
  value out of it, overlay a line on it, set its timeframe, or even confirm it
  resolved the symbol. That kills the entire strategy-visualisation requirement
  (entry/exit/SL/target/signal-candle markers) by construction.
- Its prices are a **second, unreconciled feed**. `TradingViewWidget.tsx`'s own
  docstring already records this as the reason it is not used on rupee venues: a
  chart quietly disagreeing with the order ticket beside it is the exact class of
  error the no-fabricated-data rule exists to prevent.
- Licensing is a real but *separate* dimension: the free embed is iframe-only by
  design. TradingView's **Advanced Charts** library (the one with drawing tools
  that you self-host and feed) is a separately licensed product requiring a
  signed agreement — not something to assume is available.

**Therefore: one chart, `TradeChart`, for every market.** Requirement #5 needs no
new library. lightweight-charts 4.2.3 already exposes `series.setMarkers()`
(verified present in the installed `dist/typings.d.ts`) for signal/entry/exit
markers, `series.createPriceLine()` (already used for strategy strikes) for
SL/target/trailing-stop, and the existing drawings primitive for zones. The gap
is **plumbing, not capability**: no strategy-decision overlay data is fed to it.

## What is already reusable (do not rebuild)

- **Candle contract.** `Candle` from `@tradew/types` is identical across Dhan and
  Binance. `CandleInterval` = 1m/5m/15m/1h/1d is the common set.
- **Instrument model.** `apps/web/src/lib/instruments/types.ts` already declares
  capability per instrument — `quoteSource`, `candleSource`, `chartSurface`,
  `supportedIntervals`, `tradeable`. This is the market/instrument abstraction the
  brief asks for; it exists and just needs to reach the server side.
- **Crypto data path.** Binance quotes + klines, keyless, unlimited, already
  proxied through `services/api/src/crypto/`.
- **Gold data path.** MCX front-month futures are ALREADY resolved from the Dhan
  scrip master and subscribed at boot — see `COMMODITY_UNDERLYINGS` in
  `services/market-data/scripts/live-feed-server.ts`. `GET /candles?symbol=GOLD`
  works today against Dhan's historical API.
- **Crypto money model.** `CryptoWallet` / `CryptoOrder` / `CryptoPosition` already
  exist as a separate USD spot space with `Decimal(28,8)` / `Decimal(20,8)`.
  Deliberately NOT a widening of the rupee OMS — see the schema's own comment.
- **Strategy rules.** `services/sentinel/src/intelligence/strategy-rules.ts` is a
  declarative map of named predicates over a `MarketSnapshot`. Genuinely
  market-agnostic at the rule level.
- **`marketOpen` is already a parameter**, not a hardcoded read, throughout
  `execution-fill.ts`, `execution-freshness.ts`, `execution-policy.ts` and
  `position-decision.ts`. Market-awareness is therefore a *data-supply* problem in
  the execution core, not a rewrite.

## The real blockers (in order of severity)

### 1. `ExecutionIntent` is not a trade intent — it is an NSE index-option order

This is the load-bearing finding. The model requires `optionType` ('CE'|'PE'),
`strike`, `expiry`, `contractSymbol` (`UNDERLYING:YYYYMMDD:STRIKE:CE|PE`), `lots`,
and `quantity Int`. `ExecutionJournal` repeats the same required option columns.
`StrategyAdvisorService.sideInFocus` returns a CE/PE side.

BTC spot and a gold future have no strike, no expiry, and no CE/PE. A spot BTC
size is fractional, so `quantity Int` cannot hold it.

**Decision: do not widen this.** The brief forbids modifying the working Indian
path, and these columns are referenced by `Order`, journal, calibration and
learning. Instead, insert a market-neutral layer *upstream*:

```
Strategy → StrategySignal (neutral: symbol, bias, confidence, evidence,
                           entry/stop/target in the traded instrument's own
                           price space)
         → Execution Adapter (materialiser)
              ├── NSE options  → existing ExecutionIntent path, untouched
              └── spot (BTC, gold) → spot intent → CryptoOrder / MCX order
```

The option-selection step (ATM/ITM/OTM strike choice, expiry) is revealed by this
split to be a *venue-specific materialisation*, not part of the strategy.

### 2. Session assumptions hardcoded to NSE

Audited locations:

| Where | Assumption |
| --- | --- |
| `paper-execution.service.ts` | `SESSION_CLOSE_MINUTE = 15:30`; `runProfile` hard-gates on `isTradingDay && 09:15 ≤ m < 15:30` |
| `execution-policy.ts` | `SESSION_OPEN_MINUTE = 09:15`; `market-open` and `before-square-off` checks |
| `ExecutionProfile.squareOffMinute` | defaults 910 (15:10) — mandatory flatten |
| `execution-identity.ts` | IST date key for idempotency + daily counters |
| `sim/ist-time.util.ts` | DAY-validity order expiry at 15:30 IST |
| `execution-scheduler.service.ts` | `LEARN_AFTER_MINUTE = 15:45` |
| `sentinel/src/market-clock.ts` | NSE 09:15–15:30 + NSE holiday calendar |
| `strategy-engine.service.ts` | `idealSession` windows are IST 'HH:mm-HH:mm' |
| `MarketSnapshot.openingRange` | "first 30 minutes of the session" |

### 3. A live bug: MCX gold is stamped with the NSE session

`live-feed-server.ts` computes `marketStatus` with an NSE-only `isMarketOpen()`
and applies it to **every** quote including MCX commodities. Its own comment
admits this ("MCX runs a separate, longer session (until ~23:30 IST); this flag is
reported only for the NSE-listed indices/stocks/ETFs, not the commodities") — but
`toLiveQuote` stamps commodities with it anyway. Gold therefore reads `closed`
from 15:30 while MCX is still trading, and `execution-fill.ts` refuses fills when
`!marketOpen`. **A gold experiment loses two thirds of its session to this.**

Related known gap in the same function: no holiday calendar (a trading holiday
reports OPEN). Sentinel's `market-clock.ts` already fixed this for NSE by reading
`@tradew/market-data`'s calendar; the bridge has not been unified.

### 4. Universe has no COMMODITY market / MCX exchange

`UNIVERSE_MARKETS` = INDIA, USA, UK, FOREX, CRYPTO. `UNIVERSE_EXCHANGES` has no
MCX (`dhan.catalogue.ts` maps `MCX_COMM: 'NSE'`, which is wrong). The web
`COMMODITIES` list is still a mock array in `lib/mock/market.ts`.

### 5. Cross-market comparison has a currency problem

Indian P&L is INR, crypto P&L is USD. `PaperWallet` is rupees end-to-end with no
FX conversion anywhere in the path. A comparison table summing them is meaningless.
Comparison must be on **currency-free measures** (win rate, profit factor, R
multiple, % drawdown), with absolute P&L shown per-market in its own currency and
never totalled. `packages/market-data/src/universe/currency-policy.ts` already
holds the never-convert principle.

## Instrument choices

- **BTC = spot `BTCUSDT` on Binance.** Not perpetuals: `CryptoWallet`/`CryptoOrder`
  are spot-only by design (no margin, no leverage, no short), and perps would need
  a new adapter plus funding-rate accounting. Spot is what the infrastructure
  actually supports.
- **Gold = MCX front-month `GOLD` futures via Dhan.** Chosen because it is the only
  gold instrument with both a real quote feed and real candles already wired.
  Rejected: XAU/USD via Twelve Data (8 req/min free tier — the same reason FX is
  `chartSurface: 'embed'`), gold ETFs (thin, and NSE-session-bound anyway), spot
  gold (no feed). Caveat to carry: MCX GOLD is a 100g contract worth several lakh,
  so `GOLDM` (10g) may be the better paper-sizing instrument — decide when sizing.

## Risk isolation

The brief's requirement 7 is largely satisfied by construction: `ExecutionProfile`
already binds one (agent, strategy, market, account, environment, policy) tuple and
carries its own `accountUserId`, limits and `symbol`. One profile per market gives
isolated positions, orders, P&L and limits. What is missing is an explicit
**venue/adapter binding on the profile** so a BTC profile is structurally incapable
of reaching the NSE order path — today the adapter is implied by the code path, not
declared by the row.

## Links

- [[Decisions/2026-08-18 - Sentinel paper execution loop (execution capability, not a second Sentinel)]]
- [[Decisions/2026-08-30 - Autonomous paper agents (complete entry-to-exit cycle)]]
- [[Decisions/2026-09-07 - Autonomous paper lifecycle (kill switch, excursions, staged learning, partial exits)]]
- [[Patterns/2026-08-14 - Tara chart drawing layer (series primitive, FVG detection, the concept collision)]]
- [[Patterns/2026-08-16 - Sentinel charts on the bars the engine reads (the chart and the agent disagreed)]]
- [[Decisions/2026-07-18 - Market Data domain architecture review]]

---

## What was implemented (2026-09-07)

Phases 1–2 and the two read-side deliverables. **The spine, not the end-to-end
loop** — see "What is NOT done" below, which is the more important half of this
section.

### Venue sessions — `packages/market-data/src/calendar/venue-session.ts`

`nse-calendar.ts` explicitly disclaimed session hours ("stays with each
runtime's own clock"). That held while one window covered everything; a second
venue is exactly the pressure that broke it, in the same way it broke the
holiday list. Hours, calendar binding and **day boundary** now live per venue.

Three properties differ independently, and conflating them is the bug:
the *window* (continuous venues have none — null, never a 00:00–23:59 range
that still produces a midnight boundary), the *calendar*, and the *day
boundary* for risk resets (crypto rolls at **UTC** midnight, matching Binance's
own daily klines — rolling it at 15:30 IST would cut the day mid-US-session).

`venueMinutesToClose` returns **null**, not Infinity, for continuous venues:
Infinity sails through arithmetic and schedules a square-off for an instrument
that never closes.

MCX borrows the NSE holiday list as a documented approximation that errs toward
*closed* — cost is bars not observed, never a fill against a shut exchange.

### The live MCX bug, fixed

`live-feed-server.ts#toLiveQuote` stamped **every** quote — commodities
included — with an NSE-only session, while its own comment said MCX runs to
23:30. Gold read `closed` from 15:30 and `execution-fill.ts` refuses a fill on
`!marketOpen`, so a gold experiment lost two thirds of its session silently.
Now `isInstrumentVenueOpen(meta)` per quote. Also fixed in the boot-time
placeholder loop over `ALL_INSTRUMENTS`, which seeded commodities the same way.
The holiday calendar is unified in the same change (approved explicitly),
closing the "a trading holiday shows OPEN" gap Sentinel closed in Aug.

The snapshot's top-level `marketOpen` deliberately stays NSE: its two consumers
are option pricing and feed-freshness, both NSE-appropriate. **A single scalar
cannot answer "is the market open" once the snapshot spans two sessions**, and
per-instrument callers read the quote's own `marketStatus`.

### Market registry — `packages/market-data/src/universe/market-spec.ts`

`ExperimentMarket` (INDIA/CRYPTO/GOLD) is deliberately coarser than
`MarketVenue`: the venue decides *when trading is possible*, the experiment
market decides *which row of the comparison table a result belongs to*.
`executionStyle` (`long-option` | `spot` | `futures`) is the field that makes
the option path one case rather than the only case.

### Neutral signal + adapter port

`StrategySignal` carries direction, confidence, evidence and levels **in the
analysed instrument's price space**; translating to the traded instrument is the
adapter's job. `resolveAdapter` verifies rather than trusts the profile's
declared venue — same discipline as `ExecutionAccountService`'s scope check —
with four refusals, each a way a mislabelled row could otherwise order on the
wrong exchange.

Two adapters, each with one honest refusal that would otherwise be **silent**:
- **spot** refuses bearish signals (`spot-long-only`) because `CryptoPosition`
  cannot hold a short. Counted, never skipped — a silently dropped signal makes
  the crypto win rate a filtered statistic presented as a complete one.
- **futures** refuses when one lot exceeds the allocation
  (`lot-exceeds-allocation`). MCX GOLD is 100 g ≈ ₹10 lakh against a ₹10 lakh
  wallet, so a 20% allocation can never afford one — and an agent sized to zero
  lots looks exactly like an agent that found no setup.

### Chart annotations — requirement #5

`ChartAnnotationsService` + `GET /admin/execution/chart-annotations`. Rejection
spans **collapse by `checkId`**, not by `reason` (which interpolates live
numbers, so grouping by it collapses nothing — the same distinction
`execution-policy.ts` makes for `failedCheckId`). One NSE session is ~750
passes and a 24/7 agent ~2,880/day; a pin per pass buries the moment the reason
*changed*. Spans keep `passes` and `peakConfidence` — "blocked at 58/70" and
"blocked at 12/70" are the same refusal and different situations.

Option positions' levels are **withheld with a stated reason**: stop/target are
premium prices of the traded contract and cannot be drawn on the underlying's
axis. Exit markers read from `ExecutionOutcome` (the fill), not
`ExecutionPosition` (the decision).

Client side: `TradeChart` gained a `markers` prop over native
`series.setMarkers()`. **No new library.** `strategyAnnotations.ts` snaps
annotations to bars — lightweight-charts silently drops a marker whose time has
no bar, and a chart showing no decisions is indistinguishable from a bot that
made none. Out-of-range annotations are **dropped, not clamped**: clamping
stacks them on the left edge as a flurry that never happened.

### Cross-market comparison — requirement #6

`CrossMarketPerformanceService` + `GET /admin/execution/cross-market`. Built
only from closed `ExecutionJournal` rows. **There is no total-P&L field
anywhere in the response** — a caller cannot sum what is not there. Ranking is
on mean R (dimensionless, so a ₹ option and a $ coin are orderable); absolute
P&L is per-row with its own currency. Metrics are withheld below 20 trades.
Confounds (`longOnly`, `sessionKind`, `eodFlatten`) are reported per row, not
left to be inferred — otherwise "BTC suits this strategy" is unfalsifiable.

Caught during review: `avgR` and `expectancyR` were computing the same
quantity — for R-multiples the mean *is* the expectancy — so two columns would
have implied two corroborating measures. Collapsed to one.

### Evidence

42 new tests, all passing. `services/api` 1068 passed / 14 skipped across 65
files (was 1026); `apps/web` 786 passed across 46 files. Both services and the
web app typecheck clean.

## What is NOT done

The read side is complete; the **write side is not wired**. Specifically:

- `PaperExecutionService.runProfile` still builds option intents directly. It
  does not yet produce a `StrategySignal` or call an adapter.
- `ExecutionProfile` has no `venue` column, so the declared-venue check has
  nothing real to verify against yet. That is a migration.
- Spot fills have no writer: `CryptoWallet`/`CryptoOrder`/`CryptoPosition` are
  migrated but **still unwired by any code** (verified by grep — the only
  reference in the tree is a comment).
- Sentinel's `/execution/evaluate` still returns an option-shaped
  `sideInFocus` (CE/PE). A BTC signal needs Sentinel to emit a neutral read.
- No UI renders either the annotations or the comparison table; the endpoints
  and the pure mapping exist, the panels do not.
- `runProfile`'s session gate is still the hardcoded NSE window — it has a
  venue-correct clock available now but does not read it.

So: BTC and Gold can be **charted and analysed**, and the isolation boundary is
enforced and tested, but **neither can place a paper trade yet**.
