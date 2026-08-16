---
type: pattern
date: 2026-08-16
tags: [sentinel, ui, dashboard, honesty, sentinel-py, timeline]
---

# Sentinel reference dashboard band (what the mock asked for that the platform cannot know)

**Read before adding any panel to `apps/web/src/components/sentinel/dashboard/`, before wiring a figure into `SessionStats`, and before touching `lib/sentinel/sessionTimeline.ts` or `sessionStats.ts`.**

A reference screenshot was integrated as the band directly below the "What Sentinel is reading" chart panel: strategy feed (scrolling) · your conditions · risk radar + emotion report, then the session timeline across the two right columns, then session stats · quick actions · market context. See [[Patterns/2026-08-16 - Sentinel charts on the bars the engine reads (the chart and the agent disagreed)]] for the reading panel this sits under.

## The load-bearing finding: a mock is a list of claims, not a layout

Six of the mock's figures had **no data source anywhere in TradeW**, and each would have rendered as a confident number on every page load:

| Mock says | Reality | What ships |
|---|---|---|
| FII: Net Buyer (+1,234 Cr) · DII: Net Buyer (+1,890 Cr) | no institutional-flow feed existed **when this was written** | ✅ **now real** — see the update below |
| Global: Mixed | no global-markets feed | absent |
| News Impact: Low · Upcoming: U.S CPI Data | no forward news calendar — a *stated* gap since [[Patterns/2026-08-06 - Sentinel Phases 2-6 (behaviour, lifecycle, calibration, annotations, cross-validation)]] | absent |
| Position Size: Dynamic (based on volatility) | sizing advice is **advice** — root `CLAUDE.md` Rule 2 | slot carries the strategy's *optional confirmations* instead |
| "Position size recommended: 75%" (feed) | same | never rendered; asserted by test |
| Win Rate / Avg R:R "(Simulated)" | these are the user's **real** recorded outcomes | label corrected — mislabelling real data understates it as badly as the reverse overstates it |

> **Update, same day.** Three of those six turned out to be obtainable after all — just not from where everyone assumed. FII/DII cash flow, participant-wise derivatives OI and real advance/decline breadth now come from **NSE's own free public endpoints**, not from the Dhan token (which has no such endpoint anywhere in its surface). See [[API/2026-08-16 - NSE public data (FII-DII, participant OI, breadth) — what Dhan cannot give you]]. The rail's footer shrank accordingly but did not disappear: global breadth and the macro calendar remain genuinely unavailable and are still named. **The end-of-day caveat is now the load-bearing one** — those figures describe a *completed* session, so they render under their own dated heading rather than beneath the panel's "Live" indicator.
>
> Worth keeping from the original finding: the correct move when a mock asks for data you do not have is to say so on screen, **then go and check whether it exists** — not to fill the slot with a constant. Two of the six were a research question, not a data gap.

The rule that came out of it: **an unavailable dimension is named, not silently dropped.** A reader who knows the reference should be able to tell "Sentinel measured this as low" from "TradeW cannot see this at all"; omitting the row collapses those two into one.

`extractMarketContext` already returned a `known` flag per dimension — the rail renders `known: false` in muted italic rather than deciding for itself, so exactly one module owns that judgement.

## The bug the band surfaced: the session timeline was ordered by *append*, not by *time*

`MarketTimelineEngine.entries()` returns entries in the order it was told about them. The 2026-08-13 autonomy fix made the engine stamp a detection with `detectedAt` — **the bar its rules matched on** — while guidance entries keep the poll clock. Both are correct; together they mean a detection recorded on the 10:20 poll can carry a 10:05 bar time and still be appended **after** a 10:18 guidance entry.

The track renders left-to-right as a chronology, so the list arriving *almost* sorted is the worst case: it looks right most of the time, and the occasional out-of-sequence entry reads as the market having done something at a time it did not. Fixed in the new pure `lib/sentinel/sessionTimeline.ts` by sorting on `at` (the ISO instant) — **never on `time`**, which is a `HH:mm` string that cannot order across a day boundary. Ties keep input order: several detections genuinely share one candle's timestamp, and re-ordering them would assert a sequence the data has not got.

Also there: the engine writes one prose sentence per entry and the layout wants a label above a detail, so the sentence is split at **its own punctuation** (`" — "`, `": "`) with a length cap. Past the cap the split is declined and the level's title is used — no text is invented, none is lost. The existing `dashboardModel.test.ts` assertion moved from `detail` to `title` as a result.

## Two arithmetic traps in the stats aggregate

`lib/sentinel/sessionStats.ts` is pure and tested because the grid is eight numbers in a row, and nothing on screen distinguishes a figure built from fifty outcomes from one built from zero.

1. **Performance is keyed by STRATEGY, not by watch.** A strategy's funnel already counts every watch that ran on it, so fetching per watch and summing reports three outcomes where one happened. `strategyIdsOf` de-duplicates and the hook fetches once per distinct strategy.
2. **Expectancy must be weighted by completed count.** Unweighted, a strategy with one lucky `+3.0R` outcome outvotes another with thirty-nine at `-1.0R` and the tile reads `+1.00R` instead of `-0.90R`.

And the rule this vault has now paid for twice: **a rate never travels without its sample size.** `winRate` carries `decided`, and `winRate` is `null` (not `0`) when nothing has been decided — zero would claim every outcome failed. Counts stay `0`, because a count of nothing genuinely is none. Still-open positions are excluded from the denominator or every win rate sags for as long as a trade runs.

## The follow-up: measure the mock, don't eyeball it (same day)

The band shipped at `4/4/4` across the top row with the timeline at `8`. Held against the reference that is visibly wrong — the strategy feed is the widest panel in the image, not an equal third. Measuring the reference instead of estimating it:

| Row | Panel widths in the reference | As twelfths |
|---|---|---|
| feed · conditions · radar | 550 · 392 · 430 (of 1372px content) | **5 / 3 / 4** |
| stats · actions · context | 550 · 472 · 352 | **5 / 4 / 3** |

Two things fall out that guessing would not have produced. First, **the two rows do not share a column split** — quick actions starts on the conditions panel's left edge but ends 80px past its right edge. Aligning them "for tidiness" is a change to the design, not a cleanup. Second, the bottom row's measurement came out at exactly the `5/4/3` already in the code, which is what makes the top row's `5/3/4` trustworthy: the method was validated against a row that was independently known to be right before it was used on the row that was wrong. The session timeline follows from the feed at `12 − 5 = 7`, not from a second measurement.

Worth keeping: a screenshot that looks cropped may not be. This one reads as cut off at the right edge, but the radar panel's own "Real-time" label sits at x≈1405 and the sum of the measured widths plus gutters plus padding reproduces the image width to within 3px — so the full band is present and measurable. Checking whether the numbers close is what distinguishes a measurement from a guess dressed as one.

## Live Market Overview: two charts of one index, disagreeing

Removed from the dashboard the same day and archived to `archive/web-sentinel-live-market-overview-2026-08-16.tsx.txt` (a git-tracked rename, per root `CLAUDE.md` Rule 1 — no content left the repo).

It rendered real Dhan candles for the selected market with a computed EMA20 · RSI14 · VWAP · MACD · OI · Volume strip, and it was honest about missing history. The problem was never accuracy — it was that it drew **the same instrument** as the "What Sentinel is reading" panel one card below it, on a timeframe the *user* picked from a tab strip rather than the bar the *engine* evaluates. Two candle charts of one index on one screen, implicitly disagreeing about which bar matters. The reading panel is the one tied to the engine's own timeframe (see [[Patterns/2026-08-16 - Sentinel charts on the bars the engine reads (the chart and the agent disagreed)]]), so it is the one that stayed.

The generalisable bit: **duplication on a dashboard is not redundancy, it is ambiguity.** A second view of the same underlying series does not reinforce the first — it forces the reader to work out which one is authoritative, and nothing on screen tells them.

`lib/sentinel/indicators.ts` and its tests are deliberately left in the tree despite losing their only consumer: the module is pure, independently tested, and `SentinelChartReading` is the natural next caller. `chartFocus.ts`'s `DAYS_FOR` table used to be documented as mirroring the removed card's tabs and now owns the mapping outright.

## Smaller decisions worth not re-deriving

- **"View all" → scroll.** The feed is already collapsed server-side (`_collapse` turns forty identical FORMING sweeps into one card), so a cut-off hides older *distinct* events, not repetition — and a link that navigates away from a live surface is a link away from the thing that is updating.
- **Three poll cadences on one screen, deliberately.** `/observe` at 45s (radar, emotion, timeline, context, status cards); the feed and the new `useSessionStats` at 10s against `services/sentinel-py`, because that sweep re-evaluates every 15s. Tying the user's own watches to the slower poll leaves a confirmed setup reading unconfirmed for most of a minute. Each degrades alone.
- **`StrategyFocusPanel` is suppressed in the dashboard** (`showFocusPanel={false}`, defaulting true so no existing caller changed) — its condition list would otherwise be the same ticks twice, side by side with the new conditions panel, and its history half is what the stats grid aggregates.
- **`timeline.py` renames at the boundary.** The columns are `stopPrice`/`targetPrice`; the payload is `invalidationPrice`/`projectedPrice`, matching `OpenPositionRequest`'s existing vocabulary. Nothing downstream needs to know the old names, and a test asserts the order-type words do not survive the boundary.
- **Edit scrolls, it does not route.** The conditions panel's Edit control scrolls to the strategy workspace anchor; a navigation away and back would unmount and restart every poll on the page.
- **`items-start` on the band grid.** Without it the grid stretches every cell to the tallest row, padding the emotion report to the height of a long feed.

## Verification, and what was NOT verified

390/390 web tests (38 new: `sessionStats.test.ts` 15, `sessionTimeline.test.ts` 12, `StrategyConditionsPanel.test.tsx` 11), 248/248 sentinel-py tests (3 new), `tsc --noEmit` clean, dev server compiles the route (1483 modules, no errors).

**Not driven in a browser.** `/sentinel` is behind auth + the `sentinel` capability + an active watch, and the live path additionally needs Postgres, `services/api` (4000), `services/sentinel` (4010), `services/sentinel-py` (4011) and the Dhan bridge (4600) with a same-day token, during market hours. Same standing limit as the reading panel above it — the zero-samples problem this band would measure is the one it cannot itself resolve.

**Re-verified after the column re-measure and the Live Market Overview removal:** 450/450 web tests, `tsc --noEmit` clean. Still not driven in a browser, for the same reason — `middleware.ts` bounces an unauthenticated request to `/?next=%2Fsentinel#auth` before the dashboard renders at all, so the redirect is the only thing a session-less browser can observe. The column split was therefore verified as arithmetic (5+3+4 = 12, 5+7 = 12) against a measured reference, not as pixels on a running page.
