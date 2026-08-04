# TradeW Developer Reference

**Master Handbook for TradeW Codebase Navigation & Implementation**

Status: **Comprehensive repository reverse-engineering**, based on actual code inspection of the monorepo as of 2026-07-23. This is the authoritative developer guide for all future work on TradeW.

---

## 1. Executive Architecture Overview

### 1.1 System Overview

TradeW is a **multi-pillar trading platform** serving four distinct product pillars — all within one web application shell — backed by independent service runtimes where appropriate:

```
┌─────────────────────────────────────────────────────────────────┐
│                     apps/web (Next.js)                          │
│  ┌─────────────┬──────────────┬──────────────┬──────────────┐   │
│  │ Core        │ TradeW AI    │ Sentinel     │ Learning     │   │
│  │ Platform    │ (Research)   │ (Safety Nets)│ Hub          │   │
│  └─────────────┴──────────────┴──────────────┴──────────────┘   │
└─────────────────────────────────────────────────────────────────┘
           │                │                  │
      ┌────▼────┐      ┌────▼────┐      ┌─────▼──────┐
      │services/│      │services/│      │services/   │
      │api      │      │tradew-ai│      │sentinel    │
      └────┬────┘      └────┬────┘      └─────┬──────┘
           │                │                  │
      ┌────▼────────────────▼──────────────────▼────┐
      │  packages/database (Prisma schema)         │
      │  PostgreSQL + pgvector (embeddings)        │
      └────┬──────────────────────────────────────┘
           │
      ┌────▼──────────────────────────────────┐
      │ Core Services:                         │
      │ • trading-engine (Python/Flask)        │
      │ • market-data (Node)                   │
      │ • notification (future)                │
      │ • analytics (future)                   │
      └────────────────────────────────────────┘
```

### 1.2 High-Level Data Flow

**Request Path (User → Platform):**
1. User action in `apps/web` → API call via `packages/sdk` or direct HTTP
2. `services/api` validates session, checks entitlements
3. For trading: `services/api` calls `services/trading-engine` internal REST API (service-token auth)
4. For AI: `services/api` calls `services/tradew-ai` or `services/sentinel` (internal endpoints)
5. Response merged and returned to client

**Order Execution Path:**
- TradingView webhook → `services/trading-engine` directly (HMAC-verified, latency-sensitive)
- `services/trading-engine` executes against paper broker (`mock_dhanhq.py`) or real Dhan
- Fills polled by `order_poller.py`, persisted to Postgres via `services/api` writes
- Portfolio/PnL recomputed on-demand by `services/api`

**Market Data Path:**
- Real-time: Dhan WebSocket subscription (when enabled) or simulated ticks
- Quote updates flow to `packages/database` Quote model (one row per instrument, updated in-place)
- Frontend subscribes to `apps/web`'s live-quote hook, polls `/api/market-data/quote/:symbol`

**Knowledge & Memory Path:**
- Sentinel observations → `SentinelObservation` table (append-only audit log)
- Memory records → `MemoryRecord` + `MemoryRelation` (pgvector embeddings for retrieval)
- Concept graph → `ConceptNode`, `ConceptEdge`, `ConceptObservation` (Sentinel's reasoning ontology)

### 1.3 Core Principles

Per `ARCHITECTURE.md` §1:

1. **One public ingress**: All client requests → `services/api` only (no direct calls to trading-engine, sentinel, etc.)
2. **No AI-initiated trades**: TradeW AI and Sentinel analyze and explain; they never call the order engine or execute trades
3. **Separate AI systems**: `services/tradew-ai` and `services/sentinel` are independent runtimes with different agent rosters and compliance postures
4. **Service-to-service auth**: Internal APIs (`trading-engine`, `sentinel`, etc.) authenticated with shared secrets, not end-user JWTs
5. **One schema owner per table**: `services/api` owns most tables; `trading-engine` owns its legacy SQLite (eventual migration planned)

---

## 2. Repository Map

### 2.1 Directory Structure

```
TradeW/
├── apps/
│   ├── web/              Next.js 14 trader-facing application (all four pillars)
│   ├── admin/            Internal ops console (not yet implemented)
│   ├── mobile/           React Native stub (roadmap v0.9, not yet started)
│   └── terminal/         Legacy TUI (references only, not active)
│
├── services/
│   ├── api/              NestJS — BFF, aggregates trading-engine/sentinel/ai data
│   ├── auth/             Extracted auth contract (module lives in api/ for now)
│   ├── trading-engine/   Python/Flask — paper trading OMS, webhook ingestion
│   ├── market-data/      Node/Express — Dhan scrip-master sync, quote ingestion
│   ├── sentinel/         Node/NestJS — Safety Nets runtime (four agents + orchestrator)
│   ├── tradew-ai/        Node/NestJS — Research runtime (eight agents)
│   ├── notification/     Placeholder for alert fanout
│   └── analytics/        Placeholder for portfolio analytics
│
├── packages/
│   ├── database/         Prisma schema + migrations (single Postgres schema owner)
│   ├── types/            Shared TypeScript DTOs/interfaces (API contracts)
│   ├── ui/               Design-system components (extracted from web as they stabilize)
│   ├── shared/           Config loader, structured logger, error types
│   ├── sdk/              Typed API client (future public developer API)
│   ├── ai-core/          AI foundation libraries (memory, brain, agents)
│   └── market-data/      Market data types and utilities
│
├── agents/
│   ├── sentinel/         Declarative agent definitions (YAML/JSON), Sentinel runtime only
│   └── tradew-ai/        Declarative agent definitions (YAML/JSON), Research runtime only
│
├── workflows/            n8n workflow JSON exports (versioned, not running in-repo)
├── docs/                 Product architecture + design reference
├── knowledge/            Obsidian vault (engineering memory, durable notes for developers)
├── knowledge-base/       Concept ontology YAML (Sentinel's reasoning layer)
├── infra/                Docker, Kubernetes, Terraform (deployment)
├── scripts/              Repo-wide tooling (seed, migrate, etc.)
└── archive/              Superseded code (kept, not deleted per CLAUDE.md Rule 1)
```

### 2.2 Key Applications

#### 2.2.1 apps/web — Next.js 14 Trader Platform

**Purpose**: Single-page trading platform serving all four pillars (Core, AI, Sentinel, Learning)

**Structure**:
```
apps/web/src/
├── app/                  Next.js App Router pages
│   ├── dashboard/        Dashboard page (portfolio overview)
│   ├── trade/            Trading terminal (workspace layout)
│   ├── markets/          Market workspace (watchlist, screener, charts)
│   ├── portfolio/        Portfolio detail page
│   ├── research/         Research deep-dive workspace
│   ├── sentinel/         Safety Nets workspace
│   ├── learning/         Learning Hub workspace
│   ├── knowledge/        Knowledge Graph visualization
│   ├── notifications/    Notifications center
│   ├── login/            Auth entry point
│   ├── signup/           Account creation
│   ├── settings/         User preferences
│   ├── profile/          Profile editor
│   └── layout.tsx        App shell (shell/*, workspace/*, navigation)
│
├── components/
│   ├── shell/            Top bar, sidebar, theme menu, notifications
│   ├── workspace/        Dockable layout engine, command palette, shortcuts
│   ├── dashboard/        Portfolio summary, market widgets, news feed
│   ├── terminal/         Blotter, chart, depth, option chain, news panels
│   ├── markets/          Market workspace panels
│   ├── trade/            Trade execution workspace
│   ├── sentinel/         Sentinel-specific components (briefing, timeline)
│   ├── charts/           Chart components (TradingView integration)
│   └── [feature]/        Feature-specific components
│
├── lib/
│   ├── hooks/            React hooks (useCandles, useLiveQuotes, useSentinel)
│   ├── store/            Zustand state (sessionStore, workspaceStore, tradeBasketStore)
│   ├── mock/             Mock data (candles, market data, learning content)
│   ├── sentinel/         Sentinel client logic (context derivation, hooks)
│   ├── search/           Search providers and types
│   ├── api.ts            Fetch-based API client
│   ├── marketData.ts     Market data aggregation
│   ├── oms.ts            Order management system client
│   ├── knowledge.ts      Knowledge graph client
│   ├── technicals.ts     Technical indicator calculations
│   ├── black-scholes.ts  Options pricing
│   ├── dhanLiveFeed.ts   Dhan WebSocket integration (stubbed)
│   ├── analytics.ts      Segment/event tracking
│   └── format.ts         Formatting utilities
│
└── public/               Static assets
```

**Technology Stack**:
- Framework: Next.js 14 (React 18)
- Styling: Tailwind CSS + PostCSS
- State: Zustand (lightweight, no reducer boilerplate)
- Charting: lightweight-charts (TradingView alternative)
- Markdown: react-markdown + remark-gfm
- Diagrams: Mermaid for knowledge graph
- Animations: Framer Motion

**Key Features**:
- Workspace continuity (Zustand store hydrated from localStorage + sessionStore)
- Dockable panels (splitter-based layout)
- Command palette (Cmd+K)
- Multi-chart terminal
- Real-time quotes (polling-based)
- Paper trading OMS integration
- Sentinel context-aware observations
- Knowledge graph visualization

#### 2.2.2 services/api — NestJS BFF & Aggregator

**Purpose**: Single public ingress for all client requests. Aggregates data from trading-engine, sentinel, tradew-ai, market-data.

**Structure**:
```
services/api/src/
├── app.module.ts        Main module, imports all sub-modules
├── main.ts              Bootstrap (CORS, validation pipe, port binding)
├── health.controller.ts  /health endpoint
│
├── auth/                JWT, refresh tokens, guards, auth controller
│   ├── auth.guard.ts    @UseGuards(AuthGuard) for protected routes
│   ├── auth.service.ts  Login, logout, token refresh, password reset
│   ├── auth.controller.ts POST /auth/login, /auth/refresh, /auth/logout
│   └── auth.module.ts
│
├── entitlements/        Subscription, plan grants, usage quotas
│   ├── entitlements.service.ts  canAccess(userId, 'sentinel')
│   └── entitlements.controller.ts GET /entitlements
│
├── instruments/         Instrument catalog (symbols, metadata, Dhan mappings)
│   ├── instruments.service.ts  Get by symbol, search, list
│   └── instruments.controller.ts GET /instruments, GET /instruments/:symbol
│
├── market-data/         Quote retrieval, real-time subscriptions
│   ├── market-data.service.ts  Fetch from Quote table, call services/market-data
│   └── market-data.controller.ts GET /market-data/quote/:symbol
│
├── sim/                 Paper trading OMS (orders, trades, positions, portfolio)
│   ├── sim.service.ts   Place order, cancel, compute portfolio, PnL
│   ├── portfolio.service.ts  Get wallet, positions, daily PnL, realized PnL
│   ├── order.service.ts  Get order, list orders, cancel order
│   └── sim.controller.ts  API endpoints for all above
│
├── sentinel/            Sentinel integration
│   ├── sentinel.service.ts  Call services/sentinel internal API
│   └── sentinel.controller.ts  POST /sentinel/invoke/:agentName
│
├── knowledge/           Memory and knowledge graph
│   ├── knowledge.service.ts  Memory retrieval, graph queries
│   └── knowledge.controller.ts  GET /knowledge/memories, /graph/nodes
│
├── prisma/              Database connection (PrismaClient)
│   └── prisma.module.ts
│
└── main.ts              Entry point
```

**API Endpoints**:
- `POST /auth/login` — Email + password → JWT + refresh token
- `POST /auth/refresh` — Refresh token → new JWT
- `GET /auth/profile` — Current user profile
- `GET /instruments` — List instruments
- `GET /instruments/:symbol` — Get by symbol (canonical lookup key)
- `GET /market-data/quote/:symbol` — Current quote
- `GET /sim/positions` — User's open positions
- `GET /sim/orders` — User's order history
- `POST /sim/order` — Place order (market, limit, SL, SL_M)
- `DELETE /sim/order/:id` — Cancel order
- `GET /sim/portfolio` — Wallet, total PnL, margin used
- `POST /sentinel/invoke/:agent` — Call Sentinel agent
- `GET /knowledge/memories` — Memory retrieval with embedding similarity
- `GET /knowledge/graph/nodes` — Concept graph nodes

**Module Dependencies**:
- `@prisma/client` — Postgres ORM
- `@nestjs/jwt` — Token signing/verification
- `bcryptjs` — Password hashing
- `class-validator`, `class-transformer` — DTO validation

#### 2.2.3 services/sentinel — Safety Nets Runtime

**Purpose**: Runs Sentinel's four agents (Market & Technical, Emotion, Trap & Safety, Compliance & Audit) plus Orchestrator. Produces user-facing safety observations.

**Structure**:
```
services/sentinel/src/
├── brain/               Concept ontology and reasoning engine
│   ├── ontology/        Domains, relations, pattern definitions
│   ├── loader.ts        Load ontology YAML from knowledge-base/
│   └── reasoner.ts      Compute trap signals, combine evidence
│
├── intelligence/        Agent implementations
│   ├── market-technical.agent.ts   OHLC, volume, RSI, EMA, OI patterns
│   ├── emotion.agent.ts            User behavior, entry pacing, discipline
│   ├── trap-safety.agent.ts        Composite trap detection
│   └── compliance-audit.agent.ts   Observation logging, SEBI labels
│
├── orchestrator/        Synthesizer
│   ├── orchestrator.service.ts     Combine four agents → user-facing warning
│   └── orchestrator.controller.ts
│
├── explain/             Explanation generation
│   ├── explain.service.ts  Generate human-readable output for warnings
│
├── market-data/         Read-only market data access
│   ├── market-data.service.ts  Fetch quotes, candles, option chains
│
├── compliance/          Audit trail recording
│   ├── compliance.service.ts  Log observations to DB, SEBI categorization
│
└── scripts/             Seeding, migration
    └── seed-ontology.ts  Load knowledge-base/ YAML → ConceptNode DB
```

**Agent Roster** (all produce structured observations):

1. **Market & Technical Intelligence**
   - Input: OHLC candles, volume, open interest, RSI, EMA, VWAP, CPR
   - Output: Technical patterns, support/resistance levels, breakout risk
   - Calls: services/market-data for live feeds, options chains

2. **Emotion Intelligence**
   - Input: User's own order/trade history, session timing, position sizing
   - Output: Behavioral risk flags (FOMO, revenge trading, averaging down, discipline drift)
   - Calls: services/api for user's trades, orders (read-only)

3. **Trap & Safety Intelligence**
   - Input: Market & Technical output, Emotion output, news feed
   - Output: Composite trap signals (bull trap, bear trap, liquidity sweep, fake breakout, etc.)
   - Combines signals before warning (no single-signal alerts)

4. **Compliance & Audit**
   - Input: Observations from all three above
   - Output: SEBI-categorized audit log entries
   - Logs every observation with evidence

5. **Sentinel Orchestrator**
   - Input: Outputs from all four agents
   - Output: Single user-facing warning or reflection
   - Only consumer that talks to user; other agents produce internal only

**Trap Detection Signals**:
- Fake breakout (price crosses, volume doesn't)
- Bull/bear trap (reversal after breakout/breakdown)
- Liquidity sweep (wick through stop cluster, reverses)
- Stop-hunt detection (sharp wick, no follow-through)
- FOMO entries (user entering after large move)
- Chasing green candles (repeated entries after up candles)
- Averaging down emotionally (adding into losses without plan)
- Revenge trading (entry within time window of losing exit)
- Low-volume breakout (breakout with below-average volume)
- News-driven volatility (breakout coinciding with unscheduled news)
- Expiry-day traps (pin/whipsaw action near option expiry)
- Gamma squeeze / IV crush (OI concentration, IV collapsing)
- High-risk market conditions (elevated VIX, poor breadth)

**Database Tables**:
- `SentinelObservation` (append-only audit log of all observations)
- `ConceptNode` (ontology concepts: "bull-trap", "liquidity-sweep", etc.)
- `ConceptEdge` (relationships between concepts)
- `ConceptObservation` (when a concept was observed in the market/user's trades)
- `ConceptPromotion` (human review queue for learned concepts)

#### 2.2.4 services/trading-engine — Python/Flask Paper OMS

**Purpose**: Simulated trading engine. Accepts TradingView webhooks, manages order lifecycle, computes fills, tracks positions.

**Components** (from audited codebase):
- `extreme_algo_package/` — Core: order models, position tracking, margin simulation
- `tradew_live_runner.py` — Paper broker simulation, quote polling
- `order_poller.py` — Fills reconciliation (polled, not event-driven)
- Dhan broker integration (when live mode enabled)
- HMAC webhook verification (TradingView strategy alerts)

**Key Files**:
- `strategies/` — TradingView-originated strategy webhooks (not executed directly, just logged)
- `models.py` — Order, Position, Trade, PaperWallet SQLite models
- `app.py` — Flask server, REST endpoints, webhook handler
- `mock_dhanhq.py` — Paper broker mock (fills orders immediately, simulates margin)

**REST API** (internal, called by services/api):
- `GET /positions` — User's open positions
- `GET /orders` — Order history
- `POST /order` — Place order
- `DELETE /order/:id` — Cancel order
- `GET /wallet` — Paper cash balance, margin used, PnL

**Database**: SQLite (legacy, eventual Postgres migration planned)

#### 2.2.5 services/market-data — Quote & Instrument Ingestion

**Purpose**: Manages quote updates, instruments catalog, Dhan scrip-master sync.

**Modules**:
- `ingestion/` — WebSocket subscription (Dhan live feed)
- `instruments/` — Scrip-master import, symbol resolution
- `scrip-master/` — Dhan API integration for instrument metadata

**REST API** (internal):
- `GET /quote/:symbol` — Current quote from DB
- `POST /quote/update` — Batch quote updates
- `GET /instruments` — Instruments catalog
- `POST /instruments/sync` — Re-fetch from Dhan scrip-master

### 2.3 Shared Packages

#### 2.3.1 packages/database

**Prisma Schema** (single source of truth):
- 720-line schema.prisma with 20+ models
- PostgreSQL only (postgresqlExtensions enabled for pgvector)
- Owners:
  - `services/api` — most tables (User, Order, Trade, Position, Subscription, etc.)
  - `trading-engine` — legacy SQLite, eventually migrated
  - Shared — Instrument, Quote (ingestion target)

**Key Models**:
- **User** — email, password hash, country, preferences, subscriptions
- **Subscription / Plan / PlanGrant** — entitlements (Sentinel, Research, etc.)
- **Instrument** — unified symbol lookup, Dhan mappings (securityId, exchangeSegment)
- **Quote** — live price data (one row per instrument, updated in-place)
- **Order, Trade, Position, PaperWallet** — trading state
- **MemoryRecord, MemoryRelation** — AI memory engine (pgvector embeddings)
- **ConceptNode, ConceptEdge, ConceptObservation** — Sentinel's knowledge graph
- **SentinelObservation** — audit trail of every agent observation
- **NewsEvent** — classified financial news (13-category event types)

**Migrations**:
- `20260710000000_init` — Core tables
- `20260710000100_sprint1_identity` — Auth and subscriptions

#### 2.3.2 packages/types

**Purpose**: Shared TypeScript interfaces (API contracts, DTOs).

**Exports** (from index.ts):
- `AuthDTOs` — LoginRequest, LoginResponse, RefreshTokenRequest
- `SubscriptionDTOs` — Subscription, Plan, PlanGrant, EntitlementCheckResponse
- `TradingDTOs` — PlaceOrderRequest, OrderResponse, PortfolioResponse
- `MarketDataDTOs` — QuoteResponse, CandleResponse, OptionChainResponse
- `SentinelDTOs` — ObservationResponse, TrapSignalResponse
- Market data enums — InstrumentType, OrderSide, OrderType, OrderStatus

#### 2.3.3 packages/ui

**Status**: Early-stage; components extracted from apps/web as they stabilize.

**Planned Coverage** (not yet fully extracted):
- Layout components (Sidebar, TopBar, DockSlot, Splitter)
- Form controls (Input, Button, Select, Checkbox)
- Cards (StatCard, PortfolioSummary, TrapAlert)
- Charts (ChartWrapper, candlestick, volume bars)
- Design tokens (colors, typography, spacing from DESIGN-SYSTEM.md)

**Design System Reference**: `docs/design-reference/DESIGN-SYSTEM.md` (extracted from Emergent mockups, binding spec for all UI)

#### 2.3.4 packages/shared

**Purpose**: Common Node.js utilities used by every NestJS service.

**Exports**:
- `ConfigLoader` — fail-fast env validation
- `StructuredLogger` — JSON logging with levels (info, warn, error, debug)
- `AppError`, `ValidationError`, `NotFoundError` — common error types
- `retry` utility — exponential backoff retry wrapper

#### 2.3.5 packages/ai-core

**Status**: Foundation library (pre-implementation; not yet fully integrated).

**Planned Coverage**:
- `agents/` — Agent interface, base implementation
- `brain/` — Knowledge graph traversal, reasoning
- `memory/` — In-memory and persistent memory backends
- `context/` — Execution context, session state
- `graph/` — Entity and concept graph operations

---

## 3. Complete Feature Registry

### 3.1 Core Platform Features

#### Feature: Paper Trading (Order Management System)

| Attribute | Value |
|---|---|
| **Status** | Production Ready (working) |
| **Business Purpose** | Risk-free practice trading with simulated $1M capital |
| **Entry Point** | `/trade` route in `apps/web` |
| **User Flow** | Dashboard → Trade Terminal → Place Order → Monitor Blotter → Close Position |
| **UI Components** | `TerminalWorkspace`, `OrdersPanel`, `BlotterPanel`, `QuickActionsDock` |
| **Backend Modules** | `services/api/sim/`, `services/trading-engine` |
| **Controllers** | `SimController` in api, Flask routes in trading-engine |
| **Services** | `SimService`, `OrderService`, `PortfolioService` (api) |
| **Database Tables** | Order, Trade, Position, PaperWallet, Instrument, Quote |
| **Prisma Models** | Order (status flow: PENDING → OPEN → FILLED/CANCELLED), Trade (fills), Position (open), PaperWallet (cash) |
| **APIs Used** | POST /sim/order, GET /sim/orders, DELETE /sim/order/:id, GET /sim/positions, GET /sim/portfolio |
| **Environment Variables** | TRADING_ENGINE_URL (internal endpoint), PAPER_CAPITAL (default 1M) |
| **External Dependencies** | None (fully simulated) |
| **Related Files** | apps/web/src/lib/oms.ts, services/api/src/sim/*, services/trading-engine/app.py |
| **Feature Owner** | Core Platform |
| **Known Limitations** | No actual fills; margin simulation approximate; no bracket orders yet |
| **Technical Debt** | Trading-engine uses SQLite (eventual Postgres migration); order-poller polling-based not event-driven |
| **Future Improvements** | Bracket/OCO orders, real broker live mode (Dhan), predictive margin warnings |

#### Feature: Market Data & Quotes

| Attribute | Value |
|---|---|
| **Status** | Working (simulated data, real Dhan integration pending) |
| **Business Purpose** | Real-time price data for charts, technicals, risk calculations |
| **Entry Point** | Dashboard, Charts, Depth panel, all market-watching workspaces |
| **User Flow** | Open Chart → Data loads → Real-time ticks update → Indicator recalc |
| **UI Components** | `TradeChart` (lightweight-charts), `DepthPanel`, `MarketsTab` |
| **Backend Modules** | `services/market-data/`, `services/api/market-data/` |
| **Controllers** | `MarketDataController` in api; n/a in market-data (internal REST only) |
| **Services** | `MarketDataService` (api), ingestion service (market-data) |
| **Database Tables** | Instrument (metadata + Dhan mappings), Quote (one per instrument) |
| **Prisma Models** | Instrument (symbol, display name, type, exchange, Dhan securityId/exchangeSegment), Quote (ltp, bid/ask, volume) |
| **APIs Used** | GET /market-data/quote/:symbol, GET /instruments/:symbol |
| **Environment Variables** | DHAN_API_KEY, DHAN_CLIENT_ID (when live feed enabled), QUOTE_UPDATE_INTERVAL_MS |
| **External Dependencies** | Dhan REST API (scrip-master, live quotes), WebSocket (future) |
| **Related Files** | apps/web/src/lib/marketData.ts, apps/web/src/lib/mock/*, services/market-data/src/*, services/api/src/market-data/* |
| **Feature Owner** | Core Platform |
| **Known Limitations** | Currently simulated; Dhan WebSocket subscription stubbed; only 150 seeded instruments |
| **Technical Debt** | Ingestion logic split between market-data and api; Dhan API error handling incomplete |
| **Future Improvements** | Real Dhan WebSocket, multi-provider abstraction, historical candle replay |

#### Feature: Portfolio & PnL

| Attribute | Value |
|---|---|
| **Status** | Working |
| **Business Purpose** | Track holdings, realized/unrealized PnL, margin usage, daily performance |
| **Entry Point** | Dashboard (summary), Portfolio page (detail) |
| **User Flow** | Dashboard loads → Portfolio summary rendered → Click "View Full" → Detailed portfolio page |
| **UI Components** | `PortfolioSummary`, portfolio detail page, position rows with P&L columns |
| **Backend Modules** | `services/api/sim/` (PortfolioService) |
| **Controllers** | `SimController` (GET /sim/portfolio) |
| **Services** | `PortfolioService` — computes wallet, open positions, daily/lifetime PnL |
| **Database Tables** | PaperWallet, Position, Order, Trade, Quote, Instrument |
| **Prisma Models** | PaperWallet (startingBalance, cashBalance, marginUsed, realizedPnl), Position (quantity, avgPrice, realizedPnl, sessionOpenQty/Avg/MarketPrice) |
| **APIs Used** | GET /sim/portfolio, GET /sim/positions |
| **Environment Variables** | None directly; PAPER_CAPITAL affects wallet creation |
| **External Dependencies** | services/trading-engine (read-only position sync, future) |
| **Related Files** | services/api/src/sim/portfolio.service.ts, apps/web/src/components/dashboard/PortfolioSummary.tsx |
| **Feature Owner** | Core Platform |
| **Known Limitations** | Daily PnL anchor (sessionOpenQty, etc.) only valid within a trading day; no multi-currency support; margin calcs simplified |
| **Technical Debt** | PnL calculations duplicated (api + trading-engine); session boundaries hardcoded (IST calendar day) |
| **Future Improvements** | Real-time PnL streaming via WebSocket, multi-day tracking, dividend/corporate-action adjustments |

#### Feature: Watchlist & Screener

| Attribute | Value |
|---|---|
| **Status** | Partial (UI exists, backend filters stubbed) |
| **Business Purpose** | Monitor favorite instruments, scan market conditions |
| **Entry Point** | Markets workspace, sidebar quick links |
| **User Flow** | Click "Markets" → Watchlist panel loads → Add instruments → Monitor real-time changes |
| **UI Components** | `MarketsWorkspace`, `WatchlistPanel`, screener filters |
| **Backend Modules** | TBD (screener logic not yet implemented) |
| **Controllers** | TBD |
| **Services** | TBD |
| **Database Tables** | UserPreference (stores watchlist as JSON under key "watchlist") |
| **Prisma Models** | UserPreference (userId, key="watchlist", value=JSON array of symbols) |
| **APIs Used** | GET /auth/profile (contains preferences), PUT /auth/preferences (future) |
| **Environment Variables** | None |
| **External Dependencies** | None |
| **Related Files** | apps/web/src/components/markets/MarketsWorkspace.tsx, apps/web/src/lib/mock/market.ts |
| **Feature Owner** | Core Platform |
| **Known Limitations** | No persistent watchlist backend; screener UI present but filters not wired; no custom columns |
| **Technical Debt** | Screener backend not implemented; watchlist stored as JSON string, not relational model |
| **Future Improvements** | Relational watchlist table, advanced screener (P/E, sector, market cap filters), alerts on watchlist changes |

#### Feature: Authentication & Authorization

| Attribute | Value |
|---|---|
| **Status** | Production Ready |
| **Business Purpose** | User identity, session management, entitlement checks |
| **Entry Point** | `/login`, `/signup` routes |
| **User Flow** | Signup → Email validation (stubbed) → JWT issued → Stored in sessionStore → Refresh on expiry |
| **UI Components** | LoginForm, SignupForm (pages), SettingsClient (profile edit) |
| **Backend Modules** | `services/api/auth/` |
| **Controllers** | `AuthController` — login, logout, refresh, profile, password reset (partial) |
| **Services** | `AuthService` — hashing, token generation, validation |
| **Database Tables** | User, RefreshToken |
| **Prisma Models** | User (email, passwordHash, country, experienceLevel), RefreshToken (tokenHash, expiresAt, revokedAt) |
| **APIs Used** | POST /auth/login, POST /auth/refresh, GET /auth/profile, POST /auth/logout |
| **Environment Variables** | JWT_SECRET, JWT_EXPIRY, REFRESH_TOKEN_EXPIRY, PASSWORD_RESET_URL_BASE |
| **External Dependencies** | bcryptjs (hashing) |
| **Related Files** | services/api/src/auth/*, apps/web/src/app/login/*, apps/web/src/app/signup/* |
| **Feature Owner** | Core Platform |
| **Known Limitations** | Email verification stubbed (no email service); password reset incomplete; no 2FA; no OAuth integration |
| **Technical Debt** | Auth service lives inside api/ (extraction to services/auth/ deferred per ARCHITECTURE.md §2.1) |
| **Future Improvements** | Email-based verification, password reset flow, 2FA (TOTP), OAuth (Google, GitHub), SSO for enterprise |

#### Feature: Entitlements & Subscriptions

| Attribute | Value |
|---|---|
| **Status** | Partial (foundation in place, billing integration stubbed) |
| **Business Purpose** | Gate premium features (Sentinel, AI Research) behind subscription plans |
| **Entry Point** | Settings page, feature unlock modals |
| **User Flow** | User tries Sentinel → Check entitlement → If not granted, show upgrade modal → Redirect to billing |
| **UI Components** | EntitlementCheck (HOC or middleware), UpgradeModal, SettingsClient (subscription tab) |
| **Backend Modules** | `services/api/entitlements/` |
| **Controllers** | `EntitlementsController` — GET /entitlements, canAccess checks |
| **Services** | `EntitlementsService` — check plan grants, usage quotas, overrides |
| **Database Tables** | Subscription, Plan, PlanGrant, EntitlementOverride, UsageCounter |
| **Prisma Models** | Subscription (userId, planId, status, startedAt, expiresAt, trialEndsAt), Plan (code="free"/"tradew_pro"/"sentinel_pro"/"enterprise"), PlanGrant (planId, capability="sentinel"/"ai_research", quotaLimit, quotaPeriod) |
| **APIs Used** | GET /entitlements, POST /entitlements/check (internal, not yet exposed) |
| **Environment Variables** | DEFAULT_PLAN (usually "free"), BILLING_PROVIDER (stripe, future) |
| **External Dependencies** | None yet (billing integration stub) |
| **Related Files** | services/api/src/entitlements/*, apps/web/src/components/shell/* (feature gates) |
| **Feature Owner** | Core Platform (monetization) |
| **Known Limitations** | No actual billing system; manual entitlementOverride required to grant premium features; quotas not enforced in UI |
| **Technical Debt** | Billing provider interface not yet defined; UsageCounter updates not wired to actual feature calls |
| **Future Improvements** | Stripe/Razorpay integration, self-serve upgrade flow, trial period automation, usage-based billing |

### 3.2 TradeW AI Features

#### Feature: AI Research Workspace

| Attribute | Value |
|---|---|
| **Status** | Planned (UI scaffolding only, backend stub) |
| **Business Purpose** | Dedicated deep-dive research for symbols, strategies, analysis |
| **Entry Point** | `/research` route, Research sidebar icon |
| **User Flow** | Click Research → Symbol search → Load research tools (Company Analysis, Technical, Options) → Agent responses |
| **UI Components** | Research workspace layout, ResearchMiniPanel in terminal, dedicated research page |
| **Backend Modules** | `services/tradew-ai/` (not yet active) |
| **Controllers** | TBD (agent invocation endpoints) |
| **Services** | TBD (agent implementations) |
| **Database Tables** | MemoryRecord (research outputs stored as memories) |
| **Prisma Models** | MemoryRecord (summary, content, sourceKind="research", embedding, userId for user-specific research) |
| **APIs Used** | POST /tradew-ai/agents/:name/invoke (future), GET /knowledge/memories (research retrieval) |
| **Environment Variables** | ANTHROPIC_API_KEY (Claude API access) |
| **External Dependencies** | Anthropic Claude API |
| **Related Files** | apps/web/src/app/research/page.tsx, services/tradew-ai/ (stub), agents/tradew-ai/ (declarative defs) |
| **Feature Owner** | TradeW AI pillar |
| **Known Limitations** | No agent implementations; agent definitions exist but not used; API not wired |
| **Technical Debt** | Placeholder component; memory storage not integrated |
| **Future Improvements** | Implement eight agents (AI Researcher, Company Analysis, News Analysis, Options Chain Analysis, Technical Analysis, Strategy Builder, Portfolio Insights, Learning Assistant), research cache, multi-symbol comparison |

### 3.3 Sentinel Features

#### Feature: Sentinel Safety Nets (Live Safety Feed)

| Attribute | Value |
|---|---|
| **Status** | Production Ready (foundation + one workspace view) |
| **Business Purpose** | Continuous behavioral risk monitoring; warn before costly mistakes without blocking trades |
| **Entry Point** | `/sentinel` route, Sentinel sidebar icon, Live Safety Feed panel in terminal |
| **User Flow** | Open Sentinel → Orchestrator synthesizes observations → Display warnings → User reads evidence → Proceeds or pauses |
| **UI Components** | SentinelPanel, LiveSafetyFeed, SafetyCard, SentinelTimeline, SentinelLocked (premium gate) |
| **Backend Modules** | `services/sentinel/` |
| **Controllers** | `OrchestratorController` (POST /sentinel/orchestrator/invoke) |
| **Services** | Four agent services (Market & Technical, Emotion, Trap & Safety, Compliance & Audit) + OrchestratorService |
| **Database Tables** | SentinelObservation (audit log), ConceptNode, ConceptEdge, ConceptObservation (ontology + learning) |
| **Prisma Models** | SentinelObservation (userId, agent, category, pattern, symbol, evidence, confidence, surfaced), ConceptNode (conceptId, domain, name, definition, explainer), ConceptEdge (fromId, toId, relation, weight) |
| **APIs Used** | POST /sentinel/orchestrator/invoke (main call from api) |
| **Environment Variables** | SENTINEL_ENABLED (default true), CONCEPT_SEED_PATH (knowledge-base/ YAML dir) |
| **External Dependencies** | services/market-data (read-only quote/candle feeds), services/api (read-only trades/orders for emotion analysis) |
| **Related Files** | services/sentinel/src/*, agents/sentinel/*, apps/web/src/components/sentinel/*, knowledge-base/ (ontology YAML) |
| **Feature Owner** | Sentinel pillar |
| **Known Limitations** | No real broker integrations; observation timing not in sync with actual order execution; emotions analysis based on simulated trades |
| **Technical Debt** | Orchestrator logic not fully specified in code (awaiting final prompt spec); agent prompts hardcoded (should be YAML/JSON) |
| **Future Improvements** | Real broker integration (Dhan live), streaming observations as orders are placed, user feedback loop to refine signals |

#### Feature: Trap Detection

| Attribute | Value |
|---|---|
| **Status** | Working (signals computed, composite logic implemented) |
| **Business Purpose** | Detect 13+ distinct trap patterns and warn before entry/exit mistakes |
| **Entry Point** | Embedded in Sentinel workspace and live panel |
| **User Flow** | Market action occurs → Trap & Safety agent evaluates → Multi-signal composite check → Warning if threshold met |
| **UI Components** | SafetyCard (displays trap name + evidence), TrapAlert modal, SentinelTimeline (history) |
| **Backend Modules** | `services/sentinel/intelligence/trap-safety.agent.ts`, `services/sentinel/brain/reasoner.ts` |
| **Controllers** | Called via OrchestratorController |
| **Services** | TrapSafetyIntelligenceService |
| **Database Tables** | SentinelObservation (one per trap detection), ConceptNode (trap patterns stored as concepts) |
| **Prisma Models** | ConceptNode (conceptId="bull-trap", "liquidity-sweep", etc.), ConceptObservation (symbol, outcome, strength) |
| **APIs Used** | None directly (called by orchestrator) |
| **Environment Variables** | TRAP_SIGNAL_THRESHOLD (composite evidence required), CONFIDENCE_FLOOR |
| **External Dependencies** | services/market-data (candles, volume), services/api (trades for emotion signals) |
| **Related Files** | services/sentinel/src/intelligence/trap-safety.agent.ts, services/sentinel/src/brain/reasoner.ts, knowledge-base/traps/ |
| **Feature Owner** | Sentinel pillar |
| **Known Limitations** | Signals not yet learned from user feedback; all weights hardcoded from domain knowledge; no A/B testing framework |
| **Technical Debt** | Trap detection logic intertwined with explanation generation (should separate computation from presentation) |
| **Future Improvements** | Personalized signal weights per user, backtesting against historical scenarios, user feedback loop, new pattern discovery |

#### Feature: Trading Journal & Emotion Intelligence

| Attribute | Value |
|---|---|
| **Status** | Working (UI + storage, emotion inference stubbed) |
| **Business Purpose** | Track trades, moods, lessons; feed emotional state to Sentinel for FOMO/revenge detection |
| **Entry Point** | TradingJournal component (plan to add to sidebar), Settings page (journal editor) |
| **User Flow** | After trade → Optional: Write journal entry + mood tag → Sentinel emotion agent reads history → Flags risky patterns |
| **UI Components** | TradingJournal, JournalEntryForm, JournalHistory (plan to add to UI) |
| **Backend Modules** | `services/api/sim/` (provides trade history), `services/sentinel/intelligence/emotion.agent.ts` |
| **Controllers** | TBD journal endpoints (POST /journal, GET /journal) |
| **Services** | EmotionIntelligenceService (reads JournalEntry + Trade tables) |
| **Database Tables** | JournalEntry, Trade (for timing analysis), Order (for entry pacing) |
| **Prisma Models** | JournalEntry (userId, mood="focused"/"anxious"/"confident"/"frustrated", content, flaggedByAi, aiAnnotation, createdAt) |
| **APIs Used** | GET /sim/orders (entry timing), GET /journal (emotion history) — not yet exposed |
| **Environment Variables** | None |
| **External Dependencies** | None |
| **Related Files** | apps/web/src/components/sentinel/TradingJournal.tsx, services/sentinel/src/intelligence/emotion.agent.ts |
| **Feature Owner** | Sentinel pillar |
| **Known Limitations** | Journal UI not integrated into main sidebar; emotion tags limited (4 preset moods); AI annotations not generated |
| **Technical Debt** | Journal endpoints not yet exposed in api; emotion signal weights hardcoded; no NLP sentiment analysis |
| **Future Improvements** | Emotion detection from trade patterns (no explicit journal entry required), multi-language mood tags, sentiment analysis of journal text |

### 3.4 Learning Hub Features

#### Feature: Learning Materials & Tutorials

| Attribute | Value |
|---|---|
| **Status** | Planned (content hub structure only, no curriculum backend) |
| **Business Purpose** | Educate users on trading fundamentals, technical analysis, risk management |
| **Entry Point** | `/learning` route, Learning sidebar icon, context-sensitive learning in panels (plan) |
| **User Flow** | Click Learning → Browse topics → Select lesson → Read content + watch embedded examples → Quiz (future) |
| **UI Components** | LearningPage (placeholder), LearningMiniPanel (plan to add to terminal) |
| **Backend Modules** | TBD (learning content CMS) |
| **Controllers** | TBD |
| **Services** | TBD |
| **Database Tables** | TBD (course, lesson, user_progress models) |
| **Prisma Models** | TBD |
| **APIs Used** | TBD |
| **Environment Variables** | None yet |
| **External Dependencies** | None yet (could integrate with Teachable, Kajabi, or custom CMS) |
| **Related Files** | apps/web/src/app/learning/page.tsx, apps/web/src/lib/mock/learning.ts |
| **Feature Owner** | Learning Hub pillar |
| **Known Limitations** | No backend; only placeholder UI; content sourced from mock data |
| **Technical Debt** | No content management system; learning outcomes not tracked |
| **Future Improvements** | CMS integration, progress tracking, quizzes, gamification, trading scenario simulations |

---

## 4. Screen Documentation

### 4.1 Page Routes & Navigation

| Route | Page Component | Purpose | Status |
|---|---|---|---|
| `/` | page.tsx | Home/redirect to dashboard | Working |
| `/login` | app/login/page.tsx | User authentication | Working |
| `/signup` | app/signup/page.tsx | Account creation | Working |
| `/dashboard` | app/dashboard/page.tsx | Overview, portfolio summary, market snapshot | Working |
| `/trade` | app/trade/page.tsx | Paper trading terminal (multi-panel workspace) | Working |
| `/markets` | app/markets/page.tsx | Watchlist, market analysis workspace | Partial |
| `/portfolio` | app/portfolio/page.tsx | Detailed holdings, P&L breakdown | Partial |
| `/research` | app/research/page.tsx | AI research workspace (TradeW AI) | Placeholder |
| `/sentinel` | app/sentinel/page.tsx | Safety Nets workspace | Working |
| `/learning` | app/learning/page.tsx | Learning Hub / tutorials | Placeholder |
| `/notifications` | app/notifications/page.tsx | Notification center | Working |
| `/knowledge` | app/knowledge/page.tsx | Knowledge graph visualization | Working (Mermaid-based) |
| `/settings` | app/settings/page.tsx | Profile, preferences, entitlements | Working |
| `/profile` | app/profile/page.tsx | User profile edit | Working |

### 4.2 Trade Terminal Workspace

**Route**: `/trade`

**Purpose**: Multi-panel paper trading interface

**Component Tree**:
```
TradeWorkspace
├── TerminalWorkspace (dockable layout engine)
│   ├── DockSlot (left panel)
│   │   ├── BlotterPanel (order history, fills)
│   │   ├── PortfolioMiniPanel (quick summary)
│   │   └── LearningMiniPanel (contextual tips)
│   ├── DockSlot (center-left)
│   │   ├── ChartPanel (lightweight-charts, OHLCV candles)
│   │   └── chart-tabs/
│   │       ├── TechnicalsTab (RSI, EMA, Bollinger bands)
│   │       ├── DepthTab (order book visualization)
│   │       ├── OptionChainTab (calls/puts, Greeks)
│   │       └── MarketsTab (multi-symbol ticker)
│   ├── DockSlot (center-right)
│   │   ├── OptionChainPanel (explicit options view)
│   │   └── NewsPanel (market news feed)
│   ├── DockSlot (right)
│   │   ├── OrdersPanel (place/monitor orders)
│   │   ├── WatchlistPanel (quick access)
│   │   └── ResearchMiniPanel (AI context)
│   └── QuickActionsDock (icon bar for symbol search, etc.)
└── CommandPalette (Cmd+K: search symbols, execute orders)
```

**State Management**:
- `workspaceStore` (Zustand) — panel layout, open/closed state, active symbol
- `tradeBasketStore` (Zustand) — pending order form, quantity, side, type, limits
- `sessionStore` (Zustand) — user context, login state, refreshed on auth

**API Calls**:
- `GET /market-data/quote/:symbol` — real-time quote (on symbol change)
- `POST /sim/order` — place order
- `GET /sim/orders` — load order history
- `DELETE /sim/order/:id` — cancel order
- `GET /sim/positions` — current holdings
- `GET /sim/portfolio` — wallet + total P&L

**Features**:
- Real-time quote polling (via hook: `useLiveQuotes`)
- Candle chart with technical indicators (`useCandles`)
- Order form validation (quantity, price, margin check)
- Blotter (fills in real-time, mock only)
- Multi-panel docking (drag to resize, reorder, hide/show)

### 4.3 Sentinel Workspace

**Route**: `/sentinel`

**Purpose**: Safety Nets continuous observation and warning system

**Component Tree**:
```
SentinelPage
├── SentinelLocked (entitlement gate, if user not on pro plan)
└── SentinelContent
    ├── SentinelPanel (main safety feed)
    │   ├── SafetyCard (one per warning)
    │   │   ├── pattern name (e.g., "Bull Trap Detected")
    │   │   ├── symbol + context
    │   │   ├── confidence meter
    │   │   └── "Why?" button → evidence panel
    │   ├── DayClassificationCard (daily sentiment: bullish/bearish/neutral)
    │   └── DemoModeBanner (when in paper trading)
    ├── SentinelTimeline (history of past observations)
    ├── MarketContextPanel (what market is doing: volatility, breadth, etc.)
    └── LiveSafetyFeed (real-time update stream, plan to move to web panel)
```

**State Management**:
- `useSentinel` hook — poll observations, refresh on interval
- Context derivation (`lib/sentinel/deriveContext.ts`) — compute state from portfolio + market data

**API Calls**:
- `POST /sentinel/orchestrator/invoke` — invoke Sentinel main orchestrator (via api)
- `GET /sim/positions` — user's current holdings (for emotion analysis context)
- `GET /sim/orders` — order history (for behavior pattern detection)
- `GET /market-data/quote/:symbol` — live prices (for technicals)

**Features**:
- Real-time safety observation synthesis
- Trap detection composite signals
- Emotion intelligence (entry timing, revenge trading, etc.)
- Audit trail viewing (evidence for each warning)
- Market context (VIX, breadth, sector rotation)

---

## 5. Backend Documentation

### 5.1 NestJS Modules in services/api

#### AuthModule

**Exports**: `AuthController`, `AuthService`, `AuthGuard`

**Guards**:
- `AuthGuard` — checks JWT in Authorization header, populates `req.user`

**DTOs**:
- `LoginRequest` (email, password)
- `LoginResponse` (accessToken, refreshToken, user profile)
- `RefreshTokenRequest` (refreshToken)

**Service Methods**:
- `login(email, password)` — hash check, JWT issue
- `refresh(refreshToken)` — validate, new JWT issue
- `logout(userId)` — revoke refresh token
- `validateToken(token)` — JWT verify, return payload

#### EntitlementsModule

**Exports**: `EntitlementsController`, `EntitlementsService`

**Service Methods**:
- `canAccess(userId, capability)` → boolean — check subscription + overrides
- `getSubscription(userId)` → Subscription — current plan + status
- `checkUsageQuota(userId, metric)` → boolean — within quota for period?
- `incrementUsage(userId, metric)` → void — increment counter

#### InstrumentsModule

**Exports**: `InstrumentsController`, `InstrumentsService`

**Service Methods**:
- `findBySymbol(symbol)` → Instrument — canonical lookup
- `search(query)` → Instrument[] — fuzzy search
- `getMetadata(symbol)` → enriched Instrument (with quote + technicals)

#### MarketDataModule

**Exports**: `MarketDataController`, `MarketDataService`

**Service Methods**:
- `getQuote(symbol)` → Quote — current price
- `getCandles(symbol, period, count)` → Candle[] — historical candles (stubbed)
- `getOptionChain(underlying)` → OptionChainRow[] — calls/puts (stubbed)
- `updateQuote(symbol, ltp, bid, ask, volume)` → void — streaming update

#### SimModule

**Exports**: `SimController`, `OrderService`, `PortfolioService`

**Order Service Methods**:
- `placeOrder(userId, OrderRequest)` → Order — validate, insert, margin block
- `cancelOrder(userId, orderId)` → Order — change status, release margin
- `getOrder(orderId)` → Order
- `getOrderHistory(userId)` → Order[]
- `getOrderStatus(orderId)` → OrderStatus

**Portfolio Service Methods**:
- `getWallet(userId)` → PaperWallet — cash, margin, realized PnL
- `getPositions(userId)` → Position[] — open holdings
- `getPosition(userId, instrumentId)` → Position — single holding
- `computePortfolioMetrics(userId)` → { totalValue, unrealizedPnL, dailyPnL, dailyReturn, marginUtilization }
- `dailyPnl(userId, position)` → Decimal — P&L since session open

#### SentinelModule

**Exports**: `SentinelController`

**Controller Methods**:
- `POST /sentinel/orchestrator/invoke` → SentinelObservation[] — main Sentinel call

#### KnowledgeModule

**Exports**: `KnowledgeController`, `KnowledgeService`

**Service Methods**:
- `searchMemories(query, userId?)` → MemoryRecord[] — text + embedding similarity
- `getMemory(id)` → MemoryRecord
- `createMemory(MemoryRecord)` → MemoryRecord
- `getGraphNodes(filter?)` → GraphNode[]
- `getGraphEdges(nodeId)` → GraphEdge[]

### 5.2 Python Flask Services

#### services/trading-engine

**Routes**:
- `POST /webhook/tradingview` — TradingView strategy alert → place order
- `GET /positions?user_id=...` — Get user's open positions
- `GET /orders?user_id=...` — Get order history
- `POST /order` — JSON: { user_id, symbol, side, quantity, type, price, validity }
- `DELETE /order/:order_id` — Cancel order
- `GET /wallet?user_id=...` — Paper cash + margin + PnL

**Core Classes**:
- `Order` (models.py) — state machine (PENDING → OPEN → FILLED/CANCELLED)
- `Position` (models.py) — open holding, avg price, realized PnL
- `Trade` (models.py) — one fill record
- `PaperWallet` (models.py) — cash, margin used, realized PnL

**Key Files**:
- `app.py` — Flask app, routes
- `models.py` — SQLAlchemy or dataclass Order/Position/Trade/PaperWallet
- `extreme_algo_package/` — legacy order matching, position tracking
- `tradew_live_runner.py` — paper broker mock, quote generation
- `order_poller.py` — fills reconciliation (periodically checks for fills to record)

---

## 6. Database Documentation

### 6.1 Core Trading Tables

#### Order

```sql
id UUID PRIMARY KEY
userId UUID (FK User.id)
instrumentId UUID (FK Instrument.id)
side ENUM (BUY, SELL)
type ENUM (MARKET, LIMIT, SL, SL_M)
validity ENUM (DAY, IOC)
productType ENUM (MIS, CNC, NRML)
status ENUM (PENDING, OPEN, TRIGGER_PENDING, PARTIALLY_FILLED, FILLED, CANCELLED, REJECTED, EXPIRED)
quantity INT
filledQuantity INT
price DECIMAL (limit/SL price)
triggerPrice DECIMAL (SL/SL_M trigger)
avgFillPrice DECIMAL (average fill, null until first fill)
slippage DECIMAL (execution quality metric)
charges DECIMAL (brokerage + taxes)
marginBlocked DECIMAL (simulated margin reserved while open)
rejectReason STRING (if REJECTED)
parentOrderId UUID (FK Order.id, for bracket orders — future)
placedAt DATETIME (order placement time)
updatedAt DATETIME
expiresAt DATETIME (for DAY validity orders)

Indexes:
  (userId, placedAt) — order history retrieval
  (status) — status-based queries
  (userId, status) — user's specific orders by status
```

**Used By**: PortfolioService, OrderService, Emotion intelligence (behavior analysis), Blotter UI

#### Trade (Fill Record)

```sql
id UUID PRIMARY KEY
orderId UUID (FK Order.id)
userId UUID (FK User.id)
instrumentId UUID (FK Instrument.id)
side ENUM (BUY, SELL)
quantity INT
fillPrice DECIMAL
charges DECIMAL
realizedPnl DECIMAL (only set when fill reduces/closes a position)
executedAt DATETIME

Indexes:
  (userId, executedAt) — user's trade history
  (orderId) — joins back to order
```

**Used By**: Position calculations, Trading Journal, Emotion intelligence (timing analysis), PnL computation

#### Position

```sql
id UUID PRIMARY KEY
userId UUID (FK User.id)
instrumentId UUID (FK Instrument.id)
productType ENUM (MIS, CNC, NRML)
quantity INT (sign indicates long/short)
avgPrice DECIMAL (entry average)
realizedPnl DECIMAL (closed-out profits locked in; zero for fresh position)
marginUsed DECIMAL (simulated margin blocked for this position)

-- Session-open snapshots (IST day reset)
sessionOpenQty INT
sessionOpenAvgPrice DECIMAL
sessionOpenMarketPrice DECIMAL
sessionAnchorAt DATETIME

Indexes:
  (userId) — user's positions
  (userId, instrumentId, productType) UNIQUE — one position per product type per user per instrument
```

**Used By**: Portfolio page, P&L calculations, Sentinel emotion analysis, Dashboard summary, Market data context

#### PaperWallet

```sql
id UUID PRIMARY KEY
userId UUID UNIQUE (FK User.id)
startingBalance DECIMAL (one-time grant, never changes after creation)
cashBalance DECIMAL (cash not blocked as margin)
marginUsed DECIMAL (sum of position marginUsed + order marginBlocked)
realizedPnl DECIMAL (sum of Trade.realizedPnl, incrementally maintained)
updatedAt DATETIME
createdAt DATETIME

Key Invariant: cashBalance == startingBalance + realizedPnl - marginUsed - lifetime_charges
```

**Used By**: Portfolio service, risk checks before order placement, Dashboard, Settings

### 6.2 Instrument & Market Data

#### Instrument

```sql
id UUID PRIMARY KEY
symbol STRING UNIQUE (canonical lookup key, e.g., "NSE:RELIANCE")
displayName STRING (human-readable)
type ENUM (INDEX, EQUITY, OPTION, FUTURE)
exchange STRING
underlying STRING (for derivatives, symbol of underlying)
expiryDate DATETIME (for options/futures)
strikePrice DECIMAL (for options)
optionType STRING (CE/PE for options)
lotSize INT (contract size)
tickSize DECIMAL (min price movement)

-- Dhan broker mappings (Phase 1 market data integration)
securityId STRING (Dhan security ID)
exchangeSegment STRING (NSE_EQ, BSE_EQ, NSE_FNO, MCX_COMM, IDX_I, etc.)
isin STRING
dhanInstrument STRING (EQUITY, FUTIDX, OPTSTK, etc.)
series STRING (EQ, BE, DE, etc. from NSE)
expiryFlag STRING (M/W for derivatives)
tradingSymbol STRING (broker-native symbol, not unique)
underlyingSecurityId STRING (reference to underlying, not FK)

-- Metadata provenance
active BOOLEAN (soft-delete for delisted instruments)
metadataSource STRING (dhan-scrip-master | seed)
metadataSyncedAt DATETIME

Indexes:
  (symbol) UNIQUE — canonical lookup
  (exchangeSegment, securityId) UNIQUE — Dhan identity
  (active) — filter for active instruments
  (isin) — ISIN lookup
```

**Used By**: Every trading operation (order placement, quote lookup, chart rendering)

#### Quote

```sql
id UUID PRIMARY KEY
instrumentId UUID UNIQUE (FK Instrument.id)
ltp DECIMAL (last traded price)
previousClose DECIMAL
open DECIMAL
high DECIMAL
low DECIMAL
bid DECIMAL
ask DECIMAL
volume BIGINT
source STRING (simulated | dhan | ...)
updatedAt DATETIME
createdAt DATETIME

Key Invariant: One row per instrument, updated in-place on every tick
```

**Used By**: Charts, order fills (fill price derivation), portfolio P&L calculations, Sentinel trap detection (OHLC patterns)

### 6.3 AI & Memory Tables

#### MemoryRecord

```sql
id UUID PRIMARY KEY
summary STRING (concise description)
content STRING (full text)
sourceKind ENUM (research|document|chart|indicator|conversation|market_report|trading_journal|task_output|observation|system)
sourceReference STRING (link to source, e.g., "ORDER:12345" or "SYMBOL:RELIANCE")
sourceProvider STRING (e.g., "claude-opus", "sentinel-agent")
confidence FLOAT [0, 1]
tags STRING[] (e.g., ["bullish", "tech-stocks", "earnings-season"])
entities JSON (extracted entities: stocks, sectors, people, etc.)
userId STRING (null for global knowledge)
namespace STRING (global | user-specific)
staleAfter DATETIME (optional expiration)
metadata JSON (arbitrary provider-specific data)
embedding VECTOR(embedding_dim) (pgvector, optional)
embeddingModel STRING (provider + model, e.g., "openai-text-embedding-3-small")
embeddingDim INT
createdAt DATETIME
updatedAt DATETIME

Indexes:
  (namespace, userId) — retrieve memories for a namespace/user
  (createdAt) — time-ordered queries
```

**Used By**: Research workspace, knowledge retrieval, Sentinel context (historical observations)

#### ConceptNode (Sentinel Ontology)

```sql
id UUID PRIMARY KEY
conceptId STRING UNIQUE (stable slug, e.g., "liquidity-sweep")
domain STRING (one of 15 domains: patterns, indicators, behaviors, risks, etc.)
name STRING
aliases STRING[] (alternative names)
status ENUM (canonical | proposed | deprecated)
maturity ENUM (established | emerging | contested)
confidence FLOAT (default credibility)
summary STRING (one-liner)
definition STRING (formal definition)
explainer STRING (what users read: "A liquidity sweep occurs when...")
observableWhen STRING[] (conditions for detection)
examples JSON (example scenarios)
sources STRING[] (references: academic papers, analyst notes)
tags STRING[] (categorization)

-- Versioning / supersession
supersededBy STRING (slug of successor concept)
supersedes STRING (slug of predecessor concept)

-- Canonical vs. learned
origin ENUM (canonical | learned)
sourcePath STRING (knowledge-base/patterns/liquidity-sweep.yaml)
checksum STRING (sha256 of YAML, for reseed deduplication)

-- Runtime learning
observationCount INT (how many times observed)
lastObservedAt DATETIME

-- Embeddings (future, unset today)
embedding VECTOR (optional)
embeddingModel STRING
embeddingDim INT

Indexes:
  (domain) — query by domain
  (status, confidence) — canonical, high-confidence concepts
  (origin) — canonical vs. learned
```

**Used By**: Sentinel orchestrator (concept matching), knowledge graph visualization, ontology seeding

#### SentinelObservation (Audit Trail)

```sql
id UUID PRIMARY KEY
userId STRING (null for market-wide observations)
agent ENUM (market-technical | emotion | trap-safety | compliance-audit | orchestrator)
category STRING (SEBI compliance label, e.g., "behavioral-risk" | "market-risk")
pattern STRING (e.g., "bull_trap", "revenge_trading")
symbol STRING (market symbol if applicable)
content STRING (human-readable observation text)
evidence JSON (structured evidence: candle pattern, user behavior, etc.)
confidence FLOAT [0, 1]
surfaced BOOLEAN (whether orchestrator displayed to user)
createdAt DATETIME

Indexes:
  (userId, createdAt) — user's observation history
  (agent, createdAt) — per-agent audit log
  (symbol, createdAt) — market context for a symbol
```

**Used By**: Sentinel orchestrator (decision input), compliance/audit review, evidence display in UI

---

## 7. API Reference (Complete)

### 7.1 Authentication Endpoints

**POST /auth/login**
```
Request:
  { email: string, password: string }

Response: 200
  {
    accessToken: string (JWT, 7d expiry),
    refreshToken: string (opaque, 30d expiry),
    user: { id, email, country, experienceLevel }
  }

Error: 401 Unauthorized
  { message: "Invalid credentials" }
```

**POST /auth/refresh**
```
Request:
  { refreshToken: string }

Response: 200
  { accessToken: string, refreshToken: string }

Error: 401 Unauthorized
  { message: "Invalid or expired refresh token" }
```

**GET /auth/profile** (requires AuthGuard)
```
Response: 200
  {
    id: string,
    email: string,
    country: string,
    experienceLevel: string,
    preferences: { watchlist: [...], theme: "light" | "dark" }
  }
```

**POST /auth/logout** (requires AuthGuard)
```
Response: 200
  { message: "Logged out" }
```

### 7.2 Trading Endpoints

**POST /sim/order** (requires AuthGuard)
```
Request:
  {
    instrumentId: string,
    side: "BUY" | "SELL",
    quantity: number,
    type: "MARKET" | "LIMIT" | "SL" | "SL_M",
    price?: number (for LIMIT, SL),
    triggerPrice?: number (for SL, SL_M),
    validity: "DAY" | "IOC",
    productType: "MIS" | "CNC" | "NRML"
  }

Response: 201 Created
  {
    id: string,
    status: "PENDING",
    placedAt: datetime,
    quantity: number,
    ...
  }

Error: 400 Bad Request
  { message: "Insufficient margin" | "Bad lot size" | ... }
```

**GET /sim/orders** (requires AuthGuard)
```
Query:
  status?: "OPEN" | "FILLED" | "CANCELLED"
  limit?: number (default 50)
  offset?: number (pagination)

Response: 200
  [
    { id, status, quantity, filledQuantity, avgFillPrice, charges, placedAt },
    ...
  ]
```

**DELETE /sim/order/:id** (requires AuthGuard)
```
Response: 200
  { id, status: "CANCELLED", canceledAt: datetime }

Error: 400 Bad Request
  { message: "Order already filled" | "Order not found" }
```

**GET /sim/positions** (requires AuthGuard)
```
Response: 200
  [
    {
      id: string,
      symbol: string,
      quantity: number,
      avgPrice: decimal,
      currentPrice: decimal,
      unrealizedPnl: decimal,
      realizedPnl: decimal,
      marginUsed: decimal
    },
    ...
  ]
```

**GET /sim/portfolio** (requires AuthGuard)
```
Response: 200
  {
    cash: decimal,
    marginUsed: decimal,
    marginAvailable: decimal,
    positions: Position[],
    totalValue: decimal,
    totalInvested: decimal,
    unrealizedPnl: decimal,
    realizedPnl: decimal,
    dailyPnl: decimal,
    dailyReturn: decimal,
    marginUtilization: decimal (percent)
  }
```

### 7.3 Market Data Endpoints

**GET /market-data/quote/:symbol** (requires AuthGuard)
```
Response: 200
  {
    symbol: string,
    ltp: decimal,
    bid: decimal,
    ask: decimal,
    open: decimal,
    high: decimal,
    low: decimal,
    previousClose: decimal,
    volume: bigint,
    updatedAt: datetime
  }

Error: 404 Not Found
  { message: "Instrument not found" }
```

**GET /instruments**
```
Query:
  search?: string (partial symbol match)
  type?: "EQUITY" | "OPTION" | "INDEX" | "FUTURE"
  exchange?: string
  limit?: number (default 20)

Response: 200
  [
    {
      id: string,
      symbol: string,
      displayName: string,
      type: string,
      exchange: string,
      lotSize: number,
      tickSize: decimal
    },
    ...
  ]
```

**GET /instruments/:symbol**
```
Response: 200
  {
    id: string,
    symbol: string,
    displayName: string,
    type: string,
    exchange: string,
    underlying?: string,
    expiryDate?: datetime,
    strikePrice?: decimal,
    optionType?: string,
    lotSize: number,
    tickSize: decimal,
    isin: string,
    dhanSecurityId: string,
    dhanExchangeSegment: string,
    currentQuote: Quote
  }
```

### 7.4 Entitlements Endpoints

**GET /entitlements** (requires AuthGuard)
```
Response: 200
  {
    subscription: {
      planCode: string,
      status: "ACTIVE" | "TRIALING" | "EXPIRED",
      startedAt: datetime,
      expiresAt: datetime,
      trialEndsAt?: datetime
    },
    grants: [
      { capability: "sentinel", quotaLimit: 100, quotaPeriod: "MONTH" },
      { capability: "ai_research", quotaLimit: 500, quotaPeriod: "DAY" },
      ...
    ],
    overrides: [
      { capability: string, granted: boolean, expiresAt?: datetime }
    ]
  }
```

### 7.5 Sentinel Endpoints

**POST /sentinel/orchestrator/invoke** (requires AuthGuard, Sentinel entitlement)
```
Request:
  {
    symbol?: string (optional context),
    userId: string (derived from JWT)
  }

Response: 200
  {
    observations: [
      {
        agent: "market-technical" | "emotion" | "trap-safety" | "compliance-audit" | "orchestrator",
        pattern: string,
        symbol: string,
        content: string (human-readable observation),
        evidence: object,
        confidence: float,
        category: string (SEBI label)
      },
      ...
    ],
    synthesized: {
      warning?: string (orchestrator's combined message),
      confidence: float,
      suggestedAction: string
    }
  }
```

### 7.6 Knowledge & Memory Endpoints

**GET /knowledge/memories** (requires AuthGuard)
```
Query:
  query: string (text search),
  sourceKind?: string,
  tags?: string[] (comma-separated),
  limit?: number (default 20)

Response: 200
  [
    {
      id: string,
      summary: string,
      content: string,
      sourceKind: string,
      sourceReference: string,
      confidence: float,
      tags: string[],
      createdAt: datetime
    },
    ...
  ]
```

**GET /knowledge/graph/nodes** (requires AuthGuard)
```
Query:
  domain?: string,
  status?: "canonical" | "proposed",
  limit?: number (default 100)

Response: 200
  [
    {
      id: string,
      conceptId: string,
      name: string,
      domain: string,
      definition: string,
      status: string,
      observationCount: number,
      confidence: float
    },
    ...
  ]
```

---

## 8. AI Architecture

### 8.1 Sentinel System

**Runtime**: `services/sentinel` (Node.js/NestJS)

**Agents** (all independent, produce observations):

1. **Market & Technical Intelligence**
   - Monitors OHLC, volume, OI, technical indicators (RSI, EMA, VWAP, Bollinger Bands)
   - Detects breakouts, support/resistance levels, trend reversals
   - Inputs: live candles, option chain data
   - Output: technical patterns, confidence scores

2. **Emotion Intelligence**
   - Analyzes user's trade timing, position sizing, entry/exit behavior
   - Detects FOMO, revenge trading, averaging down, discipline drift
   - Inputs: user's own trade history, order history, session timing
   - Output: behavioral risk flags

3. **Trap & Safety Intelligence**
   - Combines signals from Market & Technical + Emotion agents
   - Applies composite logic (e.g., low-volume breakout = volume below avg + price above resistance)
   - Detects 13+ trap patterns (bull trap, bear trap, liquidity sweep, fake breakout, etc.)
   - Output: trap alerts with corroborating evidence

4. **Compliance & Audit**
   - Receives all observations from other three agents
   - Assigns SEBI-relevant category labels
   - Logs to SentinelObservation table with evidence
   - Output: audit-trail records

5. **Sentinel Orchestrator**
   - Receives structured observations from all four agents
   - Synthesizes into single user-facing warning or reflection
   - Applies threshold logic (multiple signals before warning)
   - Output: final warning text + evidence panel content

**Ontology** (Concept Knowledge Graph):
- Stored in `ConceptNode`, `ConceptEdge` tables
- Sourced from `knowledge-base/` YAML files (versioned, reviewed like code)
- Domains: patterns (bull-trap, liquidity-sweep), behaviors (revenge-trading), market-conditions, etc.
- Seeded via `scripts/seed-ontology.ts` from YAML
- Reseed rewrites canonical columns; preserves learned* and observation counts

**Data Flow**:
```
Real-time market data (Dhan WebSocket, stubbed)
    ↓
Market & Technical Intelligence agent (candle patterns, volume)
    ↓
    ├─→ SentinelObservation (agent: "market-technical")
    └─→ Trap & Safety Intelligence agent
         ↓
User's trade history (services/api, read-only)
    ↓
Emotion Intelligence agent (entry timing, revenge)
    ↓
    ├─→ SentinelObservation (agent: "emotion")
    └─→ Trap & Safety Intelligence agent
         ↓
         ├─→ Composite signal check (multi-signal logic)
         ├─→ SentinelObservation (agent: "trap-safety")
         └─→ Compliance & Audit agent
              ↓
              ├─→ SentinelObservation (agent: "compliance-audit", with SEBI label)
              └─→ Sentinel Orchestrator
                   ↓
                   Synthesize into user-facing warning
                   ↓
                   SentinelObservation (agent: "orchestrator", surfaced: true)
                   ↓
                   Live Safety Feed (UI update)
```

### 8.2 TradeW AI System

**Runtime**: `services/tradew-ai` (Node.js/NestJS, not yet implemented)

**Planned Agents** (all independent, produce analysis):

1. **AI Researcher (Router)** — Dispatch incoming research questions to specialized agents
2. **Company Analysis** — Fundamental research (financials, management, moat)
3. **News Analysis** — News aggregation, sentiment, event classification
4. **Option Chain Analysis** — Greeks, OI, IV skew, risk reversals
5. **Technical Analysis** — Charting patterns, support/resistance, multi-timeframe analysis
6. **Strategy Builder** — Help users design and backtest trading strategies
7. **Portfolio Insights** — Holdings analysis, sector exposure, concentration risk
8. **Learning Assistant** — Educational context (tutorials, concept explanations)

**Data Flow**:
```
User query (symbol, topic, strategy)
    ↓
API request: POST /tradew-ai/agents/researcher/invoke
    ↓
AI Researcher agent routes to specialized agent(s)
    ↓
Each agent:
  - Calls Anthropic Claude API
  - Retrieves market data (services/market-data)
  - Retrieves memories (knowledge-base)
  - Generates structured response
    ↓
Responses synthesized and cached as MemoryRecord
    ↓
Return to UI (Research workspace or copilot docked chat)
```

**Memory & Learning**:
- Research outputs stored as MemoryRecord (sourceKind: "research")
- Tagged by symbol, topic, agent
- Embeddings computed for similarity search
- Learning Hub feeds off continuous-learning-pipeline (validate → promote → publish)

### 8.3 Agent Definitions (Declarative)

**Location**: `agents/sentinel/` and `agents/tradew-ai/` (YAML/JSON files)

**Format** (planned, not yet implemented as YAML):
```yaml
agent:
  id: "market-technical-intelligence"
  name: "Market & Technical Intelligence"
  system_prompt: |
    You are a technical analysis expert. Monitor the following...
  tools:
    - get_candles (required)
    - get_option_chain (required)
    - get_news (optional)
  guardrails:
    - never_recommend_trades: true
    - disclaimer: "This is technical observation only, not advice."
  output_schema:
    pattern: string
    confidence: float
    evidence: object
```

**Version Control**: Agent definitions are reviewed like code, changes tracked in git.

---

## 9. Feature-to-Code Map

### Paper Trading
- **Frontend**: `apps/web/src/lib/oms.ts`, `apps/web/src/components/terminal/panels/OrdersPanel.tsx`, `TerminalWorkspace`
- **Backend**: `services/api/src/sim/`, `services/trading-engine/app.py`, `extreme_algo_package/`
- **Database**: Order, Trade, Position, PaperWallet models
- **API**: POST /sim/order, GET /sim/orders, DELETE /sim/order/:id, GET /sim/positions, GET /sim/portfolio

### Market Data
- **Frontend**: `apps/web/src/lib/marketData.ts`, `apps/web/src/lib/hooks/useLiveQuotes.ts`, `TradeChart`
- **Backend**: `services/api/src/market-data/`, `services/market-data/src/`
- **Database**: Instrument, Quote models
- **API**: GET /market-data/quote/:symbol, GET /instruments/:symbol

### Portfolio & PnL
- **Frontend**: `apps/web/src/components/dashboard/PortfolioSummary.tsx`, portfolio page
- **Backend**: `services/api/src/sim/portfolio.service.ts`
- **Database**: PaperWallet, Position, Trade, Quote models
- **API**: GET /sim/portfolio

### Authentication
- **Frontend**: `apps/web/src/app/login/page.tsx`, `apps/web/src/app/signup/page.tsx`, `apps/web/src/lib/store/sessionStore.ts`
- **Backend**: `services/api/src/auth/`
- **Database**: User, RefreshToken models
- **API**: POST /auth/login, POST /auth/refresh, GET /auth/profile

### Sentinel Safety Nets
- **Frontend**: `apps/web/src/app/sentinel/page.tsx`, `apps/web/src/components/sentinel/*`, `apps/web/src/lib/sentinel/useSentinel.ts`
- **Backend**: `services/sentinel/src/`
- **Database**: SentinelObservation, ConceptNode, ConceptEdge, ConceptObservation models
- **Definitions**: `agents/sentinel/`
- **Ontology**: `knowledge-base/`
- **API**: POST /sentinel/orchestrator/invoke

### Trading Journal
- **Frontend**: `apps/web/src/components/sentinel/TradingJournal.tsx`
- **Backend**: `services/sentinel/src/intelligence/emotion.agent.ts` (reads JournalEntry + Trade history)
- **Database**: JournalEntry model
- **API**: (POST /journal, GET /journal — not yet exposed)

### Knowledge Graph
- **Frontend**: `apps/web/src/app/knowledge/page.tsx`, `KnowledgeGraph.tsx`, `Mermaid.tsx`
- **Backend**: `services/api/src/knowledge/`, `services/sentinel/src/brain/`
- **Database**: MemoryRecord, MemoryRelation, ConceptNode, ConceptEdge, GraphNode, GraphEdge models
- **API**: GET /knowledge/memories, GET /knowledge/graph/nodes

---

## 10. Dependency Graph

### Service Dependencies

```
apps/web
  ├─→ packages/types (DTOs, enums)
  ├─→ packages/ui (components, design system)
  └─→ services/api (only public ingress)

apps/admin (stub)
  └─→ services/api

apps/mobile (stub)
  └─→ packages/types
  └─→ packages/sdk

services/api
  ├─→ packages/types
  ├─→ packages/database (Prisma ORM)
  ├─→ packages/shared (logger, config, errors)
  ├─→ packages/market-data (types)
  ├─→ services/trading-engine (internal REST, service token)
  ├─→ services/sentinel (internal REST, service token)
  ├─→ services/market-data (internal REST, service token)
  └─→ (future: services/tradew-ai, notification, analytics)

services/sentinel
  ├─→ packages/database (Prisma ORM)
  ├─→ packages/shared (logger, config)
  ├─→ agents/sentinel/ (definitions, YAML/JSON)
  ├─→ knowledge-base/ (ontology YAML)
  └─→ services/api (read-only: trades, orders for emotion analysis)

services/market-data
  ├─→ packages/database (Prisma ORM)
  ├─→ packages/shared
  └─→ (Dhan REST API external)

services/trading-engine (Python)
  ├─→ extreme_algo_package (legacy order matching)
  ├─→ sqlite3 (legacy store)
  └─→ (Dhan API when live mode enabled)

packages/database
  └─→ (PostgreSQL via Prisma)

packages/types
  └─→ (no dependencies)

packages/ui
  ├─→ packages/types
  └─→ (React, Tailwind, Framer Motion, etc.)

packages/shared
  └─→ (dotenv, pino logger, standard Node.js)

agents/sentinel/
  └─→ (YAML definitions, no code)

agents/tradew-ai/
  └─→ (YAML definitions, no code)

workflows/
  └─→ (n8n JSON exports, external service)
```

### Communication Patterns

**Public → Internal**:
- `apps/web` → `services/api` (JWT auth)

**Internal Service → Internal Service**:
- `services/api` → `services/trading-engine` (service token in Authorization header)
- `services/api` → `services/sentinel` (service token)
- `services/api` → `services/market-data` (service token)
- `services/sentinel` → `services/api` (read-only, service token)

**Event Bus** (future):
- `services/trading-engine` → n8n → `services/notification` (via webhook)
- `services/api` → n8n (workflow trigger)

---

## 11. Dead Code Audit

### Unused Files

- `apps/terminal/` — Legacy TUI, not maintained, no routing to it
- `services/tradew-ai/` — Stub exists, no implementations
- `services/notification/` — Stub exists, no implementations
- `services/analytics/` — Stub exists, no implementations
- `services/auth/` — Folder exists but module lives in `services/api/auth/`; extraction deferred
- `packages/sdk/` — Stub (future public API, not yet generated from OpenAPI)

### Placeholder Components

- `apps/web/src/app/research/page.tsx` — Loads but AI Researcher not wired
- `apps/web/src/app/learning/page.tsx` — Loads mock data only, no backend
- `apps/web/src/components/terminal/panels/LearningMiniPanel.tsx` — Stub
- `apps/web/src/components/terminal/panels/ResearchMiniPanel.tsx` — Stub

### Incomplete Features

- **Screener**: UI exists, backend filter logic not implemented
- **Watchlist**: UI renders but persistence not wired (stored in mock only)
- **Email Verification**: Auth signup exists, email service not integrated
- **Password Reset**: Route stub exists, email service not integrated
- **Dhan Live Feed**: WebSocket integration stubbed, polling simulation only
- **Historical Candles**: Endpoint stub returns mock data

### Duplicate / Redundant Code

- PnL calculations: logic exists in both `services/api/sim/portfolio.service.ts` and `services/trading-engine/` (should consolidate)
- Quote update handling: market-data service + api service (integration not fully rationalized)

### TODOs in Codebase

Search for `TODO:` in source:
- Bracket order support (parentOrderId field exists but not populated)
- Multi-currency support (currently hardcoded to INR)
- Real Dhan broker mode (paper-only today)
- Options pricing (Black-Scholes exists but not integrated into option chain panel)

### Dead Imports / Exports

- Some utility exports in `packages/shared` not yet used (deferred for future services)

---

## 12. Environment Documentation

### Root-Level Environment Variables

Create `.env` files at:
- `services/api/.env.example` + `.env` (development) + `.env.production` (deployed)
- `services/trading-engine/.env.example`
- `services/market-data/.env.example`
- `services/sentinel/.env.example`
- `apps/web/.env.local` (Next.js dev), `.env.production` (deployed)

### services/api

```env
# Core
NODE_ENV=development
PORT=4000
LOG_LEVEL=debug

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/tradew

# Auth
JWT_SECRET=dev-secret-key-change-in-prod
JWT_EXPIRY=7d
REFRESH_TOKEN_EXPIRY=30d

# External Services
TRADING_ENGINE_URL=http://localhost:5000
MARKET_DATA_URL=http://localhost:5001
SENTINEL_URL=http://localhost:5002

# Dhan (future, optional)
DHAN_API_KEY=...
DHAN_CLIENT_ID=...

# Broker Mode
PAPER_CAPITAL=1000000
BROKER_MODE=paper # paper | live (live requires DHAN_* credentials)

# Frontend
FRONTEND_URL=http://localhost:3000

# Features
FEATURE_DHAN_LIVE_FEED=false
FEATURE_BRACKET_ORDERS=false
FEATURE_MULTI_CURRENCY=false
```

### services/sentinel

```env
NODE_ENV=development
PORT=5002
LOG_LEVEL=debug

DATABASE_URL=postgresql://user:password@localhost:5432/tradew

# Ontology
CONCEPT_SEED_PATH=../../knowledge-base/
RESEED_ON_STARTUP=true

# Services
API_SERVICE_URL=http://localhost:4000
MARKET_DATA_SERVICE_URL=http://localhost:5001

# Service-to-service auth
SERVICE_SECRET=shared-secret-key

# Trap Detection Thresholds
TRAP_SIGNAL_THRESHOLD=2 # min signals required
CONFIDENCE_FLOOR=0.5
```

### apps/web

```env
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_LOG_LEVEL=debug

# Feature Flags
NEXT_PUBLIC_FEATURE_SENTINEL=true
NEXT_PUBLIC_FEATURE_AI_RESEARCH=false
NEXT_PUBLIC_FEATURE_LEARNING_HUB=false
NEXT_PUBLIC_FEATURE_WATCHLIST=true

# Markets
NEXT_PUBLIC_QUOTE_UPDATE_INTERVAL_MS=1000
```

### services/trading-engine

```env
FLASK_ENV=development
FLASK_DEBUG=1
PORT=5000

# Paper Broker
PAPER_CAPITAL=1000000
PAPER_MODE=true

# Dhan (future)
DHAN_API_KEY=...
DHAN_CLIENT_ID=...

# Webhooks
TRADINGVIEW_WEBHOOK_SECRET=hmac-sha256-secret

# Order Poller
ORDER_POLL_INTERVAL_MS=5000
```

---

## 13. Development Workflow

### Request Flow: User Places an Order

1. **Frontend (apps/web)**
   - User fills OrderForm (symbol, quantity, side, type, price, validity, productType)
   - Validation runs (positive quantity, lot size check, margin check with portfolio)
   - Form submits: `POST /sim/order` with OrderRequest DTO

2. **API (services/api)**
   - AuthGuard validates JWT from Authorization header, sets `req.user`
   - SimController receives request, calls OrderService.placeOrder()
   - OrderService validates:
     - Instrument exists and is active
     - User has sufficient margin (cashBalance > marginRequired)
     - Quantity is valid lot multiple
   - If valid: inserts Order row with status: PENDING
   - Margin is blocked: update PaperWallet.marginBlocked
   - Order immediately transitions to status: OPEN (in paper mode, instant acceptance)
   - Internal call to trading-engine (future): `POST http://trading-engine:5000/order` with service token

3. **Trading Engine (services/trading-engine, Python)**
   - Flask route receives order, updates SQLite Order/Position
   - Simulates fill (mock_dhanhq.py) immediately for MARKET orders
   - For LIMIT: order rests until price is reached (in poller)
   - order_poller.py (runs periodically):
     - Checks all open LIMIT orders
     - If price crossed: generate Trade record
     - Update Order.status = FILLED, Order.avgFillPrice, Order.filledQuantity
     - Create Position or update existing
     - Unrealized margin converts to realized (position's marginUsed)

4. **Back to API (services/api)**
   - Polling: `GET /sim/orders` retrieves filled orders
   - OrderService.getOrders() returns filled order with Trade details
   - PortfolioService.computePortfolioMetrics() recomputes PnL:
     - For each Position: unrealizedPnL = (currentPrice - avgPrice) * quantity
     - Total = cash + positions' unrealizedPnL
     - Daily PnL from sessionOpen snapshot

5. **Frontend (apps/web)**
   - BlotterPanel polls `GET /sim/orders` (via `useLiveQuotes` hook, stubbed real-time)
   - Blotter updates with new Trade entry
   - If position opened/changed: Portfolio panel updates via `useCandles` hook
   - Chart redraw triggered (but fill price not live-overlaid yet)

### Request Flow: User Clicks "View Profile"

1. **Frontend (apps/web)**
   - User clicks Settings → Profile tab
   - Component mounts: `useEffect(() => fetch('/auth/profile'), [])`

2. **API (services/api)**
   - AuthGuard validates JWT
   - AuthController.getProfile() returns User + Subscription + EntitlementOverrides
   - Response includes preferences (watchlist, theme, etc.)

3. **Frontend Renders**
   - Profile form displays current email, country, experienceLevel
   - Subscription card shows current plan (Sentinel: free, AI Research: free, etc.)
   - Theme picker (light/dark) updates workspaceStore, persisted to localStorage

### Request Flow: Sentinel Observes a Trap

1. **User's trade context**
   - User holds NSE:RELIANCE long 100 shares
   - Price breaks above resistance ($2800) on low volume
   - Sentiment sheet shows declining open interest

2. **Frontend triggers Sentinel**
   - Sentinel workspace auto-polls or user clicks "Analyze Now"
   - POST `/sentinel/orchestrator/invoke` with { symbol: "NSE:RELIANCE", userId }

3. **API (services/api)**
   - SentinelController.invokeOrchestrator() calls services/sentinel internal endpoint
   - ServiceToken added to request (not end-user JWT)
   - Passes symbol, userId, current quote

4. **Sentinel (services/sentinel)**
   - OrchestratorService.invoke() calls four agents in parallel:
     - MarketTechnicalAgent: fetches candles, checks volume vs 20-day avg, OI trend
       - Finds: volume below avg, OI declining
       - Emits observation: { pattern: "low-volume-breakout", confidence: 0.6, evidence: {...} }
     - EmotionAgent: checks user's entry history (via api read-only)
       - User entered after already +2% move
       - Emits observation: { pattern: "fomo-entry", confidence: 0.5 }
     - TrapSafetyAgent: combines signals
       - low-volume + declining-OI + fomo-entry = composite score 0.75
       - Emits observation: { pattern: "bull-trap", confidence: 0.75 }
     - ComplianceAuditAgent: logs all observations to SentinelObservation table
       - category: "market-risk" or "behavioral-risk"
   - OrchestratorService synthesizes:
     - Confidence ≥ threshold → surface to user
     - Generates friendly text: "Price has broken above resistance, but volume is below the 20-day average and open interest is declining. This resembles a low-conviction breakout. Consider waiting for confirmation."
     - Returns combined observations + synthesized warning

5. **Frontend (apps/web)**
   - LiveSafetyFeed updates (real-time via polling or WebSocket, stubbed)
   - SafetyCard renders: pattern name, symbol, evidence summary, confidence meter
   - User clicks "Why?" → Evidence panel shows:
     - Volume: 200K (avg: 500K, -60%)
     - OI: declining 5%
     - Entry timing: +2% into move (FOMO flag)
   - User reviews and decides: proceed or wait for confirmation

---

## 14. Improvement Opportunities

### High-Impact, Low-Effort

1. **Expose Journal Endpoints** (2-3 hours)
   - Add POST /journal, GET /journal to api
   - Integrate JournalEntryForm into sidebar
   - Wire emotion agent to read journal entries
   - **Impact**: Emotion intelligence becomes usable; Trap detection more accurate

2. **Implement Screener Filters** (4-5 hours)
   - Add filter backend: P/E, market cap, sector, price range
   - Wire to Instrument query with SQL WHERE
   - Add filter UI to MarketsWorkspace
   - **Impact**: Watchlist → Screener workflow becomes complete

3. **Watchlist Persistence** (2 hours)
   - Move watchlist from localStorage to UserPreference
   - Add POST/PUT /auth/preferences endpoint
   - **Impact**: Watchlist persists across sessions/devices

4. **Real Dhan Scrip-Master Import** (6-8 hours)
   - Complete services/market-data scrip-master sync
   - Backfill Instrument table with all Dhan symbols (securityId, exchangeSegment)
   - Add Dhan master update job (weekly cron via n8n)
   - **Impact**: Real market data ingestion ready for phase 2

### Medium-Impact, Medium-Effort

5. **TradeW AI Research Workspace** (20-30 hours)
   - Implement eight agents (placeholder implementations with mock responses)
   - Wire agents to services/tradew-ai
   - Add Research workspace panel
   - Memory storage for research outputs
   - **Impact**: Second pillar becomes usable; competitive feature

6. **Bracket Orders** (16-20 hours)
   - Schema: parentOrderId already exists, add child SL + target orders
   - OrderService: place entry → create SL/target as children (status PENDING until entry fills)
   - Trading-engine: on entry fill, activate children
   - UI: OrderForm add SL % + Target % shortcuts
   - **Impact**: Risk/reward management workflow; professional trader feature

7. **Historical Candle Retrieval** (10-12 hours)
   - Dhan OHLC endpoint integration (services/market-data)
   - Database: Candle model (timestamp, symbol, open, high, low, close, volume)
   - Chart caching layer (Redis TTL)
   - Technical indicator library (RSI, EMA, Bollinger, MACD, Stochastics)
   - **Impact**: Charting becomes real; backtesting foundation

### High-Impact, High-Effort

8. **Email Verification & Password Reset** (12-16 hours)
   - Choose email provider (SendGrid, AWS SES, Resend)
   - Implement verification token flow
   - Password reset link generation + safe token expiry
   - UI: confirmation email, reset form
   - **Impact**: Production security requirement

9. **Real Broker Integration (Dhan Live Mode)** (30-40 hours)
   - Dhan API: place order, get fills, fetch positions, stream quotes
   - Order mapping: paper order ↔ Dhan order ID
   - Session management: Dhan session token refresh
   - Risk gating (max position size, max daily loss)
   - **Impact**: Real trading capability; revenue trigger

10. **User Feedback Loop for Trap Signals** (16-20 hours)
    - Add "Was this right?" button on SafetyCard
    - Store user feedback → ConceptPromotion table
    - Compute learned weights based on feedback frequency
    - Rebalance Trap & Safety agent thresholds
    - **Impact**: Sentinel signals become personalized; retention improves

### Technical Debt

11. **Extract services/auth as Separate Service** (12-16 hours)
    - Move AuthModule to services/auth/
    - Token validation becomes internal REST call
    - Triggers at v0.9 scale (50k concurrent sessions), not before
    - **Priority**: Deferred per ARCHITECTURE.md §2.1

12. **Consolidate PnL Logic** (8-10 hours)
    - Today: both api and trading-engine compute PnL
    - Move all logic to api; trading-engine read-only for fills
    - Eliminate divergence
    - **Impact**: Correctness, maintainability

13. **Migrate trading-engine from SQLite to Postgres** (20-24 hours)
    - Schema: Order, Trade, Position, PaperWallet
    - ORM: either Prisma (shared schema) or SQLAlchemy
    - Foreign keys: link to shared Instrument table
    - Migration job: backfill from SQLite
    - **Priority**: Post v0.4, not critical path

14. **Add Structured Logging** (6-8 hours)
    - Every service: JSON logs with request ID, user ID, latency
    - Centralize to Grafana Loki or ELK
    - Dashboards: request latency, error rate, agent invocation metrics
    - **Impact**: Observability; production debugging

---

## 15. Production Readiness Matrix

| Feature | Completion % | Code Quality | Test Coverage | Backend | Frontend | Database | Ready? |
|---|---|---|---|---|---|---|---|
| **Paper Trading (OMS)** | 85% | High | Low (50%) | ✅ | ✅ | ✅ | 🟡 Staging |
| **Market Data (Simulated)** | 70% | Medium | Low (30%) | 🟡 | ✅ | ✅ | 🟡 Staging |
| **Portfolio & PnL** | 75% | High | Low (40%) | ✅ | ✅ | ✅ | 🟡 Staging |
| **Authentication** | 80% | High | Medium (70%) | ✅ | ✅ | ✅ | 🟡 Staging |
| **Subscriptions & Entitlements** | 60% | Medium | Low (20%) | 🟡 | 🟡 | ✅ | ❌ Dev |
| **Sentinel Safety Nets** | 65% | Medium | Low (30%) | 🟡 | ✅ | ✅ | 🟡 Staging |
| **Trap Detection** | 70% | Medium | Low (20%) | 🟡 | ✅ | ✅ | 🟡 Staging |
| **Trading Journal** | 40% | Low | None | ❌ | 🟡 | ✅ | ❌ Dev |
| **Emotion Intelligence** | 50% | Low | None | ❌ | ✅ | ✅ | ❌ Dev |
| **TradeW AI Research** | 10% | N/A | None | ❌ | 🟡 | ✅ | ❌ Design |
| **Learning Hub** | 5% | N/A | None | ❌ | ❌ | ❌ | ❌ Design |
| **Knowledge Graph** | 50% | Medium | Low (20%) | 🟡 | ✅ | ✅ | 🟡 Staging |
| **Watchlist & Screener** | 40% | Low | None | ❌ | ✅ | ✅ | ❌ Dev |
| **Real Dhan Integration** | 20% | Low | None | ❌ | ❌ | 🟡 | ❌ Design |
| **Bracket Orders** | 5% | N/A | None | ❌ | ❌ | 🟡 | ❌ Design |

**Color Key:**
- 🟢 Production Ready
- 🟡 Partial (staging, needs testing)
- ❌ Not Ready (dev/design phase)

---

## 16. Developer Navigation Guide

**Quick Reference: Where to Find Everything**

### Authentication & Sessions
- **Login/Signup flows**: `apps/web/src/app/login/`, `apps/web/src/app/signup/`
- **JWT handling**: `services/api/src/auth/auth.service.ts`
- **Session state**: `apps/web/src/lib/store/sessionStore.ts` (Zustand)
- **Protected routes**: `services/api/src/auth/auth.guard.ts`, `@UseGuards(AuthGuard)`

### Portfolio & Trading
- **Order placement**: `services/api/src/sim/order.service.ts`
- **Position tracking**: `services/api/src/sim/portfolio.service.ts`
- **PnL calculations**: Position model + Portfolio service logic
- **OMS client**: `apps/web/src/lib/oms.ts`
- **Trade terminal UI**: `apps/web/src/components/terminal/TerminalWorkspace.tsx`

### Market Data & Quotes
- **Quote ingestion**: `services/market-data/src/ingestion/`
- **Instrument metadata**: `services/market-data/src/instruments/`
- **Dhan integration**: `services/market-data/src/instruments/scrip-master.ts`
- **Live quote hook**: `apps/web/src/lib/hooks/useLiveQuotes.ts`
- **Quote model**: Prisma `Quote`, one per Instrument (updated in-place)

### Sentinel (Safety Nets)
- **Main orchestrator**: `services/sentinel/src/orchestrator/orchestrator.service.ts`
- **Four agents**: `services/sentinel/src/intelligence/[market-technical|emotion|trap-safety].agent.ts`
- **Compliance audit**: `services/sentinel/src/compliance/compliance.service.ts`
- **Ontology (concepts)**: `knowledge-base/` YAML files
- **Seeding**: `services/sentinel/scripts/seed-ontology.ts`
- **Frontend**: `apps/web/src/app/sentinel/page.tsx`, `apps/web/src/components/sentinel/*`

### TradeW AI (Research)
- **Agent definitions** (placeholder): `agents/tradew-ai/` (not yet implemented)
- **Runtime** (stub): `services/tradew-ai/` (not yet implemented)
- **Frontend**: `apps/web/src/app/research/page.tsx` (placeholder)
- **Memory storage**: `MemoryRecord` model, stored with sourceKind="research"

### Learning Hub
- **Frontend**: `apps/web/src/app/learning/page.tsx` (placeholder, mock data only)
- **Backend**: Not yet implemented
- **Database**: Would need Course/Lesson/UserProgress models

### Knowledge Graph & Memory
- **Memory API**: `services/api/src/knowledge/knowledge.service.ts`
- **Memory model**: Prisma `MemoryRecord`, pgvector embeddings
- **Concept graph**: Prisma `GraphNode`, `GraphEdge`
- **Sentinel concepts**: Prisma `ConceptNode`, `ConceptEdge`, `ConceptObservation`
- **Frontend visualization**: `apps/web/src/app/knowledge/page.tsx`, `KnowledgeGraph.tsx`, `Mermaid.tsx`

### Database & Prisma
- **Schema**: `packages/database/prisma/schema.prisma` (single source of truth)
- **Migrations**: `packages/database/prisma/migrations/`
- **Seeding**: `packages/database/prisma/seed.ts` (instruments, plans, concepts)
- **Client generation**: `npm run db:generate`
- **Migrations**: `npm run db:migrate`

### API Routes & Controllers
- **Auth**: `services/api/src/auth/auth.controller.ts`
- **Trading**: `services/api/src/sim/sim.controller.ts` (placeOrder, getOrders, portfolio)
- **Market Data**: `services/api/src/market-data/market-data.controller.ts` (quotes, instruments)
- **Entitlements**: `services/api/src/entitlements/entitlements.controller.ts` (access checks)
- **Sentinel**: `services/api/src/sentinel/sentinel.controller.ts` (orchestrator invoke)
- **Knowledge**: `services/api/src/knowledge/knowledge.controller.ts` (memories, graph)

### Charts & Visualizations
- **Charting library**: `lightweight-charts` (lightweight alternative to TradingView)
- **Chart component**: `apps/web/src/components/charts/TradeChart.tsx`
- **Candle hook**: `apps/web/src/lib/hooks/useCandles.ts` (mock candles, real API pending)
- **Mermaid diagrams**: `apps/web/src/app/knowledge/Mermaid.tsx`
- **Indicators**: `apps/web/src/lib/technicals.ts` (RSI, EMA, Bollinger, VWAP, CPR — math functions)

### State Management
- **Session state**: `apps/web/src/lib/store/sessionStore.ts` (user, JWT, login state)
- **Workspace state**: `apps/web/src/lib/store/workspaceStore.ts` (panel layout, active symbol, theme)
- **Trade basket state**: `apps/web/src/lib/store/tradeBasketStore.ts` (pending order form)
- **Hydration check**: `apps/web/src/lib/store/useHydrated.ts` (prevent SSR mismatch)

### Styling & Design
- **Design system**: `docs/design-reference/DESIGN-SYSTEM.md` (binding spec from Emergent mockups)
- **Tailwind config**: `apps/web/tailwind.config.ts`
- **Tailwind CSS**: `apps/web/src/app/globals.css`
- **Component library**: `packages/ui/` (early-stage, extraction in progress)
- **Icon set**: `apps/web/src/components/shell/icons.tsx` (custom SVG exports)

### Utilities & Helpers
- **API client**: `apps/web/src/lib/api.ts` (fetch wrapper with auth headers)
- **Formatting**: `apps/web/src/lib/format.ts` (currency, percent, date formatting)
- **Technical analysis**: `apps/web/src/lib/technicals.ts` (RSI, EMA, Bollinger math)
- **Options pricing**: `apps/web/src/lib/black-scholes.ts` (call/put Greeks)
- **Keyboard shortcuts**: `apps/web/src/lib/store/useKeyboardShortcuts.ts` (Cmd+K, Esc, etc.)

### Configuration & Environment
- **Root package.json**: Monorepo workspace configuration, workspace scripts
- **API .env**: `services/api/.env.example` → define DATABASE_URL, JWT_SECRET, etc.
- **Web .env**: `apps/web/.env.local` → define NEXT_PUBLIC_API_URL
- **Sentinel .env**: `services/sentinel/.env.example`
- **Feature flags**: Environment variables (NEXT_PUBLIC_FEATURE_*, FEATURE_*)

### Testing
- **Unit tests**: Not yet implemented (recommended: Jest + Testing Library)
- **Integration tests**: Not yet implemented (recommended: Supertest for API)
- **E2E tests**: Not yet implemented (recommended: Playwright or Cypress)

### Deployment & Infrastructure
- **Docker**: `infra/docker/docker-compose.yml` (local dev setup)
- **Kubernetes**: `infra/k8s/` (production k8s manifests, AWS EKS target)
- **Terraform**: `infra/terraform/` (IaC for VPC, RDS, EKS, ElastiCache)
- **CI/CD**: `.github/workflows/` (GitHub Actions, path-based triggers per service)

### Documentation
- **Architecture**: `ARCHITECTURE.md` (binding service boundaries, communication patterns)
- **Product architecture**: `docs/product-architecture/README.md` (start here; reading order given)
- **TRADEW-OS Constitution**: `docs/product-architecture/TRADEW-OS.md` (platform philosophy, non-negotiable rules)
- **Sentinel design**: `docs/product-architecture/SENTINEL.md` (agent roster, trap detection, features)
- **TradeW AI design**: `docs/product-architecture/TRADEW-AI.md` (research agents, workflows)
- **Design system**: `docs/design-reference/DESIGN-SYSTEM.md` (component spec, tokens, layout rules)
- **Engineering knowledge**: `knowledge/` (Obsidian vault with durable developer notes)

---

## Appendix: Quick Reference Commands

### Development Startup

```bash
# Install dependencies
npm install

# Generate Prisma Client
npm run db:generate

# Run migrations
npm run db:migrate

# Seed database (instruments, plans, Sentinel ontology)
npm run seed

# Start API dev server (watch mode)
npm run dev:api

# Start web dev server (watch mode)
npm run dev:web

# Validate Sentinel ontology (if implemented)
npm run ontology:validate

# Seed Sentinel ontology
npm run ontology:seed
```

### Database

```bash
# Generate Prisma Client after schema changes
npm run db:generate -w @tradew/database

# Create a new migration
npm run db:migrate -w @tradew/database -- --name feature_name

# Reset database (dev only)
npx prisma migrate reset --schema packages/database/prisma/schema.prisma
```

### Building

```bash
# Build all workspaces
npm run build

# Build only API
npm run build:api

# Build only web
npm run build:web
```

### Monitoring & Debugging

- **API logs**: Check stdout of `npm run dev:api`
- **Database queries**: Set `DEBUG=prisma:*` before running
- **Browser DevTools**: Inspect Network tab for API calls, Console for client errors
- **Structured logs**: JSON format logged to stdout (parseable by ELK/Grafana Loki)

---

**This document is the authoritative reference for all TradeW codebase navigation and implementation guidance. Keep it updated as the architecture evolves.**

