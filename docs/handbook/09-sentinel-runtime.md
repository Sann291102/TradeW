# Chapter 9 — Sentinel: Runtime

Where Chapters 7 and 8 covered *what* Sentinel computes, this chapter covers *how it runs*: memory, reasoning, orchestration mechanics, caching, streaming, failure handling, scaling, monitoring, and latency.

---

## 9.1 Runtime topology

```
                        services/api
                             │  POST /sentinel/observe
                             │  header: x-service-token
                             ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  services/sentinel  (NestJS, :4100)                              │
   │                                                                  │
   │  ┌────────────────────────────────────────────────────────────┐  │
   │  │  ServiceTokenGuard          fail-closed on missing config   │  │
   │  └───────────────────────┬────────────────────────────────────┘  │
   │                          ▼                                       │
   │  ┌────────────────────────────────────────────────────────────┐  │
   │  │  SentinelOrchestratorService                               │  │
   │  └──┬──────────┬──────────┬──────────┬─────────────────┬──────┘  │
   │     ▼          ▼          ▼          ▼                 ▼         │
   │  Market     Emotion     Trap       News           Compliance ⚖️  │
   │  Intel      Intel       Intel      Intel                         │
   │     │                     │          │                 │         │
   │     └─────────┬───────────┘          │                 │         │
   │               ▼                      ▼                 ▼         │
   │  ┌────────────────────────────────────────────────────────────┐  │
   │  │  THE BRAIN                                                 │  │
   │  │  ┌──────────────┬──────────────┬─────────────────────────┐ │  │
   │  │  │ Memory       │ Entity graph │ Concept graph           │ │  │
   │  │  │ MemoryRecord │ GraphNode    │ ConceptNode/Edge        │ │  │
   │  │  │ + pgvector   │ GraphEdge    │ + reasoning layer       │ │  │
   │  │  └──────────────┴──────────────┴─────────────────────────┘ │  │
   │  │  Pattern Recognition · Historical Similarity ·             │  │
   │  │  Market Context · Outcome Learning · Research Trigger ·    │  │
   │  │  Concept Learning · Reinforcement · Knowledge Center       │  │
   │  └────────────────────────┬───────────────────────────────────┘  │
   └───────────────────────────┼──────────────────────────────────────┘
                               ▼
              Postgres 16 + pgvector    ·    MarketDataProvider
              (own Prisma client,             (Dhan | OU simulator,
               own tables — ARCH-5)            injected by config)
```

---

## 9.2 Memory

Sentinel has **three memory systems**, deliberately distinct. Conflating them is the most common conceptual error a new engineer makes here.

| | Memory Engine | Entity Graph | Concept Graph |
|---|---|---|---|
| **Tables** | `MemoryRecord`, `MemoryRelation` | `GraphNode`, `GraphEdge` | `ConceptNode`, `ConceptEdge`, `ConceptObservation`, `ConceptPromotion` |
| **Holds** | episodic: what happened | associative: what appeared with what | semantic: how ideas relate |
| **Example** | "low-volume breakout detected on NIFTY at 24,812 on 2026-07-23" | "NIFTY — `co_occurs_with` → bull-trap" | "liquidity-sweep — `is_a` → false-breakout" |
| **Written by** | Pattern Recognition, Research, Learning | Concept Learning Engine | seeder from YAML; reinforcement writes learned columns only |
| **Retrieval** | pgvector similarity + tag filter | unweighted BFS | **scored, narrated best-first traversal** |
| **Reasoning** | none — it is a store | none — edges carry no meaning | yes |

### 9.2.1 The Memory Engine 🟢

```prisma
model MemoryRecord {
  summary         String                  // one line
  content         String                  // full text
  sourceKind      String                  // research|document|chart|indicator|
                                          // conversation|market_report|
                                          // trading_journal|task_output|
                                          // observation|system
  confidence      Float   @default(0.5)
  tags            String[]
  entities        Json
  userId          String?                 // null = global/shared knowledge
  namespace       String  @default("global")
  staleAfter      DateTime?
  embedding       Unsupported("vector")?
  embeddingModel  String?
  embeddingDim    Int?
}
```

**The `embeddingModel` / `embeddingDim` pair is the detail worth stopping on.** The schema comment states the rule:

> *"The embedding column is dimension-flexible; embeddingModel/Dim record what produced it so mixed-provider embeddings are never compared to each other."*

Vectors from different models occupy different spaces. Cosine similarity between a Voyage embedding and an OpenAI embedding is a meaningless number that *looks* like a valid similarity score — it will be between −1 and 1, it will vary sensibly, and it will be wrong. Recording the producer makes the comparison guard possible. Skipping those two columns would have produced a bug that never throws and never gets noticed.

**`namespace` partitions memory.** Sentinel writes to `'sentinel'`; global knowledge lives in `'global'`. `userId` nullable distinguishes shared knowledge from a specific user's.

**`staleAfter` exists and is currently unused** — the field for time-bounded knowledge ("Q1 FY26 earnings" is not relevant in Q3). Listed in Chapter 26 as TD-6.

### 9.2.2 The Entity Graph 🟢

Two relations: `mentions`, `co_occurs_with`. Written by `ConceptLearningEngine` as observations accumulate.

Its limitation is designed-in and documented: unweighted BFS over structural edges answers *"what appeared together"* and nothing else. That is genuinely useful — "NIFTY, bull-trap, and expiry-day have co-occurred 14 times" is a real fact — but it is not reasoning, because `co_occurs_with` carries no meaning to reason with.

### 9.2.3 The Concept Graph 🟢 — the reasoning layer

This is where the system stops looking things up and starts reasoning.

**Scale:** 66 concepts, 273 relations, 15 domains, 13 relation types.

**The fifteen domains** (closed set — a concept that fits none of them is a taxonomy discussion, not a new folder, because `domain` is an indexed query dimension every consumer groups by):

```
market-structure · price-action · options · technical-analysis · volume
market-microstructure · macroeconomics · trading-psychology
risk-management · institutional-concepts · company-fundamentals
derivatives · sentiment · patterns · glossary
```

**The thirteen relations** — and the two properties that make them reasonable over:

| Relation | Reads | Transitive | Polarity |
|---|---|---|---|
| `is_a` | is a kind of | ✅ | neutral |
| `part_of` | is part of | ✅ | neutral |
| `causes` | causes | ✅ | supporting |
| `precedes` | precedes | ✅ | supporting |
| `confirms` | confirms | ❌ | supporting |
| `contradicts` | contradicts | ❌ | opposing |
| `invalidates` | invalidates | ❌ | opposing |
| `depends_on` | depends on | ✅ | supporting |
| `similar_to` | is similar to | ❌ | neutral |
| `measured_by` | is measured by | ❌ | neutral |
| `mitigates` | mitigates | ❌ | opposing |
| `amplifies` | amplifies | ❌ | supporting |
| `example_of` | is an example of | ❌ | neutral |

**`transitive` and `polarity` are load-bearing, not metadata.**

- `causes` chains with per-hop decay: A causes B, B causes C ⇒ A weakly supports C.
- `contradicts` does **not** chain. The relations module states the reason plainly: *"'A contradicts B, B contradicts C' says nothing about A and C, and chaining it would manufacture false conflict."*
- `is_a` chains but is neutral: it navigates a taxonomy without asserting anything.

This is why the vocabulary is **closed**. An unknown relation string would be traversed with a default weight and a default polarity, silently weighting a conclusion wrong. A genuinely new relation is an ontology change reviewed on its own.

### 9.2.4 Reasoning paths

`ConceptGraphService` produces scored, narrated paths:

```ts
export interface ReasoningStep {
  from: string; to: string;
  relation: RelationType;
  reversed: boolean;          // traversed against the declared direction
  weight: number;
  reads: string;              // plain-English reading of THIS step
}

export interface ReasoningPath {
  steps: ReasoningStep[];
  /** Product of per-step weights and per-relation decay.
   *  Strictly decreasing with length. */
  score: number;
  narration: string;
}
```

Three properties worth noting:

1. **Score is strictly decreasing with path length.** Longer chains of inference are weaker, mechanically. There is no way to construct a ten-hop path that outranks a two-hop one.
2. **Every edge has a `reads` and a `readsInverse`**, so a path traversed backwards narrates correctly. `is_a` reads "is a kind of" forward and "has subtype" backward.
3. **`USER_FACING_CONFIDENCE_FLOOR = 0.5`.** Below this, a concept is not shown to a user at all. The graph may hold it, reason with it internally, and accumulate evidence about it — but it does not surface.

Compare this to a black-box embedding similarity search. Both find related concepts. Only one can tell the user *why* two things are related, in a sentence, with a score that degrades honestly with distance. That difference is the entire justification for building a second graph (Chapter 5 §5.6.2).

### 9.2.5 Reinforcement — the three invariants

`ConceptReinforcementService` states them in its own docstring, and they are the reason a reseed is a boring operation rather than a data-loss event:

> 1. **Observations are append-only.** A learned weight is always re-derivable from the log, and a past explanation's evidence never changes under it.
> 2. **Reinforcement writes `learnedWeight` and the counters — never `weight`.** The authored prior stays intact and reseed-safe, so YAML and runtime can never fight over the same column.
> 3. **New knowledge is *proposed*, never merged.** Sentinel cannot promote its own findings; it queues them for a human, who accepts by editing YAML.

```
   ┌──────────────────── ConceptEdge ─────────────────────┐
   │ CANONICAL (seeder rewrites)  │ LEARNED (never touched)│
   │  weight                       │  learnedWeight         │
   │  note                         │  supportCount          │
   │  confidence                   │  refuteCount           │
   │  relation                     │  lastObservedAt        │
   └───────────────────────────────┴────────────────────────┘
                    ▲                          ▲
              knowledge-base/            ConceptObservation
              <domain>/<id>.yaml          (append-only log)
```

There is also an **evidence threshold**: below a minimum number of observations, the authored prior still wins even though observations are accumulating. Learning does not override authored knowledge on the basis of three data points.

### 9.2.6 The three things called "knowledge"

Reproduced because it is the highest-value disambiguation in the repository:

| | `TradeW/knowledge/` | `TradeW/knowledge-base/` | Postgres Brain |
|---|---|---|---|
| Kind | Obsidian vault | YAML concept files | Runtime tables |
| About | **building TradeW** | **markets** | **what was observed** |
| Read by | engineers, coding agents | Sentinel at runtime | Sentinel at runtime |
| Written by | coding agents, per task | humans only | services, continuously |
| In production? | **never** | seeded in | yes |

Putting a debugging note into `knowledge-base/` would mean it could be cited in a user-facing market observation. Putting a market concept into `knowledge/` would mean Sentinel never sees it.

---

## 9.3 Caching

### 9.3.1 What is cached today 🟡

| Layer | TTL | Where | Status |
|---|---|---|---|
| Quote snapshot (OMS) | 2 s | `MarketPriceService` in-process | 🟢 |
| Quote hot cache | — | `packages/market-data/src/cache/in-memory-quote-cache.ts` | 🟢 |
| Market snapshot | — | none | 🔵 |
| Concept graph | — | none | 🔵 |
| Memory retrieval | — | none | 🔵 |
| LLM completions | — | none | 🔵 |

**Sentinel currently caches nothing.** Every `/observe` recomputes the market snapshot from scratch, including two `getCandles` calls. This is honest and it is the correct starting point — but it is the first thing to fix under load.

### 9.3.2 The specified cache hierarchy 🔵

```
  L0  In-process LRU              μs        per-instance, no coherence problem
      • concept graph (reseed-invalidated)
      • relation specs (immutable)
      • indicator results per (symbol, bar-bucket)

  L1  Redis                       ~1 ms     shared across instances
      • market snapshot   key: snapshot:{symbol}:{15m-bucket}
                          TTL: until next bar close
      • memory retrieval  key: retrieval:{hash(query,namespace)}
                          TTL: 5 min
      • historical sim.   key: histsim:{symbol}:{pattern}
                          TTL: 1 h

  L2  Postgres                    ~5–50 ms  the durable truth
```

### 9.3.3 The cache key that matters most

```
   snapshot:{symbol}:{floor(now / 15min)}
```

Bucketing by **bar boundary** rather than by wall-clock TTL means: every observer of NIFTY within the same 15-minute bar gets the identical snapshot, the cache invalidates exactly when new information arrives, and there is no window in which two users see different "current" structure for the same symbol. A 30-second TTL would give all three properties away for nothing.

### 9.3.4 What must never be cached

| Never cached | Why |
|---|---|
| Behavioural signals | Depend on the user's own trades, which change per request |
| Composite gate result | Combines cached market data with uncached behaviour |
| The synthesis | Per-user, per-moment. Caching it would show one user another's observation. |
| ⚖️ Compliance writes | Every observation is a distinct audit event |

> ⚠️ Caching the synthesis by `(symbol, pattern)` looks like an obvious optimisation and is a **data-leak bug**: the synthesis text incorporates the user's own behavioural evidence.

---

## 9.4 Streaming 🔵

Sentinel does not stream today. `/observe` is request/response.

### Two things will need streaming

**1. LLM token streaming.** The orchestrator's `compose()` awaits the full completion. For a ~220-token paragraph at typical speeds that is ~1–2 s of nothing happening. Streaming would show the first words in ~300 ms.

```
   compose()  ──► llm.completeStream({ … })
                        │
                        ├─► token ─► SSE ─► UI appends
                        ├─► token ─► SSE ─► UI appends
                        └─► done  ─► SSE ─► UI marks complete + shows disclaimer
```

⚖️ **The disclaimer is attached on completion, never streamed.** A partially-streamed disclaimer is worse than none.

**2. Push observations.** SSE from `services/api` (never directly from Sentinel — ARCH-1):

```
   sentinel ──► Redis Stream ──► services/api ──► SSE ──► browser
                                 (auth, entitlement,
                                  per-user filtering)
```

The entitlement check must happen at `services/api`, on the fan-out. A user whose subscription lapses mid-session must stop receiving reasoning at the next event, not at the next page load.

---

## 9.5 Failure handling

### 9.5.1 The five reliability tiers

| Tier | Mechanism | Components | On failure |
|---|---|---|---|
| **Core** | plain `await` | snapshot, signals, gate | request fails (correctly) |
| **Fire-and-forget** | `void x().catch(() => undefined)` | research trigger, outcome learning | silent |
| **Enriching** | `try/catch` → `logger.warn` | pattern persistence, historical similarity | feature absent, response complete |
| **Additive** | `.catch(() => undefined)` | market context | field undefined |
| **Compliance** ⚖️ | `try/catch` → `logger.error` | audit persistence | logged loudly, flow continues |

### 9.5.2 Failure matrix

| What breaks | User sees | Severity |
|---|---|---|
| LLM provider down | Deterministic composition. Identical structure, plainer prose. | **none** |
| No provider configured | Same. This is the normal local-dev state. | **none** |
| Research provider absent | Nothing. Not even a log line — it is expected. | **none** |
| Brain / memory unreachable | No historical-similarity note; no "N memories" line | low |
| Concept graph mid-reseed | Canonical reads still work; learned columns untouched | low |
| Market data unavailable | Null indicators → few or no signals → likely no synthesis | medium |
| Audit write fails ⚖️ | Nothing visible. `logger.error`. **Alert fires.** | **high** |
| Sentinel entirely down | Degraded panel state. **Orders place at unchanged latency.** | medium |
| Postgres down | 500 on `/observe`. Rest of the platform unaffected. | high |

The last two rows are the payoff of ARCH-3. Sentinel is the most complex service in the platform and its total failure degrades exactly one panel.

### 9.5.3 The provider-error pattern

```ts
try {
  const llm = this.providers.getLlm();
  const response = await llm.complete({ … });
  return response.text.trim() || fallback;
} catch (err) {
  if (!(err instanceof ProviderNotAvailableError)) {
    this.logger.warn(`LLM synthesis failed, using deterministic composition: ${err}`);
  }
  return fallback;
}
```

Three details worth copying:

1. **`ProviderNotAvailableError` is not logged.** It is the expected state locally. Logging it would produce a warning on every request that engineers learn to ignore — and an ignored warning channel is worse than a silent one.
2. **Every other error *is* logged**, at `warn`.
3. **`response.text.trim() || fallback`** — an empty completion is also a failure. A model returning `""` should not produce an empty observation card.

### 9.5.4 The degrade-not-crash posture, stated

From `KnowledgeCenterService`:

> *"Same degrade-not-crash posture as every other Brain service (Historical Similarity, Market Context, Outcome Learning, …): a database outage must return an empty/zero result, never a 500."*

```ts
catch (err) {
  this.logger.warn(`brain search failed, returning empty result: ${err}`);
  return { hits: [], graphHits: [], contextText: '' };
}
```

**An empty result is a valid result.** "Sentinel has no memories of this symbol" and "the memory store is down" render identically to a user, and that is correct: neither is actionable by them, and one of them should not be a 500.

---

## 9.6 Latency

### 9.6.1 Budget

| Stage | Target | Measured | Notes |
|---|---|---|---|
| Guard + parse | ≤2 ms | ⚪ | |
| `market.snapshot()` | ≤80 ms | ⚪ | 2 `getCandles` + breadth. Dominant cost. |
| `market.signals()` | ≤3 ms | ⚪ | pure arithmetic |
| `emotion.signals()` | ≤2 ms | ⚪ | pure function |
| `traps.signals()` | ≤3 ms | ⚪ | pure arithmetic |
| `news.signals()` | ≤120 ms | ⚪ | may call an LLM classifier |
| Composite gate | ≤1 ms | ⚪ | |
| Pattern persistence | ≤30 ms | ⚪ | non-blocking-ish (awaited but wrapped) |
| Historical similarity | ≤50 ms | ⚪ | vector search |
| LLM composition | ≤1,500 ms | ⚪ | **only when the gate opens** |
| Compliance write | ≤20 ms | ⚪ | |
| Market context | ≤40 ms | ⚪ | |
| **p95, gate closed** | **≤300 ms** | ⚪ | the common case |
| **p95, gate open** | **≤2,000 ms** | ⚪ | the rare case |

Every ⚪ is honest. Sentinel has no instrumentation today. Chapter 20 §20.9.

### 9.6.2 Why the common case is fast

The composite gate is a **cost gate as well as a quality gate**. The LLM runs only when ≥2 signals corroborate at ≥0.7 combined weight — expected to be well under 15% of calls. So:

```
   85% of /observe:  no LLM  →  p95 ≈ 300 ms   →  cost ≈ ₹0
   15% of /observe:  LLM     →  p95 ≈ 2,000 ms →  cost ≈ one 220-token call
```

A design that sent every observation to a model would be 6× slower and roughly 7× more expensive, for output that is structurally identical.

### 9.6.3 The optimisation order 🔵

1. **Snapshot cache** (§9.3.3) — removes ~80 ms from every request, and collapses concurrent observers of the same symbol onto one computation. Highest value by a wide margin.
2. **Parallelise the two `getCandles` calls** — currently sequential; they are independent.
3. **Move pattern persistence off the request path** — it is awaited today, inside a try/catch. Queue it.
4. **Cache historical similarity** by `(symbol, pattern)` — the answer changes slowly.
5. **Stream the LLM composition** — does not reduce total latency, transforms perceived latency.

---

## 9.7 Monitoring 🔵

### 9.7.1 Metrics that matter

**Product health**

| Metric | Why | Alert |
|---|---|---|
| `sentinel_observe_total` | volume | — |
| `sentinel_signals_triggered_total{signal}` | which detectors actually fire | any signal at 0 for 7 days → likely broken |
| `sentinel_synthesis_surfaced_total` | how often we interrupt | — |
| **`surface_rate` = surfaced ÷ observe** | **the single most important product metric** | > 25% → too noisy; < 2% → possibly broken |
| `sentinel_composite_weight` (histogram) | threshold calibration evidence | — |

**Technical health**

| Metric | Alert |
|---|---|
| `sentinel_observe_duration_seconds` (histogram) | p95 > 500 ms (gate closed) |
| `sentinel_llm_calls_total{outcome}` | fallback rate > 20% |
| `sentinel_llm_duration_seconds` | p95 > 3 s |
| ⚖️ **`sentinel_audit_write_failures_total`** | **> 0 → page** |
| `sentinel_brain_query_duration_seconds` | p95 > 200 ms |
| `sentinel_degraded_operations_total{component}` | sustained non-zero |

### 9.7.2 The one that pages

⚖️ **`sentinel_audit_write_failures_total > 0` is the only Sentinel metric that pages a human.** Everything else degrades gracefully and can wait for business hours. A failed audit write is a compliance gap, and compliance gaps are not eventually-consistent.

### 9.7.3 Why `surface_rate` is the product metric

```
   surface_rate too HIGH (> 25%)
     → users tune out; dismiss rate rises; the product becomes an
       alert system, which is the thing it exists not to be

   surface_rate too LOW (< 2%)
     → either the market is genuinely calm, or a detector is broken
       and nobody noticed
```

The number encodes the entire design philosophy in one ratio. Track it per-signal too, because a single detector that has silently stopped firing is otherwise invisible.

---

## 9.8 Scaling

### 9.8.1 Sentinel is stateless

No in-process session state, no sticky routing, no local queue. Every request carries everything it needs. It scales horizontally today with no changes:

```
                      services/api
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         sentinel-1   sentinel-2   sentinel-3
              └────────────┼────────────┘
                           ▼
                    Postgres + Redis
```

This is a deliberate property, and it is why the fire-and-forget background work (§6.7.3) is designed as *"a batch of 5 per request"* rather than as a singleton loop — a singleton loop would make the service stateful and un-replicable.

### 9.8.2 The bottlenecks, in the order they will appear

| # | Bottleneck | Symptom | Fix |
|---|---|---|---|
| 1 | `getCandles` per observe | market-data saturated | snapshot cache (§9.3.3) |
| 2 | LLM rate limits | fallback rate climbs | queue + per-user rate limit; distilled model for classification |
| 3 | pgvector similarity | Brain p95 climbs | IVFFlat/HNSW index; tighten `limit` |
| 4 | `SentinelObservation` growth | write latency, index bloat | monthly partitioning (Chapter 17 §17.5) |
| 5 | Concept graph traversal | reasoning p95 climbs | in-process LRU; it is small and changes only on reseed |

### 9.8.3 What does not need to scale

The signal computation itself. Every detector is arithmetic over an array of at most a few hundred candles. Ten thousand concurrent evaluations is a rounding error on one CPU. **The expensive parts are all I/O**, which is why every scaling fix above is a cache or an index.

### 9.8.4 Scheduled work — the honest limit of the piggyback pattern

The fire-and-forget cadence (§6.7.3) is elegant and has a hard limit: **it cannot do anything that must happen at a specific time.**

| Needs a real scheduler 🔵 | Why the piggyback fails |
|---|---|
| End-of-day session summary | Must run at 15:30 IST, not when someone happens to load a page |
| Overnight concept promotion review | Must complete before market open |
| Weekly behavioural reports | Fixed cadence, independent of traffic |
| Ontology reseed | Deployment-triggered, not traffic-triggered |
| Stale memory expiry (`staleAfter`) | Must run even with zero traffic |

Design when it is time: a single scheduler instance (leader-elected via a Redis lock) publishing jobs to a queue that any Sentinel instance consumes. Never `@nestjs/schedule` on every replica — that runs the job N times.

---

## 9.9 Development workflow

### 9.9.1 Running Sentinel locally

```bash
npm run dev:sentinel
```

Requirements: Postgres with pgvector, a `SERVICE_TOKEN`, and `DATABASE_URL`. **No AI keys.** With none configured, Sentinel is fully functional: deterministic composition, text-match concept search, OU-simulated market data.

### 9.9.2 The ontology toolchain 🟢

```bash
npm run ontology:validate   # schema, closed vocabularies, dangling refs, cycles
npm run ontology:seed       # project knowledge-base/*.yaml → Postgres
npm run ontology:smoke      # exercise the graph reasoning layer
```

**Always `validate` before `seed`.** The validator catches: unknown domain, unknown relation type, dangling `supersededBy`/`supersedes` slug, duplicate `conceptId`, missing required field, and illegal cycles in transitive relations.

### 9.9.3 Reseed safety

The seeder rewrites only canonical columns and skips rows whose YAML `checksum` is unchanged. Consequences:

- A reseed is **idempotent**
- A reseed **never destroys runtime learning**
- A reseed is **cheap** — unchanged concepts are untouched

This is why ontology changes can ship on the normal deployment path rather than as a special migration event.

### 9.9.4 Adding a concept

```
1. knowledge-base/<domain>/<concept-id>.yaml
   ─ conceptId, domain, name, aliases, status, maturity, confidence
   ─ summary (1 line) · definition (precise) · explainer (what users read)
   ─ observableWhen[] · examples[] · sources[] · tags[]
   ─ relations: [{ to, type, weight, note }]

2. npm run ontology:validate     ← must pass

3. npm run ontology:seed

4. npm run ontology:smoke        ← does it reason sensibly?

5. Commit the YAML. It IS the source of truth.
```

**Never insert a `ConceptNode` directly into Postgres.** The next reseed will not know about it, `checksum` will be null, and provenance is lost.

---

## 9.10 Testing Sentinel 🟡

**Status (updated 2026-08-15): a substantial unit suite now exists** — `services/sentinel/src/**/*.spec.ts` covers sentinel-intelligence, the orchestrator (cross-validation, publication gate), market structure, strategy engine/lifecycle, the visual geometry/drawing-spec layer, market watch, and vocabulary; `services/sentinel-py` adds 9 `pytest` files. The remaining gap is integration/E2E across the running service, not unit coverage. The build order below still describes the intended tiering:

### Tier 1 — pure functions (start here, today)

```ts
// emotion-intelligence.spec.ts — no database, no mocks, array literals
describe('EmotionIntelligenceService', () => {
  it('does not trigger revenge_trading on a single quick re-entry', () => {
    const trades = [
      { …, realizedPnl: -500, createdAt: '2026-07-23T10:00:00Z' },
      { …, createdAt: '2026-07-23T10:05:00Z' },   // 1 occurrence
    ];
    expect(find(svc.signals(trades), 'revenge_trading').triggered).toBe(false);
  });

  it('triggers on two', () => { /* … */ });

  it('excludes gaps over 15 minutes', () => { /* … */ });

  it('does not break a loss streak on a position-opening trade', () => {
    // realizedPnl undefined must neither extend nor reset the streak
  });
});
```

`EmotionIntelligenceService` is a pure function over an array. There is no excuse for it being untested, and it is the single highest-value test file in the repository because it produces the most sensitive output.

### Tier 2 — the composite gate ⭐

The two tests the product depends on (Chapter 3, US-B2/US-B3):

```ts
it('does NOT surface a single triggered signal', () => {
  // one signal, weight 0.35 → synthesis must be null
  // but the observation must still be persisted
});

it('surfaces when two signals clear 0.7', () => {
  // 0.40 + 0.35 = 0.75 → synthesis non-null
  // confidence = min(0.95, 0.75/2 + 0.3)
});
```

If the first ever fails, the product has become an alert system.

### Tier 3 — ⚖️ compliance regression

```ts
const FORBIDDEN = /\b(buy|sell|short|long)\s+(now|here|this)\b|
                   \btarget\b|\bstop.?loss\s+at\b|\bdon'?t\s+(buy|sell)\b/i;

it('never produces directive language across the signal corpus', () => {
  for (const scenario of GENERATED_SCENARIOS) {   // ≥ 500
    expect(compose(scenario)).not.toMatch(FORBIDDEN);
  }
});
```

Run against the deterministic composer in CI (fast, free, exhaustive) **and** against a live model nightly (slower, catches guardrail drift after a prompt or model change).

### Tier 4 — architectural regression

```ts
it('places an order at unchanged latency with Sentinel unreachable', () => { /* ARCH-3 */ });
it('rejects /observe without a service token', () => { /* ARCH-1 */ });
it('exposes no order-placement tool in the registry', () => { /* ARCH-2 */ });
```

---

## 9.11 Changing Sentinel — the process

Changes here have unusual blast radius: they alter what a person is told about their own money, in a regulated context.

### 9.11.1 Changing a threshold or weight

```
□ State the current behaviour and the proposed behaviour, numerically
□ Estimate the effect on surface_rate (§9.7.3). A weight change that
  moves it more than a few points is a product change, not a tweak.
□ Replay against ≥30 days of recorded observations. How many
  syntheses appear or disappear?
□ Sample 20 newly-surfacing cases. Would a trader agree they were
  worth an interruption?
□ Get product sign-off. Weights are product decisions expressed as
  numbers.
□ Record the before/after in the vault (knowledge/Decisions/).
```

### 9.11.2 Adding a signal

Chapter 7 §7.15 checklist, plus:

```
□ Does it duplicate an existing signal? (fake_breakout ≡ low_volume_breakout)
□ Is the weight calibrated against §6.5 DP2, not chosen by feel?
□ ⚖️ Write the "never does" clause BEFORE the implementation.
□ Does it push surface_rate up? Adding signals raises composite weight
  across the board — an innocuous-looking addition can make the whole
  system noisier.
□ Unit tests for triggered, not-triggered, and the boundary.
```

### 9.11.3 Changing the composite gate

**Requires an RFC.** `SURFACE_THRESHOLD = 0.7` and `triggered.length >= 2` are the two numbers that define what the product *is*. Changing either is a change to the thesis, not to a constant.

---

## 9.12 Future improvements

| Priority | Improvement | Why |
|---|---|---|
| **P0** | Test suite, starting with Tier 1 and Tier 2 | The system is unverified |
| **P0** | Instrumentation — the §9.7 metrics | Every latency number is a guess |
| **P0** | Snapshot cache | ~80 ms off every request, and the fix for bottleneck #1 |
| **P1** | Push observations (SSE) | The ambient promise is not kept by polling |
| **P1** | LLM streaming | Perceived latency on the surfaced case |
| **P1** | Complete the trap catalogue (7 of 14) | Product completeness |
| **P1** | Real scheduler for time-bound work | EOD summaries, promotion review |
| **P2** | Per-user behavioural baselines | Session-only windows miss slow drift |
| **P2** | Data-driven weight calibration | Weights are currently judgement |
| **P2** | Per-pattern outcome semantics | Directional labels are a placeholder |
| **P2** | `packages/indicators` extraction | Client/server drift risk (TD-4) |
| **P3** | Multi-timeframe confluence | Higher-quality structural signals |
| **P3** | `staleAfter` enforcement | Time-bounded knowledge (TD-6) |

---

*Next: [Chapter 10 — Safety Nets](10-safety-nets.md)*
