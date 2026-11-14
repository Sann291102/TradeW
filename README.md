# TradeW

> A paper-trading, market-intelligence and learning platform for the Indian market (with US, UK, forex and crypto boards). One Next.js workspace in front of a NestJS API, an observation-only intelligence service (Sentinel), an in-app AI assistant, and a live Dhan market-data bridge — all on one PostgreSQL database.

**Everything that trades is paper.** There is no broker order path anywhere in this repository: people and the autonomous paper agents place simulated orders against live market prices, and every rupee is virtual.

_Last updated 2026-11-14._

---

## Contents

1. [What TradeW does](#1-what-tradew-does)
2. [Architecture](#2-architecture)
3. [Repository layout](#3-repository-layout)
4. [Features](#4-features)
5. [Technology stack](#5-technology-stack)
6. [Getting started](#6-getting-started)
7. [Configuration](#7-configuration)
8. [Scripts reference](#8-scripts-reference)
9. [Database](#9-database)
10. [Testing](#10-testing)
11. [Workflows](#11-workflows) — CI/CD, development, background jobs, n8n, agents
12. [Deployment](#12-deployment)
13. [Security](#13-security)
14. [Troubleshooting](#14-troubleshooting)
15. [Documentation map](#15-documentation-map)
16. [License](#16-license)

---

## 1. What TradeW does

| Pillar | What it is | Where it runs |
|---|---|---|
| **Core platform** | Markets, charts, option chains, watchlists, a full paper OMS (orders, positions, holdings, P&L, margin), portfolio and reports | `apps/web` + `services/api` |
| **Market data** | Live Dhan feed bridge, last-valid-price recovery when the market is closed, a multi-market tradable universe | `services/market-data` + `packages/market-data` |
| **Sentinel** | Observation-only intelligence: market/technical intelligence, trap and behaviour detection, timeline, backtests. It never gates or delays a person's order | `services/sentinel` (TS) + `services/sentinel-py` (Python strategy watcher) |
| **Autonomous paper agents** | A mandated loop that turns a Sentinel observation into a *paper* order and manages it to exit — off unless two separate switches are on ([ADR-046](docs/AUTONOMOUS-TRADING.md)) | `services/api/src/paper-execution` |
| **TradeW AI assistant** | A natural-language copilot that drives the app (navigate, open contracts, chart control) and verifies its own actions. It has no order tool | `services/tradew-ai` + `apps/web/src/lib/assistant` |
| **Discipline** | Per-session trade/loss limits, cooldowns, a friction prompt with a signed override | `services/api/src/discipline` |
| **Learning** | Courses, concepts, strategy library | `apps/web/(workspace)/learning` + `services/api/src/learning` |
| **Operator console** | Admin command centres: agents, orders, audit, health, observability, knowledge, cognition | `apps/admin` |

Product principles that the code enforces (not just documents): no surface tells a person what to trade (`services/sentinel/src/vocabulary`), Sentinel being down never blocks the platform (ADR-003), and nothing the platform has recorded is destroyed — history is closed, not deleted.

---

## 2. Architecture

```
                 Browser
                    │
        ┌───────────▼───────────┐          ┌──────────────────────┐
        │  apps/web  (Next.js)  │          │ apps/admin (Next.js) │
        │  :3000                │          │ :3001  operator      │
        │  /api/*  → proxy ─────┼──┐       │ console, server-side │
        │  /feed/* → proxy ──┐  │  │       │ proxy with ADMIN_    │
        └────────────────────┼──┘  │       │ API_TOKEN            │
                             │     │       └──────────┬───────────┘
                             │  ┌──▼──────────────────▼────────────┐
                             │  │  services/api  (NestJS) :4000     │
                             │  │  the single public ingress:       │
                             │  │  auth · OMS (sim/) · portfolio ·  │
                             │  │  paper-execution · discipline ·   │
                             │  │  payments · notifications · admin │
                             │  └──┬─────────┬──────────┬───────────┘
                             │     │ service │ service  │ service token
                             │     │ token   │ token    │
                             │  ┌──▼──────┐ ┌▼────────┐ ┌▼───────────┐
                             │  │sentinel │ │sentinel-│ │ tradew-ai  │
                             │  │ :4010   │ │py :4011 │ │ :4020      │
                             │  │ (TS)    │ │(FastAPI)│ │ assistant  │
                             │  └──┬──────┘ └┬────────┘ └────────────┘
                             │     │         │
                        ┌────▼─────▼─────────▼──┐      ┌──────────────┐
                        │ market-data bridge    │◄─────│ Dhan (live   │
                        │ :4600 live feed +     │  WS  │ feed, REST)  │
                        │ last-price recovery   │      └──────────────┘
                        └───────────┬───────────┘
                                    │
                  ┌─────────────────▼─────────────────┐
                  │ PostgreSQL 16 + pgvector + pg_trgm │
                  │ one schema: packages/database      │
                  └────────────────────────────────────┘
```

### Runtimes and ports

| Runtime | Package | Port | Start | Notes |
|---|---|---|---|---|
| Web app | `@tradew/web` | 3000 | `npm run dev:web` | Proxies `/api/*` to the API and allow-listed `/feed/*` to the bridge (`apps/web/next.config.mjs`) |
| Admin console | `@tradew/admin` | 3001 | `npm run dev:admin` | Talks to the API server-side only |
| API | `@tradew/api` | 4000 | `npm run dev:api` | Runs `scripts/preflight.mjs` first. Swagger at `/docs` |
| Sentinel | `@tradew/sentinel` | 4010 | `npm run dev:sentinel` | Internal only, service-token guarded |
| Sentinel-py | `services/sentinel-py` | 4011 | `npm run dev:sentinel-py` | Python/FastAPI personal strategy watcher; alert-only |
| TradeW AI | `@tradew/tradew-ai` | 4020 | `npm run dev:ai` | Internal; runs the `assistant-planner` agent |
| Market-data bridge | `@tradew/market-data-service` | 4600 | `npm run dev:market-data` | Needs Dhan credentials for live prices |
| Postgres (dev) | `infra/docker/docker-compose.yml` | 5433 | `docker compose up -d` | `pgvector/pgvector:pg16`, pgAdmin on 5050 |

All of these are also defined in [`.claude/launch.json`](.claude/launch.json) with pinned ports, plus `personas-api` (4100) and `personas-web` (3100) for the isolated test stack.

### Design rules

- **One public ingress.** Only `services/api` is reachable from a browser; Sentinel, Sentinel-py and TradeW AI bind to localhost and require a service token (`SENTINEL_SERVICE_TOKEN`, etc.).
- **One schema owner.** `packages/database` holds the only Prisma schema and migration history; every service reads the same Postgres.
- **Leader-gated background jobs.** Every timer in the API registers with `LeaderElectionService`, so two API replicas never run the same sweep twice.
- **Shared packages are consumed built.** `@tradew/types`, `@tradew/database`, `@tradew/ai-core` and `@tradew/market-data` are built by `postinstall` in dependency order; their `dist/` is gitignored.

The full target architecture, service boundaries and open questions are in [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 3. Repository layout

```
apps/
  web/              Next.js 14 trader workspace (the product)
  admin/            Next.js operator console
  mobile/           placeholder (README only)
services/
  api/              NestJS — the API and everything that owns money
  sentinel/         NestJS — observation-only intelligence desk
  sentinel-py/      FastAPI — personal strategy watcher
  tradew-ai/        NestJS — assistant runtime
  market-data/      live Dhan feed bridge + ingestion runtime
  company-data/     company-filings ingestion runtime
  trading-engine/   README only (the OMS lives in services/api/src/sim)
  analytics/ auth/ notification/   contract boundaries / placeholders (README only)
packages/
  database/         Prisma schema (83 models), 46 migrations, seed
  market-data/      provider/feed contracts, Dhan adapter, simulated market
  ai-core/          providers, memory, RAG, research foundation
  types/            shared TypeScript contracts
  ui/               design-system tokens and primitives
  sdk/ shared/      placeholders (README only)
agents/             declarative agent definitions (tradew-ai is loaded; sentinel is inert — see agents/README.md)
workflows/          n8n workflow exports (empty — see §11.4)
infra/              docker (dev + prod compose, Caddy), azure (Bicep), terraform (AWS), oci, k8s notes
scripts/            preflight, dev-reset, start-all-with-tunnels, load test, ad/explainer render harness
tests/personas/     virtual customers: Playwright personas against an isolated stack
docs/               handbook, product architecture, ADRs, runbooks, audits, security
knowledge/          Obsidian vault — decisions, patterns, gotchas, research
knowledge-base/     learning content
archive/            superseded code, kept for reference (never imported)
```

Root documents: [`ARCHITECTURE.md`](ARCHITECTURE.md) (target architecture), [`REPOSITORY_INVENTORY.md`](REPOSITORY_INVENTORY.md) (A–Z file inventory), [`SENTINEL_MASTER_PLAN.md`](SENTINEL_MASTER_PLAN.md) (Sentinel blueprint, cited by code comments), [`SENTINEL_ROOT_CAUSE_AND_PERMANENT_FIX.md`](SENTINEL_ROOT_CAUSE_AND_PERMANENT_FIX.md) (feed-reliability audit, cited by tests). One-off audit reports live under [`docs/audits/`](docs/audits/).

---

## 4. Features

### Trader workspace (`apps/web`)

| Area | Routes |
|---|---|
| Home and markets | `/home` `/dashboard` `/markets` `/universe` `/crypto` `/forex` `/news` `/calendar` |
| Trading | `/trade` `/orders` `/positions` `/portfolio` `/reports` `/backtesting` |
| Intelligence | `/sentinel` `/research` `/alerts` `/discipline` |
| Learning | `/learning` `/learning/[courseId]` `/learning/[courseId]/[conceptId]` `/learning/strategies` `/learning/strategy/[id]` |
| Account | `/settings/*` (account, trading, appearance, notifications, preferences, privacy, subscription, integrations, legal, help) `/profile` `/notifications` `/checkout` `/community` |
| Auth | `/login` `/signup` `/reset` `/auth/callback` `/legal/[slug]` |

The in-app **assistant** is available on every workspace page and can navigate, open option contracts, drive the chart and apply layouts; it refuses to place orders or give trade calls.

### Paper trading (`services/api/src/sim`)

- Market, limit, SL and SL-M orders; MIS, CNC and NRML products; margin blocking and release; partial fills; a matching engine tick.
- Positions, holdings with T+1 settlement, realized/unrealized P&L, simulated charges on order history.
- **Intraday square-off sweep** — exits MIS and expiring options at 15:15 IST, exits stale carried MIS after the open, and cash-settles expired options at intrinsic value from real (never simulated) underlying data. Agent positions are left to their agent until 15:25. Disable with `SQUARE_OFF_SWEEP_ENABLED=false`.
- **Order attribution** — every order, trade and trade-history row says whether a person or an agent placed it (`source`, `agent`, `role`, `exitReason`); the order book, trade history and blotter show an **Agent** badge.
- **Reset paper balance** — a two-step "Reset balance to ₹10,00,000" card on **Portfolio → Overview** and **Settings → Trading**. `POST /sim/wallet/reset` with `{ "confirm": true }`:
  - restores cash to ₹10,00,000 and zeroes margin and realized P&L;
  - closes open positions (`closeReason: FLATTENED`), cancels resting orders and clears holdings;
  - keeps every order, trade and closed position as history;
  - sets `PaperWallet.resetAt`, so performance figures count only from the reset;
  - is refused (409) while a Sentinel agent holds a position on the account, and a bare POST without `confirm` is rejected (400).
- **Last valid price** — when the market is closed or the feed is down, prices show the last valid traded price rather than 0.00; the bridge prints a "NO PRICES HELD" block naming the cause when it has nothing.

### Autonomous paper agents (`services/api/src/paper-execution`)

Execution profiles bind an agent to a consenting account, symbol and risk budget. The loop evaluates Sentinel observations, enforces policy, freshness and risk gates, places paper orders, manages exits, journals every decision and calibrates from outcomes. It runs only when `PAPER_EXECUTION_ENABLED=true` **and** a profile is armed in the admin console. Diagnosis guide: [`docs/AUTONOMOUS-TRADING.md`](docs/AUTONOMOUS-TRADING.md).

### Sentinel (`services/sentinel`, `services/sentinel-py`)

Market and technical intelligence, day classification, option-chain positioning (levels plus a verb), trap and emotion signals, a session timeline, confidence explainability, a backtest engine on real candles, an ontology/knowledge graph and outcome learning. Sentinel-py parses a person's own strategy, watches it and alerts — it holds no execution mandate.

### Platform services (`services/api`)

Email/password and Google sign-in with hashed, revocable refresh tokens; OTP over email/SMS; entitlements and subscriptions with Razorpay payments; broker OAuth (Dhan consent flow, credentials encrypted at rest); notifications; news; company intelligence; the tradable universe (India, USA, UK, forex, crypto); learning; telemetry; and the admin API behind `ADMIN_API_TOKEN`.

### Operator console (`apps/admin`)

`/agents` `/ai` `/audit` `/cognition` `/health` `/knowledge` `/lab` `/learning-platform` `/observability` `/orders` `/reasoning` `/rules` `/system`.

---

## 5. Technology stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 14 (App Router), React 18, TypeScript 5.7, Tailwind, Zustand, TanStack Query, TradingView charting |
| Backend | NestJS 10 (API, Sentinel, TradeW AI), FastAPI (Sentinel-py) |
| Data | PostgreSQL 16 with `pgvector` and `pg_trgm`, Prisma 5.22; Redis in the production compose |
| Market data | Dhan WebSocket feed + REST, bridged by `services/market-data` |
| AI | Provider-agnostic `packages/ai-core` (Anthropic/OpenAI keys optional; features report honestly when no provider is configured) |
| Testing | Vitest, pytest, Playwright (personas), a Node load harness in `scripts/loadtest` |
| Infra | Docker Compose + Caddy, Azure Container Apps (Bicep), Terraform (AWS), GitHub Actions |

---

## 6. Getting started

### Prerequisites

- Node.js 20+ and npm
- Docker (for Postgres with pgvector) — or any Postgres 16 with `vector` and `pg_trgm` available
- Python 3.11+ (only for Sentinel-py)
- Dhan API credentials (only for live prices; without them the app runs, and price-dependent actions say the feed is unavailable)

### First run

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in at least `DATABASE_URL` and `JWT_SECRET` in `.env` (the defaults in `.env.example` match the dev compose file), then:

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

```bash
npm run db:generate
```

```bash
npm run migrate:deploy -w @tradew/database
```

```bash
npm run seed -w @tradew/database
```

Start the API and the web app in two terminals:

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Open <http://localhost:3000>. The seed creates a demo account (see `packages/database/prisma/seed.ts`). API health is at <http://localhost:4000/health> and the API reference at <http://localhost:4000/docs>.

Optional runtimes: `npm run dev:sentinel`, `npm run dev:sentinel-py`, `npm run dev:ai`, `npm run dev:market-data`, `npm run dev:admin`. `npm run start:all` starts the stack with tunnels (`scripts/start-all-with-tunnels.mjs`).

---

## 7. Configuration

[`.env.example`](.env.example) is the authoritative, commented list of every variable (one root `.env` is read by the API, Sentinel, TradeW AI and the bridge). The ones you meet first:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (dev compose: `localhost:5433`) |
| `JWT_SECRET` | Access-token signing; the API refuses to boot without it |
| `API_PORT`, `FRONTEND_URL`, `CORS_ORIGINS` | API port and allowed web origins |
| `ADMIN_API_TOKEN` | Shared secret between `apps/admin` and the admin API |
| `SENTINEL_SERVICE_TOKEN` (and the TradeW AI token) | Service-to-service auth for internal runtimes |
| `DHAN_*`, `DHAN_LIVE_URL` | Live market data and the bridge URL |
| `PAPER_EXECUTION_ENABLED` | Process switch for the autonomous paper agents (default `false`) |
| `SQUARE_OFF_SWEEP_ENABLED` | Intraday square-off sweep (default on) |
| `SMTP_*`, `GOOGLE_*`, `RAZORPAY_*` | Email, Google sign-in, payments — blank disables each cleanly |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Optional AI providers |

Web-only settings go in `apps/web/.env.local` (`NEXT_PUBLIC_API_URL`, `API_PROXY_TARGET`); admin settings in `apps/admin/.env`. Never commit any `.env*` file other than the examples — `.gitignore` blocks them.

---

## 8. Scripts reference

| Script | Does |
|---|---|
| `npm run dev:api` / `dev:web` / `dev:admin` / `dev:sentinel` / `dev:sentinel-py` / `dev:ai` / `dev:market-data` | Start one runtime in watch mode |
| `npm run start:all` | Start the stack with tunnels |
| `npm run preflight` | Diagnose a dead backend (missing `.env`, secrets, unreachable Postgres) |
| `npm run dev:reset` | Recover from Next's `Cannot find module './NNN.js'` dev-cache desync |
| `npm run build` / `build:api` / `build:web` | Build all workspaces or one |
| `npm test` | Run every workspace's test suite |
| `npm run db:generate` / `db:migrate` | Prisma client generation / new dev migration |
| `npm run ontology:validate` / `ontology:seed` | Sentinel ontology checks and seeding |
| `npm run reel:build` / `reel:render` | Render the Cutting Room ad reel to MP4 (needs Playwright + ffmpeg; see `scripts/cutting-room/README.md`) |

---

## 9. Database

- **Schema:** [`packages/database/prisma/schema.prisma`](packages/database/prisma/schema.prisma) — 83 models covering users and auth, entitlements and payments, the paper OMS (`PaperWallet`, `Order`, `Trade`, `Position`, `Holding`), paper execution (`ExecutionProfile`, `ExecutionIntent`, `ExecutionPosition`, journal), Sentinel, learning, knowledge and telemetry.
- **Migrations:** 46 under `packages/database/prisma/migrations`. Apply with `npm run migrate:deploy -w @tradew/database`; create with `npm run db:migrate`. Migrations are additive — a deployed migration is never edited. CI applies all of them to an empty database and fails on any drift from the schema.
- **Seed:** `npm run seed -w @tradew/database` loads prototype instruments and quotes, subscription plans and a demo account.
- **Admin access:** `npm run admin:grant -w @tradew/database` (grant) and `admin:reconcile` (audit/withdraw).

> **Upgrading an existing database:** the balance reset adds `PaperWallet.resetAt`. Run `migrate:deploy` after pulling, or `POST /sim/wallet/reset` and the performance endpoints will fail.

---

## 10. Testing

| Suite | Command | Notes |
|---|---|---|
| Unit (all workspaces) | `npm test` | Vitest; each workspace lists its files in its `vitest.config` |
| One workspace | `npx vitest run` inside it | e.g. `apps/web`, `services/api` |
| Sentinel-py | `cd services/sentinel-py && python -m pytest -q` | |
| Type checks | `npx tsc --noEmit -p <workspace>/tsconfig.json` | what CI runs |
| Virtual customers | `cd tests/personas && npm install && node src/run.mjs` | Playwright personas using the real app in a browser; see below |
| Load | `node scripts/loadtest/run.mjs` | see `docs/LOAD-TEST-REPORT.md` |

**Virtual customers** ([`tests/personas`](tests/personas/README.md)) sign up through the real form and click the real buttons — `new-trader`, `options-trader`, `housekeeping` (the balance reset, cancel and confirm paths) and `agent-watcher`. They write `out/latest/report.md` and `findings.json`. Run them **only** against the isolated stack (Postgres on `127.0.0.1:5435`, API 4100, web 3100 — `personas-api` / `personas-web` in `launch.json`), with `PAPER_EXECUTION_ENABLED=false` and `SQUARE_OFF_SWEEP_ENABLED=false`. Never point them at a database with real users. Journeys that need live prices report "blocked: environment" when the Dhan bridge is not running; that is not a pass and not a product bug.

New screens are tested for real (personas or Playwright against the running app and a real database), not through a faked API.

---

## 11. Workflows

### 11.1 GitHub Actions (`.github/workflows`)

| Workflow | Trigger | What it does |
|---|---|---|
| **CI** (`ci.yml`) | every push and pull request, manual | Jobs: **Test suites** (`npm ci`, Prisma generate, `npm test`) · **Sentinel (Python) tests** (pytest) · **Typecheck** api, sentinel, admin, market-data · **Typecheck (web)** · **Migration drift** (apply every migration to an empty Postgres, assert no drift) · **Docker images build** · **Compose config valid** (dev + prod) · **Dependency audit** (fails on critical only) · **Terraform validate** |
| **Validate Azure Foundation** (`azure-validate.yml`) | PRs and pushes to `main` that touch `infra/azure` | Bicep build/lint of the Azure Container Apps foundation |
| **Deploy to Oracle Cloud** (`deploy.yml`) | manual only (the push-to-main trigger is deliberately disabled) | Builds and deploys the prod compose stack to OCI |
| **Build and deploy to Azure Web App** (`main.yml`) | manual only | Builds and deploys the Node app to the `tradew` Azure Web App |

### 11.2 Development workflow

1. **One task, one worktree, one branch.** Every task starts in its own git worktree on a `claude/<task>` (or feature) branch.
2. **Finish through a pull request into `main`.** Finished work must reach `main`; a commit that lives only on a task branch is invisible to anyone running the app. Unfinished work stays on its branch and is labelled as such.
3. **Conventional commit subjects** (`feat(sim): …`, `fix(web): …`, `docs: …`), with a body that says what was and was not verified.
4. **CI must be green** before merging; migrations must be additive.
5. **Record what is non-obvious** in `knowledge/` (decisions, patterns, gotchas) and keep `docs/` current.

### 11.3 Background jobs (inside `services/api`)

All are leader-gated, so only one API replica runs each.

| Job | What it does |
|---|---|
| Matching engine | Evaluates resting orders against current prices and fills them |
| Settlement sweep | Settles CNC buys into holdings (T+1) |
| Square-off sweep | 15:15 IST MIS/expiry exits and expired-option cash settlement (`SQUARE_OFF_SWEEP_ENABLED`) |
| Performance snapshot sweep | Daily performance figures (counted from `resetAt` after a reset) |
| Paper execution: evaluate / manage / reconcile | The autonomous agent loop (`PAPER_EXECUTION_ENABLED`) |
| Agent lab observation | The lab's observation loop |
| Cognition | Perceptor network (off unless `COGNITION_ENABLED=true`) |
| EOD summary | End-of-day email (needs SMTP) |
| Telemetry retention, backtest run queue | Housekeeping |

### 11.4 n8n workflows (`workflows/`)

Reserved for version-controlled n8n exports (alert fanout, KYC processing, EOD reports, on-call paging). **It is empty today**: no orchestration passes through n8n; background sequencing runs in-process (§11.3). See [`workflows/README.md`](workflows/README.md).

### 11.5 Agent definitions (`agents/`)

`agents/tradew-ai/definitions.json` is loaded by `services/tradew-ai` (its one agent, `assistant-planner`, serves `POST /assistant/interpret`). `agents/sentinel/definitions.json` is read by no code — Sentinel's reasoning is deterministic TypeScript. Details in [`agents/README.md`](agents/README.md) and [`docs/product-architecture/AGENT-LAYERS.md`](docs/product-architecture/AGENT-LAYERS.md).

---

## 12. Deployment

| Target | Where | Status |
|---|---|---|
| Docker Compose + Caddy | [`infra/docker/docker-compose.prod.yml`](infra/docker/docker-compose.prod.yml) — web, api, sentinel, sentinel-py, market-data, live-feed, migrate, postgres, redis, caddy | Used by the OCI deploy workflow |
| Azure Container Apps | [`infra/azure`](infra/azure/README.md) (Bicep) — [ADR-001](docs/adr/ADR-001-azure-container-apps-foundation.md) | Validated in CI; deploy is manual |
| Oracle Cloud | [`infra/oci`](infra/oci/README.md) | Manual workflow |
| AWS | [`infra/terraform`](infra/terraform/README.md) | Validated in CI |
| Kubernetes | [`infra/k8s`](infra/k8s) | Notes only |

Production readiness checklist: [`docs/PRODUCTION-READINESS.md`](docs/PRODUCTION-READINESS.md). Cloud design: [`docs/CLOUD-ARCHITECTURE.md`](docs/CLOUD-ARCHITECTURE.md).

---

## 13. Security

- Access tokens are short-lived JWTs; refresh tokens are hashed and revocable. The `tw_auth` cookie is a valueless routing hint, cleared when no credential backs it.
- Internal runtimes bind to localhost and require service tokens; the admin API requires `ADMIN_API_TOKEN`.
- Broker credentials are encrypted at rest (`packages/database/src/credential-crypto.ts`); see [`docs/security`](docs/security/README.md).
- Explicit `select` lists keep password hashes and Google ids out of every response.
- Secrets live only in untracked `.env` files; `.gitignore` also blocks Terraform state/vars and Azure local parameter files.

---

## 14. Troubleshooting

| Symptom | Fix |
|---|---|
| Every `/api/*` call returns 500 | The API is not running or cannot start — run `npm run preflight` |
| Next dev server 500s with `Cannot find module './NNN.js'` | Stop the dev servers, run `npm run dev:reset`, start again |
| Prices show "—" or "Market data is temporarily unavailable" | The Dhan bridge (`:4600`) is not running or has no credentials; it logs a "NO PRICES HELD" block with the cause |
| `Module '@prisma/client' has no exported member …` | Run `npm run db:generate` |
| Reset or performance endpoints fail after pulling | Apply migrations (`migrate:deploy`) — `PaperWallet.resetAt` is new |
| Agents are not trading | Follow [`docs/AUTONOMOUS-TRADING.md`](docs/AUTONOMOUS-TRADING.md) §3 in order |
| A clean checkout fails with `Cannot find module @tradew/types` | Re-run `npm install` (the `postinstall` builds the shared packages) |

---

## 15. Documentation map

| Need | Read |
|---|---|
| Current state of the app | [`docs/APPLICATION-STATUS.md`](docs/APPLICATION-STATUS.md), [`docs/PROJECT-STATUS.md`](docs/PROJECT-STATUS.md) |
| Target architecture | [`ARCHITECTURE.md`](ARCHITECTURE.md), [`docs/handbook/`](docs/handbook) (chapters 00–27) |
| Product specs | [`docs/product-architecture/`](docs/product-architecture/README.md) |
| Autonomous paper agents | [`docs/AUTONOMOUS-TRADING.md`](docs/AUTONOMOUS-TRADING.md), [`docs/product-architecture/AUTONOMOUS-PAPER-AGENTS.md`](docs/product-architecture/AUTONOMOUS-PAPER-AGENTS.md) |
| Market data | [`docs/product-architecture/DHAN-MARKET-DATA-INTEGRATION.md`](docs/product-architecture/DHAN-MARKET-DATA-INTEGRATION.md) |
| Sentinel | [`SENTINEL_MASTER_PLAN.md`](SENTINEL_MASTER_PLAN.md), [`docs/product-architecture/SENTINEL.md`](docs/product-architecture/SENTINEL.md), [`docs/SENTINEL-LIVE-VALIDATION-RUNBOOK.md`](docs/SENTINEL-LIVE-VALIDATION-RUNBOOK.md) |
| Audits | [`docs/audits/`](docs/audits) |
| Engineering memory | [`knowledge/_INDEX.md`](knowledge/_INDEX.md) |
| Every file in the repo | [`REPOSITORY_INVENTORY.md`](REPOSITORY_INVENTORY.md) |

---

## 16. License

No license file is committed, so the code is not licensed for reuse. (An earlier README described AGPL-3.0, but no license text was ever added.) Add a `LICENSE` file before distributing the code.

Maintained by Sannidhi Vivek, with Claude (Anthropic) as engineering collaborator.
