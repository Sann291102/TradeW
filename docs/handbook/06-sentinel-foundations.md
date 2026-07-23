# Chapter 6 — Sentinel: Foundations

> **Sentinel is TradeW's AI Market Intelligence System.** It observes market structure and the user's own trading behaviour, corroborates signals against each other, and produces calm, evidenced, non-directive observations. It has no authority over anything.

**Status: 🟡 Partial.** The four agents, the orchestrator, the Brain, the concept ontology, and the compliance trail are 🟢 real (~3,500 lines, zero stubs in `brain/`). The full 14-signal trap catalogue and parts of the workspace UI are 🟡. This chapter marks each claim.

---

## 6.1 Purpose

### 6.1.1 The question Sentinel answers

TradeW's two AI systems answer different questions, and the difference is the reason they are separate runtimes:

| | **TradeW AI (Research)** | **Sentinel (Safety Nets)** |
|---|---|---|
| Question | *"What does this mean?"* | *"Am I about to do something I'll regret?"* |
| Data | market data, company data, news | **the user's own trading behaviour** + market structure |
| Tone | explanatory | diagnostic and reflective |
| Trigger | user asks | continuous, ambient |
| Compliance posture | disclaimed | ⚖️ every observation logged with evidence and a SEBI category |
| Runtime | `packages/ai-core` (library, today) | `services/sentinel` (separate service) |
| Availability | every user | premium, entitlement-gated reasoning |

They are **deliberately separate systems, not two feature sets of one orchestrator.** Different question, different data, different tone, different compliance posture. Merging them would mean one prompt trying to be both explanatory and diagnostic, and one compliance posture covering both a research answer and a behavioural observation about a specific person's money.

### 6.1.2 What Sentinel is for, in one paragraph

A trader is about to buy a breakout. The volume is 62% of the twenty-bar average, open interest is declining, and this same trader has entered three positions today within fifteen minutes of a losing exit. None of those four facts, alone, is worth interrupting anyone about. Together they describe a specific, recognisable, and expensive situation. Sentinel exists to notice the *together*.

---

## 6.2 Goals

| # | Goal | How it is measured | Status |
|---|---|---|---|
| G1 | Surface only corroborated concerns | Ratio of triggered signals to surfaced syntheses stays low (target < 15%) | 🟢 enforced by the composite gate |
| G2 | Every observation carries evidence | 100% of `SentinelObservation` rows have a non-empty `evidence` array | 🟢 |
| G3 | Never block, delay, or gate an order | Order latency identical with Sentinel up and down (US-B4) | 🟢 architectural |
| G4 | Never produce directive language | Zero Buy/Sell/Entry/Target strings in generated output | 🟢 guardrails + deterministic fallback |
| G5 | Fully functional without an LLM | Deterministic composition produces the same structure | 🟢 |
| G6 | Learn from what actually happened | Pattern occurrences acquire outcome labels over time | 🟢 `OutcomeLearningService` |
| G7 | Withhold statistics when the sample is too small | `sampleTooSmall` below 5 outcome-tagged samples | 🟢 |
| G8 | Report unavailable dimensions honestly | No fabricated Market Context values | 🟡 |
| G9 | Explain itself on demand | `/explain` returns the evidence and memory hits that fed the answer | 🟢 |

**G7 deserves emphasis.** `HistoricalSimilarityService` has `MIN_SAMPLE = 5` and explicitly withholds a verdict below it. A system that says "this pattern resolved upward 100% of the time" on a sample of two is not being helpful; it is manufacturing false confidence in a domain where false confidence is expensive. The willingness to say *"I don't have enough data to tell you"* is a feature, and it is the feature that makes Rakesh (Chapter 3, Persona 3) trust the rest of the output.

---

## 6.3 AI philosophy

### 6.3.1 Deterministic core, optional LLM polish

This is the most important architectural idea in Sentinel and the one most often built the other way round.

```
   ┌──────────────────────────────────────────────────────────────┐
   │  DETERMINISTIC CORE  (always runs, no provider needed)        │
   │                                                              │
   │  candles ──► indicators ──► signals(triggered, weight,        │
   │                              evidence[])                     │
   │                                    │                          │
   │                      composite gate: ≥2 signals               │
   │                                     AND ≥0.7 weight           │
   │                                    │                          │
   │                            template composition               │
   │                    evidence → pattern → soft suggestion       │
   └────────────────────────────────────┬─────────────────────────┘
                                        │
                          ┌─────────────▼─────────────┐
                          │  OPTIONAL LLM POLISH      │
                          │  rewrite the SAME         │
                          │  structure as one calm    │
                          │  paragraph.               │
                          │  Fails? → use the         │
                          │  deterministic text.      │
                          └───────────────────────────┘
```

The LLM is a **stylist, not an analyst**. It never decides what to say — only how to say it. Consequences:

| Property | Why it follows |
|---|---|
| **Compliance is guaranteed by code** | The structure is produced deterministically. A hallucinating model cannot invent a Buy recommendation because it is not being asked what to recommend. |
| **The system works with no API key** | Local development, provider outages, and cost spikes are all non-events. |
| **Output is reproducible** | The same inputs produce the same signals and the same evidence, every time. You can debug it. |
| **Latency is bounded** | The core path is arithmetic over an array. No network call is on the critical path. |
| **Cost scales with *surfaced* observations, not with observation attempts** | The composite gate means the LLM is invoked on a small fraction of `/observe` calls. |

Compare with the naive design — "send the market data to an LLM and ask it what it thinks" — which is non-reproducible, non-auditable, expensive per call, latency-unbounded, and one prompt-injection away from a compliance incident.

### 6.3.2 Evidence is the unit of output, not conclusions

Every signal carries `evidence: string[]` — human-readable lines, written to be quoted verbatim to the user:

```ts
[
  "Price 24812.3 crossed resistance 24790.0",
  "Breakout volume is 62% of the 20-bar average",
  "Open interest is declining",
]
```

Not `{ breakout: true, volumeRatio: 0.62 }`. The structured version lives in `data` for the audit trail; the strings are the product. This means:

- The "Why" panel is a render of existing data, not a second explanation generated after the fact
- ⚖️ The compliance trail contains the actual reasoning, not a summary of it
- A user disputing an observation can be shown the exact numbers
- An engineer debugging a bad observation reads the same lines the user saw

### 6.3.3 Confidence is bounded and honest

```ts
// per-observation
confidence: Math.min(1, 0.4 + s.weight)

// synthesised
confidence: Math.min(0.95, compositeWeight / 2 + 0.3)
```

Note the **0.95 ceiling on synthesis**. Sentinel never claims certainty. This is partly epistemic honesty — a composite of heuristics is never certain — and partly ⚖️ compliance: a system claiming 100% confidence in a market observation is making a much stronger statement than a system that caps itself.

### 6.3.4 Ambient, not conversational

Sentinel is not a chatbot. It is not asked questions; it observes continuously and speaks when it has something corroborated to say. The interaction model is closer to a spell-checker than to an assistant: always on, mostly silent, occasionally useful.

This shapes the API. There is one primary entrypoint, `POST /observe`, and it takes *context* rather than a *question*:

```ts
interface ObserveRequest {
  userId: string;
  symbol?: string;          // chart open / order ticket
  recentTrades?: TradeSummary[];
  positions?: PositionSummary[];
  context?: string;         // free-form, e.g. 'order_ticket_open'
}
```

---

## 6.4 The never-does contract ⚖️

**This section is not negotiable and is not subject to a feature request.**

Sentinel **never**:

| # | Never | Enforced by |
|---|---|---|
| N1 | Places an order | No client, no tool, no endpoint, no arrow |
| N2 | Blocks an order | Not on the order path; `/observe` is a separate call |
| N3 | Delays an order | Never awaited by order placement |
| N4 | Gates an order | Not a dependency of `POST /sim/orders` in any sense |
| N5 | Says Buy / Sell / Entry / Target / Stop-loss level | `CORE_GUARDRAILS` + deterministic composition + copy review |
| N6 | Issues an imperative ("Don't buy", "Sell now") | Output contract fixed at evidence → pattern → **soft** suggestion |
| N7 | Queries trading tables | Receives `TradeSummary[]` as request data (§5.6.1) |
| N8 | Is reachable from a browser | `ServiceTokenGuard`; only `services/api` holds the token |
| N9 | Edits canonical knowledge | Proposes via `ConceptPromotion`; humans promote |
| N10 | Fabricates an unavailable value | Reports "not yet available" instead |
| N11 | Surfaces a single un-corroborated signal | Composite gate: ≥2 signals AND ≥0.7 weight |
| N12 | Produces user-facing copy from an individual agent | Only the orchestrator does |

### 6.4.1 Why N2–N4 are three rules and not one

They are three distinct failure modes, and each has been proposed at least once as a "small" improvement:

- **Blocking** — "reject the order if trap confidence > 0.9." Makes Sentinel a trading decision-maker. ⚖️ Regulatory category change.
- **Delaying** — "add a 3-second cooling-off." Feels harmless. Makes Sentinel a latency dependency of the order path and a single point of failure for the platform's core function.
- **Gating** — "show a confirmation dialog when Sentinel objects." Feels like a compromise. It is still Sentinel deciding whether the order is easy or hard to place, and it puts a Sentinel outage in the order path.

All three are rejected. If Sentinel is down, orders place at unchanged latency and the panel shows a degraded state. That property is tested by US-B4 and is worth more than any intervention we gave up.

### 6.4.2 The tone contract

Fixed, and it does not vary by signal, severity, or user preference:

```
   ✅ "Price has broken above resistance, but volume is below the
       20-day average and open interest is declining. This resembles
       a low-conviction breakout. Consider waiting for confirmation."

   ✅ "5 entries within 15 minutes of a losing exit this session.
       What pattern do you notice about your entry timing after a loss?"

   ❌ "Don't buy this breakout."
   ❌ "Sell now — this is a bull trap."
   ❌ "Wait for 24,750 before entering."      ← a price target is advice
   ❌ "This is a 92% probability short setup."
```

The questions are deliberate. A question makes the user do the reasoning; a user who reasons is a user who learns; and a question cannot be a recommendation.

---

## 6.5 Design principles

### DP1 — Composite over single-signal

No single detector produces a user-facing warning. Each is a *signal* with a weight; the orchestrator surfaces only when several corroborate.

```ts
const compositeWeight = triggered.reduce((sum, s) => sum + s.weight, 0);
if (compositeWeight >= 0.7 && triggered.length >= 2) { /* surface */ }
```

**Both conditions are load-bearing.** Weight alone would let one heavy signal (`bull_trap`, 0.45) plus a rounding error surface a warning. Count alone would let two trivial signals (`consolidating_in_cpr` 0.1 + `weak_breadth` 0.15 = 0.25) surface. Requiring both means: at least two independent observations, *and* enough combined significance.

### DP2 — Weights are calibrated, not uniform

| Weight | Signals | Interpretation |
|---|---|---|
| 0.45 | `bull_trap`, `bear_trap` | Strong structural evidence — a completed reversal pattern |
| 0.40 | `low_volume_breakout` | The canonical composite example |
| 0.35 | `revenge_trading`, `liquidity_sweep` | Strong behavioural / structural |
| 0.30 | `elevated_vix`, `high_risk_market_conditions`, `position_sizing_drift`, `loss_streak`, `fomo_entry` | Meaningful context |
| 0.25 | `overtrading`, `expiry_day_conditions` | Contributory |
| 0.20 | `overbought_rsi`, `oversold_rsi`, `weakening_momentum`, `elevated_realized_vol`, `below_average_participation`, `impatient_pacing` | Weak alone |
| 0.15 | `below_key_emas`, `weak_breadth` | Background |
| 0.10 | `consolidating_in_cpr` | Barely a signal |

Read the arithmetic and the design intent becomes visible:

- `overbought_rsi` (0.20) + `weak_breadth` (0.15) = 0.35 → **silent.** An RSI reading in a weak tape is not news.
- `bull_trap` (0.45) + `revenge_trading` (0.35) = 0.80 → **surfaced.** A structural reversal while the user is chasing a loss is exactly what the product exists for.
- `low_volume_breakout` (0.40) + `elevated_vix` (0.30) = 0.70 → **surfaced, exactly at the threshold.**

**Every calibration change is a product change**, because it directly changes how often the system interrupts a person. Chapter 9 §9.11 defines the change process.

### DP3 — Only the orchestrator speaks

Four agents produce structured `Signal[]`. One orchestrator produces prose. No agent has a user-facing surface.

This buys tone consistency (one place composes copy), compliance auditability (one place to review), and the composite gate as a real gate rather than a convention — an agent *cannot* surface a warning because it has no channel to do so.

### DP4 — Degrade, never fail

Every enrichment is individually wrapped (Chapter 2 §2.8). Sentinel returns an observation with the Brain unreachable, the LLM down, the concept graph mid-reseed, and the audit write failing.

### DP5 — Learning is separate from canonical knowledge

Column-level separation in `ConceptNode`/`ConceptEdge`: the seeder rewrites canonical columns and never touches `learnedWeight`, `supportCount`, `refuteCount`, `observationCount`, `lastObservedAt`, or `observations`. A reseed is a safe operation.

### DP6 — Append-only observation history

`ConceptObservation` is never updated and never deleted:

> *"learned weights are derived from these rows, so mutating one would rewrite history that a past explanation already cited."*

⚖️ An explanation shown to a user in March must still be reconstructible in September.

### DP7 — Withhold rather than mislead

`MIN_SAMPLE = 5`. Unavailable Market Context dimensions are reported as unavailable. The `/explain` endpoint labels a deterministic answer as deterministic rather than presenting it as AI-authored:

> *"Honesty over polish: with no LLM provider configured, this returns a clearly-labelled deterministic explanation — never a faked AI-authored one."*
> — `services/sentinel/src/explain/explain.service.ts:31-34`

### DP8 — The user's own data stays out

Sentinel holds no trading credentials and issues no trading queries (§5.6.1). This is a security property expressed as an interface.

---

## 6.6 Architecture

### 6.6.1 The observe pipeline

```
POST /observe  { userId, symbol, recentTrades[], positions[], context }
      │
      │ ServiceTokenGuard  ── x-service-token, else 401
      ▼
┌─────────────────────────────────────────────────────────────────────┐
│ SentinelOrchestratorService.observe()                               │
│                                                                     │
│ ① FIRE-AND-FORGET (void, never awaited — zero added latency)        │
│    • researchTrigger.researchIfUnfamiliar(symbol)                   │
│    • outcomeLearning.evaluatePending(5)                             │
│                                                                     │
│ ② SNAPSHOT                                                          │
│    market.snapshot(symbol)                                          │
│      → 15m candles (5d) + 1d candles (10d) + market breadth         │
│      → rsi14, ema20, ema50, vwap, macdHistogram, cpr,               │
│        volumeVsAvg, oiTrend, realizedVolPct, vix, breadthRatio,     │
│        support, resistance                                          │
│                                                                     │
│ ③ SIGNALS (four agents, one array)                                  │
│    market.signals(snapshot)        → 8 structural signals            │
│    emotion.signals(trades)         → 5 behavioural signals           │
│    traps.signals(snapshot, trades) → 7 composite trap signals        │
│    await news.signals(symbol)      → 1 news-volatility signal        │
│                                                                     │
│ ④ TRIGGERED → OBSERVATIONS                                          │
│    each triggered signal becomes a SentinelObservationOut with       │
│    a compliance category and confidence = min(1, 0.4 + weight)      │
│                                                                     │
│ ⑤ PATTERN PERSISTENCE  (try/catch → warn, non-fatal)                │
│    patternRecognition.recordOccurrence(symbol, signal, lastPrice)   │
│                                                                     │
│ ⑥ COMPOSITE GATE                                                    │
│    Σweight ≥ 0.7 AND count ≥ 2 ?                                    │
│      no  → synthesis = null                                          │
│      yes → dominant = max(weight)                                    │
│            content = compose(...)          ← LLM or template         │
│            + historicalSimilarity.describe() (try/catch → warn)      │
│            confidence = min(0.95, Σweight/2 + 0.3)                   │
│                                                                     │
│ ⑦ COMPLIANCE  ⚖️  (errors logged loudly, never thrown)              │
│    compliance.record(userId, observations, synthesis?.content)      │
│                                                                     │
│ ⑧ MARKET CONTEXT  (.catch(undefined), additive)                     │
│    marketContext.contextFor(symbol, snapshot)                       │
└─────────────────────────────────────────┬───────────────────────────┘
                                          ▼
        { synthesis, observations[], signals[], marketContext }
```

### 6.6.2 Reading the pipeline for its failure semantics

Four distinct reliability tiers, visible in the code:

| Tier | Mechanism | Example |
|---|---|---|
| **Core** — must succeed | plain `await` | snapshot, signals, gate |
| **Fire-and-forget** — never awaited | `void x().catch(() => undefined)` | research trigger, outcome learning |
| **Enriching** — try/catch → warn | `try {…} catch { logger.warn }` | pattern persistence, historical similarity |
| **Additive** — swallow | `.catch(() => undefined)` | market context |
| **Compliance** ⚖️ — log loudly | `catch { logger.error }` | audit persistence |

The compliance tier is deliberately different: it is non-fatal like the others, but it logs at `error` rather than `warn`, because *a silent audit gap is a compliance issue.*

### 6.6.3 Response shape

```ts
interface ObserveResponse {
  synthesis: {                    // null unless the gate opened
    content: string;              // the user-facing paragraph
    pattern: string;              // dominant signal name
    confidence: number;           // ≤ 0.95
    disclaimer: string;           // SENTINEL_DISCLAIMER, always present
  } | null;
  observations: SentinelObservationOut[];  // every triggered signal
  signals: Signal[];              // ALL signals, triggered or not
  marketContext?: string;         // additive narrative
}
```

**`signals` returns everything, including untriggered ones.** That is not an oversight — it is what makes the Market Context panel able to show "trap probability: low" honestly, and what makes debugging tractable. A signal that did not trigger is information about the market.

---

## 6.7 Real-time processing model

**Sentinel is pull-based today, not push-based.** 🟡

`POST /observe` is called by `services/api` in response to user context changes — chart symbol change, order ticket opening, dashboard load. There is no continuous background loop per user.

### 6.7.1 Why pull first

| | Pull (today) | Push (specified) |
|---|---|---|
| Compute | proportional to *active* users | proportional to *all* users × symbols |
| Complexity | one endpoint | scheduler + subscription registry + fan-out + backpressure |
| Failure mode | one request fails | a stuck loop degrades everyone |
| Freshness | on-demand | continuous |
| Cost | bounded by usage | bounded by universe size |

Principle 7 (Scalability First, honestly read): pull is correct until measured need says otherwise.

### 6.7.2 The push design, when it is time 🔵

```
   market-data tick stream
        │
        ▼
   ┌──────────────────┐
   │ Symbol watchers  │   one per actively-watched symbol,
   │ (debounced 5s)   │   NOT one per user
   └────────┬─────────┘
            │ snapshot changed materially?
            ▼
   ┌──────────────────┐
   │ Signal evaluation│   deterministic, cheap
   └────────┬─────────┘
            │ new signal triggered?
            ▼
   ┌──────────────────┐
   │ Per-user gate    │   composite gate with THAT user's trades
   └────────┬─────────┘
            │ gate opened?
            ▼
   ┌──────────────────┐
   │ SSE / WebSocket  │   push to that user only
   └──────────────────┘
```

**Key design constraint:** watchers are per *symbol*, not per *user*. Structural signal evaluation is shared; only the per-user gate (which needs that user's trades) is per-user. With 10,000 users watching 200 distinct symbols, that is 200 evaluations, not 10,000.

### 6.7.3 The continuous cadence trick

Two background jobs already run **without a scheduler**, by piggybacking on `/observe`:

```ts
void this.researchTrigger.researchIfUnfamiliar(symbol).catch(() => undefined);
void this.outcomeLearning.evaluatePending(5).catch(() => undefined);
```

Neither is awaited; neither adds latency. `OutcomeLearningService`'s own docstring explains the reasoning:

> *"Piggybacks on the existing observe() cadence rather than a new scheduler — Sentinel already runs continuously during market hours."*

This is a genuinely good pattern for a young system: **a batch of 5 per request, driven by organic traffic, is self-scaling with usage and has no cron to monitor, no lock to manage, and no failure mode where the scheduler dies silently.** Its limit is that it stops when traffic stops — which is exactly when there is nothing to evaluate anyway.

Its real limit is elsewhere and worth writing down: **it does not work for anything that must happen at a specific time.** End-of-day summaries need a scheduler. Chapter 9 §9.8.

---

## 6.8 Event-driven architecture 🔵

Today's flow is synchronous request/response. The specified event architecture:

```
   ORDER LIFECYCLE EVENTS          MARKET EVENTS
   OrderPlaced                     PriceLevelBroken
   OrderFilled                     VolumeSpike
   OrderRejected                   VolatilityRegimeChange
   PositionOpened                  NewsEventClassified
   PositionClosed                  SessionOpen / SessionClose
        │                                │
        └────────────┬───────────────────┘
                     ▼
            ┌─────────────────┐
            │  Redis Streams  │   (NOT Kafka — Principle 7)
            └────────┬────────┘
                     │
        ┌────────────┼────────────┬──────────────┐
        ▼            ▼            ▼              ▼
    Sentinel    notification  analytics    learning
   (observe,     (tell user)  (recompute)   pipeline
    never act)
```

**Sentinel is a subscriber, never a publisher of anything actionable.** It may publish `ObservationSurfaced` for analytics. It never publishes anything another service acts on in the order path.

---

## 6.9 Data sources

| Source | Provides | Access | Status |
|---|---|---|---|
| `MarketDataProvider` (injected, `MARKET_DATA` token) | candles, market breadth, news, VIX | interface — Dhan or OU simulator by config | 🟢 |
| `services/api` request body | `TradeSummary[]`, `PositionSummary[]` | **passed in, never queried** | 🟢 |
| Postgres — Brain tables | memories, entity graph, concept graph | own Prisma client, own tables | 🟢 |
| `knowledge-base/*.yaml` | 66 concepts, 273 relations | seeded at deploy | 🟢 |
| `ResearchEngine` (`packages/ai-core`) | external research on unfamiliar symbols | provider-gated, fire-and-forget | 🟢 |
| News feed | headlines → 13-category classification | via `MarketDataProvider` | 🟢 |

**The provider abstraction is why local development works.** `MarketDataProvider` is an interface from `@tradew/types`. In production it is the Dhan adapter; locally it is `SimMarketDataProvider` over an Ornstein–Uhlenbeck process. Sentinel's code does not know which, and the OU choice matters: a mean-reverting process produces realistic support/resistance behaviour, so the trap detectors actually fire during local development. A pure random walk would make Sentinel untestable outside market hours.

---

## 6.10 Agent orchestration

### 6.10.1 The roster

| Agent | Class | Kind | Lines |
|---|---|---|---|
| Market & Technical Intelligence | `MarketIntelligenceService` | deterministic | 113 |
| Emotion Intelligence | `EmotionIntelligenceService` | deterministic, **pure** | 88 |
| Trap & Safety Intelligence | `TrapIntelligenceService` | deterministic | 105 |
| News Event Intelligence | `NewsIntelligenceService` | LLM-assisted classification | 105 |
| Compliance & Audit ⚖️ | `ComplianceService` | deterministic | 63 |
| **Sentinel Orchestrator** | `SentinelOrchestratorService` | deterministic + optional LLM | 169 |

Note the shape: **four of six are pure deterministic functions.** `EmotionIntelligenceService.signals(trades)` takes an array and returns an array. No I/O, no database, no clock beyond `new Date()`. It is trivially testable, and it is where the platform's test suite should start.

### 6.10.2 Orchestration is composition, not messaging

There is no message bus between agents. The orchestrator calls each and concatenates:

```ts
const signals: Signal[] = [
  ...this.market.signals(snapshot),
  ...this.emotion.signals(trades),
  ...this.traps.signals(snapshot, trades),
  ...(await this.news.signals(symbol)),
];
```

Three synchronous, one async (the news agent may call an LLM for classification). Simple, debuggable, and fast. Agents-as-microservices would add network hops and failure modes to a computation that takes single-digit milliseconds.

Note that `traps.signals(snapshot, trades)` receives **both** market and behavioural inputs — the trap agent is where structural and behavioural evidence combine, which is why `fomo_entry` (a behavioural pattern requiring market context) lives there rather than in the emotion agent.

---

## 6.11 The compliance layer ⚖️

### 6.11.1 Category taxonomy

```ts
categoryFor(signal: Signal): string {
  if (signal.agent === 'emotion')      return 'behavioral_pattern_observation';
  if (signal.agent === 'trap-safety')  return 'market_risk_awareness';
  return 'market_structure_observation';
}
// orchestrator syntheses: 'synthesized_risk_awareness'
```

Four SEBI-relevant categories. Every observation carries one. This is what makes each "Why" panel *defensible* rather than merely informative — a regulator asking "on what basis did you tell this user X?" gets a category, evidence lines, a confidence value, and a timestamp.

### 6.11.2 The audit write

```ts
async record(userId, observations, surfacedContent?) {
  try {
    await this.prisma.sentinelObservation.createMany({ data: observations.map(...) });
  } catch (err) {
    // audit logging must never break the observation flow, but a silent
    // audit gap is a compliance issue — log loudly
    this.logger.error(`failed to persist ${observations.length} observations: ${err}`);
  }
}
```

Non-fatal, but `error`-level. The `surfaced` flag records **whether the user actually saw it** — distinguishing "the system noticed" from "the system said something," which is exactly the distinction a compliance review needs.

### 6.11.3 The disclaimer

`SENTINEL_DISCLAIMER` is attached to every synthesis. It is not a footer the UI may choose to render — it is a field on the response object, and its absence would be a schema violation.

---

## 6.12 Where Sentinel lives in the product

Sentinel is **a workspace inside TradeW**, sharing the sidebar, top bar, tokens, typography, auth, and entitlements with every other pillar. It is the platform's flagship premium intelligence workspace and the AI intelligence layer beneath the rest of the product. It is **not** a separate application.

⛔ **Reversed direction, 2026-07-21.** Sentinel was briefly re-specified as a standalone product with its own marketing site and no shared navigation. Reversed the same day; never executed in code. The surviving artefact is `STANDALONE_ROUTES: string[] = []` in `nav-config.tsx`, with a comment recording why the earlier chrome-less attempt was reverted:

> *"...that left no way to navigate back out to the rest of the app, a dead end rather than 'standalone.'"*

**Marketing surface ≠ application architecture.** A Sentinel landing page, subdomain, and independent SEO are fine and expected. The rule binds from sign-in onward.

**Never duplicated for Sentinel:** authentication, users, organisations, permissions, entitlements, billing, market data, portfolio data, orders, positions, watchlists, AI infrastructure, backend services, APIs, database, event system, notifications. A second implementation of any of these is an architecture violation.

---

*Next: [Chapter 7 — Sentinel: Departments](07-sentinel-departments.md)*
