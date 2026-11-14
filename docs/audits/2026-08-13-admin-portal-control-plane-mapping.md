# TradeW Admin Portal as Control Plane — Current State → Target State Architecture Mapping

**Prepared:** 2026-08-13
**Scope:** How the Admin Portal (`apps/admin`) should become the real control plane for TradeW's backend, services, AI agents, workers, and data pipelines — mapped against what actually exists in the repository today.
**Method:** every claim below is grounded in a file that was read for this report, not in what a README or planning doc asserts. Where a doc's claim and the code disagree, the code wins and the doc is flagged.

---

## 0. How to read this document

TradeW has an unusual amount of architecture documentation — a constitution (`TRADEW-OS.md`), a service-boundary doc (`ARCHITECTURE.md`), a dozen product-architecture pillar docs, a status doc, a production-readiness audit, and a separate, much more elaborate `ADMIN_PORTAL_BLUEPRINT.md`. These do not all agree with each other, and none of them fully agree with the code. This document does four things in order:

1. States what the reference architecture actually specifies for a control-plane Admin Portal (§1), and flags where the reference itself is internally inconsistent.
2. States what exists in the repository today, component by component, verified against source files (§2).
3. Reconciles the two into one target architecture, with the conflicts explicitly resolved rather than papered over (§3).
4. Gives the real-time execution path, dependency graph, migration phases, risks, rollback points, validation gates, and a final recommendation (§4–§10).

No code was written or modified to produce this report.

---

## 1. The reference architecture, as actually specified

### 1.1 The governing hierarchy

`TRADEW-OS.md` is explicit: it is the constitution, `ARCHITECTURE.md` is subordinate to it, and every pillar doc under `docs/product-architecture/` is subordinate to both. The binding rules for a control plane, pulled from the constitution:

- **One public ingress.** `apps/*` — including an admin app — reach the backend only through `services/api`. One place for auth, entitlement, rate-limiting, and audit (`TRADEW-OS.md` §2.2, `ARCHITECTURE.md` §1).
- **No AI-initiated trades, ever.** No AI service calls `trading-engine` or places an order, not even gated (`TRADEW-OS.md` §2.3).
- **AI systems are independent; orchestration lives at the ingress.** `services/tradew-ai` and `services/sentinel` never call each other directly. When a request needs both, `services/api` fans out and merges (`TRADEW-OS.md` §2.4).
- **One schema owner per table** (`TRADEW-OS.md` §2.5).
- **Everything premium is explainable** — reasoning, evidence, confidence, sources (`TRADEW-OS.md` §2.6, `EXPLAINABILITY.md`).
- **Don't build a distributed system before load demands it** — Redis Streams before Kafka, in-process before extracted service (`TRADEW-OS.md` §7, `ARCHITECTURE.md` §2.1, §3).
- **Incremental only, document-driven, never delete — archive** (`TRADEW-OS.md` §9).

### 1.2 What `ARCHITECTURE.md` says the Admin Portal is

`ARCHITECTURE.md` §2 describes `apps/admin` in one line: "🟡 internal ops console — KYC review, audit-log viewer, DLQ retry, user mgmt." It is one of three `apps/*`, all of which reach the backend only through `services/api` — the same ingress rule as the trader-facing web app. `services/auth` is explicitly *not* meant to be a day-one separate deployable; it's a contract boundary inside `services/api` until real load justifies extraction (§2.1). The agent contract every AI service is meant to expose is uniform: `POST /agents/:name/invoke`, internal-only, called only by `services/api` (`ARCHITECTURE.md` §4, restated in `AGENT-ARCHITECTURE.md` §5).

This is a modest, coherent picture: **one ingress, one agent contract, an admin app that is a thin ops console over that same backend** — not a separate system.

### 1.3 What `ADMIN_PORTAL_BLUEPRINT.md` says the Admin Portal is

This document describes something categorically different, and it is worth stating plainly rather than blending it into §1.2:

- A **separate repository** (`tw-admin`), a **separate Next.js app + separate Next.js API routes backend**, a **separate Postgres database** ("dedicated Postgres instance, read replica from main TradeW DB for some data"), and a **separate JWT/session auth system**, deployed to its own domain (`admin.tradew.io`).
- A full RBAC role system (`SUPER_ADMIN/SUPPORT/FINANCE/OPS/COMPLIANCE/CLIENT`), mandatory MFA (TOTP/WebAuthn) for privileged roles, IP allow-listing, 7-year immutable audit retention with cryptographic export signatures.
- A Stripe-backed subscription/billing/invoicing module owned by the admin app.
- A **"Living AI Headquarters"** — a React-Three-Fiber 3D scene with a rotating holographic globe and six departmental "rooms" (Engineering, Support, Finance, Security, Compliance, AI Brain), each populated by animated 3D avatars representing "agents," with a **live screen-capture/WebRTC viewer** — click an agent, see a real-time video/canvas stream of literally what that agent is looking at, mouse position and all.
- A ten-phase, 19+ week build plan culminating in a plugin/webhook extensibility platform.

**This document conflicts with the constitution on its own terms, not just in tone:**

1. **It violates "one public ingress."** A separate admin repo with its own database and its own auth is a second backend, not a console in front of `services/api`. `TRADEW-OS.md` §2.1 calls duplicate infrastructure "a violation, not a style choice," and this is the canonical example of what that rule forbids.
2. **Its "agent" model does not describe TradeW's agents.** TradeW's actual agents (confirmed in §2.4 below) are stateless, single-responsibility, per-request LLM analysis functions — a Confidence Engine, a Risk Intelligence scorer, an Orchestrator that synthesizes text. None of them have a "screen." None of them are long-running processes a camera could point at. The blueprint's Engineering/Support/Finance "rooms" with named agents at desks doing tickets and pull requests describe an *internal AI-workforce product* (autonomous agents performing company operations like a human would) — a different product than TradeW, which is a trading platform with analysis agents. Nothing in `TRADEW-OS.md`, `AGENT-ARCHITECTURE.md`, `SENTINEL.md`, or `TRADEW-AI.md` describes an agent with a UI, a desk, or a screen to capture. This section reads as a generic "AI-ops command center" template, not a TradeW-specific design.
3. **It duplicates subscription/billing state** that `SUBSCRIPTIONS.md` and the real `Plan`/`Subscription`/`PlanGrant` Prisma models already own inside `packages/database` (owned by `services/api`) — a second billing system in a second database is exactly the "two disconnected credential/data surfaces" pattern `ARCHITECTURE.md` §1.5 says was already found once and fixed.
4. **Nothing in it has been built**, and nothing in the real admin app (`apps/admin`, described in §2.2) takes any step toward it — no 3D dependency, no separate repo, no separate database, no RBAC roles, no MFA.

**Resolution used throughout the rest of this document:** `ADMIN_PORTAL_BLUEPRINT.md`'s *operational content* (user management, subscription oversight, agent/model health monitoring, immutable audit logging, alerting, content/knowledge management, system monitoring) is legitimate and worth building. Its *architecture* (separate repo/DB/auth) and its *3D "Living Headquarters"/screen-viewer* concept are not compatible with the constitution and are not recommended. Where this document's migration plan below draws on the blueprint, it draws only on the module list in §4 of that document, re-plumbed through `services/api` as the single ingress, inside the real `apps/admin`.

### 1.4 What the pillar docs specify for AI orchestration (the part the Admin Portal must observe/control)

- **Two independent runtimes**: `services/tradew-ai` (Research: AI Researcher router + Company/News/OptionChain/Technical/Strategy/Portfolio/Learning agents) and `services/sentinel` (Safety Nets: Market&Technical, Emotion, Trap&Safety, Compliance&Audit agents synthesized by one Orchestrator). Neither calls the other; `services/api` composes both when a request needs it (`AGENT-ARCHITECTURE.md` §3, `TRADEW-ASSISTANT.md` §6).
- **n8n orchestrates, never reasons** — background, multi-step, non-user-triggered sequences only (`N8N-WORKFLOWS.md`).
- **Sentinel's 12 intelligence modules** (Market Intelligence, Strategy Engine, Historical Intelligence/pgvector, News Intelligence, Learning Intelligence, 8-factor Risk Intelligence, Confidence Engine at a configurable threshold, Market Timeline, a 12-state Market State Machine, non-directive vocabulary enforcement, EOD analysis, continuous recalibration) are the concrete thing an "Engine Health"/"Reasoning Inspector" admin surface should actually be observing (`SENTINEL_MASTER_PLAN.md`).
- **Observability target, cheapest-leverage-first**: structured JSON logging → Prometheus/Grafana → one Slack alert webhook → OpenTelemetry tracing → Grafana Loki (`ARCHITECTURE.md` §8) — explicitly *not* a day-one requirement, explicitly *not* ELK/Kafka/Kubernetes until load demands it.

---

## 2. Current state, verified component by component

Every item below was confirmed by reading the actual source file(s), not the surrounding README prose. "Real" = working logic; "Stub" = scaffolded but not wired to real data or with explicit placeholder behavior; "Missing" = does not exist.

### 2.1 `apps/admin` — the Admin Portal frontend

**Real:**
- Next.js app, route group `(console)`, 8 module routes + dashboard + login (`apps/admin/src/app/(console)/*`, `apps/admin/src/components/shell/nav-config.ts`).
- **Auth is real and double-gated**, and it is the one part of the console that is fully wired end-to-end: `middleware.ts` checks a signed, expiring session cookie (`session.ts`, HMAC-SHA256 over `ADMIN_API_TOKEN` via Web Crypto, 12-hour TTL) at the Edge; every actual data call from a Route Handler re-attaches the real `ADMIN_API_TOKEN` server-side (`lib/adminApi.ts`) and is re-checked by `services/api`'s `AdminGuard`. The token itself never reaches the browser.
- `ViewAsTraderButton` — a deliberate passthrough link to `apps/web`'s real `/sentinel` route in a new tab, not a re-implementation (`components/shell/ViewAsTrader.tsx`). This is a good pattern: it avoids the duplicate-UI trap the 3D blueprint's screen-viewer would have created.

**Stub — this is the headline finding:**
- **All 8 module pages** (`Engine Health`, `Knowledge Management`, `Agent Management`, `Reasoning Inspector`, `TradingView Rule Management`, `Learning Platform`, `Observability`, `Audit & Compliance`) render the identical `ModulePlaceholder` component, which literally says "Not built yet... scaffolded (routing, auth, nav) but not wired to live data." Zero of the eight render a single real number. None of them call `lib/adminApi.ts`.
- No 3D anything. No React Three Fiber dependency, no rooms, no globe, no screen viewer, no WebSocket client. `ADMIN_PORTAL_BLUEPRINT.md`'s §5–§7 have zero code footprint here, confirming §1.3's conclusion that this part of the reference was never pursued — correctly, per the conflict analysis above.

**The single most important, most actionable fact in this report:** the gap between "Admin Portal shows nothing" and "Admin Portal is a real control plane" is *not* a large backend build — §2.2 shows `services/api` already has working endpoints for several of these eight modules. Most of the work is wiring an existing frontend shell to already-existing backend routes, not inventing either side from scratch.

### 2.2 `services/api` — the intended single ingress

**Real and substantial** (NestJS, `services/api/src/`): Auth (JWT, refresh rotation, Google OAuth + phone OTP, full audit-logged), Entitlements (capability/quota gating, `@Global`), Instruments/MarketData (read-only over `Quote`/`Instrument`), Crypto/Forex/US-stocks proxies, News, Broker (Dhan OAuth linkage, hardened per `SECURITY-AUTHORIZATION.md`), Mail/SMS, Discipline (session-limit rules), **Sim** (a complete in-process paper-trading matching engine — order/position/settlement/portfolio/holdings/trade-history/performance services), Sentinel client modules (three separate HTTP clients to `services/sentinel`), Learning proxy, Knowledge (read-only Obsidian-vault viewer + SSE, admin-gated), Notification (local CRUD only), Telemetry (`@Global`, event bus feeding SSE), **Admin** module, **Control** module, Common (leader election for singleton background jobs), Prisma.

**The `Admin` module already has real, working endpoints an Admin Portal frontend could call today:**
`GET /admin/overview`, `/admin/health`, `/admin/agents/states` (backed by a hardcoded agent list, not a live registry), `/admin/agents/runs` + `/admin/agents/runs/:runId`, `/admin/audit`, `/admin/api-calls` (+ `/timeseries`, `/routes`), `/admin/ai/calls` (+ `/by-agent`, `/timeseries`), `/admin/users`, `POST /admin/users/set-admin`, and a working SSE stream at `GET /admin/stream` pushing `activity`/`run`/`ai` events plus heartbeat off a plain Node `EventEmitter`. This is real telemetry infrastructure sitting unused by the frontend.

**The `Control` module is a deliberately honest, narrow stub for a *future* control plane:** `/control/*` is Ed25519-signed (a third, separate auth scheme from admin-session and `AdminGuard`), and its own code says outright what doesn't exist yet — mutating routes like `agents/:id/stop`, `system/pause`, `trading/live/authorize` return explicit `501`s with messages including *"No agent runtime is instantiated in TradeW Core yet"* and *"No live execution path exists in TradeW Core."* This is the codebase telling you, in its own words, exactly where the control plane stops today.

**Missing, relative to the reference:**
- `POST /agents/:name/invoke` — the uniform agent-invoke contract specified in `ARCHITECTURE.md` §4 and `AGENT-ARCHITECTURE.md` §5 **does not exist anywhere in the repository.** Sentinel is called via bespoke per-feature REST routes (`/observe`, `/explain`, `/intelligence/reason`, `/learning/*`) instead.
- **No client/orchestration code at all** to `services/trading-engine`, `services/tradew-ai`, `services/market-data`, `services/notification`, or `services/analytics`. Order matching is a local simulator inside `services/api`, not a call to `trading-engine`.
- No impersonation ("view as trader" as a real admin action, as opposed to the frontend's link-out pattern) — not found.
- No genuine rules-engine admin surface — the only "rules" endpoints (`/sentinel-intelligence/rules*`) are user-facing, entitlement-gated, not `AdminGuard`-protected.
- Audit logging is real but narrow: only `AuditEvent` (auth events) and two admin actions (`admin.granted`/`admin.revoked`) are written to an audit table; it is a plain Postgres table with **no immutability enforcement** (no triggers, no append-only constraint). Orders, Sentinel calls, and control-plane actions land in `ApiCallLog`/`AiCallLog`/`AgentActivity`/`AgentRun` — telemetry tables, not an audit trail.
- No RBAC roles beyond a single `User.isAdmin` boolean. No MFA. No IP allow-listing.
- `services/auth` folder is confirmed, in its own README, to be a non-deployable contract placeholder — consistent with `ARCHITECTURE.md` §2.1's design intent, not a gap.

### 2.3 `services/sentinel` — the one AI runtime that is substantially real

Roughly 150+ files, real NestJS service. Verified present and functioning, with file paths: Confidence Engine (`src/confidence/confidence.engine.ts` — real 7-factor weighted scoring; **threshold is 70%, not the Master Plan's 85%**, changed deliberately per an in-code comment because confidence is now one of four gate conditions), Market State Machine (`src/state-machine/state-machine.service.ts` — real 12-state enum + legal-transition graph, per-session, matches spec), Historical Intelligence / pgvector similarity (`src/brain/historical-similarity.service.ts` + `prisma-memory-store.ts`, real cosine search against `MemoryRecord.embedding`), News Intelligence (`src/intelligence/news-intelligence.service.ts`), 8-factor Risk Intelligence (`src/intelligence/risk-intelligence.service.ts` — matches spec's 8 factors exactly), Sentinel Orchestrator (`src/orchestrator/sentinel-orchestrator.service.ts`, ~500 lines, the only emitter of user-facing text, applies a 4-condition publication gate), non-directive vocabulary enforcement (`src/vocabulary/vocabulary.ts`, regex rewrite + forbidden-term probe), Strategy Engine, Market Timeline Engine, EOD review, continuous recalibration (`src/improvement/`).

**Deviations from spec worth surfacing to an admin "Reasoning Inspector":** there are **two overlapping reasoning/orchestration stacks** — the primary Orchestrator above, and a second, largely independent citation-grounded RAG engine at `src/sentinel-intelligence/` (its own agent registry, its own controller, its own gate). The primary orchestrator only reads the second stack's *cached* output; it never calls it synchronously. This is a real architectural seam an "Agent Management"/"Reasoning Inspector" admin surface needs to show as two systems, not one, or it will misrepresent what's actually running.

Sentinel's ingress is **not** the uniform `/agents/:name/invoke` contract — it's a conventional multi-controller REST API (`/observe`, `/explain`, `/brain/search`, `/strategies`, `/timeline`, `/market-close/review`, `/improvement/run`, plus separate `intelligence/*`, `learning/*`, `reasoning/*` controllers), all behind a `ServiceTokenGuard`.

`agents/sentinel/definitions.json` is real but thin: 5 agents (`market-technical`, `emotion`, `trap-safety`, `compliance-audit`, `orchestrator`), each with name/description/`systemPromptId` (no actual prompt text — resolved elsewhere, not found), empty `allowedTools: []`, plain-English guardrails. It documents the roster; it does not drive the runtime the way `ARCHITECTURE.md` §4 implies a declarative-definitions-drive-the-runtime model should.

### 2.4 `services/tradew-ai` — 0% built

Exactly one file exists: `README.md`. It says so itself: "this folder itself is still README-only... the real logic already exists in `packages/ai-core` — not here." No controllers, no services, no `package.json`, no agent implementations. `agents/tradew-ai/` is likewise a one-line "Status: empty" README, no definitions file. The entire Research pillar — AI Researcher router, Company/News/Option Chain/Technical/Strategy Builder/Portfolio Insights/Learning Assistant agents — is design-only. The one adjacent piece of real code is `apps/web/src/lib/assistant/` (`router.ts`, `commands.ts`, `domain-guard.ts`) — a deterministic, LLM-free navigation-intent router living in the *frontend*, which explicitly defers "analysis intent" (the part that would call `services/tradew-ai`) to a future phase in its own type definitions.

### 2.5 `services/trading-engine` — documentation asserts a system that is not in this checkout

The README describes, in the present tense, a hardened, real Python/Flask engine: HMAC-SHA256-verified TradingView webhook intake, an order poller, PnL tracking, a mock paper broker. A repository-wide search found **none of these files anywhere** — not in `services/trading-engine`, not in `archive/`. The only `.py` file in the entire repo is an unrelated `scripts/dhan_algo_strategies.py`. The README's own final line contradicts its own opening: "Status: not yet populated. Waiting on execution approval." **This is the one place in the repo where the documentation's confident tone and the actual code state are flatly incompatible**, and it matters specifically for this report because `ARCHITECTURE.md` §3 assumes `trading-engine`'s webhook-and-order-execution path already exists and just needs to be made internal-only. It doesn't exist at all yet — `services/api`'s own paper-trading simulator (§2.2) is the only order-execution logic in the system today.

### 2.6 `services/market-data`, `services/notification`, `services/analytics`

- `services/market-data`: real NestJS service (Dhan WebSocket ingestion, feed manager, tick pipeline, instrument registry, scrip-master sync), containerized, wired into the production compose stack, correctly documented as a singleton by design (Dhan allows 5 connections/account).
- `services/notification`, `services/analytics`: both honestly self-documented as "design-only, no code exists yet" — no `src/` directory for either.

### 2.7 `packages/database` — the one genuinely unified piece of the target architecture

Single Prisma schema, 44 models, `postgresqlExtensions` with the `vector` extension real and in use (`MemoryRecord.embedding`, `ConceptNode.embedding`). This is the part of `TRADEW-OS.md` §2.1 ("extend the existing Brain, don't build a second memory system") that actually held. Confirmed **absent**, despite being assumed by one reference doc or another: an `AuditLog` model with immutability guarantees (only `AuditEvent`, a plain mutable table, exists), any `AdminUser`/`AdminSession`/`Role` model (admin-ness is one boolean, `User.isAdmin`), any `AgentSnapshot`/`AgentScreen` model, any `FeatureFlag`/`SystemConfig` model, any `IncidentLog`/`ModelMetric` model.

### 2.8 Infrastructure and observability

- `infra/docker/docker-compose.yml` (dev) is two services: Postgres + pgAdmin. `docker-compose.prod.yml` is real and detailed — 8 services (caddy, web, api, sentinel, market-data, live-feed, migrate, postgres, redis) — but **`apps/admin` is not a service in either compose file**, and **Redis is provisioned but not consumed by any application code** (confirmed by an explicit in-file comment).
- `infra/k8s/` is empty by design ("don't build this before docker-compose proves the services work together"). `infra/terraform/` is real, substantial HCL (~1,240 lines) but its own README states it has never been applied against a real AWS account.
- No event bus of any kind — zero Redis Streams, zero Kafka, zero `EventEmitter2` usage anywhere in the codebase. Rate limiting explicitly runs on in-process memory today, with Redis-backed limiting named as a "Stage 1 prerequisite" not yet built.
- No observability stack — zero hits for Prometheus/Grafana/OpenTelemetry/Winston/Pino across the entire repo. What exists instead, and is genuinely good: structured, redaction-safe security event logging (`services/api/src/common/security-log.ts`) and in-app telemetry tables consumed by the Admin module's own endpoints and SSE stream (§2.2) — this is real, but it is bespoke, not the Prometheus/Grafana/OTel target `ARCHITECTURE.md` §8 describes.
- The 2026-08-10 production-readiness audit (`docs/PRODUCTION-READINESS.md`) found and fixed six deployment-breaking defects (Docker builds that failed outright, a container that bound to `127.0.0.1` and was unreachable behind the proxy, Sentinel's entire citation corpus silently excluded from its own image) and confirmed the app layer performs well under load (500 concurrent users, single-digit-millisecond p95 for most flows). It also states plainly: **"Nothing has ever been deployed"** to a real host, the platform is single-VM/single-Postgres with a 24-hour backup RPO, there is no alerting, and the Dhan market-data token expires daily and is refreshed by hand.

---

## 3. Reconciled target architecture

Given §1's conflict and §2's evidence, the target is: **`apps/admin` becomes a real control-plane frontend over the real backend that already exists, using the endpoints `services/api`'s Admin module already exposes, extended — not replaced — to cover the gaps.** No second repository, no second database, no second auth system, no 3D command center. This is both the constitutionally-correct answer (`TRADEW-OS.md` §2.1/§2.2) and the cheapest path to value, because §2.1/§2.2 show the frontend-to-backend gap is mostly wiring, not invention.

### 3.1 Target component responsibilities

| Layer | Owns | Current state | Target state |
|---|---|---|---|
| **`apps/admin` (control-plane UI)** | Rendering live operator views, issuing control actions as a signed request | 8 pages, all `ModulePlaceholder`; auth shell real | Each page calls `lib/adminApi.ts` against real `services/api` endpoints; write actions go through `/control/*`'s signed envelope once real handlers exist behind it |
| **`services/api` — `AdminModule`** | Read surfaces: overview, health, agent state/run history, audit, API/AI call telemetry, user list | Real, working, unused by frontend | Same, wired to `apps/admin`; extended with real audit coverage (orders, Sentinel calls, control actions) and a live (not hardcoded) agent registry once an agent runtime exists |
| **`services/api` — `ControlModule`** | The signed, mutating control-plane ingress: stop/restart an agent, pause the system, authorize live trading | Auth scheme real; every mutating handler is an honest `501` | Real handlers, added one at a time, each gated behind the thing it controls actually existing (you cannot "stop an agent" before an agent runtime exists — see Phase ordering, §6) |
| **`services/sentinel`** | The one AI runtime with real state to monitor/control today | 70–80% of the Master Plan real; two overlapping orchestration stacks | Expose the orchestrator's internal state (confidence breakdown, active state-machine state, publication-gate reasons, which of the two reasoning stacks answered) through a dedicated internal admin-only route `services/api` can read — this is what makes "Reasoning Inspector" and "Engine Health" real instead of placeholders |
| **`services/tradew-ai`** | The Research pillar runtime — does not exist | 0% | Out of scope for "make the Admin Portal real" — an admin console cannot monitor a runtime that isn't there. Flagged as a prerequisite for the "Agent Management" module ever showing more than Sentinel |
| **`services/trading-engine`** | Real-money execution — does not exist; `services/api`'s Sim module is the de facto order engine today | 0% (contradicts its own README) | Same scoping note: `/control/trading/live/authorize` cannot become real until this exists. Until then, the Admin Portal's honest job is to expose the Sim engine's state (it already emits `AgentRun`/`ApiCallLog`-style telemetry `services/api` can read) |
| **`packages/database`** | Single schema, single owner (`services/api`) | 44 models, no admin-specific models | Add narrowly-scoped models only where a real feature needs one: an append-only `AdminAuditLog` (DB-level `REVOKE UPDATE, DELETE`, not just an app-level convention) is the one addition every module in §4 below needs and none currently has |
| **Observability** | Metrics/logging a control plane reads | Bespoke telemetry tables + SSE; no Prometheus/Grafana | Cheapest-leverage-first per `ARCHITECTURE.md` §8: the existing telemetry tables and SSE stream are enough to make Engine Health/Observability real *today*; Prometheus/Grafana is a later addition, not a blocker |
| **Event bus** | Cross-service domain events | None | Not needed for the Admin Portal work in §6. Redis is already provisioned in prod compose; wiring it for rate-limiting (already flagged as a known gap) is a prerequisite for horizontal scaling, not for the Admin Portal |

---

## 4. Real-time execution path — current vs. target

### 4.1 Today, tracing an actual admin action end to end

An operator opens `apps/admin/(console)/agents`. What happens:

1. **Admin action**: none possible — the page is `<ModulePlaceholder>`. There is no button, no fetch, no data.
2. **Control plane**: `services/api`'s `AdminModule` has `GET /admin/agents/states` and `GET /admin/agents/runs` ready and correct, but nothing calls them.
3. **Orchestration → AI agents/services**: `admin.service.ts`'s `KNOWN_AGENTS` map is hardcoded display text, not a query against a live agent process — there is no agent runtime to query in the first place (`control.controller.ts` says so directly).
4. **Tools/data/backend**: `services/sentinel` is the only real backend process with agent-shaped state, reachable only via its own bespoke REST routes, not through anything `AdminModule` calls today.
5. **Execution**: N/A — no mutating admin action has a real handler (`ControlModule` returns 501 for all of them).
6. **State/events**: `TelemetryModule`'s `EventEmitter` and `AgentActivity`/`AgentRun`/`ApiCallLog`/`AiCallLog` tables are populated by real traffic (Sentinel calls, API calls) — this part works.
7. **Persistence/memory**: Postgres + pgvector, real, via Prisma — this part works.
8. **Monitoring/audit**: `AuditEvent` covers auth events only; most activity is telemetry, not audit; nothing is immutable.
9. **Admin Portal feedback**: nothing — the loop never closes because step 1 has no code.

**Honest summary of the current lifecycle: steps 6 and 7 are real. Steps 1–5 and 9 are not connected to each other at all.** The single break that matters most is between step 1 (frontend) and step 2 (backend) — everything downstream of step 2 for *read* operations already works.

### 4.2 Target lifecycle (Phase 1–2 scope, §6)

1. **Admin action** — operator opens `/agents` in `apps/admin`; page Server Component calls `adminApi('/admin/agents/states')` and `/admin/agents/runs` (already-real endpoints).
2. **Control plane** — `AdminGuard`-protected `AdminModule` routes serve the request (already real).
3. **Orchestration** — for Sentinel-backed state, `AdminModule` is extended to call a new internal `services/sentinel` route (e.g. `GET /internal/orchestrator/status`) exposing confidence breakdown, state-machine state, publication-gate reasons — net-new, small, additive to the existing `ServiceTokenGuard` pattern already used for every other Sentinel route.
4. **AI agents/services** — `services/sentinel`'s real orchestrator and sub-services answer (already real; just not exposed to admin yet).
5. **Tools/data/backend** — Prisma/Postgres/pgvector (already real).
6. **Execution** — for read-only Phase 1–2 scope, there is no mutation; write actions (agent enable/disable, confidence-threshold override) are Phase 3+ and require a `ControlModule` handler that actually changes a config value Sentinel reads — net-new but small, since Sentinel's confidence threshold and strategy toggles already exist as service-level state (`POST /strategies/toggle` already exists as a Sentinel-internal route today).
7. **State/events** — every admin read and write is itself recorded (see §4.3).
8. **Persistence/memory** — same Postgres instance, new `AdminAuditLog` table (append-only).
9. **Monitoring/audit** — the write goes to the new immutable table, not `AuditEvent` (which stays scoped to end-user auth events) or the mutable telemetry tables.
10. **Admin Portal feedback** — the page re-fetches (or, once the existing `/admin/stream` SSE is wired into the frontend, updates live) and shows the new state.

### 4.3 The audit gap is structural, not cosmetic

Because `AuditEvent` is a plain table and telemetry tables have no immutability guarantee, **every admin action taken today, if the placeholders were filled in without first adding real audit infrastructure, would be unauditable in the way `ADMIN_PORTAL_BLUEPRINT.md` §3.3 (correctly) says an admin action must be.** This is why the target lifecycle above inserts a new `AdminAuditLog` model before any write-capable admin module ships — it is the one piece of the aspirational blueprint's data model that is not optional, and it's a small, well-scoped addition (one Prisma model + one interceptor), not a redesign.

---

## 5. Dependency graph (target)

```
apps/admin ──────────────► services/api (AdminModule, ControlModule)
                                   │
                                   ├──► packages/database (Prisma; +AdminAuditLog)
                                   │
                                   ├──► services/sentinel  (existing REST routes +
                                   │      new internal /internal/orchestrator/status)
                                   │
                                   ├──► services/market-data (read-only; NOT wired
                                   │      today — Phase 2 addition for Observability page)
                                   │
                                   ├──► services/tradew-ai   (does not exist —
                                   │      Agent Management page can only ever show
                                   │      "not running" for this runtime until built)
                                   │
                                   └──► services/trading-engine (does not exist —
                                          /control/trading/live/authorize stays a
                                          501 until this is real; Sim module's own
                                          state is what Observability shows instead)

apps/web ─────────────────► services/api  (unchanged, already the sole ingress)

services/sentinel ──► packages/database, packages/ai-core   (unchanged)
services/api      ──► packages/database, packages/ai-core (telemetry only)

Explicitly no arrow: apps/admin ──X──► packages/database directly
Explicitly no arrow: apps/admin ──X──► services/sentinel directly
Explicitly no arrow: services/tradew-ai ──X──► services/sentinel (moot: tradew-ai doesn't exist)
```

The rule this preserves: `apps/admin` is exactly as constrained as `apps/web` — it is a client of `services/api`, never a second ingress. This is the direct fix for `ADMIN_PORTAL_BLUEPRINT.md`'s architectural conflict (§1.3).

---

## 6. Migration phases

Ordered by dependency and by the constitution's own "incremental only, no big-bang commits" rule (`TRADEW-OS.md` §9). Each phase is independently shippable and leaves the platform in a working state. Change-type is called out per phase, since the task explicitly separates architectural, backend, AI/agent, Admin Portal, database, infrastructure, and frontend changes.

**Phase 0 — Foundation** *(database change + backend change; no frontend, no AI/agent change)*
- Add `AdminAuditLog` Prisma model: append-only (DB-level `REVOKE UPDATE, DELETE` in a migration, matching the pattern `ADMIN_PORTAL_BLUEPRINT.md` §3.3 specifies, applied to the *real* schema instead of a second one), write interceptor on every `AdminGuard`/`ControlGuard` route.
- Migration-drift CI (already exists per `PRODUCTION-READINESS.md` §4) covers this automatically.
- Rollback: drop the table/migration; nothing downstream depends on it yet.

**Phase 1 — Wire the four read-only modules that already have real backend endpoints** *(frontend / Admin Portal change only)*
- `Engine Health`, `Agent Management` (states/runs only, no actions), `Audit & Compliance`, and a first cut of `Observability` (API/AI call metrics) — call the already-real `/admin/*` endpoints from `lib/adminApi.ts`.
- No backend change. Rollback: revert to `ModulePlaceholder`; zero backend risk.
- Validation gate: every number shown must be traceable to a real Prisma row or telemetry event — no mock data, per the codebase's own standing rule (confirmed by `ModulePlaceholder`'s own comment).

**Phase 2 — Extend `AdminModule` for the two modules with no backend surface yet** *(backend change + AI/agent-facing change (new Sentinel route) + Admin Portal change)*
- `Observability`: add read-only proxies to `services/market-data`'s health and `services/sentinel`'s `/health` (the latter is already probed by `control.controller.ts` — reuse that pattern) so Dhan-bridge/pgvector/Redis status is real, not aspirational.
- `Reasoning Inspector`: add the new internal Sentinel route from §4.2 step 3, exposing orchestrator internals (confidence breakdown, state-machine state, gate reasons, which reasoning stack answered — surfacing the two-stack seam from §2.3 honestly rather than hiding it).
- Rollback: the new route is additive; removing it only degrades these two pages back to Phase-1 state.

**Phase 3 — First real write actions** *(backend change + AI/agent-facing change + Admin Portal change; depends on Phase 0)*
- `Agent Management`: wire Sentinel's already-existing `POST /strategies/toggle` through a new `ControlModule` handler (replacing its current 501) — this is the one mutating action in the entire target that has a real thing to mutate today.
- Every write goes through `AdminAuditLog` (Phase 0) from day one.
- Validation gate: a strategy toggle in the admin UI must be observably reflected in Sentinel's own behavior within one polling cycle, verified manually before this phase closes.

**Phase 4 — `Knowledge Management` and `Learning Platform` modules** *(Admin Portal / frontend change only, same pattern as Phase 1)*
- Both already have real backend data to read (`services/api`'s `KnowledgeModule` — Obsidian vault viewer/SSE — and Sentinel's `learning/*` routes) that simply isn't surfaced in `apps/admin` today; done later because it's lower-priority for "control plane," not because it's harder.

**Phase 5 — `TradingView Rule Management`** *(backend change + Admin Portal change; scope decision required before starting)*
- Today's only "rules" surface is user-facing (`/sentinel-intelligence/rules*`). Building a real admin rules module means either promoting that surface to also be `AdminGuard`-reachable with an approval workflow (small) or building the versioning/rollback UI the module's own nav description promises (larger) — scope this explicitly before starting; do not let "Rule Management" quietly become the biggest phase by default.

**Phase 6 — Everything gated on a runtime that doesn't exist yet** *(architectural change + AI/agent change + backend change — the largest category, deliberately last)*
- Full `Agent Management` (enable/disable a *tradew-ai* agent), `/control/agents/:id/stop`, `/control/trading/live/authorize` as real handlers — **all explicitly blocked** until `services/tradew-ai` and/or `services/trading-engine` exist as real runtimes. Do not build admin UI for controlling a process that isn't running; that produces exactly the "well-behaved no-op that looks healthy" failure mode `PRODUCTION-READINESS.md` §1's defect 6 already burned the team once on.

**Infrastructure change, parallel track, no phase dependency:** add `apps/admin` as a real service in `infra/docker/docker-compose.prod.yml` (currently absent — see §2.8) before any phase above is considered production-shippable; this is infrastructure work, independent of the phases, but blocking for deployment regardless of which phase is "done."

**Explicitly out of scope, permanently, unless the architecture itself changes:** the 3D command center, the WebRTC agent-screen viewer, a separate `tw-admin` repository/database/auth system, RBAC roles beyond what `services/api`'s existing `isAdmin` boolean + capability system can reasonably be extended to cover. If a genuine business need for full RBAC (SUPER_ADMIN/FINANCE/COMPLIANCE as distinct roles with distinct permissions) emerges, that's a real, addable extension of `User`/`AdminGuard` — a `Role` enum and a permissions table — inside the existing schema, not a reason to stand up a second system.

---

## 7. Risks

- **Building admin UI for a runtime that isn't real** (tradew-ai, trading-engine) is the top risk — it reproduces the exact "healthy-looking no-op" failure the 2026-08-10 audit already found once with Sentinel's citation corpus. Every phase above is ordered specifically to avoid this.
- **Audit-log immutability is currently zero.** Shipping any write-capable admin module before Phase 0 lands means every admin action taken is deniable/editable after the fact — a compliance and security regression, not just a missing feature.
- **The hardcoded `KNOWN_AGENTS` list will drift** from whatever Sentinel actually runs the moment either side changes, unless Phase 2's internal status route becomes the actual source of truth and the hardcoded map is deleted, not left running in parallel.
- **Two overlapping Sentinel reasoning stacks** (§2.3) make "Reasoning Inspector" genuinely hard to build correctly — a naive implementation will show only the primary orchestrator and silently omit the `sentinel-intelligence/` stack's contribution, misrepresenting the system exactly when an operator needs an accurate picture most (e.g., debugging why a user got a specific piece of reasoning).
- **Rate limiting and Sentinel are both single-process today** (`PRODUCTION-READINESS.md` §5); an admin control action that assumes it's talking to "the" running instance will behave unpredictably the day a second replica exists. Any `ControlModule` handler that mutates in-process state needs the same `JobLease`-style leader-awareness already used for the matching engine, not a new ad hoc assumption.
- **Redis is provisioned but unconsumed.** If Phase 2+ work casually starts depending on Redis for anything (e.g., caching admin queries), it's the first real consumer and needs the same deliberate wiring pass the rate-limiter is already waiting on — don't let two different features both become "first to actually use Redis" independently.
- **`services/trading-engine`'s documentation actively overstates its state.** Anyone planning future phases from the README alone (rather than verifying the code, as this report did) will plan against a system that isn't there.

---

## 8. Rollback points

Each phase in §6 is designed to be independently revertible:

- **Phase 0** — a single migration; rollback is `prisma migrate resolve` + drop table, with zero application-code dependents yet.
- **Phase 1** — pure frontend; rollback is reverting the page components to `ModulePlaceholder`. No backend or data risk either direction.
- **Phase 2** — the new Sentinel internal route is additive (new controller method, doesn't touch existing routes); rollback removes the route and the two admin pages degrade gracefully to a "not available" state rather than erroring, if the frontend is written defensively (validation gate below).
- **Phase 3** — the new `ControlModule` handler replaces one specific 501; rollback reverts that one handler. Because the underlying Sentinel `/strategies/toggle` route is untouched, no in-flight Sentinel state is affected by rolling the admin action back.
- **Phases 4–6** — each module is independent of the others by construction (separate pages, separate backend routes); a bad phase can be reverted without affecting modules shipped in earlier phases.

---

## 9. Validation gates

Before any phase is considered done:

1. **No mock data ever renders.** This is not a style preference — it's the codebase's own explicit, already-enforced rule (`ModulePlaceholder`'s own comment). A gate that must be checked by reading the diff, not just by a passing test: every number on a page traces to a real query.
2. **Every write action produces exactly one `AdminAuditLog` row**, verified by test, before that action's UI ships (Phase 3 onward).
3. **Every new internal service-to-service route is behind the same `ServiceTokenGuard`/constant-time-compare pattern already used by every other Sentinel route** — no new, weaker auth scheme introduced for admin convenience.
4. **Docker build + compose config validation stays green** (already a CI gate per `PRODUCTION-READINESS.md` §4) — and `apps/admin` needs to actually be added to `docker-compose.prod.yml`, which it currently is not, before any phase here is considered production-shippable.
5. **A module is not marked "done" while it depends on a non-existent runtime.** Concretely: `Agent Management` cannot claim "enable/disable agents" as done while `services/tradew-ai` doesn't exist — the gate is per-capability, not per-page.
6. **Manual verification that a control action has an observable effect** (Phase 3's strategy-toggle gate is the template) before trusting any future write action's correctness to tests alone, given the repo's own admitted zero-to-recently-added test coverage history.

---

## 10. Final recommendation

**Build the control plane as an extension of what already exists, not as the separate `tw-admin` system the blueprint describes.** The evidence is unambiguous: `services/api` already has a working `AdminModule` with real telemetry, real audit-lite logging, and a real SSE stream; `apps/admin` already has a working, correctly-designed double-gated auth layer and an honest placeholder pattern that refuses to show fake data. The only thing missing between those two real halves is the wiring — eight `fetch` calls' worth of frontend work for the modules covered in Phase 1, not a new product.

The `ADMIN_PORTAL_BLUEPRINT.md` document should be treated as **superseded reference material, not a target** — its module *list* (user management, subscription oversight, agent/model health, immutable audit, content management, system monitoring) is sound and is exactly what §6's phases build toward; its *architecture* (separate repo, separate database, separate auth, 3D command center with agent screen capture) actively contradicts the platform's own constitution and should be explicitly retired rather than left as ambiguous "future direction" that a future contributor might try to build toward. Recommend adding one line to that document's own status header — the same kind of explicit "reversed direction" callout `TRADEW-OS.md` §1 and `SENTINEL.md` §5 already use elsewhere in this repo for exactly this situation — rather than deleting it, per the codebase's own "archive, never delete" rule.

The second-most-important finding, independent of the Admin Portal question: **`services/tradew-ai` and `services/trading-engine` are both 0% real**, despite being load-bearing assumptions in `ARCHITECTURE.md`'s dependency graph and despite `trading-engine`'s own README claiming otherwise. Any control-plane work that implies "monitor and control the AI agents and the trading engine" needs to be honest, in the UI itself, that two of the platform's five documented backend services do not exist yet — showing a real, empty "not running" state for those is more valuable, and more consistent with this codebase's own established honesty pattern (`ModulePlaceholder`, the trading-engine README's own final line, the `Control` module's 501 messages), than deferring the whole Admin Portal effort until those services are built.

Everything needed to start Phase 0 today already exists in the repository. Nothing in this recommendation requires waiting on a decision outside engineering's control.
