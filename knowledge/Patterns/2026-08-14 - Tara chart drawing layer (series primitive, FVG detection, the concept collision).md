---
type: pattern
date: 2026-08-14
tags: [pattern, tara, assistant, charts, lightweight-charts, detection]
---

# Tara chart drawing layer — series primitive, FVG detection, and the collision that answers a question by drawing on a chart

Weeks 1–2 of the Tara build order. **Read before touching
`apps/web/src/lib/charts/`, `TradeChart.tsx`, or adding any command to
`commands.ts` whose vocabulary overlaps `concepts.ts`.**

Related: [[Plans/2026-08-11 - AI Operating System (eight layers, Phase 1 spine shipped)]] ·
[[Patterns/2026-07-26 - TradeW AI assistant control layer (Comet-style app control)]] ·
[[Gotchas/2026-08-11 - Sentinel feed fabricated a CE direction on signals that had none]]

---

## 1. Rendering is a Series Primitive, and 4.1 is now a hard floor

The plan called for a custom canvas stacked over the chart. That is the wrong
shape and the version pin says so: **`lightweight-charts@4.2.3` exposes
`series.attachPrimitive()`** (Series Primitives landed in 4.1).

An overlay canvas has to re-implement coordinate conversion, device-pixel-ratio
scaling, clipping and repaint scheduling — and then stay in sync with a chart
that repaints on its own schedule, so it lags a frame on every pan. A primitive
draws *inside* the chart's render pass and is pixel-locked for free.

**Consequence: dropping below 4.1 deletes the API `drawingPrimitive.ts` is
built on.** Not a soft dependency. Zones render at `zOrder: 'bottom'` (a
translucent band over a candle body mutes the up/down colour the bar exists to
communicate), lines at `'normal'`.

Two smaller decisions worth not re-deriving:

- **Translucency is `globalAlpha`, never a string-edited colour.** The design
  tokens are authored in several formats and appending an alpha channel to a
  value you did not parse is how `bg-up/15` became a silent no-op elsewhere
  (see [[Patterns/2026-08-05 - Sentinel workspace premium redesign (two-column rail layout)]]).
- **`fancy-canvas`'s render-target type is declared structurally, not
  imported.** It is a transitive dependency of lightweight-charts; importing it
  directly makes `apps/web` depend on a package it never declared, which works
  until a hoisting change removes it.

## 2. Geometry is pure and injected, because every failure looks plausible

`resolveZoneRect` / `resolveLineSegment` take injected converters and are
tested without a canvas. This is not tidiness — **every failure mode in chart
geometry renders as a confident annotation stating a price level that was never
detected.** A zone clamped to the wrong edge still looks like a zone.

The rules, each of which was a bug waiting:

| Situation | Zone | Line |
|---|---|---|
| Price bound off the scale | **null** — height unknown, don't draw | null |
| Start time scrolled out of the series | clip to left edge | **null** |
| End time not a bar in this series | extend to right edge | n/a |
| Fully off-screen | null | null |

A line is stricter than a zone on purpose: **clamping a trendline endpoint
changes its slope**, and slope is the line's entire claim. `extendRight` is
applied along the two real points, never toward a guessed price.

`candleTime()` is shared with `TradeChart` rather than duplicated. A drawing
time that disagrees with the series' bar time by one second is invisible —
`timeToCoordinate` returns null and the zone clamps left.

## 3. Erasure is tag-scoped, and replace is not merge

`DrawingTag` is the unit of erasure. `replaceDrawingsByTag` throws on a foreign
tag, so a detector cannot reach another producer's drawings, and there is
deliberately no "clear the chart".

**Replace rather than merge is load-bearing:** a detector's output is a
complete statement about the visible range, so a gap that has since been
mitigated must *vanish*. A merge leaves it on the chart forever.

## 4. FVG detection — the off-by-one that hides the whole feature

Three candles, no overlap: bullish is `a.high < c.low`, bearish `a.low >
c.high`. Strictly less-than — `a.high === c.low` is contiguous trade, and `>=`
manufactures a zero-height gap on every trending series.

> **Mitigation must start scanning at the bar AFTER the third candle.** `c.low`
> *is* the top of a bullish gap, so including bar `c` marks every gap mitigated
> by its own definition the instant it is found, and the chart draws nothing,
> forever, with no error.

Direction decides which side counts as re-entry — a bullish gap sits below
price and is entered by a bar whose **low** drops in; a bearish gap by a bar
whose **high** rises in. One test for both silently halves detection.
`mitigatedAt` (touched) and `filledAt` (traversed) are separate: conflating
them overstates how much of the move was retraced.

**Detection reports everything it finds — no default size filter, no cap.** A
detector that quietly drops "small" gaps asserts a threshold nobody chose and
the count it reports stops meaning what it says. Trimming for what Tara *says*
is `nearestGaps` at the call site, where it is visible.

## 5. The collision: a question answered by drawing rectangles

`router.ts` resolves commands **before** concept questions. That ordering is
safe for navigation ("open the FVG chart" really is navigation) and is a trap
for a detector, because *"mark the fair value gaps"* and *"what is a fair value
gap"* reach the same matcher with the same words.

Resolving the question as a command re-creates the exact regression
`concepts.ts` was written to fix — an explain-question answered with a page
visit — from the other end of the pipeline.

So `matchDetect` returns null on an explain-phrasing, **consulting
`concepts.ts`'s own exported `EXPLAIN_RE` rather than a second copy of it.**
Two definitions of "what counts as a question" is how this comes back. The one
exception is an utterance that names the chart as its subject ("what are the
FVGs *on this chart*"), which is a request to look.

## 6. The hard-boundary hole this work exposed

`IMPERATIVE_TRADE_RE` was anchored to the start of the utterance. The planner's
refusal-poisoning rule covers *"open the chart **then** buy 50 lots"* — a
strong connective splits it and the fragment `buy 50 lots` is anchored.

But a bare "and" splits only when a verb the grammar knows follows, and **"buy"
is deliberately not one of those verbs.** So:

> `"show me the fvg and buy 50 lots of nifty"` — never split, never matched,
> executed its innocent half and silently dropped the order.

That is precisely the outcome the poisoning rule exists to prevent, reached by
the one phrasing that skipped both mechanisms. Pre-existing, but **the
detection commands are what made the innocent half executable**, so it shipped
as a live hole in the same change that found it. The regex is now anchored
after a connective (`and`/`then`/`also`/`plus`/`;`/`,`) as well as at the
start; the `panel|ticket|form` lookahead is unchanged, so "open buy/sell panel"
still navigates.

**Lesson worth generalising: adding a command that matches a previously
unmatched phrasing can convert a dormant boundary gap into a live one.** New
grammar deserves a boundary test, not just a happy-path test.

## 7. Staleness: drawings carry the series they were computed on

Zones found on NIFTY 15m describe levels that mean nothing on RELIANCE 1D.
Rendering them there is the drawing layer's version of the fabrication class in
[[Gotchas/2026-08-11 - Sentinel feed fabricated a CE direction on signals that had none]].

Guarded three ways for one invariant, because a stale zone is silent: the
published series and the stored drawings both carry `seriesKey`
(`SYMBOL|timeframe`, the same string as the chart's `fitKey`); the store drops
drawings when the key changes; and `useChartDrawings` returns nothing unless
the two still agree.

Detection runs in `executeAction`, not in the resolver — **the resolver is pure
and has no candles, so it names the detector rather than emitting
coordinates.** A grammar that emitted zone prices would be emitting invented
numbers. `chartSeries` is not in the store's `partialize` allowlist; persisting
a few hundred candles to localStorage on every tick would be a real bug.

## 8. Indicator single-source (recorded before Week 4 builds it)

`apps/web/src/lib/sentinel/indicators.ts` **already implements** `ema`, `rsi`,
`vwap`, `macd` and `buildIndicatorStrip`, pure and covered by 12 tests — they
return the latest value only, not a series.

**Week 4's chart overlays must extend that file, not add
`technicalindicators`.** Two implementations would let the indicator strip and
the chart overlay disagree about RSI on the same candles with no way to
arbitrate which is right.

## 9. What was not done

- **Detection is one-shot**, not live. Zones are computed from the bars on
  screen when asked; new bars do not re-run it. Honest for now — the user asked
  at a moment in time — but re-running on candle change is the obvious next
  refinement.
- **`chartDetect` is not in the LLM's action vocabulary** (`brain.ts`
  `validateAction` allowlists, and its `default` drops unknowns). The
  deterministic grammar handles it; widening the model's vocabulary is a
  separate decision.
- Only the underlying chart in `ChartPanel` publishes a series. The option-
  contract chart does not yet.
- Verified by test and typecheck (281/281 web tests, `tsc --noEmit` clean).
  **Not yet driven in a browser** — no zone has been seen rendered.
