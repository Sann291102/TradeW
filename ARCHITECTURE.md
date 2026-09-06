# TradeW — Final Target Architecture

Status: **approved design, now substantially implemented.** The monorepo structure below is real — `apps/`, `services/`, and `packages/` all exist and most are built out (see the 🟢/🟡 markers in §2, and [`docs/APPLICATION-STATUS.md`](docs/APPLICATION-STATUS.md) for exactly what runs end-to-end today). This document remains binding for all future development — new work should be built to match these boundaries.

This extends [`../CONSOLIDATION-PLAN.md`](../CONSOLIDATION-PLAN.md) (the audit + what to keep/archive) with *how the kept pieces fit together* going forward, and folds in three things the consolidation plan deliberately left out of scope until now: an AI agent layer, n8n workflow automation, and admin/mobile apps.

**Update:** the AI layer is now split into two separate systems — **TradeW AI (Research)** and **Sentinel (Safety Nets)** — per an explicit architecture decision made after this document's first draft. See [`docs/product-architecture/README.md`](docs/product-architecture/README.md) for the full reasoning and the product-level blueprints for each. §4 below reflects the split; treat the product-architecture docs as the detailed spec and this file as the service-boundary summary.

---

## 1. Guiding principles

1. **One public ingress.** `apps/*` never call `services/trading-engine`, `services/market-data`, `services/ai-orchestrator`, or `services/analytics` directly. Everything user-facing goes through `services/api`. This keeps one place for auth, rate limiting, and audit logging.
2. **Don't build a distributed system before the load demands one.** The company's own architecture doc targets Kubernetes + Kafka at 1M concurrent sessions — that's the v2.0+ destination, not the v0.3 starting point. Sections below mark what to build now vs. what to defer, and why.
3. **No order without a mandate.** *(Changed 2026-09-01. This rule read "No AI-initiated trades" until the company's SEBI registration removed the premise behind it; see ADR-046 in `docs/handbook/26-decision-records.md`.)*

   `services/tradew-ai` and `services/sentinel` still cannot call `services/trading-engine` or place an order. They analyze, summarize and (for Sentinel) reflect — never instruct, and never execute. What changed is that a separate, purpose-built **execution agent** may now place orders on its own initiative, and only ever through an `ExecutionProfile`: a written, bounded, revocable grant naming the symbol, the strategy roster, the size, the daily order and loss caps, the square-off time and the account it applies to. Arming it takes two deliberate acts in two mechanisms, plus that account owner's recorded consent, and every decision is written as an `ExecutionIntent` — evidence, gates, risk plan, stop and target — in the same insert that claims its idempotency key.

   Outside a mandate there is no order capability anywhere in the AI layer. A human action is still required to convert any *advisory* AI output into an order, which is what keeps the product's "platform, not advice" positioning in the PRD intact: authorisation to execute inside a mandate is not authorisation to tell a person what to do.
4. **One schema owner per table, even across languages.** `services/api` (Node/Prisma) and `services/trading-engine` (Python) will eventually share one Postgres instance, but never one ORM. Table ownership is explicit (§5).
5. ~~Every service ships its own `.env.example`.~~ **Reversed 2026-08-04.** The monorepo consolidation pass moved every service onto one root `.env` / `.env.example`, at explicit product direction — the "three disconnected credential surfaces" debt item this principle fixed had, in practice, drifted into real inconsistencies of its own (services/sentinel and packages/database silently pointing at the wrong Postgres port; a stray, unreferenced NEXT_PUBLIC_API_URL copy in a partial earlier consolidation). Per-service `.env`/`.env.example` files now just point at the root file rather than duplicating it; the two exceptions (`apps/web/.env.local`, `packages/database/.env`) exist only because Next.js and the Prisma CLI can't read an external env path, and both mirror the root file rather than diverging from it. See `.env.example` at the repo root and its header comment.

---

## 2. Monorepo structure & service boundaries

```
TradeW/
├── apps/
│   ├── web/            🟢 trader-facing app — Next.js; hosts every pillar's workspace (Core, Sentinel, Research, Learning)
│   ├── admin/           🟢 standalone Next.js operator console (port 3001) — command centers (agents/ai/audit/orders/rules/system/health/observability), cognition graph, knowledge stream; operator-account auth, read-only aggregations
│   └── mobile/          🟡 React Native, roadmap v0.9 — README/contract only, consumes packages/sdk + packages/types
│
├── services/
│   ├── api/             🟢 NestJS — the single public aggregator/BFF (port 4000); auth, orders, entitlements, payments, notifications, market-data proxy
│   ├── auth/             🟡 extraction target for the api's auth module (see §2.1 — README/contract only, still an in-process module)
│   ├── trading-engine/   🟡 Python/Dhan execution engine — README/contract only in-tree; real-money code not migrated in yet (see its README)
│   ├── market-data/      🟢 NestJS ingestor + Dhan live-feed bridge & token scripts (live-feed-server.ts on port 4600)
│   ├── tradew-ai/        🟡 Research pillar runtime scaffold (NestJS) — runs agents/tradew-ai/, thin; research features not wired yet, see §4
│   ├── sentinel/          🟢 Safety Nets pillar runtime (NestJS, port 4010) — runs agents/sentinel/, observation pipeline, Brain, ontology/reasoning; separate from tradew-ai
│   ├── sentinel-py/        🟢 new — Python/FastAPI personal strategy watcher (port 4011); parses a user's own text strategy, watches live candles, alerts. Additive to services/sentinel; alert-only, holds no mandate and places no orders, see §4
│   ├── notification/     🟡 alert fanout (email/Slack/push) — README/contract only; in-app notifications currently live in services/api
│   └── analytics/         🟡 portfolio/PnL analytics — README/contract only, eventual ClickHouse aggregation
│
├── packages/
│   ├── ui/               🟢 shared design-system components — consumed by apps/web + apps/admin; spec in docs/design-reference/DESIGN-SYSTEM.md
│   ├── types/            🟢 shared TS types/DTOs — source of truth for API contracts, consumed across apps + services
│   ├── ai-core/           🟢 provider-agnostic AI primitives (LLM client, prompt/guardrail helpers) — consumed by api, sentinel, tradew-ai
│   ├── market-data/       🟢 hand-written Dhan WebSocket binary parser + market types — consumed by services/market-data and services/sentinel
│   ├── sdk/               🟡 typed client generated from services/api's OpenAPI spec (PRD's "public developer API", Phase 3) — not built; hand-written clients used
│   ├── database/          🟢 single Prisma schema.prisma + migrations (owns the shared Postgres schema)
│   └── shared/            🟡 config loader, logger, error types — still a placeholder; boot-time env validation is ad hoc per service
│
├── agents/                🟡 declarative agent definitions, split into agents/tradew-ai/ and agents/sentinel/ — see §4
├── workflows/              🟡 versioned JSON exports of n8n workflows (n8n itself stays out-of-tree)
├── docs/                   ⚪ product/build-plan/design-reference docs, copied from the planning folder
├── infra/                  ⚪ docker-compose, k8s manifests, terraform — see §7
├── scripts/                ⚪ repo-wide tooling
└── archive/                ⚪ superseded copies per consolidation plan §2 — retained, not deleted
```

### 2.1 Why `services/auth` is a folder but not a day-one deployable

The audited backend already has a working auth module (JWT, refresh tokens, audit logging) living inside the NestJS app. Splitting it into an independently-deployed service today would mean running, deploying, and securing a second network hop for zero current benefit — nothing yet needs auth to scale independently of the rest of the API.

`services/auth/` exists now as the **contract boundary**: it holds the auth module's public interface (guards, DTOs, token-validation logic) as a package `services/api` imports internally. When load actually requires it (roadmap v0.9's 50k-concurrent-session target is the natural trigger), the extraction is a lift of that already-isolated module into its own deployable, not a rewrite. Don't extract it before then.

### 2.2 Sentinel is a workspace inside `apps/web`, like every other pillar

Every pillar — Core Platform, TradeW AI, Sentinel, Learning Hub — is served by `apps/web` as one shared workspace shell: sidebar, top bar, and all, per §4 and `docs/design-reference/DESIGN-SYSTEM.md` §3. Sentinel is the platform's flagship premium intelligence workspace and the AI intelligence layer underneath the rest of the product. It is **not** a separate application.

Sentinel's *workspace* differs from the others because its job differs — different layouts, screens and workflows — but it uses the same shell, the same design language, the same navigation, the same auth and the same entitlement system. A user moving into Sentinel has not left TradeW.

**Marketing is a separate concern from application architecture.** A dedicated Sentinel landing page, marketing site or subdomain is fine and expected. The rule binds from sign-in onward: once authenticated, Sentinel is part of the platform (`TRADEW-OS.md` §1).

> **Reversed direction, 2026-07-21.** This section previously stated the opposite — that Sentinel shipped as its own marketing site and standalone application with no shared sidebar. That was a misreading of the product vision and has been reversed. It was **never executed in code**: `apps/web/src/app/sentinel/page.tsx` still renders inside the shared shell, and an earlier attempt at a chrome-less Sentinel was itself reverted the same day because it left users no way to navigate back out. See `docs/product-architecture/SENTINEL.md` §5.

---

## 3. Communication: NestJS API ↔ Python trading engine

**Current state** (per audit): the Flask trading engine receives TradingView webhooks directly at an HMAC-verified endpoint, and separately exposes ~8 REST endpoints for positions/orders/fills/PnL, backed by SQLite.

**Target pattern, v0.3–v0.4 (build this now):**

- `trading-engine` keeps owning inbound strategy webhooks directly (TradingView → trading-engine). That path is already hardened (HMAC-SHA256, timing-safe compare) and latency-sensitive; routing it through `services/api` first would add a redundant hop and a second signature-verification surface for no gain.
- `trading-engine`'s REST API becomes **internal-only** — reachable solely from `services/api` and `services/analytics` inside the private network, authenticated with a service-to-service token (shared secret to start; mTLS once infra supports it). It is never exposed to the public internet and never called with an end-user JWT.
- `services/api` is the sole aggregator: it calls `trading-engine` for positions/orders/PnL and merges that with its own domain data (watchlists, preferences) into one response shape for `apps/*`.
- **Order flow:** user submits an order in `apps/web` → `services/api` validates (session, risk limits, permissions) → `services/api` calls `trading-engine`'s internal API to place/simulate the order → `trading-engine` executes against the broker (or `mock_dhanhq.py` in paper mode) → fills flow back via the poller.
- Keep `order_poller.py`'s polling-based fill reconciliation exactly as it is — it's a good safety net, not a stopgap to rip out.

**Target pattern, v1.0+/v2.0 (defer until real load justifies it):**

- Introduce an event bus — **start with Redis Streams**, not Kafka. Kafka is the architecture doc's long-term target for 1M-concurrent-session scale; adopting it before there's load to justify the operational cost is over-engineering.
- `trading-engine` publishes domain events (`OrderFilled`, `OrderRejected`, `PositionUpdated`, `PnLSnapshot`); `services/api`, `services/notification`, and `services/analytics` subscribe independently. This decouples "an order filled" from "notify the user" from "recompute analytics," instead of `services/api` fanning everything out synchronously.
- Graduate Redis Streams → Kafka only when a single consumer group / durability / replay requirement actually can't be met by Redis anymore.

---

## 4. AI agent architecture — two separate systems

> **⚠️ This section is the intended design, not the running system.**
> `POST /agents/:name/invoke` does not exist in any runtime. `services/sentinel`
> reads no agent definitions and runs no LLM-backed agent. No tool and no
> prompt template is registered anywhere, so `allowedTools` and `systemPromptId`
> are inert everywhere they appear. The one live piece of this design is
> `assistant-planner` in `services/tradew-ai`, on `POST /assistant/interpret`.
> **`docs/product-architecture/AGENT-LAYERS.md` is the accurate map** and takes
> precedence over this section wherever the two disagree.

**Scope, per the PRD's own boundary** ("no discretionary advice"): every agent, in either system, analyzes, explains, or reflects. None of them recommend trades in a way that bypasses user judgment, and none place an order on a human's behalf as advice.

**The one deliberate exception — and its boundary.** Since 2026-08-18, and completed 2026-08-30, `services/api/src/paper-execution/` runs **autonomous paper agents** that do place orders: they consume live market data, form a thesis, size a position, and manage it to a stop, a target or a trail without a human in the loop. Three properties keep that inside the boundary above rather than outside it, and all three are structural, not conventional:

- **Paper only, unrepresentably so.** `ExecutionEnvironment` has exactly one member, `PAPER`. There is no broker order path in this application, no enum value to route to one, and adding one is a schema-and-review change, not a config change. The agents *read* a live broker feed; they cannot *write* to a broker.
- **They never speak to a human.** An autonomous agent's output is an `ExecutionIntent` and an `Order` in its own account, not a suggestion on anybody's screen. It cannot become the "suggested next step" a user acts on, so the no-discretionary-advice boundary is untouched — nothing here recommends a trade to a person.
- **Two switches, both operator-held.** `PAPER_EXECUTION_ENABLED=true` on the API process *and* the profile's own `enabled` column, armed from the audited admin console. Off by default. A `USER_PAPER` profile additionally requires that person's revocable consent, re-read every pass.

Full reference: [`docs/product-architecture/AUTONOMOUS-PAPER-AGENTS.md`](docs/product-architecture/AUTONOMOUS-PAPER-AGENTS.md). Note that these agents are **not** the declarative `agents/` roster described below — they are deterministic TypeScript (index-direction reads, strategy rules, evidence readers, a risk model and one exit-decision function), with no LLM anywhere in the decision path.

TradeW AI (Research) and Sentinel (Safety Nets) are **deliberately separate systems**, not two feature sets of one orchestrator — different question (understanding vs. behavioral risk), different data (market/company data vs. the user's own trading behavior), different tone (explanatory vs. diagnostic/reflective), different compliance posture (Sentinel's Compliance & Audit agent logs and SEBI-labels every observation it produces). Full detail lives in `docs/product-architecture/`:

- **`docs/product-architecture/TRADEW-AI.md`** — the Research pillar. Agent roster: AI Researcher (router), Company Analysis, News Analysis, Option Chain Analysis, Technical Analysis, Strategy Builder, Portfolio Insights, Learning Assistant. Two UI surfaces: an ambient docked-chat copilot available everywhere, and a dedicated Research workspace for deep per-symbol analysis.
- **`docs/product-architecture/SENTINEL.md`** — the Safety Nets pillar. Four agents (Market & Technical Intelligence, Emotion Intelligence, Trap & Safety Intelligence, Compliance & Audit) synthesized by a Sentinel Orchestrator into the only user-facing output. Includes the composite Trap Detection design — multiple corroborating signals (fake breakouts, liquidity sweeps, FOMO entries, revenge trading, low-volume breakouts, expiry-day traps, gamma squeeze/IV crush, and more), never a single-pattern trigger — and a fixed evidence → pattern-name → soft-suggestion output tone, never a directive.

**Runtime split:**

- `agents/tradew-ai/` and `agents/sentinel/` hold **declarative** agent definitions — system prompts, allowed tools, guardrail/disclaimer config — as version-controlled files, reviewed like code, one subfolder per system.
- `services/tradew-ai` and `services/sentinel` are the two **runtimes** — each was to load only its own subfolder's definitions and expose its own internal endpoint (`POST /agents/:name/invoke`), called only by `services/api` — never directly by `apps/*` — so there's one auth/rate-limit/audit chokepoint per system for compliance review later. **As built:** `services/tradew-ai` loads its definitions and exposes `POST /assistant/interpret` (not `/agents/:name/invoke`); `services/sentinel` loads no definitions at all and exposes `POST /observe` and `POST /intelligence/reason`, both backed by deterministic TypeScript rather than agent definitions. The single-chokepoint property still holds — both are behind `ServiceTokenGuard` and called only by `services/api`.
- `services/sentinel-py` (Python/FastAPI, port 4011) is a **third, additive runtime** under the Sentinel umbrella: the *personal strategy watcher*. The user writes their own strategy in plain text; a deterministic parser turns it into rules, an in-process sweep loop watches live Dhan candles (`IDLE → FORMING → CONFIRMED`), and confirmations/in-trade R-multiple milestones are pushed to the user as `Notification` rows via `services/api`. It is called only by `services/api` (service-token guard, mirroring `services/sentinel`'s `ServiceTokenGuard`), reads/writes its own `UserStrategy`/`WatchSession`/`WatchObservation` tables in the shared Postgres via `asyncpg`, and — like every Sentinel component — **never proposes, buys, or sells**; a compliance gate (`app/notify/compliance.py`) blocks any Buy/Sell/Entry/Target/Stop string before it leaves the service. It runs alongside `services/sentinel` (TypeScript), which is unchanged; see `services/sentinel-py/README.md` and `SENTINEL_MASTER_PLAN.md`.
- Model access goes through the Anthropic API directly (see the workspace's `claude-api` reference for model/pricing/caching choices); this is independent of the separate `TradingBot` project's own Anthropic integration, which stays out of scope per the earlier decision.
- Every agent response that touches trading data carries a disclaimer and, where relevant, a structured "suggested next step" the user must explicitly act on — the UI converts that into an order only via the normal order-flow path in §3, never automatically. Sentinel additionally never blocks or delays the order flow — it comments in parallel, it is not a gate.
- TradeW AI **and Sentinel** share the same `apps/web` UI shell as workspaces — see `docs/product-architecture/README.md` for the "one app, N workspaces" model and `docs/design-reference/DESIGN-SYSTEM.md` for the shared visual system, extracted from the Emergent mockups and now binding for `packages/ui`. Sentinel's workspace has its own layouts and workflows because its job differs, but it sits under the same sidebar, top bar, design language, auth and entitlements as every other pillar (§2.2, `TRADEW-OS.md` §1, `docs/product-architecture/SENTINEL.md` §5).

---

## 5. n8n integration

`n8n-master` (the vendored OSS engine) **stays exactly where it is, outside this monorepo** — it's a third-party dependency, not TradeW-authored code, per the earlier scoping decision. Nothing here changes that.

What lives in this repo instead:

- **`workflows/`** — version-controlled JSON exports of the actual workflows TradeW's n8n instance runs (e.g., alert-fanout-across-channels, KYC-document-processing, EOD-report-generation, on-call-incident-paging). Exporting them into git means workflow changes go through code review and CI deployment instead of being edited invisibly in a running n8n UI.
- n8n is deployed as its **own service** (see `infra/`), built from the vendored `n8n-master` folder or a managed n8n Cloud instance — the monorepo never imports n8n's source.

**Direction of calls (n8n is for internal ops automation, never customer-facing trade logic):**

- TradeW → n8n: a service (e.g. `services/notification` on an `OrderFilled` event, or `services/api` on a new signup) calls an n8n webhook to *trigger* a workflow.
- n8n → TradeW: a running workflow calls back into `services/api` using a **service-scoped credential** (never an end-user JWT) to take an action — e.g., mark a KYC document reviewed, or ask `services/notification` to actually send a message.
- Nothing on the sub-150ms-SLO path (market-data ticks, order execution) ever routes through n8n — it's for minutes-scale ops workflows, not the trading hot path.

---

## 6. Shared libraries (`packages/`)

| Package | Purpose | Consumed by |
|---|---|---|
| `shared` | Config loader (fail-fast env validation), structured logger, common error types — still a placeholder | every Node service (once built) |
| `types` | Shared TS interfaces/DTOs — source of truth for request/response shapes | `api`, `ui`, `sdk`, all `apps/*` |
| `database` | The single `schema.prisma` + migration history (owns the shared Postgres schema) | `services/api` (and `services/auth` once extracted) |
| `ui` | Design-system components extracted from `apps/web` as they stabilize — don't pre-extract UI that's still changing weekly | `apps/web`, `apps/admin`, later `apps/mobile`'s web-shared views if any |
| `ai-core` | Provider-agnostic AI primitives — LLM client, prompt assembly, guardrail/disclaimer helpers | `services/api`, `services/sentinel`, `services/tradew-ai` |
| `market-data` | Hand-written Dhan WebSocket binary parser + market types (verified by `scripts/verify-parser.ts`), plus the multi-market tradable-universe catalogue (`src/universe` — five markets, three provider adapters, and the single owner of the market-currency vs paper-account-currency distinction; see `docs/product-architecture/TRADABLE-UNIVERSE.md`) | `services/market-data`, `services/api`, `services/sentinel` |
| `sdk` | Typed client generated from `services/api`'s OpenAPI spec — not built yet | `apps/*` internally now; external developers once the Phase 3 public API ships |

`services/trading-engine` (Python) and `services/sentinel-py` (Python) do not consume the TypeScript packages above — they're different runtimes with their own dependency sets. `sentinel-py` does read/write the shared Postgres schema that `packages/database` owns (directly via `asyncpg`, never through Prisma — one schema owner, never one ORM, §1.4). See §2 above for `trading-engine`'s migration path.

---

## 7. Environment & deployment

**Environment strategy:**

- One root `.env` / `.env.example` for local dev, consolidated 2026-08-04 (reversing the earlier per-service-`.env.example` principle — see §1.5). `packages/shared` remains unbuilt (still a placeholder, per its own README); env validation at boot is currently ad hoc per service rather than centralized through a shared config loader, which is a reasonable next step now that there's one file to validate.
- Tiers: **local** (docker-compose, `.env` files, `mock_dhanhq.py` as the paper broker) → **staging** (Kubernetes namespace, secrets from a secrets manager, Dhan sandbox or paper mode) → **production** (Kubernetes, AWS Secrets Manager/Vault, real broker credentials, tightly scoped access).

**Deployment architecture (`infra/`):**

- `infra/docker/` — docker-compose for local dev (api + web + trading-engine + postgres + redis), extending what already exists in the audited `TradeW-Setup-main` copy rather than inventing a new compose file from scratch.
- `infra/k8s/` — one Deployment per service/app, independently scalable and independently deployable (a `trading-engine` traffic spike shouldn't force scaling `services/analytics`). Targets AWS ap-south-1 per the architecture doc.
- `infra/terraform/` — IaC for VPC, RDS/Aurora Postgres, ElastiCache Redis, EKS, and S3 (audit/KYC storage, WORM per PRD compliance requirements).
- CI builds and deploys each service independently on path-based triggers — a change to `services/trading-engine` doesn't rebuild `apps/admin`.

---

## 8. Observability

Build in rough priority order (cheapest leverage first, matching the consolidation plan's improvement recommendations):

1. **Structured JSON logging** in every service from day one — trivial cost, immediate debugging value.
2. **Metrics**: Prometheus + Grafana, starting with `trading-engine`'s own already-planned Phase 2 work, extended to `services/api`.
3. **Alerting**: one Slack webhook first (already on `trading-engine`'s roadmap) — don't stand up PagerDuty-style paging before there's an on-call rotation to page.
4. **Tracing**: OpenTelemetry across NestJS + Python (+ n8n workflow calls where relevant), so one order's path — webhook → trading-engine → api → notification — is traceable end-to-end.
5. **Log aggregation**: start with something operationally cheap (e.g. Grafana Loki); the architecture doc's ELK stack is a later-scale target, not a day-one requirement.

---

## 9. Dependency graph

```
apps/web ──────┐
apps/admin ────┼──► services/api ──► packages/database
apps/mobile ───┘         │      ──► packages/types
                          │      ──► packages/shared
                          │
                          ├──► services/auth        (in-process module today; see §2.1)
                          ├──► services/trading-engine   (internal REST, service token)
                          ├──► services/market-data       (internal REST/event bus)
                          ├──► services/tradew-ai          (internal REST)
                          ├──► services/sentinel           (internal REST)
                          ├──► services/sentinel-py        (internal REST, service token — strategy watcher)
                          ├──► services/notification      (internal REST/event bus)
                          └──► services/analytics          (internal REST)

services/tradew-ai ──► agents/tradew-ai/ (definitions),  packages/ai-core
services/sentinel  ──► agents/sentinel/ (definitions),   packages/ai-core, packages/market-data
services/sentinel  ──► services/trading-engine (read-only, via services/api — user's own trade history for Emotion Intelligence)
services/sentinel-py ──► packages/database's Postgres schema (direct asyncpg; own UserStrategy/WatchSession/WatchObservation tables)
services/sentinel-py ──► services/market-data live-feed bridge (candles) and ──► services/api /internal/sentinel-py/notify (alerts)
services/market-data ──► packages/market-data (Dhan binary parser)
services/api ──► packages/ai-core, packages/market-data

services/notification ◄──► n8n (external service) ◄──► workflows/ (versioned exports)

packages/ui, packages/sdk ──► consumed by apps/* only
packages/database ──► consumed by services/api (Prisma) and services/sentinel-py (asyncpg, same schema)
```

Rules this graph enforces:
- No arrows point from any `packages/*` back into `apps/*` or `services/*` (no circular deps).
- No arrow points from `apps/*` to anything except `services/api` and the `packages/*` explicitly listed — that's the "one public ingress" principle from §1 made concrete.
- `services/trading-engine` has no inbound arrows from `packages/*` — it's intentionally a separate runtime island, integrated only over the network boundary defined in §3.
- `services/tradew-ai` and `services/sentinel` have no arrows between each other — they're independent systems (§4) that both happen to be called by `services/api` and both happen to read from `services/trading-engine`/`services/market-data`; neither depends on the other's output.

---

## 10. What's still open

These are decisions this document deliberately defers rather than guessing at:

- Exact schema split once `trading-engine` moves off SQLite onto the shared Postgres (which tables it owns vs. reads cross-schema).
- Whether `apps/mobile` is React Native (sharing `packages/types`/`sdk`) or a separate native codebase — revisit at the actual v0.9 build stage.
- The point at which `services/auth` is actually extracted (trigger: real session load approaching the v0.9 50k-concurrent target, not a fixed date).
- Kafka adoption trigger (trigger: a concrete consumer-group/durability need Redis Streams can't meet, not a fixed date).
