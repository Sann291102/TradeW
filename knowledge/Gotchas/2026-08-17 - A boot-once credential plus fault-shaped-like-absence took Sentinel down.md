# A boot-once credential plus fault-shaped-like-absence took Sentinel down

**Date:** 2026-08-17
**Blast radius:** every Sentinel observation, all users, for a whole trading session (76% failure rate on `/observe`)
**Full audit:** `SENTINEL_ROOT_CAUSE_AND_PERMANENT_FIX.md` (repo root)

Read before touching `services/market-data/scripts/live-feed-server.ts`,
`services/sentinel/src/market-data/candle-market-data.provider.ts`, or any code
that turns an upstream failure into a value.

---

## The two-sentence version

The bridge read its Dhan token into a module-level `let` once at boot. Dhan caps
every token at 24 h **by SEBI regulation**, so a process that outlives a day is
*guaranteed by arithmetic* to hold a dead credential with no path back to the
renewed one. And because every failure path returned an empty *successful* answer
rather than a named fault, three separate consumers reported a credential failure
as a fact about the market.

## The symptom that gives the whole class away

```
NIFTY has no live option chain, so this watch will follow the underlying itself.
Indices like NIFTY, BANKNIFTY, FINNIFTY and SENSEX have one.
```

**A message that contradicts itself in consecutive clauses is the signature of
code inferring a fact about the world from a failure of its own plumbing.** The UI
had no way to say "I could not find out", so it said the only other thing it knew
how to say. Whenever you see this shape, look for a failure being represented by
the same value as an absence — not for a copy bug.

## Why it survived so long

Everything that *should* have caught it looked healthy:

- The bridge answered in ~30 ms and `/status` reported fine — it had no field for
  "my credential is dead".
- The **ticker kept showing Nifty 50 24,241.10** the whole time, because `/quotes`
  is served from the in-memory WebSocket tick map and uses no credential. Only the
  authenticated REST paths (`/candles`, `/optionchain`) failed — which is exactly
  what the *engine* reads. So the screen looked alive while the engine was blind.
- The user-facing 503 named two innocent components ("the bridge is unreachable",
  "no backfilled candles exist") and never named the guilty one. **A hardcoded
  diagnosis is a guess that can never be wrong out loud** — it sent the
  investigation into the wrong service.
- `tsc` passed, all 1,313 tests passed. Nothing asserted that a fault is not an
  absence.

## The four defect sites

1. `let DHAN_TOKEN = process.env.DHAN_ACCESS_TOKEN || ''` — assigned once, at
   `main()`. No code path reassigned it. **A credential is a lease, not
   configuration**; reading a lease once is the same bug as caching a lock forever.

2. `if (resp.status >= 400 && resp.status < 500) return []` in `fetchExpiryList`.
   The comment justified it correctly for `DH-813 Invalid SecurityId` (a cash-only
   stock genuinely has no options). **But 401 and 429 are also 4xx.** Dhan returns
   400 for both "no options market" and "your token died" — only the *body*
   separates them.

3. `fetchJson<{ candles?: …; source?: string }>` in the Sentinel provider — `error`
   was absent from the declared type, so `{"source":"error","error":"…DH-901…"}`
   arrived and the one useful string was dropped. The failure was caught only
   *incidentally*, by `source !== 'dhan'`.

4. `return cached?.expiries ?? []` on a failed read. With no cache entry that is
   `[]`, and `[]` is the `MarketDataProvider` contract's value for "no options
   market". The comment above it even said "a failed read is not 'no options
   market'" — it got the caching half right and the return half backwards.

## `process.env` is a boot snapshot — this is the part that surprised me

Even re-reading `process.env` would have returned the dead token. dotenv does not
overwrite already-set variables, and a running process never observes a later edit
to `.env` at all. Recovery required parsing the **file from disk**
(`readEnvFile`). Proof from the incident:

```
bridge PID 16652 started    2026-08-16 22:56   (18.37 h uptime)
.env last written           2026-08-17 16:59   (operator renewed the token)
services/sentinel restarted 2026-08-17 17:11   ← picked up the new token, worked
services/api      restarted 2026-08-17 17:11   ← picked up the new token, worked
```

The bridge was the only component that had not restarted, and the only one failing.
**Comparing process start time against config mtime is a fast, high-yield
diagnostic** when one component misbehaves and its neighbours don't.

## Concurrency made it worse in four separate ways

Measured, not reasoned:

- **Failures were free to retry.** `candleCache.set` ran only on the success path,
  so 8 identical failing requests made 8 upstream Dhan calls. *The one situation
  that most needs damping had none.*
- **No in-flight coalescing on `/candles`.** 50 concurrent identical reads → 50
  upstream calls (`/optionchain` had a dedupe map; the hotter route never got one).
- **~13 users saturate the rate limit.** 4 metered series per observation × a 10 s
  poll = 0.4 calls/s per user against Dhan's 5 req/s. Past saturation everyone
  fails — and *failing produced more calls than succeeding*. **The system's
  response to exceeding its rate limit was to exceed it further.** No poll-interval
  tuning fixes that; a failure has to cost less than a success.
- **The shared 3.1 s-gap FIFO guaranteed later users a timeout.** Six concurrent
  distinct symbols: `34 / 3,148 / 6,260 / 9,358 / 12,463 / 15,566 ms` against a
  fixed 4 s client abort — 4 of 6 aborted. An aborted client does not cancel queued
  work, so those calls still ran, spending rate-limited budget on answers nobody
  would read. And the abort was then classified as "no options market", so **the
  2nd+ concurrent user was told NIFTY has no option chain because someone else
  asked first.**

## The rule this leaves behind

> **An absence is a fact about the world. A fault is a fact about us. They must
> never share a representation.**
>
> An absence is safe to cache, safe to render, and needs no operator. A fault
> cached is a lie frozen in place; a fault retried per-request is an outage
> amplifier. If the only way a caller can tell them apart is by inspecting a
> string, they are the same value.

Corollaries worth keeping:

- Classify a 4xx by **body**, not status, when the vendor overloads it.
- A fault must be **named on the wire** (`fault: 'auth' | 'rate-limit' | …`), so the
  correct handling is checkable rather than customary.
- **Only cache clean reads.** Sticky lies are worse than slow truths — the empty
  expiry list was cached 5 min in the bridge and 15 min in Sentinel.
- Error messages should state **what each tier actually said**, never a hardcoded
  narrative. The fixed message correctly reports "15m rows exist but none inside
  the requested window; newest stored bar is 2026-08-11 — the backfill is stale",
  which is a completely different instruction to an operator than "no candles
  exist".
- A timeout is a **different diagnosis** from no-data, and it is the one that points
  at the queue.

## Also true, and separately dangerous

- **A missing timeout defeats a fallback rather than merely slowing it.** The
  Anthropic provider (first in `AI_LLM_ORDER`, live key) had no `AbortSignal` at
  all. Every Sentinel caller wraps LLM use in `try/catch` and composes a
  deterministic draft — but that catches *errors*, and **a hung socket is not an
  error**. The one failure mode the fallback existed for was the one it could not
  handle. `/observe` max duration was **54,984 ms** against a p50 of 2,178 ms.
  Same for the embedding provider, whose sibling completion method in the *same
  file* did set one.
- **Empty telemetry bounds every claim.** `AiCallLog`/`AgentActivity`/`AgentRun` are
  **0 rows** (the sink is installed in `services/api`; every AI call is made in
  `services/sentinel`), so LLM call volume could not be counted, only bounded.

## What the fix looks like

Three structural pieces, all in `packages/market-data/src/providers/dhan/`:

- `dhan-credential.ts` — the token as a lifecycle: `invalidate()` on 401 →
  re-resolve from source on next use, single-flight, retry floor after a *failed*
  attempt only (not after a successful one — that bug cost a test cycle), and
  termination when the source still holds the rejected token.
- `dhan-fault.ts` — `auth | rate-limit | no-market | upstream`. Only `no-market` is
  a fact about the instrument.
- `upstream-guard.ts` — single-flight + negative cache + a **credential breaker**
  (an auth fault is per-process, not per-symbol, so damping per key would still
  admit one guaranteed-failing call per symbol).

Plus: queue back-pressure (shed fast with a named fault rather than queue behind a
fixed deadline), `useExpiries` split into `'none'` vs `'unreadable'`, and timeouts
on the two LLM providers and all seven api→sentinel hops.

**Verified:** 80 failing requests → 0 upstream calls (was 80). 50 concurrent
identical → 1 (was 50). A killed credential recovers in **~1 s with no process
restart**, same PID — previously impossible. 69 concurrent multi-user observations,
0 failures, 0 leakage. 1,355 tests pass (42 new, all verified to fail against
`git HEAD`).

## Isolation audit (the good news)

No cross-user leakage exists. Timeline and state-machine sessions are keyed
`userId::symbol::istDateKey`; every trade/position/wallet/journal query is
`where: { userId }`. **The bridge carries no user identity at all** — it is a pure
market-data cache — which is why the outage was total rather than selective, and
why no user ever received another user's analysis. The concurrency defects here
were contention and amplification, not contamination. Worth remembering that those
are different problems with different fixes.

## Related

- [[Patterns/2026-07-24 - Sentinel live data across the full universe]] — already
  recorded "token expires ~15:21 IST daily". The expiry was known; what was not
  recorded is that a boot-once read makes that expiry *strand the process*.
- [[Gotchas/2026-07-23 - Sentinel not working was four stacked config+build faults]]
  — same service, same shape: several independent faults, each individually
  plausible, presenting as one vague symptom.
- [[Gotchas/2026-08-11 - Sentinel feed fabricated a CE direction on signals that had none]]
  — the other direction of the same Rule 2 failure: there, the UI invented a claim
  the engine never made; here, it invented a claim about the *market* from a
  failure of the plumbing.
- [[Gotchas/2026-08-11 - Dhan WebSocket LTT is an IST-based epoch, REST is UTC]] —
  Dhan's two surfaces disagreeing, again. `/quotes` (WS, no credential) kept working
  while REST failed, which is precisely what hid this bug.
