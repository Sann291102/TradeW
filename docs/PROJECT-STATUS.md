# TradeW — Project Status Audit

**Audit date:** 2026-08-20 · **Branch audited:** `feat/company-intelligence` (8 commits ahead of `origin/main`, working tree dirty)
**Method:** full source scan + `git log` + planning docs + **every test suite executed** + typecheck + production build of `apps/web`. Nothing below is marked done on the strength of a doc or a README alone.

> **Note on scope:** the brief said "keep under [X] lines" with the number unfilled. Target taken as ~430 lines. Also: the request named the stack as blank — it was determined from the repo (TypeScript monorepo: Next.js 14 + NestJS 10 + Prisma/Postgres, plus a Python/FastAPI service).
>
> This file supersedes [docs/APPLICATION-STATUS.md](docs/APPLICATION-STATUS.md), which is stale as of 2026-08-15 — several gaps it lists as open are closed (plan seed data, holiday calendar, live-feed deployment), and it predates the entire backtesting and company-intelligence work.

---

## 1. Executive summary

TradeW is an Indian-markets (NSE/BSE/MCX) retail trading platform built around real Dhan broker market data. It provides a paper-trading order management system with a live matching engine, live charts with an option chain, and **Sentinel** — an observation-only AI layer that watches a trader's own behaviour and the market and narrates risk, but is architecturally forbidden from placing, blocking, or recommending trades. A newer **Company Intelligence** pillar ingests NSE filings (bhavcopy, XBRL financial statements) into a provenance-tracked warehouse, and a **backtesting platform** replays stored bars against strategies. Real-money execution does not exist and has never been started.

### Completion by module

| Module | Where | Complete | Basis |
|---|---|---:|---|
| Auth, accounts, sessions | `services/api/src/auth` | **95%** | 15 endpoints, JWT + rotating refresh, OTP, OAuth, audit; guard tests pass |
| Entitlements, plans, payments | `services/api/src/{entitlements,pricing,payments}` | **90%** | Razorpay live; capability gating drives the real lock screen; plans seeded |
| Paper-trading OMS | `services/api/src/sim` | **85%** | Order → fill → position → settlement all tested; no partial fills / OCO |
| Sentinel (TypeScript) | `services/sentinel` | **85%** | 428 tests green; 16-signal pipeline, brain, compliance trail |
| Sentinel-py strategy watcher | `services/sentinel-py` | **80%** | 304 tests green; P5 & P6 not started |
| Web frontend | `apps/web` | **80%** | 24 routes, production build clean; 4 dashboard widgets still mock |
| Cognition network | `packages/ai-core/src/cognition` | **70%** | Built and wired; **off by default** (`COGNITION_ENABLED=false`), never run in anger |
| Market data | `services/market-data`, `packages/market-data` | **70%** | Real path works, but two pipelines disagree and the service has **zero tests** |
| Backtesting platform | `services/api/src/backtest`, `services/sentinel/src/backtest` | **55%** | Engine + 8 endpoints + 23 tests — **entirely uncommitted, and no UI** |
| Admin operator console | `apps/admin` | **50%** | 6 of 13 routes live; 7 render an honest "not built" state |
| Company Intelligence | `services/company-data`, `services/api/src/company` | **25%** | Phases 1–3 of 12; no UI, no Dockerfile, cannot be deployed |
| TradeW AI (research pillar) | `services/tradew-ai` | **10%** | 556-line shell; agent roster unwired |
| Real-money trading engine | `services/trading-engine` | **0%** | README only |
| `apps/mobile`, `services/{auth,analytics,notification}`, `packages/{sdk,shared}` | — | **0%** | README only, by design |

### Top 3 risks / blockers

1. **~3,000 lines of the backtesting platform are uncommitted**, including a Prisma migration (`20260820120000_backtesting_platform`) and an edit to `services/api/src/app.module.ts`. It is tested and typechecks, but it exists only in one working tree. A `git checkout .` or a disk failure destroys it. **This is the single highest-value action in this document: commit it today.**
2. **Two market-data pipelines disagree, and neither is tested.** `services/market-data/src/` (NestJS ingestor, writes `Quote` rows, `.env.example` defaults it to `MARKET_DATA_FEED=simulated`) and `services/market-data/scripts/live-feed-server.ts` (1,866 lines, real Dhan, what the charts and OMS actually consume) are both live. `services/market-data` has **0 test files across 3,677 lines** — the least-tested code in the repo is the code that supplies every price.
3. **Product surface is outrunning product depth.** Three pillars started in the last 10 days (paper execution, company intelligence, backtesting) and none has a user-facing UI. Meanwhile Sentinel — the differentiator — has open first-pass subsystems. Risk is a platform that is broad, tested, and unusable.

---

## 2. Fully implemented ✅

Evidence standard: passing tests **and** a reachable runtime path (HTTP endpoint or rendered UI).

**Test suites — all executed 2026-08-20, all green:**

| Suite | Files | Tests | Result |
|---|---:|---:|---|
| `services/api` | 37 | 522 | ✅ pass |
| `apps/web` | 35 | 639 | ✅ pass |
| `services/sentinel` | 24 | 428 | ✅ pass |
| `services/sentinel-py` (pytest) | 21 | 304 | ✅ pass |
| `services/company-data` | 6 | 82 | ✅ pass |
| `apps/admin` | 3 | 58 | ✅ pass |
| `packages/market-data` | 2 | 34 | ✅ pass |
| `packages/ai-core` | 1 | 17 | ✅ pass |
| **Total** | **129** | **2,084** | **✅ 100% pass** |

`tsc --noEmit` is clean on `services/api`, `services/sentinel`, `apps/web`, `apps/admin`. `next build` on `apps/web` succeeds and emits all 24 routes.

| Feature | Lives in | Evidence |
|---|---|---|
| **Auth & session** | `services/api/src/auth/` (15 endpoints) | JWT + rotating hashed refresh, email OTP, OAuth/phone. `auth.guard.spec.ts`, `admin-token-guard.spec.ts`, `otp-disclosure.spec.ts` pass. Boot aborts on a weak `JWT_SECRET` (`common/secret-validation.ts`, 9 tests) |
| **Entitlements & plans** | `services/api/src/entitlements/` (8 endpoints) | Capability gating, quota metering, coupon redemption as a real server-side grant. `packages/database/prisma/seed.ts:77` `seedPlans()` seeds plans + grants — the old "fresh DB grants nobody anything" gap is **closed** |
| **Payments** | `services/api/src/payments/`, `apps/web/.../checkout/` | Razorpay client, catalog, controller; real checkout route builds and renders |
| **Paper OMS** | `services/api/src/sim/` (22 endpoints across 4 controllers) | MARKET/LIMIT/SL/SL_M, 3s matching engine, positions, T+1 settlement, performance. `settlement.spec.ts`, `position-convert.spec.ts`, `trade-history.spec.ts`, `performance.spec.ts` pass |
| **NSE trading calendar** | `packages/market-data/src/calendar/nse-calendar.ts` | Real 2026 holiday table, single source of truth, consumed by `services/api`, `services/sentinel`, `services/market-data`. The "every weekday is a trading day" gap is **closed** |
| **Sentinel observation pipeline** | `services/sentinel/src/{intelligence,orchestrator,compliance}` | 16 signals, composite surfacing gate, deterministic fallback with no AI key, SEBI-labelled audit trail. `strategy-engine.spec.ts`, `cross-validation.spec.ts`, `sentinel-intelligence.spec.ts` pass |
| **Sentinel adaptive calibration** | `services/sentinel/src/improvement/` | `adaptive-calibration.spec.ts` — 18 tests |
| **Sentinel-py watch engine** | `services/sentinel-py/app/` | Plain-text strategy → deterministic parser → asyncio sweep → `IDLE→FORMING→CONFIRMED`, in-trade R-multiple milestones, `JobLease`-gated. 304 pytest tests |
| **Compliance gate** | `services/sentinel-py/app/notify/`, `services/api/src/sentinel/sentinel-py.controller.ts` | Blocks any Buy/Sell/Entry/Target/Stop string before dispatch. `sentinel-py-notify.spec.ts` (6 tests) |
| **Paper execution loop** | `services/api/src/paper-execution/` | Bound to real TradeW user accounts; `execution-policy.spec.ts` (12 tests); admin arm/disarm surface in `admin.controller.ts:58-101` |
| **Discipline engine** | `services/api/src/discipline/` (3 endpoints) | Session budgets, override tokens, friction prompts; calendar-aware |
| **Dhan binary feed parser** | `packages/market-data/src/providers/dhan/dhan-binary-parser.ts` | Hand-written WebSocket binary parser, 34 tests incl. bar-bucket boundaries |
| **Charts & drawing layer** | `apps/web/src/components/charts/`, `lib/charts/` | lightweight-charts, IST axis, live last-bar patching, FVG + structure detectors, all unit-tested |
| **Company data ingestion (Ph. 1–3)** | `services/company-data/src/` | NSE equity list (2,550 companies), bhavcopy daily bars, XBRL financial statements with reconciliation. 82 tests incl. `xbrl.parser.spec.ts`, `refusal.spec.ts` |
| **Knowledge vault viewer** | `apps/web` + `apps/admin/(console)/knowledge` | Live SSE tree/graph over `knowledge/` |
| **Operator console core** | `apps/admin/(console)/{,ai,cognition,knowledge,orders,system}` | 6 routes reading real data via `/api/proxy/*`; 58 tests |

---

## 3. Partially implemented 🟡

| Feature | Done | Missing | Effort |
|---|---:|---|---|
| **Backtesting platform** | 70% | Engine, metrics, execution simulator, 8 REST endpoints and 4 DB models are complete and tested (`services/api/src/backtest/`, `services/sentinel/src/backtest/`, 23 tests). **There is no UI whatsoever** — `grep -ri backtest apps/web/src` returns only marketing copy in `LandingPage.tsx:279` and `FeatureList.tsx:40`. The product is currently *sold* on the landing page and *unreachable* in the app. Also 100% uncommitted | UI: 1–2 wks. Commit: 1 hr |
| **Company Intelligence** | 25% | Phases 1–3 of 12 done (provenance, identity, statements). Phase 4+ (shareholding, corporate actions, news/documents, ratios, peers, `/research/[symbol]` rewrite, screener, Sentinel integration) untouched — no `Shareholding*` models in `schema.prisma`. 5 endpoints in `company.controller.ts` have **zero frontend consumers**. Service has **no Dockerfile** and appears in no compose file or deploy workflow — it cannot ship | 8–12 wks for the plan as written |
| **Web dashboard** | 75% | 12 of 17 widgets read live data. Still hardcoded: `EconomicCalendar.tsx`, `GlobalMarkets.tsx`, `RiskAlerts.tsx`, `SentinelBriefing.tsx` — all importing `@/lib/mock/market`. Better than the 9 the old status doc claimed, but a "Risk Alerts" panel showing invented alerts is the worst of the four | 1 wk (or delete 3 of them) |
| **Watchlist** | 30% | `WatchlistWidget.tsx:5` renders `WATCHLIST` from mock, then overlays *real* live prices on those fake rows — the most misleading pattern in the codebase. **No `Watchlist` model exists in `schema.prisma`** and no endpoint backs it | 3–4 days (model + CRUD + UI) |
| **Research page** | 60% | `/research` is real (live feed + 365d candles) but `page.tsx:32` falls back to a **fabricated price** — `symbol === 'RELIANCE' ? 2945.20 : 1500.00` — and `changePct ?? 1.45`. This directly violates the codebase's own stated rule (`ChartPanel.tsx:322`: "a stale fake LTP under a real ticker is [misleading]"). Company list at `:16` is hardcoded | 2 hrs to fix the fallbacks; the real rewrite is Company Intelligence Phase 7 |
| **Sentinel-py** | 80% | P5 (image/video strategy extraction) and P6 (admin endpoints) not started. `README.md:20` claims "P0–P4 and P7 are complete" while `README.md:73` shows `- [ ] P7` unchecked — **the file contradicts itself** | P6: 3 days. P5: 2+ wks |
| **Admin console** | 50% | 7 of 13 routes render `UnavailableState`: `/agents`, `/audit`, `/health`, `/learning-platform`, `/observability`, `/reasoning`, `/rules`. Honestly labelled — no fake numbers — but half the console is a promise | 1 wk each |
| **Cognition network** | 70% | Fully built (17 perceptors, Hebbian weights, 5 DB models, `/admin/cognition` console) and imported in `app.module.ts`, but `COGNITION_ENABLED=false` in `.env.example:411`. Never validated against production traffic | Unknown until switched on |
| **Learning Hub** | 40% | `learning.controller.ts` has 14 real endpoints; `learning/strategies/page.tsx:4` still imports mock paths/categories; `LearningClient.tsx:347` renders an honest "Coming soon" | 2 wks for content |
| **TradeW AI (research)** | 10% | `services/tradew-ai` is 6 files / 556 lines — boots, enforces the service-token boundary, and does nothing else. The 8-agent roster in `TRADEW-AI.md` is unwired; `packages/ai-core` holds the primitives. AI OS plan Phases 2–5 not started | 6+ wks |
| **Market data** | 70% | See risk #2. Real path works; ingestor defaults to simulated; 0 tests in `services/market-data` | 1 wk to test + decide |

---

## 4. Started but left alone 🔴

| Item | Location | State | Recommendation |
|---|---|---|---|
| **Backtesting platform** | `services/api/src/backtest/` (12 files), `services/sentinel/src/backtest/`, `migrations/20260820120000_backtesting_platform/` | Untracked in git. Complete, tested, typechecks, registered in `app.module.ts` — all of it uncommitted | **FINISH** — commit immediately, then build the UI |
| **`services/market-data/src/` NestJS ingestor** | 8 files, ~700 lines | The documented architecture. Defaults to a simulated feed. The real data comes from a *script* beside it. Two implementations of one job, both running | **FINISH one, DELETE the other.** Decide in a week, not a quarter |
| **`ModulePlaceholder.tsx`** | `apps/admin/src/components/shell/ModulePlaceholder.tsx` | Dead code — superseded by `UnavailableState.tsx` (its own header says so at `:5`); zero importers | **DELETE** (per Rule 1: move to `archive/`) |
| **`services/trading-engine`** | README only | README describes real Python source (`extreme_algo_bot_v2.py`, `order_poller.py`, HMAC webhook verification) as "genuinely complete" work to be migrated. **None of that source is in this repo.** The README documents a mapping from a codebase that isn't here | **PARK** and mark the README as aspirational, or import the source. Right now it reads as a shipped service and is an empty folder |
| **`apps/mobile`, `services/{auth,analytics,notification}`, `packages/{sdk,shared}`** | README only | Deliberate placeholders with honest status markers (`🟡 doesn't exist yet`) | **PARK** — correctly handled |
| **Dual deploy pipelines** | `.github/workflows/deploy.yml` (Oracle Cloud) + `main.yml` (Azure) | Both gated to `workflow_dispatch`, both documented, but they target *different clouds*. Plus a 485 MB `tradew-azure-deploy.zip` sitting in the working directory (gitignored) | **DECIDE.** Pick one cloud, archive the other workflow, delete the zip |
| **`origin/HEAD` → `feat/knowledge-workspace`** | git config | The repo's default branch pointer is **123 commits behind** `HEAD`. `origin/main` is only 8 behind and is the real trunk | **FIX** — repoint `origin/HEAD` to `main` |
| **`sim/ist-time.util.ts`** | `services/api/src/sim/` | The last un-migrated consumer of the old weekday-only clock; explicitly named as outstanding in `discipline/market-calendar.ts:31`. Drives DAY-order expiry | **FINISH** — small, and it's an OMS correctness issue |
| **Stale branches** | 20+ local, 15+ remote | `ai-reasoning`, `merge/tradew-ai-2026-08-12`, several `claude/*` branches unmerged | **DELETE** the merged ones, triage the 4 unmerged |

---

## 5. Planned but not started 📋

| Feature | Source | Notes |
|---|---|---|
| Company Intelligence Phases 4–12 | `knowledge/Plans/2026-08-19 - Company Intelligence Platform...md:523-547` | Shareholding & corporate actions, news/documents, ratios/technicals/peers, `/research/[symbol]` rewrite, screener (AST + compiler), Sentinel integration, daily autonomous ingestion, quality dashboard, production hardening. **9 of 12 phases** |
| AI Operating System Phases 2–5 | `knowledge/Plans/2026-08-11 - AI Operating System...md:97` | Chart control surface → `services/tradew-ai` + brain → Sentinel over the visible chart → voice out / continuous mode / barge-in. Phase 1 spine shipped |
| Portfolio Intelligence | `docs/product-architecture/SENTINEL.md` | The one Sentinel brain subsystem never begun |
| **Risk engine** | `ARCHITECTURE.md` | No position limits, exposure caps, daily loss limits, or kill switches. Only pre-trade margin checks. **Blocking for any real-money path** |
| Push notifications (<30s socket) | `docs/product-architecture/` | Email templates and in-app sound landed; socket delivery did not |
| Public developer API | `packages/sdk/README.md` | Roadmap month 12–18; correctly gated on a stable OpenAPI spec |
| n8n workflows | `docs/product-architecture/N8N-WORKFLOWS.md` | `workflows/` is empty |
| Real-money execution | `services/trading-engine/README.md` | Blocked on the risk engine above |

---

## 6. Tech debt & code quality

**Debt markers: near zero, and that is real.** A full scan for `TODO`/`FIXME`/`HACK`/`XXX` across `apps/`, `services/`, `packages/` returns **0 hits**. The 12 loose matches are 3 `eslint-disable no-console` in CLI scripts and 9 *historical references* to a resolved `TODO(clock-unification)`. This is genuinely unusual and reflects a real discipline: the codebase explains itself in prose headers instead of leaving markers. Debt here is structural, not annotated.

### Security

| Finding | Location | Severity | Assessment |
|---|---|---|---|
| Dev signing-key fallback | `discipline.service.ts:124` — `secret \|\| 'discipline-dev-signing-key'` | **Low** | Guarded: `:117` throws in production. But non-prod override tokens are signed with a public constant, so any staging environment is forgeable |
| `PAPER_EXECUTION_ENABLED`, `COMPANY_DATA_INGESTION_ENABLED`, `SWAGGER_ENABLED` absent from `.env.example` | `.env.example` | **Low** | Three flags gate order placement, ingestion, and API-doc exposure. Undocumented flags default silently; `SWAGGER_ENABLED` in particular decides whether the full API surface is public |
| In-memory rate limiter | `app.module.ts:64-73` | **Medium at scale** | Comment concedes it is correct "only while a single API replica runs." The prod compose can scale `api`; the limiter cannot |
| No committed secrets | — | ✅ **Clean** | `.env`, `.env.prod`, `*.env.bak` all gitignored; only `.env.example` is tracked. No keys, no `.pem`. The 2026-08-10 JWT-fallback class is closed and regression-tested (`secret-validation.spec.ts`) |

### Test coverage gaps

| Area | Files | Lines | Tests |
|---|---:|---:|---:|
| `services/market-data` | 14 | 3,677 | **0** ⚠️ — includes the 1,866-line `live-feed-server.ts` that every price flows through |
| `services/tradew-ai` | 6 | 556 | **0** |
| `packages/{types,database,ui}` | 27 | 2,452 | **0** (mostly declarative; low risk) |
| `packages/ai-core` | 39 | 5,171 | 1 file / 17 tests — thin for the cognition engine |

No integration or E2E layer exists anywhere. All 2,084 tests are unit-level; nothing exercises order → fill → notification across running processes, and there are no browser tests.

### Duplication

- **IST/timezone logic is unified server-side and scattered client-side.** `packages/market-data/src/calendar/nse-calendar.ts` is the single source for `services/api`, `services/sentinel`, and `services/market-data`. But **17 files under `apps/web/src`** hand-roll `Asia/Kolkata` handling with no shared helper in `apps/web/src/lib/`. The fix that worked on the backend was never applied to the frontend.
- **Expiry resolution** was just deduplicated into `packages/types/src/expiry.ts` (346 lines, uncommitted) — good, and the pattern to repeat for IST.
- **`apps/web/src/lib/mock/`** — 8 files still shipped in the production bundle to serve 4 dashboard widgets, the watchlist, and learning categories.

### Documentation drift

`docs/APPLICATION-STATUS.md` (2026-08-15) lists as open: plan seed data (closed — `seed.ts:77`), holiday calendar (closed — `nse-calendar.ts`), live-feed not deployed (closed — `docker-compose.prod.yml:177`). It predates paper execution, company intelligence, and backtesting entirely. `services/sentinel-py/README.md` contradicts itself on P7 (`:20` vs `:73`).

---

## 7. Recommended next steps

Ordered by value per unit of effort.

| # | Action | Effort | Why |
|---:|---|---|---|
| **1** | **Commit the backtesting platform.** `services/api/src/backtest/`, `services/sentinel/src/backtest/`, `packages/types/src/expiry.ts`, the migration, and the `app.module.ts` edit | **1 hour** | ~3,000 tested lines exist in exactly one place on one disk. Everything else on this list is worthless if this is lost |
| **2** | **Fix the fabricated fallbacks.** `research/page.tsx:32` invented price, and `WatchlistWidget.tsx` real prices on fake rows | **3 hours** | These are the only places the app shows a number that is not true. The codebase already holds itself to "show nothing rather than something wrong" — these two violate it |
| **3** | **Test `live-feed-server.ts`.** Even 20 tests on parse → bucket → dispatch | **3 days** | 1,866 untested lines under every price in the product. The one place a silent bug corrupts everything downstream |
| **4** | **Decide the market-data architecture.** Promote the script to a service, or finish the ingestor and delete the script | **1 week** | Two pipelines that disagree is a permanent tax on every market-data change. It has been open since at least 2026-07 |
| **5** | **Ship a backtest UI.** One page: pick strategy, pick range, run, read equity curve | **1–2 weeks** | The backend is already done and already advertised on the landing page. Highest ratio of shippable product to remaining work in the repo |
| **6** | **Document the three missing env flags** and repoint `origin/HEAD` to `main` | **1 hour** | Trivial; `SWAGGER_ENABLED` is a live exposure decision made by an undocumented default |
| **7** | **Add `Watchlist`/`WatchlistItem` models + CRUD.** Retire `lib/mock/market.ts` | **4 days** | Most-referenced missing model in the repo; unblocks deleting the mock module |
| **8** | **Extract `apps/web/src/lib/ist.ts`** and migrate the 17 files | **3 days** | Apply the fix that already worked server-side |
| **9** | **Thin integration harness** — order → fill → notification across running services | **1 week** | The only structural coverage gap left; unit tests are already strong |
| **10** | **Decide Azure vs Oracle**, archive the losing workflow, delete `tradew-azure-deploy.zip` | **2 hours** | Two deploy paths to two clouds is an ambiguity that will cost an outage eventually |
| **11** | **Stop starting pillars.** Finish backtesting UI and Company Intelligence Phase 7 before opening Phase 4, AI OS Phase 2, or sentinel-py P5 | — | Three pillars opened in ten days, none reachable by a user. This is the strategic risk behind most items above |

### Deliberately not recommended

- **Real-money execution** — blocked on a risk engine that does not exist (no position limits, exposure caps, loss limits, or kill switch). Correctly not started.
- **`packages/sdk`, `apps/mobile`, `services/{auth,analytics,notification}`** — correctly parked with honest READMEs.

---

## ❓ Unknown — needs manual check

| Item | Why it can't be determined from source |
|---|---|
| Whether the production deployment is currently **running**, and on which cloud | Both deploy workflows are `workflow_dispatch`; last-run state lives in GitHub Actions, not the repo |
| Whether `COGNITION_ENABLED` / `PAPER_EXECUTION_ENABLED` are on in any live environment | Runtime env only |
| Whether the Dhan API credentials are currently valid | 24h token by SEBI rule; requires a live call |
| Real-world accuracy of Sentinel's 16 signals | Tests verify plumbing and gating, not predictive quality — needs live-market observation |
| Whether `services/company-data` ingestion has ever completed a full run against production NSE sources | Scheduler is flag-gated; no run artifacts committed |
| Actual DB state — whether migrations are applied, whether plans are seeded in any live environment | `main.yml:12` explicitly warns there is **no migration step** in the Azure deploy |
