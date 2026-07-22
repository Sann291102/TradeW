# TradeW — Platform, Knowledge, and AI-Powered Intelligence

> A comprehensive, open-architecture trading platform built on modular AI systems, institutional knowledge graphs, and paper-trading simulation. Designed for retail traders and emerging research teams.

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791?logo=postgresql)](https://www.postgresql.org/)
[![NestJS](https://img.shields.io/badge/NestJS-10-E0234E?logo=nestjs)](https://nestjs.com/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)](https://react.dev/)
[![License](https://img.shields.io/badge/License-AGPL%203.0-blue)]()

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

- **Core Platform:** Live market data, charts, portfolio tracking, order management (paper-trading), watchlists, symbol search, option chains
- **TradeW AI (Research):** AI-powered research agents, company/technical/option analysis, news intelligence, strategy builder, portfolio insights
- **Sentinel (Safety Nets):** Behavioral pattern detection, trap recognition, emotional intelligence, compliance logging, market/technical intelligence
- **Learning Hub:** Curated research vault, validated knowledge graph, continuous learning pipeline
- **Paper Trading:** Full order lifecycle with margin simulation (MIS/CNC/NRML), fill reconciliation, P&L tracking

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
│   ├── web/           🟢 Next.js — Core Platform, Research, Sentinel, Learning workspaces
│   ├── admin/         🟡 Internal ops console — KYC, audit logs, DLQ, user mgmt
│   └── mobile/        🟡 React Native — roadmap v0.9
│
├── services/
│   ├── api/           🟢 NestJS — single public ingress, auth, aggregation
│   ├── trading-engine/🟢 Python/Flask — order execution, webhook intake, paper-trading
│   ├── market-data/   🟡 Live quote ingestion, data pipeline
│   ├── tradew-ai/     🟡 Research agents, Claude integration
│   ├── sentinel/      🟢 Safety-net agents, behavioral analysis, ontology
│   ├── notification/  🟡 Alert fanout (email/Slack/push)
│   ├── auth/          🟡 JWT/refresh tokens (extracted from api on demand)
│   └── analytics/     🟡 Portfolio/PnL analytics, eventual ClickHouse aggregation
│
├── packages/
│   ├── database/      🟢 Prisma schema, migrations (centralized)
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
│   ├── docker/        🟢 docker-compose for local dev
│   ├── k8s/           ⚪ Kubernetes manifests (staging/prod)
│   └── terraform/     ⚪ IaC for AWS (VPC, RDS, EKS, ElastiCache)
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
| **apps/web** | Next.js frontend hosting all four platform workspaces (Core, Research, Sentinel, Learning) as a unified shell. Users move between them like switching tabs. | 🟢 Framework in place; workspaces still being built |
| **services/api** | NestJS aggregator — the single public API gateway. Handles auth, rate limiting, order validation, and calls internal services. | 🟢 Running, core routes mapped |
| **services/trading-engine** | Python/Flask paper-trading OMS. Receives TradingView webhooks (HMAC-verified), executes orders, fills trades, tracks positions. | 🟢 Framework present; Python code not yet populated |
| **services/market-data** | Quote ingestion pipeline from Dhan APIs or simulated feed. | 🟡 Planned; currently serves simulated data via `services/api` |
| **services/tradew-ai** | LLM-powered Research agents (Company Analysis, News Analysis, Technical Analysis, Strategy Builder, etc.). | 🟡 Skeleton exists; agent definitions in `agents/tradew-ai/` |
| **services/sentinel** | LLM-powered Safety-net agents (Market & Technical, Emotion, Trap & Safety, Compliance & Audit). Full orchestrator. | 🟢 Skeleton exists; agent definitions and ontology in place |
| **packages/database** | Centralized Prisma schema (27 tables) and migration history. Single source of truth for schema. | 🟢 10 migrations applied, 100% synced |
| **packages/types** | Shared TypeScript DTOs/interfaces — source of truth for all API contracts. | 🟡 Framework exists; incomplete |
| **packages/ui** | Design-system React components extracted from Emergent mockups. Binding for all apps. | 🟡 Design spec in `docs/design-reference/DESIGN-SYSTEM.md`; components still being extracted |
| **knowledge/** | Obsidian vault for durable engineering knowledge (decisions, patterns, discoveries). Not live production data. | 🟢 22 notes; actively updated |

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

- **API Gateway:** NestJS 10 (ExpressJS-compatible)
- **Trading Engine:** Python 3.9+ (Flask)
- **Authentication:** JWT (HS256) + Refresh tokens
- **LLM Integration:** Anthropic Claude API (via `services/tradew-ai` and `services/sentinel`)

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

- **Local Dev:** Docker Compose (PostgreSQL, pgAdmin, trading-engine, api, web)
- **Deployment:** Kubernetes (EKS, ap-south-1)
- **IaC:** Terraform (VPC, RDS Aurora, ElastiCache Redis, S3)
- **CI/CD:** GitHub Actions (path-based triggers per service)
- **Monitoring:** Prometheus + Grafana (Phase 2+)

### Dev Tools

- **Node.js:** 20+
- **TypeScript:** 5.7
- **Package Manager:** npm workspaces
- **Task Runner:** npm scripts
- **Linting:** ESLint (Next.js config)
- **Testing:** Jest (configured but not yet built out)

---

## Features

### ✅ Implemented

- **Authentication & Authorization**
  - JWT-based sign-up/login/refresh
  - User preferences (persistent settings)
  - Audit logging (all events tracked with IP, user agent, metadata)
  - Refresh token rotation

- **Core Platform**
  - Live market data (quote feeds, indices, bid/ask spreads, volume)
  - Instrument catalog (NSE/BSE equities, indices, options, futures)
  - Paper-trading OMS with full order lifecycle (PENDING → OPEN → FILLED/CANCELLED/EXPIRED)
  - Position tracking with daily session snapshots
  - Portfolio dashboard (cash balance, positions, P&L, margin utilization)
  - Order types: MARKET, LIMIT, SL, SL_M
  - Order validity: DAY, IOC
  - Product types: MIS (intraday), CNC (delivery), NRML (F&O carry-forward)

- **AI Foundation**
  - Memory system (MemoryRecord + MemoryRelation) with semantic search
  - pgvector embeddings for similarity matching
  - Knowledge graph (GraphNode + GraphEdge) for entity relationships
  - Namespace-based memory isolation (per-user + global)

- **Sentinel (Safety Nets)**
  - Concept ontology (ConceptNode + ConceptEdge, manually curated, runtime-learnable)
  - Concept observations with audit trail (confirmed/refuted/inconclusive)
  - Behavioral pattern detection framework
  - Trading journal with AI annotations
  - Compliance & Audit agent structure (SEBI-labeling placeholders)
  - Trap detection concept catalog (built-in patterns: bull_trap, fake_breakout, etc.)

- **Subscriptions & Entitlements**
  - Plan-based capability grants (free, pro, premium, enterprise)
  - Usage quota tracking (per-day, per-month, per-billing-cycle)
  - Entitlement overrides (manual grants for testing/support)
  - Trial periods, grace periods, cancellation tracking

- **Database**
  - 27 tables across 7 domains (users, orders, trades, positions, AI memory, ontology, sentinel observations)
  - Full referential integrity with foreign keys
  - Indexes on all hot paths
  - Soft-delete pattern for instruments (deactivate, never remove)

### ⚠️ Partially Implemented

- **Paper Trading Engine**
  - Order acceptance logic works
  - Fill simulation partially complete
  - Margin calculation framework exists (not fully validated)
  - Python bridge not yet populated (Flask skeleton only)

- **Market Data**
  - Quote tables defined
  - Simulated data ingestion works
  - Real Dhan API integration designed but not deployed
  - Option chain structure designed but not populated

- **Sentinel Runtime**
  - Skeleton service exists (`services/sentinel/`)
  - Agent definitions in place (`agents/sentinel/`)
  - Brain service scaffolding for search, strategy, observations
  - **Not yet deployed to production**

- **TradeW AI Runtime**
  - Skeleton service exists (`services/tradew-ai/`)
  - Agent definitions framework in place (`agents/tradew-ai/`)
  - **Agent roster not yet populated**
  - **No runtime orchestration yet**

### ❌ Not Yet Implemented

- **Trading Engine Python Code**
  - `extreme_algo_bot_v2.py` (webhook intake, order execution)
  - `order_poller.py` (fill reconciliation)
  - `pnl_tracker.py` (trade lifecycle)
  - Strategy webhook integration (currently skeleton)

- **Kubernetes Deployment**
  - Manifests outlined but not written
  - Service-to-service mTLS auth not configured
  - Resource limits not defined
  - Health checks not implemented

- **Terraform IaC**
  - AWS infrastructure templates not yet written
  - VPC, RDS, EKS, ElastiCache provisioning not automated
  - DNS, SSL/TLS setup not defined

- **n8n Workflow Automation**
  - Service skeleton planned
  - Workflow definitions not yet created
  - Webhook triggers not configured

- **Public SDK/API**
  - OpenAPI spec generation not yet enabled
  - SDK code generation not configured
  - Phase 3 feature

- **Admin Dashboard**
  - `apps/admin` folder exists
  - No implementation yet
  - Roadmap: KYC review, audit log viewer, DLQ retry, user mgmt

- **Mobile App**
  - `apps/mobile` folder exists
  - No implementation yet
  - Roadmap v0.9

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

### 6. Access the Application

- **Web App:** http://localhost:3000
- **API Health:** http://localhost:4000/health
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

# Frontend
FRONTEND_URL=http://localhost:3000

# Market Data
DHAN_LIVE_URL=http://localhost:4600

# Sentinel Service
SENTINEL_SERVICE_URL=http://localhost:4010
SENTINEL_SERVICE_TOKEN=dev-sentinel-token-change-me-in-prod

# Entitlements
ADMIN_API_TOKEN=sk-ant-api03-...  # Optional; leave empty to disable admin API

# Knowledge Workspace
KNOWLEDGE_WORKSPACE_ENABLED=true
KNOWLEDGE_ROOT=  # Defaults to ../../knowledge relative to service
```

#### Web App (`apps/web/.env.local`)

```bash
# API Gateway
NEXT_PUBLIC_API_URL=http://localhost:4000
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
| `npm run db:generate` | Generate Prisma Client after schema changes |
| `npm run db:migrate` | Run pending database migrations |
| `npm run ontology:validate` | Validate Sentinel concept ontology YAML |
| `npm run ontology:seed` | Seed concept ontology into database |

---

## Database

### Current State

- **Engine:** PostgreSQL 16 with pgvector extension
- **Tables:** 27 across 7 domains
- **Migrations:** 10 applied (all successful as of 2026-07-23)
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

| Domain | Tables | Purpose |
|--------|--------|---------|
| **User & Auth** | User, RefreshToken, UserPreference | Sign-up/login, token management, user settings |
| **Trading** | Order, Trade, Position, PaperWallet | Paper-trading OMS, order lifecycle, portfolio |
| **Market Data** | Instrument, Quote | Symbol catalog, live quotes |
| **AI Memory** | MemoryRecord, MemoryRelation | Semantic memory, embeddings |
| **Knowledge Graph** | GraphNode, GraphEdge | Entity relationships |
| **Sentinel Ontology** | ConceptNode, ConceptEdge, ConceptObservation, ConceptPromotion | Concept definitions, learned patterns, promotion queue |
| **Sentinel Runtime** | SentinelObservation, JournalEntry | Observations (audit trail), trading journal |
| **Subscriptions** | Plan, PlanGrant, Subscription, UsageCounter, EntitlementOverride | Capabilities, quota tracking, overrides |
| **News** | NewsEvent | Financial news classification |

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

**Status:** 🟡 Skeleton exists; agent roster not yet populated

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

**Status:** 🟢 Skeleton + ontology complete; agent orchestration partially implemented

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

- **Unit Tests:** Jest (not yet implemented; framework in place)
- **Integration Tests:** E2E tests planned
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

---

## Project Status

### What's Working (Verified 2026-07-23)

✅ Database schema (27 tables, 100% synced)
✅ API server (NestJS, all core routes)
✅ Frontend framework (Next.js, workspace scaffolding)
✅ Authentication (JWT, refresh tokens, audit logging)
✅ Paper-trading OMS (order lifecycle, positions, P&L simulation)
✅ Subscriptions & Entitlements (plan-based capability grants)
✅ AI Memory system (MemoryRecord + search)
✅ Sentinel Ontology (ConceptNode + learned patterns)
✅ Docker Compose (local dev working)
✅ pgAdmin integration (database inspection)

### What's Incomplete

⚠️ Trading engine Python code (skeleton only, needs population)
⚠️ Sentinel agent orchestration (framework exists, not fully implemented)
⚠️ TradeW AI agent roster (placeholders, not populated)
⚠️ Market data real feed (Dhan integration designed, not deployed)
⚠️ Kubernetes deployment (manifests not written)
⚠️ Terraform IaC (cloud infrastructure)
⚠️ n8n workflow automation (service planned, not deployed)
⚠️ Admin dashboard (folder exists, no code)
⚠️ Mobile app (folder exists, no code)

### Known Issues & Technical Debt

| Issue | Severity | Notes |
|-------|----------|-------|
| Trading engine not populated | HIGH | Python code from `extreme_algo_package` needs migration |
| No automated tests | MEDIUM | pytest dependency declared but no tests written |
| Sentinel agent orchestration incomplete | MEDIUM | Skeleton exists; full invocation logic needed |
| Market data uses simulation only | MEDIUM | Real Dhan feed designed; not yet deployed |
| No service-to-service mTLS | MEDIUM | Shared secrets only (service tokens); upgrade for prod |
| Admin app not started | LOW | Roadmap v0.5+ feature |
| Mobile app not started | LOW | Roadmap v0.9+ feature |
| Dead Letter Queue worker missing | MEDIUM | Table exists; retry worker not built |

---

## Roadmap

### Immediate (Next 2 Weeks)

- [ ] Populate Python trading engine code
- [ ] Deploy real Dhan market data feed
- [ ] Complete Sentinel agent orchestration
- [ ] Add automated tests (Core Platform OMS)

### Q3 2026 (Sprint Focus)

- [ ] Complete TradeW AI agent roster
- [ ] Launch Research workspace
- [ ] Implement n8n workflow automation
- [ ] Add Kubernetes deployment manifests
- [ ] Setup GitHub Actions CI/CD pipeline

### Q4 2026 (Scaling Phase)

- [ ] Write Terraform IaC (AWS provisioning)
- [ ] Deploy to staging Kubernetes cluster
- [ ] Build admin dashboard
- [ ] Implement real Sentinel brain (full orchestration)
- [ ] Add automated tests for API + agent system

### 2027 (Beyond MVP)

- [ ] Mobile app (React Native)
- [ ] Public SDK (OpenAPI + generated clients)
- [ ] ClickHouse analytics backend
- [ ] Redis Streams event bus
- [ ] TradingView integration workspace
- [ ] n8n workflow templates (alerts, reports, backtesting)

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
| DATABASE_URL | Postgres connection | On credential rotation (RDS) |
| ADMIN_API_TOKEN | Admin endpoint protection | Every quarter |

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
│ - Validates credentials                                      │
│ - Issues accessToken (5m) + refreshToken (30d)               │
│ - Stores refreshToken hash in database                       │
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
- **API Communication:** HTTPS required in production
- **Order Data:** Encrypted at rest (Postgres transparent encryption)
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

---

## Documentation

### Index of Key Documents

| Document | Purpose | Status |
|----------|---------|--------|
| **[`ARCHITECTURE.md`](ARCHITECTURE.md)** | Technical service boundaries, communication patterns, deployment architecture | 🟢 Current & binding |
| **[`docs/product-architecture/TRADEW-OS.md`](docs/product-architecture/TRADEW-OS.md)** | Platform constitution; product philosophy, non-negotiable rules | 🟢 Current |
| **[`docs/product-architecture/SENTINEL.md`](docs/product-architecture/SENTINEL.md)** | Sentinel Safety Nets system, agent roster, trap detection design | 🟢 Current |
| **[`docs/product-architecture/TRADEW-AI.md`](docs/product-architecture/TRADEW-AI.md)** | Research pillar blueprint, agent roster, workflows | 🟡 Framework only |
| **[`docs/product-architecture/LEARNING-HUB.md`](docs/product-architecture/LEARNING-HUB.md)** | 4th pillar (curated research, continuous learning pipeline) | 🟡 Framework only |
| **[`docs/product-architecture/SENTINEL-KNOWLEDGE-GRAPH.md`](docs/product-architecture/SENTINEL-KNOWLEDGE-GRAPH.md)** | Concept ontology design and runtime learning | 🟢 Implemented |
| **[`docs/design-reference/DESIGN-SYSTEM.md`](docs/design-reference/DESIGN-SYSTEM.md)** | UI components, colors, typography, workspace shell | 🟡 Spec written; components extracting |
| **[`docs/product-architecture/DHAN-MARKET-DATA-INTEGRATION.md`](docs/product-architecture/DHAN-MARKET-DATA-INTEGRATION.md)** | Real market data feed architecture | 🟡 Designed; not deployed |
| **[`docs/product-architecture/N8N-WORKFLOWS.md`](docs/product-architecture/N8N-WORKFLOWS.md)** | Workflow automation architecture and use cases | 🟡 Planned |
| **[`CONSOLIDATION-PLAN.md`](CONSOLIDATION-PLAN.md)** | Audit of existing code, what to keep/archive, tech debt | 🟢 Reference (historical) |
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
2. Review [`infra/docker/`](infra/docker/) (local dev setup)
3. Review [`infra/k8s/`](infra/k8s/) and [`infra/terraform/`](infra/terraform/) (staging/prod)

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

**Last Updated:** 2026-07-23
**Status:** 🟢 Active Development (v0.1.0)
