---
type: pattern
date: 2026-07-18
tags: [pattern, market-data, prisma, migration, market-data-baseline]
status: active
---

# Migration 1 executed — Quote revision, Market Data Baseline established

## What happened
[[2026-07-18 - Market Data domain architecture review]]'s approved Migration 1 (`Quote` revision) was applied in two parts, not one — a mid-execution drift discovery split it:

1. `20260718000000_market_data_quote_revision` — `source` field + `@@unique([instrumentId])`.
2. `20260718000001_market_data_quote_ohlc_fields` — `open/high/low/bid/ask/volume`.

**Why two migrations:** `schema.prisma` had already been edited (during the architecture-review conversation) to declare `open/high/low/bid/ask/volume` on `Quote`, but no migration had ever shipped them — the live DB's `init` migration only ever created the original 6-column `Quote`. A live-database diff (not just a schema-file diff) caught this before the Prisma Client was regenerated, which would otherwise have produced client types for columns that didn't exist in Postgres. **Lesson: when a schema file may have been drafted ahead of migrations, diff against the live DB (`prisma migrate diff --from-url`), not just against the schema file's own prior state — a file-to-file diff can't see drift that already exists between the file and the database.**

## Non-interactive environment gotcha
`prisma migrate dev` refuses to run at all in a non-TTY shell, even with `--create-only`. Workaround: hand-author the migration SQL from a validated `prisma migrate diff --script` output, place it in a correctly-timestamped `prisma/migrations/<ts>_<name>/migration.sql` folder, then apply via `prisma migrate deploy` (designed for CI, fully non-interactive). Once a migration is applied, its checksum is tracked — never hand-edit an already-applied migration file; add a new one instead.

## Result
Full baseline document created: [[../../docs/product-architecture/MARKET-DATA-BASELINE.md]] — final `Quote` schema, current endpoints, confirms zero WebSocket layer exists yet, seeded-instrument inventory, and (most importantly for Migration 2 planning) documents that **two independent, disagreeing simulated-market implementations exist today**: `services/api`'s `SimulatedEngineService` (persisted, Instrument-anchored, backs the public API) and `services/sentinel`'s `SimMarketDataProvider` (ephemeral, not Instrument-anchored, backs Sentinel's internal signals only). This divergence needs an explicit design decision at the start of Migration 2 (`Candle`), not a mid-implementation surprise.

## Known debt carried forward (see baseline doc §7 for full list)
- `seed.ts`'s `seedDemoAccount()` fails on `bcrypt.hash is not a function` — pre-existing `ts-node` ESM/CJS interop bug, confirmed unrelated to this migration via `git diff`, not fixed (out of scope).
- No ESLint configured anywhere in the repo (pre-existing, not a regression).

## Related
- [[2026-07-18 - Market Data domain architecture review]]
- [[../_INDEX.md]]
- docs/product-architecture/MARKET-DATA-BASELINE.md (full baseline, binding reference for Migration 2+)
