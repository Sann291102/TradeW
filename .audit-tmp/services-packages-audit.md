# Services & Packages Audit — TradeW Monorepo

Audited: 2026-08-04. Scope: the 8 top-level `services/*` and 7 `packages/*` workspaces.
Method: package.json presence/name, repo-wide grep for the package name / imports,
file counts, and cross-reference against root `package.json`, `docker-compose*.yml`,
and `.github/workflows/{ci,deploy}.yml`.

Root `package.json` workspaces glob is `apps/*`, `services/*`, `packages/*` (so npm
sees every folder listed below as a workspace member the moment it has a
`package.json` — even ones nothing else calls). Root **scripts** only reference
`@tradew/api`, `@tradew/web`, `@tradew/database`, `@tradew/sentinel`.
`.github/workflows/deploy.yml`'s Docker build matrix only builds `web`, `api`,
`sentinel` images. `.github/workflows/ci.yml` typechecks only `api`, `sentinel`,
`web`, and runs `npm test` on whichever workspace defines a `test` script
(api, sentinel, web, packages/market-data).

---

## SERVICES

### services/analytics
**STATUS: STUB — no code, design-only.**
- No `package.json`. Directory contains only `README.md` (869 bytes). 0 TS files.
- README: "**Status:** design-only, no code exists yet." Its stated job (aggregate
  `services/trading-engine` positions/fills/PnL + `services/market-data` into
  portfolio views) is explicitly distinguished from `trading-engine`'s own
  real-time `pnl_tracker.py` (per-trade, not aggregate) — so if it's ever built it
  is *not* a duplicate of that, just not built at all yet.
- Not referenced by root scripts, docker-compose, or CI.

### services/api
**STATUS: ACTIVE — the platform's real backend, wired everywhere.**
- `package.json` name `@tradew/api`. 167 TS/TSX files under `src/`.
- Real NestJS app: `admin/`, `auth/` (JWT, OTP, guards), `broker/` (Dhan OAuth —
  `dhan-auth.controller.ts`, `dhan-auth.service.ts`, `oauth-state.ts`),
  `crypto/` (stocks/forex/crypto quote proxies), `sim/` (paper-trading OMS —
  see below), `market-data/` (DB reads), plus specs for auth guard, broker authz,
  oauth-state, security-log.
- Depends on `@tradew/ai-core` and `@tradew/market-data` (both real, see below).
- Wired: root `dev:api`/`build:api`, CI typecheck + test job, deploy.yml Docker
  build (`services/api/Dockerfile`), `docker-compose` indirectly via Postgres.

### services/auth
**STATUS: INTENTIONAL PLACEHOLDER — not a duplicate, documented contract boundary.**
- No `package.json`. Only `README.md` (1016 bytes). 0 TS files.
- README is explicit: "This folder is **not** a running service today... the
  audited auth logic (JWT, hashed/revocable refresh tokens, `/auth/refresh` +
  `/auth/logout`, login/signup/refresh audit logging, profile/preferences)
  already works as a module inside `services/api`" (`services/api/src/auth/`,
  confirmed real — 7 files including `auth.service.ts`, `otp.service.ts`,
  `auth.guard.spec.ts`).
- Extraction trigger stated as "real session load approaching the roadmap's v0.9
  '50k concurrent' target — not a fixed date." Until then this is a deliberate
  placeholder, not dead/orphaned code and not a second implementation.

### services/market-data
**STATUS: ACTIVE implementation, but only partially wired (not deployed, not in root scripts).**
- `package.json` name `@tradew/market-data-service`. 21 TS files. Real NestJS
  ingestion runtime: `app.module.ts`, `health.controller.ts`,
  `ingestion/{dhan-websocket-factory.ts, feed-manager.service.ts,
  tick-pipeline.service.ts}`, `instruments/instrument-registry.service.ts`,
  `scrip-master/scrip-master.service.ts`, `prisma.service.ts`, plus
  `scripts/{sync-scrip-master.ts, live-feed-server.ts, backfill-candles.ts}`.
- Own README describes it precisely: "The market data **ingestion runtime**. Owns
  the feed connection, writes `Quote`... **It writes; it does not serve.**"
  Explicitly a singleton — "do not scale horizontally" (Dhan allows 5 WS
  connections per account; a 2nd replica would fight the first for connections).
- Depends on `@tradew/market-data` (the shared package) and `@tradew/types`.
- **Not wired at the root**: no `dev:market-data`/`build:market-data` script in
  root `package.json`; **no `Dockerfile`** in the folder (unlike api/sentinel);
  **not in `deploy.yml`'s build matrix**; has no `test` script so it's silently
  skipped by `ci.yml`'s "runs on every workspace with a test script" line, and
  isn't in the explicit typecheck job either. It must be started manually
  (`npm run start:dev -w @tradew/market-data-service`).
- Feed provider is config-driven: `MARKET_DATA_FEED=simulated` (default, active)
  vs `dhan` ("Built, **not enabled**... wiring a real socket is Phase 4, gated on
  the licensing question"). See Dhan section below — this is real, working code
  that is simply switched off by default, not a stub.

### services/notification
**STATUS: STUB — no code, design-only.**
- No `package.json`. Only `README.md` (971 bytes). 0 TS files.
- README: "**Status:** design-only, no code exists yet." Documented job is alert
  fanout (email/Slack/push) + the TradeW-side n8n integration; explicitly "Not
  responsible for" anything on the trading hot path.

### services/sentinel
**STATUS: ACTIVE — large, real, heavily wired.**
- `package.json` name `@tradew/sentinel`. 264 TS files — by far the largest
  workspace audited: `backtest/`, `brain/` (concept-learning, historical-
  similarity, knowledge-center, pattern-recognition, outcome-learning, etc.),
  `compliance/`, `confidence/`, `explain/`, `improvement/`, `intelligence/`,
  `sentinel-intelligence/` (visual chart context, geometry, indicator series),
  `orchestrator/`, `reasoning/`, `learning/`, `vocabulary/`, and more.
- Depends on `@tradew/ai-core`, `@tradew/types`, `@tradew/market-data`.
- Wired: root `dev:sentinel`, `ontology:validate`, `ontology:seed`; CI typecheck +
  test job; deploy.yml Docker build (`services/sentinel/Dockerfile`).
- Own package.json description confirms its scope boundary: "observation-only
  trading intelligence desk... Never places, blocks, or delays orders."

### services/tradew-ai
**STATUS: STUB folder — real implementation lives in packages/ai-core, not here.**
- No `package.json`. Only `README.md` (1162 bytes). 0 TS files.
- README is unusually direct about this: "**Status (corrected 2026-07-21):** this
  folder itself is still README-only, but the real TradeW AI agent/RAG/memory/
  provider logic (~1,697 lines) already exists in `packages/ai-core` — not
  here. Treat `packages/ai-core` as the actual implementation location until/
  unless it's extracted into this service."
- So: not an accidental duplicate of ai-core, and not truly "unused" — it's a
  reserved future service boundary whose logic is intentionally implemented
  one level down in the shared package until extraction is warranted.

### services/trading-engine
**STATUS: STUB in this repo checkout — README describes real code that is not actually present.**
- No `package.json`. Directory contains **only `README.md`** — confirmed via
  directory listing (no `.py` files anywhere in the repo at all: a repo-wide
  search for `*.py` returned zero matches).
- The README (labeled 🟢 "real, hardened work... not an experiment being
  rescued") describes, as if present, a Python options-trading bot:
  `extreme_algo_bot_v2.py` (mainline bot), `order_poller.py`, `pnl_tracker.py`,
  `security.py` (HMAC webhook verification), `mock_dhanhq.py` (paper broker
  stand-in), `templates/dashboard.html`, `requirements.txt` — none of these
  files exist under `services/trading-engine/` or anywhere else in the repo.
- The README's own last line contradicts its "🟢 real" header: "**Status:** not
  yet populated. Waiting on execution approval."
- Corroborated by `archive/README.md` (per `CONSOLIDATION-PLAN.md §2`): three
  superseded variants (`extreme_algo_bot_v1.py`, `extreme_algo_live.py`,
  `extreme_algo_paper.py`) are slated to move into `archive/`, and the keep-set
  (`extreme_algo_bot_v2.py` etc.) is slated to move into `services/trading-engine`
  — but per the same file, updated 2026-07-21: "The five items listed above...
  still have not been executed." I.e. the actual Python source almost certainly
  lives in an external/legacy location (e.g. a `tradew-prototype` copy) that was
  never migrated into this monorepo checkout.
- **Net effect:** the "extreme_algo" real-money bot is not part of this
  repository's working tree today, despite `services/analytics`'s README,
  `docs/`, and `services/trading-engine/README.md` all treating it as an
  existing internal dependency (internal REST API for positions/orders/fills/
  PnL, reachable from `services/api` and `services/analytics`).

---

## PACKAGES

### packages/ai-core
**STATUS: ACTIVE — shared AI foundation, real and heavily consumed.**
- `package.json` name `@tradew/ai-core`. 62 TS files: `agents/`, `brain/`,
  `context/`, `domain/knowledge.ts`, `graph/`, `memory/`, `news/`
  `news-event-classifier.ts`, `prompts/`, `providers/` (factory, provider-
  manager, impl/), `rag/`, `telemetry/`.
- Description in its own package.json: "Every TradeW AI product (Sentinel,
  TradeW AI Research, future agents) depends on this package and only this
  package for intelligence primitives."
- Confirmed consumers via `@tradew/ai-core` grep: `services/sentinel` (dozens of
  files — brain/*, reasoning/*, orchestrator, app.module.ts, vocabulary,
  learning/embedding-pipeline, explain/explain.service.ts, scripts), and
  `services/api` (dependency declared, used in `telemetry/`). This is also where
  `services/tradew-ai`'s logic actually lives (per that service's own README).

### packages/database
**STATUS: ACTIVE — single schema owner, used everywhere.**
- `package.json` name `@tradew/database`. Only 3 top-level TS files (it's a
  Prisma-schema package, not application code) plus `prisma/schema.prisma` and
  a migrations history.
- Description: "Single Prisma schema + migration history — the one schema owner
  for Postgres (ARCHITECTURE.md §1.4)."
- Confirmed consumers via `@tradew/database` grep: `services/api/package.json`
  (prisma schema path points here), root `package.json` (`db:generate`,
  `db:migrate` scripts), `packages/database/scripts/grant-admin.ts`, and it's the
  schema source referenced from `services/market-data` and `services/sentinel`
  Prisma clients too (both declare `@prisma/client` and point at this schema
  indirectly via the generated client). Wired at root (`db:generate`,
  `db:migrate`), and `ci.yml` runs `npx prisma generate --schema
  packages/database/prisma/schema.prisma` in every job.

### packages/market-data
**STATUS: ACTIVE — the shared market-data engine (distinct from services/market-data).**
- `package.json` name `@tradew/market-data`. 33 TS files: `cache/in-memory-
  quote-cache.ts`, `contracts/{cache,feed,instrument-ref,tick}.ts`,
  `providers/{binance,dhan,simulated,twelvedata}/`, `rate-limit/token-
  bucket.ts`, `registry.ts`, `index.ts`.
- Description: "Shared market-data engine — provider/feed contracts, the single
  simulated market, the Dhan adapter, and the ingestion primitives. Consumed by
  services/market-data (ingestor), services/api (reads) and services/sentinel."
- Confirmed real consumers (declared dependency `"@tradew/market-data": "*"` in
  each): `services/api/package.json`, `services/sentinel/package.json`,
  `services/market-data/package.json`. This is a real, in-use layering, **not**
  a duplicate of `services/market-data` — see the dedicated comparison below.
- Has its own `test`/`verify` script and is one of the four workspaces CI's
  `npm test` actually exercises.

### packages/sdk
**STATUS: ORPHANED / NOT BUILT — matches the old-audit note.**
- No `package.json`. Only `README.md` (445 bytes). 0 TS files.
- README: "A typed client generated from `services/api`'s OpenAPI spec... **Status:**
  doesn't exist yet — build this once `services/api` has enough stable endpoints
  to generate a spec from."
- Repo-wide grep for `@tradew/sdk` finds exactly **one** hit outside this README:
  `implementation_plan.md` (a planning doc, not code). No package.json anywhere
  depends on it, no import references it. Confirms the old-audit note: an
  orphaned package spec with zero real consumers because the package itself was
  never created.

### packages/shared
**STATUS: ORPHANED / NOT BUILT — matches the old-audit note.**
- No `package.json`. Only `README.md` (599 bytes). 0 TS files.
- README: "Common utilities used by every Node service: a typed config loader...
  a structured logger... common error types. **Status:** doesn't exist yet."
- Repo-wide grep for `@tradew/shared` finds exactly **one** hit outside this
  README: `implementation_plan.md`. Same conclusion as `packages/sdk` — an
  orphaned spec, never implemented, nothing imports it.

### packages/types
**STATUS: ACTIVE — small but real, consumed by the backend services.**
- `package.json` name `@tradew/types`. 6 TS files: `entitlements.ts`,
  `index.ts`, `market-data.ts` (+3 more not enumerated in the depth-2 listing).
- Description: "Shared TypeScript domain types & contracts — entitlements/
  subscriptions, market data provider abstraction, API DTOs."
- Confirmed dependency declarations: `services/api/package.json` is not a direct
  dependent per its deps list, but `services/sentinel/package.json` and
  `services/market-data/package.json` both declare `"@tradew/types": "*"`
  directly (verified by reading each package.json), and `packages/market-data`
  also depends on it. Real, in-use shared-types package.

### packages/ui
**STATUS: ACTIVE — design system, extensively consumed by apps/web.**
- `package.json` name `@tradew/ui`. 16 TS/TSX files: `components/` (Animated
  Number, Badge, Button, Card, EmptyState, IconButton, Panel, Skeleton,
  Sparkline, StatCard, Surface), `lib/cn.ts`, `motion/variants.ts`,
  `styles/tokens.css`, `tailwind-preset.ts`.
- Description: "Consumed by apps/web via Next transpilePackages; no separate
  build step."
- Confirmed: `@tradew/ui` grep returns 100+ hits, almost entirely `apps/web/src/
  **` component/page files (dashboard, terminal panels, workspace, shell, sentinel
  UI, learning, settings, etc.), plus a handful of superseded snapshots under
  `archive/*.txt`.
- **Known live bug** (per `.github/workflows/ci.yml`'s own comment): `apps/web/
  src/app/notifications/NotificationsClient.tsx` imports a `Spinner` component
  from `@tradew/ui` that doesn't exist — `packages/ui` only exports `Skeleton`
  as the loading-state primitive. This fails `tsc` (TS2305) and is called out as
  a known, currently-broken import in a dedicated CI job (`typecheck-web`),
  separated out specifically so it doesn't mask the other two typecheck jobs.

---

## Duplicate / overlap investigations

### services/market-data vs packages/market-data — NOT a duplicate; a clean two-layer split
- `packages/market-data` (33 files) is the **dependency-free library**: feed/
  tick/cache/instrument-ref contracts, the four provider clients (dhan,
  binance, twelvedata, simulated), a rate limiter, and a registry. It has no
  database, no server, no `ws` dependency of its own — `dhan.feed.ts`'s own
  header comment: "The WebSocket implementation is injected rather than
  imported so this package stays dependency-free and the reconnect logic is
  testable without a network."
- `services/market-data` (21 files) is the **NestJS runtime** that wires that
  library up to a real transport and a real database: `ingestion/dhan-
  websocket-factory.ts` supplies the real `ws`-based `WebSocketFactory` the
  library's `DhanMarketFeed` class expects; `ingestion/tick-pipeline.service.ts`
  and `feed-manager.service.ts` persist ticks to Postgres (`Quote` rows) and the
  hot cache; `instruments/instrument-registry.service.ts` and `scrip-master/
  scrip-master.service.ts` own the instrument master sync.
- Both `services/api` and `services/sentinel` also depend directly on
  `packages/market-data` (for reads/contracts), while only `services/market-
  data` owns the live write path — exactly the layering both READMEs describe.
  **Conclusion: distinct, correctly-separated things, not a duplicate.**

### The Dhan Bridge — where the real implementation actually lives
Repo-wide case-insensitive search for `dhan` returns ~55 files. The **actual
protocol implementation** (binary frame parsing, WebSocket subscribe/
unsubscribe/reconnect state machine, DhanHQ v2 constraints — 5 connections/user,
100 instruments/message, 10s ping / 40s timeout, disconnect code 805, etc.)
exists in **exactly one place**:
- `packages/market-data/src/providers/dhan/dhan.feed.ts` (the `DhanMarketFeed`
  class) + `dhan-binary-parser.ts` + `dhan-scrip-master.ts`.

Everything else is a consumer of that one implementation, not a second copy of it:
- `services/market-data/src/ingestion/dhan-websocket-factory.ts` — 14 lines,
  just supplies the real `ws` transport (`new WebSocket(url)`) that
  `DhanMarketFeed` takes as an injected `WebSocketFactory`. Not a
  reimplementation.
- `services/market-data/scripts/live-feed-server.ts` — a **separate, standalone
  ts-node script** (imports `DhanMarketFeed` from `@tradew/market-data`
  directly) that runs a small no-DB, no-auth HTTP/WS bridge for local dev/demo.
  Its own header comment is explicit about not duplicating the real pipeline:
  "Not a replacement for the Phase 4 pipeline in docs/product-architecture/
  DHAN-MARKET-DATA-INTEGRATION.md (no persistence, no reconciliation, no
  Candle/Quote writes) — a read-only bridge from the already-working
  DhanMarketFeed client to the dashboard."
- `apps/web/src/lib/dhanLiveFeed.ts` — a pure HTTP client (`fetch` calls to
  `/feed/quotes`, `/feed/candles`, `/feed/optionchain`, etc.) against the
  `live-feed-server.ts` bridge above. It contains **no** WebSocket or binary
  protocol code at all — just typed fetch wrappers and interfaces
  (`DhanLiveQuote`, `DhanCandle`, `DhanOptionChain`, ...). Its own header
  comment names its source of truth directly: "Client for the standalone Dhan
  live-feed bridge (services/market-data/scripts/live-feed-server.ts)."
- `services/api/src/broker/dhan-auth.{controller,service}.ts` — handles the Dhan
  OAuth/app-key consent flow and stores the resulting `BrokerCredential` token;
  unrelated to the feed/WebSocket logic, a different concern (auth, not data).
- `packages/market-data/src/providers/dhan/dhan-scrip-master.ts` — instrument
  master (symbol/security-id mapping) parsing, consumed by `services/market-
  data/src/scrip-master/scrip-master.service.ts`.

**Conclusion: one real Dhan WebSocket/feed implementation
(`packages/market-data/src/providers/dhan/`), consumed by two different runtime
edges (the NestJS ingestion service, and a standalone dev bridge script), plus a
thin browser-side HTTP client. No duplicate protocol implementation exists.**
Also worth flagging: the Dhan **live** feed is officially "Built, not enabled"
per `services/market-data/README.md` — `MARKET_DATA_FEED` defaults to
`simulated` everywhere, so today's "real" Dhan ticks in the dashboard actually
flow through the separate `live-feed-server.ts` bridge script, not through the
main `services/market-data` NestJS ingestion pipeline.

### services/auth vs services/api/src/auth — not a duplicate, a documented placeholder
Covered above under `services/auth`. `services/api/src/auth/` (7 files:
`auth.controller.ts`, `auth.guard.ts` + spec, `auth.service.ts`,
`otp.service.ts`, `admin-token.guard.ts`, `auth.module.ts`) is the one real,
working implementation. `services/auth/` is an empty folder with a README
explicitly stating it is a future extraction target, not a second
implementation to reconcile.

### services/api/src/sim (paper OMS) vs services/trading-engine ("extreme_algo") — no overlap, and the latter isn't present
`services/api/src/sim/` is the **paper-trading** order-management system:
`order.service.ts`, `matching-engine.service.ts`, `market-price.service.ts`,
`position.service.ts`, `portfolio.service.ts`, `sim.controller.ts`,
`sim.module.ts`, `ist-time.util.ts`, plus `order-fill.spec.ts`. Confirmed real
and tested (`docs/handbook/11-paper-trading-engine.md` documents it in detail;
`archive/README.md` records its evolution from a market-order-only stub to a
full LIMIT/SL/SL_M engine on 2026-07-22).

`services/trading-engine` (the Python "extreme_algo" real-money options bot) is,
per the dedicated finding above, **not present in this repository at all** — only
its README exists. So there is no code-level duplication between the two: one is
a real, working, TypeScript paper-trading engine inside `services/api`; the
other is an undelivered Python service described only in documentation.
`services/analytics`'s README correctly anticipates this distinction ("separate
from services/trading-engine's own real-time pnl_tracker.py") but that
distinction is currently moot since neither `analytics` nor `trading-engine` has
any code yet.

### packages/shared and packages/sdk — confirmed orphaned, zero consumers
Repo-wide grep for `@tradew/shared` and `@tradew/sdk` each return exactly one
match outside their own README: a mention in `implementation_plan.md` (a
planning/roadmap document). No `package.json` anywhere lists either as a
dependency, no `import`/`require` references either specifier, and neither
folder has a `package.json` of its own (so npm's workspaces glob doesn't even
register them as installable packages today). This matches the old-audit note
verbatim — both are aspirational specs, not orphaned *installed* packages.

---

## Summary table

| Workspace | package.json? | Real code? | Status |
|---|---|---|---|
| services/analytics | no | no (0 files) | STUB — design-only |
| services/api | yes (`@tradew/api`) | yes (167 files) | ACTIVE |
| services/auth | no | no (0 files) | PLACEHOLDER — logic lives in services/api/src/auth |
| services/market-data | yes (`@tradew/market-data-service`) | yes (21 files) | ACTIVE but not deployed/wired at root |
| services/notification | no | no (0 files) | STUB — design-only |
| services/sentinel | yes (`@tradew/sentinel`) | yes (264 files) | ACTIVE |
| services/tradew-ai | no | no (folder is empty) | STUB folder — real logic lives in packages/ai-core |
| services/trading-engine | no | no (0 files, incl. 0 .py anywhere in repo) | STUB — README describes code that isn't in this repo |
| packages/ai-core | yes (`@tradew/ai-core`) | yes (62 files) | ACTIVE |
| packages/database | yes (`@tradew/database`) | yes (schema-owner) | ACTIVE |
| packages/market-data | yes (`@tradew/market-data`) | yes (33 files) | ACTIVE |
| packages/sdk | no | no (0 files) | ORPHANED — one mention in a planning doc only |
| packages/shared | no | no (0 files) | ORPHANED — one mention in a planning doc only |
| packages/types | yes (`@tradew/types`) | yes (6 files) | ACTIVE |
| packages/ui | yes (`@tradew/ui`) | yes (16 files) | ACTIVE, heavily used by apps/web |
