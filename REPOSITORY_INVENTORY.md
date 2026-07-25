# TradeW — Repository Inventory (A→Z)

**Audit date:** 2026-07-25
**Repo:** `D:\TradeW LLC\TradeW`
**Branch audited:** `feat/notifications` @ `2302a7a` (default/PR base branch: `feat/knowledge-workspace`)
**Scope:** 537 git-tracked files. Read-only audit — nothing in the repository was created, modified, or deleted.

> **Note on file placement.** The instructions both forbade creating any file ("Never modify the repository", "DO NOT modify, create, delete, rename, or move any file") and asked for a document named `REPOSITORY_INVENTORY.md`. Resolution: this document was written to the session scratchpad, **outside** the repository, and delivered as a file. The repo working tree is untouched (`git status` shows only the pre-existing untracked `.claude/Settings.local.json`).

---

# 1. Executive Summary

## 1.1 Project purpose

TradeW is an **Indian-markets (NSE/BSE/MCX) AI trading operating system**. It is a *platform*, explicitly not an advisory or auto-trading product. The binding product constitution (`docs/product-architecture/TRADEW-OS.md`, `ARCHITECTURE.md` §1.3, root `CLAUDE.md` Rule 2) states that AI never places, blocks, or delays an order, and never emits Buy/Sell/Entry/Exit/Target language.

Four product pillars, all served as workspaces inside one web app:

| Pillar | What it does | Where it lives |
|---|---|---|
| **Core Platform** | Market data, charts, option chain, paper-trading OMS, portfolio | `apps/web` + `services/api` |
| **Sentinel (Safety Nets)** | Observation-only market/behaviour intelligence with a persistent knowledge brain and a concept ontology | `services/sentinel` + `/sentinel` route |
| **TradeW AI (Research)** | Per-symbol research + ambient assistant | **Design only** — primitives exist in `packages/ai-core`, no runtime service |
| **Learning Hub** | Structured trading education | `/learning` route, UI shell only |

## 1.2 Primary technologies

- **Language:** TypeScript 5.7 end to end (strict mode everywhere). One Python dependency file (`scripts/requirements.txt`, `dhanhq==2.3.0rc1`) used only for Dhan API verification, not in any request path.
- **Runtime:** Node ≥ 20 (global `fetch` is relied on throughout; no HTTP client dependency anywhere).
- **Monorepo:** npm workspaces (`apps/*`, `services/*`, `packages/*`). No Turborepo, Nx, pnpm, or Lerna.
- **Backend:** NestJS 10 (three services), Prisma 5.22 → PostgreSQL 16 + `pgvector`.
- **Frontend:** Next.js 14 App Router, React 18, Tailwind 3.4, Zustand 4.5, Framer Motion 11, `lightweight-charts` 4.2, `react-markdown`/`remark-gfm`, `mermaid` 11.
- **Market data:** DhanHQ v2 — WebSocket binary feed (hand-written parser), REST historical/intraday charts, REST option chain, published scrip-master CSV.
- **AI:** Provider-agnostic layer over Anthropic Messages API, any OpenAI-compatible endpoint (OpenAI / NVIDIA NIM / Ollama), Voyage embeddings, and four research providers (Tavily, Brave, Firecrawl, Anthropic web search).
- **Infra:** Docker Compose (local Postgres + pgAdmin; separate production stack), Caddy reverse proxy, GitHub Actions → GHCR → SSH deploy to an Oracle Cloud arm64 VM.

## 1.3 Overall architecture

```
                       ┌──────────────────────────────────────┐
   browser  ──────────►│  apps/web  (Next.js 14, port 3000)   │
                       └───────┬───────────────────┬──────────┘
                               │ JWT               │ direct fetch/SSE (no auth)
                               ▼                   ▼
              ┌────────────────────────┐   ┌──────────────────────────────┐
              │ services/api  :4000    │   │ live-feed-server.ts  :4600   │
              │ NestJS · single public │   │ standalone Dhan bridge       │
              │ ingress · Prisma       │   │ NO DB, NO auth               │
              └───┬─────────┬──────────┘   └───────────┬──────────────────┘
     x-service-token │      │ HTTP /quotes,/candles,   │  WebSocket + REST
                     │      └──────/optionchain────────┘         │
                     ▼                                            ▼
        ┌────────────────────────┐                        ┌──────────────┐
        │ services/sentinel :4010│                        │   DhanHQ v2  │
        │ internal only          │                        └──────────────┘
        └───────┬────────────────┘
                │
                ▼
        ┌───────────────────────────────────────────────┐
        │  PostgreSQL 16 + pgvector  (one database)     │
        └───────────────────────────────────────────────┘
                ▲
                │ sole writer of Quote
        ┌───────┴────────────────┐
        │ services/market-data   │  :4020 internal ingestor (simulated by default)
        └────────────────────────┘
```

Three architectural rules are enforced in code, not just documented:

1. **One public ingress.** `apps/*` reach only `services/api` — *except* the deliberate exception of the `live-feed-server` bridge, which the browser calls directly.
2. **Sentinel is never a gate.** Every Sentinel call site is wrapped so a failure degrades rather than blocks; the order flow never awaits it.
3. **One schema owner.** `packages/database` holds the single `schema.prisma`; each service has its own `PrismaService` with fault-tolerant boot.

## 1.4 Current development stage

**Late prototype / early alpha.** Roughly v0.3–0.4 against the project's own roadmap.

What genuinely works end to end: authentication with refresh-token rotation and audit logging, entitlements/subscriptions, live Dhan market data (indices + ~212 F&O stocks + all NSE ETFs + 5 MCX commodities), real historical candles and charts, real option chain with per-strike websocket price overlay, a full paper-trading OMS (MARKET/LIMIT/SL/SL_M with a polling matching engine, positions, P&L, wallet), Sentinel's 16-signal observation pipeline with a persistent pgvector-backed brain, a 67-concept YAML ontology with a reasoning engine, and a working EMA-cross backtest engine on real Dhan bars.

What does not exist: **any automated test whatsoever**, the Python trading engine, four of the nine declared services, two of the six declared packages, watchlist persistence, TradeW AI runtime, billing/checkout, and any real deployment.

---

# 2. Complete Folder Tree

Sizes are **git-tracked bytes only** (working-tree `node_modules`/`.next` excluded). File counts are tracked files.

```
TradeW/                                          537 files · ~2.9 MB tracked
│
├── .claude/                          0.3 KB   1 file   Claude Code launch config (api:4000, web:3000)
├── .github/workflows/                2.7 KB   1 file   GitHub Actions deploy pipeline
├── agents/                           5.6 KB   4 files  Declarative agent definitions
│   ├── sentinel/                     4.4 KB   2 files  definitions.json (5 agents) + README — NOT loaded by code
│   └── tradew-ai/                    0.5 KB   1 file   README only, empty
├── apps/                           706.3 KB 138 files
│   ├── admin/                        1.0 KB   1 file   README only — design stage
│   ├── mobile/                       0.8 KB   1 file   README only — v0.9 roadmap
│   ├── terminal/                   217.4 KB   2 files  Single 2,797-line static HTML prototype — superseded
│   └── web/                        487.1 KB 134 files  THE frontend (Next.js 14 App Router)
│       ├── src/app/                          20 files  13 routes + layout + globals.css
│       ├── src/components/                   64 files  charts, dashboard, markets, sentinel, shell, terminal, trade, workspace
│       └── src/lib/                          38 files  api clients, hooks, stores, mock data, domain math
├── archive/                         54.0 KB  16 files  Superseded code as .txt (never deleted — CLAUDE.md Rule 1)
├── docs/                          1,111 KB   57 files
│   ├── ai/                           2.8 KB   1 file   NVIDIA distillation blueprint mapping
│   ├── design-reference/             8.8 KB   2 files  Design system extracted from mockups
│   ├── handbook/                   786.2 KB  28 files  28-chapter engineering handbook (~16,700 lines)
│   ├── product/                    119.2 KB   2 files  Vision & business overview (.docx + .pdf, binary)
│   └── product-architecture/       193.7 KB  23 files  Binding per-feature blueprints
├── infra/                           19.7 KB  10 files
│   ├── docker/                       9.8 KB   6 files  Local compose, prod compose, Caddyfile, backup.sh, .env.prod.example
│   ├── k8s/                          0.3 KB   1 file   README only — empty by design
│   ├── oci/                          8.4 KB   1 file   Oracle Cloud Free Tier deployment guide
│   └── terraform/                    0.4 KB   1 file   README only — empty by design
├── knowledge/                      188.0 KB  28 files  Obsidian vault — ENGINEERING memory for coding agents
│   ├── API/ Decisions/ Gotchas/ Patterns/ Plans/ Research/  + _INDEX.md, README.md
├── knowledge-base/                 106.9 KB  67 files  Sentinel's MARKET-CONCEPT ontology (66 YAML + README)
│   └── 15 domain folders (market-structure, price-action, options, …)
├── packages/                       285.7 KB  91 files
│   ├── ai-core/                     90.9 KB  30 files  AI foundation: providers, memory, RAG, brain, agents, prompts, tools
│   ├── database/                    66.7 KB  16 files  schema.prisma + 12 migrations + seed.ts
│   ├── market-data/                 75.5 KB  17 files  Feed/provider contracts, Dhan adapter, simulator, rate limiter
│   ├── sdk/                          0.4 KB   1 file   README only — NOT BUILT
│   ├── shared/                       0.6 KB   1 file   README only — NOT BUILT (but declared as a dependency)
│   ├── types/                        7.8 KB   6 files  Shared DTOs: entitlements + market-data contracts
│   └── ui/                          43.8 KB  20 files  Design system: 11 components, tokens, Tailwind preset, motion
├── scripts/                          1.8 KB   2 files  README + Python requirements (Dhan SDK, verification only)
├── services/                       446.0 KB 112 files
│   ├── analytics/                    0.8 KB   1 file   README only
│   ├── api/                        127.8 KB  43 files  NestJS BFF — 9 modules, the public ingress
│   ├── auth/                         1.0 KB   1 file   README only — contract boundary, not a deployable
│   ├── market-data/                112.4 KB  18 files  NestJS ingestor + 3 standalone scripts (incl. the 1,193-line live bridge)
│   ├── notification/                 0.9 KB   1 file   README only
│   ├── sentinel/                   199.9 KB  46 files  NestJS intelligence service — brain, ontology, intelligence, backtest
│   ├── trading-engine/               2.1 KB   1 file   README only — Python engine never migrated
│   └── tradew-ai/                    1.1 KB   1 file   README only
├── workflows/                        1.1 KB   1 file   README only — n8n exports, none exist
├── ARCHITECTURE.md                  20.8 KB   1 file   Binding target architecture
├── PROJECT_TEST_AUDIT.md            72.1 KB   1 file   2,248-line manual QA audit
├── README.md                        41.9 KB   1 file   1,071-line project README
├── SENTINEL_BRAIN_PROGRESS.md        4.1 KB   1 file   Brain phase tracker (78%)
├── TRADEW_DEVELOPER_REFERENCE.md    97.1 KB   1 file   2,398-line developer reference
├── package.json / package-lock.json 450.8 KB   2 files  Workspace root
└── .gitignore / .dockerignore        0.6 KB   2 files
```

### Purpose of each folder

| Folder | Purpose | State |
|---|---|---|
| `.claude/` | Dev-server launch configuration for Claude Code's preview tooling | Working |
| `.github/workflows/` | arm64 multi-service build → GHCR → SSH deploy, path-filtered to `main` | Written, never run (no `main` pushes) |
| `agents/` | Version-controlled declarative agent definitions, reviewed like code | `sentinel/definitions.json` exists but nothing loads it |
| `apps/admin` | Internal ops/KYC/DLQ console | Design-only |
| `apps/mobile` | React Native or native — decision deferred to v0.9 | Deliberately empty |
| `apps/terminal` | Original single-file HTML prototype (v0.5) | Historical reference only |
| `apps/web` | The real trader-facing app; every pillar is a workspace here | Active, largest surface |
| `archive/` | Superseded implementations kept as `.txt` — never deleted | 15 archived files + README |
| `docs/handbook` | 28-chapter engineering handbook (executive summary → future vision) | Complete, some chapters describe unbuilt systems |
| `docs/product-architecture` | Per-feature binding blueprints; the spec layer | Mostly current; `SENTINEL.md` is stale |
| `infra/docker` | Local Postgres/pgAdmin; production Caddy + web + api + sentinel + postgres + redis | Local compose works; prod compose unexercised |
| `infra/k8s`, `infra/terraform` | Deliberately empty until real deployment load exists | Empty by design, documented |
| `infra/oci` | Oracle Cloud Free Tier deployment runbook | Documentation |
| `knowledge/` | Obsidian vault — engineering memory for AI coding agents (CLAUDE.md Rule 4) | 26 notes + index, actively maintained |
| `knowledge-base/` | Sentinel's market-concept ontology — 66 YAML concepts across 15 domains | Canonical source, seeded into Postgres |
| `packages/ai-core` | The shared AI foundation every AI product is supposed to compose | Built; ~60% of exports unconsumed |
| `packages/database` | The one Prisma schema + migration history | Active, 12 migrations |
| `packages/market-data` | Shared market-data engine — contracts, Dhan adapter, simulator | Active, consumed by 3 services |
| `packages/sdk`, `packages/shared` | Generated API client / config+logger+errors | **Not built** — both referenced as dependencies |
| `packages/types` | Cross-boundary DTOs | Active |
| `packages/ui` | Design system consumed from TS source via `transpilePackages` | Active, 11 primitives |
| `scripts/` | Repo-wide tooling (bootstrap/codegen/seed/migrate-check planned) | Only a Python requirements file exists |
| `services/api` | The single public ingress / BFF | Active, 9 modules |
| `services/market-data` | Singleton ingestion runtime + the live Dhan bridge scripts | Active |
| `services/sentinel` | Observation-only intelligence runtime | Active, largest service |
| `services/{analytics,auth,notification,trading-engine,tradew-ai}` | Declared boundaries, no code | README-only |
| `workflows/` | n8n workflow JSON exports | Empty |

---

# 3. Every Important File

Every TypeScript/TSX source file is covered. Grouped by package/service. Configuration files are in §4; markdown is in §11.

## 3.1 `packages/types` — shared DTOs

| Field | Value |
|---|---|
| **Path** | `packages/types/src/index.ts` |
| Purpose | Barrel |
| Language | TS |
| Exports | `* from './entitlements'`, `* from './market-data'` |
| Called by | `@tradew/sentinel`, `@tradew/market-data`, `@tradew/market-data-service`, `apps/web` |

**`packages/types/src/entitlements.ts`** (141 lines) — the subscription/entitlement domain (locked decision Q7).
- Enums: `Capability` (SENTINEL, AI_RESEARCH, NEURAL_BRAIN, ADVANCED_MARKET_INTELLIGENCE, PORTFOLIO_INTELLIGENCE, PREMIUM_AGENTS, PAPER_TRADING), `PlanCode` (free, tradew_pro, sentinel_pro, tradew_ultimate, enterprise).
- Types: `SubscriptionStatus`, `PlanCapabilityGrant`, `Plan`, `UsageQuota`, `Subscription`, `EntitlementOverride`, `EntitlementDecision`.
- Interfaces: `EntitlementService`, `SubscriptionLifecycle` (the billing-adapter boundary — nothing else may mutate subscriptions).
- Imports: none. **Note:** `services/api`'s `EntitlementsService` re-declares `EntitlementDecision` locally rather than importing this — a duplicated contract.

**`packages/types/src/market-data.ts`** (75 lines) — the pull-side provider abstraction (locked decision Q6).
- Interfaces: `Candle`, `Quote`, `OptionChainEntry`, `MarketBreadth`, `NewsItem`, `MarketDataProvider` (`getQuote`, `getCandles`, `getOptionChain`, `getMarketBreadth`, `getNews`, `healthCheck`).
- Type: `CandleInterval = '1m'|'5m'|'15m'|'1h'|'1d'`.
- Implemented by: `SimulatedMarketDataProvider` (packages/market-data), `CandleMarketDataProvider` (services/sentinel).

## 3.2 `packages/market-data` — shared market-data engine

**`src/index.ts`** — barrel re-exporting contracts, providers, cache, rate-limit, registry.

**`src/contracts/instrument-ref.ts`** — how an instrument is addressed across providers.
- Exports: `EXCHANGE_SEGMENTS` (NSE_EQ, NSE_FNO, BSE_EQ, BSE_FNO, MCX_COMM, IDX_I), `ExchangeSegment`, `isExchangeSegment()`, `SEGMENT_BY_CODE` (numeric wire codes → segment), `InstrumentRef`, `isBrokerAddressable()`, `refKey()`.
- Called by: the Dhan feed, the simulator, the ingestor's registry, the scrip-master parser.

**`src/contracts/tick.ts`** — `MarketTick` (every field except `ref`/`at`/`source` optional so "not sent in this mode" ≠ "zero"), `DepthLevel`, `FeedStatus`, `FeedStatusEvent`, `FeedMode` (`ticker|quote|full`).

**`src/contracts/feed.ts`** — the **push** contract, deliberately separate from `MarketDataProvider`'s pull contract.
- Exports: `MarketFeed` interface, `TickHandler`, `StatusHandler`, `Unsubscribe`, `class TypedEmitter<T>` (isolates listener exceptions so a bad consumer can't kill the connection).

**`src/contracts/cache.ts`** — `QuoteCache` interface, sized so an in-memory and a Redis implementation are genuinely interchangeable. Documents that in-memory cannot serve `services/api` across a process boundary.

**`src/cache/in-memory-quote-cache.ts`** — `InMemoryQuoteCache implements QuoteCache` + non-interface `snapshot()` for health endpoints. Used only inside the ingestor.

**`src/rate-limit/token-bucket.ts`** — `TokenBucketOptions`, `class TokenBucket` (`tryAcquire`, `waitMs`, `acquire`), `DHAN_LIMITS` (marketQuote 1/s, optionChain 1/3s, dataApi 5/s). **Exported but never imported anywhere** — the live bridge implements its own FIFO queue instead.

**`src/providers/dhan/dhan-binary-parser.ts`** (243 lines) — pure, synchronous parser for Dhan's little-endian binary feed.
- Exports: `FEED_CODE` (TICKER 2, QUOTE 4, OI 5, PREV_CLOSE 6, FULL 8, DISCONNECT 50), `HEADER_BYTES`, `PacketHeader`, `ParsedPacket`, `readHeader()`, `parsePacket()`, `parseFrame()`.
- Handles multi-packet frames by walking declared lengths; guards zero/negative lengths; rounds float32 prices to 2dp; treats a 0 day-close as absent.
- Verified by `scripts/verify-parser.ts`.

**`src/providers/dhan/dhan.feed.ts`** (281 lines) — `class DhanMarketFeed implements MarketFeed`.
- Encodes protocol limits: 5 connections/user, 5,000 instruments/connection, 100 per subscribe message, disconnect code 805.
- Exponential backoff with jitter; replays all subscriptions on reconnect (server-side set is empty after a drop).
- WebSocket injected via `WebSocketFactory` so the package stays dependency-free.
- Exports: `WebSocketLike`, `WebSocketFactory`, `DHAN_FEED_URL`, `MAX_*` constants, `DhanFeedOptions`, `DhanMarketFeed`.
- Instantiated by: `services/market-data`'s `FeedManagerService` (via `registry.ts`) and `live-feed-server.ts` (directly).

**`src/providers/dhan/dhan-scrip-master.ts`** (346 lines) — CSV parser for Dhan's published instrument master.
- Exports: `ScripMasterRow`, `splitCsvLine()`, `deriveExchangeSegment()`, `ParseResult`, `ParseOptions`, `parseScripMaster()`, `optionalField()`, `scripKey()`, `mergeScripMasters()`.
- Accepts both the compact and detailed header vocabularies; treats `"NA"`/`"-"`/`"NULL"` as absence; scopes the series filter to cash segments only (filtering indices on series silently dropped every index — a fixed bug preserved as a comment).
- `mergeScripMasters` is load-bearing: compact has the ticker, detailed has ISIN/underlying, neither alone is sufficient.
- Called by: `ScripMasterService` (services/market-data) and `live-feed-server.ts`.

**`src/providers/simulated/ou-engine.ts`** (206 lines) — the single simulated market.
- Discrete Ornstein-Uhlenbeck mean-reverting walk anchored to real `previousClose`, seeded from `(symbol, trading-day)` so it is deterministic and reproducible across processes.
- Exports: `MarketStatus`, `SimulatedQuote`, `marketStatusAt()`, `simulateQuoteAt()`, `simulateCandles()`, `round2()`, `SESSION`.
- `marketStatusAt` is imported by `services/api`'s `MarketDataService` — the one place session state is derived from the clock rather than persisted.

**`src/providers/simulated/simulated.provider.ts`** (147 lines) — `SimulatedMarketDataProvider implements MarketDataProvider`; `InstrumentAnchor`, `AnchorResolver`, `fallbackAnchor()`. Anchors are injected (real `previousClose`/`tickSize`) with a deterministic symbol-derived fallback for DB-less operation.

**`src/providers/simulated/simulated.feed.ts`** (154 lines) — `SimulatedMarketFeed implements MarketFeed`. Field coverage mirrors the real feed's modes exactly, so code written against the simulator can't depend on data a Ticker subscription wouldn't deliver. Off outside market hours by default.

**`src/registry.ts`** (~120 lines) — the provider-selection seam.
- Exports: `ProviderName`, `MarketDataConfig`, `RegistryDependencies`, `loadMarketDataConfigFromEnv()`, `createMarketDataProvider()`, `createMarketFeed()`.
- **`createMarketDataProvider('dhan')` throws — not implemented.** Deliberate: failing loudly beats mislabelling simulated data as live.

**`scripts/verify-parser.ts`** (192 lines) — hand-rolled round-trip assertions for every documented packet layout, incl. truncation and zero-length guards. Run via `npm run verify -w @tradew/market-data`. **This is the closest thing in the repo to a test suite.**

## 3.3 `packages/ai-core` — the AI foundation

Layered as `domain → providers → memory → graph → rag → research → brain → context → prompts → tools → agents`, plus `news`.

| File | Purpose / key exports | Consumed by |
|---|---|---|
| `src/domain/knowledge.ts` | `KnowledgeSourceKind`, `KnowledgeSource`, `EntityRef`, `MemoryRecord`, `NewMemoryRecord` | everything |
| `src/providers/types.ts` | Provider-agnostic shapes: `ChatMessage`, `ToolCall`, `ToolSpec`, `CompletionRequest/Response` (incl. `reasoning` kept out of `text`), `EmbeddingRequest/Response`, `ResearchQuery/Result` | all providers |
| `src/providers/interfaces.ts` | `LlmProvider`, `EmbeddingProvider`, `ResearchProvider` | provider-manager |
| `src/providers/provider-manager.ts` | `ProviderSelection`, `ProviderNotAvailableError`, `class ProviderManager` (register/pick by configured order) | sentinel ×4 |
| `src/providers/factory.ts` (231) | `ProvidersConfig`, `TierModels`, `createProviderManager()`, `loadProvidersConfigFromEnv()`. Holds the measured NIM model defaults and the warning that `llama-3.2-3b` must not be re-adopted | sentinel, scripts |
| `src/providers/impl/anthropic.ts` | `AnthropicLlmProvider` — Messages API, tool blocks, system hoisting | factory |
| `src/providers/impl/openai-compatible.ts` (258) | `OpenAiCompatibleLlmProvider` + `OpenAiCompatibleEmbeddingProvider`; one adapter serves OpenAI, NVIDIA NIM and Ollama. `splitReasoning()` strips `<think>` blocks and `reasoning`/`reasoning_content` siblings so chain-of-thought never reaches users | factory |
| `src/providers/impl/voyage.ts` | `VoyageEmbeddingProvider` | factory |
| `src/providers/impl/research.ts` (215) | `TavilyResearchProvider`, `BraveResearchProvider`, `FirecrawlResearchProvider`, `AnthropicWebSearchProvider` | factory |
| `src/memory/interfaces.ts` | `MemorySearchQuery/Hit`, `MemoryStore`, `VectorStore` | sentinel's Prisma store |
| `src/memory/in-memory.ts` | `cosineSimilarity()`, `InMemoryVectorStore`, `InMemoryMemoryStore` — **unused** dev doubles | — |
| `src/graph/interfaces.ts` | `GraphNode`, `GraphEdge`, `NeighborQuery`, `KnowledgeGraph` | sentinel's Prisma graph |
| `src/rag/interfaces.ts` | `Chunk`, `Chunker`, `RetrievalRequest/Result`, `Retriever` | sentinel |
| `src/rag/impl.ts` | `SimpleChunker` (**unused**), `DefaultRetriever` (semantic + one-hop graph expansion, token-budgeted) | sentinel DI |
| `src/research/interfaces.ts` | `ResearchRunRequest/Result`, `ResearchEngine` | sentinel |
| `src/research/impl.ts` | `DefaultResearchEngine` — search → validate (URL + content + dedupe) → LLM summarize → learn | sentinel DI |
| `src/brain/interfaces.ts` | `BrainAskRequest/Response`, `NeuralBrain`, `LearnEventKind`, `LearnInput`, `LearningEngine` | sentinel |
| `src/brain/impl.ts` (185) | `DefaultLearningEngine` (summarize → store → connect ≥0.75 similar → graph), `DefaultNeuralBrain` (memory → research → answer; `SUFFICIENT_SCORE = 0.55`; every Q&A becomes memory) | sentinel DI |
| `src/context/interfaces.ts` | `ContextBudget`, `ContextAssemblyRequest/Result`, `ContextManager` | brain, agents |
| `src/context/impl.ts` | `SimpleContextManager` — deterministic trimming (system+guardrails and user message never dropped; history oldest-first, then retrieval, then inline) | sentinel DI |
| `src/prompts/interfaces.ts` | `PromptTemplate`, `PromptLibrary`, **`CORE_GUARDRAILS`** — the five never-advise rules appended to every trading-adjacent prompt | orchestrator, explain, agents |
| `src/prompts/impl.ts` | `InMemoryPromptLibrary` — **unused** |
| `src/tools/interfaces.ts` | `ToolContext`, `ToolHandler`, `RegisteredTool`, `ToolRegistry`. Deliberately no order-placement mechanism | — |
| `src/tools/impl.ts` | `DefaultToolRegistry` — **unused** |
| `src/agents/interfaces.ts` | `AgentDefinition`, `AgentInvocation`, `AgentResult`, `AgentRuntime` | (definitions.json shape) |
| `src/agents/impl.ts` | `DefaultAgentRuntime` — bounded 6-round tool loop, unremovable guardrails, fenced-JSON structured output — **unused** |
| `src/news/news-event-classifier.ts` (141) | `NEWS_EVENT_LABELS` (13 categories), `NEWS_EVENT_PROMPT`, `standardizeLabel()`, `NewsEventClassifier` | sentinel's `NewsIntelligenceService`, NIM smoke script |

**Dependency note:** `ai-core` has **zero runtime dependencies** — all HTTP via global `fetch`, all IDs via `node:crypto`.

## 3.4 `packages/ui` — design system

| File | Exports |
|---|---|
| `src/index.ts` | barrel → components + motion variants + `cn` |
| `src/lib/cn.ts` | `cn()` — thin `clsx` wrapper |
| `src/tailwind-preset.ts` | Default-exported Tailwind preset mapping CSS vars → theme keys. Notably prefixes the v2 font scale (`fsXs`…`fs3xl`) so it can't clobber Tailwind's own `text-sm`/`text-lg` |
| `src/styles/tokens.css` (176) | Light on `:root`, dark on `[data-theme="dark"]`; colours, elevation ramp, glass, motion durations, focus ring |
| `src/motion/variants.ts` (177) | `fade`, `fadeInUp`, `panelSlide`, `sidebarSlide`, `modalPop`, `stagger` + duration tokens |
| `src/components/index.ts` | Re-exports the 11 primitives below |
| `Button.tsx` | `Button`, `buttonClasses` (recipe so `<Link>` can be styled identically), `ButtonProps/Variant/Size` |
| `Card.tsx`, `Panel.tsx` | `Card` (title/subtitle), `Panel` (terminal slot with loading/empty states) |
| `Badge.tsx` | `Badge`, `BadgeTone` |
| `StatCard.tsx` | `StatCard` (label/value/delta) |
| `Sparkline.tsx` | Axis-less SVG trend |
| `Skeleton.tsx`, `EmptyState.tsx` | Loading + empty states |
| `IconButton.tsx` | Requires `aria-label` |
| `Surface.tsx` | `Surface`, `ELEVATION_SHADOW`, `SurfaceElevation` |
| `AnimatedNumber.tsx` | Tick-animated numeric display |

Consumed by `apps/web` **from TypeScript source** — `next.config.mjs` lists it in `transpilePackages`, so there is no build step and no `dist/`.

## 3.5 `packages/database`

**`prisma/schema.prisma`** (775 lines) — the single schema. Full model/enum breakdown in §7.

**`prisma/seed.ts`** (200 lines) — upserts 5 index instruments with quotes, 12 NIFTY/BANKNIFTY option contracts (lot sizes 75/35), and a bcrypt-hashed founder user. Uses `upsertInstrument()` helper. Run via `npm run seed -w @tradew/database`.

**`prisma/migrations/*/migration.sql`** — 12 migrations, 793 SQL lines. Listed in §7.5.

## 3.6 `services/api` — the public ingress (NestJS, port 4000)

**`src/main.ts`** — bootstrap. CORS: strict allowlist in production; in dev also accepts any `localhost`/`127.0.0.1` port and origin-less tools. Global `ValidationPipe({ whitelist: true, transform: true })`.

**`src/app.module.ts`** — imports `PrismaModule`, a **globally registered** `JwtModule` (secret from `JWT_SECRET`, 7d default), then `Auth`, `Entitlements`, `Instruments`, `MarketData`, `Sim`, `Sentinel`, `Knowledge`, `Notification`. Controller: `HealthController`.

**`src/health.controller.ts`** — `GET /health` → `{ok, service, timestamp}`. Unauthenticated.

**`src/prisma/prisma.service.ts` / `prisma.module.ts`** — `PrismaService extends PrismaClient`, `@Global()` module. Fault-tolerant `onModuleInit`: a DB outage logs a warning instead of crash-looping the process.

### auth module
- **`auth.service.ts`** (120) — `signup`, `login`, `refresh`, `logout`, `me`, `updateMe`, `listPreferences`, `setPreference`; privates `issue()`, `hash()`, `audit()`. bcrypt (cost 10); refresh tokens are 48 random bytes, stored **only as a SHA-256 hash**, single-use (rotated on refresh); every auth event writes an `AuditEvent` with IP + UA, and audit failures are swallowed so they can't break auth.
- **`auth.controller.ts`** — DTOs `AuthDto`, `RefreshDto`, `UpdateProfileDto`, `PreferenceDto` with `class-validator`. 8 routes (§13).
- **`auth.guard.ts`** — `AuthGuard implements CanActivate`; Bearer extraction + `jwt.verify`, attaches `req.user`.
- **`auth.module.ts`** — exports `AuthGuard` and `AuthService`.

### entitlements module
- **`entitlements.service.ts`** (229) — the only place premium access is decided. `check()` resolves in order: admin override → live subscription (ACTIVE/TRIALING/PAST_DUE/GRACE) → plan grant → quota. `capabilitiesOf()`, `recordUsage()` (increments both day and month keys), plus the full `SubscriptionLifecycle` (`activate`, `renew`, `markPastDue`, `cancel`, `expire`, `createOverride`, `listPlans`). Privates `validity()` (valid/grace/expired), `grantReason()`.
- **`capability.guard.ts`** — `CAPABILITY_KEY`, `RequiresCapability()` decorator, `CapabilityGuard` (runs after `AuthGuard`, attaches `req.entitlement`, throws 403 with `{capability, reason, quota}`).
- **`entitlements.controller.ts`** — also defines `AdminTokenGuard` (static `x-admin-token` header vs `ADMIN_API_TOKEN`; throws if the env var is unset, i.e. admin API disabled by default). 7 routes.
- **`entitlements.module.ts`** — `@Global()`.

### instruments module
- **`instruments.service.ts`** — `search(q)`: case-insensitive `contains` across `symbol`/`displayName`/`underlying`, ordered by type then symbol, `take: 25`.
- **`instruments.controller.ts`** — `GET /instruments/search?q` behind `AuthGuard`.

### market-data module (read-only)
- **`market-data.service.ts`** (153) — **pure reads**. Exports `DASHBOARD_INDEX_SYMBOLS`, `QuoteDto`. Methods `quote()`, `quoteBySymbol()`, `quotesBySymbols()` (two queries, no N+1, caller ordering preserved), `indices()`. Privates `toDto()` (coalesces nullable OHLC against `ltp` so a ticker-mode row doesn't render as −100%), `loadWithQuote()`. Derives `marketStatus` from the clock via `marketStatusAt()`. `source` is read from the row, never hardcoded.
- **`market-data.module.ts`** — documents the deliberate absence of the old `SimulatedEngineService` (archived).
- **`market-data.controller.ts`** — 4 routes, all `AuthGuard`.

### sim module — the paper-trading OMS
- **`market-price.service.ts`** (312) — all pricing and instrument metadata comes from the **live Dhan bridge** (`DHAN_LIVE_URL`, default `:4600`), *not* Postgres `Quote`. Exports `LivePrice`, `ParsedOptionSymbol`, `buildOptionSymbol()`, `parseOptionSymbol()`, `MarketPriceService`. Methods: `resolveInstrument()` (lazy upsert from the bridge), `getPrice()`, privates `getSnapshot()` (2s cache), `resolveOptionInstrument()`, `getOptionPrice()`. Canonical option symbol format `UNDERLYING:YYYYMMDD:STRIKE:CE|PE` — must stay byte-identical to the frontend's `buildOptionSymbol`. Normalises Dhan's paise tick size to rupees; synthesises a ±5bp spread when bid/ask arrive as 0.
- **`order.service.ts`** (428) — the engine. Module constants `STARTING_BALANCE` (₹10L), `CHARGES_RATE` (3bps). Pure helpers `computeMargin()` (option BUY = full premium; CNC = notional; FUTURE/option SELL = 15%; MIS = 20%) and `applyFill()` (add / partial-close / full-close / close-and-flip with correct realized P&L). Methods: `ensureWallet`, `placeOrder`, `executeFill` (transactional; the margin delta subtracts **both** the order's block and the position's pre-fill margin — a documented bug fix), `modifyOrder`, `cancelOrder`, `exitPosition`, `exitAll` (per-position error isolation), `orderBook`, `tradeBook`.
- **`matching-engine.service.ts`** (123) — `setInterval` poller every 3s via Nest lifecycle hooks (deliberately not `@nestjs/schedule`). Expires DAY orders, triggers SL/SL_M (BUY on rise, SELL on fall), promotes SL→OPEN and re-checks in the same tick, fills LIMIT at limit-or-better. Per-order try/catch so one unpriceable symbol can't stall the book.
- **`position.service.ts`** (138) — `PositionDto`, `list()`, `closed()`, privates `toDto()` (falls back to `avgPrice` with `priceStatus: 'stale'` rather than erroring the list) and `todaysRealizedPnl()`. Daily P&L = today's realized + change in unrealized since the session-open snapshot. Documents a known simplification: today's realized P&L isn't split by `productType`.
- **`portfolio.service.ts`** (57) — `PortfolioSummary`, `summary()`; pure rollup, no new persistence.
- **`ist-time.util.ts`** (46) — `istDayKey()`, `todayIstSessionEnd()` (rolls forward past weekends), `startOfIstDay()`. One place for the `toLocaleString` IST trick. **No holiday calendar.**
- **`sim.controller.ts`** (141) — DTOs `PlaceOrderDto`, `ModifyOrderDto`. 10 routes; static `positions/closed` and `positions/exit-all` are declared before the dynamic `positions/:instrumentId/exit`.
- **`sim.module.ts`** — no longer imports `MarketDataModule`.

### sentinel module (client side)
- **`sentinel.service.ts`** (172) — `SentinelApiService`, the only caller of the internal Sentinel service. Assembles the user's own recent trades/positions (Sentinel never queries trading tables) and forwards them. Also supports a `clientTrades`/`clientPositions` bridge for the paper simulator, trusted for one request and never persisted. Methods: `observe`, `explain`, `brainSearch`, `brainStrategy`, `observations`, `sessionSummary`, `listJournal`, `addJournal`. Failures become `BadGatewayException`; `sessionSummary` still renders from API-owned data when Sentinel is down.
- **`sentinel.controller.ts`** — class-level `@UseGuards(AuthGuard, CapabilityGuard)` + `@RequiresCapability('sentinel')`. Meters usage: `sentinel_requests` on observe, `ai_requests` on explain and brain search. 8 routes.

### knowledge module (internal developer tool)
- **`knowledge.service.ts`** (504) — a read-only window over the `TradeW/knowledge/` Obsidian vault. In-memory index rebuilt by a 2s poll-diff (chosen over `fs.watch` for cross-platform reliability and delete detection). Exports `TreeNode`, `FileMeta`, `FileContent`, `RecentItem`, `SearchHit`, `GraphNode`, `GraphEdge`, `GraphData`, `ActivityEvent`, `KnowledgeService`. Public: `tree()`, `file()`, `recent()`, `search()` (weighted title>filename>tags>content), `graph()`, `activity()`, `changes` (EventEmitter), `isStarted`. Privates include `walk()`, `safeResolve()` (**rejects path traversal**), frontmatter/tag/heading parsing, wiki-link and markdown-link extraction, and multi-strategy link resolution (exact → basename → suffix).
- **`knowledge.guard.ts`** — `KnowledgeWorkspaceGuard`: on when `KNOWLEDGE_WORKSPACE_ENABLED=true`, off when `false`, otherwise on outside production. Returns **404** when disabled so the surface isn't advertised.
- **`knowledge.controller.ts`** — 6 REST routes + an SSE `/knowledge/stream` with a 25s heartbeat. **Gated only by the workspace guard — no JWT** (documented as intentional; EventSource can't send an Authorization header).

### notification module
- **`notification.service.ts`** — `NotificationCategoryType` (re-export of the Prisma enum), `NotificationItem`; `list`, `unreadCount`, `markRead`, `markAllRead`, `create`; private `formatTime()` producing relative labels.
- **`notification.controller.ts`** — 5 routes behind `AuthGuard`. `CreateNotificationDto` has **no `class-validator` decorators**, so the global whitelist pipe strips nothing and validates nothing on this route.

## 3.7 `services/market-data` — ingestion runtime (NestJS, port 4020) + scripts

**`src/main.ts`** — binds `127.0.0.1` by default; the docstring states the service is a **singleton by design** (Dhan evicts the oldest connection with code 805 on a sixth).

**`src/app.module.ts`** — providers: `PrismaService`, `InstrumentRegistryService`, `TickPipelineService`, `FeedManagerService`, `ScripMasterService`. Controller: `HealthController`.

**`src/health.controller.ts`** — `GET /health`; reports `disabled` / `ok` / `degraded` (degraded when the feed is down but persisted prices are still served).

**`src/prisma.service.ts`** — sole writer of `Quote` and of `Instrument`'s broker-metadata columns; fault-tolerant connect.

**`src/ingestion/feed-manager.service.ts`** (138) — owns the feed lifecycle. `onApplicationBootstrap` starts unless `INGESTION_ENABLED=false`; `start()`, `stop()`, `resubscribe()`, `health()`; bounded status history (last 50, reports last 10).

**`src/ingestion/tick-pipeline.service.ts`** (228) — tick → cache (every tick) → Postgres (coalesced on a flush interval). Overlap guard, chunked write concurrency (25), change-detection fingerprint that skips unchanged instruments, per-field mapping so a ticker-mode tick can't blank OHLC written by a richer earlier tick, volume clamped ≥0 (Dhan wires volume as int32). Rate-limited unresolved-instrument warnings. Local type `QuoteWriteData` (deliberately not `Prisma.QuoteUpdateInput`, which permits relation ops illegal in the create branch).

**`src/ingestion/dhan-websocket-factory.ts`** — one-line `ws` adapter satisfying `WebSocketLike`; the injection edge that keeps `packages/market-data` dependency-free.

**`src/instruments/instrument-registry.service.ts`** (131) — resolves between the three identities (broker key, symbol, UUID). Full-reload cache (universe changes ~daily). Exports `CachedInstrument`. `resolve()` tries broker key first (live feed) then symbol (simulator); `subscriptionSet()`; `anchorResolver` supplies the simulator's price anchors; `stats()`.

**`src/scrip-master/scrip-master.service.ts`** (344) — exports `SCRIP_MASTER_COMPACT_URL`, `SCRIP_MASTER_DETAILED_URL`, `DEFAULT_SEGMENTS` (`IDX_I`, `NSE_EQ`), `DEFAULT_SERIES` (`EQ`, `BE`), `SyncOptions`, `SyncReport`, `ScripMasterService`. Resolves symbol collisions deterministically *before* touching the DB and reports them rather than overwriting; matches on broker identity first, falls back to symbol so seeded rows are enriched not duplicated; `hasChanged()` skips no-op writes; `deactivateMissing()` sets `active: false`, never deletes. Documents the measured fact that importing all series yields 417 collisions vs 1 for EQ+BE.

**`scripts/sync-scrip-master.ts`** (~110) — CLI (`--dry`, `--segments`, `--series`, `--limit`, `--file`, `--detailed-file`, `--deactivate-missing`). Prints a full sync report; exits non-zero on errors.

**`scripts/backfill-candles.ts`** (226) — Dhan REST → `Candle`. Maps `CandleInterval` to `/charts/intraday` (with minute interval) or `/charts/historical` (`expiryCode: 0`). Drops Dhan's flat/zero-volume non-traded placeholder bars. Idempotent upsert on `(instrumentId, timeframe, bucketStart)`; 400 ms pacing. Defaults: NIFTY, BANKNIFTY, FINNIFTY, RELIANCE, COALINDIA × 15m,1d × 90 days.

**`scripts/live-feed-server.ts`** (1,193 — the largest source file) — the standalone Dhan bridge, no DB, no auth. Covered in detail in §9.

## 3.8 `services/sentinel` — intelligence runtime (NestJS, port 4010)

**`src/main.ts`** — binds `127.0.0.1` by default; dev-only CORS for `localhost:3000` allowing the `x-service-token` header.

**`src/app.controller.ts`** — `ServiceTokenGuard` (constant `x-service-token` vs `SERVICE_TOKEN`; throws if unset) + `AppController` with 7 routes (health is unguarded).

**`src/app.module.ts`** (147) — the composition root. Binds `MARKET_DATA` → `CandleMarketDataProvider`, builds `PROVIDER_MANAGER`, `MEMORY_STORE` → `PrismaMemoryStore`, `KNOWLEDGE_GRAPH` → `PrismaKnowledgeGraph`, `BASE_LEARNING_ENGINE`, `RETRIEVER`, `RESEARCH_ENGINE`, `NEURAL_BRAIN`, and registers the ontology + brain + intelligence services. Holds `SENTINEL_BRAIN_SYSTEM_PROMPT`.

**`src/domain.ts`** — `Signal`, `TradeSummary`, `PositionSummary`, `ObserveRequest`, `SentinelObservationOut`, `ObserveResponse`, `SENTINEL_DISCLAIMER`.

**`src/prisma.service.ts`** — owns `SentinelObservation`; reads/writes memory + graph in the `sentinel` namespace; never touches trading tables. Fault-tolerant connect (observation works with no DB at all).

### orchestrator
**`src/orchestrator/sentinel-orchestrator.service.ts`** (169) — the only component producing user-facing copy. Fires research + outcome-learning fire-and-forget (never adds latency), collects signals from all four engines, gates surfacing on `compositeWeight ≥ 0.7 && triggered.length ≥ 2`, appends a historical-frequency note, records observations. `compose()` uses an LLM with `CORE_GUARDRAILS` and falls back to a deterministic `evidence → pattern → soft suggestion` template when no provider is configured.

### intelligence
- **`indicators.ts`** — pure math: `ema`, `rsi`, `vwap`, `macd`, `cpr`, `averageVolume`, `swingLevels`, `realizedVolatilityPct`, `oiTrend`.
- **`market-intelligence.service.ts`** (~140) — `MARKET_DATA` token, `MarketSnapshot`, `snapshot()` (15m + 1d candles + breadth), `signals()` producing 9 technical signals.
- **`emotion-intelligence.service.ts`** — 5 behavioural signals from caller-supplied trades only: `revenge_trading`, `overtrading`, `position_sizing_drift`, `impatient_pacing`, `loss_streak`.
- **`trap-intelligence.service.ts`** — 6 composite signals: `low_volume_breakout`, `bull_trap`, `bear_trap`, `liquidity_sweep`, `expiry_day_conditions`, `high_risk_market_conditions`, `fomo_entry` (with a clamped lateness fraction — a fixed bug that previously produced "last 254%").
- **`news-intelligence.service.ts`** (141) — classifies headlines into the 13 NVIDIA-blueprint categories through the provider layer, persists `NewsEvent`, emits `news_driven_volatility`. Degrades to `OTHER` with no LLM.

### compliance / explain
- **`compliance/compliance.service.ts`** — `categoryFor()` (SEBI-relevant labels), `record()` (audit failures logged loudly, never thrown), `feed()` (degrades to an empty list).
- **`explain/explain.service.ts`** — `ExplainTrace`, `ExplainResult`, `explain()`. Returns `live: false` with an honest deterministic note when no provider is configured — never a faked AI answer.

### brain
- **`tokens.ts`** — the 7 DI string tokens (interfaces have no runtime representation).
- **`prisma-memory-store.ts`** (207) — real `MemoryStore` over `MemoryRecord`/`MemoryRelation`. pgvector via raw SQL (`<=>` cosine) because Prisma excludes `Unsupported("vector")` from CRUD; text-`ILIKE` fallback with no embedder.
- **`prisma-knowledge-graph.ts`** — `KnowledgeGraph` over `GraphNode`/`GraphEdge`; BFS `path()` up to `maxHops`.
- **`concept-learning.service.ts`** — extracts symbols/patterns/sectors (hints beat regex), writes entities onto the record, upserts graph nodes, links `mentions` and `co_occurs_with`.
- **`knowledge-center.service.ts`** — `search()` / `stats()`, both degrade to empty rather than 500.
- **`pattern-recognition.service.ts`** — every triggered signal becomes a durable `pattern_occurrence` stamped with price-at-detection and `outcome: null`.
- **`historical-similarity.service.ts`** — per-symbol+pattern frequency, gated at `MIN_SAMPLE = 5`, with an honest `describe()`.
- **`market-context.service.ts`** — composes a short narrative from the snapshot + Brain recall.
- **`research-trigger.service.ts`** — fires once per unfamiliar symbol only (checks the graph first); no crawling.
- **`outcome-learning.service.ts`** — after 15 minutes tags occurrences `continued_up` / `continued_down` / `unclear` (`MOVE_THRESHOLD_PCT = 0.3`). Rides the observe cadence, no scheduler.
- **`strategy-intelligence.service.ts`** — cross-symbol base rates, gated at `MIN_SAMPLE = 8`.

### brain/ontology — the Concept Knowledge Graph
- **`domains.ts`** — the closed set of 15 domains + descriptions + `isDomain()`.
- **`relations.ts`** (215) — the closed 13-relation vocabulary, each with `reads`/`readsInverse`, `symmetric`, `transitive`, `polarity`; `RELATION_HOP_DECAY` per relation; `readEdge()` narration.
- **`concept.schema.ts`** (295) — `Concept`, `ConceptRelation`, `ConceptExample`, `ValidationIssue`, `parseConcept()`, `lintDirectiveLanguage()`. The lint matches **imperative phrasing**, not vocabulary, so "buy-side liquidity" passes while "you should buy" fails. Collects all issues rather than failing fast.
- **`ontology-loader.service.ts`** (207) — walks `knowledge-base/`, validates, cross-checks (dangling targets, duplicate ids, id↔filename, declared-vs-actual domain, symmetric-relation double declaration, orphans), sha256 checksums, `summarise()`, `resolveKnowledgeBaseDir()`.
- **`concept-graph.service.ts`** (441) — the reasoning layer: `getConcept`, `byDomain`, `search`, `neighbors`, `explainPath` (weighted, decayed, narrated; refuses to chain non-transitive relations), `explainObservation`, `similarConcepts`, `stats`. `USER_FACING_CONFIDENCE_FLOOR = 0.5`.
- **`concept-reinforcement.service.ts`** (277) — the learning half. Three invariants: observations are append-only; reinforcement writes `learnedWeight`/counters, **never** the authored `weight`; new knowledge is *proposed* (`ConceptPromotion`), never merged. `MIN_OBSERVATIONS_FOR_LEARNED_WEIGHT = 8`, `MIN_SUPPORT_FOR_PROMOTION = 12`.

### backtest
- **`types.ts`** — `BacktestTrade`, `EmaCrossConfig` (+ `DEFAULT_EMA_CROSS_CONFIG`), `BacktestStats`, `BacktestResult`. Header states plainly: retrospective analysis, never a live signal, never in the order flow.
- **`ema-cross-strategy.ts`** — `isEmaCrossLong()`: bullish bar + EMA passing through the bar + close above EMA (+ optional fresh-cross). No look-ahead.
- **`engine.ts`** (233) — `runEmaCrossBacktest()`. Next-bar-open fills, stop-first bar resolution, session-gap inference from median bar spacing (forces `eod` exits and skips last-bar-of-session signals), round-trip costs, optional trend/body/volume filters, cooldown. `summarize()` computes win rate, avg win/loss R, expectancy, profit factor, max consecutive losses, max drawdown in R.

### market-data provider
**`market-data/candle-market-data.provider.ts`** (224) — `CandleMarketDataProvider implements MarketDataProvider`. Resolution order **live bridge → `Candle` table → simulator**, per call, with a 4s abort timeout. `getMarketBreadth()` computes real advances/declines from the bridge's stock snapshot and reads India VIX from the indices. Option chain and news still delegate to the simulator.

### scripts
- **`validate-ontology.ts`** — DB-free; exits non-zero on any validation issue (CI-gateable).
- **`seed-ontology.ts`** (178) — projects YAML → Postgres; refuses to seed if validation fails; writes canonical columns only; deprecates removed concepts rather than deleting; `--dry`.
- **`smoke-concept-graph.ts`** — end-to-end exercise of path scoring, non-transitive refusal, validation gate, reinforcement, and reseed-safety.
- **`smoke-nvidia-nim.ts`** (173) — per-tier completion, embedding, and the news classifier against expected labels.
- **`backtest-ema-cross.ts`** (257) — CLI (`--symbol --interval --days --ema --rr --timeout --cooldown --fresh --source db|sim`), with 1m→3m resampling.

## 3.9 `apps/web` — the frontend

### App Router (`src/app/`)
| Route file | Type | Purpose |
|---|---|---|
| `layout.tsx` | server | Root layout; imports `@tradew/ui/styles.css` then `globals.css`; inline pre-paint theme script (no FOUC) reading `tradew-workspace-v1` from localStorage; wraps children in `AppFrame`; `suppressHydrationWarning` |
| `globals.css` | css | App-level styles over the token layer |
| `page.tsx` | server | `redirect('/dashboard')` — no login wall |
| `dashboard/page.tsx` | server | Renders `MarketWorkspace` |
| `markets/page.tsx` | server | `Suspense` wrapper for `MarketsWorkspace` (needs `useSearchParams`) |
| `trade/page.tsx` | server | `Suspense` wrapper for `TradeWorkspace` |
| `portfolio/page.tsx` | client | Stat cards from **mock** `PORTFOLIO_SUMMARY` + 4 tabs, all `EmptyState` |
| `sentinel/page.tsx` | client | Market selector + day classification + context + safety feed + training + timeline; entitlement-locked |
| `research/page.tsx` | server | Deliberate "coming soon" with disabled search + tab chips |
| `learning/page.tsx` | server | Learning paths + category grid from mock data |
| `knowledge/page.tsx` | client | Full-page vault link graph, live-updated over SSE |
| `knowledge/KnowledgeGraph.tsx` | client | 206-line force-ish SVG graph renderer |
| `knowledge/Mermaid.tsx` | client | Dynamic mermaid renderer (used by the archived markdown view) |
| `notifications/page.tsx` + `NotificationsClient.tsx` | server + client | Real API-backed notification list |
| `settings/page.tsx` + `SettingsClient.tsx` | server + client | Account + Sentinel pricing tiers (₹1399→₹999/mo); reads real `sentinel` capability; **no checkout** |
| `profile/page.tsx` | client | Identity from `sessionStore`; owns `/auth/preferences` directly; logout returns to `/dashboard` |
| `login/page.tsx`, `signup/page.tsx` | client | Real auth; `friendlyError()` distinguishes network failure; explicit "explore without signing in" link |

### Shell (`src/components/shell/`)
`AppFrame.tsx` (permanent chrome; mounts store hydration, keyboard shortcuts, session init, theme sync, and the four overlays), `Sidebar.tsx` (config-driven from `nav-config`), `TopBar.tsx`, `Ticker.tsx`, `ThemeMenu.tsx`, `NotificationCenter.tsx` (bell drawer — reads **store-seeded mock**), `FloatingAI.tsx` (visual surface only, no routing logic), `icons.tsx` (24 inline SVG icons), `nav-config.tsx` (`NAV_ITEMS`, `BARE_ROUTES`, `STANDALONE_ROUTES` — now empty after the reverted standalone-Sentinel experiment).

### Dashboard widgets (`src/components/dashboard/`)
`MarketWorkspace` (staggered entrance), `IndexOverview`, `MarketMovers`, `TrendingStocks`, `CommodityMarkets`, `WatchlistWidget`, `SectorHeatmap`, `GlobalMarkets`, `MarketNews`, `EconomicCalendar`, `RiskAlerts`, `PortfolioSummary`, `QuickLinks`, `SentinelBriefing`. The first five read the live Dhan feed; the rest render mock data.

### Markets / Trade / Charts
`markets/MarketsWorkspace.tsx` (363) — indices/stocks/ETFs tables with per-tab filters, driven by the live feed. `trade/TradeWorkspace.tsx` (150) — one integrated page (not a dock): chart + orders + optional blotter/sentinel/news; parses `?symbol&strike&type&expiry&action`; prices option tickets from the contract's own premium via `useOptionQuote`. `charts/TradeChart.tsx` (223) — `lightweight-charts` wrapper with IST time formatting, `liveLast` bar patching, and `fitKey`-driven refits.

### Terminal panels (`src/components/terminal/panels/`)
`ChartPanel.tsx` (397, dynamic/`ssr:false`) with tabs `MarketsTab`, `TechnicalsTab`, `DepthTab`, `OptionChainTab` (438), plus `ContractAnalysisDrawer` and `QuickActionsDock`. `OrdersPanel.tsx` (301) places real paper orders. `BlotterPanel`, `DepthPanel`, `NewsPanel`, `SentinelPanel`, `WatchlistPanel`, `PortfolioMiniPanel`, `LearningMiniPanel`, `ResearchMiniPanel`, `OptionChainPanel`, `types.ts` (`DockPanelContentProps`). `TerminalWorkspace.tsx` is an `export {}` tombstone.

### Workspace/dock (`src/components/workspace/`)
`panel-registry.tsx` (the `PanelKind` → title/icon/component catalog), `WorkspaceDock`, `WorkspaceTabs`, `DockSlot`, `DockControls`, `Splitter`, `LayoutMenu`, `ClosedPanelsMenu`, `CommandPalette` (182), `ShortcutsHelp`, `Popover`. Only `LayoutMenu`, `ClosedPanelsMenu`, `CommandPalette`, `ShortcutsHelp` and `panel-registry` are still reachable from a route.

### Sentinel components (`src/components/sentinel/`)
`MarketSelector` (182, searchable across ~220 markets), `DayClassificationCard` (132), `MarketContextPanel`, `LiveSafetyFeed`, `SafetyCard`, `ContextualTraining`, `SentinelTimeline`, `SentinelLocked`, `DemoModeBanner`, `TradingJournal`.

### lib (`src/lib/`)
- **API clients:** `api.ts` (token storage + transparent 401 refresh-and-retry), `oms.ts` (151 — the `/sim/*` client and the mirrored `buildOptionSymbol`), `marketData.ts` (`/market-data/*`), `notifications.ts`, `knowledge.ts` (102 — only `graph()` and `subscribeToChanges()` still called), `dhanLiveFeed.ts` (192 — the bridge client: quotes, candles, option candles, expiry list, has-chain, option chain).
- **Hooks:** `useDhanLiveFeed` (166 — **module-level singleton** SSE connection with a 20s grace period, added because 7+ widgets each opening an EventSource exhausted the browser's per-origin connection limit), `useCandles`, `useLiveQuotes`, `useOptionQuote`, `useOptionCandles`, `useInstrumentMeta`, `useHasOptionChain`.
- **Stores (Zustand):** `workspaceStore.ts` (565 — panels, slots, layout presets, tabs, theme, overlays, seeded notifications; persisted as `tradew-workspace-v1`), `sessionStore.ts` (auth + capabilities; deliberately **not** persisted; never redirects), `tradeBasketStore.ts`, `useHydrated.ts`, `useKeyboardShortcuts.ts`.
- **Domain:** `technicals.ts` (146 — pivots, SMA, RSI, MACD, stochastic, Williams %R, ROC, CCI, `technicalIndicators()`), `black-scholes.ts` (96 — own implementation, A&S 7.1.26 erf), `format.ts`, `analytics.ts` (console stub), `shortcuts.ts`, `search/{types,providers}.ts` (184).
- **Sentinel:** `sentinel/types.ts` (+ `DEMO` fixtures), `useSentinel.ts` (live with demo fallback), `deriveContext.ts` (355 — `DAY_TYPES`, `classifyDay`, `extractMarketContext`, `extractSafetyFeed`, `pushworthyCards`, `suggestedLesson`), `markets.ts` (~220 markets, `BACKFILLED_SYMBOLS`).
- **Mock:** `market.ts` (300), `foUniverse.ts` (235), `indices.ts` (165), `candles.ts` (135), `optionChain.ts`, `optionCandles.ts`, `learning.ts`, `research.ts`.

## 3.10 `archive/` — 15 superseded implementations (`.txt`)

`api-market-data-simulated-engine.service.ts.txt`, `api-sim-service-market-order-only.service.ts.txt`, `sentinel-sim-market-data.provider.ts.txt`, `web-knowledge-{activity-panel,file-tree,markdown-view}.tsx.txt`, `web-order-ticket-panel-preview-only.tsx.txt`, `web-sentinel-{agent-timeline,alert-callout,observation-feed,reflection-cards,session-summary,standalone-shell}.tsx.txt`, `web-terminal-workspace-static-grid.tsx.txt`, `web-trade-sprint0-page.tsx.txt`, plus `README.md` documenting why each was superseded. **None are imported.** This is intentional retention under CLAUDE.md Rule 1.

---

# 4. Configuration Files

Every configuration file discovered, including the ones asked about that **do not exist**.

## 4.1 Present

| File | Purpose / notable content |
|---|---|
| `package.json` (root) | npm workspaces `apps/*`, `services/*`, `packages/*`. `private: true`, `engines.node >= 20`. Scripts: `build` (all workspaces `--if-present`), `build:api`, `build:web`, `dev:api`, `dev:web`, `dev:sentinel`, `db:generate`, `db:migrate`, `ontology:validate`, `ontology:seed`. **No `dev:market-data`, no `test`, no `lint`, no `typecheck` at root.** |
| `package-lock.json` | 12,726 lines / 450 KB — npm v3 lockfile for the whole workspace |
| `.gitignore` | `node_modules`, `dist`, `.next`, `out`, `*.tsbuildinfo`, all `.env*` variants, `.env.prod`, logs, `coverage/`, Python artifacts, `*.bak` |
| `.dockerignore` | Excludes `node_modules`, builds, all `.env*` **except** `.env.example`, plus `knowledge`, `docs`, `archive`, `infra/k8s`, `infra/terraform` |
| `.claude/launch.json` | Dev-server config for the preview tooling: `api`→4000, `web`→3000, both `autoPort: true` |
| `.github/workflows/deploy.yml` | See §4.3 |
| `apps/web/package.json` | `@tradew/web`. Deps: `@tradew/types`, `@tradew/ui`, `framer-motion` ^11.15, `lightweight-charts` ^4.2.3, `mermaid` ^11.4.1, `next` ^14.2.20, `react`/`react-dom` ^18.3, `react-markdown` ^9, `remark-gfm` ^4, `zustand` ^4.5.5. Dev: TS 5.7, Tailwind 3.4.16, ESLint 8.57 + `eslint-config-next`, PostCSS, autoprefixer |
| `apps/web/tsconfig.json` | `target: es5`, `moduleResolution: bundler`, `strict`, `noEmit`, `jsx: preserve`, path alias `@/* → ./src/*`, `next` plugin |
| `apps/web/next.config.mjs` | Single setting: `transpilePackages: ['@tradew/ui']` — consumes the design system from TS source, no build step |
| `apps/web/tailwind.config.ts` | Uses the `@tradew/ui/tailwind-preset`; content globs include `../../packages/ui/src/**` so the package's classes are emitted |
| `apps/web/postcss.config.js` | `tailwindcss` + `autoprefixer` |
| `apps/web/.eslintrc.json` | `extends: next/core-web-vitals` — **the only lint config in the repo** |
| `apps/web/next-env.d.ts`, `src/next-env.d.ts` | Next type references (**duplicated in two locations**) |
| `apps/web/Dockerfile` | Two-stage node:20-bookworm-slim; build context is the repo root; `NEXT_PUBLIC_API_URL` baked at build (default `/api` → same-origin, no CORS); runs `npx next start`. Notes that `output: 'standalone'` would shrink the image |
| `apps/web/.env.local.example` | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_DHAN_LIVE_URL` |
| `services/api/package.json` | `@tradew/api`. NestJS 10.4, `@nestjs/jwt` 10.2, Prisma 5.22, `bcryptjs`, `class-validator`/`class-transformer`, `dotenv`, `rxjs`, `@tradew/market-data`. Dev: `@nestjs/cli`, `@nestjs/testing` (**declared, never used**), `ts-node`. `prisma.schema` points at `packages/database/prisma/schema.prisma` |
| `services/api/tsconfig.json` | CommonJS, ES2021, decorators + metadata, `strict`, `declaration`, `outDir: ./dist` |
| `services/api/nest-cli.json` | `sourceRoot: src` |
| `services/api/Dockerfile` | Installs `openssl` (Prisma engine), runs `prisma generate`, builds; runtime stage copies `node_modules` (carrying `.prisma`) + schema so the **same image doubles as the migration runner** |
| `services/api/.env.example` | Documented in §14 |
| `services/sentinel/package.json` | `@tradew/sentinel`. NestJS 10.4, Prisma, `js-yaml`, `@tradew/ai-core`, `@tradew/types`, `@tradew/market-data`. Scripts: `ontology:validate/seed/smoke`, `nim:smoke`, `backtest:ema` |
| `services/sentinel/tsconfig.json` | `include: ["src/**/*.ts"]`, `exclude: [scripts]` — with a comment explaining that compiling `scripts/` shifts `rootDir` up and emits `dist/src/main.js`, breaking `start:prod` |
| `services/sentinel/tsconfig.scripts.json` | Extends the above with `noEmit` + `types: ["node"]` for `ts-node -T` |
| `services/sentinel/nest-cli.json`, `Dockerfile`, `.env.example` | Dockerfile builds `@tradew/types` + `@tradew/ai-core` + the service, sets `HOST=0.0.0.0`; env example documents measured NIM model latencies |
| `services/market-data/package.json` | `@tradew/market-data-service`. Adds `ws` ^8.18. Scripts: `scrip:sync`, `live:server`, `backfill:candles` |
| `services/market-data/tsconfig.json` / `tsconfig.scripts.json` / `nest-cli.json` / `.env.example` | Same split-build pattern and rationale as sentinel |
| `packages/ai-core/package.json` + `tsconfig.json` | Zero runtime deps; CommonJS build to `dist` |
| `packages/market-data/package.json` + `tsconfig.json` | Depends only on `@tradew/types`; adds a `verify` script |
| `packages/types/package.json` + `tsconfig.json` | ES2022/CommonJS, declaration output |
| `packages/ui/package.json` + `tsconfig.json` | `type: module`; `main`/`types` point at **`./src/index.ts`** (source, not `dist`); exports map for `.`, `./styles.css`, `./tailwind-preset`; peer deps react/react-dom/framer-motion; only script is `typecheck` |
| `packages/database/package.json` | Scripts `generate`, `migrate`, `migrate:deploy`, `seed` |
| `infra/docker/docker-compose.yml` | Local: `pgvector/pgvector:pg16` on host port **5433** + pgAdmin on 5050. Named volumes, healthcheck |
| `infra/docker/docker-compose.prod.yml` (150) | Production: `caddy` (only public service, 80/443), `web`, `api`, `sentinel`, one-shot `migrate`, `postgres` (tuned: 1 GB shared_buffers, 3 GB effective_cache_size, 100 connections), `redis` (**provisioned but not consumed by any code**). Bridge network `tradew`; health checks on api/sentinel/postgres |
| `infra/docker/Caddyfile` | Automatic HTTPS; `handle_path /api/*` strips the prefix → `api:4000` with `flush_interval -1` for SSE; everything else → `web:3000`. Sentinel is deliberately not routed |
| `infra/docker/.env.prod.example` | Full production env template; see §14 |
| `infra/docker/backup.sh` | Nightly `pg_dump | gzip` → rclone → OCI Object Storage, with retention pruning and documented restore steps |
| `scripts/requirements.txt` | `dhanhq==2.3.0rc1`, pinned exactly; explicitly *not* the trading engine's dependency set |
| `agents/sentinel/definitions.json` | 5 `AgentDefinition` records (market-technical, emotion, trap-safety, compliance-audit, orchestrator) with per-agent guardrails, tiers and the orchestrator's `requiredCapability: 'sentinel'`. **Not loaded by any code** |
| `packages/database/prisma/schema.prisma` | See §7 |

## 4.2 Explicitly absent

| Asked about | Status |
|---|---|
| `pnpm-workspace.yaml` | **Absent** — npm workspaces, not pnpm |
| `turbo.json` | **Absent** — no Turborepo |
| `nx.json` | **Absent** |
| `vite.config.*` | **Absent** — Next.js, not Vite |
| `.prettierrc` / `prettier.config.*` | **Absent** — formatting is convention-only |
| `jest.config.*`, `vitest.config.*`, `playwright.config.*` | **Absent** — no test runner is configured anywhere |
| `.eslintrc` at root or in any service/package | **Absent** — only `apps/web` is linted |
| `tsconfig.json` at root, `tsconfig.base.json`, project references | **Absent** — each workspace is standalone |
| `docker-compose.override.yml`, `Dockerfile` for `market-data` | **Absent** — the ingestor and the live bridge have no images and are not in either compose file |
| `.editorconfig`, `.nvmrc`, `renovate.json`, `CODEOWNERS`, issue/PR templates | **Absent** |
| `.env` / `.env.local` / `.env.prod` | Correctly absent (gitignored); five `.env.example` files exist |

## 4.3 GitHub Actions — `.github/workflows/deploy.yml`

- **Trigger:** push to `main` filtered to `apps/web/**`, `services/**`, `packages/**`, `infra/docker/**`, the workflow itself; plus `workflow_dispatch`.
- **Job `build`:** matrix over `web`/`api`/`sentinel`; QEMU + Buildx for **linux/arm64** (OCI Ampere A1); logs into `ghcr.io` with the default `GITHUB_TOKEN`; lowercases the owner; pushes `:latest` and `:${{ github.sha }}`; GHA layer cache `mode=max`; passes `NEXT_PUBLIC_API_URL=/api`.
- **Job `deploy`:** `appleboy/ssh-action` → `cd /opt/tradew`, `git pull --ff-only`, `compose pull`, `compose run --rm migrate`, `compose up -d`, `docker image prune -f`.
- **Secrets required:** `SSH_HOST`, `SSH_USER`, `SSH_KEY`.
- **Gaps:** no test, lint, typecheck, or build-verification step; no staging environment; no rollback path; `services/market-data` is never built or deployed; the current work is on `feat/*` branches so this has never fired.

---

# 5. Backend

## 5.1 Modules (NestJS)

**`services/api`** — `AppModule` → `PrismaModule` (`@Global`), `JwtModule` (`@Global`), `AuthModule`, `EntitlementsModule` (`@Global`), `InstrumentsModule`, `MarketDataModule`, `SimModule`, `SentinelModule`, `KnowledgeModule`, `NotificationModule`.

**`services/sentinel`** — a single `AppModule` acting as the composition root (no feature modules); 22 providers + 7 DI tokens.

**`services/market-data`** — a single `AppModule` with 5 providers.

## 5.2 Services (providers)

| Service | Location | Responsibility |
|---|---|---|
| `AuthService` | api/auth | signup/login/refresh/logout/profile/preferences + audit |
| `EntitlementsService` | api/entitlements | the single entitlement decision point + subscription lifecycle |
| `InstrumentsService` | api/instruments | instrument search |
| `MarketDataService` | api/market-data | pure quote reads |
| `MarketPriceService` | api/sim | live pricing + lazy instrument resolution from the bridge |
| `OrderService` | api/sim | order lifecycle, fills, margin, wallet |
| `MatchingEngineService` | api/sim | resting-order poller |
| `PositionService` | api/sim | positions + P&L breakdown |
| `PortfolioService` | api/sim | account rollup |
| `SentinelApiService` | api/sentinel | the only client of the internal Sentinel service |
| `KnowledgeService` | api/knowledge | vault index, search, graph, SSE change feed |
| `NotificationService` | api/notification | notification CRUD |
| `PrismaService` | ×3 services | DB connection, fault-tolerant boot |
| `SentinelOrchestratorService` | sentinel | signal synthesis, the only user-facing voice |
| `MarketIntelligenceService`, `EmotionIntelligenceService`, `TrapIntelligenceService`, `NewsIntelligenceService` | sentinel/intelligence | the four deterministic signal engines |
| `ComplianceService` | sentinel/compliance | SEBI-labelled audit trail |
| `ExplainService` | sentinel/explain | traceable explanations |
| `PrismaMemoryStore`, `PrismaKnowledgeGraph`, `ConceptLearningEngine`, `KnowledgeCenterService`, `PatternRecognitionService`, `HistoricalSimilarityService`, `MarketContextService`, `ResearchTriggerService`, `OutcomeLearningService`, `StrategyIntelligenceService` | sentinel/brain | the ten Brain subsystems |
| `ConceptGraphService`, `ConceptReinforcementService`, `OntologyLoaderService` | sentinel/brain/ontology | concept graph reasoning + learning + loading |
| `CandleMarketDataProvider` | sentinel/market-data | live bridge → Candle table → simulator |
| `FeedManagerService`, `TickPipelineService`, `InstrumentRegistryService`, `ScripMasterService` | market-data | ingestion runtime |

## 5.3 Controllers

`HealthController` (api), `AuthController`, `EntitlementsController`, `InstrumentsController`, `MarketDataController`, `SimController`, `SentinelController`, `KnowledgeController`, `NotificationController`; `AppController` + `HealthController` (sentinel, market-data). Full route list in §13.

## 5.4 Routes

37 routes on `services/api`, 7 on `services/sentinel`, 1 on `services/market-data`, 9 on the live bridge. See §13.

## 5.5 Middleware

**None.** No `NestMiddleware` implementation, no `configure(consumer)`, no `app.use()` anywhere. The only global pieces are `enableCors()` and the global `ValidationPipe` in `services/api/src/main.ts`.

## 5.6 Guards

| Guard | Where | Mechanism |
|---|---|---|
| `AuthGuard` | api/auth | Bearer JWT verify → `req.user` |
| `CapabilityGuard` | api/entitlements | Reflector reads `@RequiresCapability`, calls `EntitlementsService.check`, attaches `req.entitlement`, throws 403 with reason + quota |
| `AdminTokenGuard` | api/entitlements (declared inside the controller file) | `x-admin-token` vs `ADMIN_API_TOKEN`; disabled when unset |
| `KnowledgeWorkspaceGuard` | api/knowledge | env flag; 404 when off |
| `ServiceTokenGuard` | sentinel | `x-service-token` vs `SERVICE_TOKEN` |

## 5.7 Interceptors / Pipes / Filters

- **Interceptors:** none.
- **Exception filters:** none — Nest's default filter handles everything.
- **Pipes:** one global `ValidationPipe({ whitelist: true, transform: true })`.

## 5.8 Schedulers, cron jobs, queues

- **No `@nestjs/schedule`, no `@Cron`, no BullMQ, no queue of any kind.**
- Three hand-rolled `setInterval` loops, all via Nest lifecycle hooks:
  1. `MatchingEngineService` — 3 s, fills resting orders (`onModuleInit`/`onModuleDestroy`).
  2. `TickPipelineService` — `MARKET_DATA_FLUSH_MS` (default 2 s), flushes coalesced quotes; drains on shutdown.
  3. `KnowledgeService` — 2 s vault poll-diff (`unref`'d).
- Plus, inside `live-feed-server.ts`: a 300 ms SSE broadcast flush, a 30 s market-status re-broadcast, and a 15 s SSE keep-alive.
- **Sentinel has no scheduler at all** — outcome evaluation and research triggers deliberately ride the `/observe` cadence, so they only run while someone is observing.
- One documented cron lives outside the app: `infra/docker/backup.sh` at 02:30 daily.

## 5.9 Database connections

Three independent `PrismaClient` subclasses (`services/api`, `services/sentinel`, `services/market-data`), all pointing at the same `DATABASE_URL`, all with fault-tolerant `onModuleInit`. Standalone scripts (`seed.ts`, `sync-scrip-master.ts`, `backfill-candles.ts`, `seed-ontology.ts`, `smoke-concept-graph.ts`, `backtest-ema-cross.ts`) instantiate `PrismaClient` directly. Table ownership is documented per service: api owns user/trading tables, market-data is the sole writer of `Quote` and `Instrument` broker columns, sentinel owns `SentinelObservation` and the `sentinel` memory namespace.

## 5.10 Cache

- **No Redis client is installed or imported anywhere**, despite Redis being provisioned in the production compose file (documented there as unused).
- Actual caching, all process-local:
  - `InMemoryQuoteCache` inside the ingestor.
  - `MarketPriceService.snapshotCache` — 2 s.
  - `live-feed-server`: `candleCache` 60 s, `expiryListCache` 5 min, `optionChainCache` 2 s, `lastGoodChain` (unbounded fallback), plus an in-flight map that collapses concurrent identical upstream calls.
  - `useHasOptionChain` caches confirmed negatives for the session but never caches "couldn't determine".
  - `KnowledgeService`'s in-memory vault index.

## 5.11 WebSocket

- **Outbound only.** `DhanMarketFeed` is a WebSocket *client*; `ws` ^8.18 is a dependency of `services/market-data` only.
- **No server-side WebSocket** (`@nestjs/websockets`/Socket.IO absent). Server→client push uses **Server-Sent Events** in two places: `GET /knowledge/stream` (api) and `GET /stream` (live bridge).

## 5.12 Authentication

JWT access tokens (`@nestjs/jwt`, HS256, global secret from `JWT_SECRET`, default TTL `15m` via `ACCESS_TOKEN_TTL`, module default `7d`) + opaque 48-byte refresh tokens stored as SHA-256 hashes with a 30-day default (`REFRESH_TOKEN_DAYS`), rotated single-use on refresh and revocable individually or wholesale on logout. Passwords are bcrypt cost 10. Every auth event writes an `AuditEvent` (type, userId, IP, UA, metadata). The frontend stores both tokens in `localStorage` and transparently refreshes once on a 401.

**Service-to-service:** shared static tokens — `x-service-token` (api → sentinel) and `x-admin-token` (ops → entitlements admin API). No mTLS.

## 5.13 Authorization

Capability-based, decided in exactly one place. `@RequiresCapability('sentinel')` + `CapabilityGuard` → `EntitlementsService.check()` → override → live subscription → plan grant → quota. Usage metered via `recordUsage()` on both day and month keys. `GET /entitlements/me` feeds the frontend's `sessionStore.hasCapability()`, which drives the Sentinel lock screen and the Settings upgrade CTA.

**Only the Sentinel routes are capability-gated.** `/sim/*`, `/market-data/*`, `/instruments/*` and `/notifications/*` require authentication but no capability — notably `Capability.PAPER_TRADING` is defined but never enforced.

---

# 6. Frontend

## 6.1 Pages (13 routes)

`/` (redirect → `/dashboard`), `/dashboard`, `/markets`, `/trade`, `/portfolio`, `/research`, `/learning`, `/knowledge`, `/sentinel`, `/notifications`, `/settings`, `/profile`, `/login`, `/signup`.

## 6.2 Layouts

One root `app/layout.tsx`. No nested layouts, no route groups, no `loading.tsx`, `error.tsx`, `not-found.tsx`, `template.tsx`, or `middleware.ts`. Chrome is applied by the client component `AppFrame`, which chooses bare vs. shell rendering from `nav-config`'s `BARE_ROUTES` / `STANDALONE_ROUTES`. Two routes wrap their client component in `<Suspense>` because they read `useSearchParams`.

## 6.3 Components (~78)

| Group | Count | Files |
|---|---|---|
| shell | 10 | AppFrame, Sidebar, TopBar, Ticker, ThemeMenu, NotificationCenter, FloatingAI, icons, nav-config |
| dashboard | 14 | MarketWorkspace + 13 widgets |
| markets | 1 | MarketsWorkspace |
| trade | 1 | TradeWorkspace |
| charts | 1 | TradeChart |
| terminal/panels | 12 + 6 chart-tabs + types | ChartPanel, OrdersPanel, OptionChainTab, … |
| workspace | 11 | dock engine, command palette, shortcuts help, popover, menus |
| sentinel | 10 | selector, day card, context, feed, card, training, timeline, locked, banner, journal |
| ui package | 11 | Button, Card, Badge, StatCard, Panel, Sparkline, Skeleton, EmptyState, IconButton, Surface, AnimatedNumber |

## 6.4 Hooks (7 custom + 2 store hooks)

`useDhanLiveFeed`, `useCandles`, `useLiveQuotes`, `useOptionQuote`, `useOptionCandles`, `useInstrumentMeta`, `useHasOptionChain`; plus `useHydrateWorkspaceStore` and `useKeyboardShortcuts`.

## 6.5 Contexts / Providers

**None.** No React Context, no provider components. All cross-cutting state is Zustand; the design system is consumed as plain imports. `AppFrame` is the de-facto single provider-equivalent (mounts hydration, shortcuts, session init, theme sync).

## 6.6 Stores (Zustand)

- **`workspaceStore`** (565) — `PanelKind` (11 kinds), `SlotId` (left/main/auxA/auxB/right), `PanelState`, `LayoutPreset`, `WorkspaceTab`, notifications, `ThemeName` (`dark|light|high-contrast`), overlay open/closed flags, sidebar/mobile-nav state, slot sizes. Persisted to `localStorage` under `tradew-workspace-v1` (the key the root layout's pre-paint script reads).
- **`sessionStore`** — `status`, `user`, `capabilities`, `offline`, `init()`, `logout()`, `hasCapability()`. Not persisted; never redirects; only a confirmed rejection (not a network blip) clears the token.
- **`tradeBasketStore`** — `ContractKey`, `contractKeyOf()`, persisted basket of selected contracts.

## 6.7 API layer

Four distinct clients: `api.ts` (authenticated `services/api` fetch wrapper with refresh-and-retry), `oms.ts`, `marketData.ts`, `notifications.ts`, `knowledge.ts` (all built on `api()`), and `dhanLiveFeed.ts` (direct, unauthenticated calls to the bridge on `NEXT_PUBLIC_DHAN_LIVE_URL`).

## 6.8 Routing

Next.js App Router, file-system based. Navigation is **config-driven** from `NAV_ITEMS` — the Sidebar never hardcodes routes. Deep-linking into the trade workspace uses query params (`?symbol=&strike=&type=&expiry=&action=`). Client navigation via `next/link` and `useRouter`.

## 6.9 Charts

`lightweight-charts` ^4.2.3 only. `TradeChart.tsx` wraps it with IST-localised time formatting, live last-bar patching, and refit control. `Sparkline` (packages/ui) is a hand-rolled axis-less SVG. `SectorHeatmap` is CSS grid. `KnowledgeGraph.tsx` is a hand-written SVG graph. `mermaid` is installed and wrapped by `Mermaid.tsx` but is only referenced from the archived markdown view.

## 6.10 UI libraries

`@tradew/ui` (own design system), Tailwind CSS 3.4 with the shared preset, Framer Motion 11, `clsx` (via `cn`). **No component library** (no Radix, shadcn, MUI, Chakra, Headless UI). All icons are hand-written inline SVG in `icons.tsx` — no icon package.

---

# 7. Database

**Engine:** PostgreSQL 16 with the `vector` extension (declared via Prisma `previewFeatures: ["postgresqlExtensions"]` and `extensions = [vector]`). Local compose exposes it on host port **5433**.

## 7.1 Enums (10)

| Enum | Values |
|---|---|
| `InstrumentType` | INDEX, OPTION, EQUITY, FUTURE |
| `OrderSide` | BUY, SELL |
| `OrderType` | MARKET, LIMIT, SL, SL_M |
| `OrderValidity` | DAY, IOC |
| `ProductType` | MIS, CNC, NRML |
| `OrderStatus` | PENDING, OPEN, TRIGGER_PENDING, PARTIALLY_FILLED, FILLED, CANCELLED, REJECTED, EXPIRED |
| `SubscriptionStatus` | ACTIVE, TRIALING, PAST_DUE, GRACE, CANCELED, EXPIRED |
| `QuotaPeriod` | DAY, MONTH, BILLING_CYCLE |
| `NotificationCategory` | trade, sentinel, learning, research, portfolio, broker, announcement |

## 7.2 Tables (24 models)

**Identity & audit (4):** `User`, `RefreshToken`, `UserPreference`, `AuditEvent`.

**Market data (3):** `Instrument` (platform symbol + full Dhan broker identity: `securityId`, `exchangeSegment`, `isin`, `dhanInstrument`, `series`, `expiryFlag`, `tradingSymbol`, `underlyingSecurityId`, plus `active` soft-delete and `metadataSource`/`metadataSyncedAt` provenance), `Quote` (one latest-snapshot row per instrument), `Candle` (append-only OHLCV history keyed by instrument+timeframe+bucket).

**Trading (4):** `Order` (full lifecycle incl. `filledQuantity`, `avgFillPrice`, `slippage`, `charges`, `marginBlocked`, `rejectReason`, self-referencing `parentOrderId` for future bracket orders, `expiresAt`), `Trade` (with per-fill `realizedPnl`), `Position` (with session-open snapshot columns for the daily-P&L split and `marginUsed`), `PaperWallet`.

**Subscriptions & entitlements (5):** `Plan`, `PlanGrant`, `Subscription`, `EntitlementOverride`, `UsageCounter`.

**AI foundation (4):** `MemoryRecord` (with `Unsupported("vector")` embedding + `embeddingModel`/`embeddingDim` so mixed-provider vectors are never compared), `MemoryRelation`, `GraphNode`, `GraphEdge`.

**Concept knowledge graph (4):** `ConceptNode` (canonical columns projected from YAML + separate runtime-learning columns + checksum), `ConceptEdge` (authored `weight` vs runtime `learnedWeight`/`supportCount`/`refuteCount`), `ConceptObservation` (append-only), `ConceptPromotion` (human review queue with a service-computed `dedupeKey`, because Postgres treats NULLs as distinct in composite uniques).

**Sentinel & user content (3):** `SentinelObservation`, `JournalEntry`, `Notification`.

**News (1):** `NewsEvent`.

## 7.3 Relations

`User` 1→N `Order`/`Trade`/`Position`/`RefreshToken`/`UserPreference`/`AuditEvent`/`Subscription`/`EntitlementOverride`/`JournalEntry`/`Notification`, 1→1 `PaperWallet`. `Instrument` 1→1 `Quote`, 1→N `Candle`/`Order`/`Trade`/`Position`. `Order` 1→N `Trade` and self-relation `OrderChildren`. `Plan` 1→N `PlanGrant`/`Subscription`. `MemoryRecord` N↔N via `MemoryRelation` (named `MemoryRelationFrom`/`To`). `GraphNode` N↔N via `GraphEdge`. `ConceptNode` N↔N via `ConceptEdge`, 1→N `ConceptObservation`.

**Deliberately not FKs:** `ConceptNode.supersededBy`/`supersedes` (slug references, so seed order doesn't matter), `Instrument.underlyingSecurityId`, `ConceptObservation.edgeId`, `ConceptPromotion` entirely.

## 7.4 Indexes

40 declared. Highlights: `@@unique` on `User.email`, `Instrument.symbol`, `Instrument([exchangeSegment, securityId])`, `Quote.instrumentId` (making the ingestor's write a true upsert with no read-modify-write race), `Candle([instrumentId, timeframe, bucketStart])`, `Position([userId, instrumentId, productType])`, `PaperWallet.userId`, `PlanGrant([planId, capability])`, `UsageCounter([userId, metric, periodKey])`, `MemoryRelation([fromId,toId,relation])`, `GraphNode.entityId`, `ConceptNode.conceptId`, `ConceptEdge([fromId,toId,relation])`, `ConceptPromotion.dedupeKey`. Composite read indexes on `Order([userId, placedAt])`/`([userId,status])`, `Trade([userId, executedAt])`, `SentinelObservation` by user/agent/symbol + createdAt, `Notification([userId,createdAt])`/`([userId,read])`.

**No vector index (IVFFlat/HNSW) is created on `MemoryRecord.embedding` or `ConceptNode.embedding`** — similarity search is a sequential scan today.

## 7.5 Migrations (12, 793 SQL lines)

| Migration | Lines | Content |
|---|---|---|
| `20260710000000_init` | 96 | Users, instruments, quotes, orders, trades, positions, paper wallet |
| `20260710000100_sprint1_identity` | 44 | Refresh tokens, preferences, audit events |
| `20260716000000_ai_foundation_entitlements` | 281 | Plans/grants/subscriptions/overrides/usage + memory/graph + Sentinel observation + journal |
| `20260718000000_market_data_quote_revision` | 5 | `Quote.instrumentId` made unique |
| `20260718000001_market_data_quote_ohlc_fields` | 7 | open/high/low/bid/ask on `Quote` |
| `20260721000000_sentinel_concept_knowledge_graph` | 147 | The four Concept* tables |
| `20260721010000_instrument_broker_identity` | 31 | Dhan identity columns + soft delete + provenance |
| `20260721020000_instrument_type_future` | 7 | `FUTURE` enum value |
| `20260722100000_oms_order_lifecycle_enums` | 19 | OrderType/Validity/ProductType/Status enums |
| `20260722100001_oms_order_lifecycle` | 86 | Order lifecycle + position session-anchor + margin columns |
| `20260723000000_market_data_candle` | 31 | `Candle` table |
| `20260724000000_notification_category_enum` | 39 | `Notification` + `NotificationCategory` |

Migration history is linear and matches the schema.

## 7.6 Seeders

Two, both idempotent:
1. **`packages/database/prisma/seed.ts`** — 5 indices + quotes, 12 option contracts, one bcrypt founder user. `npm run seed -w @tradew/database`.
2. **`services/sentinel/scripts/seed-ontology.ts`** — projects the 66 `knowledge-base/` YAML concepts into `ConceptNode`/`ConceptEdge`, writing canonical columns only and deprecating removed concepts. Refuses to run if validation fails. `--dry` supported.

**No `Plan`/`PlanGrant` seed exists** — so a fresh database grants no capabilities to anyone, and `/sentinel/*` returns 403 (`no_subscription`) until rows are inserted by hand or via the admin API.

---

# 8. AI System

## 8.1 Where AI lives

| Location | Role |
|---|---|
| `packages/ai-core` | The shared foundation — every intelligence primitive |
| `services/sentinel` | The only AI **runtime** that exists |
| `agents/sentinel/definitions.json` | Declarative agent config (unloaded) |
| `knowledge-base/` | The concept ontology Sentinel reasons over |
| `apps/web/src/components/shell/FloatingAI.tsx` | The assistant UI slot — no logic |
| `docs/ai/DISTILLATION.md` | How the NVIDIA distillation blueprint maps onto the provider layer |

## 8.2 Agents

**Sentinel (5, defined in `definitions.json`):** `market-technical`, `emotion`, `trap-safety`, `compliance-audit`, `orchestrator` (the only user-facing voice; carries `requiredCapability: 'sentinel'` and the disclaimer).

Important nuance: the **deterministic halves** of these agents are real NestJS services that always run; the **LLM halves** are optional polish. `DefaultAgentRuntime` exists in `ai-core` but is never instantiated, so `definitions.json` is currently documentation rather than executable config.

**TradeW AI (8 planned, none built):** ai-researcher, company-analysis, news-analysis, option-chain-analysis, technical-analysis, strategy-builder, portfolio-insights, learning-assistant.

## 8.3 Prompts

- **`CORE_GUARDRAILS`** (`ai-core/src/prompts/interfaces.ts`) — five non-negotiable rules appended to every trading-adjacent prompt: never execute trades; never Buy/Sell/Entry/Exit/Target; observations and education only; warnings follow evidence → pattern → soft suggestion; not a licensed advisor.
- Inline system prompts: the orchestrator's synthesis prompt, `SENTINEL_BRAIN_SYSTEM_PROMPT`, `ExplainService`'s prompt, `DefaultLearningEngine`'s summarizer, `DefaultResearchEngine`'s summarizer, and `NEWS_EVENT_PROMPT` (the 13-category classifier).
- Per-agent guardrail fragments in `definitions.json`.
- `InMemoryPromptLibrary` exists but no template is ever registered — prompts are inline strings today.

## 8.4 Memory

`MemoryRecord` + `MemoryRelation` in Postgres via `PrismaMemoryStore`. Namespaced (`sentinel`, `global`), user-scoped or global, with provenance (`sourceKind`, `sourceReference`, `sourceProvider`), `confidence`, `tags`, `entities`, and `staleAfter` soft-expiry. Everything becomes memory: research results, observations, pattern occurrences, and every Q&A turn. `InMemoryMemoryStore` is the unused dev double.

## 8.5 Embeddings

Provider-selected in configured order (`AI_EMBEDDING_ORDER`, default `voyage,nvidia-nim,openai`). Voyage `voyage-3` (1024-dim) or any OpenAI-compatible `/embeddings` endpoint; NIM retrieval models get the required `input_type: query|passage`. Dimension is stored per record so mixed-provider vectors are never compared. **With no embedder configured, storage still succeeds without a vector and search degrades to `ILIKE` text match** — a deliberate degrade-not-break path.

## 8.6 Vector database

**pgvector on the same Postgres** — locked decision Q4, no Pinecone/Weaviate/Qdrant. Because Prisma excludes `Unsupported("vector")` from generated CRUD, every write is a follow-up `$executeRaw` and every search is `$queryRaw` using the `<=>` cosine-distance operator. Two vector columns exist (`MemoryRecord.embedding`, `ConceptNode.embedding`); the concept one is never populated, so concept search falls back to text matching.

## 8.7 LLM providers

Configured order `AI_LLM_ORDER`, default `anthropic,nvidia-nim,openai,ollama`.

| Provider | Adapter | Tier defaults |
|---|---|---|
| Anthropic | `AnthropicLlmProvider` (Messages API) | fast `claude-haiku-4-5-20251001`, balanced `claude-sonnet-5`, deep `claude-opus-4-8` |
| NVIDIA NIM | `OpenAiCompatibleLlmProvider` | fast `meta/llama-3.1-8b-instruct`, balanced/deep `nvidia/llama-3.3-nemotron-super-49b-v1` |
| OpenAI | same adapter | `gpt-4o-mini` / `gpt-4o` / `o3` |
| Ollama | same adapter, no key | `llama3.2` / `llama3.1` / `llama3.1:70b` |

The NIM path carries hard-won operational detail: a `jsonModeStrategy: 'omit'` because vLLM rejects bare `{type:'json_object'}`; an `extraBody` escape hatch for `chat_template_kwargs.enable_thinking`; a 300 s default timeout with a specific error message about free-tier queueing; and an explicit comment that `meta/llama-3.2-3b-instruct` must not be re-adopted (it timed out on 2 of 4 prose calls and never answered a tool call).

Reasoning traces are separated into `CompletionResponse.reasoning` and **never** promoted into `text`, even when the model burns its whole budget thinking — an empty answer is detectable, leaked chain-of-thought rendered as an observation is not.

## 8.8 Research providers

`AI_RESEARCH_ORDER`, default `tavily,brave,anthropic-web-search,firecrawl`. All four implement `ResearchProvider`; `AnthropicWebSearchProvider` reuses the Anthropic key by default and extracts both citations and `web_search_tool_result` blocks.

## 8.9 Orchestrators

- **`SentinelOrchestratorService`** — the runtime orchestrator: gathers 16 signals, gates on corroboration (`weight ≥ 0.7` **and** `≥ 2` triggered), synthesizes one message, records the audit trail, attaches market context.
- **`DefaultNeuralBrain`** — the knowledge orchestrator: memory → (research → learn) → context assembly → completion → learn the turn.
- **`ProviderManager`** — the provider orchestrator; consumers never name a provider.

## 8.10 Workflows

Four event-driven loops, no scheduler:
1. **Observe** — `/observe` → signals → composite gate → synthesis → compliance record → market context.
2. **Learn** — every triggered signal → `pattern_occurrence` memory → entity extraction → graph links.
3. **Outcome** — after 15 minutes, tag occurrences `continued_up`/`continued_down`/`unclear`; feeds historical similarity and cross-symbol base rates.
4. **Research** — once per never-seen symbol, checked against the graph first.

`workflows/` (n8n) is empty; nothing in the repo integrates n8n.

## 8.11 Research pipeline

`DefaultResearchEngine.run()`: provider search → validate (real URL, non-empty content, dedupe by URL, each rejection reasoned) → LLM summarize into 3–6 cited factual bullets with an explicit no-advice instruction → `ConceptLearningEngine.ingest()` (summarize → embed → store → extract entities → connect ≥0.75-similar records → upsert graph nodes and edges). Event-driven only; no crawler, no schedule.

## 8.12 Concept Knowledge Graph (distinct from the entity graph)

66 YAML concepts across 15 domains, 13 typed relations each carrying polarity, transitivity and per-hop decay. `ConceptGraphService.explainPath()` produces a scored, narrated reasoning path and refuses to chain non-transitive relations (chaining `contradicts` would manufacture false conflict). `ConceptReinforcementService` learns from observation without ever touching authored weights, and queues discoveries as `ConceptPromotion` rows for human review — Sentinel cannot promote its own findings.

The domain YAML covers: market-structure, price-action, options, technical-analysis, volume, market-microstructure, macroeconomics, trading-psychology, risk-management, institutional-concepts, company-fundamentals, derivatives, sentiment, patterns, glossary.

**Currently reachable only from CLI scripts** — no controller exposes it, and no runtime service injects `ConceptGraphService`.

---

# 9. Trading System

## 9.1 Broker adapters

**Dhan is the only broker integrated.** There is no adapter abstraction over brokers — the abstraction is over *market data* (`MarketFeed` push / `MarketDataProvider` pull), not over order routing.

| Requested | Status |
|---|---|
| **Dhan** | ✅ Deeply integrated — see below |
| **Upstox** | ❌ Zero references anywhere |
| **Zerodha / Kite** | ❌ Zero references anywhere |
| **Polygon** | ❌ Zero references |
| **Finnhub** | ❌ Zero references |
| Alpha Vantage / IEX / TrueData / NSE-direct | ❌ None. `MARKET-DATA-BASELINE.md` names free NSE/BSE/screener sources as future options |

## 9.2 Dhan integration surface

| Surface | Implementation |
|---|---|
| **WebSocket live feed** | `DhanMarketFeed` + `dhan-binary-parser` — hand-written little-endian parser for Ticker/Quote/Full/OI/PrevClose/Disconnect packets, 5-level depth, multi-packet frames; backoff with jitter; 805 handling; subscription replay |
| **Scrip master** | `dhan-scrip-master.ts` parser + `ScripMasterService` (DB sync) + in-memory resolution in the live bridge; merges the compact and detailed CSVs |
| **Historical / intraday charts** | REST `POST /v2/charts/historical` and `/v2/charts/intraday`, used by `backfill-candles.ts` and by the live bridge's `/candles` and `/candles/option` |
| **Option chain** | REST `POST /v2/optionchain` and `/v2/optionchain/expirylist`, serialized behind a FIFO queue with a 2.5 s floor gap |
| **Rate limits** | Encoded once in `DHAN_LIMITS` (unused) and again as the bridge's queue + caches (used) |
| **Auth** | `DHAN_ACCESS_TOKEN` + `DHAN_CLIENT_ID`; the env file notes individual tokens expire every 24 h and recommends API key/secret (12 months) |

## 9.3 The two market-data pipelines

This is the single most important thing to understand about the trading system: **two independent pipelines exist and serve different consumers.**

| | Pipeline A — NestJS ingestor | Pipeline B — live bridge |
|---|---|---|
| Entry point | `services/market-data/src/main.ts` (:4020) | `services/market-data/scripts/live-feed-server.ts` (:4600) |
| Default source | **Simulated** (`MARKET_DATA_FEED=simulated`) | **Real Dhan**, always |
| Persistence | Writes `Quote` to Postgres | None |
| Auth | Internal service | **None** |
| Consumed by | `services/api` `/market-data/*` → `marketData.ts` | `apps/web` widgets/charts/chain directly, `services/api`'s OMS, `services/sentinel`'s provider |
| Universe | Whatever `Instrument` rows exist | 5 indices + ~212 F&O stocks + all NSE ETFs + 5 MCX front-month futures + on-demand option legs |

Consequence: `GET /market-data/indices` can return simulated prices while the dashboard beside it shows real ones. Both paths label their `source` honestly, but they are not reconciled. The code documents this deliberately (see `MarketPriceService`'s docstring and `MARKET-DATA-ARCHITECTURE.md`).

## 9.4 `live-feed-server.ts` in detail (1,193 lines)

Boot: downloads the scrip master, parses `IDX_I, NSE_EQ, MCX_COMM, NSE_FNO, BSE_FNO`, and resolves the universe — F&O stocks by symbol (with `LEGACY_STOCK_ALIASES` mapping `TATAMOTORS→TMCV`, `ZOMATO→ETERNAL`), every NSE ETF, front-month MCX contracts chosen by nearest unexpired expiry, ~239 per-underlying **derivative lot sizes**, and ~125k option contracts indexed by `UNDERLYING|YYYY-MM-DD|strike|CE|PE`.

Notable engineering:
- `underlyingFromContractSymbol()` cuts at the expiry token rather than the first hyphen — splitting on `-` silently truncated `BAJAJ-AUTO` to `BAJAJ`, which made option lot sizes resolve to null.
- Option legs near spot (±15 strikes, CE+PE) are subscribed **on demand** so live prices overlay the rate-limited REST chain; slots are never spent on deep OTM.
- Tick handling uses a keyed `Map` lookup (an O(n) scan burned real CPU across 553 instruments).
- SSE is coalesced to a 300 ms flush with a 15 s comment keep-alive and a 30 s status re-broadcast.
- `lastGoodChain` + in-flight collapsing ensure a rate-limited refresh never blanks the chain ("prices must never stop").
- `isWithinSession()` drops Dhan's synthetic post-close bar that otherwise stretched the chart's time axis to 19:30 IST.

## 9.5 Market data (summary)

Real: LTP/OHLC/volume/bid-ask/depth ticks, historical and intraday candles, option chains with OI/IV/Greeks, instrument metadata (lot size, tick size, ISIN, security id), India VIX, and computed advance/decline breadth.
Simulated fallback: the deterministic OU engine, used when no real source answers.
Absent: news (`getNews()` returns `[]` everywhere), corporate actions, fundamentals, and any holiday calendar.

## 9.6 Indicators

| Location | Contents |
|---|---|
| `services/sentinel/src/intelligence/indicators.ts` | `ema`, `rsi`, `vwap`, `macd`, `cpr`, `averageVolume`, `swingLevels`, `realizedVolatilityPct`, `oiTrend` |
| `apps/web/src/lib/technicals.ts` | `classicPivots`, `sma`, `smaSignal`, `rsi`, `macdHistogram`, `stochasticK`, `williamsR`, `roc`, `cci`, `technicalIndicators()` |
| `apps/web/src/lib/black-scholes.ts` | `blackScholesPrice`, `blackScholesGreeks` (own implementation) |

`rsi` and MACD are implemented twice with different signatures — the backend and frontend do not share indicator math.

## 9.7 Strategy engine

One strategy exists: `isEmaCrossLong()` — bullish bar + EMA passing through the bar's range + close above the EMA, with an optional fresh-cross requirement. It is a **backtest** rule only; there is no live strategy runner, no signal scheduler, and no path from a strategy to an order.

## 9.8 Backtesting ✅

`runEmaCrossBacktest()` — walk-forward, long-only, next-bar-open fills (no look-ahead), stop-first bar resolution, data-inferred session gaps with forced EOD exits, timeout and cooldown, round-trip costs, and optional trend/body/volume filters. Reports trades, win rate, avg win/loss R, expectancy, total R and points, profit factor, max consecutive losses, and max drawdown in R. Runs against real Dhan `Candle` rows (`--source db`) or the deterministic simulator (`--source sim`), and supports 1m→3m resampling. Header states plainly that it is retrospective and never wired to order flow.

## 9.9 Execution

A **paper OMS only** (`services/api/src/sim/`). Supported: MARKET (immediate), LIMIT / SL / SL_M (resting, filled by the 3 s poller), modify, cancel, exit-one, exit-all, DAY and IOC validity, MIS/CNC/NRML, per-instrument lot-size validation, simulated margin with an explicit "not real SPAN" disclaimer, 3 bps charges, slippage reporting, and a ₹10 L paper wallet. Positions handle add/partial-close/full-close/close-and-flip with correct realized P&L, and daily P&L is split from carry-forward via a session-open snapshot.

**No real-money execution exists.** No live order placement, no broker order API, no OCO/bracket (`parentOrderId` is present but nothing populates it), no partial fills (`filledQuantity` is only ever 0 or full).

## 9.10 Option chain ✅

Real Dhan chain (strikes, OI, previous OI, volume, IV, bid/ask, delta/theta/gamma/vega) proxied through the bridge, with per-strike websocket LTP overlay. `OptionChainTab.tsx` (438 lines) renders it; clicking a strike deep-links into `/trade` with the contract; `ContractAnalysisDrawer` shows per-contract detail; option contracts are tradeable in the paper OMS at their real per-strike premium via the canonical `UNDERLYING:YYYYMMDD:STRIKE:CE|PE` symbol.

## 9.11 Risk engine

There is **no risk engine**. What exists instead:
- Pre-trade: lot-size multiple validation and a simulated margin check that can reject an order for insufficient margin.
- Post-trade observation: Sentinel's six trap signals and five behavioural signals — advisory only, never a gate.
- Absent: position limits, exposure caps, per-day loss limits, kill switches, concentration checks, drawdown circuit breakers, and any pre-trade risk gate on the order path.

---

# 10. Infrastructure

| Technology | Status |
|---|---|
| **Docker** | ✅ Three Dockerfiles (`web`, `api`, `sentinel`), all multi-stage `node:20-bookworm-slim`, all built from the repo root. **No Dockerfile for `services/market-data`** — neither the ingestor nor the live bridge is containerised or present in any compose file |
| **Docker Compose** | ✅ Two files. Local: Postgres (pgvector, host 5433) + pgAdmin (5050). Production: caddy, web, api, sentinel, one-shot migrate, postgres, redis; healthchecks and a private bridge network |
| **Caddy** | ✅ The single public entrypoint; automatic Let's Encrypt; `handle_path /api/*` strips the prefix (same-origin, no CORS); `flush_interval -1` for SSE; Sentinel intentionally unrouted |
| **PostgreSQL 16** | ✅ The one database, shared by three services with explicit table ownership |
| **pgvector** | ✅ Real — `pgvector/pgvector:pg16` image, `extensions = [vector]`, raw-SQL `<=>` similarity. **No IVFFlat/HNSW index created** |
| **Redis** | ⚠️ Provisioned in the production compose file with persistence, explicitly commented as *not consumed by application code*. No client installed, no import anywhere. `QuoteCache` is designed for it |
| **TimescaleDB** | ❌ Not used. `Candle` is a plain table; hypertables/retention/continuous aggregates are a documented future option |
| **ClickHouse** | ❌ Not used. Named in `ARCHITECTURE.md` §2 and `services/analytics/README.md` as an at-scale target only |
| **RabbitMQ** | ❌ Not used, not mentioned |
| **Kafka** | ❌ Not used. `ARCHITECTURE.md` §3 explicitly defers it behind Redis Streams |
| **NATS** | ❌ Not used, not mentioned |
| **Event bus of any kind** | ❌ None. Services communicate by direct HTTP with static shared tokens |
| **Kubernetes** | ❌ `infra/k8s/` is an empty README, deliberately |
| **Terraform** | ❌ `infra/terraform/` is an empty README, deliberately |
| **CI/CD** | ⚠️ One workflow: arm64 build → GHCR → SSH deploy. No test/lint/typecheck gate, no staging, no rollback |
| **Target host** | Oracle Cloud Free Tier Ampere A1 (arm64, 24 GB) — `infra/oci/README.md` is the runbook |
| **Backups** | ✅ `backup.sh` — nightly `pg_dump | gzip` → rclone → OCI Object Storage, retention pruning, documented restore |
| **Observability** | ❌ None. No Prometheus, Grafana, OpenTelemetry, Sentry, Loki, or structured JSON logging. Logging is Nest's default `Logger` + `console.log`. `ARCHITECTURE.md` §8 lists the intended order of adoption |
| **Secrets management** | `.env` files only; no Vault/SSM/Secrets Manager |
| **n8n** | Vendored out-of-tree at `D:\TradeW LLC\n8n-master`; nothing in this repo integrates it and `workflows/` is empty |

---

# 11. Documentation

117 markdown files tracked. Grouped, with an assessment of each.

## 11.1 Root documents

| Document | Lines | Purpose | Valid? | Outdated? | Duplicated? |
|---|---|---|---|---|---|
| `ARCHITECTURE.md` | 212 | Binding target architecture: boundaries, order flow, AI split, n8n, packages, env/deploy, observability, dependency graph, open questions | ✅ Binding | ⚠️ Partly — §3's order flow via `services/trading-engine` is not what was built (the paper OMS lives in `services/api`); §7's local compose description overstates what exists | Overlaps handbook ch. 5/16 |
| `README.md` | 1,071 | Full project README | ✅ | ⚠️ Some feature claims run ahead of code | Heavy overlap with the developer reference |
| `TRADEW_DEVELOPER_REFERENCE.md` | 2,398 | "Definitive" developer reference | ✅ Useful | ⚠️ Dated 2026-07-23; predates the backtest engine and the notification enum | **Substantially duplicates** README + handbook |
| `PROJECT_TEST_AUDIT.md` | 2,248 | Manual QA & product audit | ✅ As a record | ⚠️ Point-in-time (2026-07-23) | Overlaps `knowledge/Plans/2026-07-21 - Full platform and product audit.md` |
| `SENTINEL_BRAIN_PROGRESS.md` | 53 | Brain phase tracker at 78%, with an honest "known first-pass simplifications" section | ✅ Accurate | Last updated 2026-07-16 | — |

## 11.2 `docs/handbook/` — 28 chapters, ~16,700 lines

`00-front-matter`, `01-executive-summary`, `02-company-principles`, `03-product-requirements`, `04-platform-overview`, `05-system-architecture`, `06-sentinel-foundations`, `07-sentinel-departments`, `08-sentinel-engines`, `09-sentinel-runtime`, `10-safety-nets`, `11-paper-trading-engine`, `12-market-data`, `13-chart-engine`, `14-monorepo`, `15-frontend-architecture`, `16-backend-architecture`, `17-database`, `18-ai-architecture`, `19-security`, `20-performance-engineering`, `21-testing`, `22-devops`, `23-coding-standards`, `24-design-system`, `25-engineering-processes`, `26-decision-records`, `27-future-vision`.

**Assessment:** the largest single artefact in the repo (786 KB — larger than `apps/web`'s entire source). Internally coherent and genuinely valuable as intent. But it is aspirational in places the code has not reached — most sharply **ch. 21 (Testing)**, which describes a testing strategy for a repo that contains zero tests, and **ch. 22 (DevOps)**, which describes operations far beyond one Compose file. Chapters 5/16/17 substantially restate `ARCHITECTURE.md` and the product-architecture docs; ch. 24 restates `DESIGN-SYSTEM.md`.

## 11.3 `docs/product-architecture/` — 23 blueprints

`README`, `TRADEW-OS` (the constitution), `GENESIS-V2-BLUEPRINT`, `AGENT-ARCHITECTURE`, `SENTINEL`, `SENTINEL-KNOWLEDGE-GRAPH`, `TRADEW-AI`, `TRADEW-ASSISTANT`, `KNOWLEDGE-GRAPH`, `CONTINUOUS-LEARNING-PIPELINE`, `EXPLAINABILITY`, `RESEARCH-VAULT`, `LEARNING-HUB`, `ONBOARDING`, `SUBSCRIPTIONS`, `MARKET-WORKSPACE`, `TRADINGVIEW-WORKSPACE`, `WORKSPACE-SHELL`, `WORKSPACE-CONTINUITY`, `MARKET-DATA-ARCHITECTURE`, `MARKET-DATA-BASELINE`, `DHAN-MARKET-DATA-INTEGRATION`, `N8N-WORKFLOWS`.

- **Most accurate:** `DHAN-MARKET-DATA-INTEGRATION.md` (282), `SENTINEL-KNOWLEDGE-GRAPH.md` (189), `MARKET-DATA-BASELINE.md` (200), `WORKSPACE-SHELL.md` (167) — all track the code closely.
- **Known stale:** **`SENTINEL.md`** — `archive/README.md` records explicitly that it still describes the archived Reflection-Cards/Agent-Timeline/Observation-Feed layout and "needs a rewrite". Highest-priority doc fix.
- **Aspirational:** `TRADEW-AI.md`, `TRADEW-ASSISTANT.md`, `RESEARCH-VAULT.md`, `LEARNING-HUB.md`, `ONBOARDING.md`, `N8N-WORKFLOWS.md`, `CONTINUOUS-LEARNING-PIPELINE.md` — describe systems with no runtime.
- **Duplication:** `KNOWLEDGE-GRAPH.md` vs `SENTINEL-KNOWLEDGE-GRAPH.md` describe two genuinely different graphs but are easy to confuse; `AGENT-ARCHITECTURE.md` overlaps `ARCHITECTURE.md` §4.

## 11.4 `docs/` — other

`docs/README.md` (9 lines — **stale**: says "Status: empty" while `docs/` now holds 57 files), `docs/ai/DISTILLATION.md` (accurate), `docs/design-reference/DESIGN-SYSTEM.md` (binding, accurate), `docs/design-reference/prototype/README.md` (a 9-line move pointer), `docs/product/TradeW-Project-Vision-and-Business-Overview.{docx,pdf}` (binary, not reviewable as text).

## 11.5 `knowledge/` — Obsidian vault (26 notes + index + README)

- **Decisions (7):** Obsidian layer adopted; Genesis v2 ×2; market-data domain review; Concept Knowledge Graph; **Sentinel decoupled** and **Sentinel reinstated (decoupling reversed)** — the second supersedes the first and says so.
- **Patterns (11):** knowledge workspace; M2 terminal conversion; M3 dockable workspace; M4 auth session; market-data migration 1; packages-ui foundation; market-data Phase 1; Candle + Dhan backfill; Sentinel market selector; EMA-cross backtest; Sentinel live data across the full universe.
- **Gotchas (1):** "Sentinel not working was four stacked config+build faults" — genuinely high-value.
- **Research (3):** Oracle migration; Sentinel Brain audit; backend audit.
- **Plans (3):** OCI Free Tier deployment; platform audit & roadmap (293 lines); full platform and product audit.
- **API (1):** NVIDIA free tools (NIM API, Agent Skills) — 150 lines with measured latencies.

**Assessment:** the most consistently accurate documentation in the repo, because notes are written immediately after the work and dated. Two decision notes contradict each other by design (the later one explicitly reverses the earlier). `_INDEX.md` is current.

## 11.6 Component READMEs (25)

Accurate and useful — most carry an explicit status marker (🟢 built / 🟡 planned / ⚪ empty) and several have been visibly corrected in place (`apps/terminal`, `services/sentinel`, `services/tradew-ai`, `archive/`).

**Known stale:**
- `packages/types/README.md` and `packages/ui/README.md` still say "doesn't exist yet" in their opening lines despite both packages being built (the UI one later contradicts itself with a "foundation built" section).
- `packages/database/README.md` says `Watchlist`/`WatchlistItem` "still to be written" — still true, but the note is a year-scale open item.
- `services/api/README.md` lists dependencies on `packages/shared` (not built) and a call-out to `services/ai-orchestrator` (renamed long ago).
- `docs/README.md` and `infra/README.md` both describe themselves as empty when they are not.

## 11.7 `knowledge-base/README.md`

140 lines. Accurate and unusually valuable: it contains an explicit disambiguation table for `knowledge/` vs `knowledge-base/` — the single most likely confusion in this repo.

---

# 12. Feature Inventory

Legend: **Complete** = works end to end · **Partial** = works with real gaps · **Prototype** = demonstrable, not production-shaped · **Stub** = scaffolding only · **Dead** = present, unreachable.

## 12.1 Authentication & identity

| Feature | Status | Notes |
|---|---|---|
| Signup / login (bcrypt) | **Complete** | |
| JWT access + rotating hashed refresh tokens | **Complete** | Single-use rotation, individual and bulk revocation |
| Logout (single or all sessions) | **Complete** | |
| Audit logging of auth events | **Complete** | IP + UA + metadata; failures swallowed by design |
| Profile read/update | **Complete** | |
| Key/value user preferences | **Complete** | |
| Frontend session store + transparent refresh | **Complete** | |
| Password reset / email verification / MFA / OAuth | **Absent** | No email infrastructure at all |

## 12.2 Subscriptions & entitlements

| Feature | Status | Notes |
|---|---|---|
| Plans, grants, capability resolution | **Complete** | |
| Trial and grace-period handling | **Complete** | |
| Quota metering (day + month) | **Complete** | |
| Admin override API | **Complete** | Disabled unless `ADMIN_API_TOKEN` is set |
| Subscription lifecycle methods | **Complete** | `activate`/`renew`/`markPastDue`/`cancel`/`expire` |
| Capability gating in the UI | **Complete** | Sentinel lock screen, Settings CTA |
| Plan seed data | **Absent** | No plans exist on a fresh DB, so nobody is entitled to anything |
| Billing / checkout / payment provider | **Stub** | Pricing tiers are displayed; no provider adapter exists |

## 12.3 Market data

| Feature | Status | Notes |
|---|---|---|
| Dhan WebSocket feed + binary parser | **Complete** | Verified by `verify-parser.ts` |
| Scrip-master sync (DB) | **Complete** | Collision-safe, deactivate-never-delete |
| Scrip-master in-memory resolution (bridge) | **Complete** | ~125k option contracts indexed |
| Live quotes for ~220 instruments + all ETFs | **Complete** | Via the bridge |
| Historical/intraday candles | **Complete** | REST proxy + `Candle` backfill |
| Option chain with OI/IV/Greeks | **Complete** | Rate-limit-safe, last-good fallback |
| Per-strike live price overlay | **Complete** | On-demand subscriptions ±15 strikes |
| Simulated market (OU engine) | **Complete** | Deterministic, shared by all services |
| NestJS ingestion runtime | **Partial** | Works, but defaults to simulated and is not containerised or deployed |
| `Quote`-backed API reads | **Partial** | Correct, but fed by the simulated pipeline in practice |
| Redis hot cache | **Stub** | Interface designed, container provisioned, no client |
| Dhan pull provider (`MARKET_DATA_PROVIDER=dhan`) | **Stub** | Throws by design |
| News feed | **Stub** | `getNews()` returns `[]` in every provider |
| Holiday calendar | **Absent** | Documented open question; a trading holiday reads as OPEN |

## 12.4 Charts

| Feature | Status |
|---|---|
| Candlestick chart with real history, IST axis, live last-bar patching | **Complete** |
| Interval switching, contract charts on real option OHLC | **Complete** |
| Technicals / Markets / Depth / Option-Chain tabs | **Complete** (Depth uses mock ladder data) |
| Drawing tools, saved layouts, multi-chart | **Absent** |

## 12.5 Paper trading OMS

| Feature | Status | Notes |
|---|---|---|
| MARKET / LIMIT / SL / SL_M placement | **Complete** | |
| Matching engine for resting orders | **Complete** | 3 s poller |
| Modify / cancel / exit-one / exit-all | **Complete** | |
| Positions with realized/unrealized/daily P&L, MTM, margin | **Complete** | |
| Portfolio rollup + paper wallet | **Complete** | |
| Option-contract orders at real premium | **Complete** | |
| Lot-size validation from the scrip master | **Complete** | |
| Simulated margin | **Partial** | Explicitly not SPAN; documented |
| Partial fills | **Absent** | `filledQuantity` is only 0 or full |
| Bracket / OCO orders | **Stub** | `parentOrderId` exists, nothing writes it |
| Order/trade history UI | **Partial** | Orders panel yes; `/portfolio` tabs are all empty states |

## 12.6 Sentinel

| Feature | Status | Notes |
|---|---|---|
| 16-signal observation pipeline | **Complete** | 9 technical + 5 behavioural + 6 trap + 1 news (overlapping agents) |
| Composite surfacing gate | **Complete** | ≥0.7 weight and ≥2 signals |
| LLM synthesis with deterministic fallback | **Complete** | |
| Compliance audit trail with SEBI labels | **Complete** | |
| Explainability with evidence trace | **Complete** | Honest `live: false` without a provider |
| Persistent Knowledge Brain (pgvector) | **Complete** | Text fallback without embeddings |
| Concept Learning, Pattern Recognition, Historical Similarity, Market Context, Knowledge Center, Research Trigger | **Complete** | |
| Continuous Learning from Outcomes | **Partial** | Directional labels only, self-documented |
| Strategy Intelligence base rates | **Partial** | Cross-symbol only, self-documented |
| Concept Knowledge Graph + reasoning | **Complete but unreachable** | 66 concepts, no HTTP surface, no runtime injection |
| Sentinel workspace UI | **Complete** | Market selector, day classification, context, safety feed, training, timeline |
| Trading journal | **Partial** | API complete; the UI component is not mounted on the redesigned page |
| Portfolio Intelligence | **Absent** | The one Brain subsystem never started |
| Agent definitions loaded at runtime | **Dead** | `definitions.json` is never read |

## 12.7 Frontend workspaces

| Feature | Status | Notes |
|---|---|---|
| App shell (sidebar, top bar, ticker, overlays) | **Complete** | |
| Theme engine (dark/light/high-contrast, no FOUC) | **Complete** | |
| Command palette + keyboard shortcuts | **Complete** | |
| Dashboard | **Partial** | 5 widgets live, 9 on mock data |
| Markets workspace | **Complete** | |
| Trade workspace | **Complete** | |
| Option chain | **Complete** | |
| Notifications page | **Complete** | Real API |
| Notification bell drawer | **Prototype** | Reads store-seeded mock — a second source of truth |
| Settings & plans | **Partial** | Real entitlement state; no checkout |
| Profile | **Complete** | |
| Knowledge graph viewer | **Complete** | Live SSE updates |
| Portfolio page | **Stub** | Mock stat cards, four empty tabs |
| Research page | **Stub** | Intentional "coming soon" |
| Learning hub | **Stub** | Mock paths and categories; no lesson content |
| Floating AI assistant | **Stub** | Visual dock only, no routing logic |
| Watchlist | **Prototype** | Widget renders mock rows; **no persistence model exists** |
| Dockable workspace (tabs, drag, pin, pop-out) | **Dead** | Built and working, but no route mounts `WorkspaceDock`/`WorkspaceTabs`/`DockSlot` |

## 12.8 Backtesting

| Feature | Status |
|---|---|
| EMA-cross walk-forward engine with costs and filters | **Complete** |
| CLI over real `Candle` data or the simulator | **Complete** |
| 1m→3m resampling | **Complete** |
| Additional strategies, parameter sweeps, UI, persisted results | **Absent** |

## 12.9 Dead code (present, unreachable)

- `apps/web/src/components/terminal/TerminalWorkspace.tsx` — an `export {}` tombstone.
- `WorkspaceDock`, `WorkspaceTabs`, `DockSlot`, `DockControls`, `Splitter` — complete dock engine, no route uses it.
- `lib/knowledge.ts`'s `tree()`, `file()`, `recent()`, `search()` — documented as retained after the graph-only redesign.
- `ai-core`: `InMemoryMemoryStore`, `InMemoryVectorStore`, `SimpleChunker`, `InMemoryPromptLibrary`, `DefaultToolRegistry`, `DefaultAgentRuntime` — exported, never imported outside the package.
- `packages/market-data`: `TokenBucket` / `DHAN_LIMITS` — never imported.
- `agents/sentinel/definitions.json` — never read.
- `ConceptGraphService`, `ConceptReinforcementService` — DI-registered but injected by nothing (only CLI scripts use them).
- `apps/terminal/index.html` — 2,797-line superseded prototype.
- `archive/*.txt` (15 files) — intentional retention under CLAUDE.md Rule 1.
- `Mermaid.tsx` — only the archived markdown view referenced it.
- `apps/web/src/lib/mock/*` — eight mock modules still powering nine dashboard widgets and two pages.

---

# 13. API Inventory

## 13.1 `services/api` — public ingress, port 4000

| Method | Route | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/health` | none | — | `{ok, service, timestamp}` |
| POST | `/auth/signup` | none | `{email, password≥6}` | `{accessToken, refreshToken, user}` |
| POST | `/auth/login` | none | `{email, password}` | `{accessToken, refreshToken, user}` |
| POST | `/auth/refresh` | none | `{refreshToken}` | new token pair (old revoked) |
| POST | `/auth/logout` | JWT | `{refreshToken?}` | `{ok:true}` |
| GET | `/auth/me` | JWT | — | `{id,email,country,experienceLevel,optionsFamiliarity,createdAt}` |
| PATCH | `/auth/me` | JWT | `{country?,experienceLevel?,optionsFamiliarity?}` | updated user |
| GET | `/auth/preferences` | JWT | — | `Record<key, JSON>` |
| POST | `/auth/preferences/:key` | JWT | `{value: object}` | `{key, value}` |
| GET | `/entitlements/me` | JWT | — | `{capabilities: string[]}` |
| GET | `/entitlements/me/check/:capability` | JWT | — | `EntitlementDecision` |
| GET | `/entitlements/plans` | **none** | — | active plans with grants |
| POST | `/entitlements/admin/subscriptions` | `x-admin-token` | `{userId, planCode, trial?, expiresAt?}` | `Subscription` |
| POST | `/entitlements/admin/subscriptions/:id/cancel` | `x-admin-token` | `{atPeriodEnd?}` | `Subscription` |
| POST | `/entitlements/admin/overrides` | `x-admin-token` | `{userId, capability, granted, reason, grantedBy?, expiresAt?}` | `EntitlementOverride` |
| GET | `/entitlements/admin/users/:userId/capabilities` | `x-admin-token` | — | `{capabilities}` |
| GET | `/instruments/search?q=` | JWT | — | ≤25 `Instrument[]` |
| GET | `/market-data/quote/:instrumentId` | JWT | — | `QuoteDto` |
| GET | `/market-data/quote-by-symbol/:symbol` | JWT | — | `QuoteDto` |
| GET | `/market-data/quotes?symbols=A,B` | JWT | — | `QuoteDto[]` (caller order preserved) |
| GET | `/market-data/indices` | JWT | — | 5 index `QuoteDto[]` |
| POST | `/sim/orders` | JWT | `PlaceOrderDto` | `Order` |
| GET | `/sim/orders?status=` | JWT | — | ≤200 orders + instrument |
| PATCH | `/sim/orders/:id` | JWT | `{quantity?,price?,triggerPrice?}` | `Order` |
| DELETE | `/sim/orders/:id` | JWT | — | cancelled `Order` |
| GET | `/sim/trades` | JWT | — | ≤200 trades + instrument |
| GET | `/sim/positions` | JWT | — | `PositionDto[]` (open) |
| GET | `/sim/positions/closed` | JWT | — | ≤100 flattened positions |
| POST | `/sim/positions/exit-all` | JWT | — | per-position `{order?|error?}[]` |
| POST | `/sim/positions/:instrumentId/exit?productType=` | JWT | — | exit `Order` |
| GET | `/sim/portfolio` | JWT | — | `PortfolioSummary` |
| POST | `/sentinel/observe` | JWT + cap `sentinel` | `{symbol?, context?, clientTrades?, clientPositions?}` | `ObserveResponse` |
| POST | `/sentinel/explain` | JWT + cap | `{question, context?}` | `ExplainResult` |
| POST | `/sentinel/brain/search` | JWT + cap | `{query, namespace?, limit?}` | `RetrievalResult` |
| GET | `/sentinel/brain/strategy?pattern=` | JWT + cap | — | base rate + description |
| GET | `/sentinel/observations?limit=` | JWT + cap | — | `SentinelObservation[]` |
| GET | `/sentinel/session-summary` | JWT + cap | — | `{tradesToday, flaggedEvents, realizedPnl}` |
| GET | `/sentinel/journal?limit=` | JWT + cap | — | `JournalEntry[]` |
| POST | `/sentinel/journal` | JWT + cap | `{content, mood?, tags?}` | `JournalEntry` |
| GET | `/knowledge/tree` | **flag only** | — | `TreeNode` |
| GET | `/knowledge/file?path=` | **flag only** | — | `FileContent` + links/backlinks |
| GET | `/knowledge/recent?limit=` | **flag only** | — | `RecentItem[]` |
| GET | `/knowledge/search?q=&limit=` | **flag only** | — | `SearchHit[]` |
| GET | `/knowledge/graph` | **flag only** | — | `GraphData` |
| GET | `/knowledge/activity?since=` | **flag only** | — | `ActivityEvent[]` |
| GET | `/knowledge/stream` | **flag only** | — | SSE `change` + 25 s `ping` |
| GET | `/notifications?limit=` | JWT | — | `NotificationItem[]` |
| GET | `/notifications/unread-count` | JWT | — | `{count}` |
| POST | `/notifications` | JWT | `{category,title,body}` (**unvalidated**) | `NotificationItem` |
| PATCH | `/notifications/:id/read` | JWT | — | `{ok:true}` |
| PATCH | `/notifications/read-all` | JWT | — | `{ok:true}` |

## 13.2 `services/sentinel` — internal, port 4010

| Method | Route | Auth | Request → Response |
|---|---|---|---|
| GET | `/health` | **none** | `{status:'ok', service:'sentinel'}` |
| POST | `/observe` | `x-service-token` | `ObserveRequest` → `ObserveResponse` |
| GET | `/observations?userId=&limit=` | `x-service-token` | → `SentinelObservation[]` |
| POST | `/explain` | `x-service-token` | `{question, context?}` → `ExplainResult` |
| POST | `/brain/search` | `x-service-token` | `{query,userId?,namespace?,limit?}` → `RetrievalResult` |
| GET | `/brain/stats` | `x-service-token` | → `{total, byNamespace}` |
| GET | `/brain/strategy?pattern=` | `x-service-token` | → `BaseRateResult` + description |

## 13.3 `services/market-data` — internal, port 4020

| Method | Route | Auth | Response |
|---|---|---|---|
| GET | `/health` | none | `{status: disabled\|ok\|degraded, provider, feedStatus, instruments, pipeline, recentStatus}` |

## 13.4 Live Dhan bridge — port 4600, **no authentication**

| Method | Route | Response |
|---|---|---|
| GET | `/status` | `{marketOpen, feedStatus, feedReason, now, universe}` |
| GET | `/quotes` | `{marketOpen, indices[], stocks[], etfs[], commodities[]}` |
| GET | `/instrument?symbol=` | `{instrument: InstrumentMetadataOut\|null}` — incl. `lotSize` and `derivativeLotSize` |
| GET | `/instrument/option?symbol=&expiry=&strike=&type=` | `{instrument}` — securityId, segment, class, lot, tick |
| GET | `/candles?symbol=&interval=&days=` | `{candles[], source:'dhan'\|'none'\|'error', cached?}` |
| GET | `/candles/option?symbol=&expiry=&strike=&type=&interval=&days=` | same shape, per contract |
| GET | `/optionchain/expirylist?symbol=` | `{expiries: string[]}` |
| GET | `/optionchain?symbol=&expiry=` | `{spot, strikes[{strike, ce, pe}]}` with live LTP overlay |
| GET | `/stream` | SSE snapshot every ~300 ms when dirty |

**Security note:** this server has no auth, no rate limiting of inbound requests, and permissive CORS (`Access-Control-Allow-Origin: *`). It is documented as a demo bridge, but `services/api`'s OMS and `services/sentinel` both depend on it in the current configuration.

## 13.5 Outbound APIs consumed

DhanHQ v2 (`wss://api-feed.dhan.co`, `https://api.dhan.co/v2/charts/{historical,intraday}`, `/v2/optionchain`, `/v2/optionchain/expirylist`), `images.dhan.co` scrip masters; Anthropic `/v1/messages` and `/v1/models`; OpenAI-compatible `/chat/completions`, `/embeddings`, `/models` (OpenAI, NVIDIA NIM, Ollama); Voyage `/v1/embeddings`; Tavily `/search`; Brave `/res/v1/web/search`; Firecrawl `/v1/search`.

---

# 14. Environment Variables

Compiled from all `process.env` reads plus the five `.env.example` files.

## 14.1 `services/api` (`.env.example`)

| Variable | Required | Default | Used in |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | — | Prisma datasource (all three services + every script) |
| `JWT_SECRET` | **Yes in prod** | `dev-secret-change-me` | `app.module.ts` — a silent insecure default |
| `PORT` | No | `4000` | `main.ts` |
| `FRONTEND_URL` | No | `http://localhost:3000` | CORS allowlist (comma-separated) |
| `NODE_ENV` | No | — | CORS strictness, knowledge-guard default |
| `ACCESS_TOKEN_TTL` | No | `15m` | `auth.service.ts` |
| `REFRESH_TOKEN_DAYS` | No | `30` | `auth.service.ts` |
| `DHAN_LIVE_URL` | No | `http://localhost:4600` | `market-price.service.ts` — **the OMS's price source** |
| `ADMIN_API_TOKEN` | No | unset | `AdminTokenGuard`; unset ⇒ admin API disabled |
| `SENTINEL_SERVICE_URL` | No | `http://localhost:4010` | `sentinel.service.ts` |
| `SENTINEL_SERVICE_TOKEN` | **Yes for Sentinel** | `''` | must match sentinel's `SERVICE_TOKEN` |
| `KNOWLEDGE_ROOT` | No | `../../knowledge` from cwd | `knowledge.service.ts` |
| `KNOWLEDGE_WORKSPACE_ENABLED` | No | on outside production | `knowledge.guard.ts` |

## 14.2 `services/sentinel` (`.env.example`)

| Variable | Required | Default | Used in |
|---|---|---|---|
| `PORT` | No | `4010` | `main.ts` |
| `HOST` | No | `127.0.0.1` | `main.ts` (Dockerfile sets `0.0.0.0`) |
| `SERVICE_TOKEN` | **Yes** | — | `ServiceTokenGuard`; unset ⇒ every guarded route 401s |
| `DATABASE_URL` | No (degrades) | — | Prisma; absent ⇒ runs without persistence |
| `CORS_ORIGINS` | No | `localhost:3000,127.0.0.1:3000` | `main.ts` |
| `SENTINEL_LIVE_FEED_URL` | No | `''` (disabled) | `CandleMarketDataProvider` — **unset ⇒ Sentinel never sees real data** |
| `SENTINEL_LIVE_FEED_TIMEOUT_MS` | No | `4000` | same |
| `AI_LLM_ORDER` | No | `anthropic,nvidia-nim,openai,ollama` | `factory.ts` |
| `AI_EMBEDDING_ORDER` | No | `voyage,nvidia-nim,openai` | `factory.ts` |
| `AI_RESEARCH_ORDER` | No | `tavily,brave,anthropic-web-search,firecrawl` | `factory.ts` |
| `ANTHROPIC_API_KEY` | No | — | registers Anthropic LLM + web search |
| `VOYAGE_API_KEY`, `VOYAGE_MODEL` | No | model `voyage-3` | Voyage embeddings |
| `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL` | No | `text-embedding-3-small` | OpenAI |
| `NVIDIA_NIM_API_KEY`, `NVIDIA_NIM_BASE_URL` | No | `https://integrate.api.nvidia.com/v1` | either one registers NIM |
| `NVIDIA_NIM_EMBEDDING_MODEL` | No | `nvidia/nv-embedqa-e5-v5` | NIM embeddings |
| `NVIDIA_NIM_MODEL_FAST` / `_BALANCED` / `_DEEP` | No | measured defaults | per-tier pinning |
| `NVIDIA_NIM_ENABLE_THINKING` | No | — | `chat_template_kwargs.enable_thinking` |
| `NVIDIA_NIM_TOP_P`, `NVIDIA_NIM_TIMEOUT_MS` | No | `0.95`, `300000` | sampling / patience |
| `OLLAMA_BASE_URL` | No | — | registers a local Ollama |
| `TAVILY_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY` | No | — | research providers |
| `KNOWLEDGE_BASE_DIR` | No | walks up ≤8 levels | `resolveKnowledgeBaseDir()` |

## 14.3 `services/market-data` (`.env.example`)

| Variable | Required | Default | Used in |
|---|---|---|---|
| `PORT`, `HOST` | No | `4020`, `127.0.0.1` | `main.ts` |
| `DATABASE_URL` | **Yes** | — | Prisma (example points at port **5433**) |
| `MARKET_DATA_FEED` | No | `simulated` | `registry.ts` — must be opted into `dhan` |
| `MARKET_DATA_PROVIDER` | No | mirrors feed | `registry.ts` (`dhan` throws) |
| `MARKET_DATA_FEED_MODE` | No | `full` | `ticker\|quote\|full` |
| `MARKET_DATA_FLUSH_MS` | No | `2000` | tick pipeline flush |
| `MARKET_DATA_SIM_INTERVAL_MS` | No | `2000` | simulator cadence |
| `MARKET_DATA_SIM_EMIT_WHEN_CLOSED` | No | `false` | emit outside session hours |
| `INGESTION_ENABLED` | No | `true` | `false` = maintenance window |
| `DHAN_ACCESS_TOKEN`, `DHAN_CLIENT_ID` | **Yes for real data** | — | feed, REST charts, option chain, backfill |
| `DHAN_FEED_URL` | No | `wss://api-feed.dhan.co` | feed |
| `DHAN_LIVE_PORT` | No | `4600` | live bridge listen port |

## 14.4 `apps/web` (`.env.local.example`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | No | `http://localhost:4000` | Baked into the client bundle at build time; production uses `/api` |
| `NEXT_PUBLIC_DHAN_LIVE_URL` | No | `http://localhost:4600` | Browser talks to the bridge directly |

## 14.5 Production (`infra/docker/.env.prod.example`)

Adds `DOMAIN`, `ACME_EMAIL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `IMAGE_WEB`, `IMAGE_API`, `IMAGE_SENTINEL`, `BACKUP_RCLONE_REMOTE`, `BACKUP_BUCKET`, `BACKUP_RETENTION_DAYS`; sets `KNOWLEDGE_WORKSPACE_ENABLED=false` and `NEXT_PUBLIC_API_URL=/api`. Every secret is a `CHANGE_ME_` placeholder with an explicit rotation instruction.

## 14.6 CI secrets

`SSH_HOST`, `SSH_USER`, `SSH_KEY` (repo secrets); `GITHUB_TOKEN` (automatic, used for GHCR).

## 14.7 Observations

- `DATABASE_URL` is the only variable shared by all three services, and it is read via Prisma's `env()` rather than `process.env`.
- **`JWT_SECRET` silently falls back to `dev-secret-change-me`.** No boot-time validation exists — the `packages/shared` fail-fast config loader that `ARCHITECTURE.md` §7 mandates was never built.
- `SERVICE_TOKEN`/`SENTINEL_SERVICE_TOKEN` must match across two services and two env files; a mismatch surfaces only as a 401 at call time.
- The production `.env.prod` sets **both** `SERVICE_TOKEN` and `SENTINEL_SERVICE_TOKEN` to the same value because a single file is shared by two containers.
- `SENTINEL_LIVE_FEED_URL` appears in no `.env.example`, so a default deployment leaves Sentinel on `db-candle+simulated`.
- No variable controls the matching-engine poll interval, the option-chain rate-limit gap, or any cache TTL — all are hardcoded constants.

---

# 15. Dependency Graph

## 15.1 Package-level (actual, from imports)

```
┌───────────────────────────────────────────────────────────────────┐
│                         packages/types                            │
│              (entitlements + market-data contracts)               │
└──────┬─────────────────┬──────────────────┬───────────────────────┘
       │                 │                  │
       ▼                 ▼                  ▼
 packages/market-data   packages/ai-core   apps/web ──► packages/ui
       │  │  │           │      │
       │  │  │           │      └──────────────┐
       ▼  │  ▼           ▼                     ▼
services/api  services/market-data      services/sentinel
       │              (ingestor)               │
       └──────────────┬───────────────────────┘
                      ▼
              packages/database  (schema only — consumed as
                                  generated @prisma/client, not imported)
```

- `packages/types` — leaf, zero dependencies.
- `packages/market-data` → `@tradew/types` only.
- `packages/ai-core` → **nothing** (not even `types`).
- `packages/ui` → `clsx` + React/framer-motion peers.
- `packages/database` → is not imported by anyone; services consume the generated `@prisma/client`.
- No cycles. No `packages/*` imports any `apps/*` or `services/*`.

## 15.2 Runtime graph (actual)

```
browser
  ├──► services/api  :4000  ──► PostgreSQL
  │        ├──► services/sentinel :4010   (x-service-token)
  │        │        ├──► PostgreSQL  (memory, graph, concepts, observations)
  │        │        ├──► live-feed-server :4600   (SENTINEL_LIVE_FEED_URL)
  │        │        └──► AI providers  (Anthropic / NIM / OpenAI / Ollama / Voyage / Tavily …)
  │        └──► live-feed-server :4600   (DHAN_LIVE_URL — the OMS's price source)
  └──► live-feed-server :4600            (direct fetch + SSE, unauthenticated)

services/market-data :4020 ──► PostgreSQL (sole writer of Quote)
                            ──► Dhan WS  (only when MARKET_DATA_FEED=dhan)

live-feed-server :4600 ──► Dhan WebSocket + Dhan REST + scrip-master CSV
```

## 15.3 Divergence from `ARCHITECTURE.md` §9

| Documented | Actual |
|---|---|
| `apps/web` → `services/api` only | `apps/web` also calls the live bridge directly (documented exception) |
| `services/api` → `services/trading-engine` for orders | The Python engine does not exist; the paper OMS lives inside `services/api` |
| `services/api` → `services/market-data` over REST | `services/api` reads Postgres `Quote` and calls the bridge; it never calls the ingestor |
| `services/api` → notification / analytics / tradew-ai | Those services do not exist |
| `services/sentinel` reads trade history via `services/api` | ✅ Correct — `SentinelApiService` passes summaries per request |
| Every Node service depends on `packages/shared` | `packages/shared` does not exist |
| `packages/sdk` consumed by `apps/*` | Does not exist; hand-written clients are used |

## 15.4 Module-level highlights

- **Frontend → backend:** `api.ts` is the single authenticated seam (5 wrapper modules build on it); `dhanLiveFeed.ts` is the single unauthenticated seam.
- **Frontend internals:** `AppFrame` is the hub — mounts store hydration, shortcuts, session init, theme, and four overlays. `workspaceStore` is read by ~15 components; `sessionStore` by 6.
- **OMS:** `SimController` → `OrderService` → (`MarketPriceService` → bridge, Prisma transaction) ; `MatchingEngineService` → `OrderService.executeFill` — one shared correctness-critical fill path for both market and resting orders.
- **Sentinel:** `AppController` → `SentinelOrchestratorService` → 4 intelligence services + 5 brain services + `ComplianceService`; every brain call is individually try/caught.
- **Shared math:** `marketStatusAt()` from `packages/market-data` is the one cross-service import into `services/api`'s read path.

---

# 16. Technical Debt

Findings only — nothing was fixed.

## 16.1 Testing (most severe)

- **Zero automated tests in the entire repository.** No `*.spec.ts`, `*.test.ts`, `__tests__/`, and no jest/vitest/playwright/cypress configuration.
- `@nestjs/testing` is declared as a dev dependency of `services/api` and never used.
- The closest substitutes: `packages/market-data/scripts/verify-parser.ts` (real assertions, exits non-zero), `services/sentinel/scripts/smoke-concept-graph.ts`, `smoke-nvidia-nim.ts`, and `validate-ontology.ts` — none are wired into CI.
- `PROJECT_TEST_AUDIT.md` (2,248 lines) is a **manual** audit, not an automated suite.
- CI runs no test, lint, or typecheck step.

## 16.2 Missing implementations that are declared as dependencies

- **`packages/shared`** — README only. `ARCHITECTURE.md` §6/§7 and `services/api/README.md` both declare a dependency on it; the fail-fast env validation it was supposed to provide does not exist, which is why `JWT_SECRET` can silently default.
- **`packages/sdk`** — README only; four hand-written clients exist instead.
- **`Watchlist` / `WatchlistItem` Prisma models** — called out as required in two READMEs since 2026-07-16, still absent. The watchlist UI renders mock rows.
- **`services/trading-engine`** (Python), **`services/auth`**, **`services/analytics`**, **`services/notification`**, **`services/tradew-ai`** — README only.
- **`agents/tradew-ai/`** — empty.
- **Portfolio Intelligence** — the one Brain subsystem never started (tracked in `SENTINEL_BRAIN_PROGRESS.md`).

## 16.3 Duplicate code

| Duplication | Locations |
|---|---|
| RSI / MACD implementations | `services/sentinel/src/intelligence/indicators.ts` **and** `apps/web/src/lib/technicals.ts` — different signatures |
| IST session/market-open logic | `ou-engine.marketStatusAt`, `live-feed-server.isMarketOpen`, `live-feed-server.SESSION_WINDOWS`, `api/sim/ist-time.util.ts` — four implementations |
| F&O stock universe (~212 symbols) | `live-feed-server.ts` `FO_STOCK_SYMBOLS` **and** `apps/web/src/lib/mock/foUniverse.ts` — duplication is documented but manual |
| `buildOptionSymbol` | `services/api/src/sim/market-price.service.ts` **and** `apps/web/src/lib/oms.ts` — must stay byte-identical, enforced only by comments |
| `EntitlementDecision` | `packages/types/src/entitlements.ts` **and** re-declared in `services/api/src/entitlements/entitlements.service.ts` |
| `ProviderManager` construction | Built four times: DI token in `app.module.ts`, plus inline in `SentinelOrchestratorService`, `NewsIntelligenceService`, `ExplainService` |
| `DASHBOARD_INDEX_SYMBOLS` | `services/api/src/market-data/market-data.service.ts` and `apps/web/src/lib/marketData.ts` |
| Notification category union | Prisma enum, `apps/web/src/lib/notifications.ts`, and `workspaceStore.NotificationCategory` |
| `next-env.d.ts` | `apps/web/next-env.d.ts` and `apps/web/src/next-env.d.ts` |
| Documentation | README ↔ `TRADEW_DEVELOPER_REFERENCE.md` ↔ `docs/handbook/*` describe the same systems three times |

## 16.4 Dead code

See §12.9 for the full list. Most of it is *intentional* retention under CLAUDE.md Rule 1 and is documented in `archive/README.md`. The genuinely undocumented dead weight is:
- `TokenBucket` / `DHAN_LIMITS` (never imported; the bridge re-implements rate limiting).
- Six `ai-core` implementations (`InMemoryMemoryStore`, `InMemoryVectorStore`, `SimpleChunker`, `InMemoryPromptLibrary`, `DefaultToolRegistry`, `DefaultAgentRuntime`) — roughly 40% of the package's exported surface has no consumer.
- `ConceptGraphService` / `ConceptReinforcementService` — registered in DI, injected by nothing.
- `agents/sentinel/definitions.json` — a carefully written config file no code reads.

## 16.5 TODO / FIXME markers

**There are no `TODO`, `FIXME`, `HACK`, or `XXX` comments anywhere in the codebase.** Unfinished work is instead expressed as prose docstrings ("not implemented yet", "coming soon", "first pass", "known simplification"), which is more readable but invisible to tooling. Notable examples: `registry.ts` (`MARKET_DATA_PROVIDER=dhan is not implemented yet`), `/research` page ("coming soon"), `DockControls` ("Multi-monitor pop-out — coming soon"), `search/providers.ts` (disabled "coming soon" rows), `position.service.ts` (productType-blended realized P&L), `outcome-learning.service.ts` (directional labels only).

## 16.6 Broken / questionable imports

- **No broken imports found.** Every relative and workspace import resolves.
- Two undeclared-but-working dependencies (they resolve via npm workspace hoisting, which is fragile):
  - `packages/ai-core` imports nothing external — fine.
  - `services/api` imports `@tradew/market-data` ✅ declared, but does **not** declare `@tradew/types` while `@tradew/market-data`'s public types transitively surface in its code.
- `apps/web` imports `@tradew/ui` from **source**, so a type error in the package surfaces as a Next build error in the app rather than in the package.

## 16.7 Correctness and consistency risks

1. **Two market-data pipelines, unreconciled** (§9.3) — `/market-data/indices` may serve simulated prices next to real ones on the same screen.
2. **Notification state has two sources of truth** — the bell drawer reads a store-seeded mock; the `/notifications` page reads the API. Marking read in one does not affect the other.
3. **`apps/web/src/lib/marketData.ts` types `source` as the literal `'simulated'`** while the backend widened it to `string` — a stale contract that would mislabel real data.
4. **`CreateNotificationDto` has no validators**, so the global `whitelist` pipe neither strips nor validates that body; an invalid `category` reaches Prisma and throws a 500.
5. **`GET /entitlements/plans` is unauthenticated** — minor, but it exposes the plan/grant catalogue.
6. **`/knowledge/*` is JWT-free by design**, gated only by an env flag. Path traversal is properly rejected, but if the flag were ever set in production the whole engineering vault would be publicly readable.
7. **The live bridge has no auth, no inbound rate limiting, and `Access-Control-Allow-Origin: *`**, yet two backend services now depend on it.
8. **`JWT_SECRET` silently defaults** to a known string.
9. **No holiday calendar** — `isMarketOpen`/`marketStatusAt`/`todayIstSessionEnd` treat every weekday as a trading day; documented as an open question.
10. **`OrderService.executeFill` always fills the full quantity** — `filledQuantity`/`PARTIALLY_FILLED` exist in the schema but are unreachable.
11. **No vector index** on either embedding column — similarity search is a sequential scan that will degrade as memory grows.
12. **`services/market-data` is not containerised** and appears in neither compose file, so the documented "sole writer of `Quote`" never runs in the deployed stack; nor does the live bridge that `DHAN_LIVE_URL` points at.
13. **`bcryptjs`** (pure JS) rather than native `bcrypt` — noticeably slower at cost 10 under load.
14. **`@nestjs/schedule` avoided in favour of raw `setInterval`** — fine at one instance, but nothing prevents duplicate matching-engine execution if `services/api` is ever scaled to two replicas.
15. **`refresh` revokes the old token before issuing the new one**, and the frontend retries a 401 exactly once — a race between two concurrent requests can log a user out.
16. **`docs/README.md`, `infra/README.md`, `packages/types/README.md`, `packages/ui/README.md` describe themselves as empty/unbuilt** when they are not.
17. **`docs/product-architecture/SENTINEL.md` is known-stale** — flagged in `archive/README.md` as needing a rewrite.

---

# 17. Missing Pieces

Everything referenced somewhere but not implemented.

## 17.1 Referenced in code

| Referenced | Where | Status |
|---|---|---|
| `packages/shared` config loader / logger / errors | `ARCHITECTURE.md` §6–7, `services/api/README.md` | Not built |
| `packages/sdk` typed client | `ARCHITECTURE.md` §6, `apps/*` READMEs | Not built |
| `Watchlist` / `WatchlistItem` models | `packages/database/README.md`, `services/api/README.md` | Not written |
| Dhan pull provider | `registry.createMarketDataProvider` throws | Not built (Phase 3) |
| Redis `QuoteCache` implementation | `contracts/cache.ts`, `docker-compose.prod.yml` | Not built |
| `DefaultAgentRuntime` consumption | `agents/sentinel/definitions.json` | Nothing loads it |
| Prompt Library registration | `InMemoryPromptLibrary` | No template registered |
| Tool Registry population | `DefaultToolRegistry` | No tool registered |
| `services/trading-engine` REST API | `ARCHITECTURE.md` §3 order flow | Service does not exist |
| Bracket / target child orders | `Order.parentOrderId` + schema comment | Nothing populates it |
| Partial fills | `Order.filledQuantity`, `PARTIALLY_FILLED` | Unreachable |
| `Capability.PAPER_TRADING` etc. | `packages/types/src/entitlements.ts` | Defined, never enforced |
| News data | `MarketDataProvider.getNews` | Returns `[]` in every implementation |
| Concept graph HTTP surface | `ConceptGraphService` | No controller |

## 17.2 Referenced in documentation

Services (`auth`, `analytics`, `notification`, `tradew-ai`, `trading-engine`), apps (`admin`, `mobile`), n8n workflows (all four planned exports), `infra/k8s` and `infra/terraform` (deliberately empty), `scripts/` tooling (`bootstrap`, `codegen`, `seed`, `migrate-check`), the eight TradeW AI agents, Research Vault, Learning Hub content, Onboarding flow, Workspace Continuity, TradingView Workspace, Portfolio Intelligence, ClickHouse/TimescaleDB/Kafka, OpenTelemetry/Prometheus/Grafana/Loki, and the PRD's public developer API.

## 17.3 Absent product functionality with no home yet

Billing/checkout, email delivery (so no password reset, no verification, no alert email), push notifications, KYC/compliance review, real-money order routing, position/exposure/loss limits, holiday calendar, multi-user org/team accounts, data export, and an audit-log viewer.

## 17.4 Absent engineering infrastructure

Automated tests of any kind, lint/format/typecheck gates in CI, pre-commit hooks, a staging environment, structured logging, error tracking, metrics, tracing, health-based deployment gating, rollback, database backup verification, and load testing.

---

# 18. Questions

Genuine uncertainties this audit could not resolve from the repository alone.

1. **Which market-data pipeline is intended to win?** The NestJS ingestor is the documented architecture; the live bridge is what actually serves real data and what two backend services now depend on. Is the bridge a temporary scaffold to be folded into the ingestor, or has it become the design?
2. **Is `live-feed-server.ts` ever meant to be deployed?** It has no Dockerfile and is in no compose file, yet `DHAN_LIVE_URL` defaults to it and the OMS cannot price a fill without it. In the current production stack, order placement would fail.
3. **What is the Dhan data-licensing position?** `DHAN-MARKET-DATA-INTEGRATION.md` §3.1 flags an unresolved question about whether one account may serve exchange data to end users. Has that been settled? It gates the ingestor's `MARKET_DATA_FEED=dhan`.
4. **Was the absence of tests a deliberate stage-appropriate choice or an accumulating gap?** Handbook ch. 21 describes a full strategy; no test exists. Which is current intent?
5. **Is `services/trading-engine` still in the plan?** `ARCHITECTURE.md` §3 builds the order flow around it, but the paper OMS inside `services/api` has effectively taken that role.
6. **Should `packages/shared` be built before more services are added?** Its absence is the direct cause of the silent `JWT_SECRET` default and per-service config drift.
7. **Is the Concept Knowledge Graph meant to be reachable at runtime?** 66 concepts, a full reasoning engine, and reinforcement learning exist but nothing injects `ConceptGraphService` and no endpoint exposes it.
8. **Should `agents/sentinel/definitions.json` drive behaviour?** Today the deterministic services are authoritative and the definitions are documentation. Which is the target?
9. **What is the intended relationship between the three overlapping doc sets** (README, developer reference, 28-chapter handbook)? Maintaining all three at ~1,000/2,400/16,700 lines is a standing cost.
10. **Which branch is canonical?** The default branch is `feat/knowledge-workspace`, work is on `feat/notifications`, `main` exists, and CI only fires on `main`.
11. **Is the notification bell meant to migrate to the real API?** Two sources of truth exist today, and the code comments acknowledge it.
12. **What is the plan for the dock engine?** A complete, working dockable-workspace implementation is retained but unmounted after the Trade page redesign.
13. **Is the `apps/terminal` prototype still needed?** 217 KB of superseded HTML, already documented as historical.
14. **Who consumes `docs/product/*.docx`/`.pdf`?** Binary product documents inside a git repo that is otherwise all plain text.

---

# 19. Overall Health

Scores are 1–10 relative to *a production-bound trading platform*, not to a hobby project.

| Dimension | Score | One-line verdict |
|---|---|---|
| Architecture | **8 / 10** | Unusually disciplined boundaries, honestly documented deviations |
| Backend | **7.5 / 10** | Correct, defensive, well-reasoned — but untested and thin on ops |
| Frontend | **7 / 10** | Real, polished, live-data-driven; several surfaces still mock |
| Infrastructure | **4.5 / 10** | A working deploy path exists; key components aren't in it |
| Testing | **1 / 10** | Effectively nonexistent |
| Documentation | **8.5 / 10** | Exceptional volume and honesty; some staleness and triplication |
| Security | **6 / 10** | Auth is done properly; several surfaces are deliberately open |
| Performance | **7 / 10** | Real bottlenecks found and fixed; no measurement discipline |
| Maintainability | **8 / 10** | Comments explain *why*; strict TS; low coupling |
| **Weighted overall** | **≈ 6.5 / 10** | Strong engineering, dangerously thin verification |

## Architecture — 8/10
Service boundaries are explicit and mostly honoured. `MarketFeed` (push) vs `MarketDataProvider` (pull) is the right split for the actual rate economics. The provider layer means switching LLM or market-data providers is configuration, not code. Table ownership is stated per service. Failure modes are chosen deliberately: the ingestor is a singleton because broker connections are a per-account resource; `createMarketDataProvider('dhan')` throws rather than silently simulating; Sentinel degrades rather than blocking. **Deducted for:** the unreconciled dual market-data pipeline, and the gap between the documented order flow and the built one.

## Backend — 7.5/10
`OrderService.executeFill` handles add/partial-close/full-close/flip correctly and settles margin against both the order block and the position's pre-fill margin — a subtle bug that was found and documented. Pure reads with a single writer for `Quote`. Chunked write concurrency with an overlap guard. pgvector accessed correctly through Prisma's documented `Unsupported` workaround. Fault-tolerant DB boot in all three services. **Deducted for:** zero tests, no structured logging, one unvalidated DTO, no partial fills, and hardcoded intervals.

## Frontend — 7/10
Real live data across the dashboard, markets, charts, and option chain. The singleton SSE connection is a genuine fix for a genuine browser limit. No-FOUC theming, keyboard shortcuts, command palette, reduced-motion support, and consistent `aria-label`s on icon buttons. **Deducted for:** nine dashboard widgets and three pages still on mock data, the split notification state, and a complete dock engine that no route mounts.

## Infrastructure — 4.5/10
There is a real, coherent deployment path — arm64 images to GHCR, Caddy with automatic TLS and same-origin `/api` routing (which sidesteps CORS entirely), one-shot migrations, healthchecks, and a documented backup/restore with retention. **Deducted heavily for:** `services/market-data` having no image and appearing in no compose file (so `Quote` is never written in production and the OMS's price source is absent), no staging, no rollback, no observability, and a CI pipeline with no quality gate.

## Testing — 1/10
Not a single automated test. The point is scored above zero only because `verify-parser.ts` genuinely asserts the riskiest code in the repo (byte-offset arithmetic, where a wrong offset produces plausible numbers rather than a crash), and three smoke scripts exercise the ontology and provider paths. For a system that computes margin, P&L, and order fills, this is the dominant risk in the repository.

## Documentation — 8.5/10
Among the best-documented codebases of this size I have audited. Docstrings consistently explain *why* — including a running record of bugs that were fixed and must not recur (`BAJAJ-AUTO` truncation, the FOMO lateness clamp, the stranded-margin bug, `llama-3.2-3b`'s timeouts, `nest build` picking up `scripts/`). Status markers, an explicit archive policy, and a knowledge vault that reverses its own earlier decisions in writing. **Deducted for:** ~20,000 lines across three overlapping doc sets, several READMEs describing themselves as empty when they are not, and `SENTINEL.md` being known-stale.

## Security — 6/10
Done well: bcrypt, hashed single-use refresh tokens with revocation, audit logging with IP/UA, path-traversal rejection in the knowledge service, an admin API that is off unless explicitly configured, a knowledge workspace off in production by default and returning 404 rather than 403, `class-validator` with a whitelist pipe, and no secrets in the tree.
Done poorly or deliberately deferred: a silent `JWT_SECRET` default; tokens in `localStorage` (XSS-exposed); shared static service tokens rather than mTLS; an entirely unauthenticated live bridge with wildcard CORS that two services now depend on; `/entitlements/plans` open; no rate limiting or brute-force protection on `/auth/login`; no helmet/CSP/security headers; one unvalidated DTO.

## Performance — 7/10
Real problems were identified and fixed with reasoning recorded: the SSE connection-limit exhaustion, per-tick O(n) scans replaced by keyed maps, tick coalescing with change detection, chunked write concurrency, in-flight request collapsing on the option chain, `anchorPrice` deliberately kept out of an effect dependency array to stop chart refits, and dynamic imports for the heavy Chart/OptionChain panels. **Deducted for:** no vector index, no measurement (no metrics, no profiling, no load test), N+1 patterns in `PositionService.toDto` (a bridge call per position) and `PrismaKnowledgeGraph.path` (a query per BFS node), and `StrategyIntelligenceService.baseRateFor` loading every `pattern_occurrence` row into memory to filter in JS.

## Maintainability — 8/10
Strict TypeScript everywhere, consistent naming, small focused files, low coupling, DI used properly, an explicit never-delete archive policy that keeps history readable, and comments that are unusually good at explaining intent and past failure. **Deducted for:** the absence of tests (which makes refactoring risky regardless of code quality), no lint or format gate outside `apps/web`, duplicated indicator and session logic, and two contracts (`buildOptionSymbol`, `EntitlementDecision`) whose consistency is enforced only by comments.

## Bottom line

This is a strong, thoughtfully-engineered prototype with production-grade *reasoning* and prototype-grade *verification*. The architecture, the honesty of the documentation, and the quality of the failure-mode thinking are well above what the stage would suggest. The gap is verification and operations: no tests, no observability, and a production stack that is missing the very service that supplies its market data.

If three things were fixed first, they would be: **(1)** an automated test suite starting with `OrderService`'s fill/margin math and `EntitlementsService.check`; **(2)** containerising and deploying `services/market-data` (or formally promoting the live bridge and securing it); **(3)** building `packages/shared`'s fail-fast config loader so `JWT_SECRET` and the service tokens can never silently default.

---

*End of inventory. Read-only audit — no repository files were created, modified, or deleted.*
