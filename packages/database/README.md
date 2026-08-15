# packages/database 🟢

The single, corrected Prisma schema — one schema, one migration history, replacing the three inconsistent copies found in the audit.

**How it's built (per CONSOLIDATION-PLAN.md §2.1):**
- Base: `TradeW-Setup-main/tradew-prototype/backend/prisma/schema.prisma` (matches its own migrations, uses `env("DATABASE_URL")` correctly).
- Add: `Watchlist`/`WatchlistItem` models, which never actually existed in either source copy despite a working controller/service calling them — these need to be written fresh, not copied.
- **Explicitly excluded:** the top-level copy's `schema.prisma`, which contains a live leaked Neon credential (rotate it — see CONSOLIDATION-PLAN.md §0 — regardless of this migration).

**Table ownership boundary (ARCHITECTURE.md §5):** this package is consumed by `services/api` (Prisma, and `services/auth` once extracted). Two exceptions read/write the same Postgres **without** Prisma: `services/sentinel-py` (Python) reaches its own `UserStrategy`/`WatchSession`/`WatchObservation` tables directly via `asyncpg`, and `services/trading-engine` (Python) will own its own tables via its own client. Two+ schema domains, one database, no shared ORM across languages.

**Status:** 🟢 grown well beyond the original seed — **53 models across 28 migrations** now, spanning trading/OMS, market data, subscriptions & entitlements, notifications, broker OAuth, OTP, the AI memory/graph and Sentinel concept-ontology models, the four-layer **cognition** network (`Percept`/`PerceptorState`/`CognitiveEpisode`/`CognitiveProposal`/`NeuralSynapse`), operator/admin (`OperatorAccount`), and the sentinel-py strategy-watch tables (`UserStrategy`/`WatchSession`/`WatchObservation`). Scripts: `db:generate`, `db:migrate`, `seed`, plus `admin:grant` / `operator:create`. **Still not written:** a general `Watchlist`/`WatchlistItem` model (the strategy-watch tables are a different concept).
