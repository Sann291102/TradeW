# TradeW — Platform, Knowledge, and AI-Powered Intelligence

> A comprehensive, open-architecture trading platform built on modular AI systems, institutional knowledge graphs, and paper-trading simulation. Designed for retail traders and emerging research teams.

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791?logo=postgresql)](https://www.postgresql.org/)
[![NestJS](https://img.shields.io/badge/NestJS-10-E0234E?logo=nestjs)](https://nestjs.com/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)](https://react.dev/)
[![License](https://img.shields.io/badge/License-AGPL%203.0-blue)]()
[![Status](https://img.shields.io/badge/Status-~80%25%20complete-brightgreen)]()

---

> **Project status (2026-07-29): ~80% complete.** The core platform is live end to end — real Dhan market data, a full paper-trading OMS (equities, F&O and per-strike option premiums), broker OAuth, an in-app AI assistant that drives the application, the Sentinel safety-net service (backtest engine on real candles, ontology, orchestrator), crypto/forex boards, discipline limits, real market news, notifications, and a hardened security layer with 112 automated tests. Remaining work is largely the standalone Python trading engine, the TradeW-AI *backend* research service, cloud IaC automation, and the admin/mobile apps. See [Project Status](#project-status) for the current matrix.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Repository Structure](#repository-structure)
- [Technology Stack](#technology-stack)
- [Features](#features)
- [Quick Start](#quick-start)
- [Setup Guide](#setup-guide)
- [Development](#development)
- [Database](#database)
- [AI Architecture](#ai-architecture)
- [Project Status](#project-status)
- [Roadmap](#roadmap)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Documentation](#documentation)

---

## Overview

**TradeW** is a modular, full-stack trading platform designed around three core philosophies:

1. **Platform, not advice** — TradeW educates and explains; it never directs trades. All AI systems analyze, summarize, and reflect — they never initiate orders.
2. **Knowledge over hype** — Every insight is traceable to evidence. The Sentinel system logs observations with explicit audit trails; the Research system explicitly marks confidence and sources.
3. **Separation of concerns** — Core Platform (markets, orders, portfolios) is independent from TradeW AI (research/learning) and Sentinel (behavioral safety nets). Different runtimes, different agents, unified product experience.

### What TradeW Does

- **Core Platform:** ✅ Live Dhan market data, real TradingView charts, portfolio tracking, order management (paper-trading), watchlists, symbol search, option chains, crypto & forex market boards, real financial newswires
- **In-App AI Assistant:** ✅ A natural-language copilot that *drives the application* — navigates screens, opens exact option contracts, toggles panels, applies layouts — while strictly refusing to place orders or give trade calls (see [AI Architecture](#ai-architecture))
- **TradeW AI (Research):** 🚧 AI-powered research agents, company/technical/option analysis, news intelligence, strategy builder, portfolio insights (`packages/ai-core` foundation built; dedicated backend research service not yet populated)
- **Sentinel (Safety Nets):** 🚧 Behavioral pattern detection, trap recognition, EMA-cross backtest engine on real candles, compliance logging, market/technical intelligence — running as its own service
- **Discipline & Guardrails:** ✅ Per-session trade/loss limits, cooldowns, market-calendar awareness
- **Learning Hub:** 📅 Curated research vault, validated knowledge graph, continuous learning pipeline
- **Paper Trading:** ✅ Full order lifecycle with margin simulation (MIS/CNC/NRML), fill matching, position and P&L tracking, real per-strike option premiums

---

## Architecture

### System Overview

```
                         ┌─────────────────────────────────────────┐
                         │       apps/web (Next.js)                │
                         │   One unified shell, four workspaces:   │
                         │   - Core Platform, Research, Sentinel,  │
                         │     Learning Hub                        │
                         └────────────────┬────────────────────────┘
                                          │
                         ┌────────────────┼────────────────────────┐
                         │                │                        │
                    ┌────▼────┐   ┌──────▼───┐   ┌─────────▼──┐
                    │ services│   │ services │   │  services │
                    │   /api  │   │/tradew-ai│   │ /sentinel │
                    │ NestJS  │   │  LLM     │   │  LLM      │
                    │ GraphQL │   │ Agents   │   │ Agents    │
                    └────┬────┘   └──────┬───┘   └─────┬──────┘
                         │               │             │
        ┌────────────────┼───────────────┼─────────────┤
        │                │               │             │
   ┌────▼──────┐  ┌──────▼────┐  ┌──────▼───┐  ┌─────▼─────┐
   │ services/ │  │  services/│  │ services/│  │ services/ │
   │   market- │  │ trading-  │  │  notify- │  │ analytics │
   │   data    │  │  engine   │  │  cation  │  │  (future) │
   └────┬──────┘  └──────┬────┘  └──────┬───┘  └───────────┘
        │                │              │
        └────────────────┼──────────────┘
                         │
          ┌──────────────▼──────────────┐
          │   PostgreSQL 16 + pgvector  │
          │   (single authoritative DB) │
          └─────────────────────────────┘
```

### Monorepo Structure

```
TradeW/
├── apps/
│   ├── web/           🟢 Next.js — Core Platform, Research, Sentinel, Learning workspaces + in-app AI assistant
│   ├── terminal/      🟢 Static full-screen trading terminal shell
│   ├── admin/         🟡 Internal ops console — KYC, audit logs, DLQ, user mgmt
│   └── mobile/        🟡 React Native — roadmap v0.9
│
├── services/
│   ├── api/           🟢 NestJS — single public ingress, auth, OMS, aggregation (14 modules)
│   ├── market-data/   🟢 NestJS ingestor + standalone live Dhan feed bridge (port 4600)
│   ├── sentinel/      🟢 Safety-net service — backtest engine, brain, orchestrator, ontology (44 TS files)
│   ├── trading-engine/🟡 Python/Flask — order execution, webhook intake (README only; OMS lives in services/api/sim)
│   ├── tradew-ai/     🟡 Research backend service (README only; foundation in packages/ai-core)
│   ├── notification/  🟡 Alert fanout (in-app notifications live in services/api)
│   ├── auth/          🟡 JWT/refresh tokens (auth currently lives in services/api)
│   └── analytics/     ⚪ Portfolio/PnL analytics, eventual ClickHouse aggregation
│
├── packages/
│   ├── database/      🟢 Prisma schema (36 models), migrations (centralized)
│   ├── ai-core/       🟢 AI foundation — providers, memory, RAG, agents, news classifier
│   ├── market-data/   🟢 Shared instrument/quote helpers
│   ├── types/         🟡 Shared TypeScript interfaces/DTOs
│   ├── ui/            🟡 Design-system components (from Emergent mockups)
│   ├── sdk/           🟡 Typed OpenAPI client (Phase 3)
│   └── shared/        🟡 Config loader, logger, error types
│
├── agents/
│   ├── tradew-ai/     🟡 Declarative Research agent definitions
│   └── sentinel/      🟢 Declarative Safety-net agent definitions (4 agents + orchestrator)
│
├── workflows/         🟡 Version-controlled n8n workflow JSON exports
│
├── docs/
│   ├── product-architecture/  Product blueprints (TRADEW-OS, SENTINEL, TRADEW-AI, etc.)
│   ├── design-reference/      Design system extracted from mockups
│   └── product/               PRD, vision, business overview
│
├── infra/
│   ├── docker/        🟢 docker-compose (local dev) + docker-compose.prod.yml + Caddy (prod)
│   ├── oci/           ⚪ Oracle Cloud (Ampere A1 arm64) deployment notes
│   ├── k8s/           ⚪ Kubernetes manifests (notes only)
│   └── terraform/     ⚪ IaC (notes only)
│
├── knowledge/         🟢 Obsidian vault — engineering decisions, patterns, research summaries
│
├── scripts/           🟡 Repo-wide tooling (codegen, database seed, bootstrap)
│
└── archive/           📦 Superseded code (kept, never deleted per Rule 1)
```

**Legend:** 🟢 real code exists · 🟡 designed, not yet built · ⚪ config/docs only · 📦 archived

---

## Repository Structure

### Core Folders

| Folder | Purpose | Current Status |
|--------|---------|-----------------|
| **apps/web** | Next.js frontend hosting the unified shell (18 routes: dashboard, markets, trade, portfolio, sentinel, research, learning, crypto, forex, news, discipline, notifications, knowledge, settings, profile, auth) plus the in-app AI assistant that drives the app. | 🟢 Live; most workspaces built, Research/Learning still filling in |
| **services/api** | NestJS aggregator — the single public API gateway. Handles auth, OMS, entitlements, market data, broker OAuth, discipline, news, notifications, and calls internal services. | 🟢 Running, 14 modules mapped |
| **services/market-data** | NestJS quote ingestor **plus** a standalone live Dhan feed bridge (port 4600) serving real quotes, charts and option chains to the app. | 🟢 Live feed bridge in use; NestJS ingestor writes Postgres `Quote` |
| **services/sentinel** | Safety-net service — EMA-cross backtest engine on real Dhan candles, persistent knowledge brain, orchestrator, state machine, compliance, ontology. Internal-only (service token). | 🟢 Running as its own service (port 4010) |
| **services/trading-engine** | Python/Flask engine for webhook-driven strategy execution. | 🟡 README only; the paper-trading OMS is implemented in `services/api/src/sim` |
| **services/tradew-ai** | LLM-powered Research *backend* agents (Company Analysis, News, Technical, Strategy Builder). | 🟡 README only; the AI foundation is in `packages/ai-core` and the in-app assistant in `apps/web` |
| **packages/database** | Centralized Prisma schema (36 models) and migration history. Single source of truth for schema. | 🟢 17 migrations applied, 100% synced |
| **packages/ai-core** | AI foundation: provider abstraction (Anthropic, OpenAI-compatible, Voyage, research), memory, RAG, prompts, tools, news classifier. | 🟢 Built; consumed by services |
| **packages/types** | Shared TypeScript DTOs/interfaces — source of truth for all API contracts. | 🟡 Framework exists; incomplete |
| **packages/ui** | Design-system React components extracted from Emergent mockups. Binding for all apps. | 🟡 Design spec in `docs/design-reference/DESIGN-SYSTEM.md`; components still being extracted |
| **knowledge/** | Obsidian vault for durable engineering knowledge (decisions, patterns, discoveries). Not live production data. | 🟢 Actively updated |

---

## Technology Stack

### Frontend

- **Framework:** Next.js 14 (App Router)
- **UI Library:** React 18 + Tailwind CSS
- **State Management:** Zustand
- **Charts:** TradingView Lightweight Charts, Mermaid (diagrams)
- **Markdown:** react-markdown + remark-gfm
- **Animation:** Framer Motion

### Backend

- **API Gateway:** NestJS 10 (ExpressJS-compatible) — single public ingress
- **Paper-Trading OMS:** NestJS (`services/api/src/sim`) — order/matching/position/portfolio services
- **Sentinel Service:** NestJS (`services/sentinel`) — internal-only, service-token authenticated
- **Live Feed Bridge:** Node standalone server (`services/market-data`) — real Dhan quotes/charts/option chain
- **Trading Engine:** Python 3.9+ (Flask) — planned, webhook-driven strategy execution
- **Authentication:** JWT (HS256, 15m access) + rotating refresh tokens; email one-time-code foundation (SMTP)
- **Outbound Email:** Nodemailer / generic SMTP (dev falls back to logging + `devCode`)
- **LLM Integration:** Anthropic Claude API via `packages/ai-core` (provider-abstracted; OpenAI-compatible & Voyage embeddings also supported)

### Database & ORM

- **Database:** PostgreSQL 16 (with pgvector extension for embeddings)
- **ORM:** Prisma 5.22
- **Caching/Events:** Redis (planned; Streams for event bus)
- **Future:** ClickHouse (analytics aggregation)

### AI & Memory

- **LLM Provider:** Anthropic Claude (default)
- **Vector DB:** pgvector (in-process Postgres)
- **Memory System:** MemoryRecord + MemoryRelation (semantic search + embedding)
- **Knowledge Graph:** ConceptNode + ConceptEdge (ontology-based reasoning; Sentinel-specific)
- **Agent Framework:** Custom (Prisma + LLM direct; not LangChain or AutoGen)

### Infrastructure

- **Local Dev:** Docker Compose (PostgreSQL, pgAdmin) + npm workspaces for services
- **Deployment:** ✅ Oracle Cloud (OCI Ampere A1, arm64) via `docker-compose.prod.yml` behind Caddy (TLS, same-origin `/api` + `/feed` proxy)
- **Container Registry:** ✅ GitHub Container Registry (ghcr.io) — arm64 images built in CI
- **CI/CD:** ✅ GitHub Actions (`.github/workflows/deploy.yml`) — build arm64 images on `main`, push to ghcr.io, deploy over SSH (pull → migrate → up)
- **IaC:** 📅 Terraform / Kubernetes manifests (notes only)
- **Monitoring:** 📅 Prometheus + Grafana

### Dev Tools

- **Node.js:** 20+
- **TypeScript:** 5.7
- **Package Manager:** npm workspaces
- **Task Runner:** npm scripts
- **Linting:** ESLint (Next.js config)
- **Testing:** Jest — 112 test cases across 7 suites, security-focused (broker authz, OAuth state, log redaction, feed-URL validation) plus discipline/market-calendar logic

---

## Features

### ✅ Implemented

- **Authentication & Authorization**
  - JWT-based sign-up/login/refresh with bcrypt password hashing
  - Rotating refresh tokens (stored hashed; revoked-on-use)
  - Email one-time-code foundation (`Otp` model, `OtpService`, SMTP mailer) — enumeration-safe, brute-force-throttled
  - Branded transactional emails (`mail/templates.ts`): HTML+text templates for OTP, **login-alert on every sign-in**, password-changed, payment receipts and the EOD summary — one template layer, sent as `admin@tradew-setup.com`
  - Google sign-in (OAuth 2.0) — wired end-to-end; enabled by setting `GOOGLE_CLIENT_ID/SECRET`
  - User profile + preferences (persistent settings)
  - Audit logging (all events tracked with IP, user agent, metadata)

- **Core Platform**
  - Live Dhan market data — real quotes (indices, bid/ask, volume), TradingView chart history, live option chains, derivative lot sizes
  - Standalone live-feed bridge serving the same real prices to dashboard, charts and option chain
  - Instrument catalog (NSE/BSE equities, indices, options, futures) with real broker identifiers
  - Paper-trading OMS with full order lifecycle (PENDING → OPEN → FILLED/PARTIALLY_FILLED/CANCELLED/EXPIRED)
  - Real per-strike option premium paper trading; short-option margin corrected
  - Matching engine, position tracking, portfolio (cash balance, positions, P&L, margin utilization) wired to the real paper account
  - Order types: MARKET, LIMIT, SL, SL_M · Validity: DAY, IOC · Products: MIS / CNC / NRML
  - IST-aware session times and lot sizes

- **Crypto & Forex Boards**
  - Crypto market board with `CryptoWallet` / `CryptoOrder` / `CryptoPosition` schema and public price feed
  - Forex board (SOON badge for gated features) and a US-stocks route

- **In-App AI Assistant (TradeW AI, app-control layer)**
  - Natural-language router that takes control of the app — navigation, "open NIFTY 24300 call of 21st July", panel toggles, layout presets, theme switch, command palette
  - Hard-boundary guard: refuses to place/cancel orders, give trade calls/targets, or relay Sentinel's premium reasoning
  - Domain fence: markets + this app only

- **Sentinel (Safety Nets) — running as its own service**
  - EMA-cross backtest engine on real Dhan candles
  - Live quotes read from the Dhan feed (no simulator) in `getQuote`
  - Persistent knowledge brain, orchestrator, state machine, confidence, compliance, timeline, vocabulary modules
  - Concept ontology (ConceptNode + ConceptEdge, manually curated, runtime-learnable) with observations audit trail (confirmed/refuted/inconclusive)
  - Trap detection concept catalog (built-in patterns: bull_trap, fake_breakout, etc.)
  - Internal-only: gated by a shared service token, never publicly exposed

- **Discipline & Guardrails**
  - `DisciplineSession` / `DisciplineOverride` with per-session trade & loss limits and cooldowns
  - Market-calendar awareness (holiday/weekend logic, unit-tested)

- **Market News & Notifications**
  - Real financial newswires (Economic Times, Moneycontrol RSS) on a public Market News route, de-duplicated, cached, newest-first
  - Persistent notifications with a typed `NotificationCategory` enum, backed end-to-end: bell badge, drawer and `/notifications` page all read the real `/notifications` API via a 30s live sync, with a synthesized "TradeW mark" chime on new arrivals (and on new Sentinel live-feed observations) — mutable per user

- **Payments (Razorpay, seam)**
  - `services/api/src/payments/` — order creation, signature-verified checkout callback, and an authoritative webhook, all fulfilling through `EntitlementsService.activate` (idempotent on the Razorpay payment id — never double-grants)
  - Premium checkout page (`apps/web/.../checkout`) for Sentinel Pro terms; honestly reports `billingEnabled:false` until `RAZORPAY_KEY_ID/SECRET` are set — no account can be charged out of the box
  - Payment receipt / processing / failed email templates

- **End-of-Day Summary Email**
  - Daily portfolio value + P&L + orders wrap-up, gated by leader-election, trading-day, after-close-hour and once-per-user-per-day — off by default (`EOD_EMAIL_ENABLED=true` to turn on)

- **Broker Integration (Dhan OAuth "consent" flow)**
  - Per-user broker credential ownership; CSRF/replay-protected OAuth state; single feed-default row for the shared bridge
  - See [Security](#security) for the full model

- **AI Foundation (`packages/ai-core`)**
  - Provider abstraction (Anthropic, OpenAI-compatible, Voyage embeddings, research provider) + provider manager/factory
  - Memory system (MemoryRecord + MemoryRelation) with semantic search over pgvector embeddings
  - Knowledge graph (GraphNode + GraphEdge), RAG, prompts, tools, and a 13-category news-event classifier

- **Subscriptions & Entitlements**
  - Plan-based capability grants (free, pro, premium, enterprise)
  - Usage quota tracking (per-day, per-month, per-billing-cycle)
  - Entitlement overrides (manual grants for testing/support)
  - Trial periods, grace periods, cancellation tracking

- **Database**
  - 36 models across the trading, market-data, AI, ontology, subscription, discipline, broker and news domains
  - Full referential integrity with foreign keys; indexes on all hot paths
  - Partial unique index enforcing a single broker feed-default row
  - Soft-delete pattern for instruments (deactivate, never remove)

- **Security & Testing**
  - Hardened security layer (headers, CORS restrictions, log redaction, secure cookies, admin guard) — see [Security](#security)
  - 112 automated tests, security-focused

### 🚧 Partially Implemented

- **Sentinel premium reasoning**
  - Service runs with backtest engine, brain, orchestrator and ontology in place
  - Full agent orchestration (Emotion, Trap & Safety, Compliance synthesis into user-facing output) still being wired end to end
  - Trading journal with AI annotations: schema + endpoints exist; annotation pipeline partial

- **TradeW AI research pillar**
  - The in-app *app-control* assistant is live (see Implemented)
  - The *research* backend (`services/tradew-ai`) is a README only; the reasoning agents (chart read, support/resistance, option-chain interpretation) are parked for Phase 2
  - `packages/ai-core` provides the foundation (providers, memory, RAG) they will build on

- **News intelligence**
  - Real headlines are served; a 13-category LLM classifier exists in `packages/ai-core` and a `NewsEvent` model exists
  - Classification is intentionally NOT wired to user-facing output pending compliance review

- **Notifications**
  - Persisted with categories, exposed via API, live-synced in-app with sound (see Implemented)
  - Slack/push channels not built; email is covered separately (login-alert, payment, EOD — see Implemented) rather than as generic per-notification fanout

- **Admin Dashboard (`apps/admin`)**
  - Operator-only Next.js console: token-gated session, Engine Health / Knowledge / Agents / Reasoning / Rules / Learning Platform / Observability / Audit modules, "View as Trader" passthrough
  - Backed by real `services/api` `/admin/*` endpoints, double-gated (`isAdmin` JWT + shared `ADMIN_API_TOKEN`)
  - Deliberately never public — see [`infra/docker/DEPLOY-DEV.md`](infra/docker/DEPLOY-DEV.md): loopback-bound + SSH tunnel only, no Caddy route
  - Roadmap items still open: KYC review UI, DLQ retry worker UI

- **Payments (Razorpay)**
  - Order/checkout/webhook flow and entitlement fulfillment are implemented and idempotent
  - `billingEnabled:false` until `RAZORPAY_KEY_ID/SECRET` are configured — no live gateway credentials wired yet, so nothing can be charged today
  - Sells Sentinel Pro terms only; Learning Hub/demo-pass checkout not yet mapped to a plan

### 📅 Not Yet Implemented

- **Standalone Python Trading Engine**
  - `services/trading-engine` is a README; webhook intake, order poller and PnL tracker not populated
  - (The paper-trading OMS itself IS implemented, in `services/api/src/sim`)

- **Kubernetes / Terraform IaC**
  - Production runs on Oracle Cloud via Docker Compose + Caddy today
  - `infra/k8s` and `infra/terraform` are notes only; manifests and cloud provisioning not automated
  - Service-to-service mTLS not configured (shared service tokens in use)

- **n8n Workflow Automation**
  - Service skeleton planned; workflow definitions and webhook triggers not created

- **Public SDK/API**
  - OpenAPI spec generation and SDK codegen not configured (Phase 3)

- **Mobile App**
  - `apps/mobile` folder exists; no implementation yet (roadmap v0.9)

- **Learning Hub**
  - Route scaffolded; curated vault + continuous learning pipeline not built

---

## Quick Start

### Prerequisites

- **Node.js:** 20+ ([download](https://nodejs.org/))
- **Docker & Docker Compose:** Latest stable
- **Git:** Latest stable
- **PostgreSQL Client Tools:** `psql` (optional, for manual queries)

### 1. Clone & Install

```bash
git clone <repository-url>
cd "TradeW LLC/TradeW"
npm install
```

### 2. Start Infrastructure (Docker Compose)

```bash
docker-compose -f infra/docker/docker-compose.yml up -d
```

This starts:
- **PostgreSQL 16** on `localhost:5433` (credentials: tradew/tradew)
- **pgAdmin 4** on `http://localhost:5050` (login: admin@tradew-setup.com / admin)

Verify:
```bash
docker-compose -f infra/docker/docker-compose.yml ps
```

### 3. Setup Database

```bash
cd packages/database
npx prisma db push
```

Expected output:
```
Your database is now in sync with your Prisma schema. Done in XXXms
```

### 4. Start API Server

```bash
npm run dev:api
```

Expected output:
```
TradeW backend listening on 4000
```

### 5. Start Web Frontend (new terminal)

```bash
npm run dev:web
```

Expected output:
```
  ▲ Next.js 14.2.20
  - Local:        http://localhost:3000
```

### 6. (Optional) Start Sentinel + Live Feed Bridge

```bash
npm run dev:sentinel        # Sentinel safety-net service (port 4010)
npm run live:server -w @tradew/market-data-service   # live Dhan feed bridge (port 4600)
```

The web dev server proxies `/api/*` to the API and the allowlisted `/feed/*` routes to the bridge (see `apps/web/next.config.mjs`), so the whole stack is reachable on one origin. All four services are also defined in `.claude/launch.json` with pinned ports (api 4000, web 3000, sentinel 4010, bridge 4600).

### 7. Access the Application

- **Web App:** http://localhost:3000
- **API Health:** http://localhost:4000/health
- **Sentinel Health:** http://localhost:4010/health
- **pgAdmin:** http://localhost:5050

---

## Setup Guide

### Environment Variables

#### API Service (`services/api/.env`)

```bash
# Database
DATABASE_URL=postgresql://tradew:tradew@localhost:5433/tradew

# Auth
JWT_SECRET=dev-secret-change-me-in-prod
PORT=4000
ACCESS_TOKEN_TTL=15m         # optional; default 15m
REFRESH_TOKEN_DAYS=30        # optional; default 30

# Frontend (comma-separated allowlist in prod)
FRONTEND_URL=http://localhost:3000

# Market Data — standalone live Dhan feed bridge
DHAN_LIVE_URL=http://localhost:4600

# Broker OAuth (Dhan "consent" flow) — required to link a broker account
DHAN_APP_ID=
DHAN_APP_SECRET=
DHAN_CLIENT_ID=
DHAN_AUTH_URL=https://auth.dhan.co          # optional override
BROKER_OAUTH_REQUIRE_STATE=false            # set true once the broker echoes `state`
DHAN_ACCESS_TOKEN=                          # optional fallback for the feed bridge

# Sentinel Service (internal-only; never exposed publicly)
SENTINEL_SERVICE_URL=http://localhost:4010
SENTINEL_SERVICE_TOKEN=dev-sentinel-token-change-me-in-prod

# Operator / admin API (guards /entitlements/admin/*, /broker/dhan/admin/*,
# and the whole apps/admin console via AdminGuard)
ADMIN_API_TOKEN=            # leave empty to disable the admin surface (fails closed)

# Outbound email (OTP, login alerts, password-changed, payment receipts, EOD
# summary — see mail/templates.ts). Leave SMTP_* blank in dev — the mailer logs
# the message and OTP endpoints return the code as `devCode` so flows stay
# testable without credentials.
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
MAIL_FROM=TradeW · Setup <admin@tradew-setup.com>
SUPPORT_EMAIL=admin@tradew-setup.com   # reply-to shown in email footers

# Google Sign-In (services/api/src/auth/google-oauth.service.ts). Leave blank
# to disable — /auth/google returns 503 and the button reports "not available".
# Redirect URI registered in Google Cloud must equal GOOGLE_REDIRECT_URI exactly.
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:4000/auth/google/callback
API_PUBLIC_URL=http://localhost:4000

# Payments — Razorpay (services/api/src/payments). Leave blank to keep billing
# disabled (GET /payments/catalog reports billingEnabled:false).
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=       # from the Razorpay dashboard webhook config

# End-of-day summary email. Off by default; requires SMTP configured above.
EOD_EMAIL_ENABLED=false
EOD_EMAIL_HOUR_IST=16

# Knowledge Workspace (internal developer tool; reads TradeW/knowledge/)
KNOWLEDGE_WORKSPACE_ENABLED=  # true=on, false=off, unset=on outside production
KNOWLEDGE_ROOT=               # defaults to ../../knowledge relative to service
```

#### Admin Console (`apps/admin/.env`)

```bash
# services/api base URL this console talks to (server-side only, never sent to
# the browser).
ADMIN_API_URL=http://localhost:4000
# The SAME shared secret as ADMIN_API_TOKEN above — must match exactly.
ADMIN_API_TOKEN=
# apps/web's URL, for the "View as Trader" passthrough.
NEXT_PUBLIC_TRADEW_WEB_URL=http://localhost:3000
```

#### Web App (`apps/web/.env.local`)

```bash
# API Gateway. In production this is built as /api (same-origin proxy).
NEXT_PUBLIC_API_URL=http://localhost:4000

# Optional direct targets (used for CSP connect-src and the dev proxy)
NEXT_PUBLIC_DHAN_LIVE_URL=http://localhost:4600
NEXT_PUBLIC_SENTINEL_URL=http://localhost:4010

# Dev proxy targets (apps/web/next.config.mjs)
API_PROXY_TARGET=http://127.0.0.1:4000
FEED_PROXY_TARGET=http://127.0.0.1:4600
```

#### Database (`packages/database/.env`)

```bash
DATABASE_URL=postgresql://tradew:tradew@localhost:5433/tradew
```

### Database Setup

**Fresh Setup (all migrations):**
```bash
cd packages/database
npx prisma db push
```

**Generate Prisma Client After Schema Changes:**
```bash
npm run db:generate
```

**Run Migrations in Development:**
```bash
npm run db:migrate
```

**View Database in pgAdmin:**
1. Navigate to http://localhost:5050
2. Login: admin@tradew-setup.com / admin
3. Servers → TradeW Local → Databases → tradew
4. Browse tables, run queries in Query Tool

### Build Commands

#### Build All Services

```bash
npm run build
```

#### Build Specific Services

```bash
npm run build:api
npm run build:web
```

#### Build Docker Images

```bash
docker build -f services/api/Dockerfile -t tradew/api:latest .
docker build -f apps/web/Dockerfile -t tradew/web:latest .
```

### Development Commands

| Command | Purpose |
|---------|---------|
| `npm run dev:api` | Start NestJS API in watch mode (port 4000) |
| `npm run dev:web` | Start Next.js frontend in dev mode (port 3000) |
| `npm run dev:sentinel` | Start Sentinel service in watch mode (port 4010) |
| `npm run live:server -w @tradew/market-data-service` | Start the standalone live Dhan feed bridge (port 4600) |
| `npm run db:generate` | Generate Prisma Client after schema changes |
| `npm run db:migrate` | Run pending database migrations |
| `npm run ontology:validate` | Validate Sentinel concept ontology YAML |
| `npm run ontology:seed` | Seed concept ontology into database |

---

## Database

### Current State

- **Engine:** PostgreSQL 16 with pgvector extension
- **Models:** 36 (with 12 enums)
- **Migrations:** 17 applied (all successful as of 2026-07-29)
- **Synced:** 100% with Prisma schema
- **Readiness:** ✅ Production-ready for core platform

### ORM & Migrations

**ORM:** Prisma 5.22

**Schema Location:** `packages/database/prisma/schema.prisma`

**Migration Workflow:**

1. **Modify schema:**
   ```bash
   # Edit packages/database/prisma/schema.prisma
   ```

2. **Create migration:**
   ```bash
   cd packages/database
   npx prisma migrate dev --name <migration-name>
   ```
   This creates a new `.sql` file and applies it immediately.

3. **Deploy to production:**
   ```bash
   npx prisma migrate deploy
   ```
   This applies all unapplied migrations (tracked in `_prisma_migrations` table).

4. **Generate Prisma Client:**
   ```bash
   npx prisma generate
   ```
   Regenerate TypeScript types after schema changes (usually automatic with `migrate dev`).

### Database Initialization Process

```
┌─────────────────────────────────────────────────────────┐
│ 1. Start PostgreSQL via docker-compose                  │
│    $ docker-compose up -d                               │
└─────────────────────────────┬───────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────┐
│ 2. Create .env in packages/database/ with DATABASE_URL  │
└─────────────────────────────┬───────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────┐
│ 3. Run Prisma DB Push (applies all migrations)          │
│    $ npx prisma db push                                 │
└─────────────────────────────┬───────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────┐
│ 4. Verify via pgAdmin (tables, columns, indexes)        │
│    http://localhost:5050                                │
└─────────────────────────────┬───────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────┐
│ 5. Database ready for application use                   │
└─────────────────────────────────────────────────────────┘
```

### Table Domains

| Domain | Models | Purpose |
|--------|--------|---------|
| **User & Auth** | User, RefreshToken, UserPreference, AuditEvent, EmailOtp | Sign-up/login, token rotation, user settings, audit trail, email OTP |
| **Trading** | Order, Trade, Position, PaperWallet | Paper-trading OMS, order lifecycle, portfolio |
| **Crypto** | CryptoWallet, CryptoOrder, CryptoPosition | Crypto paper-trading board |
| **Market Data** | Instrument, Quote, Candle | Symbol catalog, live quotes, OHLC candles |
| **Discipline** | DisciplineSession, DisciplineOverride | Per-session trade/loss limits and cooldowns |
| **Broker** | BrokerCredential, BrokerOAuthState | Per-user broker credentials, OAuth state (CSRF/replay) |
| **AI Memory** | MemoryRecord, MemoryRelation | Semantic memory, embeddings |
| **Knowledge Graph** | GraphNode, GraphEdge | Entity relationships |
| **Sentinel Ontology** | ConceptNode, ConceptEdge, ConceptObservation, ConceptPromotion | Concept definitions, learned patterns, promotion queue |
| **Sentinel Runtime** | SentinelObservation, JournalEntry | Observations (audit trail), trading journal |
| **Subscriptions** | Plan, PlanGrant, Subscription, UsageCounter, EntitlementOverride | Capabilities, quota tracking, overrides |
| **Notifications** | Notification | In-app notifications (typed categories) |
| **News** | NewsEvent | Financial news classification (schema present; not user-facing yet) |

---

## AI Architecture

### Two Separate Systems

TradeW AI and Sentinel are **deliberately separate** — different runtimes, different agents, different data, different questions.

#### TradeW AI (Research)

**Question:** "What does this mean?"

**Data:** Market data, company financials, news, technical indicators

**Tone:** Explanatory, educational

**Agents:**
- AI Researcher (router)
- Company Analysis
- News Analysis
- Option Chain Analysis
- Technical Analysis
- Strategy Builder
- Portfolio Insights
- Learning Assistant

**UI:** Dockable copilot (everywhere) + dedicated Research workspace

**Status:** 🚧 The in-app **app-control assistant is live** (`apps/web/src/lib/assistant/*`) — it navigates, opens exact contracts, toggles panels and applies layouts, with a hard guard against orders/trade-calls. The **research reasoning agents** (chart read, S/R, option-chain interpretation) are parked for Phase 2; the `services/tradew-ai` backend is a README, and the AI foundation they will use lives in `packages/ai-core`.

#### Sentinel (Safety Nets)

**Question:** "Am I about to make a mistake?"

**Data:** User's own trading behavior, positions, order history, market data

**Tone:** Reflective, questioning, non-directive

**Agents:**
- Market & Technical Intelligence
- Emotion Intelligence (behavioral patterns)
- Trap & Safety Intelligence (composite trap detection)
- Compliance & Audit (SEBI labeling, audit trail)
- Orchestrator (synthesizes above into user-facing output)

**Core Feature — Trap Detection:** Multiple corroborating signals before triggering:
- Fake breakouts
- Liquidity sweeps
- Fomo entries
- Revenge trading
- Low-volume breakouts
- Expiry-day traps
- Gamma squeeze / IV crush

**UI:** Safety Nets workspace (integrated into sidebar)

**Status:** 🚧 Running as its own service (port 4010, internal-only): EMA-cross backtest engine on real Dhan candles, live quotes read from the Dhan feed, persistent knowledge brain, orchestrator, state machine, confidence, compliance, timeline and ontology modules are in place. Full multi-agent synthesis into user-facing output is still being wired end to end. Routes exposed via `services/api` (`/sentinel/*`): `observe`, `explain`, `brain/search`, `brain/strategy`, `observations`, `timeline`, `strategies`, `market-close/review`, `session-summary`, `journal`.

### Memory Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ AI Requests (Trade analysis, research queries)              │
└────────────────────────┬────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ Agent Execution (TradeW AI or Sentinel services)            │
└────────────────────────┬────────────────────────────────────┘
                         ↓
       ┌─────────────────┴──────────────────┐
       ↓                                    ↓
┌──────────────────┐            ┌──────────────────────┐
│  MemoryRecord    │            │  ConceptObservation  │
│  (semantic)      │            │  (ontology-based)    │
│  - embedding     │            │  - pattern name      │
│  - confidence    │            │  - outcome (conf/    │
│  - tags          │            │    refuted)          │
│  - namespace     │            │  - strength          │
└──────────────────┘            └──────────────────────┘
       │                                 │
       └─────────────────┬───────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ PostgreSQL with pgvector (in-process vector DB)             │
│ - MemoryRecord + embedding for semantic search              │
│ - ConceptNode + edge for ontology retrieval                 │
│ - MemoryRelation for knowledge graph connections            │
└─────────────────────────────────────────────────────────────┘
```

### Agent Communication

All agents are called by `services/api` (never directly by frontend):

```
Frontend → services/api → services/tradew-ai OR services/sentinel
                          └─ Prisma (memory, observations, concepts)
                          └─ Claude API (LLM inference)
```

**Non-negotiable rule:** No agent ever calls `services/trading-engine` directly. Orders are placed by users through the normal order flow, augmented by agent context.

### Knowledge System Layers

| Layer | Table | Purpose | Example |
|-------|-------|---------|---------|
| **Raw Research** | MemoryRecord (sourceKind: research) | Unvalidated evidence, articles, data points | "Found 3 earnings beat patterns in RELIANCE last quarter" |
| **Observations** | SentinelObservation (confidence) | Logged pattern detections with confidence scores | "Detected low-volume breakout in NIFTY50 [confidence: 0.78]" |
| **Validated Knowledge** | GraphNode (entity-based) | Confirmed relationships between symbols, sectors, patterns | "RELIANCE belongs to Energy sector" |
| **Concept Ontology** | ConceptNode (canonical) | Manually curated concept definitions and relationships | "bull_trap definition: reversal after initial reversal that gaps above opening price" |
| **Learning** | ConceptObservation | Runtime learned patterns, eventually promoted to canonical | New trap patterns identified during trading sessions |

---

## Development Workflow

### Branch Strategy

- **main:** Production-ready code (rare direct commits; PRs required)
- **feat/*** — Feature branches (created from main, merged back via PR)
- **fix/*** — Bug fixes
- **chore/*** — Maintenance, deps, cleanup
- **docs/*** — Documentation only

### Coding Standards

- **Language:** TypeScript (strict mode enabled)
- **Formatting:** Prettier (via ESLint config)
- **Linting:** ESLint with Next.js rules
- **Naming:** camelCase for variables/functions, PascalCase for types/classes
- **Database:** Prisma-generated types, no manual SQL
- **Comments:** Minimal; code should be self-documenting. Only explain *why*, not *what*.

### Testing

- **Unit Tests:** ✅ Jest — 112 test cases across 7 suites in `services/api/src`, run with `npm test -w @tradew/api`
  - Security-focused: `broker/broker-authz.spec.ts`, `broker/oauth-state.spec.ts`, `broker/dhan-auth.service.spec.ts`, `common/security-log.spec.ts` (redaction), `news/feed-url.spec.ts`
  - Domain logic: `discipline/discipline-limits.spec.ts`, `discipline/market-calendar.spec.ts`
- **Integration / E2E Tests:** 📅 Planned (OMS end-to-end, agent system)
- **Database Tests:** Prisma client testing with real Postgres

### Commits & PRs

- One commit per logical change
- Commit messages: `<type>: <subject>` (e.g., `feat: add order validation`)
- PRs require at least one approver
- Merge strategy: Squash + merge for features, regular merge for hotfixes
- All CI checks must pass before merge

### Code Review

- All PRs reviewed for correctness, security, style
- Architecture decisions checked against `ARCHITECTURE.md`
- Database changes verified against schema integrity
- AI code reviewed for safety/disclaimer compliance

### HTTP API (selected routes)

All public traffic goes through `services/api` (single ingress). Authenticated routes require a bearer `accessToken`; operator routes require the `X-Admin-Token` header.

| Group | Prefix | Auth | Notes |
|-------|--------|------|-------|
| Auth | `/auth` | mixed | `signup`, `login`, `refresh`, `logout`, `me` (GET/PATCH), `preferences` |
| Paper OMS | `/sim` | AuthGuard | order placement/cancel, positions, portfolio, blotter |
| Instruments | `/instruments` | AuthGuard | symbol catalog, lot sizes |
| Market Data | `/market-data` | AuthGuard | quotes, candles, option chain |
| Crypto / Forex / US | `/crypto`, `/forex`, `/us-stocks` | mixed | market boards (public price feeds; user-scoped trading gated) |
| News | `/news` | **public** | real newswire headlines (server-cached) |
| Discipline | `/discipline` | AuthGuard | session limits, overrides |
| Notifications | `/notifications` | AuthGuard | in-app notifications |
| Entitlements | `/entitlements` | AuthGuard + `/admin/*` AdminTokenGuard | plans, quotas, overrides |
| Broker (Dhan) | `/broker/dhan` | AuthGuard + public `/callback` + `/admin/*` AdminTokenGuard | OAuth consent flow — see [Security](#security) |
| Sentinel | `/sentinel` | AuthGuard | proxied to the internal Sentinel service |
| Knowledge | `/knowledge` | dev tool | Obsidian vault reader (internal) |
| Health | `/health` | public | liveness |

---

## Project Status

**Overall: ~80% complete.** The core platform, live market data, paper OMS, broker OAuth, in-app AI assistant, Sentinel service, discipline, news, notifications and the security layer are all working. The remaining ~20% is the standalone Python trading engine, the TradeW-AI research backend, cloud IaC automation, and the admin/mobile apps.

### What's Working (Verified 2026-07-29)

✅ Database schema (36 models, 17 migrations, 100% synced)
✅ API server (NestJS, 14 modules)
✅ Frontend (Next.js, 18 routes) + in-app AI app-control assistant
✅ Authentication (JWT + rotating refresh tokens, bcrypt, audit logging; email-OTP foundation)
✅ Live Dhan market data (real quotes, TradingView chart history, live option chain) via the feed bridge
✅ Paper-trading OMS (full lifecycle, matching, positions, portfolio, real per-strike option premiums)
✅ Crypto & forex market boards
✅ Broker OAuth (Dhan consent flow, per-user credentials, CSRF/replay protection)
✅ Sentinel service (backtest engine on real candles, brain, orchestrator, ontology)
✅ Discipline session limits + market-calendar awareness
✅ Real market news + persistent notifications
✅ Subscriptions & Entitlements (plan-based capability grants)
✅ AI foundation (`packages/ai-core`: providers, memory, RAG, news classifier)
✅ Security hardening + 112 automated tests
✅ CI/CD (GitHub Actions → ghcr.io → Oracle Cloud) & Docker Compose (local + prod)

### What's Incomplete

🚧 Sentinel multi-agent synthesis into user-facing output (service runs; end-to-end wiring partial)
🚧 TradeW AI research backend (`services/tradew-ai`) — reasoning agents parked for Phase 2
🚧 Email-OTP public endpoints (foundation built, not surfaced)
📅 Standalone Python trading engine (README only)
📅 Kubernetes / Terraform IaC (prod runs on Docker Compose + Caddy today)
📅 n8n workflow automation (service planned, not deployed)
📅 Admin dashboard (folder exists; operator actions via admin-token routes)
📅 Mobile app (folder exists, no code)
📅 Learning Hub (route scaffolded, pipeline not built)

### Known Issues & Technical Debt

| Issue | Severity | Notes |
|-------|----------|-------|
| Broker access token plaintext at rest | MEDIUM | Encryption needs a key-management decision; tracked in `schema.prisma` |
| Sentinel agent synthesis incomplete | MEDIUM | Service + backtest run; full user-facing orchestration being wired |
| Standalone Python trading engine not populated | LOW | OMS is implemented in `services/api/src/sim`; the Python engine is a separate future path |
| No service-to-service mTLS | MEDIUM | Shared service tokens only; upgrade for multi-node prod |
| CSP uses `unsafe-inline` for scripts | LOW | Nonce migration deferred (see Security roadmap) |
| Admin app not started | LOW | Roadmap v0.5+; admin-token routes cover operator actions for now |
| Mobile app not started | LOW | Roadmap v0.9+ feature |
| Dead Letter Queue worker missing | LOW | Retry worker not built |

---

## Roadmap

### ✅ Recently Completed

- [x] Real Dhan market data feed (quotes, chart history, live option chain)
- [x] Real TradingView chart history + trade-from-chart
- [x] Paper-trading OMS with real per-strike option premiums and corrected margins
- [x] Broker OAuth (Dhan consent flow) with per-user credentials
- [x] In-app AI assistant that drives the application
- [x] Sentinel service: EMA-cross backtest engine on real candles + knowledge brain
- [x] Crypto & forex market boards
- [x] Discipline session limits + market-calendar awareness
- [x] Real market news route + persistent notifications
- [x] Security hardening pass + 112 automated tests
- [x] GitHub Actions CI/CD → ghcr.io → Oracle Cloud (Docker Compose + Caddy)
- [x] AI foundation package (`packages/ai-core`)

### 🚧 In Progress / Next

- [ ] Complete Sentinel multi-agent synthesis into user-facing output
- [ ] Surface email-OTP public auth endpoints
- [ ] TradeW AI research backend (Company/News/Technical/Option/Strategy agents)
- [ ] Launch the Research and Learning Hub workspaces
- [ ] Encrypt broker access token at rest (key-management decision)

### 📅 Later (Scaling Phase)

- [ ] Populate the standalone Python trading engine (webhook-driven strategies)
- [ ] Kubernetes manifests + Terraform IaC (currently Docker Compose on OCI)
- [ ] n8n workflow automation (alerts, reports, backtesting templates)
- [ ] Admin dashboard (KYC, audit viewer, DLQ retry, user mgmt)
- [ ] Service-to-service mTLS
- [ ] CSP nonce migration + Prometheus/Grafana monitoring

### 2027 (Beyond MVP)

- [ ] Mobile app (React Native)
- [ ] Public SDK (OpenAPI + generated clients)
- [ ] ClickHouse analytics backend
- [ ] Redis Streams event bus

---

## Troubleshooting

### Database Issues

**Problem:** `DATABASE_URL not found` error when running Prisma

**Solution:** Create `.env` in `packages/database/` with:
```bash
DATABASE_URL=postgresql://tradew:tradew@localhost:5433/tradew
```

**Problem:** Migration failed with enum error

**Solution:** This was a known issue on 2026-07-22, now recovered. If recurs:
```bash
npx prisma migrate resolve --applied <migration-name>
npx prisma migrate deploy
```

**Problem:** `port 5433 refused connection`

**Solution:** Verify PostgreSQL is running:
```bash
docker-compose -f infra/docker/docker-compose.yml ps
```
Should show `tradew-postgres` in `Up` state. If not:
```bash
docker-compose -f infra/docker/docker-compose.yml up -d postgres
```

### Build Issues

**Problem:** `Module not found` error during build

**Solution:** Clear node_modules and reinstall:
```bash
rm -r node_modules
npm install
```

**Problem:** `TypeScript compilation error`

**Solution:** Ensure `@prisma/client` is generated:
```bash
npm run db:generate
```

### Development Issues

**Problem:** API server won't start (port 4000 already in use)

**Solution:** Find and kill the process:
```bash
# Windows
netstat -ano | findstr :4000
taskkill /PID <PID> /F

# Mac/Linux
lsof -i :4000
kill -9 <PID>
```

**Problem:** Frontend can't reach API (CORS error)

**Solution:** Verify `FRONTEND_URL` in `services/api/.env`:
```bash
FRONTEND_URL=http://localhost:3000
```

And `NEXT_PUBLIC_API_URL` in `apps/web/.env.local`:
```bash
NEXT_PUBLIC_API_URL=http://localhost:4000
```

### pgAdmin Issues

**Problem:** Can't login to pgAdmin

**Solution:** Default credentials are:
- Email: `admin@tradew-setup.com`
- Password: `admin`

**Problem:** pgAdmin can't connect to PostgreSQL

**Solution:** Use Docker service name as host:
- Host: `postgres` (from inside Docker)
- Port: `5432` (internal)
- Database: `tradew`
- Username: `tradew`
- Password: `tradew`

---

## Security

### Secrets Management

**Development:**
- All secrets in `.env` files (gitignored)
- Use `.env.example` templates as reference
- Never commit actual secrets

**Production:**
- Use AWS Secrets Manager or HashiCorp Vault
- Environment variables injected at runtime
- Rotate secrets quarterly

### Critical Secrets

| Secret | Usage | Rotation |
|--------|-------|----------|
| JWT_SECRET | Sign/verify access tokens | Every 6 months or on compromise |
| SENTINEL_SERVICE_TOKEN | Service-to-service auth | Every 6 months or on compromise |
| DATABASE_URL | Postgres connection | On credential rotation |
| ADMIN_API_TOKEN | Admin/operator endpoint protection | Every quarter |
| DHAN_APP_ID / DHAN_APP_SECRET | Broker OAuth consent (app-key auth) | On broker rotation or compromise |
| SMTP_PASS | Outbound email (OTP) | On mail-provider rotation |

### Authentication Flow

```
┌──────────────────────────────────────────────────────────────┐
│ Frontend (apps/web)                                          │
│ - Stores accessToken in memory                               │
│ - Stores refreshToken in secure cookie (httpOnly, Secure)    │
└────────────────────┬─────────────────────────────────────────┘
                     │ POST /auth/signup or /auth/login
                     ↓
┌──────────────────────────────────────────────────────────────┐
│ services/api (NestJS)                                        │
│ - Validates credentials (bcrypt)                             │
│ - Issues accessToken (15m) + refreshToken (30d)              │
│ - Stores refreshToken hash (SHA-256) in database             │
└────────────────────┬─────────────────────────────────────────┘
                     │ Returns both tokens
                     ↓
┌──────────────────────────────────────────────────────────────┐
│ Frontend                                                     │
│ - accessToken attached to every API request (Authorization) │
│ - On expiration, POST /auth/refresh with refreshToken       │
│ - Updates accessToken, continues                             │
└──────────────────────────────────────────────────────────────┘
```

### Data Protection

- **Passwords:** Hashed with bcryptjs (10 rounds)
- **Refresh tokens / OAuth state / OTP codes:** Stored as SHA-256 digests, never in plaintext
- **API Communication:** HTTPS enforced in production (HSTS, `upgrade-insecure-requests`)
- **User Data:** Not sold, never shared with 3rd parties
- **Compliance:** SEBI-labeled via Sentinel audit trail

### Audit Logging

All security-relevant events logged to `AuditEvent` table:

```sql
SELECT * FROM "AuditEvent" 
WHERE "userId" = '...' 
  AND "eventType" IN ('login', 'signup', 'logout', 'order_placed')
ORDER BY "createdAt" DESC;
```

In addition, a dedicated structured security log (`services/api/src/common/security-log.ts`) emits single-line, greppable `[security]` events for auth failures, admin probing, broker OAuth rejections and rejected feed links.

### Application Security (implemented)

The broker OAuth flow and news pipeline received a dedicated hardening pass (July 2026). Each item below is backed by code and, where noted, automated tests.

- ✅ **Per-user broker credential ownership** — `BrokerCredential` is keyed `(provider, userId)`; every method scopes its query to the acting user. No route reads or writes a credential by provider alone (the one shared-feed exception reads only the explicitly designated `isFeedDefault` row).
- ✅ **OAuth state validation** — the `GET /broker/dhan/callback` endpoint (which cannot carry a bearer token) is only honoured when it matches a live state row an *authenticated* user started; the credential is attributed to that row's user, never to anything in the callback request.
- ✅ **Single-use OAuth state** — state consumption is a conditional `UPDATE` that runs *before* the token exchange, so a replayed callback loses the race and exchanges nothing (`consumedAt`).
- ✅ **Replay & CSRF protection** — 256-bit CSPRNG state, SHA-256-hashed at rest, 10-minute TTL, constant-time digest comparison; an `HttpOnly`/`Secure`/`SameSite=Lax` state cookie is a second binding factor; conflicting cookie/query state is refused.
- ✅ **Authorization enforcement / user-scoped access** — authenticated routes derive the subject from the JWT (`req.user.sub`), never from a path/query parameter; where a caller *can* name a user, a mismatch is refused and logged (`denyCrossUserAccess`).
- ✅ **Feed default ownership model** — promoting a credential to the shared live-feed default is an `AdminTokenGuard` operator action, enforced unique by a partial index, so a user cannot elect their own (or anyone else's) token into the platform-wide feed.
- ✅ **RSS URL validation** — every news `<link>` passes an allowlist validator (`news/feed-url.ts`): only `http`/`https`, control-character and length checks, parsed-serialization returned — blocking `javascript:`/`data:`/`blob:`/`file:` click-to-execute XSS in the origin that holds the bearer token.
- ✅ **Feed proxy allowlist** — the web proxy forwards an explicit list of read-only public market-data routes to the bridge instead of a `/feed/:path*` wildcard, so nothing added to the (unauthenticated) bridge becomes public by default (`apps/web/feed-proxy-routes.mjs`).
- ✅ **Security headers** — CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP, `Cache-Control: no-store`, and production-only HSTS — set on both the API (strict `default-src 'none'` for JSON) and the web app.
- ✅ **CORS restrictions** — strict origin allowlist in production; localhost-only relaxation in development; credentials enabled with an explicit `allowedHeaders` list.
- ✅ **Log redaction** — the security logger drops secret-shaped fields by key *and* truncates long opaque strings by shape, so a token cannot reach the log even if a caller passes it (unit-tested).
- ✅ **Admin guard** — operator endpoints gated by `AdminTokenGuard`: fails closed when `ADMIN_API_TOKEN` is unset, constant-time comparison, denials logged.
- ✅ **Secure cookie handling** — a single `serializeSecureCookie` helper sets `HttpOnly`/`Secure`/`SameSite`/`Path`/`Max-Age` by default and rejects delimiter-injection rather than escaping it.
- ✅ **Email-OTP hardening** — enumeration-safe responses, hashed codes, per-code attempt cap, resend cooldown, and supersession of prior live codes.
- ✅ **Security-focused automated tests** — `broker-authz`, `oauth-state`, `dhan-auth.service`, `security-log` (redaction) and `feed-url` suites.

### Remaining Security Roadmap (intentional technical debt)

These are known, deliberately-deferred items — each documented in code where it lives:

- 📅 **Access token encryption at rest** — `BrokerCredential.accessToken` is still plaintext; encrypting it needs a key-management decision, not just a code edit (tracked in `schema.prisma`).
- 📅 **CSP nonce migration** — `script-src` still uses `'unsafe-inline'` because Next's App Router injects inline bootstrap/streaming scripts; moving to middleware-generated nonces is a larger change than a hardening pass should make silently.
- 📅 **Live database verification of the partial index** — the `WHERE isFeedDefault = true` unique index is expressed in raw SQL in the migration (Prisma cannot model it); it should be verified against the live database.
- 📅 **Browser CSP validation** — the enforced policy should be validated end-to-end in a real browser session to confirm no legitimate resource is blocked.

---

## Documentation

### Index of Key Documents

| Document | Purpose | Status |
|----------|---------|--------|
| **[`ARCHITECTURE.md`](ARCHITECTURE.md)** | Technical service boundaries, communication patterns, deployment architecture | 🟢 Current & binding |
| **[`docs/product-architecture/TRADEW-OS.md`](docs/product-architecture/TRADEW-OS.md)** | Platform constitution; product philosophy, non-negotiable rules | 🟢 Current |
| **[`docs/product-architecture/SENTINEL.md`](docs/product-architecture/SENTINEL.md)** | Sentinel Safety Nets system, agent roster, trap detection design | 🟢 Current |
| **[`docs/product-architecture/TRADEW-ASSISTANT.md`](docs/product-architecture/TRADEW-ASSISTANT.md)** | In-app AI assistant (app-control) design and boundaries | 🟢 Implemented |
| **[`docs/product-architecture/SECURITY-AUTHORIZATION.md`](docs/product-architecture/SECURITY-AUTHORIZATION.md)** | Authorization model, broker OAuth threat model | 🟢 Current |
| **[`docs/product-architecture/TRADEW-AI.md`](docs/product-architecture/TRADEW-AI.md)** | Research pillar blueprint, agent roster, workflows | 🚧 Foundation only (`packages/ai-core`) |
| **[`docs/product-architecture/LEARNING-HUB.md`](docs/product-architecture/LEARNING-HUB.md)** | 4th pillar (curated research, continuous learning pipeline) | 🟡 Framework only |
| **[`docs/product-architecture/SENTINEL-KNOWLEDGE-GRAPH.md`](docs/product-architecture/SENTINEL-KNOWLEDGE-GRAPH.md)** | Concept ontology design and runtime learning | 🟢 Implemented |
| **[`docs/design-reference/DESIGN-SYSTEM.md`](docs/design-reference/DESIGN-SYSTEM.md)** | UI components, colors, typography, workspace shell | 🟡 Spec written; components extracting |
| **[`docs/product-architecture/DHAN-MARKET-DATA-INTEGRATION.md`](docs/product-architecture/DHAN-MARKET-DATA-INTEGRATION.md)** | Real market data feed architecture | 🟢 Implemented (live feed bridge) |
| **[`docs/product-architecture/N8N-WORKFLOWS.md`](docs/product-architecture/N8N-WORKFLOWS.md)** | Workflow automation architecture and use cases | 🟡 Planned |
| **[`TRADEW_DEVELOPER_REFERENCE.md`](TRADEW_DEVELOPER_REFERENCE.md)** | Definitive developer reference | 🟢 Reference |
| **[`REPOSITORY_INVENTORY.md`](REPOSITORY_INVENTORY.md)** | A–Z repository inventory audit | 🟢 Reference |
| **[`SENTINEL_MASTER_PLAN.md`](SENTINEL_MASTER_PLAN.md)** | Sentinel build plan and progress | 🟢 Reference |
| **[`knowledge/_INDEX.md`](knowledge/_INDEX.md)** | Engineering knowledge vault, decisions, discoveries | 🟢 Active |
| **[`.claude/CLAUDE.md`](.claude/CLAUDE.md)** | Workspace rules for all Claude Code sessions | 🟢 Active |

### Getting Started Reading Order

**For New Developers:**
1. Read this README (you're here)
2. Read [`ARCHITECTURE.md`](ARCHITECTURE.md) for tech boundaries
3. Read [`docs/product-architecture/TRADEW-OS.md`](docs/product-architecture/TRADEW-OS.md) for product rules
4. Run Quick Start, verify everything works

**For Feature Implementation:**
1. Read the relevant pillar doc (SENTINEL, TRADEW-AI, LEARNING-HUB, etc.)
2. Read [`docs/design-reference/DESIGN-SYSTEM.md`](docs/design-reference/DESIGN-SYSTEM.md) for UI specs
3. Check [`knowledge/`](knowledge/) for related decisions/patterns
4. Write code against the spec

**For Deployment/DevOps:**
1. Read [`ARCHITECTURE.md`](ARCHITECTURE.md) §7 (Deployment)
2. For a single-VPS dev/staging deploy, follow [`infra/docker/DEPLOY-DEV.md`](infra/docker/DEPLOY-DEV.md) end to end (provisioning → DNS → secrets → bring-up → optional operator console)
3. Review [`infra/docker/docker-compose.yml`](infra/docker/docker-compose.yml) (local dev) and [`docker-compose.prod.yml`](infra/docker/docker-compose.prod.yml) + [`docker-compose.admin.yml`](infra/docker/docker-compose.admin.yml) (loopback-only operator console) + [`Caddyfile`](infra/docker/Caddyfile) (production)
4. Review [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) (CI/CD → ghcr.io → Oracle Cloud over SSH)
5. `infra/k8s/` and `infra/terraform/` are notes only (future scaling)

---

## License

This project is licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0).

See [`LICENSE`](LICENSE) for details.

**Summary:**
- You can use, modify, and distribute TradeW
- You must make source code publicly available if you distribute it
- You must disclose modifications
- Software-as-a-service (SaaS) deployments must expose source code to users

---

## Contributors

- **Vivek Sannidhi** — Platform architect, founder
- **Claude (Anthropic)** — Code generation, documentation, architecture guidance

---

## Support

- **Issues:** GitHub Issues (in progress)
- **Documentation:** This README + `docs/` folder
- **Chat:** (In-repo Obsidian knowledge vault for engineering notes)

---

## Citation

If you reference TradeW in academic work or public discussions, please cite:

```bibtex
@software{tradew2026,
  title={TradeW: Modular AI-Powered Trading Platform},
  author={Sannidhi, Vivek},
  year={2026},
  url={https://github.com/viveksannidhi/tradew}
}
```

---

**Last Updated:** 2026-07-29
**Status:** 🟢 Active Development (v0.1.0 · ~80% complete)
