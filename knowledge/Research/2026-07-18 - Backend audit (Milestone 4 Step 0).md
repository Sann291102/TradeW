---
type: research
date: 2026-07-18
tags: [research, audit, backend, milestone-4, prisma, postgres]
status: verified
---

# Backend Audit — Phase 2, Milestone 4, Step 0 (mandatory pre-integration audit)

## For future Claude
Read this before starting any Milestone 4 subsystem integration, and before assuming any service exists just because `docs/product-architecture/*.md` or `ARCHITECTURE.md` describes it. Those docs describe the **target** architecture; this audit is what's **actually built**, verified by reading code and querying the live database directly — not by trusting doc claims. Cross-reference with [[2026-07-17 - Sentinel Brain audit]] (still accurate, re-confirmed here).

## Headline finding

**Only two backend services are real and running: `services/api` (a NestJS monolith/gateway) and `services/sentinel` (the Sentinel Brain).** Every other service directory named in `ARCHITECTURE.md` — `services/auth`, `services/market-data`, `services/notification`, `services/tradew-ai`, `services/analytics` — is a **placeholder containing only a README** describing intent, with zero code. `services/trading-engine` is a different case: real, hardened Python code described in its README, but that code has **not been copied into the monorepo yet** ("not yet populated. Waiting on execution approval") — it currently exists only in the separate `TradeW-Setup-main` planning tree and is a **live-money** Dhan options bot, distinct from the paper-trading simulator (`services/api`'s `sim` module) the frontend currently talks to.

This matters directly for how Milestone 4's 8 subsystems should be sequenced — see "Recommended order" at the end.

---

## 1. Existing services

| Service | Status | What's actually there |
|---|---|---|
| `services/api` | 🟢 real, running | NestJS monolith. Modules: `auth`, `entitlements`, `instruments`, `knowledge`, `market-data`, `sim`, `sentinel` (proxy), `prisma`. Owns the one Postgres DB via Prisma. Listens on `:4000`. |
| `services/sentinel` | 🟢 real, running | NestJS. The "Brain" — `PrismaMemoryStore`, `PrismaKnowledgeGraph`, `ConceptLearningEngine`, pattern/outcome/historical-similarity services, orchestrator. Listens on `:4010`, internal-only (`ServiceTokenGuard`), called by `services/api`. |
| `services/auth` | 🟡 placeholder, no code | README states auth logic already lives inside `services/api`'s `auth` module by design; this folder is reserved for the day it's extracted to a real network service ("v0.9 50k concurrent" trigger, not yet reached). **Do not build a second auth implementation here.** |
| `services/market-data` | 🟡 placeholder, no code | README describes a planned live-quote ingest service (Dhan today, TrueData/Global Datafeeds later) publishing ticks over WebSocket. Does not exist. Today's only market-data code is `services/api`'s thin `market-data` module (one endpoint, DB-backed quote lookup — see §2). |
| `services/notification` | 🟡 placeholder, no code | README describes planned alert fanout + n8n trigger service. Does not exist. `services/api` has no notification module at all. |
| `services/tradew-ai` | 🟡 placeholder, no code | README describes the planned TradeW AI runtime (`POST /agents/:name/invoke`, agent roster per `TRADEW-AI.md`). Does not exist. There is no AI/LLM backend anywhere in the repo today. |
| `services/analytics` | 🟡 placeholder, no code | README describes planned portfolio/PnL aggregation. Does not exist. |
| `services/trading-engine` | 🟡 "not yet populated" (README calls the underlying code 🟢) | The actual Python bot (`extreme_algo_bot_v2.py`, webhook-driven, real Dhan broker execution) lives outside the monorepo and has not been migrated in. This is **not** the same thing as `services/api`'s paper-trading `sim` module — conflating the two would be a real-money-risk mistake. |

## 2. Existing APIs — `services/api` (`:4000`, base for all routes below)

| Method | Route | Purpose | Auth | Status |
|---|---|---|---|---|
| POST | `/auth/signup` | create account, returns JWT + refresh | none | ✅ working, verified live (created real users this session) |
| POST | `/auth/login` | authenticate | none | ✅ working, verified live |
| POST | `/auth/refresh` | rotate refresh token | refresh token in body | ✅ working |
| POST | `/auth/logout` | revoke refresh token | JWT | ✅ working |
| GET | `/auth/me` | current user profile | JWT | ✅ working |
| PATCH | `/auth/me` | update profile (country/experience/options familiarity) | JWT | ✅ working |
| GET | `/auth/preferences` | list preferences | JWT | ✅ working |
| POST | `/auth/preferences/:key` | upsert one preference | JWT | ✅ working |
| GET | `/entitlements/me` | caller's capabilities | JWT | ✅ working |
| GET | `/entitlements/me/check/:capability` | single capability check | JWT | ✅ working |
| GET | `/entitlements/plans` | list plans | none | ✅ working |
| POST | `/entitlements/admin/subscriptions` | activate a subscription | `ADMIN_API_TOKEN` | ✅ working (admin-only) |
| POST | `/entitlements/admin/subscriptions/:id/cancel` | cancel | `ADMIN_API_TOKEN` | ✅ working |
| POST | `/entitlements/admin/overrides` | grant/revoke a capability override | `ADMIN_API_TOKEN` | ✅ working |
| GET | `/entitlements/admin/users/:userId/capabilities` | inspect a user's capabilities | `ADMIN_API_TOKEN` | ✅ working |
| GET | `/instruments/search?q=` | instrument search | JWT | ✅ working (14 instruments seeded) |
| GET | `/market-data/quote/:instrumentId` | single quote (DB `Quote` row, not live feed) | JWT | ⚠️ **partial** — reads a static `Quote` table row, no live tick ingestion, no OHLC, no history, no market movers, no option chain endpoint at all |
| POST | `/sim/orders` | paper-trade order (writes `Order`+`Trade`+`Position`) | JWT | ✅ working, verified live earlier this session |
| GET | `/sim/positions` | list positions | JWT | ✅ working |
| POST | `/sentinel/observe` | trigger a Sentinel observation (proxies to `services/sentinel`, with trade/position context gathered locally first) | JWT + capability | ✅ working (proxy) |
| POST | `/sentinel/explain` | ask Sentinel to explain | JWT + capability | ✅ working (proxy) |
| POST | `/sentinel/brain/search` | semantic search over the Brain | JWT + capability | ✅ working (proxy) |
| GET | `/sentinel/brain/strategy?pattern=` | strategy intelligence lookup | JWT + capability | ✅ working (proxy) |
| GET | `/sentinel/observations` | list a user's observations | JWT + capability | ✅ working (proxy) |
| GET | `/sentinel/session-summary` | today's trade count / P&L / realized | JWT + capability | ✅ working — **local to `services/api`**, not proxied (own Prisma aggregation over `Trade`/`Position`) |
| GET | `/sentinel/journal` | list journal entries | JWT + capability | ✅ working — **local**, own `JournalEntry` table |
| POST | `/sentinel/journal` | create a journal entry | JWT + capability | ✅ working — **local** |
| GET/GET/GET | `/knowledge/tree`, `/file`, `/recent`, `/search`, `/graph`, `/activity` | in-app Obsidian-vault viewer (dev tool, reads `TradeW/knowledge/` off disk) | `KnowledgeWorkspaceGuard` (dev-gated) | ✅ working, unrelated to product data |
| GET | `/health` | liveness | none | ✅ working |

**Missing entirely (no endpoint exists anywhere):** OHLC/candle history, market movers/gainers-losers, sector data, option chain, order book/depth, notifications (any kind), learning content, research/knowledge-graph read API, TradeW AI conversation endpoint, watchlist persistence (server-side — today's watchlist is 100% frontend mock data).

## 3. Existing APIs — `services/sentinel` (`:4010`, internal only, `ServiceTokenGuard`)

`GET /health`, `POST /observe`, `GET /observations`, `POST /explain`, `POST /brain/search`, `GET /brain/stats`, `GET /brain/strategy`. All real (confirmed in the earlier Sentinel Brain audit — `PrismaMemoryStore`/`PrismaKnowledgeGraph` do real Postgres+pgvector reads/writes, not stubs). **No direct graph-query endpoint** (e.g. "get neighbors of node X") exists yet — `KNOWLEDGE-GRAPH.md` §2 already flags this as a gap to close when Research/Learning need it.

## 4. Database — live Postgres, introspected directly (not just Prisma's view)

- **Extensions**: `plpgsql` (default), `vector` 0.8.5 (pgvector — installed, active).
- **Tables**: 21 product tables + `_prisma_migrations`. Exactly matches `schema.prisma` — **zero drift**, confirmed via `prisma migrate status` ("Database schema is up to date!") and direct `\dt` introspection.
- **Views**: none.
- **Custom functions/triggers**: none — the 118 "functions" `\df` returns are all pgvector's own operator/type-support functions (`vector_*`, `halfvec_*`, `cosine_distance`, etc.), not app-defined.
- **Indexes**: 57, all Prisma-declared (`@@index`/`@@unique`), no extras, no missing ones relative to schema.
- **Migrations**: 3, all applied — `20260710000000_init`, `20260710000100_sprint1_identity`, `20260716000000_ai_foundation_entitlements`. No pending migrations.
- **Live row counts** (real data from earlier sessions' testing, not synthetic): `User` 5, `Instrument` 14, `Quote` 14, `Order`/`Trade`/`Position` 1 each, `Plan` 5, `PlanGrant` 22, `Subscription` 2, `MemoryRecord`/`GraphNode`/`GraphEdge`/`SentinelObservation` a handful each (Sentinel Brain has been exercised, not empty).

## 5. Prisma — models, relations, what's unused

21 models across 5 concerns, one schema, one datasource (`postgresqlExtensions` preview feature for `vector`):

- **Identity/auth**: `User`, `RefreshToken`, `UserPreference`, `AuditEvent`
- **Trading (paper)**: `Instrument`, `Quote`, `Order`, `Trade`, `Position` — enums `InstrumentType`, `OrderSide`, `OrderStatus` (note: `OrderStatus` only has `FILLED`/`REJECTED` — **no `PENDING`/`OPEN`/`PARTIAL` states exist**, meaning the current order model can't represent a resting limit order, only instant paper fills)
- **Entitlements/billing**: `Plan`, `PlanGrant`, `Subscription`, `EntitlementOverride`, `UsageCounter` — enums `SubscriptionStatus`, `QuotaPeriod`
- **AI foundation / Knowledge Graph**: `MemoryRecord`, `MemoryRelation`, `GraphNode`, `GraphEdge` (this is the physical store `KNOWLEDGE-GRAPH.md` and `RESEARCH-VAULT.md` both point to — confirmed real, not aspirational)
- **Sentinel-specific**: `SentinelObservation`, `JournalEntry`
- **News**: `NewsEvent` — schema exists, **zero rows, no writer anywhere in the code** (no ingestion job, no controller writes to it) — a genuinely unused-so-far model, not a stub with fake data, just not fed yet.

No models are dead/orphaned in the sense of "should be deleted" — `NewsEvent` is simply ahead of its consumer (the News ingestion workflow `N8N-WORKFLOWS.md` already designs for). Every other model has both a writer and a reader in real code paths.

## 6. Frontend mock data — exact map of what to replace with what

| Page / component | Mock source | Real service to connect (once built) |
|---|---|---|
| `/dashboard` (IndexOverview, MarketMovers, SectorHeatmap, TrendingStocks, MarketNews, WatchlistWidget, PortfolioSummary) | `lib/mock/market.ts` | `services/market-data` (doesn't exist yet — see §8) for quotes/movers/news; `services/api`'s `sim`/Prisma for the portfolio numbers (real data already exists here, just not wired) |
| `/markets` | `lib/mock/market.ts` | same as above |
| `/portfolio` | `lib/mock/market.ts` (`PORTFOLIO_SUMMARY`) | `services/api`'s `sim` module (`Position`/`Trade`/`Order` — **real data, real endpoints partially exist**, this is the most connectable mock today) |
| `/learning` + `LearningMiniPanel` | `lib/mock/learning.ts` | no backend exists (§8) |
| `/research` + `ResearchMiniPanel` | `lib/mock/research.ts` (just tab labels, always "coming soon") | no backend exists (§8) |
| Shell `Ticker` | `lib/mock/market.ts` | `services/market-data` (doesn't exist) |
| Terminal panels: `ChartPanel`, `WatchlistPanel`, `NewsPanel`, `PortfolioMiniPanel` | `lib/mock/market.ts` | mixed — Portfolio mini panel is real-data-ready now (`sim`); Chart/Watchlist/News need live market-data |
| `apps/web/src/app/notifications/*`, `NotificationCenter` | `lib/store/workspaceStore.ts` seed | no backend exists (§8) |
| Terminal `OrderTicketPanel`, `BlotterPanel`, `DepthPanel`, `OptionChainPanel` | UI-only placeholders (M2/M3 explicitly did not wire these) | `OrderTicketPanel`→`sim/orders` (real, connectable now); `BlotterPanel`→`sim/positions` + a missing orders-list/trades-list endpoint (§8); `DepthPanel`/`OptionChainPanel`→no backend exists |

**Already real, not mock**: `/login`, `/signup`, `/profile` (all call `services/api` today, verified live), `/sentinel` (fully wired to the real proxy + local endpoints), `/knowledge` (real FS-backed service).

## 7. Frontend API clients

- **One fetch wrapper**: `apps/web/src/lib/api.ts` — plain `fetch`, no axios/React Query/SWR anywhere in the repo (confirmed via package.json + grep). Handles JWT attach, 401→refresh→retry once, and throws on non-2xx. This is the correct, only client — every integration in this milestone should call through it, not create a second one.
- **One legitimate secondary client**: `lib/knowledge.ts`, which imports and reuses `api()` for normal calls but also redeclares its own `API_URL` constant to build a raw `EventSource` URL for `/knowledge/stream` SSE (a fetch wrapper can't do SSE). Minor, easily-fixed duplication: `API_URL` should be exported from `lib/api.ts` and imported here instead of redeclared — flagging as a one-line cleanup, not a blocker.
- **No duplicated request logic** anywhere else — Milestone 2/3's mock-data pages never built their own fetch calls, they just imported static arrays from `lib/mock/*`, so there's nothing to "un-duplicate" there, only mock imports to swap for `api()` calls once real endpoints exist.
- **Dormant reference implementation**: `archive/web-trade-sprint0-page.tsx.txt` (per Milestone 2's own archive) already contains working calls to `/instruments/search`, `/market-data/quote/:id`, `/sim/orders`, `/sim/positions` — this is the exact contract to reintroduce into `OrderTicketPanel`/`BlotterPanel` in Step 3.

## 8. Gap summary — what Milestone 4's 8 subsystems actually need before "connect" is possible

| Subsystem | Backend readiness | What connecting means |
|---|---|---|
| **Auth** (Step 1) | ✅ fully real | Wire the already-working `apps/web/src/lib/api.ts` calls into the M2/M3 UI properly (session-aware Sidebar/TopBar, real route guarding) — the backend needs nothing new. |
| **Portfolio/Orders** (Step 3) | ✅ mostly real | `sim/orders`, `sim/positions` exist and work. Missing: an orders-list and trades-list endpoint (`Order`/`Trade` tables exist, just no `GET /sim/orders` or `/sim/trades` controller method yet) — a small, in-module addition to `services/api`'s existing `SimController`, not a new service. |
| **Sentinel** (Step 4) | ✅ fully real | `/sentinel/*` proxy + local endpoints all work today, already partially wired in `/sentinel/page.tsx`. Extending Sentinel panels in the M3 dock to use real data is pure frontend wiring. |
| **Market Data** (Step 2) | ⚠️ ~10% real | Only single-instrument quote lookup exists (DB row, not live). OHLC, movers, option chain, ticker, watchlist persistence all need building **inside `services/api`'s existing `market-data` module** (per its own README's "no network hop until the extraction trigger" reasoning) — this is new backend code, not a new service, and squarely inside "if something is missing, implement it in the correct backend service" from this milestone's own rules. |
| **TradeW AI** (Step 5) | ❌ 0% — no code at all | `services/tradew-ai` is a README. Nothing to "connect" — this subsystem cannot proceed without first building an actual agent runtime, which is a significant scope of new backend work, not integration. Flag for explicit discussion before attempting. |
| **Learning** (Step 6) | ❌ 0% — no code, no tables | No `Lesson`/`LearningPath`/`Progress` Prisma models exist. Needs new models + a new `services/api` module (or the still-unbuilt Knowledge Graph read API from `KNOWLEDGE-GRAPH.md` §2). |
| **Research** (Step 7) | ❌ ~5% | The physical store exists (`MemoryRecord`/`GraphNode`/`GraphEdge`, real, active) but no read API is exposed beyond Sentinel's own use — `KNOWLEDGE-GRAPH.md` §2 already calls this out as an open item. |
| **Notifications** (Step 8) | ❌ 0% — no code, no tables | No notification model, no service. Needs both. |

## Bottom line

Of the 8 subsystems Milestone 4 lists, **3 have a real, connectable backend today** (Auth, Portfolio/Orders, Sentinel), **1 is ~10% there** (Market Data — single-quote lookup only), and **4 have no backend code at all** (TradeW AI, Learning, Research, Notifications). This isn't a blocker to the milestone's philosophy — the milestone's own rules already say "if something is missing, implement it in the correct backend service, never work around it in the frontend" — but it means the first four subsystems listed in the brief (Auth → Market Data → Portfolio → Sentinel) are not uniformly ready, and the order should follow actual backend readiness rather than the brief's listed order, to keep each incremental step genuinely "connect, don't build a service from scratch."

## Related
- [[../_INDEX.md]]
- [[2026-07-17 - Sentinel Brain audit]] — re-confirmed accurate here
- [[2026-07-17 - Oracle migration assessment]] — separate blocker, not touched by this audit
- docs/product-architecture/GENESIS-V2-BLUEPRINT.md, TRADEW-OS.md (target architecture these findings are measured against)
