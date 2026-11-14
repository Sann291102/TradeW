# Apps + Knowledge Feature Migration Audit

Scope: `apps/admin`, `apps/mobile`, `apps/terminal`, `apps/web`, plus `services/api` for backend cross-check.
Read-only recon — no files modified.

---

## 1. Per-app overview

### `apps/admin` — NOT a real app; design-only stub, unrelated to the shipped Admin Portal

- Contents: **only `README.md`** (1 file total). No `package.json`, no `src/`, no framework.
- `apps/admin/README.md` (full text, 14 lines) explicitly says:
  > "**Status:** design-only. Build after `apps/web` and `services/api` are stood up and the DLQ retry worker exists — an admin UI for a feature that doesn't work yet isn't useful."
- Conclusion: `apps/admin` is a **planning placeholder that was never built**. It is NOT a duplicate of the real Admin Portal — the real Admin Portal was instead built **inside** `apps/web/src/app/admin/` (a Next.js route group), which is a different (and now superseded) plan than what this README describes. `apps/admin` is stale/dead directory content that should probably be deleted or have its README updated to point at the real location, but it contains no code, so there's no functional risk — just a documentation trap for anyone who goes looking for "the admin app" in the obvious place.

### `apps/mobile` — empty placeholder, deliberately unbuilt

- Contents: only `README.md` (1 file).
- README: "Placeholder for the Android/iOS app... **Status: empty on purpose. Do not scaffold a framework here yet.**"
- No framework chosen yet (React Native vs native undecided, explicitly deferred).

### `apps/terminal` — superseded static HTML prototype, not a live app

- Contents: `index.html` + `README.md` (2 files).
- README (self-corrected 2026-07-21): "historical reference only, superseded by `apps/web`... This was originally documented as 'THE TradeW app' — that framing is stale and incorrect."
- Single self-contained HTML/CSS/JS file, run via `python -m http.server`. No build step, no package.json, no framework. Kept only for archival/provenance reasons per repo policy ("archive-don't-delete").
- Its old Sentinel section describes a UI model (AI Reflection Cards, Agent Activity Timeline, etc.) that has since been superseded by the real `/sentinel` workspace in `apps/web`.

### `apps/web` — the real, actively developed frontend (all real feature work lives here)

- `package.json`: `@tradew/web`, Next.js 14.2.20, React 18.3.1, Zustand, framer-motion, lightweight-charts, mermaid, react-markdown. Real `dev`/`build`/`start`/`lint`/`test` (vitest) scripts.
- **349 files** under `apps/web/src` (179 counted narrowly under earlier pass before including all subpaths; full recursive count of `apps/web/src` = 349).
- Top-level route groups under `apps/web/src/app/`: `admin`, `crypto`, `dashboard`, `discipline`, `forex`, `learning`, `login`, `markets`, `news`, `notifications`, `portfolio`, `profile`, `research`, `reset`, `sentinel`, `settings`, `signup`, `strategy-workspace`, `trade`. Component dirs: `charts`, `dashboard`, `discipline`, `markets`, `sentinel`, `shell`, `strategy-workspace`, `terminal`, `trade`, `workspace`.
- README confirms this is the one canonical app: "hosts **every** workspace inside one application, sharing one app shell: Core Platform, TradeW AI/Research, Sentinel and Learning Hub."
- **Confirms the key architectural fact requested**: the "Admin Portal" is a Next.js route group **inside `apps/web`** (`apps/web/src/app/admin/*`), not a separate application. `apps/admin` (the empty top-level dir) is unrelated/unused dead scaffold, not a duplicate implementation.
- `apps/web/.next` build output exists (291MB) — checked for staleness/leaks, see §2 below. It's a current, post-migration build (dashboard/sentinel/strategy-workspace bundles only contain the *comments* about the knowledge move, not a live route — see evidence below).

---

## 2. Knowledge feature leak-check — MIGRATION IS STRUCTURALLY COMPLETE ON THE FRONTEND, BUT THE BACKEND AUTH MODEL DOES NOT MATCH THE DOCUMENTED CLAIM

### 2a. Old route directory — confirmed gone

`find apps/web/src/app/knowledge` → `No such file or directory`. The old page is fully deleted, not just unlinked.

### 2b. Nav / sidebar config — cleanly removed, not just relabeled

`apps/web/src/components/shell/nav-config.tsx` lines 68–72 (comment where the nav item used to sit, between `/learning` and `/sentinel`):
```
// Knowledge was removed from this list on 2026-08-03 and now lives at
// /admin/knowledge. It was never a trader-facing surface: the graph it
// renders is the engineering vault (Decisions, Gotchas, Research notes) that
// the agents write to, and exposing it on the public workspace put internal
// architecture in front of every signed-in user. See apps/web/src/app/admin.
```
There is **no** `{ href: '/knowledge', ... }` entry left in `NAV_ITEMS`/whatever array this file exports — it was deleted, not repointed. Regular users get no nav link to Knowledge at all (not even a disabled/greyed one).

`icons.tsx` still exports `KnowledgeIcon` (line 51) but it's cosmetic — it's reused by `panel-registry.tsx` line 56 for an unrelated `news` panel (`{ title: 'News', icon: KnowledgeIcon, Component: NewsPanel }`), not a leftover Knowledge feature reference.

### 2c. Command palette / search index — cleanly removed

`apps/web/src/lib/search/providers.ts` lines 175–178:
```
// 'knowledge' removed 2026-08-03 — the route moved to /admin/knowledge and
// the public command palette must not advertise a surface its user cannot
// reach. Searching "knowledge" now falls through to the other providers.
stubProvider('tradew-ai', 'TradeW AI', SparkleIcon, ['ai', 'assistant', 'chat', 'ask']),
```
`SEARCH_PROVIDERS` array no longer contains a `knowledge` stub provider — confirmed by reading lines 167–179 directly.

### 2d. Hardcoded links / router pushes / sitemap / breadcrumbs — none found

- `grep -rn "href=.*knowledge" apps/web/src --include="*.tsx"` excluding `/admin/knowledge` → **no matches**.
- `grep -rn "push(.*knowledge" apps/web/src` → **no matches**.
- No sitemap file exists under `apps/web/src` (`find ... -iname "*sitemap*"` → empty).
- No breadcrumb component exists under `apps/web/src` (`grep -rli "breadcrumb"` → empty).
- `apps/web/src/app/admin/README.md` explicitly states the portal is "not linked from the website, not in the sidebar, not in the command palette, not in the sitemap."

### 2e. Old lib import — confirmed moved, not duplicated

`apps/web/src/lib/knowledge.ts` no longer exists. The only knowledge client lib is `apps/web/src/lib/admin/knowledge.ts`, whose own header comment documents the move:
```
// The product API client, not the admin one: `/knowledge/*` is an ordinary
// authenticated route that predates the portal, so it needs the bearer token
// but not the operator token. Moved under lib/admin/ on 2026-08-03 with the
// route itself — it has no remaining caller outside the console.
```
Only `apps/web/src/app/admin/knowledge/page.tsx` imports from it (`import { knowledge, subscribeToChanges, ... } from '@/lib/admin/knowledge'`). No other file in `apps/web/src` imports it — confirmed by the earlier grep pass over the whole tree (only `AdminFrame.tsx`, `admin/knowledge/page.tsx`, `admin/page.tsx` reference "knowledge" among non-Learning/non-Sentinel files, and those are all inside `app/admin/`).

### 2f. AdminGate/AdminFrame/layout — real two-factor gate, but see §2h for the gap

- `apps/web/src/app/admin/layout.tsx`: renders `<AdminFrame>{children}</AdminFrame>` for every route under `/admin/*`, sets `robots: { index: false, follow: false, noarchive: true, nosnippet: true }`.
- `apps/web/src/app/admin/AdminFrame.tsx` (`verify()`, lines 42–63): requires (1) a session token (`getToken()`), (2) an operator token (`getAdminToken()`), and then calls a real backend endpoint (`admin.overview(1)`) to confirm both are valid before setting `access: 'granted'`. If the backend call 401/403s, it clears the local operator token. This is a real, working client-side gate, not a fake one — it fails closed (`access: 'denied'`/`'no-session'` render `<AdminGate>`, not the children).
- `apps/web/src/app/admin/AdminGate.tsx` renders a deliberately uninformative "Restricted console" screen that doesn't distinguish wrong-token vs non-admin vs no-account, by design (per its own comment) to avoid being an oracle.
- **The AdminFrame.tsx doc comment claims:** "every byte of data this portal displays comes from `/admin/*`, and every one of those endpoints independently enforces both factors server-side." **This claim is false for the Knowledge section specifically** — see §2h.

### 2g. Backend: `/admin/*` routes are properly double-gated

`services/api/src/admin/admin.controller.ts`:
```ts
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController { ... }
```
Class-level guard, deliberately placed there per its own comment ("a route added later is protected by default"). `services/api/src/admin/admin.guard.ts` (`AdminGuard.canActivate`) requires, in order: (1) `ADMIN_API_TOKEN` env var configured at all (fails closed if unset), (2) a valid `x-admin-token` header matching it via `timingSafeEqual`, (3) a valid JWT bearer token, (4) the JWT's `sub` user looked up in Postgres with `isAdmin: true` (never trusted from the JWT claim itself). This is real, well-built two-factor auth, and it covers every route on `AdminController` — `overview`, `health`, `api-calls`, `ai/*`, `agents/*`, `stream`, `orders`, `trades`, `users`, `audit`, `users/set-admin`.

**`AdminController` has no `knowledge` route at all** — confirmed by reading the full file (233 lines); there is no `@Get('knowledge...')` handler anywhere in it.

### 2h. THE GAP — the Knowledge data itself is NOT served under `/admin/*` and is NOT gated by `AdminGuard`

The frontend admin Knowledge page (`apps/web/src/app/admin/knowledge/page.tsx`) calls `knowledge.graph()`, `knowledge.recent()`, `subscribeToChanges()` from `apps/web/src/lib/admin/knowledge.ts`, which hit:
```ts
tree: () => api('/knowledge/tree') ...
file: (path) => api(`/knowledge/file?path=...`) ...
recent: (limit=20) => api(`/knowledge/recent?limit=...`) ...
search: (q, limit=50) => api(`/knowledge/search?q=...`) ...
graph: () => api('/knowledge/graph') ...
activity: (since) => api(`/knowledge/activity...`) ...
```
i.e. **`/knowledge/*`, not `/admin/knowledge/*`**. This is a standalone, pre-existing NestJS module: `services/api/src/knowledge/knowledge.controller.ts`:
```ts
@UseGuards(KnowledgeWorkspaceGuard)
@Controller('knowledge')
export class KnowledgeController { ... }
```
`KnowledgeWorkspaceGuard` (`services/api/src/knowledge/knowledge.guard.ts`) is **not** the `AdminGuard** — it does not check a JWT, does not check `isAdmin`, and does not check the operator token at all. It is purely an environment-flag kill switch:
```ts
canActivate(): boolean {
  const flag = process.env.KNOWLEDGE_WORKSPACE_ENABLED;
  const enabled = flag === 'true' || (flag !== 'false' && process.env.NODE_ENV !== 'production');
  if (!enabled) throw new NotFoundException();
  return true;
}
```
The controller's own doc comment admits this is intentional for its original use case but does not account for the fact it is now the backing data source for an "admin-only" UI:
> "Gated solely by KnowledgeWorkspaceGuard — an internal developer tool... It deliberately does NOT require a per-user JWT... If this surface is ever enabled in production, put it behind the ingress/network auth there — do not rely on this controller for user authentication."

**Concretely, in this repo's own `services/api/.env`:**
```
KNOWLEDGE_WORKSPACE_ENABLED=true
```
This hardcodes the flag to `true` unconditionally — it does **not** rely on the "off by default in production" fallback described in the guard's comment (that fallback only applies when the var is *unset*). So in whatever environment uses this `.env` file, `/knowledge/tree`, `/knowledge/file`, `/knowledge/graph`, `/knowledge/search`, `/knowledge/recent`, `/knowledge/activity`, and the `/knowledge/stream` SSE endpoint are reachable by **anyone who can reach the API**, with **no session token, no admin flag, no operator token whatsoever** — a completely anonymous `curl http://api-host/knowledge/graph` would succeed. `services/api/.env.example` line 25 ships the var blank (`KNOWLEDGE_WORKSPACE_ENABLED=`), so a default install would fall back to "on outside production" — meaning any non-production deployment (staging, demo, preview) is open by default too.

**This directly contradicts two documentation claims:**
- `AdminFrame.tsx` comment: "every byte of data this portal displays comes from `/admin/*`... every one of those endpoints independently enforces both factors server-side" — false for Knowledge, which comes from `/knowledge/*` and enforces zero of those factors.
- `apps/web/src/app/admin/README.md` line 49–51: "The client-side gate in `AdminFrame` is a **convenience, not a boundary**. Every `/admin/*` endpoint enforces both factors independently." — same gap; Knowledge isn't an `/admin/*` endpoint at all, and its actual endpoint enforces neither factor.

**Net effect:** the frontend UI for Knowledge is properly hidden from nav/search/routes and wrapped in the operator-token gate like the rest of the admin portal, so a regular logged-in user browsing the web app will never see or reach it through the UI. But the underlying data (the "engineering vault": architecture decisions, gotchas, agent research notes — the exact content the migration's stated goal was to stop exposing) is served by an endpoint that performs no authentication check beyond an environment kill switch that this repo's own `.env` has explicitly turned on. Anyone who knows or guesses the `/knowledge/*` paths (they're not secret — they're literally in the public frontend bundle since `lib/admin/knowledge.ts` ships to the browser) can read the entire vault without logging in, without being an admin, and without an operator token. This is a real, currently-live gap between the stated security model and the implementation, not a leftover UI reference.

### 2i. Backend duplicate-controller check

Only one Knowledge-related controller exists: `services/api/src/knowledge/knowledge.controller.ts` (`@Controller('knowledge')`). No `admin/knowledge` controller, no second/duplicate knowledge controller. `AdminController` has zero knowledge routes (confirmed by full-file read). So there is no backend duplication — just a single backend surface that the frontend migration silently repointed itself around without updating the backend's auth boundary to match the new "admin-only" intent.

### 2j. `.next` build artifacts — clean, matches current source

`apps/web/.next` (291MB) exists. Grepped `server/app/{dashboard,page,sentinel,strategy-workspace}/page.js` for "knowledge" — all four hits are just the **bundled source comments** quoted above (the nav-config.tsx and search/providers.ts comments get bundled verbatim since Next.js doesn't strip comments from these chunks), not a live `/knowledge` route, `href`, or nav entry. `BUILD_ID`/file mtimes are consistent with a fresh build against current source. No stale pre-migration artifact issue.

---

## 3. Other duplicate/parallel-implementation components noticed while scanning (not deeply audited)

- **`apps/web/src/components/terminal/`** (`TerminalWorkspace.tsx` + panels: `WatchlistPanel`, `PortfolioMiniPanel`, `LearningMiniPanel`, `ResearchMiniPanel`, `SentinelPanel`, `OptionChainPanel`, `DepthPanel`, `OrdersPanel`, `NewsPanel`, `ChartPanel`, `BlotterPanel`, plus `chart-tabs/*`) vs. **`apps/terminal/index.html`** (the standalone static prototype). Naming collision, not a functional duplicate — `apps/web`'s "terminal" is a real in-app trading workspace built with the same panels described in the terminal README as the old prototype's Core workspace layout (Home/Markets/Trading/Portfolio/Option Chain/Alerts). Worth flagging only because the shared name ("terminal") could confuse anyone searching the repo — the static prototype is explicitly superseded per its own README, so this isn't two live implementations, but it's easy to grep the wrong one.
- **`apps/web/src/components/dashboard/`** has both `MarketWorkspace.tsx` and a cluster of dashboard widgets (`GlobalMarkets.tsx`, `CommodityMarkets.tsx`, `SectorHeatmap.tsx`, `IndexOverview.tsx`, `TrendingStocks.tsx`, `MarketMovers.tsx`, `WatchlistWidget.tsx`, `PortfolioSummary.tsx`, `SentinelBriefing.tsx`, `MarketNews.tsx`, `EconomicCalendar.tsx`, `RiskAlerts.tsx`, `QuickLinks.tsx`) alongside a separate **`components/markets/`** directory and the terminal panels above (`MarketsTab.tsx`, `TechnicalsTab.tsx`, `DepthTab.tsx` under `terminal/panels/chart-tabs/`). Not confirmed duplicates — plausibly legitimate separate surfaces (dashboard widget vs. full workspace panel vs. terminal tab), but the naming overlap (three different "market" component clusters: `dashboard/GlobalMarkets.tsx`, `components/markets/*`, `terminal/panels/chart-tabs/MarketsTab.tsx`) is exactly the kind of thing worth a follow-up pass if a "duplicate component" audit is done next — I did not open these files to compare implementations, just noticed the naming pattern while listing directories.
- **`apps/admin/README.md`** vs. the real `apps/web/src/app/admin/README.md` — two READMEs both titled around "admin", describing two different (one hypothetical/never-built, one real/shipped) admin surfaces. Anyone onboarding who reads `apps/admin/README.md` first will get a stale/wrong picture (DLQ retry worker, KYC review screen — neither of which the real admin portal implements; the real one is telemetry/orders/AI-spend/users, not KYC/DLQ). Recommend either deleting `apps/admin/` or rewriting its README to point at `apps/web/src/app/admin/`.

---

## Summary of file paths referenced

- `D:\TradeW LLC\TradeW\apps\admin\README.md`
- `D:\TradeW LLC\TradeW\apps\mobile\README.md`
- `D:\TradeW LLC\TradeW\apps\terminal\README.md`, `index.html`
- `D:\TradeW LLC\TradeW\apps\web\README.md`, `package.json`
- `D:\TradeW LLC\TradeW\apps\web\src\components\shell\nav-config.tsx`
- `D:\TradeW LLC\TradeW\apps\web\src\components\shell\icons.tsx`
- `D:\TradeW LLC\TradeW\apps\web\src\components\workspace\panel-registry.tsx`
- `D:\TradeW LLC\TradeW\apps\web\src\lib\search\providers.ts`
- `D:\TradeW LLC\TradeW\apps\web\src\lib\admin\knowledge.ts`
- `D:\TradeW LLC\TradeW\apps\web\src\app\admin\layout.tsx`
- `D:\TradeW LLC\TradeW\apps\web\src\app\admin\AdminFrame.tsx`
- `D:\TradeW LLC\TradeW\apps\web\src\app\admin\AdminGate.tsx`
- `D:\TradeW LLC\TradeW\apps\web\src\app\admin\README.md`
- `D:\TradeW LLC\TradeW\apps\web\src\app\admin\knowledge\page.tsx`, `KnowledgeGraph.tsx`, `Mermaid.tsx`
- `D:\TradeW LLC\TradeW\services\api\src\admin\admin.controller.ts`, `admin.guard.ts`, `admin.module.ts`
- `D:\TradeW LLC\TradeW\services\api\src\knowledge\knowledge.controller.ts`, `knowledge.guard.ts`, `knowledge.module.ts`, `knowledge.service.ts`
- `D:\TradeW LLC\TradeW\services\api\src\app.module.ts`
- `D:\TradeW LLC\TradeW\services\api\.env` (line 25: `KNOWLEDGE_WORKSPACE_ENABLED=true`)
- `D:\TradeW LLC\TradeW\services\api\.env.example` (line 25: blank)
- `D:\TradeW LLC\TradeW\apps\web\.next\` (build output, checked for staleness)
