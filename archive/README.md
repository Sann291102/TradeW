# archive/ ⚪

Superseded code, retained for provenance — never deleted, per the original project instruction to preserve functionality and never lose history without a trace.

**What lands here, per CONSOLIDATION-PLAN.md §2:**
- `tradew-prototype-legacy/` — the top-level `tradew-prototype` copy, once its unique watchlists feature has been ported into `services/api`/`apps/web` and its Prisma models rebuilt properly. (Rotate its leaked Neon credential first, regardless of archiving — CONSOLIDATION-PLAN.md §0.)
- `tradew-prototype-sprint0.zip` — kept zipped, for provenance only; confirmed a strict subset of the other two copies with no unique code.
- `extreme_algo_bot_v1.py`, `extreme_algo_live.py`, `extreme_algo_paper.py` — superseded/redundant relative to the `services/trading-engine` keep set.
- `pine_scripts_pre_v3.1/` — pine script iterations v1/v2/v3, superseded by `v3.1_orb_final.pine`.
- `tradew-site/` — a byte-identical duplicate deployment copy of `TradeW-Platform-v0.4.html`, not a distinct marketing site (see CONSOLIDATION-PLAN.md §1.3).

**Status (updated 2026-07-21):** not empty — two files have landed here ahead of the formal consolidation-plan execution above, added informally during Phase 1 frontend work: `web-terminal-workspace-static-grid.tsx.txt` and `web-trade-sprint0-page.tsx.txt` (both superseded frontend snapshots from the M2 terminal-conversion milestone, see [[../knowledge/Patterns/2026-07-18 - M2 terminal conversion (shell, widgets, terminal slots)]]). The five items listed above from CONSOLIDATION-PLAN.md §2 (the `tradew-prototype-legacy`, `extreme_algo_*`, pine scripts, `tradew-site` migration) still have not been executed — that part of this note remains accurate. Only the "empty" claim was stale.

**Added 2026-07-26 — Sentinel Master Plan integration:** `sentinel-timer-metrics.service.ts.txt` — a `TimerService` recording per-call execution durations, written during a first pass at the Master Plan modules and never registered in `AppModule` or called by anything. Superseded before it shipped: the Market Timeline Engine (`services/sentinel/src/timeline/timeline.engine.ts`) already timestamps every observation with an IST label, so a parallel timing store would have been a second, unreferenced source of truth for "when did this happen". Kept here rather than deleted per CLAUDE.md Rule 1; if per-call latency metrics are wanted later they belong in a Nest interceptor, not a hand-rolled service.

**Added 2026-07-23 — Order Ticket replaced by a working Orders panel:** `web-order-ticket-panel-preview-only.tsx.txt` — the original `apps/web/src/components/terminal/panels/OrderTicketPanel.tsx`, a visual-only form whose submit button was permanently `disabled` ("Preview — no order is placed") with a hardcoded quantity of 75 and MIS/NRML + Market/Limit/Stop-loss selects that were never read. Superseded by `OrdersPanel.tsx`, which places real paper orders against the Phase 1 OMS (`/sim/orders`), resolves lot size per instrument from Dhan's scrip master, and offers Intraday/Delivery + Market/Limit only. The `orderTicket` PanelKind is unchanged so saved workspace layouts keep working — only its title and component changed (see `panel-registry.tsx`).

**Added 2026-07-21 — Sentinel homepage redesign:** `web-sentinel-alert-callout.tsx.txt`, `web-sentinel-reflection-cards.tsx.txt`, `web-sentinel-agent-timeline.tsx.txt`, `web-sentinel-observation-feed.tsx.txt`, `web-sentinel-session-summary.tsx.txt` — the original `/sentinel` page composition (AI Reflection Cards / Agent Activity Timeline / Observation Feed / Session Summary), superseded per a product-direction change: Sentinel's UI exposed its internal multi-agent architecture instead of a single readable conclusion. Replaced by `apps/web/src/components/sentinel/{DayClassificationCard,MarketContextPanel,LiveSafetyFeed,SafetyCard,ContextualTraining,SentinelTimeline}.tsx`. `docs/product-architecture/SENTINEL.md` still describes the archived layout as of this date and needs a rewrite once the new direction is validated — see the "For future Claude" note at the top of the new `/sentinel/page.tsx`.

**Added 2026-07-21 (same day) — standalone shell reverted:** `web-sentinel-standalone-shell.tsx.txt` — a first pass at the redesign above also stripped the shared Sidebar/TopBar from `/sentinel` entirely (no nav, custom branded header). Reverted within the same session: it left no way to navigate back out to the rest of the app, a dead end rather than "standalone." `/sentinel` now renders inside the normal shared shell like every other route (see `nav-config.tsx`'s `STANDALONE_ROUTES`, now empty) — only the page's own content (Day Classification / Market Context / Live Safety Feed) is new, the surrounding chrome is unchanged.

**Added 2026-07-22 — Paper Trading OMS Phase 1:** `api-sim-service-market-order-only.service.ts.txt` — the original `services/api/src/sim/sim.service.ts`, superseded by a full order-management engine (`OrderService`/`MarketPriceService`/`MatchingEngineService`/`PositionService`/`PortfolioService` in the same `sim/` module). The old version only placed instantly-filled MARKET orders priced from Postgres's `Quote` table (written by a *simulated* ingestor, disconnected from the real live Dhan prices shown everywhere else in the app); the new engine adds LIMIT/SL/SL_M order types, a real order lifecycle, and prices every fill from the same live Dhan bridge the dashboard/charts/option chain already use. `positions()`'s logic is preserved and expanded in `PositionService`.

**Added 2026-07-21 (same day) — Knowledge page simplified to graph-only:** `web-knowledge-file-tree.tsx.txt`, `web-knowledge-markdown-view.tsx.txt`, `web-knowledge-activity-panel.tsx.txt` — the `/knowledge` dev-tool page's file-tree/markdown-viewer/search/activity-feed layout, superseded per direct product feedback: the page should show only the vault's note-link graph (`KnowledgeGraph.tsx`, unchanged), full-page, not a file browser. `apps/web/src/app/knowledge/page.tsx` is now a thin page rendering just the graph plus a minimal header (no Terminal/Sentinel nav links). `lib/knowledge.ts`'s `tree()`/`recent()`/`file()`/`search()` client functions are now unused (only `graph()` and `subscribeToChanges()` are still called) — left in place, not removed, since the file-browser view could be reinstated as a separate route later if needed.

**Added 2026-08-04 — monorepo consolidation audit (repository-wide cleanup pass):**
- `apps-admin-stub-superseded/README.md` — the top-level `apps/admin` app
  directory. It was never built beyond its own README, and that README
  described a different feature (a DLQ retry worker + KYC review console)
  than what the platform actually shipped. The real Admin Portal was built
  inside `apps/web/src/app/admin/*` (a section of the existing Next.js app,
  not a separate deployable), first appearing 2026-08-03. Kept as a directory
  rather than a flat `.txt` since it's a whole (tiny) app scaffold, not a
  single superseded component. `apps/admin/` itself is left in the tree as an
  empty directory — this environment's filesystem could rename files but not
  remove the now-empty directory; safe to `rmdir apps/admin apps/terminal`
  by hand.
- `apps-terminal-legacy-prototype/{index.html,README.md}` — the top-level
  `apps/terminal` app: a static, single-file HTML prototype whose own README
  already said it was superseded by the terminal experience built inside
  `apps/web/src/components/terminal/`. Archived rather than left in place
  since nothing in the workspace scripts, CI, or Docker config referenced it.
- `root-docs/TRADEW_DEVELOPER_REFERENCE.md` — a 99KB repository reference
  document that near-duplicates `REPOSITORY_INVENTORY.md` (154KB, newer,
  actively cross-referenced elsewhere). Kept for provenance; the inventory is
  the one to treat as current.
- `root-docs/PROJECT_TEST_AUDIT.md`, `root-docs/SENTINEL_BRAIN_PROGRESS.md` —
  point-in-time audit/progress snapshots superseded by the living
  `docs/APPLICATION-STATUS.md`.
- `root-docs/implementation_plan.md` — not a TradeW planning doc at all: a
  stray artifact left behind by an external IDE session (Gemini Antigravity),
  with output file paths pointing at a different machine entirely. Archived
  rather than deleted per this file's own rule, but it never described this
  repository's plan.
- `root-docs/docs.zip` — a 523KB snapshot of the live `docs/` directory from
  2026-07-27. Diffed against current `docs/`: no unique content, missing only
  files added after that date. Stale duplicate.

**Correction, 2026-08-04 (same day, during branch-merge consolidation):** the
`apps-admin-stub-superseded` entry above is wrong. It was written without
visibility into the `ai-reasoning` branch, which — also on 2026-08-04 — built
a real, working Admin Portal ("operator console skeleton, auth verified
live") as its own standalone Next.js app at top-level `apps/admin/`, distinct
from `apps/web/src/app/admin/*`. When merging `ai-reasoning` and
`chore/monorepo-consolidation` together, the archived stub content was
discarded and the real `apps/admin/` app was restored from `ai-reasoning` —
the `apps-admin-stub-superseded/` directory itself has been removed from the
tree (not left archived, since it held only the placeholder README, no code).

**Added 2026-08-04 (same merge) — Learning course-platform superseded by the catalog-based Learning Hub:**
`apps-web-learning-course-platform-superseded/` — an older Learning Hub
design (`app/learning/[courseId]/`, `app/learning/[courseId]/[conceptId]/`,
the top-level `app/learning/LearningClient.tsx`, and `lib/learning/api.ts`)
built around a `Course`/`Lesson`/`Flashcard`/`Quiz` model fetched from a
learning-platform API. Superseded by the newer, simpler catalog-based design
(`lib/learning/catalog.ts` + `lib/learning/types.ts`'s `Strategy`/`Lesson`
shapes, routed at `app/learning/[id]/`) introduced in commit `d1c3031`
("teach structure, never instruct; make lessons readable"), which reads
authored markdown from `docs/learning/` directly instead of a platform API.
The two could not coexist regardless of preference: Next.js's app router
does not allow two different dynamic-segment names (`[courseId]` vs `[id]`)
at the same path depth, so keeping both would have failed the build. Nothing
outside this island referenced `LearningClient.tsx` or `lib/learning/api.ts`,
confirmed via a repo-wide grep before archiving.
- **Not archived, left in place on purpose:** `services/analytics`,
  `services/auth`, `services/notification`, `services/tradew-ai`,
  `services/trading-engine`, `packages/shared`, `packages/sdk` — each is a
  documented, intentional placeholder for future work (own README says so
  explicitly), not an accidental duplicate or abandoned attempt, so this pass
  left them where they are rather than archiving them.
- **Not archived — left in the working tree, deliberately untracked:**
  `services/api/.env.bak`. It's a backup of a file containing live secrets
  (Dhan tokens, JWT secret) and is covered by `.gitignore`'s `*.env.bak` rule
  specifically because such backups must never enter git history. Moving it
  into this tracked directory would commit those secrets permanently, which
  outweighs the tidiness gain. Recommend deleting it by hand outside of git.

**Added 2026-07-26 — TradeW AI dock became a working command surface:** `web-floating-ai-visual-scaffold.tsx.txt` — the original `apps/web/src/components/shell/FloatingAI.tsx`, a visual-only dock whose own comment read "Milestone 2 delivers the VISUAL surface only… No AI/routing logic yet (that's a later milestone) — this is the slot": a static greeting bubble, an "Interface preview — responses arrive in a later milestone" notice, four decorative quick chips with no `onClick`, and an uncontrolled input whose Send button did nothing. Superseded by Phase 1 of the assistant control layer, which makes the dock resolve what the user types and actually drive the application (routes, option-contract deep links, panel visibility, layout presets, theme) with a visible trace of what it did. All of the scaffold's layout, classnames and framer-motion animation were carried over unchanged — only the inert body was replaced with a live transcript and a working input. Resolution logic lives in `apps/web/src/lib/assistant/` (pure, no LLM call); execution in `lib/assistant/useAssistant.ts`. See [[../knowledge/Patterns/2026-07-26 - TradeW AI assistant control layer (Comet-style app control)]].
