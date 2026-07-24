---
type: pattern
date: 2026-07-24
tags: [sentinel, backtest, strategy, market-data, indicators]
---

# EMA-cross backtest engine (Sentinel, on real Dhan data)

First **backtesting** capability in the repo. Measures how a *user-defined* rule
would have behaved on historical bars and reports statistics — it is
**observation/education only** (ARCHITECTURE.md §3–4, [Rule 2](../../CLAUDE.md)):
no live Buy/Sell/Entry/Target signal, never wired into the order flow. A
`BacktestTrade` is a record of a hypothetical past trade, not an instruction.

## What was built
- `services/sentinel/src/backtest/` — `types.ts`, `ema-cross-strategy.ts` (the
  pure trigger predicate), `engine.ts` (walk-forward simulator + stats).
- `services/sentinel/scripts/backtest-ema-cross.ts` — runner. `npm run backtest:ema`.
- Reuses the existing `ema()` from `intelligence/indicators.ts` and reads bars
  through the same `MarketDataProvider.getCandles()` contract that serves
  production data — so the substrate is swappable with zero engine changes.

## The rule (v1 — the user's "just EMA" scalp, stated precisely so it can be measured)
Long trigger at the close of bar *i*: **bullish** (`close>open`) **AND** EMA passes
through the bar (`low ≤ ema ≤ high`) **AND** closes above it (`close>ema`). Optional
`requireFreshCross` also demands the prior bar sat at/below its EMA (a genuine
reclaim, not a mid-trend re-trigger). Fill = **next bar's open** (no look-ahead);
stop = signal low; target = entry + R:R·risk; stop-checked-first per bar; timeout
+ cooldown supported. Long-only, matching the described setup.

## Finding 1 — the simulator is NOT a valid substrate for strategy validation
`packages/market-data/.../ou-engine.ts::simulateCandles` applies a **constant**
downward drift (`-θ·0.1`), not a real mean-reversion (`-θ·(logPrice-logAnchor)` —
which `simulateQuoteAt` *does* use correctly). Result: it grinds one direction, so
only **8–16 % of bars are bullish** (should be ~50 %) and a long-reclaim setup
essentially never appears (0–1 triggers across a 10-symbol basket, 500 bars each).
It also caps at 500 bars and ignores session boundaries. Fine as a *fallback feed*;
useless for judging a strategy. **Do not report simulated backtest numbers as
evidence a strategy works.** (Left the engine as-is; did **not** rewrite the shared
simulator — that changes behaviour for every consumer and is out of scope here.)

## Finding 2 — real data available for backtesting (as of 2026-07-24)
`Candle` table (`source='dhan'`), ~3 months **2026-04-24 → 2026-07-23**:
- **15m**: NIFTY/BANKNIFTY/FINNIFTY 1567 bars, RELIANCE/COALINDIA 1550.
- **1d**: 61 bars each. Same 5 symbols.
- **No 1m/5m yet** — true scalping timeframes require extending
  `services/market-data/scripts/backfill-candles.ts`. See [[2026-07-23 - Candle table + Dhan backfill (Sentinel on real data)]].

## Finding 3 — v1 results on real 15m data (gross, no costs, long-only)
The bare "just EMA" rule is **breakeven-to-losing everywhere** — it is not a
standalone edge, which matches the user's own "it doesn't work every time / fake
spikes." `requireFreshCross` is the first real lever: it flips **indices** positive
but does **not** help **stocks** — i.e. this behaves like an index-mean-reversion
pattern, not a stock pattern.

| symbol | bare expectancy | fresh-cross expectancy |
|---|---|---|
| NIFTY | −0.02R (−2.6R) | **+0.04R (+4.4R)** |
| BANKNIFTY | −0.09R (−12.4R) | **+0.01R (+1.6R)** |
| FINNIFTY | −0.12R (−14.8R) | −0.03R (−2.8R) |
| RELIANCE | −0.22R (−25.5R) | −0.24R (−26.1R) |
| COALINDIA | −0.26R (−31.6R) | −0.34R (−36.0R) |

Win rate ~26–35 %, avg win ≈ +1.9R vs avg loss ≈ −1.0R (as designed at 1:2). Max
losing streak reached 15 on NIFTY — the drawdown reality behind "fake spikes".
Note: total-**R** and total-**points** can disagree in sign (R normalises each
trade by its own risk); R is the risk-adjusted truth, points is raw.

## Open / next
- Backfill **1m/5m** so the real scalping timeframe can be tested (the screenshots
  are ~1–5m, not 15m).
- Model **costs** (spread/slippage/brokerage) — a gross-breakeven rule is net-losing.
- Session-awareness (drop overnight-gap "bars"); confirm the exact entry rule with
  the user; layer the trap/volume/trend filters ([[../Gotchas/2026-07-23 - Sentinel not working was four stacked config+build faults]] area) as Phase 2 fake-spike defence.
- Phase 3: surface as an observation-only "Strategy Lab" panel in the `/sentinel`
  workspace ([[2026-07-24 - Sentinel live data across the full universe]]).
