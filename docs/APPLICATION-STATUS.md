# TradeW — Application Status & Roadmap

**Last updated:** 2026-07-25
**Branch at time of writing:** `feat/notifications` (latest commit `2302a7a`)
**Purpose:** One place a new developer or planner can read to know, right now — what's built, what's actually working, and what's left. This is a living status doc, not a spec. For architecture rules see [`ARCHITECTURE.md`](../ARCHITECTURE.md); for the full file-by-file audit see [`REPOSITORY_INVENTORY.md`](../REPOSITORY_INVENTORY.md).

## How to read this

| Mark | Meaning |
|---|---|
| ✅ **Built & working** | Runs end to end against real data/services; manually verified. **Not unit-tested** — see [Zero test coverage](#zero-automated-test-coverage) below. |
| ⚠️ **Partial** | Real, but with a known gap (mock data on one screen, a documented simplification, a missing piece). |
| 🧱 **Built, not wired up** | Code exists and is correct but nothing in the running app calls it. |
| ❌ **Not built** | Design/README only, or literally nothing exists. |

---

## One-paragraph snapshot

TradeW is an Indian-markets (NSE/BSE/MCX) AI trading platform: real Dhan market data (live feed + historical + option chain), a working paper-trading order engine, and Sentinel — an observation-only AI safety layer with a persistent knowledge brain and a 66-concept market ontology. All of that runs today, but the highest-priority gap is that **there are zero automated tests anywhere in the repository**, and the piece that actually supplies real market data to production (the live Dhan bridge) isn't in the deploy pipeline yet.

---

## ✅ Built & working end to end

### Auth & accounts
- Signup / login / logout, JWT access + rotating hashed refresh tokens, audit logging of every auth event.
- Profile + preferences.
- Frontend session store with transparent 401-retry.

### Subscriptions & entitlements
- Plan/grant/subscription model, trial + grace period handling, quota metering (day + month), admin override API.
- Capability gating drives the real Sentinel lock screen and the Settings upgrade CTA.
- ⚠️ **Gap:** no plan seed data — a fresh database grants nobody anything until rows are inserted by hand.

### Market data (real)
- Dhan WebSocket live feed with a hand-written binary parser (verified by `packages/market-data/scripts/verify-parser.ts` — the one real test-like artifact in the repo).
- Live quotes for 5 indices, ~212 F&O stocks, every NSE ETF, 5 MCX commodities.
- Real historical/intraday candles, real option chain with OI/IV/Greeks and live per-strike price overlay.
- Scrip-master sync (collision-safe, deactivate-never-delete).
- ⚠️ **Gap:** this real path is served by a *standalone script* (`services/market-data/scripts/live-feed-server.ts`, port 4600, no auth, no DB) — not the NestJS ingestor that's actually documented as the architecture. See [Known critical gaps](#known-critical-gaps) below.

### Charts
- Real candlestick charts (lightweight-charts) with IST time axis, live last-bar patching, interval switching.
- Technicals / Markets / Depth / Option-Chain tabs.

### Paper trading OMS
- MARKET / LIMIT / SL / SL_M order placement, a real 3-second matching engine for resting orders.
- Modify, cancel, exit-one, exit-all.
- Positions with realized/unrealized/daily P&L, margin, wallet (₹10L paper capital).
- Option contracts trade at their real per-strike premium.
- ⚠️ **Gap:** margin is explicitly simplified (not real SPAN), no partial fills, no bracket/OCO orders (schema field exists, nothing writes it).

### Sentinel (AI safety layer)
- 16-signal observation pipeline: 9 technical, 5 behavioural (revenge trading, overtrading, sizing drift, pacing, loss streaks), 6 trap-detection (bull/bear trap, liquidity sweep, low-volume breakout, FOMO entry, expiry risk), 1 news.
- Composite surfacing gate (only warns when ≥2 signals corroborate), LLM synthesis with a deterministic fallback when no AI key is configured.
- Full compliance audit trail with SEBI-relevant labels.
- Persistent Knowledge Brain: pgvector-backed memory, concept learning, pattern recognition, historical similarity, market context narration, event-driven research — all real, all degrade gracefully without a database or AI key.
- Sentinel workspace UI: market selector (~220 markets), day classification, market context panel, live safety feed, contextual training, timeline.
- ⚠️ **Gap:** "Continuous Learning from Outcomes" and "Strategy Intelligence" are first-pass only (directional labels / cross-symbol only, self-documented in `SENTINEL_BRAIN_PROGRESS.md`).

### Concept Knowledge Graph
- 66 market concepts across 15 domains (market structure, price action, options, psychology, risk management, etc.), a 13-relation reasoning engine with weighted/decayed path explanation, and reinforcement learning that never overwrites the reviewed authored weights.
- 🧱 **Built, not wired up** — real and correct, but no controller exposes it and nothing in the running service injects it. Only reachable via CLI scripts (`ontology:validate`, `ontology:seed`, `smoke-concept-graph`).

### Backtesting
- Real EMA-cross walk-forward backtest engine against actual Dhan candle history (no look-ahead, session-aware, cost-adjusted). CLI only, no UI yet.

### Frontend shell
- Sidebar/top bar/ticker, dark/light/high-contrast theming with no flash-of-wrong-theme, command palette, keyboard shortcuts, notifications page (real API), dashboard (mostly real data), markets workspace, trade workspace, knowledge-vault graph viewer with live updates.

---

## ⚠️ Partial — real but visibly incomplete

| Feature | What's missing |
|---|---|
| Dashboard | 5 of 14 widgets are live; the other 9 (global markets, news, risk alerts, economic calendar, etc.) render mock data |
| Portfolio page | Real stat-card numbers are mock; Holdings/Positions/Performance/Journal tabs are all empty states |
| Notifications | Two sources of truth — the bell drawer reads a store-seeded mock list, the `/notifications` page reads the real API; marking read in one doesn't affect the other |
| Settings & Plans | Real entitlement state, but no checkout/payment provider exists — pricing is display-only |
| Watchlist | UI renders mock rows; **no `Watchlist` database model exists at all** — flagged as needed since the project started |
| Learning Hub | UI shell with mock paths/categories; no lesson content |
| Floating AI assistant | Visual dock only — no routing/answering logic behind it |

## ❌ Not built

- **TradeW AI (Research pillar)** — the whole runtime. `packages/ai-core` has the primitives; nothing invokes them for research. The `/research` page is a deliberate "coming soon" placeholder.
- **`services/trading-engine`** (Python, real-money execution), **`services/auth`**, **`services/analytics`**, **`services/notification`** as standalone services, **`apps/admin`**, **`apps/mobile`** — all README-only.
- **`packages/shared`** (fail-fast config/logger — its absence is why `JWT_SECRET` can silently default to a known dev value) and **`packages/sdk`** (typed client — hand-written clients are used instead).
- **Billing/checkout**, **email delivery** (no password reset, no verification), **push notifications**.
- **Portfolio Intelligence** (the one Sentinel Brain subsystem never started).
- **Risk engine** — no position limits, exposure caps, daily loss limits, or kill switches. Only pre-trade margin checks exist.
- **Holiday calendar** — every weekday is treated as a trading day.
- **n8n workflow integrations** — `workflows/` is empty.

---

## Known critical gaps

### Zero automated test coverage
No `*.spec.ts`, `*.test.ts`, no jest/vitest/playwright config anywhere in the repo, and no test/lint/typecheck gate in CI. For a system computing margin, P&L, and order fills, this is the single biggest risk. **First priority for anyone picking this up:** a test suite starting with `OrderService`'s fill/margin math and `EntitlementsService.check()`.

### The real market-data path isn't deployed
The live Dhan bridge (`live-feed-server.ts`) that both the paper OMS and Sentinel depend on for real prices has no Dockerfile and is in neither Docker Compose file. In the current production stack as configured, it doesn't run — so order placement would have no price source. Either containerize and secure it, or finish the documented NestJS ingestor path and cut over.

### Two market-data pipelines disagree
The NestJS ingestor (writes `Quote` to Postgres) defaults to a **simulated** market and is what `GET /market-data/*` reads. The live bridge above is **real** Dhan data and is what the dashboard/charts/OMS actually use. They are not reconciled — the same screen can show simulated and real prices side by side depending on which endpoint fed it.

---

## Recommended next steps, in priority order

1. **Add tests** for `OrderService` (fill math, margin, position flip/close) and `EntitlementsService.check()` — the two places a silent bug costs real correctness.
2. **Decide the market-data architecture**: promote the live bridge to a real, secured, deployed service, or finish cutting the ingestor over to real Dhan data and retire the bridge. Don't leave both running as-is.
3. **Build `packages/shared`'s config loader** so `JWT_SECRET` and the two service tokens can never silently default — this is a small, contained fix with outsized safety value.
4. **Seed `Plan`/`PlanGrant` data** so a fresh environment isn't permanently locked out of Sentinel.
5. **Unify the notification store** onto the real API so the bell drawer and the notifications page agree.
6. **Add the `Watchlist`/`WatchlistItem` Prisma models** — the most-referenced missing piece across READMEs.
7. Everything else in [§17 "Missing Pieces"](../REPOSITORY_INVENTORY.md) of the full inventory, roughly in the order it's listed there.

---

*This file is meant to be updated as work lands — not regenerated from scratch. When a ⚠️/❌/🧱 item above is finished, move it up to ✅ and note the date.*
