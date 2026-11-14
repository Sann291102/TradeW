# TradeW — API Reliability Findings

Companion to `APIcallandrealiabilty-AUDITED.md`. Every finding uses the evidence
format required by the audit brief §19. Labels: `CONFIRMED-RUNTIME`,
`CONFIRMED-SOURCE`, `INFERRED`, `UNKNOWN`.

Severity counts: **4 CRITICAL · 7 HIGH · 8 MEDIUM · 5 LOW**

---

# CRITICAL

## C-1 — AI telemetry is written by a process that never makes AI calls

**Finding:** `AiCallLog`, `AgentActivity` and `AgentRun` are read by the admin
console and by the cognition network, but are never written, because the
telemetry sink is installed only in `services/api` while every AI call is made
in `services/sentinel`.

**Status:** BROKEN

**Evidence:** `setTelemetrySink()` has exactly one caller in the repository.
`emitAiCall()` is a no-op when no sink is installed (`bus.ts:80`). The
`services/sentinel` process has no telemetry module at all.

**File / Function / Line:**
- `services/api/src/telemetry/telemetry.service.ts:117` — `setTelemetrySink(this)` (the only installation)
- `packages/ai-core/src/telemetry/bus.ts:80` — `emitAiCall`
- `packages/ai-core/src/providers/provider-manager.ts:54` — instrumentation applied
- `services/sentinel/src/orchestrator/sentinel-orchestrator.service.ts:934` — the LLM call, in the wrong process

**Runtime evidence:** `AiCallLog` = **0 rows**, `AgentActivity` = **0**,
`AgentRun` = **0**, alongside `ApiCallLog` = **181,541 rows** over the same 14
days. `CONFIRMED-RUNTIME`.

**Impact:** No LLM cost, latency, token or failure data exists anywhere. The
admin console's AI dashboards render permanent zeros. The cognition perceptor at
`services/api/src/cognition/perceptors/application.perceptors.ts:216` reads
`aiCallLog.groupBy` and therefore feeds the Hebbian network a constant. This
audit could not count LLM calls for the same reason — only bound them.

**Severity:** CRITICAL

**Recommendation:** Install the sink in `services/sentinel`'s bootstrap and have
it persist through its own Prisma client (or POST batches to a small internal
ingest route on `services/api`). One call site; no product behaviour changes.

---

## C-2 — The cognition network has learned nothing, and it is switched on

**Finding:** `COGNITION_ENABLED=true` in this deployment. The network senses and
records episodes but has never persisted a single weight.

**Status:** BROKEN

**Evidence / Runtime evidence:** `Percept` = 1,120, `CognitiveEpisode` = 970,
**`NeuralSynapse` = 0**. `CONFIRMED-RUNTIME`.

**File:** `packages/ai-core/src/cognition/weights.ts:248` (the delta-rule update);
`services/api/src/cognition/perceptors/application.perceptors.ts:216`

**Impact:** The learning loop is running, consuming a pass every
`COGNITION_PASS_MS` (300s) under leader election, and producing no learning. A
weight only moves on a *scored outcome*; with `AiCallLog` empty (C-1) one of its
input perceptors is structurally dead. `NeuralSynapse` is deliberately excluded
from retention sweeps as the only irreplaceable table — and it is empty.

**Severity:** CRITICAL (silent no-op presented as a live capability)

**Recommendation:** Do not tune it. First establish whether any outcome is ever
scored; add one assertion that a pass which observes ≥1 episode writes ≥1
synapse. Consider defaulting `COGNITION_ENABLED=false` until then, per its own
documented default.

---

## C-3 — The primary LLM provider has no timeout

**Finding:** `AnthropicLlmProvider.complete()` issues a bare `fetch` with no
`AbortSignal`, no timeout and no retry. It is **first** in this deployment's
`AI_LLM_ORDER` with a live API key, so it is the provider actually selected.

**Status:** REAL (defect)

**Evidence:**
```ts
// packages/ai-core/src/providers/impl/anthropic.ts:54
const res = await fetch(`${this.baseUrl}/v1/messages`, {
  method: 'POST', headers: {...}, body: JSON.stringify(body),
});   // <- no signal, no timeout
```
`AnthropicConfig` (line 4) has no `timeoutMs` field at all. By contrast the NIM
provider does get one (`openai-compatible.ts:131`, default 300,000ms).

**File / Function / Line:** `packages/ai-core/src/providers/impl/anthropic.ts:54`,
`complete()`; selection at `packages/ai-core/src/providers/factory.ts:200` and
`.env` `AI_LLM_ORDER=anthropic,nvidia-nim,openai,ollama`

**Runtime evidence:** `/sentinel/observe` max duration **54,984ms** against a
p50 of 2,178ms. `CONFIRMED-RUNTIME` for the outlier; `INFERRED` for attributing
it to this call.

**Impact:** The orchestrator's `try/catch` fallback (line 958) handles *errors*,
but a hung socket is not an error — it never throws, so the deterministic
fallback never engages and `/observe` hangs. The safety net is defeated by the
one failure mode it was built for.

**Severity:** CRITICAL

**Recommendation:** Add `timeoutMs` to `AnthropicConfig` and pass
`AbortSignal.timeout()`, defaulting to something well under the caller's budget
(the polish call has `maxTokens: 260`; 10s is generous). One file.

---

## C-4 — Bridge signals failure with HTTP 200 and an error field nobody reads

> **⚠ STATUS UPDATE (17:34, during this audit).** A concurrent session fixed the
> substance of this finding in the working tree while the audit was running. The
> bridge now emits a named discriminator via `describeFault()`
> (`fault: 'auth'|'rate-limit'|'upstream'`, `error`, `needsOperator`), and
> `candle-market-data.provider.ts` now declares `FeedFault` and returns a
> discriminated `FeedRead<T>` carrying the reason. Its new comment cites "the
> 2026-08-17 audit" and states the exact defect below.
> **HTTP 200 is retained on purpose** — rationale in the code: the bridge *did*
> answer, and the body names what failed upstream of it. That is defensible, so
> recommendation (a) below is a disagreement with a deliberate design decision,
> not an open bug. Recommendation (b) is **done**.
> The finding is retained in full because it was **confirmed at runtime** against
> the committed state and is the proven cause of today's 76% failure rate.

**Finding:** When the upstream Dhan call fails, the live-feed bridge returns
**HTTP 200** with `{"candles":[],"source":"error","error":"..."}`. The consumer's
response type does not declare `error`, so the real diagnostic is discarded and
the user-facing message is wrong.

**Status:** BROKEN (as measured) → **FIXED in working tree, uncommitted**

**Evidence:**
```ts
// services/sentinel/src/market-data/candle-market-data.provider.ts:145
const json = await this.fetchJson<{ candles?: FeedCandle[]; source?: string }>(url);
if (!json || json.source !== 'dhan' || !Array.isArray(json.candles) || !json.candles.length) return null;
```
`error` is absent from the type. `fetchJson` checks `res.ok`, which is `true`.
The failure is caught only *incidentally*, by `source !== 'dhan'`.

**Runtime evidence:** `CONFIRMED-RUNTIME`.
```
GET :4600/candles?symbol=NIFTY&interval=15  -> HTTP 200
{"candles":[],"source":"error","error":"Dhan historical API returned 401 for
 NIFTY: {\"errorCode\":\"DH-901\",\"errorMessage\":\"... token is invalid or expired.\"}"}
```
The resulting user-facing 503 reads *"The Dhan live-feed bridge is unreachable"*
— but the bridge answered in **31ms** and is healthy.

**Impact:** The actual root cause (an expired 24h credential, a daily
operational event) is invisible in logs, dashboards and error messages.
Diagnosis requires manually curling an internal service. Today this produced a
**76% failure rate** on the flagship workflow with a misleading explanation.

**Severity:** CRITICAL (operational blindness on the most failure-prone dependency)

**Recommendation:** Two small changes — (a) bridge returns 502/503 for upstream
failures, (b) add `error?: string` to the consumer type and log it when present.
Keep the fallback chain exactly as it is.

---

# HIGH

## H-1 — No runtime failover between AI providers

**Finding:** `AI_LLM_ORDER` reads as a failover chain and is documented as
"Primary/fallback order", but `pick()` selects the first **registered** provider
and never reconsiders on call failure.

**Status:** PARTIAL (registration preference only)

**Evidence:**
```ts
// packages/ai-core/src/providers/provider-manager.ts:89
private pick<T>(capability: string, order: string[], registry: Map<string, T>): T {
  for (const name of order) { const provider = registry.get(name); if (provider) return provider; }
  throw new ProviderNotAvailableError(capability, order);
}
```
File comment line 10: *"Primary/fallback order comes from configuration"*.

**Impact:** If Anthropic is registered and returns 500, `nvidia-nim` is never
tried. Mitigated for the orchestrator (deterministic fallback) but not for
`explain` or the assistant. `CONFIRMED-SOURCE`.

**Severity:** HIGH · **Recommendation:** Either implement try-next-on-failure in
`pick`'s callers, or correct the comment and env docs to say "preference", not
"fallback". Do not leave the two disagreeing.

---

## H-2 — Embedding provider has no timeout

**Finding:** `OpenAiCompatibleEmbeddingProvider.embed()` has no `AbortSignal`,
unlike its sibling completion method in the same file.

**File / Line:** `packages/ai-core/src/providers/impl/openai-compatible.ts:224`
(compare `:131`, which does set one).

**Impact:** On the `/observe` path via `buildWhy → learningReferences →
retrieve → memory.search`. A hung embedding request hangs the observation.
`CONFIRMED-SOURCE`.

**Severity:** HIGH · **Recommendation:** Mirror the completion path's timeout.

---

## H-3 — No timeout on either internal service hop

**Finding:** Browser→API and API→Sentinel both use bare `fetch` with no timeout.

**File / Line:**
- `apps/web/src/lib/api.ts:180` and `:191` — the wrapper all 90 frontend call sites use
- `services/api/src/sentinel/sentinel.service.ts:106`

**Impact:** A slow Sentinel holds an API worker indefinitely; a slow API holds a
browser query indefinitely. The 54,984ms observation was survivable only because
nothing enforced a ceiling. `CONFIRMED-SOURCE`.

**Severity:** HIGH · **Recommendation:** `AbortSignal.timeout()` on both, with
the server-side budget shorter than the client's.

---

## H-4 — `/auth/refresh` fails 36.8% of the time

**Finding:** 274 failures across 745 calls, despite an extensively-documented
single-flight guard intended to prevent exactly this.

**Runtime evidence:** `CONFIRMED-RUNTIME` from `ApiCallLog`.

**File:** `apps/web/src/lib/api.ts:104` (`refreshInFlight` single-flight);
rotation/revocation in `services/api` auth service.

**Impact:** Refresh tokens are single-use and revoked on presentation, so a lost
race signs the user out at random. The in-tab guard cannot coordinate **across
browser tabs or across a reload**, which the comment does not claim to handle.
`/auth/signup` at 65.4% and `/auth/login` at 15.9% suggest the auth surface
needs its own pass.

**Severity:** HIGH · **Recommendation:** Investigate before changing code — the
failures may be dominated by expected 401s on absent tokens. Split the counter
by status before concluding.

---

## H-5 — `/observe` makes 4 independent data reads strictly sequentially

**Finding:** `snapshot()` awaits four mutually independent network reads in
series.

**Evidence:**
```ts
// services/sentinel/src/intelligence/market-intelligence.service.ts:127-141
const candles   = await this.marketData.getCandles(symbol, SNAPSHOT_INTERVAL, from, to);
const breadth   = await this.marketData.getMarketBreadth();          // independent
const dayCandles= await this.marketData.getCandles(symbol, '1d', ...); // independent
const chain     = await this.marketData.getOptionChain(symbol)...;     // independent
```
Only `contracts()` (line 210) uses `Promise.all`.

**Runtime evidence:** p50 2,178ms / p95 7,703ms against a design note claiming
~1.6s. `CONFIRMED-RUNTIME`.

**Impact:** Three avoidable serial round trips on the critical path of a request
polled every 10–60s by every open workspace.

**Severity:** HIGH · **Recommendation:** `Promise.all` the four. Behaviour-neutral
— `composeSnapshot` already receives them as independent inputs.

---

## H-6 — Chart and engine read the bridge by two independent paths

**Finding:** The browser calls the bridge (`:4600`) **directly**, bypassing
`services/api`, while Sentinel calls the same bridge server-side. Same origin
data, two uncoordinated freshness windows.

**File:** `apps/web/src/lib/dhanLiveFeed.ts` (6 `fetch` sites, `NEXT_PUBLIC_DHAN_LIVE_URL`)
vs `services/sentinel/src/market-data/candle-market-data.provider.ts`.

**Impact:** The chart can show a price the engine has not read, and vice versa —
the exact chart-vs-agent divergence class the vault records twice before
(2026-08-14, 2026-08-16). Also a standing exposure: an unauthenticated internal
service reachable from the browser.

**Severity:** HIGH · **Recommendation:** Route browser market data through
`services/api` so one cache and one freshness rule govern both, or stamp a
shared `asOf` on both paths and surface disagreement.

---

## H-7 — Silent interval substitution: a 3m strategy is evaluated on 5m bars

**Finding:** The bridge maps unknown intervals with
`INTRADAY_INTERVAL[interval] ?? '5'`, so a strategy saved as `3m` is silently
evaluated on 5m bars with no error anywhere in the chain.

**Status:** REAL (previously recorded in the vault, re-confirmed here)

**Impact:** The user's stated strategy timeframe and the engine's actual
timeframe differ, invisibly. `CONFIRMED-SOURCE`.

**Severity:** HIGH · **Recommendation:** Reject unsupported intervals explicitly
rather than defaulting; surface the substitution if it must remain.

---

# MEDIUM

## M-1 — N+1 query in retrieval graph expansion
`packages/ai-core/src/rag/impl.ts:52-60` — 1 vector search then up to 9
sequential `memory.get()` awaits inside a nested loop, on the `/observe` path.
Batch with a single `findMany({ where: { id: { in: [...] } } })`. `CONFIRMED-SOURCE`.

## M-2 — Frozen `marketStatus` on cached quotes
`live-feed-server.ts:421` stamps `marketStatus` at write time; a 10:56 IST tick
still reads `"open"` at 17:21 IST, contradicting the envelope's
`marketOpen:false`. `CONFIRMED-RUNTIME`.

## M-3 — No staleness gate anywhere in Sentinel's data path
No consumer checks `updatedAt`. Today the bridge served quotes **384.8 minutes**
old with no signal. Only the *candle* path fails closed; the quote path
(breadth/VIX) does not. `CONFIRMED-RUNTIME`.

## M-4 — 4.56 hours of the trading session produced no ticks
Last tick 10:56 IST against a 15:30 close, `feedStatus:"reconnecting"`, and
nothing alerted. `CONFIRMED-RUNTIME`.

## M-5 — `/crypto/quotes` fails 33.1% of the time
6,770 of 20,450 calls. Unauthenticated third-party proxy, polled every 10s.
`CONFIRMED-RUNTIME`.

## M-6 — `/nse/breadth` p95 is 10,016ms
Cookie-priming + scrape against an unofficial surface, on a 60s poll.
`CONFIRMED-RUNTIME`.

## M-7 — Ten hand-rolled `setInterval` polls sit outside query dedupe
`lib/query/live.ts` states it replaces `setInterval`, but 10 remain
(`useOptionQuote` 3s, `OptionChainTab` 3s, `useOptionChainStrikes` 4s,
`useCandles` 60s, `useNseContext` 60s, `useWatchPrices`, `useSessionStats`,
`SelectedStrategyPanel` 10s, …). Migrated surfaces get TanStack Query's
key-based dedupe; these do not. `CONFIRMED-SOURCE`.

## M-8 — Fire-and-forget work on the request path swallows all errors
`runObservation:188-191` voids `researchIfUnfamiliar` (which can reach an LLM and
web search) and `evaluatePending(5)` with `.catch(() => undefined)`. Unbounded,
unattributed, and invisible — including in cost. `CONFIRMED-SOURCE`.

---

# LOW

## L-1 — `SimpleChunker` has no consumers (dead code). `CONFIRMED-SOURCE`.
## L-2 — `DefaultNeuralBrain` / `DefaultResearchEngine` are DI-registered but have no traced caller from any HTTP route. `INFERRED`.
## L-3 — Committed Next.js build artifacts (`apps/web/.next.prodbuild-aside-*`) are tracked in git and pollute every repo-wide search. `CONFIRMED-SOURCE`.
## L-4 — Sentinel citation corpus unreadable at test time (`corpus root unreadable`); because uncited verdicts are dropped rather than flagged, SentinelIntelligence degrades to a silent no-op. `CONFIRMED-RUNTIME`.
## L-5 — `SENTINEL_SERVICE_TOKEN` / `SERVICE_TOKEN` are the same secret under two names, acknowledged in `.env.example` as consolidation debt. `CONFIRMED-SOURCE`.

---

# Reliability scorecard

Scored per the brief's 0–5 rubric.

| Dependency | Timeout | Retry | Fallback | Observability | Score |
|---|---|---|---|---|---|
| Dhan bridge (candles) | 4s | none | Candle table → fail closed | error discarded | **3** |
| Dhan bridge (quotes) | 4s | none | stale cache, no gate | none | **2** |
| Anthropic LLM | **none** | none | deterministic draft | **none** | **2** |
| NIM LLM | 300s | none | deterministic draft | **none** | **2** |
| Embeddings | **none** | none | ILIKE degrade | **none** | **2** |
| Postgres | driver default | none | fail closed | ApiCallLog | **3** |
| api → sentinel | **none** | none | 502/503 passthrough | ApiCallLog | **3** |
| browser → api | **none** | 3 + backoff/jitter | cached data | client logs | **3** |
| NSE public | — | none | named-unavailable | ApiCallLog | **3** |
| Razorpay | — | none | idempotent on payment id | ApiCallLog | **4** |

**Weighted overall: 2.6 / 5.**

The pattern is consistent and worth naming: **degradation design is genuinely
good; instrumentation and timeouts are the gap.** Fallback chains, fail-closed
behaviour on market data, and honest "unavailable" states are better than most
codebases this size. What is missing is the ability to *see* any of it, and the
ceilings that stop a hang from propagating.

---

# Recommended fix order

Smallest change first, correctness before efficiency.

1. **C-3 + H-2** — add timeouts to Anthropic and the embedding provider. Two
   files, no behaviour change, removes the unbounded-hang class.
2. **C-4** — bridge returns a real status code; consumer reads and logs `error`.
   Makes the daily token expiry self-diagnosing.
3. **C-1** — install the telemetry sink in `services/sentinel`. Until this
   lands, no cost or reliability claim about AI in this system is verifiable.
4. **H-3** — timeouts on both internal hops.
5. **C-2** — determine why no synapse is ever written; default cognition off
   until it demonstrably learns.
6. **H-5** — `Promise.all` the four snapshot reads (largest latency win for the
   smallest diff).
7. **M-1** — batch the graph-expansion N+1.
8. **H-6 / H-1 / H-7** — market-data path unification, provider failover
   semantics, interval substitution. These are design decisions, not bug fixes;
   schedule deliberately.

No rewrite is warranted. Items 1–4 are each a handful of lines and address every
CRITICAL and most HIGH findings.
