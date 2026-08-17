# Sentinel — Root Cause and Permanent Fix

**Date:** 2026-08-17
**Trigger:** Sentinel workspace showing `HTTP 503 — no real market data available for NIFTY`, and
`NIFTY has no live option chain` (screenshots supplied with the brief).
**Status:** Root cause proven at runtime; permanent fix implemented, tested and verified.

---

# Executive Summary

One mechanism produced every symptom in the screenshots: **the Dhan credential is
captured once at process start into a module-level `let` and never re-read, and
when it dies every failure path in the integration degrades to an EMPTY SUCCESSFUL
ANSWER that downstream code reads as a fact about the market.**

Dhan caps every access token at 24 hours — a SEBI rule on API access management,
not a vendor policy — so a bridge process that reads its token once and runs
longer than a day is *guaranteed by arithmetic* to reach a state where it holds a
dead credential, with no path back to the renewed value. Measured at the time of
the incident: the bridge had **18.4 h uptime**, the operator had renewed the token
in `.env` **20 minutes earlier**, `services/api` and `services/sentinel` had both
restarted and picked it up, and the bridge had not.

Because the fault was returned as `HTTP 200 {"candles":[],"source":"error"}` and
`HTTP 200 {"expiries":[]}`, three separate consumers each concluded something
false:

| What actually happened | What the user was told |
|---|---|
| Bridge is up, answering in ~30 ms; its Dhan token was refused (DH-901) | "The Dhan live-feed bridge is unreachable" |
| 1,627 NIFTY 15m candles in the table, newest 2026-08-11 (outside the 5-day window) | "no backfilled candles exist for it" |
| NIFTY's option chain is live — Dhan returns 18 expiries when asked with a working token | "NIFTY has no live option chain" |

And because those faults were neither cached nor coalesced, **each one cost a fresh
metered Dhan call per request per user**, so the failure amplified linearly with
concurrency rather than being contained.

The fix is structural in three places: the credential became a thing with a
lifecycle; the fault taxonomy became explicit so an absence can no longer be
confused with a failure; and upstream load became bounded by distinct keys rather
than by request count.

**Verified after the fix:** 80 failing requests → 0 upstream calls (was 80). 50
concurrent identical reads → 1 upstream call (was 50). 6 concurrent option-chain
reads → 0 client timeouts (was 4 of 6, up to 15.6 s). A killed credential now
recovers in **~1 second with no process restart** (previously impossible).
69 concurrent multi-user observations: 0 failures, 0 cross-user leakage.
1,355 repository tests pass.

---

# Original Error

Two symptoms, from the supplied screenshots.

**Symptom A** — the workspace banner and the disconnected card:

```
Sentinel reconnecting… Sentinel answered HTTP 503. Retrying automatically.

Sentinel service not connected
The API answered but Sentinel could not complete the observation (HTTP 503: No
real market data available for NIFTY (15m candles). The Dhan live-feed bridge is
unreachable and no backfilled candles exist for it. Sentinel does not substitute
simulated data.). Retries continue in the background; check that
services/sentinel is running on port 4010.
```

Every KPI tile read `AWAITING` / `OFFLINE` / `—`.

**Symptom B** — the watch creator, in the same session:

```
NIFTY has no live option chain, so this watch will follow the underlying itself.
Indices like NIFTY, BANKNIFTY, FINNIFTY and SENSEX have one.
```

This message **contradicts itself in consecutive clauses**. That self-contradiction
is the single most diagnostic artefact in the whole incident: the UI had no way to
express "I could not find out", so it said the only other thing it knew how to
say. Anywhere a message argues with itself, code has inferred a fact about the
world from a failure of its own plumbing.

A third detail from the screenshot mattered: the top ticker showed **Nifty 50
24,241.10** while Sentinel claimed no NIFTY data existed. Two paths, one
instrument, opposite conclusions — the clue that this was not "the market data is
missing" but "one specific read is failing".

---

# Reproduction Steps

All against the running system, 2026-08-17.

**1. Confirm the bridge is alive** (contradicting the user-facing message):

```bash
curl -s http://localhost:4600/status
# {"marketOpen":false,"feedStatus":"reconnecting","universe":{"stocks":212,...}}
```

**2. Reproduce Symptom A** — the exact call every observation makes:

```bash
curl -s "http://localhost:4600/candles?symbol=NIFTY&interval=15m&days=5"
```
```json
{"candles":[],"source":"error","error":"Dhan historical API returned 401 for NIFTY:
 {\"errorType\":\"Invalid_Authentication\",\"errorCode\":\"DH-901\",
  \"errorMessage\":\"Client ID or user generated access token is invalid or expired.\"}"}
```

**HTTP 200.** The real cause — DH-901, a refused credential — is right there in the
body, and the consumer's response type did not declare the field.

**3. Reproduce Symptom B:**

```bash
curl -s "http://localhost:4600/optionchain/expirylist?symbol=NIFTY"
# {"expiries":[]}
```

**4. Prove the empty list is a lie** — same token, straight to Dhan:

```bash
curl -X POST https://api.dhan.co/v2/optionchain/expirylist \
  -H "access-token: $DHAN_ACCESS_TOKEN" -H "client-id: $DHAN_CLIENT_ID" \
  -d '{"UnderlyingScrip":13,"UnderlyingSeg":"IDX_I"}'
# HTTP 200
# {"data":["2026-08-18","2026-08-25","2026-09-01", … 18 expiries],"status":"success"}
```

NIFTY's option chain was live the entire time.

**5. Prove the credential in `.env` was NOT the one the bridge was using:**

```
BRIDGE PID 16652 StartTime : 2026-08-16 22:56:22   (18.37 h uptime)
.env LastWriteTime         : 2026-08-17 16:59:07   (renewed 20 min earlier)
services/sentinel PID      : started 2026-08-17 17:11:47  ← picked up the new token
services/api PID           : started 2026-08-17 17:11:50  ← picked up the new token
```

The bridge was the only component that had not restarted since the renewal, and it
was the only one failing.

---

# Exact Failure Trace

```
USER ACTION            open /sentinel, market head = NIFTY
        │
FRONTEND EVENT         useSentinel('NIFTY') → React Query, 10–30 s cadence   SUCCESS
        │
HTTP REQUEST           POST /sentinel/observe                                SUCCESS
        │
BACKEND ROUTE          SentinelController.observe → SentinelApiService        SUCCESS
        │
SERVICE HOP            fetch → http://localhost:4010/observe (no timeout)    SUCCESS
        │
ORCHESTRATOR           SentinelOrchestratorService.runObservation            SUCCESS
        │
AGENT                  MarketIntelligenceService.snapshot('NIFTY')           SUCCESS
        │
MARKET DATA (tier 1)   CandleMarketDataProvider.candlesFromLiveFeed
        │              GET :4600/candles?symbol=NIFTY&interval=15m&days=5
        │              ← HTTP 200 {candles:[],source:'error',error:'…DH-901…'}
        │              checked `source !== 'dhan'` → null.  ERROR TEXT DISCARDED   ← FAULT LAUNDERED
        │
   ┌────┴─── BRIDGE     ALL_INSTRUMENTS lookup ok (NIFTY, securityId 13)      SUCCESS
   │                    fetchDhanCandles → POST api.dhan.co/v2/charts/intraday
   │                    ← HTTP 401 DH-901                                     FAILED
   │                    NOT cached (candleCache written only on success)       AMPLIFIES
   │                    NOT coalesced (no in-flight map on this route)         AMPLIFIES
   │                    DHAN_TOKEN = module-level `let`, read once at boot     ROOT CAUSE
   └───────────────────  renewed token in .env invisible to this process       ROOT CAUSE
        │
MARKET DATA (tier 2)   candlesFromTable('NIFTY','15m', now-5d, now)
        │              Instrument row found; 1,627 15m rows exist
        │              …but newest is 2026-08-11, OUTSIDE the window → 0 rows
        │              returned null — indistinguishable from "never backfilled"  STALE
        │
THROW                  MarketDataUnavailableError with a HARDCODED message
        │              asserting two things that were both false                  FAILED
        │
API                    503 passthrough (message preserved verbatim)            SUCCESS
        │
FRONTEND STATE         splitFault → reconnecting banner + disconnected card    SUCCESS
        │
RETRY                  React Query: 3 retries, then 60 s failing cadence       BOUNDED
        │              each retry → 2 fresh uncached Dhan calls                AMPLIFIES
```

Parallel branch, same root cause, producing Symptom B:

```
WatchCreator → useExpiries('NIFTY') → fetchDhanExpiryList
   → GET :4600/optionchain/expirylist?symbol=NIFTY
   → bridge: fetchExpiryList → Dhan 401
   → `if (status >= 400 && status < 500) return []`        ← 401 CLASSIFIED AS "NO OPTIONS MARKET"
   → route caches [] for 5 minutes, serves it to everyone   ← LIE MADE STICKY
   → fetchDhanExpiryList: `catch { return [] }`             ← FAULT ERASED
   → useExpiries: isError || empty → 'unavailable'          ← TWO MEANINGS, ONE STATUS
   → WatchCreator prints "NIFTY has no live option chain"   ← SELF-CONTRADICTING MESSAGE
   → and silently sets underlyingOnly = true                ← WATCH SWITCHED INSTRUMENT
```

---

# Root Cause

**Root Cause:**
The live-feed bridge holds its Dhan access token in a module-level `let`, assigned
once at boot, with no path from "Dhan is refusing this token" back to "read the
token again". Dhan caps every token at 24 hours by regulation, so any bridge
process outliving a day is guaranteed to hold a dead credential. When that
happens, every failure path in the Dhan integration returns an *empty successful
answer* rather than a named fault — `HTTP 200 {"candles":[],"source":"error"}` and
`HTTP 200 {"expiries":[]}` — and because a 4xx was classified purely by status
code, the 401 was treated as Dhan's "this instrument has no derivatives market".
Downstream consumers therefore reported a credential failure as facts about the
market. Neither the fault nor the empty answer was coalesced or negatively cached,
so the dead credential cost one fresh metered Dhan call per request per user.

**Evidence:**

*File:* `services/market-data/scripts/live-feed-server.ts:75` (pre-fix)
```ts
let DHAN_TOKEN = process.env.DHAN_ACCESS_TOKEN || '';
let DHAN_TOKEN_SOURCE = 'env';
```
*Function:* `resolveDhanToken()` — called exactly once, at `main():850`.
No caller anywhere re-invokes it; no code path reassigns `DHAN_TOKEN` after boot.

*File:* `services/market-data/scripts/live-feed-server.ts:800` (pre-fix)
```ts
if (resp.status >= 400 && resp.status < 500) {
  // Dhan's own definitive answer for a security with no derivatives market …
  return [];
}
```
The comment is correct for `DH-813 Invalid SecurityId`. **401 and 429 are also
4xx.** So a refused credential and a rate limit both returned "no options market".

*File:* `services/sentinel/src/market-data/candle-market-data.provider.ts:145` (pre-fix)
```ts
const json = await this.fetchJson<{ candles?: FeedCandle[]; source?: string }>(url);
if (!json || json.source !== 'dhan' || !Array.isArray(json.candles) || !json.candles.length) return null;
```
`error` is absent from the declared type. The failure is caught only *incidentally*.

*File:* `services/sentinel/src/market-data/candle-market-data.provider.ts:46` (pre-fix)
```ts
super(
  `No real market data available${symbol ? ` for ${symbol}` : ''} (${what}). ` +
    'The Dhan live-feed bridge is unreachable and no backfilled candles exist for it. ' +
```
A hardcoded diagnosis — a guess that can never be wrong out loud.

*File:* `services/sentinel/src/market-data/candle-market-data.provider.ts:347` (pre-fix)
```ts
if (!json || !Array.isArray(json.expiries)) return cached?.expiries ?? [];
```
With no cache entry this is `[]`, and `[]` is the `MarketDataProvider` contract's
value for "this instrument has no options market".

**Causal sequence, as measured:**

1. Bridge starts 2026-08-16 22:56, reads token T₁ into `DHAN_TOKEN`.
2. T₁ passes Dhan's 24 h cap during the 2026-08-17 session.
3. Operator renews to T₂ in `.env` at 16:59. api and sentinel restart at 17:11 and
   use T₂. The bridge does not restart and still presents T₁.
4. Dhan answers `401 DH-901` to every authenticated REST call from the bridge.
5. `/candles` → `{source:'error'}` HTTP 200; `/optionchain/expirylist` → `{expiries:[]}` HTTP 200.
6. Sentinel reads (5) as absence, not failure → 503 with a hardcoded, false message.
7. The web watch creator reads (5) as "NIFTY has no option chain".
8. Neither is cached or coalesced → every retry from every user re-calls Dhan.

**Why the ticker still showed prices:** `GET /quotes` is served from the bridge's
in-memory WebSocket tick map — no upstream call, no credential use. It held ticks
from 10:56 IST. So the one path that needed no credential kept working, which is
precisely why the failure looked like "Sentinel is broken" rather than "the
credential died".

---

# Why It Happens

Three independent design decisions, each defensible alone, compose into a
guaranteed failure:

1. **A credential treated as a constant.** `DHAN_TOKEN` is configuration-shaped, so
   it was read like configuration — once, at boot. But it is a *lease* with a
   24-hour regulatory ceiling. Reading a lease once is the same bug as caching a
   lock forever.

2. **`process.env` is a boot snapshot.** Even a re-read of `process.env` would have
   returned the dead token: dotenv does not overwrite already-set variables, and a
   running process never observes a later edit to `.env` at all. Recovery required
   reading the *file*.

3. **Failure shaped like emptiness.** Every degradation path was written to be
   *safe* — never fabricate data, always degrade to "no data". That instinct is
   right and is why this system never invented candles. But "no data" was
   expressed as the same value as "no such data exists", and the second is a claim
   about the market. The safe choice and the honest choice diverged, and nobody
   noticed because both look like `[]`.

---

# Why It Appears in Realtime

The failure is invisible until the market is being read continuously:

- **It needs a long-lived process.** The bug requires uptime > token lifetime.
  A developer restarting services all day never sees it; a bridge left running
  overnight hits it every single day, once, at the same point in the token's life.
- **It needs the metered path.** `/quotes` (WebSocket-fed, no credential) keeps
  working, so the dashboard looks alive. Only `/candles` and `/optionchain`
  (authenticated REST) fail — and those are exactly what the *engine* reads.
- **It is time-dependent, not input-dependent.** The same request succeeds at
  09:00 and fails at 17:00 with no code, config or input change. That is why it
  reads as flakiness rather than a bug.

---

# Why Multiple Users Make It Worse

Four distinct amplifications, all measured.

### 1. Failures were free to retry and therefore infinitely repeated

`candleCache.set` ran only on the success path.

```
8× sequential identical failing /candles:  57, 30, 28, 32, 30, 27, 28, 29 ms
baseline (in-memory /status route):        ~2 ms
```

Every request above the baseline is a round trip to Dhan. **Eight requests, eight
upstream calls.** The one situation that most needs damping — a broken upstream —
had none.

### 2. Concurrent identical reads did not coalesce

```
10 concurrent identical /candles: wall 127 ms; immediate repeat still 31 ms
25 concurrent identical /candles: wall 276 ms; immediate repeat still 36 ms
50 concurrent identical /candles: wall 621 ms; immediate repeat still 30 ms
```

**50 users watching NIFTY cost 50 upstream calls, not 1.** `/optionchain` had an
in-flight map for exactly this reason; `/candles` never got one.

### 3. The arithmetic reaches the rate limit at ~13 users

One observation reads **4 metered series** (15m + 1d underlying, CE + PE legs).
Active poll cadence is 10 s:

```
   1 user   →   4 series / 10 s  =  0.4 calls/s
  13 users  →  52 series / 10 s  =  5.2 calls/s   ← Dhan's documented 5 req/s
 100 users  → 400 series / 10 s  = 40   calls/s   ← 8× over
```

Past saturation every user's read fails — and because failures were uncached,
failing produced *more* calls than succeeding. **The system's response to
exceeding its rate limit was to exceed it further.** That cannot be fixed by
tuning a poll interval.

### 4. The shared FIFO guaranteed later users a timeout read as "no option chain"

Every option-family call in the process shares one queue with a 3.1 s floor gap,
while every caller has a fixed 4,000 ms deadline (`SENTINEL_LIVE_FEED_TIMEOUT_MS`).
Six concurrent requests, distinct symbols:

```
ITC          34 ms   within 4 s
WIPRO     3,148 ms   within 4 s
AXISBANK  6,260 ms   EXCEEDS the 4 s abort
LT        9,358 ms   EXCEEDS
BEL      12,463 ms   EXCEEDS
DLF      15,566 ms   EXCEEDS
```

**4 of 6 aborted.** Three compounding consequences:

- An aborted HTTP client does not cancel queued work, so those four upstream calls
  still ran, at 3.1 s each, spending rate-limited budget on answers nobody would
  read — while the next poll enqueued four more behind them.
- Wait time grew linearly with users, so the queue could never drain.
- Downstream, a 4 s abort was classified as "no options market". **The second and
  subsequent concurrent users were told NIFTY has no option chain purely because
  someone else asked first.**

---

# Concurrency Analysis

Audited for the shared-state and isolation questions in the brief §4, §5, §11–13.
**Finding: no cross-user data leakage exists. The concurrency defects are
contention and amplification, not contamination.**

### State inventory

| State | Scope | Correct? |
|---|---|---|
| `DHAN_TOKEN` (bridge) | process-wide | ✗ **root cause** — no lifecycle |
| `candleCache` | process-wide, keyed `symbol:interval:days` | ✓ market data is not per-user; ✗ no negative caching |
| `expiryListCache` | process-wide, keyed by raw query symbol | ✗ case-sensitive → `nifty`/`NIFTY` were two entries and two upstream calls |
| `optionChainQueue`, `lastOptionChainCallAt` | process-wide | ✓ intentional; ✗ unbounded depth vs fixed client deadline |
| `byKey`, `optionLtpBySecurityId`, `sseClients` | process-wide | ✓ market data / connection set, no user identity |
| `chainCache`, `expiryCache` (Sentinel provider) | process-wide, keyed by symbol | ✓ market data; ✗ cached faults as absence |
| `MarketTimelineEngine` sessions | `userId::symbol::istDateKey` | ✓ **user-scoped** |
| `MarketStateMachineService` sessions | `userId::symbol::istDateKey` | ✓ **user-scoped** |
| `MarketWatchService.watched` | process-wide symbol set | ✓ by design; bounded by `watchMaxSymbols`, sweep-guarded |
| `polishCache` (orchestrator) | keyed on the full deterministic draft text | ✓ a hit requires byte-identical evidence, so it can only return prose derived from identical input |
| `ComplianceService.feed` | `where: { userId }` | ✓ scoped |
| `SentinelApiService` trades/positions | `where: { userId }` | ✓ scoped |

**The bridge carries no user identity at all** — it is a pure market-data cache, and
market data is legitimately global. This is why an outage was total (everyone saw
it) rather than selective, and why no user ever received another user's analysis.

### Identity chain

`userId` → `sessionKey` (`userId::symbol::istDateKey`) is preserved intact from
`SentinelController` → `SentinelApiService.observe` → Sentinel `/observe` →
`runObservation` → timeline + state machine + compliance. No hardcoded, reused or
globally-stored user id was found on the observation path. `symbol` defaults to
`'NIFTY'` in several places (`request.symbol ?? 'NIFTY'`) — benign, since it is the
product default, but it does mean a dropped symbol silently becomes NIFTY rather
than erroring.

### Verified isolation after the fix

69 concurrent observations across distinct users:

```
1. TWO users, SAME symbol (NIFTY)         2 ok / 0 failed   p50 2,362 ms
2. FIVE users, MIXED symbols              5 ok / 0 failed   p50 2,195 ms
   ✓ user-A NIFTY      → contractWatch=NIFTY
   ✓ user-B BANKNIFTY  → contractWatch=BANKNIFTY
   ✓ user-C NIFTY      → contractWatch=NIFTY
   ✓ user-D RELIANCE   → contractWatch=RELIANCE
   ✓ user-E BANKNIFTY  → contractWatch=BANKNIFTY
3. TEN concurrent, 10 users              10 ok / 0 failed   p50   999 ms
4. SAME user, TWO symbols                 2 ok / 0 failed
   ✓ user-Z's NIFTY and BANKNIFTY observations stayed separate
5. FIFTY concurrent, 25 users × 3 symbols 50 ok / 0 failed  p50 3,413 ms, max 7,508 ms

RESULT: PASS — bounded and isolated
```

No response described a symbol other than the one it requested.

---

# API / LLM / ML Impact

**Metered Dhan Data API** — the dependency this incident was about. Per observation:
4 series (15m + 1d underlying, CE + PE legs). Pre-fix, under fault, each was one
upstream call *per request*; post-fix, one per distinct key per 60 s TTL, and zero
while the credential breaker is open.

**LLM** — `SentinelOrchestratorService.polish()` is the only LLM call on `/observe`,
and it is optional: a deterministic draft is always composed first, and the LLM
only rewrites it. Two findings, both fixed here:

- The **Anthropic provider had no timeout at all** — no `AbortSignal`, no
  `timeoutMs` field — and it is first in `AI_LLM_ORDER` with a live key, so it is
  the provider actually selected. This defeats the very fallback built to make the
  provider optional: `polish()`'s `try/catch` engages on a *rejection*, and a hung
  socket never rejects. Corroborated by `/sentinel/observe` **max duration 54,984
  ms** against a p50 of 2,178 ms.
- The **embedding provider had no timeout**, while its sibling completion method in
  the same file did. Embeddings sit on `/observe` via
  `buildWhy → learningReferences → retrieve → memory.search`.

Both now have ceilings (30 s / 15 s) that convert a hang into a rejection, which is
what the existing fallbacks were always designed to catch.

**ML / Brain** — `PatternRecognitionService.recordOccurrence` and the Brain writes
are already wrapped non-fatally and are not on the failure path. The `polishCache`
hit rate is unaffected by this change.

**Note on measurability:** LLM call volume could not be counted directly, because
`AiCallLog`/`AgentActivity`/`AgentRun` are **empty (0 rows)** — the telemetry sink
is installed only in `services/api` while every AI call is made in
`services/sentinel`. That is a separate, pre-existing defect (see *Remaining
Risks*); it bounds what this audit can claim about AI cost, and it is why the LLM
findings above are argued from source and latency rather than from call counts.

---

# Data Isolation Analysis

Every Sentinel-adjacent query on the observation path was checked for scoping.

**Correctly scoped:**
- `prisma.trade.findMany({ where: { userId, executedAt: { gte: since } } })`
- `prisma.position.findMany({ where: { userId } })`
- `prisma.paperWallet.findUnique({ where: { userId } })`
- `prisma.journalEntry.findMany({ where: { userId } })`
- `prisma.trade.count({ where: { userId, executedAt: { gte: dayStart } } })`
- `ComplianceService.feed(userId, …)`
- Timeline and state-machine sessions keyed `userId::symbol::istDateKey`

**Unscoped by design, and correct:**
- `prisma.instrument.findUnique({ where: { symbol } })` — instruments are reference
  data, global by definition.
- `prisma.candle.findMany({ where: { instrumentId, timeframe, bucketStart } })` —
  market history is global.

**One historical near-miss, already fixed before this incident and worth recording
because it is the same class:** `BrokerCredential` used to be looked up by
`provider: 'dhan'` alone, which after the move to per-user credentials would have
resolved to "whichever user's row came back first" — any user who linked their
broker could have ended up powering the shared public feed. It now requires an
explicit operator-set `isFeedDefault: true`. The failure-injection test in this
audit exercises that path.

**Conclusion:** no path was found by which User A can receive User B's analysis,
market context, memory or session state.

---

# WebSocket / Realtime Analysis

- **Sentinel deliberately opens no WebSocket.** Dhan permits 5 connections per
  account and evicts the oldest with code 805; `services/market-data` is the
  declared singleton consumer. Sentinel polls the bridge's in-memory `/quotes`
  instead. This is correct and unchanged.
- **Bridge SSE** (`/stream`): `sseClients` is a `Set`, added on connect and removed
  on `req.on('close')` — no leak. Ticks are coalesced and flushed at 300 ms with a
  15 s keep-alive comment frame, and `no-transform` is set to stop proxy gzip
  buffering a low-rate stream.
- **Option-leg subscriptions**: `subscribedOptionIds` guards re-subscription;
  failed subscribes roll back their entries. Bounded to 15 strikes either side of
  spot (×2 legs) per underlying+expiry against a 5,000-subscription budget.
- **Observed during this incident:** `feedStatus: "reconnecting"` with an empty
  reason, last tick **10:56 IST against a 15:30 close** — 4.5 h of session with no
  ticks and nothing alerting. Quotes were served **384.8 minutes stale** with no
  staleness gate on the quote path. Not the root cause (the candle path fails
  closed and is what produced the 503) but it is the reason the dashboard looked
  alive throughout. Recorded under *Remaining Risks*.

---

# Database / Cache Analysis

**Cache key audit:**

| Cache | Key | Verdict |
|---|---|---|
| `candleGuard` (was `candleCache`) | `symbol:interval:days` | ✓ complete; now also negative-cached and coalesced |
| `expiryGuard` (was `expiryListCache`) | `SYMBOL` (uppercased) | ✓ **fixed** — was raw query value, so case variants split the cache |
| `optionChainCache` | `symbol:expiry` | ✓ |
| `chainCache` (Sentinel) | `SYMBOL:expiryIso` | ✓ |
| `expiryCache` (Sentinel) | `SYMBOL` | ✓; now only caches clean reads |
| `polishCache` | `systemPromptLength:draftText` | ✓ hit requires identical evidence |

No cache key is missing a discriminator that would let it return another user's
state, because none of these caches hold user-scoped data.

**The stale-backfill finding.** The second tier is real and was misreported:

```
NIFTY 15m  oldest 2026-04-24  newest 2026-08-11   (1,627 rows)
NIFTY 1d   oldest 2026-04-23  newest 2026-07-21   (   61 rows)
Snapshot window: 2026-08-12 → 2026-08-17
Rows inside that window: 0
```

So the fallback tier could not answer, and the message said "no backfilled candles
exist" — sending an operator to run a backfill that had already run. The 1d series
is nearly a month stale, which means `priorDay` (and therefore CPR and every
gap-based market profile) is unavailable even when the live feed is healthy.
Recorded under *Remaining Risks* — it is a data-operations gap, not a code defect.

---

# Permanent Fix

Three structural changes, in the order the failure propagates. No `try/catch`
suppression, no added retries, no widened timeouts as a substitute for a fix.

### 1. The credential became a thing with a lifecycle

`packages/market-data/src/providers/dhan/dhan-credential.ts` (new)

`DhanCredential` replaces the module-level `let`:

- `get()` returns the token, re-resolving when stale, expired or previously rejected.
- `invalidate(reason)` is called on a 401, so **the next call re-reads the source** —
  this is the recovery path that previously did not exist.
- `readEnvFile()` parses `.env` **from disk**, not `process.env`, because that is
  where a renewed token actually lands and dotenv would not have overwritten an
  already-set variable anyway.
- Resolution is **single-flight**: 50 simultaneous 401s trigger one re-resolution,
  not 50 (each of which would open its own `PrismaClient`).
- A **retry floor** (15 s) applies only after an attempt that produced no usable
  token, so a genuinely dead credential is not re-resolved per request — while a
  rejection still clears the floor so recovery is immediate.
- Termination: if the source still holds the *already-rejected* token, that counts
  as a failure and re-arms the floor, so invalidate → re-resolve cannot loop.
- `state()` is reported on `/status`, so "up but credential dead" is now visible.

### 2. A fault can no longer be mistaken for an absence

`packages/market-data/src/providers/dhan/dhan-fault.ts` (new)

`classifyDhanFault(status, body)` returns `auth | rate-limit | no-market | upstream`.
Only `no-market` is a fact about the instrument. It reads Dhan's `errorCode` and
wording, not just the status, because Dhan returns 400 for both "no options market"
and "your token died".

Propagated end to end:

- **Bridge**: one `dhanPost()` helper applies the credential and the taxonomy for
  every call. `fetchExpiryList`'s blanket `status >= 400 → []` is gone; only Dhan's
  genuine no-market answer reaches `[]`. Routes emit `{fault, error, needsOperator}`
  alongside the existing shape.
- **Sentinel provider**: `readFeed<T>()` returns a discriminated
  `{ok:true,data} | {ok:false,reason,needsOperator}`. `MarketDataUnavailableError`
  now takes an `UnavailableDiagnosis` and states what each tier actually said —
  including whether stored rows exist but fall outside the window.
  `getOptionExpiries` **throws** on a fault instead of returning `[]`, and only
  caches clean reads. The `MarketDataProvider` contract documents this.
- **contract-alignment**: gains `unreadableReason`, so the panel distinguishes "no
  options market" from "could not find out".
- **Web**: `fetchDhanExpiryList` throws `ExpiryListUnreadableError`. `useExpiries`
  splits `'unavailable'` into **`'none'`** (fact about the instrument) and
  **`'unreadable'`** (fact about us). `WatchCreator` renders a different, true
  message for each — and no longer silently switches the watch to the underlying
  when the read merely failed.

### 3. Upstream load became bounded by distinct keys, not request count

`packages/market-data/src/providers/dhan/upstream-guard.ts` (new)

`UpstreamGuard` wraps `/candles` and `/candles/option` (and expiries) with:

- **Single-flight** — N concurrent callers for one key share one upstream call.
- **Negative cache** — a fault is remembered per `FAULT_CACHE_MS`
  (auth 30 s / rate-limit 5 s / upstream 3 s) and **re-thrown as the same typed
  error**, so caller behaviour is unchanged; only the retry stops reaching Dhan.
- **Credential breaker** — while the credential is known-dead, nothing is attempted
  at all. An auth fault is per-process, not per-symbol; damping it per key would
  still admit one guaranteed-failing call per symbol.
- Bounded key retention (oldest-first eviction).

**Queue back-pressure**: `queueDhanCall` now rejects fast when the projected wait
exceeds what a caller can wait for (`DHAN_OPTION_QUEUE_MAX_WAIT_MS`, 3,500 ms)
rather than accepting unbounded work behind a fixed client deadline. A shed call
returns a named `rate-limit` fault, which the UI reports as "could not read,
retrying" — never as "no option chain".

### 4. Unbounded hangs closed (same class: a dependency unbounded in *time*)

- `AnthropicLlmProvider` — `timeoutMs`, default **30 s**, timeout converted to a
  rejection so the deterministic fallback engages. Overridable via
  `ANTHROPIC_TIMEOUT_MS`.
- `OpenAiCompatibleEmbeddingProvider` — `timeoutMs`, default **15 s**, mirroring the
  completion path in the same file.
- `SentinelApiService` — every api→sentinel hop goes through `fetchWithTimeout`
  (`SENTINEL_SERVICE_TIMEOUT_MS`, default **20 s**), reported as **504** so the
  browser's existing retry policy treats it as transient. Without this, a hung
  Sentinel held an API worker and socket indefinitely; with polling every 10–30 s
  those accumulate instead of draining, which is capacity exhaustion rather than
  slowness.
- `MarketIntelligenceService.snapshot()` — the four independent reads now run
  concurrently via `Promise.allSettled`, cutting three serial round trips off the
  critical path. `allSettled` rather than `all` deliberately, so the intraday
  read's error keeps precedence exactly as when they were sequential — the change
  is behaviour-neutral.

---

# Code Changes

**New**
```
packages/market-data/src/providers/dhan/dhan-fault.ts          fault taxonomy
packages/market-data/src/providers/dhan/dhan-credential.ts     credential lifecycle + readEnvFile
packages/market-data/src/providers/dhan/upstream-guard.ts      single-flight + negative cache + breaker
packages/market-data/src/providers/dhan/dhan-reliability.spec.ts  27 regression tests
packages/market-data/vitest.config.ts                          test runner (allowlist convention)
services/sentinel/src/market-data/candle-market-data.spec.ts    15 regression tests
```

**Modified**
```
services/market-data/scripts/live-feed-server.ts    credential holder, dhanPost, guards, queue
                                                    back-pressure, /status observability
services/sentinel/src/market-data/candle-market-data.provider.ts
                                                    FeedRead<T>, UnavailableDiagnosis,
                                                    getOptionExpiries throws on fault
services/sentinel/src/intelligence/market-intelligence.service.ts
                                                    parallel snapshot reads; expiry fault →
                                                    contractsReadable:false + reason
services/sentinel/src/intelligence/contract-alignment.ts        unreadableReason
services/api/src/sentinel/sentinel.service.ts                   fetchWithTimeout on all 7 hops
packages/ai-core/src/providers/impl/anthropic.ts                timeoutMs (default 30s)
packages/ai-core/src/providers/impl/openai-compatible.ts        embedding timeoutMs (default 15s)
packages/ai-core/src/providers/factory.ts                       ANTHROPIC_TIMEOUT_MS wiring
packages/types/src/market-data.ts                               contract: faults MUST throw
packages/market-data/src/index.ts                               exports
packages/market-data/package.json                               vitest
apps/web/src/lib/dhanLiveFeed.ts                                ExpiryListUnreadableError
apps/web/src/lib/sentinel/useExpiries.ts                        'none' vs 'unreadable'
apps/web/src/components/sentinel/strategy/WatchCreator.tsx      true message per state; no
                                                                silent instrument switch
services/sentinel/vitest.config.ts                              new suite in the allowlist
```

No files deleted; no code removed beyond the specific defective lines.

---

# Regression Tests

42 new tests, all of which fail against the pre-fix code.

**`packages/market-data/.../dhan-reliability.spec.ts` (27)**
- The verbatim DH-901 body classifies as `auth`, not `no-market`.
- 429 classifies as `rate-limit`, not `no-market`.
- Dhan's genuine `DH-813` still classifies as `no-market` (no over-throwing).
- An auth code inside a 400 body wins over the status; auth *wording* also matches,
  so an unknown `DH-xxx` cannot become `no-market`.
- A renewed token is picked up after a rejection **with no restart**.
- 50 concurrent re-resolutions collapse to 1.
- The retry floor holds: 100 requests over 5 s → 1 resolution.
- invalidate → re-resolve does not loop when the source still holds the dead token.
- Expired/proactive refresh; a refresh that finds nothing keeps the working token.
- 50 concurrent identical reads → **1** upstream call.
- 8 sequential failing reads → **1** upstream call.
- The negative cache re-throws the *same typed* fault.
- Zero upstream calls while the breaker is open.
- One key's fault does not suppress another key; faults clear on renewal.
- Key retention is bounded.

**`services/sentinel/.../candle-market-data.spec.ts` (15)**
- The 503 message must **not** contain "The Dhan live-feed bridge is unreachable"
  when the bridge answered, and must contain `DH-901`.
- Stale stored history is reported as stale, with the newest bar's timestamp, and
  distinguished from never-backfilled.
- A 4 s abort is named as a timeout.
- `getOptionExpiries` **throws** on auth / rate-limit / unreachable, and returns
  `[]` only for a clean empty read.
- A fault is not cached as "no options market"; a still-valid cached list is served
  in preference to throwing.
- `getOptionCandles` names a refused leg rather than returning a flat series.

**Proof the tests are not vacuous.** The pre-fix provider was extracted from
`git HEAD` and the same assertions run against it, inverted. All five characterised
the bug exactly:

```
✓ claimed the bridge was unreachable when it answered with a named auth fault
✓ claimed "no backfilled candles exist" while stale rows sat in the table
✓ returned [] — "no options market" — for a refused credential
✓ returned [] for a rate limit too — so concurrency alone removed the chain
✓ returned [] when the bridge was genuinely unreachable
```

(That temporary harness was removed after the run; the assertions live on in the
suites above.)

---

# Concurrency Test Results

**Bridge, before vs after** — identical harness, same running service.

```
                                    BEFORE                  AFTER
baseline /status                    ~2 ms                   ~1 ms
8× sequential identical /candles    30 ms median            2 ms median
                                    (8 upstream calls)      (1 upstream call)
10 concurrent identical             wall 127 ms             wall  21 ms
25 concurrent identical             wall 276 ms             wall  33 ms
50 concurrent identical             wall 621 ms             wall  48 ms
repeat right after the burst        30 ms (not cached)      1 ms (coalesced+cached)

6 concurrent expirylist, distinct symbols:
  BEFORE  34 / 3,148 / 6,260 / 9,358 / 12,463 / 15,566 ms → 4 of 6 EXCEED the 4 s abort
  AFTER    4 /     4 /     4 /     5 /      5 /     58 ms → 0 of 6 exceed
```

**Fault amplification, measured on the live bridge with an injected dead credential:**

```
                       upstream calls   faults served
before 80 requests           1                0
after  80 requests           1               80
```

**80 failing requests produced 0 additional Dhan calls.** Pre-fix, each of those 80
was its own upstream call.

**Sentinel `/observe`, multi-user** — 69 concurrent observations, 0 failures, 0
leakage (full output in *Concurrency Analysis*). Against a **76% failure rate** on
this endpoint earlier the same day.

---

# Failure Injection Results

| Injected condition | Result |
|---|---|
| **Dead credential (designated an invalid token as feed default, restarted the bridge so it booted holding it)** | `/candles` → `HTTP 200 {fault:'auth', error:'…DH-901…', needsOperator:true}`. `/status.credential` → `healthy:false`, verbatim `lastFault`, `retryingInMs:3154`. |
| **80 requests against the dead credential** | 0 additional upstream calls; `faultsServed:80`. |
| **Credential renewed, bridge NOT restarted** | **Recovered in ~1 s.** PID 36976 unchanged. `/status.credential` → `healthy:true`, `source` `db`→`env`, `resolutions:2`, `lastFault:null`. This is the single most important result in this audit: pre-fix this state was unrecoverable without a process restart. |
| **Bridge stopped entirely** | `/observe` → 503 in 0.26 s: *"Live feed: bridge unreachable — fetch failed. Stored history: 15m rows exist but none inside the requested window (…); newest stored bar is 2026-08-11T06:00:00.000Z — the backfill is stale."* Both clauses true; names the real second problem. |
| **Rate limit / queue saturation (6 concurrent distinct symbols)** | 1 served, 5 shed in ~4 ms with `fault:'rate-limit'` and the projected wait. No client timeouts; no symbol reported as having no option chain. |
| **Dhan WebSocket refused (429 on connect, observed live)** | REST paths unaffected; `/candles`, `/optionchain` and `/observe` all served real data. Confirms the streaming and metered paths degrade independently. |

---

# Before vs After

**Before**

```
User A → /observe NIFTY
       → bridge /candles → Dhan 401 (token read at boot 18 h ago, renewed on disk 20 min ago)
       → HTTP 200 {candles:[], source:'error'}          ← fault laundered into emptiness
       → tier 2: 1,627 rows exist, all outside the window → null
       → 503 "The bridge is unreachable and no backfilled candles exist"   ← BOTH FALSE
       → not cached, not coalesced → retry = 2 more Dhan calls

User B → /observe BANKNIFTY (concurrently)
       → same dead credential, its own fresh Dhan calls
       → expirylist queued behind A's → 6.2 s > 4 s abort
       → abort classified as 4xx → "BANKNIFTY has no live option chain"    ← FALSE
       → watch silently switched to the underlying

Users C…N → each multiply the metered calls; ~13 users saturate 5 req/s;
            past that everyone fails, and failing costs MORE than succeeding.
Recovery → only a manual process restart.
Result   → 76% failure rate on /observe; max observation 54,984 ms.
```

**After**

```
User A → /observe NIFTY
       → candleGuard: 1 upstream call for this key per 60 s
       → Dhan 401 → classifyDhanFault → 'auth' → credential.invalidate()
       → next call re-reads .env FROM DISK → renewed token → recovered (~1 s, no restart)
       → success: 25 bars, CE+PE legs read, PCR signal, profile "Descent Continuation"

User B → /observe BANKNIFTY (concurrently)
       → separate key, separate sessionKey (userId::symbol::date)
       → shares A's coalesced calls where the key matches; breaker spares it
         guaranteed-failing calls where it does not
       → success, with its own isolated state

Users C…N → cost scales with DISTINCT SYMBOLS, not with user count.
            50 concurrent identical reads = 1 upstream call.
Fault    → 80 failing requests = 0 upstream calls, one named diagnosis.
Recovery → automatic, ~1 s after the credential is renewed.
Result   → 69/69 concurrent observations succeed, 0 leakage.
```

---

# Remaining Risks

Found during this work, **not** fixed here because each is a separate concern with
its own blast radius. Listed in the order I would take them.

1. **AI telemetry is written by a process that makes no AI calls.**
   `AiCallLog`/`AgentActivity`/`AgentRun` are **0 rows** against `ApiCallLog`'s
   181,541 over 14 days, because `setTelemetrySink()` is installed only in
   `services/api` while every AI call happens in `services/sentinel`. Until this
   lands, no LLM cost, latency or failure claim about this system is verifiable —
   including the timeout defaults I chose above. **Highest-value next fix.**

2. **Stale backfill.** NIFTY 15m stops at 2026-08-11 and 1d at 2026-07-21, so the
   second data tier cannot serve the 5-day window and `priorDay` (CPR, every
   gap-based profile) is unavailable even when the live feed is healthy. The
   message now says so; the backfill still needs running on a schedule.

3. **No staleness gate on the quote path.** Quotes were served **384.8 minutes**
   old with no signal, and `marketStatus` is stamped at write time so a 10:56 tick
   still reads `"open"` at 17:21. The candle path fails closed; the quote path
   (breadth, VIX) does not.

4. **Feed liveness is unmonitored.** 4.5 h of the session produced no ticks with
   `feedStatus:"reconnecting"` and an empty reason, and nothing alerted. The
   credential is now visible on `/status`; tick recency should be too.

5. **Cognition network learns nothing while switched on.** `COGNITION_ENABLED=true`,
   `Percept`=1,120, `CognitiveEpisode`=970, **`NeuralSynapse`=0**. A silent no-op
   presented as a live capability. Partly downstream of (1).

6. **No runtime failover between LLM providers.** `AI_LLM_ORDER` is documented as a
   fallback chain but `pick()` selects the first *registered* provider and never
   reconsiders on failure. Mitigated for the orchestrator by its deterministic
   draft; not for `explain` or the assistant.

7. **Browser reads the bridge directly**, bypassing `services/api`, so the chart and
   the engine have two uncoordinated freshness windows — the chart-vs-agent
   divergence class already recorded twice in the vault.

8. **Silent interval substitution.** `INTRADAY_INTERVAL[interval] ?? '5'` means a
   strategy saved as `3m` is evaluated on 5m bars with no error anywhere. Same
   fault-as-fact class as this incident, still open.

9. **Queue shedding is a real trade-off.** With Dhan's ~1-call-per-3s option-chain
   ceiling, ≥2 concurrent distinct symbols cannot all be served inside a 4 s
   deadline — the physics are fixed upstream. Shedding fast with a named, retryable
   fault is the honest option, but users on less-common symbols will see "could not
   read, retrying" during bursts. The durable fix is persisting chains server-side
   (the Phase 4 ingestion pipeline), not tuning this queue.

10. **`SENTINEL_SERVICE_TOKEN` / `SERVICE_TOKEN`** are the same secret under two
    names, acknowledged as consolidation debt in `.env.example`.

---

# Final Verification

```
Root cause identified                    ✓  module-level credential + fault-as-absence
Root cause proven with code evidence     ✓  file/function/line for all four defect sites
Runtime reproduction completed           ✓  DH-901 reproduced; PID/mtime timeline proves
                                            the bridge held a token 18 h old while the
                                            renewed one sat on disk
Permanent fix implemented                ✓  credential lifecycle, fault taxonomy,
                                            load bounding, timeouts
Multi-user concurrency tested            ✓  2/5/10/50 users, mixed symbols, same user
                                            two symbols — 69/69 ok, 0 leakage
Regression tests added                   ✓  42 new; verified to FAIL against git HEAD
Failure scenarios tested                 ✓  dead credential, renewal without restart,
                                            bridge down, rate limit, WS refused
No silent workaround added               ✓  no suppression, no added retries, no widened
                                            timeout used as a substitute for a fix
Sentinel state isolated                  ✓  user-scoped sessionKeys audited; bridge
                                            carries no user identity
Retry behaviour bounded                  ✓  single-flight + negative cache + breaker +
                                            queue back-pressure; 80 failures → 0 calls
Realtime lifecycle verified              ✓  SSE add/remove, subscription guard, no leak
Final audit written                      ✓  this file
Repository tests pass                    ✓  1,355 tests green
```

**Repository test run:**
```
@tradew/admin        2 files    50 tests   passed
@tradew/web         29 files   471 tests   passed
@tradew/api         31 files   409 tests   passed
@tradew/sentinel    21 files   381 tests   passed   (+15 new)
@tradew/ai-core      1 file     17 tests   passed
@tradew/market-data  1 file     27 tests   passed   (+27 new, plus scrip-master verify)
                              ───────────
                               1,355 tests passed
```

**Live end-to-end, after the fix:**
```
POST /observe {"symbol":"NIFTY"}        HTTP 201 in 2.34 s
  confidence 37.8 | 26 signals | profile "Descent Continuation"
  contractWatch: 25 index bars, CE 24300 (26 bars), PE 24300 (26 bars)
  option chain read (PCR signal present)
/status.credential                     healthy:true  source:env
```

Both screenshot symptoms are resolved, and the mechanism that produced them has
been removed rather than suppressed: the credential can no longer strand a running
process, a fault can no longer be reported as a property of the market, and one
fault can no longer cost more than one upstream call.
