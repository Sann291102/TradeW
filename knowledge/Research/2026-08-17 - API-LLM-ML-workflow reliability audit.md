---
type: research
date: 2026-08-17
tags: [audit, reliability, llm, ml, telemetry, market-data, observability]
---

# 2026-08-17 — API / LLM / ML / workflow reliability audit

Full forensic audit executed against `APIcallandrealiabilty.md`. Deliverables at
the repo root: `APIcallandrealiabilty-AUDITED.md` (main),
`api-call-inventory.json`, `api-call-graph.md`, `api-runtime-measurement.md`,
`api-reliability-findings.md`. **Read those for evidence; this note records only
what is durable and non-obvious.**

Verdict: **workflow PARTIAL · overall reliability 2.6/5 · observability 1/5 ·
cost efficiency 5/5.** No rewrite warranted — every CRITICAL is a few lines.

## The four things worth remembering

**1. There is no machine learning in this repository.** Zero matches for
`onnx|torch|tensorflow|sklearn|xgboost|lightgbm|transformers|numpy|pandas`
across 754 production files; `sentinel-py` declares only fastapi/uvicorn/
pydantic/httpx/dotenv/asyncpg. Everything called "intelligence" is a
deterministic rule/statistics engine. The only adaptive component is the
cognition network's Hebbian weight updater — **not** model inference. Stop
describing any path as "ML inference"; it never was one.

**2. The LLM is cosmetic, and the count is tiny.** `polish()`
(`sentinel-orchestrator.service.ts:934`) rewrites an already-complete
deterministic draft; every number and gate is computed without it. `decide()`'s
branches are mutually exclusive, so `/observe` makes **0 or 1** LLM calls, 0 in
the common case. Runtime bound from `SentinelObservation agent='orchestrator'`:
**≤72 LLM calls in the system's entire history**, and
`synthesized_market_guidance` has fired **exactly once ever (2026-08-05)**.
`buildWhy()` — which *is* on the `/observe` path — does **not** call the LLM;
the LLM in `explain.service.ts` is on `/explain` only.

**3. `emitAiCall` is a no-op in every process that makes AI calls.**
`setTelemetrySink()` has exactly one caller —
`services/api/src/telemetry/telemetry.service.ts:117` — so the sink exists only
in the **services/api** process. All LLM/embedding/agent calls happen in
**services/sentinel**, a separate process with its own `@tradew/ai-core` module
instance where `getTelemetrySink()` is `null`. Result after 14 days:
`ApiCallLog` **181,541 rows**, but `AiCallLog` **0**, `AgentActivity` **0**,
`AgentRun` **0**. Consequences: the admin console's AI cost dashboards read a
table nothing writes; the cognition perceptor at
`application.perceptors.ts:216` (`aiCallLog.groupBy`) is structurally dead; and
**the platform cannot answer how much it spends on AI** — neither could this
audit, which is why §5 of the runtime file *bounds* rather than counts. This
also means the "agent orbit" the orchestrator comments describe as "real work,
in the order it actually happened" renders nothing real.

**4. The cognition network is on and has learned nothing.**
`COGNITION_ENABLED=true` here, `Percept` 1,120, `CognitiveEpisode` 970,
**`NeuralSynapse` 0**. A weight only moves on a *scored outcome*, and one of its
input perceptors is dead per (3). Do not tune it — first assert that a pass
observing ≥1 episode writes ≥1 synapse.

## Timeouts: the asymmetry that defeats the fallback design

`AnthropicLlmProvider.complete()` (`impl/anthropic.ts:54`) has **no
`AbortSignal`, no timeout, no retry**, and `AnthropicConfig` has no `timeoutMs`
field — while the NIM provider *does* get one (300s). This deployment's
`AI_LLM_ORDER` puts `anthropic` first with a live key, so the provider with no
timeout is the one selected. The orchestrator's `try/catch` → deterministic
fallback handles **errors**, but a hung socket never throws, so the safety net
is defeated by exactly the failure it exists for. Same defect in the embedding
provider (`openai-compatible.ts:224`, where `:131` sets one). Both internal hops
(`api.ts:180`, `sentinel.service.ts:106`) also have no timeout.

**`AI_LLM_ORDER` is not failover.** `provider-manager.ts:89` `pick()` returns
the first *registered* provider and never reconsiders on call failure, despite
the file comment saying "Primary/fallback order". Registration preference only.

## Retry amplification does NOT stack here

Worst case is **3, not 27**. Only one layer retries (browser TanStack Query, 3×
with backoff+jitter); `api()` adds one retry on 401-after-refresh only, and
every server hop is `retries: 0`. The real risk is the inverse — `retries: 0`
everywhere plus no timeouts means one hung upstream propagates uncapped.

## Duplicate calls are largely a non-problem

TanStack Query key-dedupe collapses concurrent identical requests; the
refresh-token single-flight (`api.ts:104`) works; there is exactly **one**
browser WebSocket (live data is HTTP polling throughout); StrictMode
double-invoke is dev-only. Real residue: **10 hand-rolled `setInterval` hooks
outside query dedupe** despite `lib/query/live.ts` claiming to have replaced
them, and the browser calling the bridge (`:4600`) **directly** via
`dhanLiveFeed.ts`, bypassing `services/api` — same origin as Sentinel's reads,
two uncoordinated freshness windows.

## Latency: the shape is serial, not expensive

`market-intelligence.service.ts:124` `snapshot()` awaits **four independent
network reads strictly sequentially** (15m candles → breadth → 1d candles →
option chain); only `contracts()` uses `Promise.all`. Measured `/observe`:
p50 **2,178ms**, p95 **7,703ms**, p99 **11,316ms**, max **54,984ms** — against a
design note claiming ~1.6s. Plus an N+1: `rag/impl.ts:52` graph expansion does 1
vector search then up to **9 sequential** `memory.get()` awaits. `Promise.all` on
the four is the largest win for the smallest diff.

## 1,520 green tests while the product fails 76% of calls

sentinel 366 · web 471 · api 409 · sentinel-py 274, all passing — while
`/sentinel/observe` failed **29 of 38 calls** on the audit day. Every suite mocks
the market-data boundary, so the failure class actually occurring (expired
upstream credential, HTTP-200-with-error-body, stale cache) is **structurally
invisible** to them. One integration test against a bridge returning
`{"source":"error"}` would have caught it.

## What was right, and should not be "fixed"

Credit where due, so nobody refactors these away: candles **fail closed**
(Sentinel returns 503 rather than substituting simulated data — verified live);
`contracts()` deliberately reads index/CE/PE on **one clock**; the LLM draft is
always complete so an AI outage costs wording, not correctness; 429s carry
`Retry-After` and the client honours it; `contracts()` is started early and
awaited late to keep it off the critical path.

## Gotcha: Git Bash ignores `TZ`

`TZ=Asia/Kolkata date` under Git Bash/MSYS returned the **UTC** time labelled as
IST, which briefly made a closed market look open and inverted a staleness
reading. Trust `node -e "new Date().toString()"` (reports the real zone offset)
over `TZ=… date` on this machine. Cost ~10 minutes and one wrong claim.

## Cross-session hazard observed

The working tree carried **854 lines of uncommitted concurrent work**, and three
audited files were edited **mid-audit** (17:30–17:34) — `live-feed-server.ts`,
`candle-market-data.provider.ts`, `market-intelligence.service.ts`. C-4 was
fixed underneath the audit (the bridge now emits a named `fault` /
`needsOperator` via `describeFault`, and Sentinel reads it via `FeedFault` /
`FeedRead<T>`; HTTP 200 retained deliberately). H-5, H-7 and M-2 were
re-verified as still present at 17:36. **When auditing this repo, record file
mtimes and re-verify any finding whose file changed during the pass** — and cite
the working tree, not a commit, unless the tree is clean.

Related: [[Plans/2026-08-10 - Production readiness audit (security, scale, infra)]] ·
[[Decisions/2026-08-12 - Cognition network (perceptors + four layers)]] ·
[[Patterns/2026-08-16 - Sentinel charts on the bars the engine reads (the chart and the agent disagreed)]] ·
[[API/2026-08-11 - Dhan Algo Strategies]]
