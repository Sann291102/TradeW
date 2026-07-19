---
type: pattern
date: 2026-07-18
tags: [pattern, frontend, phase-1, milestone-3, apps-web, zustand]
status: active
---

# Pattern: Milestone 3 — dockable workspace, command palette, theme engine, notifications

## For future Claude
Phase 1 Milestone 3 turned the M2 static terminal grid into a real dockable workspace with persisted state. Read before touching apps/web/src/lib/store/workspaceStore.ts, components/workspace/*, or anything reading/writing workspace state. Full architecture doc: docs/product-architecture/WORKSPACE-SHELL.md — this note is the "gotchas + why" companion, not a duplicate of it.

## The one new dependency
`zustand` (+ its `persist` middleware) — added specifically to implement WORKSPACE-CONTINUITY.md client-side (localStorage) since backend integration was out of scope for M3. One store: `apps/web/src/lib/store/workspaceStore.ts`. Don't add a second state library or a second store — extend this one.

## Hydration-safety pattern (important, easy to get wrong)
The store uses `persist(..., { skipHydration: true })` and is manually rehydrated via `useWorkspaceStore.persist.rehydrate()` inside a `useEffect` (`lib/store/useHydrated.ts`, mounted once in AppFrame). **Do not** let zustand auto-rehydrate from localStorage during store creation (the default behavior without `skipHydration`) — that module runs once during SSR (no `window`, no-op) and once during the client's first render (localStorage IS available), so the client's very first render would differ from the server-rendered HTML → React hydration-mismatch warning. Also: the store's default/seed data must be **fully deterministic** — no `Math.random()`, no `Date.now()` in any code path that runs before rehydration (the initial default workspace tab uses a fixed id `'tab-1'` for exactly this reason; `newTab()` only uses `Math.random()` for tabs created later by a user click, which is client-only and safe).

## Theme no-flash pattern
Inline `<script>` in `apps/web/src/app/layout.tsx` `<head>` reads `localStorage['tradew-workspace-v1']` and sets `data-theme` on `<html>` before paint, before React hydrates. `<html suppressHydrationWarning>` is REQUIRED alongside this — without it, React warns because the DOM attribute (set by the script) doesn't match what React's own SSR render produced. This is the standard next-themes-style technique; don't try to "fix" the warning any other way.

## Panel dock architecture — deliberate scope boundary
Dock = 5 named zones (left/main/auxA/auxB/right), NOT free floating windows. Panels move between zones via HTML5 native drag-and-drop scoped to a small grip handle (`DockControls`) — NOT the whole panel card (dragging the whole card would fight normal clicks/text-selection inside it). Reordering within a zone uses explicit ▲▼ buttons, not drag-only, specifically so it's keyboard-operable. Multi-monitor pop-out is a `detachable` flag + disabled button only — no window-detach implementation, matching the brief's own "architecture only" scoping for that item. Don't build real multi-window docking unless explicitly asked; it's a materially bigger engineering scope than this milestone.

## Command Palette = Global Search (unified, not two features)
Ctrl/⌘+K opens one overlay with a modular provider registry (`lib/search/providers.ts`, `SearchProvider[]`). Real providers: navigation, stocks (mock data), learning, commands. Five STUB providers (Portfolio/Research/Sentinel/Knowledge/TradeW AI) each show one disabled "coming soon" row, only when the query matches that domain's keywords — this is the actual fulfillment of "prepare modular providers, backend search later," not a placeholder to remove. When wiring real backend search for one of these domains, replace that provider's `search()` body only.

## Gotcha: browser automation coordinate/keyboard desync (not an app bug)
During verification, the browser tool's `computer` action with a `ref` sometimes resolved to a STALE screen coordinate after a re-render/animation settled, causing a click to land on the wrong element (once navigated to /dashboard instead of toggling a panel). Also, simulated `key: "Return"` presses did not reliably reach React's synthetic event system in this environment, even though `Ctrl+K` worked fine. **Verification workaround**: use `javascript_tool` to call `.click()` directly on a `querySelector`-found DOM node, or invoke `element[reactPropsKey].onClick(...)` directly — this exercises the real React handler without depending on the automation harness's coordinate/key-event fidelity. Also remember React 18 batches state updates: a synchronous DOM read immediately after triggering a state change will show STALE values — always re-check after a tick (or just take a screenshot, which is inherently post-paint) before concluding something didn't work.

## State ownership migration (M2 → M3)
M2's AppFrame held `collapsed`/`mobileOpen`/`aiOpen` as local `useState`. M3 moved ALL of it into the store (`sidebarCollapsed`, `mobileNavOpen`, `aiDockOpen`, plus the new overlay booleans) because (a) sidebar-collapsed state is a documented Workspace Continuity requirement, and (b) centralizing overlay state is what lets one `closeAllOverlays()` Escape handler close whichever overlay is open, from anywhere. Sidebar/TopBar/FloatingAI now read the store directly instead of taking props from AppFrame — if you're adding a new shell-level overlay, follow this pattern (store-owned boolean + a component that self-gates via `AnimatePresence`), don't reintroduce prop-drilled local state.

## Verified
Build (17 routes), typecheck, lint all clean throughout (checked incrementally after every major addition, not just once at the end — catches errors while the diff causing them is still small). Full browser pass: resize/collapse/pin/close/restore, cross-zone drag, 6 layout presets, 2 independently-stateful workspace tabs (verified both switch directions), command palette search + result activation, shortcuts help, notification center, theme switch + persistence across a hard reload with no flash, mobile stacking — zero console errors throughout.

## Related
- [[../_INDEX.md]]
- [[2026-07-18 - M2 terminal conversion (shell, widgets, terminal slots)]]
- [[2026-07-18 - packages-ui foundation (tokens, preset, transpilePackages)]]
- docs/product-architecture/WORKSPACE-SHELL.md (full architecture), WORKSPACE-CONTINUITY.md §7 (status)
