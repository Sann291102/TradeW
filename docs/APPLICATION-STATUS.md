# TradeW — Application Status & Roadmap

**Last updated:** 2026-08-20 (admin console + Sentinel paper execution entries; the rest is the 2026-08-15 revision)
**Branch at time of writing:** `main` (latest commit `6928301`)
**Purpose:** One place a new developer or planner can read to know, right now — what's built, what's actually working, and what's left. This is a living status doc, not a spec. For architecture rules see [`ARCHITECTURE.md`](../ARCHITECTURE.md); for the full file-by-file audit see [`REPOSITORY_INVENTORY.md`](../REPOSITORY_INVENTORY.md).

> **Since the 2026-07-25 revision** the following landed on `main` and are reflected below: a real **automated test suite + CI gate** (the "zero test coverage" gap is closed — see [that section](#automated-test-coverage)), **Razorpay payments/checkout**, the standalone **`apps/admin` operator console**, the **`services/sentinel-py` personal strategy watcher** (Python/FastAPI), the **four-layer cognition network** (`packages/ai-core` + `/admin/cognition`), broker **OAuth/credential** storage, and the **chart drawing layer + FVG detectors** in the trade workspace.

## How to read this

| Mark | Meaning |
|---|---|
| ✅ **Built & working** | Runs end to end against real data/services; manually verified. **Not unit-tested** — see [Zero test coverage](#zero-automated-test-coverage) below. |
| ⚠️ **Partial** | Real, but with a known gap (mock data on one screen, a documented simplification, a missing piece). |
| 🧱 **Built, not wired up** | Code exists and is correct but nothing in the running app calls it. |
| ❌ **Not built** | Design/README only, or literally nothing exists. |

---

## One-paragraph snapshot

TradeW is an Indian-markets (NSE/BSE/MCX) AI trading platform: real Dhan market data (live feed + historical + option chain), a working paper-trading order engine, and Sentinel — an observation-only AI safety layer with a persistent knowledge brain and a 66-concept market ontology. All of that runs today. The old "zero automated tests" gap is closed — there is now a real unit-test suite (~70 TS/JS `.spec`/`.test` files across `services/api`, `services/sentinel`, `apps/web`, `apps/admin`, `packages/ai-core`, plus 9 `pytest` files in `services/sentinel-py`) with a CI typecheck+test gate. The remaining highest-priority gap is that the piece that actually supplies real market data (the live Dhan bridge, `live-feed-server.ts`) is still a standalone script rather than a first-class deployed service.

---

## ✅ Built & working end to end

### Auth & accounts
- Signup / login / logout, JWT access + rotating hashed refresh tokens, audit logging of every auth event.
- Profile + preferences.
- Frontend session store with transparent 401-retry.

### Subscriptions & entitlements
- Plan/grant/subscription model, trial + grace period handling, quota metering (day + month), admin override API.
- Capability gating drives the real Sentinel lock screen and the Settings upgrade CTA.
- Server-side coupon/code redemption is a real entitlement grant (not a client toggle).
- ⚠️ **Gap:** no plan seed data — a fresh database grants nobody anything until rows are inserted by hand.

### Payments & checkout
- Razorpay integration in `services/api` (`payments/` module — `razorpay.client.ts`, `payment.controller.ts`, `payment.service.ts`, `payment.catalog.ts`) and a real checkout flow in `apps/web` (`(workspace)/checkout/CheckoutClient.tsx`, `lib/payments.ts`). Turns an entitlement grant into a paid transaction rather than display-only pricing.

### Admin operator console (`apps/admin`)
- Standalone Next.js app on port 3001 with its own operator-account auth (`OperatorAccount`, composed `AdminAccessGuard`), a **deny-by-default** proxy allowlist to `services/api` (`src/lib/adminProxyRoutes.ts`), and a live knowledge SSE stream.
- **Seven** surfaces read live data: Dashboard, `/ai`, `/cognition`, `/knowledge`, `/orders` (incl. Sentinel paper execution), `/system`, `/audit`. **Six** more (`/health`, `/agents`, `/reasoning`, `/rules`, `/learning-platform`, `/observability`) are scaffolded routes that render "Not built yet" with no sample data — the sidebar labels the two groups separately on purpose (`src/components/shell/nav-config.ts`).
- Writes are limited to seven audited POSTs (admin grant, three cognition controls, execution profile arm/run/upsert, agent-trading consent). No route on this console can place an order.
- `/orders` reports whether the execution loop is actually **ticking** (`/admin/execution/status` — env flag, both leader leases, last tick), and groups the window's refused decisions by the gate that stopped them (`/admin/execution/rejections`).
- ⚠️ **Gap:** no operator RBAC (`OperatorAccount` has no role column), no MFA, no IP allow-list — mitigated today by loopback-binding + SSH tunnel, which is a deployment property, not an application one. See `docs/ADMIN_PORTAL_BLUEPRINT.md` §4 for the ordered backlog.

### Market data (real)
- Dhan WebSocket live feed with a hand-written binary parser (verified by `packages/market-data/scripts/verify-parser.ts` — the one real test-like artifact in the repo).
- Live quotes for 5 indices, ~212 F&O stocks, every NSE ETF, 5 MCX commodities.
- Real historical/intraday candles, real option chain with OI/IV/Greeks and live per-strike price overlay.
- Scrip-master sync (collision-safe, deactivate-never-delete).
- ⚠️ **Gap:** this real path is served by a *standalone script* (`services/market-data/scripts/live-feed-server.ts`, port 4600, no auth, no DB) — not the NestJS ingestor that's actually documented as the architecture. See [Known critical gaps](#known-critical-gaps) below.

### Charts
- Real candlestick charts (lightweight-charts) with IST time axis, live last-bar patching (the live tick is merged into the candle series), interval switching.
- Technicals / Markets / Depth / Option-Chain tabs.
- Chart drawing layer (`lib/charts/drawings.ts`, `drawingPrimitive.ts`) and automatic detectors — Fair Value Gaps (`lib/charts/fvg.ts`) and structure detectors (`lib/charts/detectors.ts`), all unit-tested.

### Paper trading OMS
- MARKET / LIMIT / SL / SL_M order placement, a real 3-second matching engine for resting orders.
- Modify, cancel, exit-one, exit-all.
- Positions with realized/unrealized/daily P&L, margin, wallet (₹10L paper capital).
- Option contracts trade at their real per-strike premium.
- ⚠️ **Gap:** margin is explicitly simplified (not real SPAN), no partial fills, no bracket/OCO orders (schema field exists, nothing writes it).

### Sentinel paper execution (`services/api/src/paper-execution/`)
- Landed 2026-08-18 (`fd0c66d`). Turns a Sentinel observation that already cleared Sentinel's own gates into a PAPER order through the **existing** `OrderService` — no second OMS, no shadow ledger, no direct position writes. Exits go through `exitPosition` like any other order.
- `ExecutionProfile` → `ExecutionIntent` → `Order`/`Trade` → `ExecutionOutcome`, with an idempotency key claimed by INSERT *before* any order exists, nine risk gates (`execution-policy.ts`), and a per-order trace on `/orders`.
- Verified end to end against the running stack on 2026-08-18: real agent orders visible at every hop (admin stats, admin list, the bound user's `/sim/orders`, the console proxy leg) within 196 ms of creation.
- Bound to **real TradeW user accounts** (`USER_PAPER` scope) behind revocable per-user consent (`User.agentPaperTradingEnabledAt`), re-read every pass.
- Long options only (side is the constant `BUY`); `ExecutionEnvironment` has exactly one member, `PAPER`, and the loop refuses anything else twice.
- Two switches, both required: `PAPER_EXECUTION_ENABLED=true` on the API process **and** the profile's own `enabled` column. Off by default.
- Square-off orders link back to the decision they close (`Order.exitOfIntentId`, 2026-08-20), so the `source=sentinel` filter and the per-order trace cover an agent's exits as well as its entries.
- Every refusal is stored twice: as a sentence for a human (`rejectReason`) and as the failing gate's id (`rejectCheckId`) so refusals can be counted.
- ⚠️ **Expected behaviour, not a gap:** intents can accumulate with zero orders when a daily-loss gate trips (see `knowledge/Gotchas/2026-08-18 - Paper orders invisible in Admin_Web is usually no order, not a read bug.md`). The console's rejection breakdown now answers that in one glance.
- **Hardening pass (2026-08-26 — this branch):** a **global kill switch** (`SystemExecutionControl` — ON / OFF / EMERGENCY_STOP, runtime, audited, no redeploy; EMERGENCY_STOP force-flattens open positions); a **stale/missing market-data guard** (`fresh-market-data` — a quote older than `PAPER_EXECUTION_MAX_QUOTE_AGE_MS` is refused, no fill against a dead feed); one **authoritative `MarketSessionService`** (calendar-aware weekend/holiday/pre/active/post); **restart recovery** (a PROPOSED intent orphaned by a crash mid-submit is failed out under `recovery-orphaned`, guarded on status); **performance analytics** (`/admin/execution/analytics` — win rate, expectancy, profit factor, drawdown, breakdowns by strategy / confidence / strike / regime / hour — measurement only, no self-modification); a **consolidated health surface** (`/admin/execution/health` — a RUNNING/HALTED/PAUSED/IDLE/DISABLED headline *derived* from real process + DB state, plus a live feed-freshness probe); and a **real-Postgres integration harness** proving the full lifecycle + rejection matrix. See `docs/runbooks/PAPER-EXECUTION.md`.

### Sentinel (AI safety layer)
- 16-signal observation pipeline: 9 technical, 5 behavioural (revenge trading, overtrading, sizing drift, pacing, loss streaks), 6 trap-detection (bull/bear trap, liquidity sweep, low-volume breakout, FOMO entry, expiry risk), 1 news.
- Composite surfacing gate (only warns when ≥2 signals corroborate), LLM synthesis with a deterministic fallback when no AI key is configured.
- Full compliance audit trail with SEBI-relevant labels.
- Persistent Knowledge Brain: pgvector-backed memory, concept learning, pattern recognition, historical similarity, market context narration, event-driven research — all real, all degrade gracefully without a database or AI key.
- Sentinel workspace UI: market selector (~220 markets), day classification, market context panel, live safety feed, contextual training, timeline.
- ⚠️ **Gap:** "Continuous Learning from Outcomes" and "Strategy Intelligence" are first-pass only (directional labels / cross-symbol only, self-documented in `SENTINEL_BRAIN_PROGRESS.md`).

### Sentinel-py — personal strategy watcher (`services/sentinel-py`)
- New Python/FastAPI service (port 4011, additive to the TS `services/sentinel`). The user writes their own strategy in plain text; a **deterministic parser** turns it into rules; an in-process asyncio sweep loop polls live Dhan candles and runs an `IDLE → FORMING → CONFIRMED` state machine with cooldown.
- **In-trade monitoring:** once the user marks a position taken, the sweep measures R-multiple milestones (1R/2R/3R), invalidation, projected-level and structure-break — risk read from the adverse extreme, reward from the close.
- Confirmations/milestones are pushed as `Notification` rows via `services/api` (`/internal/sentinel-py/notify`) with per-trading-day dedupe; a compliance gate blocks any Buy/Sell/Entry/Target/Stop string. Backed by `UserStrategy`/`WatchSession`/`WatchObservation`, sweep gated on a `JobLease`. P0–P4 done; P5–P7 (image/video extraction, admin endpoints, strike dropdown) pending. See `services/sentinel-py/README.md`.
- Frontend: the Sentinel strategy workspace ("write, watch, follow") in `apps/web`.

### Cognition network
- Four-layer perceptor network in `packages/ai-core` (`src/cognition/`) with 17 perceptors, an event dispatcher, online Hebbian weights, and an `/admin/cognition` neural-layers console. Off by default; proposals never self-execute. Backed by `Percept`/`PerceptorState`/`CognitiveEpisode`/`CognitiveProposal`/`NeuralSynapse`.

### Concept Knowledge Graph
- 66 market concepts across 15 domains (market structure, price action, options, psychology, risk management, etc.), a 13-relation reasoning engine with weighted/decayed path explanation, and reinforcement learning that never overwrites the reviewed authored weights.
- Now exposed at runtime via `services/sentinel`'s `reasoning.controller.ts` (and the CLI scripts `ontology:validate`, `ontology:seed`, `smoke-concept-graph`), and surfaced in the `apps/admin` reasoning/knowledge consoles — no longer a stranded module.

### Backtesting
- Real EMA-cross walk-forward backtest engine against actual Dhan candle history (no look-ahead, session-aware, cost-adjusted). CLI only, no UI yet.

### Fundamental research (`/research`)
- Company profile, income statement, balance sheet and cash-flow statement from a real vendor
  (Twelve Data), normalized into one vocabulary by
  `packages/market-data/src/providers/fundamentals` and cached in Postgres
  (`ResearchCompany`, `ResearchStatementFact`).
- 21 ratios computed from those statements, each carrying its formula, its operands and the
  period it was computed from. A ratio whose inputs are missing is reported as skipped WITH the
  missing operand named — never as 0.00.
- Balance-sheet reconciliation (`Assets = Liabilities + Equity`) shown, including the
  discrepancy when it does not hold. Reported figures are never adjusted to close a gap.
- Historical series (revenue, EBITDA, net income, EPS, FCF, operating margin, ROE) drawn only
  where a metric has two or more comparable periods.
- AI synthesis grounded strictly in the retrieved statements, gated on the `ai_research`
  capability. It emits no score, rating, confidence figure or recommendation — the response
  schema has no field for one — and the evidence it was given is rendered beside the prose.
- **Free on every plan**: all statements, ratios, history, search. Only the AI synthesis is
  premium.
- Replaced a fabricated page (hardcoded P/E, ROE, EPS, market cap and shareholding; an invented
  "87% confidence / 9.2 out of 10" AI summary; nine inert tabs). See
  `docs/audits/SIDEBAR-FEATURE-REALITY-AUDIT.md` §4.8 and
  `docs/implementation/RESEARCH-IMPLEMENTATION-NOTE.md`.

### Frontend shell
- Sidebar/top bar/ticker, dark/light/high-contrast theming with no flash-of-wrong-theme, command palette, keyboard shortcuts, notifications page (real API), dashboard (mostly real data), markets workspace, trade workspace, knowledge-vault graph viewer with live updates.

---

## ⚠️ Partial — real but visibly incomplete

| Feature | What's missing |
|---|---|
| Dashboard | 5 of 14 widgets are live; the other 9 (global markets, news, risk alerts, economic calendar, etc.) render mock data |
| Portfolio page | **Corrected 2026-08-23:** Portfolio, Orders and Positions are fully real against the paper OMS, including exit/convert/modify/cancel. Their limitation is upstream — no order can fill while the Dhan bridge is down, because `MarketPriceService` has no fallback price source |
| Notifications | **Corrected 2026-08-23:** the bell, the badge and the `/notifications` page now share one store slice (`NotificationSync`), so this is no longer two sources of truth. The real remaining gap is that only ONE code path in the whole repository writes a `Notification` row (`discipline.service.ts` — the profit-target notice), so the feed is empty for almost every user |
| Settings & Plans | Real entitlement state and a real Razorpay checkout now exist (see Payments above); remaining gap is plan **seed data** so a fresh env has plans to buy |
| Watchlist | UI renders mock rows; **no `Watchlist` database model exists at all** — flagged as needed since the project started |
| Learning Hub | **Corrected 2026-08-23:** courses and lessons are generated from the indexed knowledge corpus via `services/sentinel`, and progress is real and persisted. "Certificates earned" and "hours learned" remain labelled *Coming soon* |
| Floating AI assistant | **Corrected 2026-08-23:** a real deterministic router/planner with unit tests. The LLM path (`POST /assistant/interpret`) returns 503 without an AI key and falls back to that router |

## ❌ Not built

- **TradeW AI (Research pillar) as a standalone runtime** — `services/tradew-ai` is still a thin
  scaffold. Note the line above this list is now out of date in one respect: `/research` is no
  longer a placeholder. It is a working fundamental-research terminal with its own API module
  (`services/api/src/research`), its own provider abstraction and its own grounded AI layer, which
  invokes `packages/ai-core`'s LLM providers directly rather than through `services/tradew-ai`.
  What remains unbuilt is the separate research *agent* runtime, not the research surface.
- **`services/trading-engine`** (Python, real-money execution), **`services/auth`**, **`services/analytics`**, **`services/notification`** as standalone services, **`apps/mobile`** — all README-only. (`apps/admin` is now built — see the Admin operator console section above.)
- **`packages/shared`** (fail-fast config/logger) and **`packages/sdk`** (typed client — hand-written clients are used instead). Note: `JWT_SECRET` and the two service tokens now fail-fast at boot via dedicated secret guards (`services/api/src/common/secret-validation`), so the silent-dev-default risk is closed even though `packages/shared` itself is still a placeholder.
- **Push notifications** (sub-30s socket delivery). Email delivery templates and in-app notifications with sound have since landed; **billing/checkout has landed** (Razorpay).
- **Portfolio Intelligence** (the one Sentinel Brain subsystem never started).
- **Risk engine** — no position limits, exposure caps, daily loss limits, or kill switches. Only pre-trade margin checks exist.
- ~~**Holiday calendar** — every weekday is treated as a trading day.~~ **Closed.** The shared NSE calendar (`@tradew/market-data/calendar/nse-calendar.ts`, `NSE_HOLIDAYS_2026`) is honoured across `services/api`, `services/sentinel` and the paper-execution loop; the loop's `MarketSessionService` classifies weekend / holiday / pre-market / active / post-market and refuses entries on anything but `active`.
- **n8n workflow integrations** — `workflows/` is empty.

---

## Known critical gaps

### Automated test coverage
**Closed (was the #1 gap).** There is now a real unit-test suite and a CI gate (`.github/workflows/ci.yml`, typecheck + test jobs):
- `services/api` — order fill math, settlement, position-convert, performance, entitlements/coupon redemption, discipline limits, market calendar, auth/admin/broker guards, secret validation, sentinel-py notify, leader election.
- `services/sentinel` — sentinel-intelligence, orchestrator cross-validation, publication gate, market structure, strategy engine/lifecycle, visual geometry/drawing-spec, watch.
- `apps/web` — assistant (detect/planner/brain/quotes/voice), chart drawings/FVG, sentinel models (dashboard/watch/indicators/option-chain), pricing, session storage.
- `apps/admin`, `packages/ai-core` (cognition), and `services/sentinel-py` (9 `pytest` files: parser, evaluator, state machine, sweep, intrade, notify, strategies API).

Coverage is unit-level; there is still no end-to-end/integration harness across the running services, and no Playwright UI tests. Broadening from unit tests to a thin integration layer around the order → fill → notification path is the natural next step.

### The real market-data path isn't deployed
The live Dhan bridge (`live-feed-server.ts`) that both the paper OMS and Sentinel depend on for real prices has no Dockerfile and is in neither Docker Compose file. In the current production stack as configured, it doesn't run — so order placement would have no price source. Either containerize and secure it, or finish the documented NestJS ingestor path and cut over.

### Two market-data pipelines disagree
The NestJS ingestor (writes `Quote` to Postgres) defaults to a **simulated** market and is what `GET /market-data/*` reads. The live bridge above is **real** Dhan data and is what the dashboard/charts/OMS actually use. They are not reconciled — the same screen can show simulated and real prices side by side depending on which endpoint fed it.

---

## Recommended next steps, in priority order

1. ~~Add tests for `OrderService` and `EntitlementsService.check()`~~ **Done** — both are unit-tested (`sim/order-fill.spec.ts`, `entitlements/*.spec.ts`). Next test priority: a thin **integration** harness across the running services (order → fill → notification), which unit tests don't cover.
2. **Decide the market-data architecture**: promote the live bridge to a real, secured, deployed service, or finish cutting the ingestor over to real Dhan data and retire the bridge. Don't leave both running as-is.
3. ~~Build `packages/shared`'s config loader so secrets can't silently default~~ **Addressed** — boot-time secret guards (`services/api/src/common/secret-validation`) now fail-fast on weak/missing `JWT_SECRET` and service tokens; `packages/shared` itself can still be built to centralize this.
4. **Seed `Plan`/`PlanGrant` data** so a fresh environment isn't permanently locked out of Sentinel.
5. **Unify the notification store** onto the real API so the bell drawer and the notifications page agree.
6. **Add the `Watchlist`/`WatchlistItem` Prisma models** — the most-referenced missing piece across READMEs.
7. Everything else in [§17 "Missing Pieces"](../REPOSITORY_INVENTORY.md) of the full inventory, roughly in the order it's listed there.

---

*This file is meant to be updated as work lands — not regenerated from scratch. When a ⚠️/❌/🧱 item above is finished, move it up to ✅ and note the date.*
