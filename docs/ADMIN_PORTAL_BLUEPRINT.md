# TradeW Admin Portal — Blueprint (as built, and what is next)

**Last updated:** 2026-08-20
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

**Working — reads live data through the proxy (6):**

| Route | File | Reads |
|---|---|---|
| `/` Dashboard | `(console)/page.tsx` | `/admin/overview`, `/admin/health`, `/admin/api-calls/timeseries`, `/admin/agents/{states,runs}` |
| `/ai` AI & Sentinel | `(console)/ai/page.tsx` (225 ln) | `/admin/ai/{calls,by-agent,by-model,timeseries}`, `/admin/agents/{states,runs}` |
| `/cognition` Perceptors & Neural | `(console)/cognition/page.tsx` (365 ln) | `/admin/cognition/*` — the only surface with model-affecting writes |
| `/knowledge` Knowledge Management | `(console)/knowledge/page.tsx` | `/admin/knowledge/{tree,file,recent,search,graph,activity}` + SSE |
| `/orders` Orders / OMS | `(console)/orders/page.tsx` (705 ln) | `/admin/orders*`, `/admin/trades`, **`/admin/execution/*`** |
| `/system` Users / System | `(console)/system/page.tsx` | `/admin/users`, `/admin/audit`, `/admin/api-calls/routes` |

**Scaffolded — routing, auth and nav exist; the page says "Not built yet" (7):**
`/health`, `/agents`, `/reasoning`, `/rules`, `/learning-platform`,
`/observability`, `/audit`. All seven render `UnavailableState`
(which names the missing upstream feed) and **no sample data** — the house rule against inventing numbers in place of a
real connection. Do not promote one to `WORKING_NAV` until its page reads a live
feed.

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
`src/lib/adminProxyRoutes.ts` is an explicit allowlist — currently ~40 rules,
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

### 2.2 The paper-execution loop

```
ExecutionSchedulerService (services/api, leader-elected)
  ├── evaluate tick   default 60_000 ms   PAPER_EXECUTION_INTERVAL_MS
  │     PaperExecutionService.runAllEnabled()
  │       → preflight: enabled? PAPER? account authorized? trading day?
  │                    09:15–15:30 IST?
  │       → SentinelExecutionClient → services/sentinel :4010
  │                    POST /execution/evaluate (x-service-token, 30s timeout)
  │       → resolve the selected strike to a real Instrument + live price
  │       → INSERT ExecutionIntent (claims the idempotency key first)
  │       → evaluatePolicy(...)  9 gates
  │       → OrderService.placeOrder(...)   ← the existing paper OMS, untouched
  │       → link Order ↔ intent, open an ExecutionOutcome on a fill
  └── reconcile tick  default 15_000 ms   PAPER_EXECUTION_RECONCILE_MS
        ExecutionLifecycleService.squareOff()  then .reconcile()
          SUBMITTED → FILLED → CLOSED + ExecutionOutcome (P&L read from Trade
          rows the OMS booked, never recomputed)
```

Both timers only start when `PAPER_EXECUTION_ENABLED=true`, and only the leader
replica ticks. Exits go through `OrderService.exitPosition` — an ordinary MARKET
order in the opposite direction, margin-settled and charged like any other. There
is no direct position write anywhere in this module.

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
7. All nine policy gates pass: `profile-enabled`, `environment-paper`,
   `market-open`, `before-square-off` (default 15:10 IST), `confidence-floor`
   (default 70%), `max-open-positions` (default 1, counted per profile),
   `max-orders-per-day` (default 6), `daily-loss-limit` (default ₹25,000,
   account-wide), `affordable`.

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

### P0 — the console can mislead an operator today

1. **~~`PAPER_EXECUTION_*` is undocumented in `.env.example`.~~** Fixed in this
   change. The flag that decides whether the loop runs at all existed in exactly
   five source files and no env template, so a fresh deployment could arm a
   profile and wait forever. Keep the template in sync when the loop gains a knob.
2. **The console cannot tell "armed" from "armed and ticking."** The Sentinel
   card reads `enabledProfiles` from the database; the env switch lives in the
   API process. A profile can show as armed while the loop is disabled, and the
   only hint is a footnote in small print under the table. **Add
   `GET /admin/execution/status`** returning `{ enabled, intervalMs,
   reconcileMs, isLeader, lastEvaluateTickAt, lastReconcileTickAt }`, allowlist
   it, and render it as a status indicator beside "Armed profiles."
   (`execution-scheduler.service.ts` → `admin.controller.ts` →
   `adminProxyRoutes.ts` → `(console)/orders/page.tsx`.)
3. **"Why did nothing trade today?" needs one view.** The reason is already on
   `ExecutionIntent.rejectReason` and in the per-order trace, but only per-intent.
   Group today's REJECTED/FAILED intents by their first failing check id, so the
   answer is one glance instead of the day the 2026-08-18 audit spent on the read
   path. (`execution-query.service.ts` + a panel on `/orders`.)
4. **Label agent exits.** Either link the square-off order back to its intent
   (a nullable second FK, keeping the `@unique` entry link intact) or render an
   explicit "exit (agent)" source pill. Today the source filter quietly under-
   reports agent activity by half.

### P1 — the promised surface that is still a placeholder

5. **`/audit` is the cheapest win of the seven.** `/admin/audit` is already
   allowlisted and already read by `/system`; the page is a placeholder purely
   because nobody built the filtered view. The other six each need an upstream
   feed first (`/health` a per-engine feed, `/agents` an agent registry with
   write control, `/reasoning` a trace read, `/rules` the learned-rule store,
   `/learning-platform` course analytics, `/observability` a dependency probe).
   For each: build the feed, or drop the route. A permanent placeholder is the
   thing `nav-config.ts` exists to prevent hardening into.
6. **Operator RBAC does not exist.** `OperatorAccount` has no role column, so
   every operator can grant product admin, arm an execution profile, and grant
   agent-trading consent. The archived blueprint assumed five roles
   (SUPER_ADMIN / OPS / SUPPORT / FINANCE / COMPLIANCE). At minimum, gate the
   three privileged writes behind a role before a second person gets an account.
7. **No MFA and no IP allow-list.** Both were in the original security section;
   neither exists. Currently mitigated by loopback-binding + SSH tunnel, which is
   real but is a deployment property, not an application one — it evaporates the
   day this is exposed.
8. **KYC/compliance review UI and the DLQ retry UI** — `apps/admin/README.md`'s
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
- `knowledge/Decisions/2026-08-18 - Sentinel paper execution loop (execution capability, not a second Sentinel).md`
- `knowledge/Decisions/2026-08-18 - Sentinel paper execution bound to real TradeW user accounts.md`
- `knowledge/Gotchas/2026-08-18 - Paper orders invisible in Admin_Web is usually no order, not a read bug.md`
- `knowledge/Decisions/2026-08-12 - Operator identity for the standalone admin console.md`
- `docs/APPLICATION-STATUS.md` — the living, whole-platform status doc.
