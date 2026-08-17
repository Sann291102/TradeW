# TradeW — Runtime Measurements

Companion to `APIcallandrealiabilty-AUDITED.md`.

**Everything in this file is `CONFIRMED-RUNTIME` unless explicitly marked otherwise.**
Static estimates live in the main report and are labelled there.

---

## 1. Measurement conditions

| Fact | Value |
|---|---|
| Date | 2026-08-17 |
| Wall clock at probe | 11:51 UTC = **17:21 IST** |
| NSE session | **CLOSED** (15:30 IST close, ~1h51m before probe) |
| Services up | all 8 ports open: 3000, 3001, 4000, 4010, 4011, 4020, 4600, 5433 |
| API uptime at probe | 526s |
| Dhan feed | `feedStatus: "reconnecting"`, access token **expired** |

### Clock correction (recorded so the numbers are auditable)

An initial reading of `TZ=Asia/Kolkata date` under Git Bash returned `11:51`,
which would have made the market *open*. That is a Git-Bash/MSYS `TZ` handling
bug — it ignored the override. Node reports the machine as `GMT+0530 (India
Standard Time)` with true UTC `11:51Z`, i.e. **IST 17:21**. All timings below
use the corrected clock. The market was closed; `marketOpen:false` from the
bridge is correct.

---

## 2. Instrumentation used — none added

The audit brief allows temporary instrumentation. **None was required and none
was added**, because the repository already contains exactly the correlation
schema the brief specifies:

- `ApiCallLog` — `requestId`, `method`, `path`, `statusCode`, `durationMs`,
  `userId`, `error`, `createdAt`. Written by
  `services/api/src/telemetry/telemetry.service.ts` (batched `createMany`).
- `AiCallLog` — `requestId`, `system`, `agent`, `provider`, `model`, `tier`,
  `promptTokens`, `completionTokens`, `costUsd`, `latencyMs`, `status`.
- `AgentActivity`, `AgentRun` — per-agent transitions.

Product behaviour was not modified. The only artifact created was a throwaway
read-only query script (`audit-q.mjs`), deleted after use.

### Table population (the headline result)

| Table | Rows | Verdict |
|---|---|---|
| `ApiCallLog` | **181,541** (2026-08-03 → 2026-08-17) | working |
| `SentinelObservation` | 10,817 | working |
| `MemoryRecord` | 10,765 | working |
| `Percept` | 1,120 | working |
| `CognitiveEpisode` | 970 | working |
| **`AiCallLog`** | **0** | **never written** |
| **`AgentActivity`** | **0** | **never written** |
| **`AgentRun`** | **0** | **never written** |

Root cause: `setTelemetrySink()` is called in exactly one place —
`services/api/src/telemetry/telemetry.service.ts:117` — installing the sink in
the **services/api process only**. Every LLM/embedding/agent call happens in
**services/sentinel**, a separate OS process with its own module instance of
`@tradew/ai-core`, where `getTelemetrySink()` returns `null` and `emitAiCall()`
is a silent no-op.

**Consequence:** the platform cannot answer "how many LLM calls did I make and
what did they cost" — the exact question this audit was commissioned to answer.
Neither can this audit, from telemetry. It can only bound it (§5).

---

## 3. Route measurements (14 days, 181,541 requests)

### Highest volume

| Path | Method | Calls | avg ms | p95 ms | max ms | Errors |
|---|---|---|---|---|---|---|
| `/market-data/indices` | GET | 40,841 | 158 | 1,253 | 3,388 | 0 |
| `/sim/positions` | GET | 25,010 | 82 | — | 26,916 | 0 |
| `/sim/orders` | GET | 24,414 | 16 | — | 1,992 | 303 |
| `/sim/trades` | GET | 21,118 | 5 | — | 363 | 0 |
| `/crypto/quotes` | GET | 20,450 | 214 | — | 4,517 | **6,770** |
| `/sim/trade-history` | GET | 10,987 | 36 | — | 2,152 | 0 |
| `/sim/portfolio` | GET | 4,398 | 175 | 1,434 | 3,388 | 0 |
| `/news` | GET | 4,221 | 38 | — | 8,043 | 0 |
| `/learning/courses` | GET | 2,577 | 338 | 2,412 | 5,210 | 14 |
| `/sentinel/observe` | POST | 2,177 | 1,960 | 5,625 | **54,984** | **669** |

### Worst error rates (≥100 calls)

| Path | Calls | Errors | Error % |
|---|---|---|---|
| `/auth/signup` | 130 | 85 | **65.4%** |
| `/auth/refresh` | 745 | 274 | **36.8%** |
| `/crypto/quotes` | 20,450 | 6,770 | **33.1%** |
| `/sentinel/observe` | 2,177 | 669 | **30.7%** |
| `/sentinel-intelligence/workspace` | 142 | 34 | 23.9% |
| `/auth/login` | 271 | 43 | 15.9% |
| `/sentinel-py/strategies` | 249 | 29 | 11.6% |
| `/sentinel/strategies/registry` | 534 | 47 | 8.8% |
| `/sentinel-py/watch` | 1,087 | 86 | 7.9% |

### Slowest (p95, ≥50 calls)

| Path | Calls | p95 ms | max ms |
|---|---|---|---|
| `/nse/breadth` | 202 | **10,016** | 10,185 |
| `/sentinel-intelligence/workspace` | 142 | 7,529 | 8,466 |
| `/sentinel/observe` | 2,177 | 5,625 | **54,984** |
| `/sim/orders/:id` | 850 | 2,860 | 6,529 |
| `/learning/courses` | 2,577 | 2,412 | 5,210 |

---

## 4. `/sentinel/observe` in detail

Status breakdown across 2,177 calls:

| Status | Calls | avg ms | max ms | Meaning |
|---|---|---|---|---|
| 201 | 1,508 | 2,733 | 54,984 | success |
| 503 | 602 | 235 | 4,188 | no real market data |
| 502 | 59 | 59 | 350 | Sentinel unreachable |
| 500 | 8 | 33 | 120 | crash |

**Success-path latency:** p50 **2,178ms**, p95 **7,703ms**, p99 **11,316ms**,
max **54,984ms**.

**Today (2026-08-17):** 38 calls, **29 errors — a 76% failure rate**, avg 768ms.

### Direct probe

```
POST http://127.0.0.1:4010/observe  {"userId":"audit-probe-001","symbol":"NIFTY"}
-> HTTP 503 in 112ms
-> {"message":"No real market data available for NIFTY (15m candles). The Dhan
    live-feed bridge is unreachable and no backfilled candles exist for it.
    Sentinel does not substitute simulated data.","statusCode":503}
```

Downstream cause, obtained by probing the bridge directly:

```
GET http://127.0.0.1:4600/candles?symbol=NIFTY&interval=15
-> HTTP 200 in 31ms
-> {"candles":[],"source":"error",
    "error":"Dhan historical API returned 401 for NIFTY:
             {\"errorCode\":\"DH-901\",\"errorMessage\":\"Client ID or user
              generated access token is invalid or expired.\"}"}
```

Two things are proven here at once:

1. Sentinel **fails closed** and refuses to substitute simulated data. That is
   correct, deliberate behaviour and it is working.
2. The 503 message is **factually wrong**. The bridge is healthy and answered in
   31ms; the *upstream Dhan token* expired. The real error string exists in the
   bridge response and is discarded (see §6).

---

## 5. LLM calls — what can and cannot be established

`AiCallLog` is empty, so no direct count exists. Bounding it from
`SentinelObservation`, where an `agent='orchestrator'` row is written only when
`decide()` produced a synthesis (the sole path that calls `polish()`):

| Category | Rows | Last seen |
|---|---|---|
| `orchestrator` / `synthesized_risk_awareness` | 71 | 2026-08-11 |
| `orchestrator` / `synthesized_market_guidance` | **1** | **2026-08-05** |
| **total orchestrator syntheses (ever)** | **72** | — |

Therefore:

- **Upper bound on orchestrator LLM calls, all time: 72.** Actual is lower — the
  polish cache (5min TTL, 500 entries) collapses repeats.
- Against 1,508 successful observations, the LLM path engaged in at most
  **4.8%** of them.
- The flagship "market guidance" output — the four-condition publication gate —
  has fired **exactly once in the system's history**, on 2026-08-05, and not
  since.
- No orchestrator synthesis of any kind since **2026-08-11** (6 days).

`CONFIRMED-RUNTIME` for the row counts; `INFERRED` for the mapping from rows to
LLM invocations (sound, because `polish()` is the only caller and it is reached
only on the branches that write these rows).

**ML inference calls, all time: 0.** Not bounded — *zero by construction*, since
no ML runtime exists in the dependency tree at all.

---

## 6. Market-data freshness (measured)

`GET :4600/quotes` at 17:21 IST:

| Symbol | LTP | `updatedAt` age | per-quote `marketStatus` |
|---|---|---|---|
| NIFTY | 24,241.10 | 384.8 min | `open` |
| BANKNIFTY | 57,179.70 | 384.8 min | `open` |
| FINNIFTY | 26,107.25 | 384.8 min | `open` |
| SENSEX | 77,508.96 | 384.8 min | `open` |
| INDIAVIX | 11.68 | 384.8 min | `open` |

Top-level envelope says `marketOpen: false`; every quote inside says
`marketStatus: "open"`. The per-quote field is stamped at write time
(`live-feed-server.ts:421`, `marketStatus: isMarketOpen() ? 'open' : 'closed'`)
and frozen into the cached record, so a tick written at 10:56 IST still reports
`"open"` at 17:21 IST — and will report it tomorrow.

The last tick is **10:56 IST**. The session ran to 15:30 IST. So
**4.56 hours of the trading session produced no tick updates at all**, and the
bridge continued serving the 10:56 values as current for the rest of the day.

No consumer checks `updatedAt`. Greps for `stale|freshness|ageMs|MAX_AGE` across
`candle-market-data.provider.ts` and `market-intelligence.service.ts` return
nothing but one unrelated comment. `CONFIRMED-SOURCE`.

---

## 7. Test suite vs production

| Suite | Result |
|---|---|
| `@tradew/sentinel` | 20 files, **366 passed** |
| `@tradew/web` | 29 files, **471 passed** |
| `@tradew/api` | 31 files, **409 passed** |
| `sentinel-py` (pytest) | **274 passed** |
| `@tradew/market-data` verify | parser round-trip OK |
| **Total** | **1,520 passing, 0 failing** |

**1,520 green tests while the flagship workflow fails 76% of calls in
production today.** Every suite mocks the market-data boundary, so the entire
class of failure that is actually occurring — expired upstream credential,
HTTP-200-with-error-body, stale cache — is structurally invisible to them.

One real warning surfaced during the sentinel run and is worth recording:

```
ERROR [SentinelIntelligenceService] corpus ingestion failed;
      reasoning will proceed with weak grounding: corpus root unreadable
```

This is the citation corpus that `SentinelIntelligence` requires. Because
uncited verdicts are *dropped* rather than flagged, an empty corpus makes that
engine a silent no-op.

---

## 8. Static vs runtime comparison

| Workflow | Expected from source | Actual runtime | Difference |
|---|---|---|---|
| `/observe` external HTTP | 6 to bridge | **1** (fails at first `/candles`) | pipeline aborts at stage 1 |
| `/observe` LLM | 0–1 | **0** | never reached |
| `/observe` embedding | 1 | **0** | never reached |
| `/observe` DB writes | 2 + n | **0** | never reached |
| `/observe` latency | ~1.6s (per design comment) | p50 2,178ms / p95 7,703ms | **~1.4× p50, ~4.8× p95** |
| LLM calls all-time | unbounded by design | **≤72** | gate almost never opens |
| ML inference | 0 | **0** | agrees |
| `AiCallLog` rows | 1 per LLM call | **0** | telemetry sink absent in process |
| Retry amplification | 3×3×3 = 27 hypothesised | **3** | only one layer retries |

---

## 9. What could NOT be measured

Stated explicitly rather than estimated:

- **Full `/observe` pipeline call count at runtime** — blocked by the expired
  Dhan token. The 6-call figure is `CONFIRMED-SOURCE`, not runtime-verified.
  Re-run `npm run dhan:token -w @tradew/market-data-service` and repeat §4.
- **Actual LLM invocation count and cost** — structurally unmeasurable while
  `AiCallLog` is unwritten. Bounded at ≤72 in §5.
- **Per-provider token spend** — same cause. Cost is given as a formula in the
  main report, not a number.
- **WebSocket reconnect behaviour end-to-end** — the only WebSocket is the
  bridge→Dhan socket, and it was stuck in `reconnecting` with an invalid
  credential for the whole audit, so a clean reconnect could not be observed.
- **`services/tradew-ai` request path** — code is real but the service was not
  observed running on any port.
- **Browser-side duplicate-call counts** — would require driving the UI with a
  live session; the hand-rolled-interval analysis in the main report is
  `CONFIRMED-SOURCE`.
