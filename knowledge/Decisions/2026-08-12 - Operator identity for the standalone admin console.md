---
type: decision
date: 2026-08-12
tags: [decision, security, admin, auth, operator]
---

# Operator identity for the standalone admin console (Option B)

**Read before touching** `services/api/src/admin/`, `AdminGuard`,
`AdminAccessGuard`, `OperatorAccount`, or wiring anything in `apps/admin`.

Decision on the question posed by
[[Plans/2026-08-12 - Admin consolidation auth design (operator boundary)]]. That
note has the full reasoning and the ten answered questions; this records what was
chosen and built.

## What was decided

**Option B.** The standalone `apps/admin` control plane gets its own identity
store (`OperatorAccount`), separate from the product's `User` table, and
`AdminController` is gated by a **composed** guard rather than a widened one.
Option A (give the console a real product JWT) was kept on record as a lighter
interim but not taken — a control plane should not inherit the product's signup
/ reset / OAuth surface.

The rejected shortcut — making `ADMIN_API_TOKEN` sufficient on its own — was
reverted. The rule it violated: **a shared secret proves a process is trusted,
never that a person is present, and never which person.**

## What shipped (Phase 1 — backend, done and tested)

- `OperatorAccount` model + additive migration `20260812000000_operator_accounts`
  (`email`, `passwordHash` (bcrypt), `disabledAt`, `failedAttempts`,
  `lockedUntil`, `lastSeenAt`). No OAuth path, by design.
- `OperatorService` — login (constant-work on the miss path, 5-strike lockout),
  assertion mint/verify. **The assertion is signed with `OPERATOR_JWT_SECRET`,
  NOT `JWT_SECRET`** — this is the load-bearing detail. `AuthGuard` accepts any
  claims that verify under `JWT_SECRET`, so an operator assertion signed with the
  product key would be a valid product bearer token. Separate key + a required
  `typ: 'operator'` claim keeps the two credential systems apart. The key is also
  NOT derived from `ADMIN_API_TOKEN`, which travels on the wire every request.
- `AdminAccessGuard` — routes on the presence of `x-operator-assertion`:
  absent → delegates **verbatim** to the unchanged `AdminGuard` (apps/web's
  product-admin path); present → operator token (required) + assertion. The
  token is required on both paths and sufficient on neither. Sets
  `req.user.sub = 'operator:<id>'` so `setAdmin` / `resolveProposal` stay
  attributable — the thing the reverted bypass broke.
- `OperatorController` — `POST /admin/operator/login|verify`, `GET status`,
  gated by `AdminTokenGuard` (the login endpoint mints the second factor, so it
  cannot require it; it still requires the first).
- `create-operator` CLI (`npm run operator:create -w @tradew/database`),
  `OPERATOR_JWT_SECRET` in `.env.example`.
- Specs: `admin-access.guard.spec.ts` (9), `operator.service.spec.ts` (10). Full
  api suite green (324).

## Phase 2 — apps/admin login + sealed session + proxy (DONE, tested)

The standalone console now authenticates a real operator end-to-end, browser
credentials never touching `services/api` directly and no privileged credential
ever reaching browser JavaScript:

- `apps/admin/src/lib/operatorSession.ts` — the session is the operator
  assertion + identity **sealed with AES-256-GCM** under a server-only
  `ADMIN_SESSION_SECRET`, carried in an httpOnly cookie as opaque ciphertext.
  Edge-safe (Web Crypto), so `middleware.ts` validates it without a Node
  runtime. This is the interpretation chosen for "assertion stored server-side":
  no session backend exists in `apps/admin`, and sealing under a server-only key
  keeps the plaintext inside this process while staying Edge-compatible.
- `apps/admin/src/lib/operatorAuth.ts` + `app/api/auth/login/route.ts` — the ONE
  auth boundary. Browser → `/api/auth/login` (email+password) → server-side →
  `services/api /admin/operator/login` (with `x-admin-token`) → assertion sealed
  into the cookie. The browser never calls the API and receives only the cookie.
- `app/api/proxy/[...path]/route.ts` and both SSE stream routes now forward
  **both** `x-admin-token` and `x-operator-assertion`, decrypted server-side.
- Old token-only session (`session.ts`, its test, `api/session/route.ts`)
  archived to `archive/apps-admin-session-2026-08-12/` per Rule 1 — no second
  login path left behind.
- `ADMIN_SESSION_SECRET` added to `apps/admin/.env.example`; distinct from
  `ADMIN_API_TOKEN` (which is on the wire every request) by design.
- Test: `apps/admin/src/lib/operatorSession.test.ts` (7) — round-trip, no
  plaintext in the cookie, wrong-key/tamper/expiry rejection, fail-closed.

## Phase 3 — proxy allowlist + the knowledge-guard gap (DONE, tested)

- `apps/admin/src/lib/adminProxyRoutes.ts` — the catch-all proxy is now
  **deny-by-default**: an explicit `(method, path)` allowlist mirroring
  `lib/api.ts` + `lib/knowledge.ts`, `'*'` matching exactly one id segment,
  traversal/empty segments rejected. A new `/admin/*` route is unreachable
  through the console until added here — the same inversion
  `apps/web/feed-proxy-routes.mjs` documents. The proxy now exports only GET and
  POST (the surface has no DELETE/PATCH). Spec: `adminProxyRoutes.test.ts`.
- **Fixed a gap Phase 1 opened:** `KnowledgeController` (`@Controller('admin/
  knowledge')`) was still on the bare `AdminGuard`, so the console's knowledge
  pages would 401 on the operator path while everything else worked. Switched it
  to the composed `AdminAccessGuard` (re-provided locally in `KnowledgeModule`,
  following that module's existing self-contained pattern). Any admin sub-surface
  added later must use `AdminAccessGuard`, never `AdminGuard` directly — that is
  the invariant that keeps both identities working everywhere.

## Phase 5 — nav restoration + source-level parity gate (DONE)

Audit finding: all six working surfaces from `apps/web/src/app/admin` were
migrated into `apps/admin` as real, wired pages, but four (`/ai`, `/cognition`,
`/orders`, `/system`) had been dropped from the sidebar while the nav instead
advertised eight not-yet-built modules (seven of which are `ModulePlaceholder`
stubs). The screenshots circulating are a design mockup, NOT the built app.

Fix (nav only — no page code touched): `components/shell/nav-config.ts` now
splits nav into `WORKING_NAV` (the six live surfaces, reachable) and
`SCAFFOLDED_NAV` (the seven stubs, rendered under a "Planned" heading with a
"Soon" marker so a placeholder is never mistaken for a feature). The seven
scaffolds are UNCHANGED and remain honest placeholders.

Source-level parity verified for all six: every page → `admin`/`knowledge`
client → `/api/proxy/*` (deny-by-default allowlist) → `AdminAccessGuard` →
service. Zero direct backend calls, zero credentials in client code, zero
fabricated data. Live updates: polling (8–30s) on five, SSE on knowledge
(`/api/stream/knowledge`) and the Sentinel orbit (`/api/stream`), both
forwarding `x-admin-token` + `x-operator-assertion`. Guard invariant holds:
`AdminController` and `KnowledgeController` on `AdminAccessGuard`; only
`admin/operator` login is `AdminTokenGuard` (it mints the assertion).

**Runtime parity is still UNPROVEN** — not run end-to-end (needs the migration
applied, `OPERATOR_JWT_SECRET`/`ADMIN_SESSION_SECRET`/`ADMIN_API_TOKEN` set, an
operator created, and free ports; the concurrent session holds the dev server +
Prisma engine DLL, which must not be disturbed).

**Remaining (Phase 6, blocked on runtime parity):** archive
`apps/web/src/app/admin`. Its deletion is currently staged by the concurrent
session and must stay uncommitted/reversible until a live page-by-page walk
passes.

## UI phase (2026-08-12) — operator-console visual upgrade, increment 1

Goal: make `apps/admin` resemble the intended TradeW Operator Console (dark
control-room, dense KPIs, prominent neural viz) WITHOUT fabricating data or
touching auth/proxy/guards. Governing rule baked into every new component: it
renders what it is handed and invents nothing — a card with no value shows "—",
a "live" dot is only green from a real read.

Delivered this increment:
- Shared primitives appended to `components/ui.tsx`: `MetricCard`, `StatusDot`,
  `StatusIndicator`, `SystemHealthList`, `ActivityFeed`, `SectionTitle`,
  `Sparkline` (built on the existing `admin-*` CSS + tokens; existing pages keep
  working and can adopt them).
- `components/UnavailableState.tsx` — the honest scaffold shell (intended layout
  as labelled empty skeletons + "Backend not connected"; successor to
  `ModulePlaceholder`).
- `components/SystemPipeline.tsx` — the reusable, data-driven cognition/system
  flow viz (Data → Perceptors → Features → Neural → Sentinel → Agents →
  Reasoning → Risk → OMS → Audit). Stages carry real metrics where the backend
  exposes them and render dashed "no source" nodes otherwise; extensible by
  passing more stages.
- `(console)/page.tsx` rewritten into the command center on real
  overview/health/cognition/agentStates/runs data.
- The 7 scaffolds now render structured `UnavailableState` shells (no fake data).

UI increment 2 (2026-08-12) — bespoke redesign of the five working pages, DONE:
`/cognition` is now a Neural & Perceptor Control Center with a new dedicated
`components/CognitionGraph.tsx` (interactive SVG node graph: perceptor domains →
four layers → proposals, every node/edge backed by a real field, edges animate
only on live signal) + a selected-node detail panel; `/ai` is an AI & Sentinel
command room (orbit + real agent-state distribution from `agents/states` +
telemetry); `/orders`, `/system`, `/knowledge` recomposed onto the shared
`MetricCard`/`StatusIndicator`/`SystemHealthList`/`ActivityFeed` system. All
real data paths, SSE, polling, and admin actions preserved verbatim; nothing
fabricated. api suite 324, admin 47, typechecks clean.

UI increment 3 (2026-08-13) — AI & Sentinel Command Center + Perceptors & Neural
rebuilt to the operator-console reference, real-data-only. Added THREE truthful
read-only backend aggregations (no schema/guard changes): `/admin/ai/by-model`
(GROUP BY provider+model), `/admin/api-calls/pulse` (per-minute request pulse),
`/admin/cognition/domains` (per-domain percept counts + derived rate) — each in
admin.service + admin.controller + client + proxy allowlist + allowlist test.
New reusable `Donut` in ui.tsx. `/ai` centres on the real `SentinelOrbit` (live
states, peer edges, SSE) + KPIs + model usage + system pulse + honest
"Unavailable" Sentinel subsystems. `/cognition` uses the real `CognitionGraph`
topology + domains panel + synapse distribution + recent percepts + live
propagation. **Proven live end-to-end**: logged in as the dev operator, both
pages render the real agent roster (market-technical/emotion/trap-safety/
compliance-audit/orchestrator), real postgres health, and honest `—`/
`Unavailable` where the dev DB is idle — zero fabricated values. The reference's
per-neuron MLP (Node 87/bias/firing) was deliberately NOT built — TradeW's
cognition is perceptors→4 aggregate layers→named synapses, shown truthfully.
Verified: api 324, admin 50, both typechecks clean, hygiene clean.

**Nav discrepancy found:** `(console)/layout.tsx` renders nav from
`components/AdminFrame.tsx` (its own list), NOT `components/shell/Sidebar.tsx` +
`nav-config.ts` — so the Phase-5 nav-restoration edits are inert. The live
AdminFrame nav links the 6 working pages but none of the 7 scaffolds. Reconcile
later (point AdminFrame at the shared nav-config, or add scaffolds to it). Visual fidelity is source-level only; not runtime-rendered
(the login gate + DB/secrets are the deferred runtime step). Real-data
opportunity noted: `/observability` and `/audit` scaffolds could be backed by
EXISTING endpoints (`health`, `api-calls/routes`, `audit`) without new backend —
deliberately left as honest shells pending the go-ahead, to respect "do not
implement the seven yet".

**Working-tree caveat (read before committing):** none of the Phase 1/2 changes
here touch `apps/web`. BUT a **concurrent session** has separately been doing the
UI half of this same consolidation — the session-start snapshot already showed
`apps/web/src/app/admin/*` **deleted** and a parallel `apps/admin/src/app/
(console)/*` UI built (untracked), plus a modified `apps/web/.../nav-config.tsx`.
That work is not ours and was not verified by us. So the two halves (their UI
migration, our auth layer) currently coexist uncommitted in one tree. This is
exactly what the pre-commit full-diff review is for: confirm the UI migration is
real and parity-checked before the web console's deletion is committed, rather
than assuming it.

### Manual steps before the operator path runs live
1. `npm run migrate:deploy -w @tradew/database` — creates the `OperatorAccount`
   table (migration written, NOT yet applied).
2. Set `OPERATOR_JWT_SECRET` on `services/api` and `ADMIN_SESSION_SECRET` on
   `apps/admin` (both `.env.example` documented).
3. `npm run operator:create -w @tradew/database -- <email> "<password>"`.

## The two traps for anyone extending this

1. **Never re-widen `AdminGuard`.** The whole point of the composed guard is that
   a second way in cannot alter the first. A branch added to `AdminGuard` to
   serve one client silently becomes a second auth mechanism for every admin
   route. Put new paths in `AdminAccessGuard`.
2. **No header confers trust.** There is deliberately no `X-Admin-Proxy` /
   trusted `X-Forwarded-*`. Any client that reaches the API can set any header,
   so a header can only carry a credential to verify — never, by its presence,
   an assertion the caller is trusted. Trust = the token (a secret) + the
   assertion signature (this process only) + the API not being internet-exposed.

## Related

- [[Plans/2026-08-12 - Admin consolidation auth design (operator boundary)]] — the reasoning and the ten questions.
- [[Decisions/2026-08-12 - Cognition network (perceptors + four layers)]] — `CognitiveProposal.resolvedBy` is one of the two attribution sites this protects.
- [[Gotchas/2026-08-12 - Nest DTOs must be declared above the controller]] — applies to `OperatorController`'s DTO too; it is declared above the class for this reason.
