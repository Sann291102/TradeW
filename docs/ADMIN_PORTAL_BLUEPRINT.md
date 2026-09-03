# TradeW Admin Portal — Blueprint (as built, and what is next)

**Last updated:** 2026-08-20 (second pass — the P0 backlog below is now built)
**Verified against:** `main` @ `6928301`, by reading source — not by running the stack (see [How to verify this yourself](#how-to-verify-this-yourself)).
**Supersedes:** the 2026-08-09 v1.0 blueprint, archived verbatim at
[`archive/root-docs/ADMIN_PORTAL_BLUEPRINT-vision-2026-08-09.md`](../archive/root-docs/ADMIN_PORTAL_BLUEPRINT-vision-2026-08-09.md).

## Why this document was rewritten

The previous version described an admin portal that does not exist and does not
match the one that does. It specified a **separate `tw-admin` git repository**, a
**dedicated Postgres instance with its own 470-line Prisma schema**, **Next.js API
routes** (`/api/users`, `/api/agents/:id/screen`, `/api/subscriptions/...`) as the
backend, an **18-week 9-phase plan**, and a roadmap in **2025 quarters** that had
already passed when it was written.

What was actually built, in the same fortnight, is a **standalone Next.js app
inside this monorepo** (`apps/admin`) that owns **no data at all** — it reads the
shared Postgres exclusively through `services/api`'s NestJS `AdminController`,
behind a deny-by-default proxy allowlist. None of the endpoints in the old
section 10 exist. The old section 9 schema conflicts with
`packages/database/prisma/schema.prisma`, which is the single source of truth for
every table the console reads.

Keeping both documents live meant every question about the admin portal had to be
re-answered from source. That is what this rewrite fixes. The aspirational
material (3D command center, agent rooms, live agent screens) is not deleted —
it is preserved in the archived original and summarised, honestly labelled, in
[§6](#6-the-vision-not-built).

---

## 1. What exists today

`apps/admin` — 55 files, a standalone Next.js 14 app on **port 3001**
(`npm run dev:admin`), Tailwind + framer-motion, `vitest` for tests. It is never
public: loopback-bound + SSH tunnel (`infra/docker/DEPLOY-DEV.md`).

### 1.1 The surfaces, split honestly

`src/components/shell/nav-config.ts` deliberately keeps two lists, and the sidebar
renders them as two labelled groups. This is load-bearing: a 2026-08-12 parity
audit found the sidebar advertising eight unbuilt modules while hiding four
working ones.

**Working — reads live data through the proxy (7):**

| Route | File | Reads |
|---|---|---|
| `/` Dashboard | `(console)/page.tsx` | `/admin/overview`, `/admin/health`, `/admin/api-calls/timeseries`, `/admin/agents/{states,runs}` |
| `/ai` AI & Sentinel | `(console)/ai/page.tsx` (225 ln) | `/admin/ai/{calls,by-agent,by-model,timeseries}`, `/admin/agents/{states,runs}` |
| `/cognition` Perceptors & Neural | `(console)/cognition/page.tsx` (365 ln) | `/admin/cognition/*` — the only surface with model-affecting writes |
| `/knowledge` Knowledge Management | `(console)/knowledge/page.tsx` | `/admin/knowledge/{tree,file,recent,search,graph,activity}` + SSE |
| `/orders` Orders / OMS | `(console)/orders/page.tsx` (705 ln) | `/admin/orders*`, `/admin/trades`, **`/admin/execution/*`** |
| `/system` Users / System | `(console)/system/page.tsx` | `/admin/users`, `/admin/audit`, `/admin/api-calls/routes` |
| `/audit` Audit & Compliance | `(console)/audit/page.tsx` | `/admin/audit` — filtered by category and event type, searchable, with metadata |

**Scaffolded — routing, auth and nav exist; the page says "Not built yet" (6):**
`/health`, `/agents`, `/reasoning`, `/rules`, `/learning-platform`,
`/observability`. All six render `UnavailableState`
(which names the missing upstream feed) and **no sample data** — the house rule
against inventing numbers in place of a real connection. Do not promote one to
`WORKING_NAV` until its page reads a live feed. `/audit` was promoted on
2026-08-20 under exactly that rule: its feed already existed, so the page could
be built rather than described.

### 1.2 Authentication — two factors, neither in the browser

1. **Who is driving it.** An `OperatorAccount` row (bcrypt cost 10, non-nullable
   hash — there is no OAuth path into this table), with `disabledAt` checked
   against the database on every request (revocation, not a delay),
   `failedAttempts`/`lockedUntil` as an online-guessing brake. Created only by
   `npm run operator:create -w @tradew/database`. Login goes to `services/api`
   `/admin/operator/login`, itself behind `AdminTokenGuard`.
2. **Which process is asking.** `ADMIN_API_TOKEN`, shared with `services/api`.

The browser receives **only an opaque cookie**: the operator assertion is sealed
with AES-256-GCM under `ADMIN_SESSION_SECRET` (server-only, ≥32 chars, fails
closed), `httpOnly`, 12h TTL matching the assertion. `middleware.ts` gates every
page in the Edge runtime by decrypting that cookie — and page access is *all* it
decides; the data calls are re-authorized per request upstream.

### 1.3 The proxy is the entire data path

`src/app/api/proxy/[...path]/route.ts` forwards to `services/api/admin/*` with
`x-admin-token` + `x-operator-assertion` attached **server-side**, and
`Cache-Control: no-store` restated (not forwarded) on the way back.
`src/lib/adminProxyRoutes.ts` is an explicit allowlist — currently ~42 rules,
GET and POST only. A new admin endpoint upstream is **unreachable** from this
console until someone adds a rule here. Both properties are pinned by tests
(`adminProxyRoutes.test.ts`, `adminProxyCacheHeaders.test.ts`,
`operatorSession.test.ts`).

Every write the console can perform, in full — there are seven:

| Write | Route |
|---|---|
| Grant / revoke product admin | `POST /users/set-admin` |
| Enable / disable a perceptor | `POST /cognition/perceptors/:id/enabled` |
| Resolve a cognitive proposal | `POST /cognition/proposals/:id/resolve` |
| Run the cognition network once | `POST /cognition/run` |
| **Arm / disarm an execution profile** | `POST /execution/profiles/:id/enabled` |
| **Run one execution pass now** | `POST /execution/profiles/:id/run` |
| **Grant / revoke a user's agent-trading consent** | `POST /execution/accounts/:userId/agent-trading` |
| Create / rebind an execution profile | `POST /execution/profiles` |

Everything else on this console is a read. **No route on this surface places an
order** — the two execution writes arm a profile and trigger a pass that applies
every policy gate; neither can submit an order directly.

---

## 2. What code actually runs

Two independent loops. The console drives the first. Nothing in the console
drives the second — it runs on a timer inside `services/api`.

### 2.1 Serving a console page

```
browser :3001
  → middleware.ts            decrypt sealed cookie, else redirect /login
  → (console)/<page>.tsx     client component, usePolling(8–20s)
  → /api/proxy/<path>        allowlist check → attach x-admin-token
                              + x-operator-assertion (server-side only)
  → services/api :4000 /admin/<path>   AdminAccessGuard (both factors)
  → AdminService / ExecutionQueryService / CognitionService → Prisma → Postgres
```

Plus two SSE channels served by dedicated route handlers (never the proxy):
`/api/stream` and `/api/stream/knowledge`.

### 2.2 The autonomous paper-agent loops

Three timers, three leases, three cadences. Each cadence is derived from what the
Dhan bridge can actually serve, not chosen for comfort — see
[`docs/product-architecture/AUTONOMOUS-PAPER-AGENTS.md`](product-architecture/AUTONOMOUS-PAPER-AGENTS.md) §9.

```
ExecutionSchedulerService (services/api, three independent leader elections)
  ├── manage tick     default  2_000 ms   PAPER_EXECUTION_MANAGE_MS
  │     PositionManagerService.manageAll()
  │       → SELECT ExecutionPosition WHERE state = OPEN   ← NOT profile.enabled
  │       → one bridge read per pass, premium taken from the BID
  │       → decidePosition(facts)  ONE authoritative decision, fixed precedence
  │            EMERGENCY > STOP > TARGET > TRAIL > INVALIDATED > SQUARE_OFF
  │       → trail: persist an ExecutionTrailAdjustment per 3-point step
  │         exit : atomic claim OPEN → EXITING, then OrderService.exitPosition
  ├── evaluate tick   default 30_000 ms   PAPER_EXECUTION_INTERVAL_MS
  │     PaperExecutionService.runAllEnabled()
  │       → preflight: enabled? PAPER? account authorized? trading day?
  │                    09:15–15:30 IST?
  │       → SentinelExecutionClient → services/sentinel :4010
  │                    POST /execution/evaluate (x-service-token, 30s timeout)
  │            Sentinel side, in order:
  │              1. data quality   (candle history, bar freshness, index spot)
  │              2. agent strategy (code-defined roster only; YAML cannot opt in)
  │              3. index direction(five weighted reads; the chain is NOT consulted)
  │              4. evidence       (declared keys only, per strategy)
  │              5. strike selection
  │       → resolve the selected strike to a real Instrument + live price
  │       → INSERT ExecutionIntent (claims the idempotency key first)
  │       → planRisk(...)        stop, target, quantity from 3% / 9% / 20%
  │       → evaluatePolicy(...)  gates, incl. quote-freshness and risk-plan
  │       → OrderService.placeOrder(...)   ← the existing paper OMS, untouched
  │       → modelPaperFill(...) stored on the intent
  │       → link Order ↔ intent, open an ExecutionOutcome AND an ExecutionPosition
  │         in the same transaction, levels re-derived from the ACTUAL fill price
  └── reconcile tick  default 15_000 ms   PAPER_EXECUTION_RECONCILE_MS
        ExecutionLifecycleService.squareOff()  then .reconcile()
          SUBMITTED → FILLED → CLOSED + ExecutionOutcome (P&L read from Trade
          rows the OMS booked, never recomputed)
          → ExecutionJournalService.write(intentId) folds the outcome into
            StrategyCalibration, then writes the ExecutionJournal row
```

All three timers only start when `PAPER_EXECUTION_ENABLED=true`, and only the
leader replica for that particular lease ticks — three separate `JobLease` rows,
so a slow 30 s evaluation can never stall the 2 s position management. Exits go
through `OrderService.exitPosition` — an ordinary MARKET order in the opposite
direction, margin-settled and charged like any other. There is no direct position
write anywhere in this module.

**Disarming is not a kill switch for open positions.** `manageAll` and
`squareOff` both select on position/intent state and never on `profile.enabled`
(the latter did filter on it before 2026-08-30, which could strand an open
position on a disarmed profile). Disarming an agent stops NEW ENTRIES; the
position it already holds keeps its stop, its target, its trail and its
end-of-day square-off.

---

## 3. Does it really perform paper trading?

**Yes — this is measured, not asserted.** The end-to-end audit recorded in
`knowledge/Gotchas/2026-08-18 - Paper orders invisible in Admin_Web is usually no
order, not a read bug.md` queried the running stack for two real agent order ids
(`443d6dc9-…`, `46e57c7f-…`) and found them present at **every** hop —
`/admin/orders/stats`, `/admin/orders`, `/admin/orders?source=sentinel`, the
console's own proxy leg, and the bound user's `/sim/orders` — field-for-field
identical, with a fresh order visible at all three hops within **196 ms** and a
cancel within **86 ms**.

It is paper trading in the strict sense, structurally:

- `ExecutionEnvironment` has exactly one member, `PAPER`, and the loop refuses a
  profile whose environment is anything else — twice (in `runProfile` and again
  in `evaluatePolicy`), because a non-PAPER value could only come from a row that
  did not originate in this application.
- Side is the constant `BUY`. Long options only, so risk is capped at the
  premium; widening that is a deliberate schema-and-review step, not a config
  change.
- It places orders through the **same** `OrderService` a human order ticket uses,
  into the same `Order`/`Trade`/`Position`/`Wallet` tables. A `USER_PAPER`
  profile's orders therefore show up in that person's own app — one row, one id,
  no sync layer.

### 3.1 What has to be true before a tick produces an order

All seven, every pass:

1. `PAPER_EXECUTION_ENABLED=true` on the API process (off by default).
2. The profile's own `enabled` column is true — armed from `/orders`.
3. `SENTINEL_SERVICE_TOKEN` set, and `services/sentinel` reachable and holding
   market data (a 503 from Sentinel is a *skip*, not a fault — the distinction
   the 2026-08-17 outage fix exists to preserve).
4. For a `USER_PAPER` profile: that user's `agentPaperTradingEnabledAt` consent
   is granted, re-read every pass so a revocation takes effect immediately.
5. An NSE trading day, 09:15–15:30 IST.
6. Sentinel returns `executable` with a selected strike and expiry above the
   profile's confidence floor. Silence writes **nothing** — a row per quiet
   minute would bury the real decisions.
7. Sentinel's own four gates pass, in order — `stale-data`,
   `no-agent-strategy`, `index-direction-conflict`, `evidence-conflict` — and
   then every policy gate on the API side: `profile-enabled`,
   `environment-paper`, `market-open`, `before-square-off` (default 15:10 IST),
   `quote-freshness` (default 15 s; an unknown quote age FAILS),
   `index-direction` (the intent's own direction must still agree),
   `confidence-floor` (platform floor 70%, raised — never lowered — by
   calibration), `risk-plan` / `allocation-ceiling` / `risk-budget`,
   `max-open-positions` (default 1, counted per profile), `max-orders-per-day`
   (default 6), `daily-loss-limit` (default ₹25,000, account-wide),
   `affordable`.

### 3.2 The honest caveat an operator needs

Intents can accumulate while **zero orders** appear, and that is correct
behaviour, not a bug. On 2026-08-18 a human's own manual loss of −₹110,955 on the
bound account tripped two independent gates — `evaluatePolicy`'s account-wide
`maxLossPerDay`, and `DisciplineService.evaluatePlacement` inside `placeOrder`
(409 `discipline_limit`) — so every pass produced a REJECTED or FAILED intent and
no `Order` row. The console's "Intents" card kept climbing while the orders table
stayed flat.

**Do not "fix" either gate.** A person's losses stopping their own agent is
exactly what an account-wide loss bound is for, and the loop must never mint a
`overrideToken` — that is a human friction mechanism (signed, single-use, 20 s
dwell, 40-char reason), and an agent that can mint one has no limit at all.

Two related traps: an agent's **square-off order carries
`executionIntentId = null`** (one intent submits exactly one order, `@unique`),
so `source=sentinel` shows entries and never exits; and `apps/web`'s
`OrdersSection` opens on the **Open** tab, so an instantly-FILLED agent order is
invisible there until the user picks **Executed**.

---

## 4. What to do next

Ordered by what an operator actually loses without it. Every item names the file
it lands in.

### Shipped 2026-08-30 — the autonomous-agent console

The paper-execution loop became a complete trading cycle (entry → management →
exit → journal → calibration), and `/orders` grew the three panels an operator
needs to supervise one without a database client.

1. **Live positions.** `GET /admin/execution/positions` — every `OPEN`/`EXITING`
   position with its entry, stop, target, current trail, trail-step count, last
   observed premium and its age, and unrealized P&L. The stop and target on this
   panel are the ones the 2 s loop is actually monitoring, read from
   `ExecutionPosition`, not recomputed for display.
   *(`position-manager.service.ts`, `admin.controller.ts`, `(console)/orders/page.tsx`.)*

2. **What each agent is thinking right now.** `GET /admin/execution/agents` —
   per armed profile: the index direction and its strength, the strategy that
   matched, the confidence and the effective floor it was measured against, the
   evidence that supported and opposed it, the data-quality verdict, and — when
   nothing traded — the named gate that stopped it. This is the panel that
   answers "it is armed and it is ticking, so why is it not trading?" without a
   log grep.
   *(`paper-execution.service.ts` `lastDecision`/`agentState`, `admin.controller.ts`.)*

3. **Trade journal and calibration.** `GET /admin/execution/journal` renders one
   row per closed trade with its full decision context, and
   `GET /admin/execution/calibration` shows every learning bucket — (agent,
   symbol, strategy, version, regime), its trade count, average R, and the
   confidence-floor adjustment it currently contributes, with its version. The
   join from a journal row to the calibration version that the *next* trade
   consumed is what makes "it learns" checkable rather than claimed.
   *(`execution-journal.service.ts`, `execution-calibration.service.ts`.)*

All four routes are reads. They are on the deny-by-default allowlist as GET only;
nothing on this console can open, move, trail or close a position.

### Shipped 2026-08-20 — the P0 set

Every item below was on this list as P0 and is now in the tree. Kept rather than
deleted: the reason each existed is the argument for not regressing it.

1. **`PAPER_EXECUTION_*` is documented in `.env.example`.** The flag deciding
   whether the loop runs at all existed in five source files and no env
   template, so a fresh deployment could arm a profile and wait forever. Keep
   the template in sync when the loop gains a knob.

2. **The console tells "armed" from "armed and ticking."**
   `GET /admin/execution/status` reports this process's own live state —
   `enabled`, both intervals, both leader leases, whether a pass is in flight,
   and when each tick last fired — and `/orders` renders it beside the armed
   count. Four states are distinguished, because they mean different things to
   an operator: loop off (warn, and it names the env var), on but another
   replica holds the lease (info, ordinary on two replicas), ticking (good, with
   the age of the last pass), and stalled — no pass in over two intervals — as a
   fault. Nothing on the console starts or stops the loop; the status route is a
   read, and `POST` to it is refused by the allowlist.
   *(`execution-scheduler.service.ts`, `admin.controller.ts`,
   `adminProxyRoutes.ts`, `(console)/orders/page.tsx`.)*

3. **"Why did nothing trade today?" is one panel.** Refusals were always
   recorded — as a sentence, written for someone reading one intent, with live
   numbers interpolated into it, which is precisely why they could not be
   counted. `ExecutionIntent.rejectCheckId` now stores the same refusal as the
   failing gate's id (plus `submission-raised` / `oms-rejected` for the two
   non-policy stops), `GET /admin/execution/rejections` groups a window by it,
   and `/orders` renders the breakdown with the most recent full sentence under
   each bar. One map in `execution-policy.ts` supplies both a live check's label
   and a stored refusal's, so a renamed check cannot leave an unlabelled bar.
   *(`execution-policy.ts`, `paper-execution.service.ts`,
   `execution-query.service.ts`, `(console)/orders/page.tsx`.)*

4. **Agent exits are visible.** `Order.exitOfIntentId` links a square-off back to
   the decision it closed — a second, nullable, non-unique column, because the
   entry link is `@unique` and that constraint IS the order-layer idempotency
   guarantee, and because a retried exit is ordinary. `source=sentinel` now
   matches either link, the orders table labels an exit as an exit and names the
   decision it closed, and the trace resolves from an exit order as well as an
   entry — so the orders whose provenance is least obvious from the row are no
   longer the ones with no trace behind them.
   *(`schema.prisma` + migration, `execution-lifecycle.service.ts`,
   `admin.service.ts`, `execution-trace.service.ts`, `(console)/orders/page.tsx`.)*

5. **The limit and its display are one function** — found while building #2.
   `maxOpenPositions` bounds what THIS PROFILE holds and was gated on exactly
   that, but the console counted every non-zero position on the ACCOUNT and
   rendered it against the same limit. On a system account the two agree; on a
   real person's account they do not, so a trader holding two of their own
   positions made their agent read `2/1` — visibly over a limit it was nowhere
   near. Both callers now use `countProfileOpenPositions`.
   *(`execution-open-positions.ts` + spec.)*

6. **`/audit` is built** — see §1.1. The cheapest of the seven placeholders: its
   feed already existed and was already allowlisted.

7. **A pre-existing migration drift is corrected.** `Order.updatedAt` carried a
   database default that `schema.prisma` never declared, dating to
   `20260722100001_oms_order_lifecycle`, so CI's drift job reported a diff on
   every run — on `main` as much as anywhere. Verified by applying main's
   migrations to an empty Postgres and diffing: identical output, none of this
   work's changes present. Dropped in the same migration that touches the table.

### P1 — next, and blocked on a decision rather than on effort

1. **Build the remaining six placeholders, or drop them.** Each needs an
   upstream feed built first — `/health` a per-engine feed, `/agents` an agent
   registry with write control, `/reasoning` a trace read, `/rules` the
   learned-rule store, `/learning-platform` course analytics, `/observability` a
   dependency probe. For each: build the feed, or drop the route. A permanent
   placeholder is the thing `nav-config.ts` exists to prevent hardening into.
2. **Operator RBAC does not exist.** `OperatorAccount` has no role column, so
   every operator can grant product admin, arm an execution profile, and grant
   agent-trading consent. The archived blueprint assumed five roles
   (SUPER_ADMIN / OPS / SUPPORT / FINANCE / COMPLIANCE). At minimum, gate the
   three privileged writes behind a role before a second person gets an account.
3. **No MFA and no IP allow-list.** Both were in the original security section;
   neither exists. Currently mitigated by loopback-binding + SSH tunnel, which is
   real but is a deployment property, not an application one — it evaporates the
   day this is exposed.
4. **KYC/compliance review UI and the DLQ retry UI** — `apps/admin/README.md`'s
   own open roadmap. The DLQ retry worker is still unbuilt engine-side, so the UI
   cannot lead it.

### P2 — genuinely later

Subscription/billing surfaces (the data exists: plans, grants, quota metering,
Razorpay), content management (prompts, announcements), and the 3D command centre
below.

---

## 5. How to verify this yourself

```bash
# The console
npm run dev:admin                 # :3001, needs ADMIN_API_URL/_TOKEN/_SESSION_SECRET
npm test -w @tradew/admin         # proxy allowlist, cache headers, session sealing

# Is the loop even armed?
grep -n PAPER_EXECUTION .env      # the process switch
```

```sql
-- Did the loop write anything, and did any of it become an order?
SELECT status, count(*) FROM "ExecutionIntent" GROUP BY status;
SELECT count(*) FROM "Order" WHERE "executionIntentId" IS NOT NULL;

-- Intents present as REJECTED/FAILED with no orders = a write-path stop.
-- The reason is already written down:
SELECT "rejectReason", count(*) FROM "ExecutionIntent"
 WHERE status IN ('REJECTED','FAILED') GROUP BY 1 ORDER BY 2 DESC;
```

Ask the database before touching a query, a cache or a poll. That is the whole
lesson of the 2026-08-18 audit.

---

## 6. The vision (not built)

Retained here so it is not lost, and labelled so it is not mistaken for a
commitment. Full detail — scene graphs, room concepts, R3F code sketches — is in
the [archived original](../archive/root-docs/ADMIN_PORTAL_BLUEPRINT-vision-2026-08-09.md),
sections 5–7.

- **3D command center** (React Three Fiber): a holographic globe of Indian market
  activity, data flowing between systems, crimson/black glassmorphism.
- **Living AI headquarters**: Engineering / Support / Finance / Security /
  Compliance rooms with a central "AI brain", agents visibly working in each.
- **Live agent screen viewer**: click an agent, see what that agent is looking at
  right now, streamed over WebSocket.
- **Subscription, compliance and content modules**: SOC2/GDPR report generation,
  DSAR export, prompt A/B tests, announcements.

Four corrections to carry forward if any of it is ever built, because the
original states them wrongly and they are architectural:

| Original said | Reality |
|---|---|
| Separate `tw-admin` repository | `apps/admin` in this monorepo, sharing `packages/{ui,types}` |
| Dedicated Postgres + its own `schema.prisma` | One shared Postgres; `packages/database/prisma/schema.prisma` is the only schema |
| Next.js API routes as the backend | `services/api`'s NestJS `AdminController` behind `AdminAccessGuard`, reached only through the allowlisted proxy |
| 18-week phased plan, 2025 quarterly roadmap | Six surfaces already shipped; the real backlog is §4 above |

The single design constraint any of it must respect: **`apps/admin` owns no data
and holds no second copy of a number.** The moment a 3D room needs its own store,
it has become a second system to keep correct.

---

## 7. Related reading

- `apps/admin/README.md` — the app's own status note.
- `docs/product-architecture/AUTONOMOUS-PAPER-AGENTS.md` — the full agent reference: strategies, capital model, exit precedence, cadence, learning bounds.
- `knowledge/Decisions/2026-08-18 - Sentinel paper execution loop (execution capability, not a second Sentinel).md`
- `knowledge/Decisions/2026-08-18 - Sentinel paper execution bound to real TradeW user accounts.md`
- `knowledge/Gotchas/2026-08-18 - Paper orders invisible in Admin_Web is usually no order, not a read bug.md`
- `knowledge/Decisions/2026-08-12 - Operator identity for the standalone admin console.md`
- `docs/APPLICATION-STATUS.md` — the living, whole-platform status doc.
