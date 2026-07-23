# Chapter 4 — Platform Overview

This chapter walks every module of TradeW: what it is, where the code lives, what it depends on, what is genuinely built, and what is specified. It is the map you keep open during your first month.

---

## 4.0 The module map

```
┌───────────────────────────────────────────────────────────────────────────┐
│                        apps/web — one shell, N workspaces                 │
│                                                                           │
│  ┌──────────┐  ┌──────────────────────────────────────────────────────┐   │
│  │ SIDEBAR  │  │ TOP BAR: page · live dot · ticker · ⌘K · paper/live  │   │
│  │ (icon    │  ├──────────────────────────────────────────────────────┤   │
│  │  rail)   │  │                                                      │   │
│  │          │  │              CONTENT AREA                            │   │
│  │ Dashboard│  │              (per-workspace)                         │   │
│  │ Trade    │  │                                                      │   │
│  │ Markets  │  │   ┌────────┬──────────────────┬────────┐             │   │
│  │ Portfolio│  │   │  left  │      main        │  right │  ← 5-zone   │   │
│  │ Research │  │   │        ├──────────────────┤ (stack)│    dock     │   │
│  │ Learning │  │   │        │  auxA  │  auxB   │        │             │   │
│  │ Knowledge│  │   └────────┴────────┴─────────┴────────┘             │   │
│  │ Sentinel🔒│  │                                                      │   │
│  │ ─────────│  │                                    ╭──────────────╮  │   │
│  │ Settings │  │                                    │ TradeW AI    │  │   │
│  │ Profile  │  │                                    │ docked chat  │  │   │
│  │ Notifs   │  │                                    ╰──────────────╯  │   │
│  └──────────┘  └──────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────┬───────────────────────────────┘
                                            │ HTTPS, JWT
                                            ▼
                            ┌───────────────────────────┐
                            │   services/api  (NestJS)  │  ← the ONLY ingress
                            │  auth · entitlements ·    │
                            │  instruments · market-data│
                            │  sim · sentinel ·         │
                            │  knowledge · health       │
                            └───┬───────────┬───────────┘
                     x-service-token        │ Prisma
                                │           ▼
                    ┌───────────▼──────┐  ┌────────────────────┐
                    │ services/sentinel│  │ Postgres + pgvector│
                    │  4 agents +      │  │ 21 models          │
                    │  orchestrator +  │  └────────────────────┘
                    │  Brain           │
                    └──────────────────┘
                                │ HTTP :4600
                    ┌───────────▼──────────────────┐
                    │ services/market-data          │  ← singleton
                    │  Dhan feed / OU simulator     │
                    └───────────────────────────────┘
```

The nav order in that sidebar is not decorative — it is `NAV_ITEMS` in `apps/web/src/components/shell/nav-config.tsx`, and **the sidebar component never hardcodes a page.** Adding a workspace means adding one row to that array. The command palette's navigation provider reads the same array, so a new workspace becomes searchable for free.

---

## 4.1 Authentication 🟢

**Code:** `services/api/src/auth/` · `apps/web/src/app/login/`, `signup/` · `apps/web/src/lib/store/sessionStore.ts`
**Tables:** `User`, `RefreshToken`, `UserPreference`, `AuditEvent`

### What it does

| Endpoint | Purpose |
|---|---|
| `POST /auth/signup` | Create account; bcrypt hash; returns token pair |
| `POST /auth/login` | Verify credentials; returns access JWT + refresh token |
| `POST /auth/refresh` | Rotate: revoke presented token, issue a new pair |
| `POST /auth/logout` | Revoke the presented refresh token |
| `GET /auth/me` | Current profile |
| `PATCH /auth/me` | Update profile |
| `GET /auth/preferences` | All preferences |
| `POST /auth/preferences/:key` | Upsert one preference (JSON value) |

### Design notes worth knowing

**Refresh tokens are stored hashed.** `RefreshToken.tokenHash` is `@unique`; the plaintext token never touches the database. A database dump does not yield usable sessions.

**Rotation, not reuse.** Each refresh revokes the presented token and issues a new one. `revokedAt` is set rather than the row being deleted (archive-never-delete at the data layer), which means token-reuse detection is possible later without a schema change.

**Preferences are a typed key/value store**, not columns. `UserPreference(userId, key)` is unique with a `Json` value. New preference types require no migration. The trade-off — no schema-level validation — is accepted because preferences are UI state, not business data.

**`AuditEvent` is append-only**, indexed on `(userId, createdAt)` and `(eventType, createdAt)`, and `userId` is nullable so pre-authentication events (failed logins against unknown emails) are still recorded.

### The frontend session store

`sessionStore` is **deliberately unpersisted**. It holds the in-memory session; the refresh token lives in an httpOnly cookie. A page reload re-derives the session from `/auth/me`. This means a stolen `localStorage` dump contains no credential.

> ⚠️ **Gotcha (cost: half a day).** `AppFrame`'s mount-only `useEffect` does **not** re-run on client-side route navigation. Login succeeded but the shell didn't update — the fix was to make the effect depend on the pathname. If you ever see "the action succeeded but the chrome didn't change," suspect a mount-only effect on a component that doesn't remount.

### Not yet built 🔵

Password reset, email verification, TOTP 2FA, OAuth/social login, device/session listing.

---

## 4.2 Dashboard 🟢

**Code:** `apps/web/src/app/dashboard/page.tsx` · `apps/web/src/components/dashboard/*` (13 widgets)

The landing surface after login. Answers "what happened while I was away, and what should I look at?"

| Widget | File | Data source |
|---|---|---|
| Index Overview | `IndexOverview.tsx` | live quotes (NIFTY, BANKNIFTY, SENSEX, FINNIFTY) |
| Portfolio Summary | `PortfolioSummary.tsx` | `GET /sim/portfolio` 🟢 |
| Watchlist | `WatchlistWidget.tsx` | live quotes 🟡 |
| Market Movers | `MarketMovers.tsx` | mock 🟡 |
| Sector Heatmap | `SectorHeatmap.tsx` | mock 🟡 |
| Trending Stocks | `TrendingStocks.tsx` | mock 🟡 |
| Market News | `MarketNews.tsx` | mock 🟡 |
| Economic Calendar | `EconomicCalendar.tsx` | mock 🟡 |
| Global Markets | `GlobalMarkets.tsx` | mock 🟡 |
| Commodity Markets | `CommodityMarkets.tsx` | mock 🟡 |
| Risk Alerts | `RiskAlerts.tsx` | Sentinel observations 🟡 |
| Sentinel Briefing | `SentinelBriefing.tsx` | `POST /sentinel/observe` 🟡 |
| Quick Links | `QuickLinks.tsx` | static |

**Status honesty:** roughly half these widgets read from `apps/web/src/lib/mock/` today. That is intentional sequencing — the layout, virtualisation, and update semantics were built first so that swapping the data source is a one-line change per widget. It is also a trap: do not assume a dashboard number is live. Check the widget's import.

**Performance contract:** widgets are independent subscribers. A tick that changes NIFTY re-renders the Index Overview's price cell and nothing else. There is no dashboard-level state that all widgets read from.

---

## 4.3 Market Workspace 🟢

**Code:** `apps/web/src/app/markets/page.tsx` · `components/markets/MarketsWorkspace.tsx` · `components/dashboard/MarketWorkspace.tsx`

Symbol discovery and comparison: full index list (`lib/mock/indices.ts` — all NSE indices), F&O stock universe (`lib/mock/foUniverse.ts`), sector views, and a quote grid.

The F&O universe file matters more than it looks: it is the allowlist that determines which symbols can have an option chain (`useHasOptionChain`), which is what stops the UI offering an options view for an instrument that has no derivatives.

---

## 4.4 Charts 🟡

**Code:** `apps/web/src/components/charts/TradeChart.tsx` · `components/terminal/panels/ChartPanel.tsx` · `lib/hooks/useCandles.ts` · `lib/technicals.ts`
**Library:** `lightweight-charts` ^4.2.3 (TradingView's open-source renderer)

Full treatment in **Chapter 13**. Summary:

| Capability | Status |
|---|---|
| Candlestick / line / area series | 🟢 |
| Timeframes 1m / 5m / 15m / 1H / 4H / 1D / 1W | 🟢 |
| Indicator overlays (EMA, VWAP, RSI, MACD, CPR) | 🟢 via `lib/technicals.ts` |
| Live price updates without full redraw | 🟢 |
| Lazy-loaded chunk (`dynamic`, `ssr:false`) | 🟢 |
| Drawing tools (trendline, rect, fib, text, ruler) | 🔵 |
| Chart replay | 🔵 |
| Multi-chart layouts | 🟡 (via the dock, not a chart-native grid) |
| Custom user indicators | 🔵 |
| Embedded TradingView (licensed widget) | 🔵 Phase 9 |

`lib/technicals.ts` is a pure-function indicator library computed **client-side** from the candle array. This is a deliberate performance decision: recomputing an EMA over 500 candles in the browser costs microseconds; a network round trip costs 50–200 ms. Indicators that require data the client does not have (market breadth, OI) are computed server-side in Sentinel instead.

---

## 4.5 Watchlists 🟡

**Code:** `apps/web/src/components/terminal/panels/WatchlistPanel.tsx` · `components/dashboard/WatchlistWidget.tsx`

Symbol rows with LTP, change, % change, and an inline sparkline. Click-to-focus wires the selected symbol into the chart, option chain, and depth panels via `workspaceStore.activeSymbol` — this is the workspace's cross-panel binding and it is what makes the dock feel like one application rather than a grid of widgets.

**Not yet built:** persistence. `Watchlist` / `WatchlistItem` are net-new models identified in the Market Data domain review and not yet migrated (Chapter 17 §17.4). Today's lists are client-local.

---

## 4.6 Scanner 🔵

**Status: specified, no code.**

A scanner evaluates a predicate set across the instrument universe on a schedule and emits matches.

```
   Universe (Instrument WHERE active AND segment IN allowlist)
        │
        ▼
   Predicate set  ──►  [price > ema20]  AND  [volume > 2× avg20]
        │              AND [rsi14 < 30]
        ▼
   Evaluation (server-side, on the candle store)
        │
        ▼
   Matches ──► scan results panel ──► optional notification
```

**Binding design decisions:**
- Scanner predicates evaluate against the **persisted `Candle` store** (Migration 2), never against a live tick stream. Scanning is a minutes-scale operation, not a hot path.
- The scanner is a **read-only consumer**. It never writes to `Quote` or `Candle`.
- It must never produce directive output. A scan result is "these instruments match your predicates," never "these are buys." (ARCH-4.)
- Runs are quota'd via `UsageCounter` metric `scan_runs`.

**Blocked on:** FR-MD-9 (`Candle` model).

---

## 4.7 Screeners 🔵

**Status: specified, no code.**

Distinct from the scanner: a screener filters on **fundamental and structural** attributes (sector, market cap, IV rank, OI concentration, expiry proximity) rather than on price/volume predicates evaluated per bar.

**Blocked on:** FR-MD-10 (`OptionMetrics`) and a fundamentals data source, which is not yet chosen.

---

## 4.8 Portfolio 🟢

**Code:** `apps/web/src/app/portfolio/page.tsx` · `services/api/src/sim/portfolio.service.ts`, `position.service.ts`

`GET /sim/portfolio` returns the account rollup:

```ts
{
  startingBalance,      // ₹10,00,000, granted once at wallet creation
  availableBalance,     // cash not blocked as margin
  marginUsed,
  realizedPnl,          // lifetime, from the wallet (incremental)
  unrealizedPnl,        // sum over open positions, computed now
  dailyPnl,             // sum over positions vs. their IST session anchor
  positionValue,
  netWorth,             // cash + margin + unrealized
  openPositionsCount,
}
```

**Why `PortfolioService` is only 56 lines.** It assembles; it does not recompute. `PaperWallet` maintains cash/margin/realised P&L *incrementally* on every fill, so the portfolio read is a read — not a fold over the full trade history. This stays correct even if trade history is pruned later, and it is the reason the portfolio screen is fast.

**Positions** (`PositionService`) return a richer DTO than a naive engine would: `unrealizedPnl`, `realizedPnl`, `dailyPnl`, `mtm`, `positionValue`, `marginUsed`, `positionStatus`, and `priceStatus`.

Two details worth internalising:

- **`mtm` duplicates `unrealizedPnl` on purpose.** Same number, separate field, because "MTM" is the term traders expect on a positions screen and renaming a domain term to save a field is a bad trade.
- **`priceStatus: 'live' | 'stale'`.** When the live bridge cannot price a symbol, the row still renders using `avgPrice` as a placeholder and is flagged stale — it does not disappear and it does not error the whole list. Principle 8 (Reliability) at the row level.

---

## 4.9 Paper Trading 🟢

**Code:** `services/api/src/sim/*` (7 files) · `apps/web/src/lib/oms.ts` · `components/trade/TradeWorkspace.tsx`

Full treatment in **Chapter 11**. The short version: it is a real OMS.

```
   PENDING ──► OPEN ──────────────► PARTIALLY_FILLED ──► FILLED
      │          │                        │
      │          ├──► CANCELLED           └──► CANCELLED (residual)
      │          └──► EXPIRED (DAY validity, IST session close)
      │
      └──► TRIGGER_PENDING ──(trigger hit)──► OPEN | filling
      │
      └──► REJECTED (lot size · margin · unresolvable instrument)
```

Matching is a 3-second `setInterval` poller (`MatchingEngineService`) that loads all resting orders and evaluates each against one cached price snapshot. Polling cost does not scale with order volume, because one `/quotes` call covers every resting order regardless of count.

---

## 4.10 Orders 🟢

`POST /sim/orders`, `GET /sim/orders`, `PATCH /sim/orders/:id`, `DELETE /sim/orders/:id`, `GET /sim/trades`

Validation is at the controller boundary with `class-validator` DTOs (`PlaceOrderDto`, `ModifyOrderDto`) — an invalid payload never reaches the service.

**Known Phase 1 scope limit, documented in the controller's own docstring:** order placement covers indices, stocks, ETFs, and commodities. **Option-contract orders from the Option Chain are not yet supported** (FR-SIM-16). The schema supports them fully; the live-price bridge does not price option contracts yet.

---

## 4.11 Positions 🟢

`GET /sim/positions`, `GET /sim/positions/closed`, `POST /sim/positions/:instrumentId/exit`, `POST /sim/positions/exit-all`

**Closed positions are never deleted.** A position flattened to zero keeps its row (`@@unique([userId, instrumentId, productType])` means it is also reused if the user re-enters). `GET /sim/positions/closed` returns the last 100.

**The daily-P&L anchor** is a genuinely subtle piece of design. Rather than a separate time-series table, `Position` carries a session-open snapshot refreshed once per IST calendar day on first touch:

```prisma
sessionOpenQty         Int
sessionOpenAvgPrice    Decimal?
sessionOpenMarketPrice Decimal?
sessionAnchorAt        DateTime?
```

This distinguishes "today's P&L" from lifetime unrealised/realised **without a new table and without a nightly job**. It is the kind of decision that looks like a shortcut and is actually the right answer: the alternative (a `PositionSnapshot` table written by a cron at 09:15 IST) adds an operational dependency, a failure mode, and a backfill problem, in exchange for data nobody queries historically.

---

## 4.12 Analytics 🔵

**Status:** `services/analytics` is a README-only stub.

Specified scope: win rate, average win/loss, profit factor, expectancy, holding-period distribution, drawdown curve, per-symbol and per-setup attribution, behaviour correlation (does revenge trading actually cost this user money?).

**The behaviour-correlation piece is the interesting one** and is the analytical payoff of the whole Sentinel design. Joining `SentinelObservation` against subsequent `Trade` outcomes answers "does this user's revenge trading actually lose them money, and how much?" That is a number no competitor can produce, because no competitor logs behavioural observations with evidence and timestamps.

**Storage plan:** Postgres until aggregate queries exceed ~2 s p95, then ClickHouse. Not before. (Principle 7.)

---

## 4.13 Trading Journal 🟡

**Code:** `apps/web/src/components/sentinel/TradingJournal.tsx` · `services/api/src/sentinel/` (`GET/POST /sentinel/journal`)
**Table:** `JournalEntry`

```prisma
model JournalEntry {
  mood         String?   // 'focused' | 'anxious' | 'confident' | 'frustrated'
  content      String
  flaggedByAi  Boolean   @default(false)
  aiAnnotation String?
  tags         String[]
}
```

The mood field is the point. A journal with a mood tag turns into a dataset: "your win rate when you tagged 'frustrated' is 31%; when you tagged 'focused' it is 58%." That is the behavioural thesis made measurable, and it requires exactly one nullable string column.

**Product status is genuinely unresolved.** `SENTINEL.md` §4 records that the mood-tagged journal *exists in code* but is not part of the currently-bound Sentinel UI; reintroducing it as a longitudinal view is an open product decision. Do not assume it is on a roadmap — it is a real open question.

---

## 4.14 Learning Center 🔵

**Code:** `apps/web/src/app/learning/page.tsx` (shell) · `lib/mock/learning.ts` (content) · `components/terminal/panels/LearningMiniPanel.tsx`

**Status: shell 🟡, content mocked, backend 🔵.**

Specified architecture:

```
   Track  ──►  Module  ──►  Lesson  ──►  UserProgress
   ("Options basics")       (content +
                             concept refs)
                                │
                                ▼
                     ConceptNode.explainer
                     (the text users actually read)
```

**The v2 ambition** (Genesis Phase 7) is the interesting part: Learning Hub content generated from **validated Knowledge Graph nodes**. A concept that Sentinel has observed 200 times with a 0.85 learned confidence becomes a lesson automatically, with the observations as worked examples. This is why `ConceptNode` carries `explainer` (user-facing prose) as a field distinct from `definition` (precise, technical) and `summary` (one line).

**Non-goal, stated in the blueprint:** the Learning Hub must never become a signal service. A lesson explains a concept; it never says "and therefore buy X."

---

## 4.15 Settings 🟢

**Code:** `apps/web/src/app/settings/page.tsx`, `SettingsClient.tsx`

Backed by `UserPreference` (typed key/value). Covers appearance/theme, workspace defaults, notification preferences, and data/privacy controls. Adding a setting requires no migration.

---

## 4.16 Notifications 🟡

**Code:** `apps/web/src/app/notifications/` · `components/shell/NotificationCenter.tsx`
**Service:** `services/notification` is a stub 🔵

In-app centre with unread count and keyboard navigation (↑/↓/Enter/Esc) 🟢. Fan-out to email/push/Slack via `services/notification` + n8n is specified 🔵.

**Binding rule for the future service:** nothing on the sub-150 ms path — market ticks, order execution — ever routes through n8n. n8n is for minutes-scale ops workflows, never the trading hot path. (`ARCHITECTURE.md` §5.)

---

## 4.17 Subscriptions & Entitlements 🟢

**Code:** `services/api/src/entitlements/` · **Tables:** `Plan`, `PlanGrant`, `Subscription`, `EntitlementOverride`, `UsageCounter`

This is one of the best-built modules in the platform and repays reading in full.

### The separation of concerns (locked decision Q7)

```
   auth          = who you are
   subscription  = what plan you're on
   billing       = how you pay      ← future adapter, integrates ONLY
                                       through SubscriptionLifecycle
   entitlements  = what features you get
   usage         = how much you may use
```

Four concepts, four table groups, one decision point. `EntitlementsService`'s docstring is explicit: *"the ONLY place premium access is decided. No hardcoded plan checks anywhere else in the codebase."*

### The decision algorithm

```
check(userId, capability):
  1. EntitlementOverride, newest first, unexpired
       → granted?  ALLOW  reason='override'
       → revoked?  DENY   reason='override_revoked'

  2. live Subscriptions (ACTIVE | TRIALING | PAST_DUE | GRACE), newest first
       → none?     DENY   reason='no_subscription'

  3. does any live plan grant this capability?
       → no?       DENY   reason='plan_lacks_capability'

  4. does the grant carry a quota?
       → yes: UsageCounter(userId, metric, periodKey)
            → used >= limit?  DENY  reason='quota_exhausted'

  5. ALLOW  reason='plan_grant' | 'trial' | 'grace_period'
```

### Why the decision is a *typed object*, not a boolean

```ts
export interface EntitlementDecision {
  userId: string;
  capability: string;
  allowed: boolean;
  reason: 'plan_grant' | 'trial' | 'grace_period' | 'override'
        | 'no_subscription' | 'plan_lacks_capability'
        | 'subscription_expired' | 'quota_exhausted' | 'override_revoked';
  quota?: { metric: string; limit: number; used: number; period: string };
  decidedAt: Date;
}
```

A boolean tells the UI to show a lock. A `reason` tells the UI *which* lock: "start your free trial" (`no_subscription`) is a different screen from "you've used 50 of 50 research runs this month" (`quota_exhausted`) is a different screen from "your payment failed, update your card" (`PAST_DUE`).

Returning a reason is also what makes support tractable. "It says I can't access Sentinel" is unanswerable; `reason: 'quota_exhausted'` with the quota object attached is a one-line answer.

**Note `PAST_DUE` and `GRACE` are both live statuses.** A failed payment does not instantly revoke access. That is a deliberate customer-first choice (Principle 1) encoded in a constant.

### The `CapabilityGuard`

`@UseGuards(AuthGuard, CapabilityGuard)` + `@RequiresCapability('sentinel')` at the controller. Enforcement is at the boundary, never scattered through service code.

### ⚖️ The visibility rule, again

`Sentinel` is `premium: true` in `NAV_ITEMS` — which controls a lock affordance, **not** whether the item renders. Entitlement gates reasoning, never visibility. Getting this backwards is a product bug, not a billing bug.

---

## 4.18 Workspace 🟢

**Code:** `apps/web/src/components/workspace/*` (11 files) · `lib/store/workspaceStore.ts` · `lib/shortcuts.ts`

The platform's signature engineering. Full treatment in Chapter 15 §15.6.

### Five-zone dock — and why not floating windows

```
   ┌────────┬─────────────────────┬────────┐
   │        │        main         │        │
   │  left  ├──────────┬──────────┤ right  │  right stacks vertically,
   │        │   auxA   │   auxB   │(stack) │  ordered by `order`
   └────────┴──────────┴──────────┴────────┘
```

Free-floating windows were considered and rejected. Zones give: deterministic layout serialisation (a `PanelState[]`, not a geometry graph), sane keyboard navigation, a responsive story that actually works, and no z-index management. The cost is less flexibility, which no user has asked for.

### The panel registry

`PANEL_REGISTRY` maps every `PanelKind` to `{ title, icon, Component }`. Eleven panels today: watchlist, chart, blotter, optionChain, orderTicket, depth, sentinel, news, portfolio, learning, research.

> Adding a dockable panel = one row here + one union member in `PanelKind`. Nothing in `WorkspaceDock` or `DockSlot` changes.

Heavy panels (Chart, Option Chain) are `next/dynamic` with `ssr: false` and a skeleton `loading` component — the performance brief's lazy-load requirement, implemented at the registry rather than at each call site.

### Persistence, and the hydration gotcha

`workspaceStore` uses Zustand `persist` → `localStorage`. Its shape is deliberately close to the server-owned `workspace_session` table specified in `WORKSPACE-CONTINUITY.md`, so Phase 10 is a transport change, not a redesign.

> ⚠️ **Gotcha (cost: most of a day).** Zustand `persist` stores need `skipHydration: true` plus a manual `rehydrate()` in `useEffect`, and **no `Math.random()` or `Date.now()` in seed data before rehydration** — otherwise server and client render different trees and React throws a hydration mismatch. This applies to every persisted store you add.

### Command palette (⌘K)

Not a shortcut menu — a **unified global search** with pluggable providers: navigation (reads `NAV_ITEMS`, so new pages are searchable for free), symbols (indices + F&O universe), panels, learning content, theme, and actions. Adding a provider is one module implementing `SearchProvider`.

### Keyboard shortcuts

`lib/shortcuts.ts` is a pure data source; matching lives in `useKeyboardShortcuts`. The comment explaining the binding policy is worth quoting because it prevents a recurring class of bug:

> *Every bound shortcut uses a modifier key, so it's safe to fire globally regardless of focus — a modifier+letter combo doesn't insert text into a focused input. Escape is the one bare-key binding and is safe everywhere. Space is intentionally NOT bound globally — reserved for a possible future "quick preview"; binding it now would break every text input and button on the page.*

| Combo | Action |
|---|---|
| ⌘/Ctrl + K | Command palette |
| ⌘/Ctrl + P | Quick open (alias) |
| ⌘/Ctrl + B | Toggle sidebar |
| ⌘/Ctrl + Shift + F | Focus top-bar search |
| ⌘/Ctrl + / | Shortcuts help |
| Esc | Close palette / notifications / help / mobile menu |
| ↑ ↓ / Enter | Navigate / activate results |
| Double-click a tab | Rename it |
| Drag a panel grip | Move to another zone |

---

## 4.19 Themes 🟢

**Code:** `components/shell/ThemeMenu.tsx` · `packages/ui/src/styles/tokens.css` · inline no-flash script in `app/layout.tsx`

Dark-first (a trading terminal is used in dark rooms for eight hours). Theme is applied by a **blocking inline script before first paint** — a `useEffect` would produce a light flash on every load, which is exactly the kind of one-line defect that makes a product feel cheap.

Tokens are CSS custom properties in `packages/ui`, extracted verbatim from the canonical terminal HTML. Chapter 24.

---

## 4.20 Profile 🟢

`apps/web/src/app/profile/page.tsx` — display name, email, experience level, options familiarity, country, account age, plan badge.

`experienceLevel` and `optionsFamiliarity` exist on `User` because the onboarding flow (FR-AUTH-8, 🔵) is meant to adapt the first-run experience from them. The columns landed ahead of the flow — an example of schema-first sequencing that is fine, and of a field you should not assume is populated.

---

## 4.21 Admin 🔵

**Status:** `apps/admin` is a README-only stub. **However, admin *endpoints* already exist** in `services/api`:

```
POST /entitlements/admin/subscriptions
POST /entitlements/admin/subscriptions/:id/cancel
POST /entitlements/admin/overrides
GET  /entitlements/admin/users/:userId/capabilities
```

These are how entitlements were verified end-to-end during Milestone 4 — a real grant/revert round-trip against the live API. The console is UI over an API that works, which is the right order.

Specified scope: user management, subscription/override administration, audit-log viewer, DLQ retry, KYC review (real-money era), feature-flag control.

---

## 4.22 Research 🟡

**Code:** `apps/web/src/app/research/page.tsx` · `components/terminal/panels/ResearchMiniPanel.tsx` · `packages/ai-core/src/research/`

Two surfaces, one system:

1. **Ambient docked copilot** — the ~420 px right-hand panel available on every page, reopened by the floating gradient button (`FloatingAI.tsx`). Present as an overlay, never a separate route. 🟡
2. **Research workspace** — deep per-symbol analysis with tabs (Overview / Fundamentals / Technicals / Options / News / Risk Factors). 🔵

**Agent roster (8), specified:** AI Researcher (router), Company Analysis, News Analysis, Option Chain Analysis, Technical Analysis, Strategy Builder, Portfolio Insights, Learning Assistant.

> **Where the code actually is.** TradeW AI's real agent/RAG/memory/provider logic lives in **`packages/ai-core`** (~2,300 lines), *not* in `services/tradew-ai` or `agents/tradew-ai`, which remain README-only stubs. This surprises people. Chapter 18.

**Non-negotiable:** every response carries a disclaimer, and the docked chat's disclaimer footer is a **required component**, not optional copy (`DESIGN-SYSTEM.md` §4).

---

## 4.23 Sentinel 🟡

**Code:** `services/sentinel/` (~3,500 lines) · `apps/web/src/app/sentinel/` · `components/sentinel/*` (9 components)

Chapters 6–10. Overview only here.

### The four agents plus one synthesiser

| Agent | Question it answers | Inputs |
|---|---|---|
| **Market & Technical Intelligence** | What is the market structure doing? | candles, indicators, breadth, VIX, OI |
| **Emotion Intelligence** | What is *this user* doing? | trade summaries **passed in by `services/api`** |
| **Trap & Safety Intelligence** | Do these two together look like a trap? | outputs of the above + news |
| **Compliance & Audit** ⚖️ | Is it logged, with evidence and a category? | outputs of all three |
| **Sentinel Orchestrator** | What, if anything, do we say to the user? | all of the above |

**Only the orchestrator produces user-facing copy.** No individual agent talks to the user.

### The composite gate

```ts
if (compositeWeight >= 0.7 && triggered.length >= 2) { surface a synthesis }
```

Two independent signals must corroborate. This is the single most important line in the service, and US-B2 in Chapter 3 exists to protect it.

### The Brain

`services/sentinel/src/brain/` — 11 files, zero stubs:

| Service | Role |
|---|---|
| `pattern-recognition.service.ts` | Every triggered signal becomes durable, queryable knowledge |
| `historical-similarity.service.ts` | "This has happened N times before on this symbol" — frequency, never direction |
| `market-context.service.ts` | Additive narrative; never blocks the response |
| `outcome-learning.service.ts` | Evaluates past observations against what actually happened |
| `research-trigger.service.ts` | Fire-and-forget research on unfamiliar symbols |
| `concept-learning.service.ts` | Builds the entity graph from observations |
| `knowledge-center.service.ts` | Search across the Brain |
| `strategy-intelligence.service.ts` | Aggregate strategy-level knowledge |
| `ontology/*` (5 files) | The concept knowledge graph: 15 domains, 13 relations |

### The workspace UI

Day Classification hero → Market Context panel → Live Safety Feed (expandable "Why" panels) → Contextual Training → session Timeline.

⛔ **Reversed direction, recorded because the reasoning is instructive.** On 2026-07-21 Sentinel was briefly re-specified as a standalone product with no shared navigation, then reversed the same day; it was never executed in code. An earlier chrome-less attempt *was* built and reverted for a concrete reason preserved in `nav-config.tsx`:

> *"...that left no way to navigate back out to the rest of the app, a dead end rather than 'standalone.'"*

`STANDALONE_ROUTES` remains in the codebase as an empty array — the mechanism kept, the usage withdrawn.

---

## 4.24 Knowledge Workspace 🟢

**Code:** `apps/web/src/app/knowledge/` · `services/api/src/knowledge/`

An in-app viewer for the `knowledge/` Obsidian vault: file tree, markdown rendering, full-text search, a Mermaid-rendered graph view, and a recent-activity feed.

**Architecture:** filesystem-backed, **no database**. Server-Sent Events push live updates from a snapshot-diff poller. Dev-gated (`KnowledgeGuard`) and authenticated.

This exists because coding agents and engineers both work in this repository, and giving the engineering memory a browsable surface makes it likelier to be read. It is **never wired into the production runtime** — the vault holds knowledge about *building* TradeW; `knowledge-base/` holds knowledge about *markets*, and only the latter is consumed by Sentinel.

---

## 4.25 What is not in this chapter

| Absent | Where it is |
|---|---|
| `services/trading-engine` (real-money OMS) | Un-migrated. Chapter 5 §5.9. |
| `apps/mobile` | Roadmap Y3. Folder only. |
| `apps/terminal` | Static HTML reference. Not active. |
| `packages/sdk` | Phase 3. Folder only. |
| `packages/shared` | Config loader, logger, error types. Folder only — a genuine gap, since ARCH says every Node service should use it. |
| `workflows/` (n8n exports) | Phase 11. Folder only. |

---

*Next: [Chapter 5 — System Architecture](05-system-architecture.md)*
