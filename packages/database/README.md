# packages/database 🟢

The single, corrected Prisma schema — one schema, one migration history, replacing the three inconsistent copies found in the audit.

**How it's built (per CONSOLIDATION-PLAN.md §2.1):**
- Base: `TradeW-Setup-main/tradew-prototype/backend/prisma/schema.prisma` (matches its own migrations, uses `env("DATABASE_URL")` correctly).
- Add: `Watchlist`/`WatchlistItem` models, which never actually existed in either source copy despite a working controller/service calling them — these need to be written fresh, not copied.
- **Explicitly excluded:** the top-level copy's `schema.prisma`, which contains a live leaked Neon credential (rotate it — see CONSOLIDATION-PLAN.md §0 — regardless of this migration).

**Table ownership boundary (ARCHITECTURE.md §5):** this package is consumed by `services/api` (and `services/auth` once extracted) only. `services/trading-engine` (Python/SQLite today, Postgres later) owns its own tables directly via its own client — never through this Prisma schema, even once both land in the same Postgres instance. Two schema domains, one database, no shared ORM across languages.

**Status:** populated 2026-07-16 — schema + both migrations copied from `TradeW-Setup-main/tradew-prototype/backend/prisma` (original untouched). `Watchlist`/`WatchlistItem` models still to be written. Sentinel/entitlement models come in later phases.
