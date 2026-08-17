# TradeW — Real Workflow Call Graph

Companion to `APIcallandrealiabilty-AUDITED.md`. Every graph below was derived by
reading the implementation, not the architecture docs. Stages that do **not**
exist are omitted rather than drawn hopefully.

Evidence labels: `CONFIRMED-RUNTIME` (observed executing 2026-08-17) ·
`CONFIRMED-SOURCE` (read in code) · `INFERRED` · `UNKNOWN`.

---

## 0. Service topology (verified live 2026-08-17)

```text
browser :3000 (apps/web, Next 14.2.20)
   |
   |  every call goes through ONE wrapper: apps/web/src/lib/api.ts  api()
   |  (no timeout; 1 retry only after a 401 refresh)
   v
services/api :4000  (NestJS, 190 routes)  <-- the ONLY service the browser talks to
   |
   +--> services/sentinel   :4010  (NestJS, 47 routes)   [x-service-token]
   |        |
   |        +--> live-feed bridge :4600  (standalone Dhan bridge)
   |        |        +--> api.dhan.co  (REST candles/optionchain)   [TOKEN EXPIRED]
   |        |        +--> wss://api-feed.dhan.co (binary tick feed) [reconnecting]
   |        +--> Postgres :5433 (Prisma + pgvector)
   |        +--> api.anthropic.com   (LLM prose polish, 0-or-1 per observe)
   |        +--> integrate.api.nvidia.com (embeddings)
   |
   +--> services/sentinel-py :4011 (FastAPI, 18 routes)  [x-service-token]
   |        +--> Postgres :5433 (asyncpg — its OWN tables, never Prisma)
   |        +--> back to services/api /internal/sentinel-py/notify
   |
   +--> services/market-data :4020 (NestJS ingestor -> Quote table)
   +--> Postgres :5433 (Prisma)
   +--> www.nseindia.com, api.razorpay.com, api.twelvedata.com, binance, RSS

apps/admin :3001 --> services/api (server-side proxy, deny-by-default allowlist)
```

**Not in the graph because they do not exist as services:** `services/auth`,
`services/analytics`, `services/notification`, `services/trading-engine` are
README-only placeholders. `services/tradew-ai` has real code
(`DefaultAgentRuntime`) but was not observed running.

---

## 1. Sentinel analysis — `POST /sentinel/observe` (the flagship workflow)

This is the workflow the product is built around. Traced from
`runObservation()` at `services/sentinel/src/orchestrator/sentinel-orchestrator.service.ts:180`.

```text
TRIGGER   useSentinel() adaptive poll (10s active / 30s idle / 60s failing)
          + refetchOnWindowFocus + refetchOnMount + refetchOnReconnect
   |
FRONTEND  apps/web/src/lib/sentinel/useSentinel.ts:124  useQuery(observeKey)
          -> api('/sentinel/observe')            [no timeout, 3 retries]
   |
INTERNAL  services/api  SentinelController -> SentinelService.observe()
   |      services/api/src/sentinel/sentinel.service.ts:106
   |      fetch(:4010/observe)                   [no timeout, 0 retries]
   |
ORCHEST.  services/sentinel  runObservation()
   |
   +-(fire-and-forget, never awaited, errors swallowed)
   |    researchTrigger.researchIfUnfamiliar(symbol)   -> may reach LLM + web search
   |    outcomeLearning.evaluatePending(5)             -> DB
   |
   +--> market.snapshot(symbol)          4 SEQUENTIAL awaits, zero parallelism:
   |      1. getCandles(symbol, 15m)     -> HTTP :4600 /candles
   |      2. getMarketBreadth()          -> HTTP :4600 /quotes
   |      3. getCandles(symbol, 1d)      -> HTTP :4600 /candles
   |      4. getOptionChain(symbol)      -> HTTP :4600 /optionchain
   |
   +--> market.contracts(snapshot)       started here, awaited at the bottom
   |      Promise.all([CE, PE])          -> 2x HTTP :4600 /candles/option
   |
   +--> DETERMINISTIC AGENTS (no network, no model):
   |      market.signals()       EMA / RSI / VWAP / CPR
   |      emotion.signals()      recent-trade behaviour
   |      traps.signals()        sweeps, false breakouts, expiry traps
   |      news.signals()         -> may reach NewsEventClassifier (LLM per headline)
   |      behaviour.analyse()    structure / liquidity
   |      strategies.scan()      rule engine
   |      risk.assess()          rule engine
   |      confidence.compute()   weighted scoring
   |      stateMachine.advance() in-memory FSM
   |
   +--> historicalSimilarity.similarPast()   -> Postgres
   +--> patternRecognition.recordOccurrence() -> Postgres (Promise.all over signals)
   +--> compliance.record()                   -> Postgres write
   +--> compliance.feed(userId, 100)          -> Postgres read
   |
   +--> decide()  ---- the four-condition publication gate ----
   |      |
   |      +-- publish?  -> composeGuidance()  -> polish() -> LLM   \  MUTUALLY
   |      +-- risky?    -> composeRiskWarning()-> polish() -> LLM   /  EXCLUSIVE
   |      +-- neither   -> NO LLM CALL AT ALL      <-- the common case
   |
   +--> explain.buildWhy()                    NO LLM
   |      +-- learningReferences()
   |            -> DefaultRetriever.retrieve()
   |                 -> memory.search()
   |                      -> EMBEDDING call (nvidia-nim)
   |                      -> pgvector cosine query
   |                      -> up to 9 SEQUENTIAL memory.get()   <-- N+1
   |
   +--> marketContext.contextFor()            -> Postgres
   +--> strategyAdvisor.advise() / sideInFocus()   pure, synchronous
   |
RESPONSE  ObserveResponse
   |
UI        SentinelLiveCharts, SafetyCard, timeline, SessionStats
```

### Call count for ONE `/observe`

| Class | Count | Label |
|---|---|---|
| External HTTP to bridge (:4600) | 6 | CONFIRMED-SOURCE |
| LLM | **0 or 1** (0 in the common case) | CONFIRMED-SOURCE |
| ML inference | **0** | CONFIRMED-SOURCE |
| Embedding | 1 | CONFIRMED-SOURCE |
| Postgres reads | ~5 + up to 9 N+1 | CONFIRMED-SOURCE |
| Postgres writes | 2 + 1 per triggered signal | CONFIRMED-SOURCE |
| Internal service hops | 2 (browser->api->sentinel) | CONFIRMED-RUNTIME |
| Cache | 1 in-process polish cache (5min TTL); option-chain TTL in provider | CONFIRMED-SOURCE |

**Runtime today:** the graph terminates at `market.snapshot` step 1 — `/candles`
returns empty because the Dhan token expired, so `MarketDataUnavailableError`
is thrown and the response is **503**. Everything below that line did not run.
0 LLM, 0 embedding, 0 writes. `CONFIRMED-RUNTIME`.

---

## 2. Initial application load

```text
TRIGGER  browser navigates to /
   |
   +-- Next middleware reads tw_auth cookie (non-secret routing hint only)
   +-- AppFrame mounts -> sessionStore.init()
   |     Promise.all([ api('/auth/me'), api('/entitlements/me') ])
   |     -> on double-401 BOTH would refresh; single-flight guard in api.ts:104
   |        collapses them into ONE POST /auth/refresh
   +-- NotificationSync mounts -> 30s poll of /notifications
   +-- workspace surfaces mount their own queries
```

Measured cost of the auth pair: `/auth/me` avg 8ms, `/entitlements/me` avg 22ms.
`/auth/refresh` shows a **36.8% error rate** across 745 calls — see finding H-4.

---

## 3. Dashboard load

```text
TRIGGER  /dashboard
   +-- /market-data/indices     40,841 calls all-time, avg 158ms, p95 1253ms
   +-- /sim/positions           25,010 calls, avg 82ms,  max 26,916ms
   +-- /sim/orders              24,414 calls, avg 16ms
   +-- /sim/trades              21,118 calls, avg 5ms
   +-- /sim/portfolio            4,398 calls, avg 175ms
   +-- /notifications            (30s poll)
```

These four `/sim/*` routes are the highest-volume authenticated traffic in the
system and are polled, not pushed. `CONFIRMED-RUNTIME`.

---

## 4. Chart load / market refresh

```text
TRIGGER  symbol selection
   +-- useCandles          60s setInterval  (hand-rolled, OUTSIDE query dedupe)
   +-- useOptionQuote       3s setInterval  (hand-rolled)
   +-- OptionChainTab       3s setInterval  (hand-rolled)
   +-- useOptionChainStrikes 4s setInterval (hand-rolled)
   +-- useDhanLiveFeed      5s poll -> :4600 direct from the browser
   +-- useNseContext       60s setInterval
```

The browser talks to the bridge (:4600) **directly** via
`apps/web/src/lib/dhanLiveFeed.ts` (6 fetch sites) — bypassing `services/api`
entirely. So chart prices and Sentinel's prices come from the same bridge but
over two independent paths with independent freshness. See finding H-6.

---

## 5. WebSocket / SSE reality

```text
Browser  -> NO WebSocket to services/api. One `new WebSocket` in the whole
            frontend. Live data is HTTP polling throughout.
Bridge   -> holds the ONLY WebSocket: wss://api-feed.dhan.co (Dhan binary feed)
SSE      -> EventSource used for admin/knowledge streams only (10 files)
```

"Reconnect" therefore means *the bridge's* Dhan socket reconnecting, which the
browser never learns about except through stale `updatedAt` values.
`CONFIRMED-RUNTIME`: bridge reported `feedStatus: "reconnecting"` throughout the audit.

---

## 6. Failure path (measured)

```text
Dhan token expires (24h SEBI cap)
   |
bridge GET /candles  -> HTTP 200  {"candles":[],"source":"error","error":"DH-901 ..."}
   |                    ^^^^^^^^ 200, not 5xx
CandleMarketDataProvider.fetchJson -> res.ok === true -> returns the body
   |  type is {candles?, source?} — the `error` field is not declared and never read
   |  guard `json.source !== 'dhan'` catches it INCIDENTALLY -> returns null
   v
falls through to Candle table -> empty -> MarketDataUnavailableError
   v
services/sentinel  -> 503 "The Dhan live-feed bridge is unreachable"
   |                         ^^^^^^^^^^^ WRONG: the bridge is healthy; the
   |                                     upstream token expired
services/api       -> 503 passthrough
apps/web           -> 3 retries with backoff, then error state
```

The true root cause (`DH-901 Invalid_Authentication`) is visible **only** by
querying the bridge directly. It never reaches a Sentinel log or the user.
`CONFIRMED-RUNTIME`.
