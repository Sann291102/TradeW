---
type: pattern
date: 2026-07-18
tags: [pattern, frontend, phase-1, milestone-2, apps-web]
status: active
---

# Pattern: Milestone 2 — HTML terminal → React (shell, dashboard, terminal slots)

## For future Claude
Phase 1 Milestone 2 converted the canonical HTML terminal (apps/terminal/index.html) into production React in apps/web. Read before adding pages/components or wiring backend data. Extends [[2026-07-18 - packages-ui foundation (tokens, preset, transpilePackages)]].

## Layout reconciliation (important)
The canonical HTML uses a horizontal top-nav for page navigation + a left watchlist panel. DESIGN-SYSTEM.md §3 and the M2 build order (Step 2) both specify a **left icon-rail nav sidebar** + top status bar. Resolved in favor of the sidebar layout (two binding sources agree; "don't change navigation" = preserve the page set/workflow, not the horizontal nav specifically). Nav destinations preserved; presentation follows the design system.

## Shell without moving existing pages (Rule 1)
Existing pages (trade, sentinel [300 lines, backend-wired], knowledge [50kB], profile, login, signup) were NOT moved or rewritten. The shell is applied via a **path-aware `AppFrame`** wrapped around `{children}` in the root `layout.tsx`: `isBareRoute(pathname)` → render bare (/, /login, /signup); else render Sidebar + TopBar + Ticker + content. This gave every workspace page the chrome with zero file moves/deletions. Verified: the pre-existing Sentinel page renders correctly inside the shell unchanged.

## Component boundary
- `packages/ui` = presentational primitives (StatCard, Panel, Sparkline, Skeleton, EmptyState, IconButton + M1's Button/Card/Badge). Framework-agnostic.
- `apps/web/src/components/shell/` = routing-coupled chrome (AppFrame, Sidebar, TopBar, Ticker, FloatingAI, nav-config, icons). Consumes packages/ui. Kept in-app per ARCHITECTURE.md §6 (don't pre-extract UI still changing weekly); extract to packages/ui when a 2nd app needs it.
- `apps/web/src/components/dashboard/` = independent dashboard widgets (Step 5).
- `apps/web/src/components/terminal/` = TerminalWorkspace + panels/ (Step 6 slots).

## Key conventions established
- **Nav is config-driven**: `shell/nav-config.tsx` `NAV_ITEMS[]`. Add a workspace = add a row. Never hardcode nav in the Sidebar.
- **Mock data**: `apps/web/src/lib/mock/market.ts` mirrors canonical HTML values; component shapes are what the live services/market-data feed will fill (swap mock→live is a data change, not a component change). Sparkline seeds are deterministic (no Math.random — SSR-safe).
- **Lazy loading**: heavy terminal panels (ChartPanel, OptionChainPanel) use `next/dynamic({ssr:false, loading: <Panel loading/>})` per the performance brief.
- **Motion**: framer-motion via shared variants; `useReducedMotion()` in components + CSS token layer zeroes durations under prefers-reduced-motion. Ticker marquee = CSS `tw-ticker` keyframes in globals.css (disabled under reduced-motion; component also renders a static strip).
- **a11y**: IconButton requires aria-label (type-enforced); tabs use role=tablist/tab/aria-selected; nav uses aria-current; focus-visible rings everywhere.

## Trade page decision
The Sprint-0 backend-wired order form at /trade was **archived** to `archive/web-trade-sprint0-page.tsx.txt` (Rule 1, preserved not deleted) and /trade became the terminal-slot workspace (TerminalWorkspace). The archived file's api calls (/instruments/search, /market-data/quote/:id, /sim/orders, /sim/positions) are the contract to re-wire the Order Ticket + Blotter slots in a later milestone.

## Gotchas fixed
- `Card`/`Panel` props extending `HTMLAttributes` must `Omit<..., 'title'>` because native `title` is string-only but we want ReactNode. (Hit twice.)
- `Sparkline` uses `useId` → must be `'use client'` so server components can render it.
- Panel needed a `subtitle` prop added (Card had it, Panel didn't).
- Terminal fills viewport height via `lg:h-full lg:grid-rows-[minmax(0,1fr)]` on the grid; columns get `min-h-0`, right column `overflow-y-auto`. Verified computed heights: shell root/sidebar/body all = viewport (900px). (Screenshots show dark letterbox below the page due to DPR 1.25 capture area — not a layout bug; confirmed via getBoundingClientRect.)

## Verification (all green)
Build 16 routes ✓, tsc (web via build + @tradew/ui) ✓, next lint ✓ (only 2 pre-existing exhaustive-deps warnings in profile/trade-archived — untouched). Browser: dashboard, trade terminal, markets, portfolio, learning, sentinel all render; AI dock + sidebar collapse animate; zero console errors.

## Related
- [[../_INDEX.md]]
- [[2026-07-18 - packages-ui foundation (tokens, preset, transpilePackages)]]
- DESIGN-SYSTEM.md, TRADEW-OS.md §8–9
