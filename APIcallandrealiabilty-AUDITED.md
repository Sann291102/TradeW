# TradeW — Full API / LLM / ML / Workflow Reliability Audit (AUDITED)

**Audit date:** 2026-08-17 (16:55–17:40 IST) · **Branch:** `main` · **Base commit:** `5004935`
**Scope of code read:** the **working tree**, not the commit — see the concurrency caveat below.
**Spec:** `APIcallandrealiabilty.md` (executed, not summarised)
**Method:** `OBSERVE → TRACE → COUNT → CLASSIFY → VERIFY → REPORT`

> ### ⚠ Concurrency caveat — read before acting on any finding
>
> The working tree contained **854 lines of uncommitted changes by a concurrent
> session**, and three of the files this audit examined were **edited while the
> audit was running**:
>
> | File | Modified at | Effect on findings |
> |---|---|---|
> | `services/market-data/scripts/live-feed-server.ts` | 17:30 | C-4 partly addressed; H-7, M-2 **re-verified still present at 17:36** |
> | `.../market-data/candle-market-data.provider.ts` | 17:34 | C-4 **fixed in working tree** |
> | `.../intelligence/market-intelligence.service.ts` | 17:34 | H-5 **re-verified still present at 17:36** |
>
> Files carrying the CRITICAL/HIGH findings about **timeouts, telemetry, LLM and
> ML** (`anthropic.ts`, `provider-manager.ts`, `sentinel-orchestrator.service.ts`,
> the cognition and telemetry modules) were **not** touched during the audit;
> those findings are stable.
>
> All **runtime measurements** were taken against the *running* processes and are
> unaffected by source edits made after those processes started.

Supporting artifacts:
[`api-call-inventory.json`](api-call-inventory.json) ·
[`api-call-graph.md`](api-call-graph.md) ·
[`api-runtime-measurement.md`](api-runtime-measurement.md) ·
[`api-reliability-findings.md`](api-reliability-findings.md)

Evidence labels used throughout: **CONFIRMED-RUNTIME** (observed executing),
**CONFIRMED-SOURCE** (read in code, not executed during this audit),
**INFERRED**, **UNKNOWN**. No estimate is presented as a measurement.

**No product behaviour was modified.** No instrumentation was added — none was
needed, because the repository already contains the exact correlation schema the
brief asks for. The only artifact created was a read-only query script, deleted
after use.

---

# Executive Summary

## The one-line answer

The workflow is **coherently designed and honestly degraded, but effectively
blind and — today — not running.** The flagship Sentinel analysis fails **76% of
calls today** on an expired daily credential, reports the wrong cause, and the
system has **no way to see its own AI usage** because the AI telemetry table has
never received a single row.

## Direct answers to the brief's questions

| Question | Answer | Label |
|---|---|---|
| How many calls per major workflow? | `/observe` = **6 external HTTP + ~5 DB reads + 2+n DB writes + 1 embedding + 0–1 LLM**. Dashboard = 5–6 internal. See §3. | CONFIRMED-SOURCE |
| How many are LLM? | **0 or 1 per observation**, 0 in the common case. **≤72 in the system's entire history.** | INFERRED from runtime |
| How many are ML? | **ZERO. There is no machine learning in this repository at all.** | CONFIRMED-SOURCE |
| How many are embeddings? | **1 per observation** (+3 non-request-path sites). | CONFIRMED-SOURCE |
| How many are market-data calls? | **6 per observation**, all to one internal bridge. | CONFIRMED-SOURCE |
| How many are internal? | 2 service hops per observation; 73 distinct endpoints from 90 frontend call sites. | CONFIRMED-RUNTIME |
| Are calls duplicated? | **Not seriously.** TanStack Query dedupes migrated surfaces; 10 hand-rolled intervals remain outside it. | CONFIRMED-SOURCE |
| Is the workflow intact? | **PARTIAL** — see the verdict in §14. | — |
| What is broken? | AI telemetry (0 rows), agent telemetry (0 rows), the cognition network (0 weights), the market-data credential, the 503 diagnostic. | CONFIRMED-RUNTIME |
| What is risky? | Three network paths with **no timeout at all**, including the primary LLM provider. | CONFIRMED-SOURCE |
| What is unnecessarily expensive? | Very little. The LLM is cosmetic and cached; the real waste is **latency**, not spend. | CONFIRMED-RUNTIME |

## The five things that matter most

1. **There is no ML.** No ONNX, torch, TensorFlow, sklearn, XGBoost, LightGBM,
   transformers — not even numpy or pandas — anywhere in 754 production files.
   Everything described as intelligence is a deterministic rule/statistics
   engine, plus one dormant Hebbian weight-updater. This is not a criticism;
   it is a correction to any belief that ML inference is in the request path.

2. **The LLM is decorative, and that is by design.** The single user-facing LLM
   call rewrites prose over an already-complete deterministic draft. Every
   number, decision and gate is computed without it. Turning off all AI
   providers changes the wording of the output and nothing else.

3. **The system cannot see its own AI usage.** `AiCallLog` has **0 rows** after
   14 days and 181,541 logged API calls, because the telemetry sink is installed
   in `services/api` while all AI calls happen in `services/sentinel`. The
   admin console's cost dashboards read a table nothing writes.

4. **The flagship workflow is down and lying about why.** The Dhan token
   expired; the bridge reports the failure as **HTTP 200** with an `error` field
   the consumer's type does not declare; the user sees *"the bridge is
   unreachable"* about a bridge that answers in 31ms.

5. **1,520 tests pass while the product fails.** Every suite mocks the
   market-data boundary, so the entire class of failure actually occurring is
   structurally invisible to the test suite.

---

# 1. System Overview

Verified live 2026-08-17 (all ports open).

| Component | Kind | Port | Status |
|---|---|---|---|
| `apps/web` | Next.js 14.2.20 | 3000 | REAL |
| `apps/admin` | Next.js | 3001 | REAL |
| `services/api` | NestJS, **190 routes** | 4000 | REAL |
| `services/sentinel` | NestJS, **47 routes** | 4010 | REAL |
| `services/sentinel-py` | FastAPI, **18 routes** | 4011 | REAL |
| `services/market-data` | NestJS ingestor | 4020 | REAL |
| live-feed bridge | standalone script | 4600 | **DEGRADED** |
| Postgres + pgvector | database | 5433 | REAL |
| `services/tradew-ai` | NestJS | — | PARTIAL (real code, not observed running) |
| `services/auth` · `analytics` · `notification` · `trading-engine` | — | — | **UNUSED** (README only) |

**Correction to the knowledge vault:** the note *"`services/tradew-ai` is an
empty stub"* (2026-08-11) is **stale**. It now contains
`assistant.service.ts` wiring `DefaultAgentRuntime`. The
`auth`/`analytics`/`notification`/`trading-engine` placeholders remain accurate.

The browser talks only to `services/api` — with one exception: it calls the
market-data bridge **directly** via `lib/dhanLiveFeed.ts` (finding H-6).

---

# 2. API Call Inventory

Full machine-readable form in [`api-call-inventory.json`](api-call-inventory.json).

| Class | Count | Notes |
|---|---|---|
| Production source files swept | 754 | excludes archive/, `.next*`, node_modules, 105 test files |
| Frontend `api()` call sites | 90 | across 73 distinct endpoints |
| `fetch` call sites (prod) | 75 | hand-verified individually |
| `services/api` routes | 190 | 27 controllers |
| `services/sentinel` routes | 47 | |
| `services/sentinel-py` routes | 18 | |
| External providers | 15 | 6 configured, 9 unconfigured |
| Python HTTP clients | 2 modules | `httpx` in sentinel-py only |
| WebSocket (browser) | **1** | live data is HTTP polling throughout |
| SSE | 10 files | admin/knowledge streams only |
| `setInterval` polls (web) | 10 hand-rolled | outside query dedupe |

**Everything funnels through one wrapper.** All 90 frontend call sites go
through `api()` at `apps/web/src/lib/api.ts:178`. That single function has no
timeout and retries once, only after a 401 refresh.

---

# 3. Workflow-by-Workflow Call Counts

Full graphs in [`api-call-graph.md`](api-call-graph.md).

### `/sentinel/observe` — one observation

| Class | Count | Detail |
|---|---|---|
| External HTTP | **6** | 2× `/candles`, 1× `/quotes`, 1× `/optionchain`, 2× `/candles/option` |
| **LLM** | **0 or 1** | mutually exclusive branches in `decide()`; 0 in the common case |
| **ML inference** | **0** | none exists |
| Embedding | **1** | `buildWhy → learningReferences → retrieve → memory.search` |
| Postgres reads | ~5 + **up to 9 N+1** | graph expansion loop |
| Postgres writes | 2 + 1 per triggered signal | |
| Internal hops | 2 | browser → api → sentinel |
| Caches | 2 | polish cache (5min/500), option-chain TTL |
| Retries | ≤3 | browser only; every server hop is 0 |

Four of the six HTTP reads are **strictly sequential** despite being independent
(finding H-5).

### Other workflows

| Workflow | Internal | External | LLM | ML | Embed |
|---|---|---|---|---|---|
| Initial load | 2–3 (`/auth/me`, `/entitlements/me`, ±`/auth/refresh`) | 0 | 0 | 0 | 0 |
| Dashboard | 5–6 (`/market-data/indices`, `/sim/*`) | 0 | 0 | 0 | 0 |
| Chart load | 3–5 + direct bridge | 1+ | 0 | 0 | 0 |
| Market refresh | 1 per interval per hook | 1 | 0 | 0 | 0 |
| Strategy analysis (`sentinel-py`) | 1 | 0 | **0** | 0 | 0 |
| Strategy generation (`/strategies/parse`) | 1 | 0 | **0 — deterministic parser** | 0 | 0 |
| `/explain` | 1 | 0 | **1** | 0 | 0 |
| Manual refresh | same as the surface refreshed | | | | |
| WS reconnect | n/a — no browser WebSocket | | | | |
| Failure/retry | ≤3 browser attempts, no server-side multiplication | | | | |

**Note on strategy generation:** `sentinel-py`'s strategy parser is fully
deterministic — no LLM. A user writing a strategy in text gets a rule parser,
not a model. `CONFIRMED-SOURCE`.

---

# 4. LLM Inventory

Six call sites in application code. Only **one** is reachable from a routine user
action.

| ID | Location | Trigger | Per action | Timeout | Fallback | Load-bearing |
|---|---|---|---|---|---|---|
| LLM-01 | `sentinel-orchestrator.service.ts:934` `polish()` | `/observe`, only when the gate opens | 0–1 | **NONE** | deterministic draft | **No** |
| LLM-02 | `explain.service.ts:225` | `/explain` | 1 | **NONE** | deterministic text | No |
| LLM-03 | `news-event-classifier.ts:111` | headline classification | **1 per headline**, concurrency 5 | inherits | none | No |
| LLM-04 | `agents/impl.ts:63` | `services/tradew-ai` assistant | 1 per turn + tool loop | inherits | none | Yes |
| LLM-05 | `brain/impl.ts:82,157` | DI-registered, no traced route caller | — | — | — | UNKNOWN |
| LLM-06 | `research/impl.ts:68` | fire-and-forget from `runObservation:188` | unbounded | inherits | swallowed | No |

**Provider actually selected in this deployment:** `AI_LLM_ORDER =
anthropic,nvidia-nim,openai,ollama` with `ANTHROPIC_API_KEY` set →
**Anthropic**, model `claude-haiku-4-5-20251001` (the `fast` tier),
`maxTokens: 260`.

### Why the LLM is not load-bearing

```ts
// sentinel-orchestrator.service.ts:887 — the draft is already complete
const fallback = `${status} on ${symbol} at ${confidence.score}% confidence, ...`;
return this.polish(fallback, systemPrompt, userPrompt);
```
`polish()` returns `fallback` on any throw, and the output passes through
`enforceVocabulary()` regardless. Every number originates in the deterministic
engine. **The LLM changes wording, never conclusions.**

### Efficiency review (brief §12)

- Necessary? **No** — it is a presentation nicety.
- Could deterministic code do it? **It already does**, and the draft ships when the model is absent.
- Cached? **Yes** — 5min TTL, 500 entries, keyed on the draft.
- Called before data is ready? **No** — it runs last.
- Called on every tick? **No** — only when the four-condition gate opens (≤4.8% of observations).
- Output consumed? **Yes.**
- Duplicate reasoning by another agent? **No** — Engine 2 is read as a cached corroboration signal, never re-invoked synchronously.

This is a well-disciplined AI integration. The problems around it are timeout and
telemetry, not overuse.

---

# 5. ML Inventory

**Trained-model inference call sites: 0.**

Verified by sweeping all 754 production files for `onnx|torch|tensorflow|
sklearn|scikit|xgboost|lightgbm|transformers|numpy|pandas|scipy` — **zero
matches**. `services/sentinel-py/pyproject.toml` declares only `fastapi`,
`uvicorn`, `pydantic`, `httpx`, `python-dotenv`, `asyncpg`.

The only adaptive component is the **cognition network** — online
reward-modulated Hebbian learning with a delta rule
(`packages/ai-core/src/cognition/weights.ts:248`), pure TypeScript, no model
artifact, no inference step. It is enabled here (`COGNITION_ENABLED=true`) and
**has learned nothing**: `Percept` 1,120, `CognitiveEpisode` 970,
**`NeuralSynapse` 0**. `CONFIRMED-RUNTIME`. See finding C-2.

Modules whose names suggest ML but are deterministic on inspection:
`news-event-classifier` (an **LLM** call), `market-behaviour.service`,
`regime-intelligence.service`, `contract-alignment`, `watch/indicators.py`.

**Classification discipline, per brief §6:** in this system
`LLM ≠ ML ≠ embedding ≠ deterministic`, and the honest tally is
**LLM: 6 sites · ML inference: 0 · embeddings: 4 · everything else:
deterministic**.

---

# 6. Embedding Inventory

| ID | Location | Trigger | Per action | Timeout |
|---|---|---|---|---|
| EMB-01 | `prisma-memory-store.ts:114` | **`/observe`** via `buildWhy` | 1 | **NONE** |
| EMB-02 | `prisma-memory-store.ts:67` | memory write | 1 per record | **NONE** |
| EMB-03 | `cognition/layers.ts:182` | L2 encode pass | batch | **NONE** |
| EMB-04 | `brain-import.service.ts:54` | corpus ingestion | per chunk | **NONE** |

Provider: `nvidia-nim` (`AI_EMBEDDING_ORDER`), key set. Vector search is pgvector
cosine over `MemoryRecord` (10,765 rows). Degrades to `ILIKE` text matching when
no embedder is registered — a genuine, working fallback.

---

# 7. External Provider Inventory

15 providers referenced; 6 configured in this deployment.

| Provider | Criticality | Configured | Timeout | Retry | Fallback | Runtime status |
|---|---|---|---|---|---|---|
| **Dhan** | **CRITICAL** | yes | 4s (bridge hop) | none | Candle table → fail closed | **FAILING — token expired** |
| Anthropic | LOW | yes | **none** | none | deterministic draft | untested |
| NVIDIA NIM | LOW | yes | 300s (LLM only) | none | — | untested |
| NSE public | MEDIUM | keyless | — | none | named-unavailable | working, p95 10s |
| Razorpay | HIGH | yes | — | none | idempotent on payment id | not exercised |
| Twelve Data | LOW | yes | — | none | — | working |
| Binance | LOW | keyless | — | none | — | **33.1% error rate** |
| SendGrid/SMTP · Twilio · Google OAuth · OpenAI · Voyage · Tavily · Brave · Firecrawl | — | **no** | — | — | — | disabled |

Dhan is the only true single point of failure: no alternative market-data
provider exists, and its credential expires every 24 hours by SEBI regulation.

---

# 8. Internal Service Inventory

| Caller → Callee | Auth | Timeout | Retry | Failure mapping |
|---|---|---|---|---|
| browser → `services/api` | Bearer JWT | **none** | 3 (browser) | `ApiError` with status |
| `services/api` → `sentinel` | `x-service-token`, constant-time | **none** | 0 | 503 passthrough / 502 |
| `services/api` → `sentinel-py` | `x-service-token` | — | 0 | — |
| `sentinel-py` → `services/api` | shared token | 5s | 0 | logged |
| `sentinel` → bridge | none | **4s** | 0 | → null → next tier |
| `apps/admin` → `api` | operator assertion + admin token | — | 0 | deny-by-default allowlist |

The `sentinel → bridge` hop is the only internal call with a timeout.

---

# 9. Runtime Measurements

Full detail in [`api-runtime-measurement.md`](api-runtime-measurement.md).
Source: the pre-existing `ApiCallLog` table — **181,541 rows, 2026-08-03 →
2026-08-17**.

### `/sentinel/observe`, 2,177 calls

| Status | Calls | Share |
|---|---|---|
| 201 success | 1,508 | 69.3% |
| 503 no market data | 602 | 27.7% |
| 502 unreachable | 59 | 2.7% |
| 500 crash | 8 | 0.4% |

Latency (success only): **p50 2,178ms · p95 7,703ms · p99 11,316ms · max
54,984ms**.

**Today:** 38 calls, **29 errors — 76% failure rate**.

### Telemetry table population

| Table | Rows |
|---|---|
| `ApiCallLog` | **181,541** |
| `SentinelObservation` | 10,817 |
| `MemoryRecord` | 10,765 |
| `Percept` | 1,120 |
| `CognitiveEpisode` | 970 |
| **`AiCallLog`** | **0** |
| **`AgentActivity`** | **0** |
| **`AgentRun`** | **0** |

### LLM usage, bounded

`agent='orchestrator'` observations — written only where `polish()` is reached:

- `synthesized_risk_awareness`: **71** (last 2026-08-11)
- `synthesized_market_guidance`: **1** (last **2026-08-05**)
- **Upper bound on orchestrator LLM calls, all time: 72**

The flagship guidance output has fired **once ever**. Nothing since 2026-08-11.

### Tests

**1,520 passing, 0 failing** — sentinel 366, web 471, api 409, sentinel-py 274,
plus the market-data parser verify.

---

# 10. Static vs Runtime Comparison

| Metric | Expected (source) | Actual (runtime) | Difference |
|---|---|---|---|
| `/observe` external HTTP | 6 | **1** (aborts at first `/candles`) | fails at stage 1 |
| `/observe` LLM | 0–1 | **0** | never reached |
| `/observe` embedding | 1 | **0** | never reached |
| `/observe` latency | ~1.6s (design note) | p50 2,178 / p95 7,703 | **1.4× / 4.8×** |
| LLM calls all-time | unbounded | **≤72** | gate rarely opens |
| ML inference | 0 | **0** | agrees |
| `AiCallLog` rows | 1 per LLM call | **0** | sink absent in process |
| Retry amplification | 27 hypothesised | **3** | only one layer retries |

---

# 11. Duplicate Call Analysis

**Verdict: duplication is not a significant problem here.** This is the brief's
biggest hypothesis that the evidence does not support.

| Suspected source | Present? | Evidence |
|---|---|---|
| React StrictMode double-mount | **Dev only** | `reactStrictMode` unset (`config-shared.js:81` default `null`); StrictMode double-invoke never affects production |
| Parent + child fetching the same data | **No** | TanStack Query key dedupe collapses concurrent identical keys |
| Duplicate refresh-token requests | **Fixed** | single-flight `refreshInFlight`, `api.ts:104` |
| Retry stacking across layers | **No** | 3 × 1 × 1 × 1 = **3**; every server hop is `retries: 0` |
| SDK retry + custom retry | **No** | no SDKs — all providers are raw `fetch` |
| Duplicate WebSocket subscriptions | **No** | exactly one browser WebSocket exists |
| Duplicate LLM calls | **No** | branches are mutually exclusive + 5min polish cache |
| **Hand-rolled polls outside dedupe** | **YES** | 10 `setInterval` hooks; `useOptionQuote` (3s) and `OptionChainTab` (3s) both poll option data independently |
| **Two paths to the same bridge** | **YES** | browser → `:4600` direct *and* sentinel → `:4600` server-side (H-6) |

Only the last two are real. Both are **fragmentation**, not amplification.

---

# 12. Retry Amplification

```
browser TanStack Query : 3 attempts, exponential 1s/2s/4s, cap 30s, +500ms jitter
api() wrapper          : +1, only after a successful 401 refresh
services/api → sentinel: 0
sentinel → bridge      : 0   (4s timeout)
ai-core → provider     : 0
                         ─────────────────────────────
worst case at provider : 3   (NOT 27)
```

**The 3×3×3 = 27 scenario does not occur.** Multiplication requires two or more
retrying layers; this system has exactly one. `CONFIRMED-SOURCE`.

The real risk is the inverse: with `retries: 0` everywhere server-side and **no
timeout** on three hops, a single hung upstream propagates all the way to the
browser without any layer bounding it.

---

# 13. Market Data Consistency

| Consumer | Source | Timeframe | Freshness gate |
|---|---|---|---|
| Chart (`SentinelLiveCharts`) | bridge `:4600` **direct from browser** | watch's `rules.timeframe` | none |
| Sentinel engine | bridge `:4600` **server-side** | `SNAPSHOT_INTERVAL` (15m) | none |
| Deterministic analysis | same snapshot object | 15m | n/a |
| LLM input | prose derived from that snapshot | 15m | n/a |
| ML input | — | — | no ML exists |

**Same origin, two independent paths, no shared freshness contract** (H-6).

Measured today at 17:21 IST: every index quote **384.8 minutes stale**, envelope
`marketOpen:false`, every quote inside stamped `marketStatus:"open"` — a field
frozen at write time (`live-feed-server.ts:421`). The last tick was 10:56 IST
against a 15:30 close, so **4.56 hours of the session produced no ticks** and
nothing alerted.

Two genuinely good behaviours worth crediting:

- **Candles fail closed.** Sentinel refuses to substitute simulated data and
  returns 503 rather than inventing a market. This is the correct choice and it
  works.
- **Interval discipline.** `contracts()` deliberately reads index, CE and PE on
  one clock, because comparing a 15m index move to a 1m premium move and calling
  the difference divergence would be wrong.

Against that: **quotes do not fail closed** (breadth/VIX silently use 6-hour-old
values), and a `3m` strategy is silently evaluated on **5m** bars via
`INTRADAY_INTERVAL[interval] ?? '5'` (H-7).

---

# 14. Database / Cache Analysis

Per `/observe`:

| Operation | Count |
|---|---|
| Postgres reads | ~5 (+ up to 9 N+1 from graph expansion) |
| Postgres writes | 2 + 1 per triggered signal |
| pgvector similarity | 1 |
| Redis | **0 — Redis is not used anywhere in this repository** |
| In-process caches | polish (5min/500), option-chain TTL, `staleTime` 5s / `gcTime` 5min in the browser |

**There is no shared cache and no Redis.** Every cache is per-process memory, so
they do not survive a restart and do not coordinate across replicas — the same
constraint already documented for the rate limiter.

`ApiCallLog` grows at ~13,000 rows/day and is bounded only by
`TELEMETRY_RETENTION_DAYS=30`.

---

# 15. Failure Scenarios (traced)

| Failure | Behaviour | Verdict |
|---|---|---|
| **Market API fails** | 200-with-error → `source!=='dhan'` → Candle table → empty → 503 | fails closed ✅, wrong message ❌ |
| **LLM fails (throws)** | caught → deterministic draft | **degrades cleanly ✅** |
| **LLM hangs** | no timeout → `/observe` hangs | **CRITICAL ❌** |
| **Embedding fails** | caught → `learningReferences` returns `[]` | degrades ✅ |
| **Embedding hangs** | no timeout → observation hangs | HIGH ❌ |
| **ML fails** | n/a — no ML | — |
| **Database fails** | Brain writes wrapped non-fatal; core reads propagate | mixed ✅ |
| **WebSocket disconnects** | bridge reconnects; browser never told; stale data served as current | **silent ❌** |
| **Rate limit hit** | 429 + `Retry-After`, honoured by client backoff | **good ✅** |
| **Timeout at bridge** | 4s abort → null → next tier | good ✅ |
| **Malformed payload** | `res.json().catch(() => ({}))` | tolerant ✅ |
| **Stale data** | **no detection on the quote path** | **❌** |
| **User gets incorrect success state** | **Yes** — stale quotes render as live prices with `marketStatus:"open"` | ❌ |

The pattern: **explicit thrown errors are handled well; hangs and staleness are
not handled at all.**

---

# 16. Cost Analysis

No pricing is invented. Formulas, with the one measured input available.

```
LLM cost per observation
  = P(gate opens) × (1 − cache_hit) × (in_tok × price_in + out_tok × price_out)

Measured:  P(gate opens)  = 72 / 1508  ≈ 0.048
           maxTokens      = 260 (output ceiling)
           model          = claude-haiku-4-5 (fast tier)
           cache          = 5min TTL, 500 entries

⇒ ~95% of observations cost ZERO in LLM terms.
```

```
Embedding cost per observation = 1 call × query_tokens × embed_price
                                 (NVIDIA NIM free tier here ⇒ ~0)

Market data cost = 6 bridge calls → shared Dhan quota
                   (rate-limited, not per-call billed)

Worst-case retry-amplified cost = 3 × single-action cost   (not 27×)
```

**Conclusion: AI spend is negligible and well-controlled.** The expensive
resource in this system is **latency and the Dhan rate limit**, not tokens.

The figures above cannot be reconciled against actual provider spend, because
`AiCallLog.costUsd` — the field designed for exactly this — has never been
written (C-1).

---

# 17. Latency Analysis

Critical path of one observation (measured p50 2,178ms):

```
browser → api            ~5-20ms
api → sentinel           ~5ms
  snapshot: 4 SEQUENTIAL bridge reads   ← dominant, ~4 × 200-400ms
  deterministic agents                   ~sub-ms (pure computation)
  embedding + pgvector + up to 9 N+1     ~100-500ms
  LLM polish (when it fires)             ~300-2000ms, UNBOUNDED on hang
  DB writes                              ~10-50ms
```

| Property | Finding |
|---|---|
| Slowest dependency | the 4 serial bridge reads (H-5) |
| Parallelisable | **yes** — all four are independent; only `contracts()` uses `Promise.all` |
| Serial that shouldn't be | snapshot reads, and the N+1 graph expansion |
| Off critical path already | `contracts()` (started early, awaited late) — good design |
| Unbounded | LLM polish, embeddings, both internal hops |

Largest single win: `Promise.all` on the four snapshot reads. Behaviour-neutral.

---

# 18. Reliability Score

| Dimension | Score | Basis |
|---|---|---|
| **API reliability** | **3 / 5** | timeouts + fallbacks on the market path; none on three hops; no circuit breaker anywhere |
| **LLM reliability** | **2 / 5** | excellent deterministic fallback, but no timeout, no retry, no runtime failover, zero observability |
| **ML reliability** | **N/A** | no ML exists. The one adaptive component has learned nothing (C-2) |
| **Market-data reliability** | **2 / 5** | fails closed on candles ✅; no staleness gate on quotes ❌; single provider; credential expires daily |
| **Observability** | **1 / 5** | `ApiCallLog` is excellent and real; **every AI/agent table is empty by construction** |
| **Cost efficiency** | **5 / 5** | LLM used sparingly, cached, non-load-bearing; no waste found |

**Overall weighted: 2.6 / 5.**

---

# 19. Workflow Integrity Verdict

## `PARTIAL` — with one `BROKEN` subsystem

Judged against the brief's own definitions:

- **Not `HEALTHY`** — the orchestration chain is real and each stage does pass
  validated output to the next, but three stages (AI telemetry, agent telemetry,
  cognition weights) are wired to sinks that never receive anything.
- **`PARTIAL` is exact** — "components exist but some are bypassed, mocked,
  disconnected, or inconsistently used." The AI telemetry sink is *disconnected
  by process boundary*; the cognition network is *inconsistently used*; the
  browser *bypasses* `services/api` for market data.
- **Not `BROKEN` overall** — the UI does not claim work the backend skips. When
  data is unavailable Sentinel says so and returns 503 rather than fabricating.
  That is the single most important integrity property and it holds.
- **Not `FRAGMENTED`** — there is one orchestration contract (`runObservation`),
  and it is genuinely central.
- **Not `OVER-ENGINEERED`** — the LLM is used once per observation at most, and
  only when a four-condition gate opens.
- **Partly `UNDER-ENGINEERED`** — three network dependencies have no timeout,
  and no dependency anywhere has a circuit breaker.

### Specific UI-vs-implementation checks from the brief §8

| Claim | Reality |
|---|---|
| "Sentinel analysed charts" | **TRUE** — it reads index + CE + PE on one clock |
| "Agent uses ML" | **No such claim is made in code**, and no ML exists |
| "Orchestrator delegates" | **TRUE** — but the browser bypasses it for market data (H-6) |
| Chart provider A vs agent provider B | **Same bridge, two uncoordinated paths** (H-6) |
| LLM receives stale market data | **Possible on the quote path** (no staleness gate); **not** on candles, which fail closed |
| ML output generated but ignored | **Yes** — 970 cognitive episodes, 0 weights persisted (C-2) |
| Agent Activity orbit shows "real work" | **FALSE** — `AgentActivity` has 0 rows; the orbit renders nothing real |

---

# 20. Findings Summary

Full evidence blocks in [`api-reliability-findings.md`](api-reliability-findings.md).

### CRITICAL (4)
- **C-1** AI telemetry written by a process that never makes AI calls — `AiCallLog` = 0 rows
- **C-2** Cognition network enabled, 970 episodes, **0 weights learned**
- **C-3** Primary LLM provider (Anthropic) has **no timeout** — defeats the fallback design
- **C-4** Bridge reports failure as HTTP 200; `error` field undeclared and unread; user-facing cause is wrong.
  **Status: confirmed at runtime against the committed state; being fixed in the working tree
  during this audit** — the bridge now emits a named `fault` / `needsOperator` discriminator
  (`describeFault`) and Sentinel now reads it (`FeedFault`, `FeedRead<T>`). HTTP 200 is
  **retained deliberately** there, with the documented rationale that the bridge did answer and
  the body names the upstream fault. That is a defensible call; this audit's suggestion to use
  502/503 is therefore a *disagreement with a deliberate decision*, not an open defect. The
  substance — the diagnostic being discarded — is resolved.

### HIGH (7)
- **H-1** No runtime failover between AI providers (`pick()` is registration-order only)
- **H-2** Embedding provider has no timeout
- **H-3** No timeout on either internal service hop
- **H-4** `/auth/refresh` fails 36.8% (745 calls)
- **H-5** Four independent snapshot reads run strictly sequentially
- **H-6** Chart and engine reach the same bridge by two uncoordinated paths
- **H-7** `3m` strategies silently evaluated on `5m` bars

### MEDIUM (8)
N+1 graph expansion · frozen `marketStatus` · no staleness gate · 4.56h tick gap ·
`/crypto/quotes` 33% errors · `/nse/breadth` p95 10s · 10 hand-rolled polls ·
fire-and-forget work swallowing errors

### LOW (5)
Dead `SimpleChunker` · DI-registered-but-uncalled engines · committed `.next`
build artifacts · unreadable citation corpus · duplicated service-token env name

---

# 21. Recommended Fix Order

Correctness → reliability → observability → efficiency → cost → latency.
**No rewrite is warranted.**

1. **Add the two missing timeouts** (C-3, H-2) — Anthropic + embeddings. Two
   files, no behaviour change; removes the unbounded-hang class.
2. **Make the bridge's failures legible** (C-4) — real status code, declare and
   log `error`. Makes the daily token expiry self-diagnosing.
3. **Install the telemetry sink in `services/sentinel`** (C-1) — until this
   lands, *no cost or reliability claim about AI in this system is verifiable*,
   including the ones in this report.
4. **Timeouts on both internal hops** (H-3).
5. **Resolve the cognition no-op** (C-2) — find why no synapse is written;
   default it off until it demonstrably learns.
6. **`Promise.all` the four snapshot reads** (H-5) — biggest latency win, smallest diff.
7. **Batch the N+1** (M-1).
8. **Design decisions, scheduled deliberately** — market-data path unification
   (H-6), provider failover semantics (H-1), interval substitution (H-7).

Also worth doing, and cheap: **one integration test that runs against a bridge
returning `{"source":"error"}`**. 1,520 tests pass today precisely because none
of them cross that boundary.

---

# 22. Final Verdict

```
OVERALL WORKFLOW:        PARTIAL
API RELIABILITY:         3 / 5
LLM RELIABILITY:         2 / 5
ML RELIABILITY:          N/A  (no ML exists; the one adaptive component has learned nothing)
MARKET DATA RELIABILITY: 2 / 5
OBSERVABILITY:           1 / 5
COST EFFICIENCY:         5 / 5
```

**The blunt version.** This is a carefully built system with unusually honest
degradation — it refuses to invent market data, its LLM is decorative by design
so an outage costs wording rather than correctness, and its retry topology
avoids the amplification trap most codebases fall into. It is also, right now,
**blind and stopped**: the flagship workflow has failed 76% of today's calls on
an expired daily credential while reporting the wrong cause, the AI telemetry
that would have revealed any of this has never received a row, and a learning
network is switched on and learning nothing. The gap is not architecture. It is
three missing timeouts, one misplaced telemetry sink, and one error field nobody
reads.

---

# 23. The Question the Brief Says Matters Most

> *"When the user performs a real action in this application, what EXACTLY
> happens from the first request to the final result?"*

**A user opens `/sentinel` and selects NIFTY. Today, 2026-08-17, this is
exactly what happens:**

```
 1. useSentinel() fires useQuery(observeKey)          apps/web/src/lib/sentinel/useSentinel.ts:124
 2. api('/sentinel/observe')                          apps/web/src/lib/api.ts:178   [no timeout]
 3. POST :4000/sentinel/observe                       services/api SentinelController
 4. SentinelService.observe() → fetch :4010/observe   sentinel.service.ts:106       [no timeout, 0 retries]
 5. runObservation()                                  sentinel-orchestrator.service.ts:180
 6.   void researchIfUnfamiliar(NIFTY)                fire-and-forget, errors swallowed
 7.   void outcomeLearning.evaluatePending(5)         fire-and-forget
 8.   market.snapshot('NIFTY')
 9.     getCandles('NIFTY','15m') → GET :4600/candles [4s timeout]
10.       bridge → api.dhan.co → HTTP 401 DH-901      TOKEN EXPIRED
11.       bridge returns HTTP **200** {"candles":[],"source":"error","error":"..."}
12.     fetchJson: res.ok === true → body returned; `error` never read
13.     guard `source !== 'dhan'` → null
14.     candlesFromTable() → Instrument lookup → no rows → null
15.     → throw MarketDataUnavailableError
16.   AppController catches → 503
17. services/api maps 503 → ServiceUnavailableException, message passed verbatim
18. api() throws ApiError(503) → TanStack Query retries 3× (1s, 2s, 4s + jitter)
19. all 3 fail identically
20. UI renders: "The Dhan live-feed bridge is unreachable"   ← factually wrong;
                                                               the bridge answered in 31ms
```

**Exact call count for that user action today:**

| Class | Count |
|---|---|
| Browser → API | **4** (1 + 3 retries) |
| API → Sentinel | **4** |
| Sentinel → bridge | **4** |
| Bridge → Dhan | **4** (each a 401) |
| Postgres | **4** (Instrument lookup per attempt) |
| **LLM** | **0** |
| **ML** | **0** |
| **Embedding** | **0** |
| **Total network calls** | **20** |
| **Total user-visible result** | one wrong error message |

**When the token is valid**, the same action costs **6 bridge calls, ~5 DB
reads (+ up to 9 N+1), 2+n DB writes, 1 embedding, and 0–1 LLM calls**, in
~2.2s at p50 — and in ~95% of cases the LLM is not called at all.

That is the unambiguous answer.
