# apps/web 🟢

The trader-facing web app — hosts all three product pillars (Core Platform, TradeW AI/Research, Sentinel) as workspaces inside one application, sharing one app shell. See `../../docs/product-architecture/README.md` for why these are separate *systems* on the backend while staying one cohesive *app* here.

**Source mapping (per CONSOLIDATION-PLAN.md §2.1):**
- Base: `TradeW-Setup-main/tradew-prototype/frontend` (Next.js, the copy with the correct `env("DATABASE_URL")` usage and working `api.ts` auto-refresh-on-401 logic).
- Ported in: the top-level copy's `/watchlist` page and its supporting components — once the missing `Watchlist`/`WatchlistItem` Prisma models are added to `packages/database`.

**Workspaces (nav-level sections, per the Emergent mockups — see `docs/design-reference/DESIGN-SYSTEM.md`):**
- **Core Platform**: Home, Trading, Options, Portfolio, Demo Trade, Explorer, Watchlist
- **Research** (TradeW AI's dedicated workspace): company/technical/news deep-dive tabs — see `docs/product-architecture/TRADEW-AI.md`
- **Sentinel**: its own full workspace layout — see `docs/product-architecture/SENTINEL.md`
- Additionally, TradeW AI has an **ambient surface** (docked chat + floating trigger) available as an overlay on top of the Core Platform pages, not a separate route.

**Talks to:** `services/api` only — never directly to `services/trading-engine`, `services/market-data`, `services/tradew-ai`, or `services/sentinel` (see ARCHITECTURE.md §1).

**Depends on:** `packages/ui` (binding design system, see its README), `packages/types`, `packages/sdk`.

**Design reference:** the static prototypes in `docs/design-reference/` (`TradeW-Platform-v0.4.html`) and, more authoritatively, the Emergent mockups behind `docs/design-reference/DESIGN-SYSTEM.md` — the latter should be treated as current/binding where the two disagree, since it's the more recently produced and more structurally detailed reference.

**Status:** populated 2026-07-16 from `TradeW-Setup-main/tradew-prototype/frontend` (copied, original untouched). Watchlist page port still pending its Prisma models. Sentinel/Research workspaces not yet built.
