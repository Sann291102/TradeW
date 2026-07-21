# apps/web 🟢

The trader-facing web app — hosts **every** workspace inside one application, sharing one app shell: Core Platform, TradeW AI/Research, Sentinel and Learning Hub. See `../../docs/product-architecture/README.md` for why these are separate *systems* on the backend while remaining one product to the user, and `../../docs/product-architecture/TRADEW-OS.md` §1 for the one-ecosystem principle.

**Source mapping (per CONSOLIDATION-PLAN.md §2.1):**
- Base: `TradeW-Setup-main/tradew-prototype/frontend` (Next.js, the copy with the correct `env("DATABASE_URL")` usage and working `api.ts` auto-refresh-on-401 logic).
- Ported in: the top-level copy's `/watchlist` page and its supporting components — once the missing `Watchlist`/`WatchlistItem` Prisma models are added to `packages/database`.

**Workspaces (nav-level sections, per the Emergent mockups — see `docs/design-reference/DESIGN-SYSTEM.md`):**
- **Core Platform**: Home, Trading, Options, Portfolio, Demo Trade, Explorer, Watchlist
- **Research** (TradeW AI's dedicated workspace): company/technical/news deep-dive tabs — see `docs/product-architecture/TRADEW-AI.md`
- Additionally, TradeW AI has an **ambient surface** (docked chat + floating trigger) available as an overlay on top of the Core Platform pages, not a separate route.

**Sentinel is a workspace here** — the flagship premium intelligence workspace, at `/sentinel`, inside the shared shell like every other route. Its content differs substantially from the trading workspaces; its chrome, design language, auth and entitlements do not. Core Platform's `/trade` dock keeps a locked `SentinelPanel` teaser cross-selling into it. See `docs/product-architecture/SENTINEL.md` §5.

**Talks to:** `services/api` only — never directly to `services/trading-engine`, `services/market-data`, `services/tradew-ai`, or `services/sentinel` (see ARCHITECTURE.md §1).

**Depends on:** `packages/ui` (binding design system, see its README), `packages/types`, `packages/sdk`.

**Design reference:** the static prototypes in `docs/design-reference/` (`TradeW-Platform-v0.4.html`) and, more authoritatively, the Emergent mockups behind `docs/design-reference/DESIGN-SYSTEM.md` — the latter should be treated as current/binding where the two disagree, since it's the more recently produced and more structurally detailed reference.

**Status:** populated 2026-07-16 from `TradeW-Setup-main/tradew-prototype/frontend` (copied, original untouched). Watchlist page port still pending its Prisma models. Research workspace not yet built. Sentinel has a real, built `/sentinel` workspace as of 2026-07-21, rendering inside the shared shell. *(A 2026-07-21 direction change briefly called for removing that shell; it was reversed the same day and no removal work is pending — see `docs/product-architecture/SENTINEL.md` §5.)*
