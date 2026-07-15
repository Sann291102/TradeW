# packages/ui 🟡

Shared design-system components. **No longer speculative** — the design system is now extracted and documented at `../../docs/design-reference/DESIGN-SYSTEM.md` from real, already-built Emergent AI mockups, which are treated as the design system, not inspiration. Build this package to match that document, not a fresh interpretation of it.

**Covers:** the shared app chrome (top bar, index ticker strip, icon sidebar, Paper/Live toggle, notification bell, avatar) plus the component inventory in DESIGN-SYSTEM.md §4 (stat cards, sparkline rows, data tables, tab bars, donut charts, sentiment/category pills, chat message bubbles, disclaimer footers, reflection cards, activity timelines, chart toolbars, the payoff visualizer).

**Why this exists as one shared package:** Core Platform, TradeW AI (Research), and Sentinel are three workspaces inside one `apps/web`, not three products — sharing this package is what keeps them feeling cohesive while each workspace still gets its own specialized components (e.g. Sentinel's Reflection Cards live here too, just not reused elsewhere).

**Consumed by:** `apps/web`, `apps/admin`, and later `apps/mobile`'s shared (non-native) views if any.

**Before building:** confirm exact color hex values and font family from the live deployed mockup if still reachable (DESIGN-SYSTEM.md §6) rather than estimating from screenshots.

**Status:** not yet built.
