# scripts/ ⚪

Repo-wide tooling that doesn't belong inside any single app/service/package.

**Planned (not yet written):**
- `bootstrap` — one-command local dev setup (installs deps across `apps/`, `services/`, `packages/`; copies the root `.env.example` → `.env` and `apps/web/.env.local.example` → `.env.local` — updated 2026-08-04, env config is now consolidated at the repo root, not per service)
- `codegen` — regenerates `packages/sdk` from `services/api`'s OpenAPI spec
- `seed` — database seed script (successor to the audited `tradew-prototype/backend/prisma/seed.ts`)
- `migrate-check` — CI guard that fails if `packages/database`'s schema and migration history drift apart (the exact failure mode found in the audit, where a migration existed for fields the schema didn't have)

**Status:** empty. Write these as the services they support come online — a seed script for a database that doesn't exist yet has nothing to seed.
