---
type: decision
date: 2026-08-31
tags: [decision, tara, assistant, sentinel, market-intelligence, analysis, boundary]
---

# Tara consumes the canonical market observation — one snapshot, three consumers

**Status:** shipped.

**Read before touching** `apps/web/src/lib/assistant/{analysis,commands,planner,domain-guard}.ts`,
`services/api/src/market-analysis/`, or
`services/sentinel/src/intelligence/market-observation{,.service}.ts`.

Related: [[Patterns/2026-08-14 - Tara chart drawing layer (series primitive, FVG detection, the concept collision)]] ·
[[Decisions/2026-08-30 - Autonomous paper agents (complete entry-to-exit cycle)]] ·
[[Gotchas/2026-08-11 - Sentinel feed fabricated a CE direction on signals that had none]]

---

## The problem

Asked to analyse a market, Tara said: *"That needs the analysis agents — reading
chart structure and interpreting option data is the next phase."* Meanwhile the
repository already contained a complete market-analysis engine, running in
production, feeding two autonomous paper-trading agents.

The forensic trace found **no missing engine — three plumbing gaps and one
policy gap**:

1. No chart-state contract. Timeframe was React local state in `ChartPanel`;
   the chart exposes no indicator state at all; only one component published
   bars; the crypto surface is a cross-origin TradingView iframe.
2. No analysis `AssistantAction`. The union had no variant, so no utterance
   could reach a market read — deterministic or otherwise.
3. `MarketSnapshot` is composed on every `/observe` and then **discarded**.
   `ObserveResponse` carries `marketProfile`, `marketBehaviour`, `signals`,
   `explanation` — and **not one raw indicator number**. There was no
   `GET /market-analysis`.
4. `domain-guard.ts` refused anything naming Sentinel beside an explain-verb,
   and the router's fallback refused every remaining market question.

## The decision

**Do not build a second analysis engine. Project the canonical one.**

```
MarketIntelligenceService.snapshot(symbol, interval)   ← the canonical MarketSnapshot
  ├─ SentinelOrchestrator        → /observe             premium verdict
  ├─ ExecutionEvaluationService  → /execution/evaluate  autonomous paper agents
  └─ MarketObservationService    → /market-observation  Tara (measurements only)
```

`snapshot()` gained an optional `interval` defaulting to `SNAPSHOT_INTERVAL`, so
every pre-existing caller reads exactly the bars it always did. `composeSnapshot`
is untouched and is still the single place indicators are wired.

## The load-bearing decisions

### 1. The boundary is MEASUREMENTS vs CONCLUSIONS, not "Sentinel"

The old guard over-approximated: it declined "what VWAP is Sentinel seeing"
while answering the identical question phrased without the word. Reading VWAP
off a chart is arithmetic anyone can do; gating it protected nothing while the
number stayed visible two centimetres away. What users pay for is Sentinel
deciding what the arithmetic **means**.

So: measurements cross (price, OHLC, volume, RSI/EMA/VWAP/MACD/CPR, support and
resistance, structure and its breaks, liquidity, regime, option-chain
aggregates, index-direction votes, freshness). Conclusions do not (`synthesis`,
`publication`, `sideInFocus`, `strategyAdvice`, `strategyMatches`,
`confidence`).

**Enforced by shape, not convention.** `MarketObservation` has no field a
verdict can travel in; `FORBIDDEN_OBSERVATION_FIELDS` is asserted by a test that
also greps the *serialized* payload, so a nested leak fails too; and
`services/api` re-checks and strips before the response leaves. Two independent
checks, the same posture `brain.ts` takes toward the model — if they ever
disagree, the stricter one is right.

`readIndexDirection` is included; `alignedOptionSide` is not. **The line between
an observation and an instruction runs exactly between those two functions.**

### 2. Narrowing the guard exposed a hole going the other way

`SENTINEL_EXPLAIN_RE` required an explain *phrasing*, so **"what strategy is
Sentinel using" and "sentinel setups today" reached no guard at all** — plain
requests for the premium verdict, unrefused. "What is Sentinel recommending"
was caught purely because it contains the words "what is". Naming Sentinel
beside a verdict word is now sufficient on its own, with a navigational escape
hatch (the same "a command verb wins" pattern `concepts.ts` uses) so "open
Sentinel strategies" stays a route. Net: **narrower on measurements, wider on
verdicts** — the shape it was always meant to have.

### 3. "Open Sentinel" was refused as off-topic

`matchNav` matches an item's sidebar label verbatim and Sentinel's label is
**"AI Sentinel"**. So the exact phrase the refusal copy, the capability reply
and `TRADEW-ASSISTANT.md` §6 all tell users to say fell through every resolver
and hit the remit fence. `NAV_SHORT_NAMES` (keyed by href, so a rename cannot
orphan an alias) fixes it. *A product that instructs users to say a sentence it
then declines is worse than one that never offered.*

### 4. The refusal-poisoning bug: two kinds of refusal, not one

> `"Find FVG in BTC crypto and draw"`

resolved perfectly on the whole utterance, then `AND_THEN_VERB` split it on
`draw`, the bare fragment "draw" carried no market vocabulary, `guardDomain`
refused it as off-topic, and that refusal **discarded the working plan**.

The insight: the split loop is only reached because the whole utterance
*already* produced actions. So an out-of-domain fragment is not evidence the
request is off-topic — it is evidence **the split was wrong**. Hard boundaries
still poison (that is why poisoning exists; `"show me the fvg and buy 50 lots"`
is still refused). An out-of-domain comprehension guess now falls back to the
whole-utterance resolution.

### 5. Symbol coverage is explicit, and classified BEFORE any fetch

Sentinel's provider is Dhan/NSE-only with no simulator fallback. The workspace
charts BTC from Binance inside an iframe nothing on our side can read. Running
NSE indicators over one market and presenting the result beside the other's
chart is fabrication — the class of error this repo has already been bitten by
twice.

`classifySymbol` runs before the request, so **a crypto ask makes no outbound
call to the NSE engine at all** (asserted structurally: the test spies on
`fetch` and requires zero calls). The refusal names the real data path rather
than claiming the feature is missing.

Crypto was *not* silently extended, though `composeSnapshot` is a pure function
of candles and Binance candles exist at `GET /crypto/candles/:symbol`. The
reason: `sessionSlice` groups by calendar day, and the opening range and CPR all
assume an exchange session with an open and a close. On a 24/7 venue those
produce numbers that are arithmetically real and economically meaningless.
**Crypto needs its own session model; it is not a routing tweak.**

### 6. The JSON is authoritative; no model is in the numeric path

The grammar resolves *what* to measure. `services/sentinel` measures it.
`analysis.ts` renders the payload verbatim. There is no arithmetic on the client
and no LLM anywhere between the measurement and the sentence. If RSI is 63.4 in
the response, 63.4 is what the user is told.

An unmeasurable value is `null` **with a reason in `unavailable`** — never a
zero. A `0` VWAP and an unmeasured VWAP are indistinguishable once they leave
the service, and the first is a lie.

`analyzeMarket` **is** in the LLM's vocabulary (unlike `chartDetect`): it names
a symbol and a timeframe and nothing else, so a hallucinated plan can measure
the wrong market but cannot invent a price.

### 7. Timeframe is a store field, never parsed from `seriesKey`

`workspaceStore.chartTimeframe`, published by `useChartDrawings`. The key's
format is load-bearing for drawing staleness and is
`SYMBOL|contract|timeframe` for an option chart, where the naive split returns
the contract. It also must exist before the first candle arrives, while the
pill does.

The request carries `{symbol, timeframe}`; the response carries `timeframe` (as
measured), `requestedTimeframe`, and a `timeframeNote` when they differ — the
weekly pill is read on daily bars **and says so**. Analysing different bars from
the ones on screen without saying so is the failure `SNAPSHOT_INTERVAL` exists
to prevent, one layer up.

### 8. The indicator single-source question, resolved upward

The 2026-08-14 note §8 said the chart overlays must extend
`apps/web/src/lib/sentinel/indicators.ts`. Two facts changed the answer: that
file has **no non-test callers** (`buildIndicatorStrip` is dead code), and the
repository already carries **three** implementations (`services/sentinel`,
`services/sentinel-py`, and it). The canonical source is
`MarketIntelligenceService`, reached over the wire; `apps/web` computes no
indicator at all. Reviving the dead copy would have made a fourth.

## A pinned known behaviour

`ema()` returns a series from whatever it is given rather than refusing, so a
50-period EMA over three bars is real arithmetic and meaningless economics. The
engine's answer to that is the **freshness gate**, not a threshold inside the
indicator — so the projection reports the EMA *and* fails freshness with the bar
count. Adding a bar-count rule inside the projection would have put a fourth
opinion about "enough history" in the repository.

## Evidence

- `services/sentinel` 608/608 · `services/api` 674 passed + 14 skipped ·
  `apps/web` 705/705 — all green, including 24 + 15 + 31 + 23 new assertions.
- `tsc --noEmit` clean across api, sentinel, tradew-ai, web, admin, market-data.
- `next lint` clean (one pre-existing `exhaustive-deps` warning, unchanged).
- ⚠️ **Not driven in a browser and not against a live market.** The path needs a
  signed-in session, the Dhan bridge and `services/sentinel` running, during
  market hours. Every check above is unit-level.
