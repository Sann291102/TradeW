# packages/ui 🟢

Shared design-system components. **No longer speculative** — the design system is now extracted and documented at `../../docs/design-reference/DESIGN-SYSTEM.md` from real, already-built Emergent AI mockups, which are treated as the design system, not inspiration. Build this package to match that document, not a fresh interpretation of it.

**Covers:** the shared app chrome (top bar, index ticker strip, icon sidebar, Paper/Live toggle, notification bell, avatar) plus the component inventory in DESIGN-SYSTEM.md §4 (stat cards, sparkline rows, data tables, tab bars, donut charts, sentiment/category pills, chat message bubbles, disclaimer footers, reflection cards, activity timelines, chart toolbars, the payoff visualizer).

**Why this exists as one shared package:** Core Platform, TradeW AI (Research), and Sentinel are three workspaces inside one `apps/web`, not three products — sharing this package is what keeps them feeling cohesive while each workspace still gets its own specialized components (e.g. Sentinel's Reflection Cards live here too, just not reused elsewhere).

**Consumed by:** `apps/web`, `apps/admin`, and later `apps/mobile`'s shared (non-native) views if any.

**Before building:** confirm exact color hex values and font family from the live deployed mockup if still reachable (DESIGN-SYSTEM.md §6) rather than estimating from screenshots.

## Status: foundation built (Phase 1, Milestone 1 — 2026-07-18)

Scaffolded and consumed live by `apps/web`. What exists now:

- `src/styles/tokens.css` — the color/shadow/focus/motion tokens, extracted **verbatim** from the canonical terminal (`apps/terminal/index.html`). Light set on `:root`, dark override on `[data-theme="dark"]`; apps apply dark by default (dark-first) while keeping both toggleable.
- `src/tailwind-preset.ts` — maps those CSS vars to Tailwind theme keys (`bg-card`, `text-muted`, `text-teal`, `text-up`/`text-down` for market direction, `rounded-card`, `duration-micro/panel/route`). Apps add it via `presets: [tradewPreset]`.
- `src/motion/variants.ts` — shared Framer Motion tokens + variants (fade, fadeInUp, panelSlide, sidebarSlide, modalPop, stagger) on the BLUEPRINT §3 duration budget.
- `src/components/` — primitives: `Button` (+ `buttonClasses` recipe so `<Link>` can be styled as a button without duplicating classes), `Card`, `Badge`/pill, `StatCard`, `Panel` (terminal slot with loading/empty states), `Sparkline` (axis-less SVG trend), `Skeleton`, `EmptyState`, `IconButton` (required `aria-label`).

**Consumption model:** no separate build step — `apps/web` lists `@tradew/ui` in `transpilePackages` (next.config.mjs) and imports from TS source directly. Token CSS is imported once in `apps/web/src/app/layout.tsx` before `globals.css`.

## App chrome lives in the app, not here (yet)

Per ARCHITECTURE.md §6 ("don't pre-extract UI that's still changing weekly"), the routing-coupled app chrome — Sidebar, TopBar, Ticker, AppFrame, FloatingAI — lives in `apps/web/src/components/shell/` (Milestone 2), consuming these primitives. Extract it here once it stabilizes / a second app (admin) needs it. The presentational primitives above ARE here because they're framework-agnostic and reused across pages.

**Still to build (later Phase-1 milestones):** more DESIGN-SYSTEM.md §4 inventory (dense data tables, donut chart, chat bubbles as a component, reflection cards, payoff visualizer) and, when stable, extraction of the app chrome.
