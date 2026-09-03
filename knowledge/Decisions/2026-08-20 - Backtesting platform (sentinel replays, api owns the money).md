---
type: decision
date: 2026-08-20
tags: [decision, backtesting, sentinel, strategy, market-data, paper-trading]
---

# Backtesting platform

A user-facing backtesting system that replays a strategy over stored `Candle`
rows and persists an immutable, reproducible result.

## The split, and why it is where it is

A backtest needs two things this repo already owns, in two different services,
and neither may be duplicated:

| Half | Owner | Why it cannot move |
|---|---|---|
| The STRATEGY — `StrategyEngineService`, `composeSnapshot`, indicators | `services/sentinel` | The agents and rules read `MarketSnapshot`; moving the walk out means shipping a snapshot per bar across a service boundary |
| The MONEY — `applyFill`, `computeMargin`, `CHARGES_RATE` | `services/api/src/sim` | A second implementation of average-price maintenance or short-option margin drifts from the paper wallet |

So sentinel answers exactly one question — *at which bars did this strategy
fire* — over `POST /backtest/scan`, **once per backtest, not once per bar**, and
`services/api` decides what a portfolio would have done about it.
`execution-simulator.ts` imports `applyFill` and `computeMargin` as pure
functions; that is the whole reuse, and it is why there is no second OMS.

`composeSnapshot`'s own docstring already anticipated this ("the Module 12
backtest replay both call this… there is no second, drifting copy of the
indicator wiring"). The seam existed; this built into it.

## Decisions worth keeping

**The lookback is imported, not repeated.** The replay windows bars to
`SNAPSHOT_LOOKBACK_MS` — the same constant the live `snapshot()` uses. A replay
that fed the strategy every bar since the backfill began would compute EMA(50)
over a window the live engine never sees, and would measure a strategy the
product does not run. Bounding the walk to linear time is the side effect, not
the reason.

**No look-ahead is a construction, not a discipline.** At bar `i` the strategy
sees `bars.slice(windowStart, i + 1)` and nothing else. Three subtler leaks are
closed explicitly: the fill bar is `i + 1` and is **null across a session
boundary**; `scan(snapshot, at)` gets the *bar's* timestamp so `idealSession` is
not judged against today's clock; and `priorDailyBar` is **strictly** before the
replayed bar's IST date, because the same day's daily bar contains that day's
high, low and close.

The tests are adversarial rather than expectation-based — they replace every
future bar with a 12,000-point spike, and truncate the series, and demand the
past does not move. A look-ahead leak makes results *better*, so it has no
symptom to assert on directly.

**Costs are itemised, never folded into the fill price.** `grossPnl - fees -
slippageCost = netPnl` holds exactly on every trade, and entry/exit columns show
the price the market actually printed. A P&L computed as `(exit − entry) × qty`
with costs waved at afterwards is the single easiest way to make a losing
strategy look profitable.

**Every ambiguity resolves against the trader.** A bar spanning both stop and
target is a STOP. A bar that *gaps* through the stop fills at the **open**, not
the stop — that difference is the entire risk of holding.

**Null is a result.** Sharpe below 20 trades, CAGR below 90 days, and profit
factor with no losing trade are stored as `null` with a stored reason, not
printed. `METRIC_MIN_SAMPLE = 20`.

**Immutability is the absence of a write path.** `BacktestService` has no update
method. Re-running a configuration makes a NEW row, which is what keeps
`Backtest A → strategy v1.3` reporting v1.3's numbers after the strategy is
edited.

## Two bugs the tests found

**A coverage off-by-one.** `tradingDatesBetween` counted a session whose market
open fell outside the requested window — IST is UTC+5:30, so a request ending
`23:59Z` reaches 05:29 IST the next day. Now keyed on the 09:15 IST session
open, which is the only question coverage cares about.

**The run LABEL was in the configuration hash.** `resolveConfig` spread the
whole request, so `label` and `sourceProfileId` landed in the stored config and
therefore in `configurationHash` — renaming a run made it a different
experiment, silently breaking the one thing the hash exists to answer. Fixed
with a key whitelist. **Found by `verify:backtest`, not by a type**: both fields
are legitimately part of the request type.

## Verified at runtime

`npm run verify:backtest -w @tradew/api` — 44 checks, production classes, real
Postgres, real Sentinel. NIFTY 15m 2026-05-01→08-11: 1,501 bars, 60 sessions,
146 trades, −₹25,396.59, max DD 2.54%, in 997 ms. The identity held on all 146
trades (worst deviation 0.0000); an uncovered period FAILED with a plain reason
and wrote zero rows; and **no Order, Trade, Position, PaperWallet or
ExecutionIntent row was created** — the structural claim that a backtest is not
the paper engine. 89 unit tests besides (23 sentinel, 66 api).

## The data limit that shapes everything downstream

**Zero historical option candles.** 33 OPTION instruments exist, not one has a
bar. Intraday history covers **five symbols only** — NIFTY, BANKNIFTY, FINNIFTY
(1m/5m/15m from 2026-04-24) and RELIANCE, COALINDIA (to 2026-07-22). Daily
covers 2,354 equities from 2025-12-12 via NSE bhavcopy.

Consequence, and it is not only a backtesting one: an option-leg backtest cannot
exist. The loop still closes if drawn one level up — the strategy fires on the
**underlying** (backtestable), and the option is how the read is *expressed*.
That is already how the paper loop is factored, since strike selection sits
deliberately off the observe contract.

Related: [[Decisions/2026-08-18 - Sentinel paper execution loop (execution capability, not a second Sentinel)]],
[[Plans/2026-08-20 - Agent Trading Laboratory (audit and architecture plan)]].
