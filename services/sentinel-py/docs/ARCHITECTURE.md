# Sentinel (Python) — Architecture

**Service:** `services/sentinel-py` · FastAPI · Python 3.11 · port `4011`
**Last verified against the code:** 2026-08-15

This describes what exists. Anything planned but not built is in PLAN.md and
is not described here as though it were real.

---

## 1. Position in the system

```
  browser (apps/web)
        │  session JWT
        ▼
  services/api  (NestJS, port 4000)          ← the ONLY public ingress
        │  AuthGuard + CapabilityGuard('sentinel')
        │  x-service-token, userId from req.user.sub
        ▼
  services/sentinel-py  (FastAPI, port 4011) ← internal only
        │                    │
        │ asyncpg            │ HTTP
        ▼                    ▼
   Postgres            live-feed bridge (port 4600)
   (Prisma-migrated)    services/market-data → Dhan
```

Two rules hold this together:

- **`userId` never comes from the client.** `services/api` fills it from the
  authenticated JWT and does not forward client query strings. A route that
  let a caller name the user would let any signed-in account read every other
  account's strategies.
- **Prisma owns the schema.** This service reads and writes with `asyncpg`,
  but every table is migrated by `packages/database/prisma`. There is one
  migration tool in the monorepo.

`services/sentinel` (TypeScript, port 4010) is untouched and still runs. It
does a different job — market analysis on its own account. Retiring it is a
separate decision that has not been taken.

---

## 2. Data model

Three tables, all migrated by Prisma:

| Table | Holds |
|---|---|
| `UserStrategy` | The user's strategy: name, `rawInput`, `rules` JSON, status |
| `WatchSession` | One strategy applied to one instrument: symbol/strike/expiry, state, the user's declared entry/invalidation/direction, `reachedMilestones` |
| `WatchObservation` | One sweep's result: per-rule evaluations, state, and a metadata bag of the evaluator's own measurements |

`WatchObservation` is the audit trail and the analytics substrate at once. It
is append-only, and it records sweeps that *failed* to read the market as well
as those that succeeded — that record is the answer to "why didn't Sentinel
tell me anything?".

Naming note: the table is `WatchObservation`, not `SentinelObservation` — that
name already belongs to the TypeScript service's market-wide feed. They are
different things that briefly shared a word, and the collision broke the build
once.

---

## 3. Module map

```
app/
  core/       config, service-token auth, JobLease (leader election)
  market/     clock.py    — IST session boundaries, 09:15–15:30
              feed.py     — candle fetcher; real data or an error
  strategy/   parser.py   — free text → rules, deterministic, no LLM
              templates.py— the 11-entry catalogue
              schemas.py  — the rules JSON contract
              store.py    — UserStrategy persistence
              performance.py — funnel, outcomes, R stats
              segments.py — strategy-specific breakdowns
              contract.py — the ONE payload the UI renders from
              router.py   — /strategies/*
  watch/      indicators.py  — pure primitives over candle lists
              evaluator.py   — condition strings → met/unmet + detail
              state_machine.py — IDLE→FORMING→CONFIRMED→IN_TRADE→EXITED
              poller.py      — the sweep loop, leased
              timeline.py    — observations → collapsed feed events
              store.py, router.py
  intrade/    monitor.py  — R milestones, invalidation, projected level
  notify/     compliance.py — vocabulary + metadata guard
              dispatcher.py — → services/api → Notification row
```

### The layering rule

`indicators.py` contains **pure functions over candle lists** — no I/O, no
state. Each answers a factual question about price ("is this EMA rising?",
"did this candle's body reach the level?"). Nothing there decides whether a
setup is good.

`evaluator.py` maps a condition string to one of those primitives.
**An unknown condition is never met** and says so in its detail, so a strategy
containing something the parser recognised loosely can never silently count as
confirmed.

That separation is what lets Sentinel be described to a user as *"your rules,
checked"* rather than *"our model, applied"*.

---

## 4. The watch loop

```
every 15s (SENTINEL_PY_SWEEP_SECONDS), if market open and we hold the lease:

  for each active watch:
      fetch candles  ──── unavailable? ──→ record skip observation, continue
            ↓
      drop the forming candle
            ↓
      evaluate the user's rules  ──→ per-rule met/unmet + human detail
            ↓
      advance the state machine  ──→ transition, maybe a notification tier
            ↓
      persist WatchObservation (rules + measurements)
            ↓
      dispatch notification if the transition warrants one
```

Design decisions worth knowing:

- **Leased singleton.** `JobLease` (ported from the TS service's leader
  election) means only one instance sweeps. Without it, two replicas would
  evaluate every watch twice and notify twice.
- **Only closed candles.** The bridge returns the in-progress bar last; it is
  dropped. This is "confirmation before notification" in one line of code.
- **Cooldown never suppresses a forward transition.** A recent *Wait & Watch*
  must not swallow a *CONFIRMED*.
- **Repeated state collapses.** Forty consecutive "still forming" sweeps are
  one state, not forty events (`timeline.py::_collapse`).
- **An open position stops evaluating entry rules.** They are spent; what
  matters is movement against the user's declared numbers.

---

## 5. The generic strategy contract

`GET /strategies/{id}/contract` returns one shape, whatever the evaluator
underneath:

```
id, name, status, template, configuration, watches, focusedWatchId,
currentState, conditions, latestObservation, lifecycle, dataStatus,
performance, availableAnalytics, segments
```

This is the load-bearing frontend decision. Without it the web app branches on
which strategy it is looking at, and the eleventh strategy needs an eleventh
screen before it can be shown at all.

Three properties keep it honest:

1. **`configuration.parameters` is derived from the strategy's own rules**, so
   a seven-rule strategy gets seven controls. There is no per-strategy form.
2. **`availableAnalytics` is derived from observations that exist**, not from
   what a template could in principle measure. A strategy adopted this morning
   offers no breakdowns.
3. **`dataStatus`** distinguishes "the market was quiet" from "Sentinel could
   not read the market", which otherwise produce an identical empty screen.

Two tests defend it: one asserts the key set is identical across nine
templates; one renders two unrelated strategies through the same React
components and **fails if any component so much as mentions a template id**.

---

## 6. Frontend integration

Everything lives in the "Your strategies" section of `/sentinel`
(`components/sentinel/strategy/SentinelStrategyWorkspace.tsx`). There is no
separate strategies route — one was built and removed, because two surfaces
for one job drift apart.

```
StrategyComposer          describe → Parse → understood → save
InbuiltStrategyPicker     backend catalogue → preview → adopt
SelectedStrategyPanel     my strategy: config, conditions, context,
                          lifecycle, performance   (contract-driven)
WatchCreator              WHERE the strategy is applied
WatchCard                 running watches
```

`lib/sentinel/strategyContract.ts` is the **only** place the contract payload
is interpreted. Six components each parsing the API for themselves would
drift, and the first strategy whose shape differed would get a special case.

---

## 7. Compliance boundary

```
   evaluator produces facts
            ↓
   dispatcher composes a message from fixed templates
            ↓
   compliance.assert_compliant()   ← rejects banned wording AND
            ↓                         forbidden metadata keys
   services/api writes a Notification row
            ↓
   apps/web polls /notifications every 30s
```

The guard rejects rather than rewrites. A notification arrives stripped of the
page that explains it: a price to enter at and a price to stop at **is** a
trade alert, whatever the surrounding words say — hence the metadata-key
check, not just the text check.

Notification latency is ~45s worst case (15s sweep + 30s poll). WebSocket push
is deferred and tracked in issue #7.
