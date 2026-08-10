# scripts/ ⚪

Repo-wide tooling that doesn't belong inside any single app/service/package.

**Written:**
- `dhan_algo_strategies.py` — reference implementation of Dhan's algo-strategy API surface: the Conditional Trigger rule engine (`/alerts/orders`), the execution primitives (`/orders`, `/super/orders`, `/forever/orders`), the broker-side risk layer (`/killswitch`, `/pnlExit`), candle fetch, and a 14-entry catalog of every strategy Dhan's fixed indicator vocabulary can express. Stdlib only — the pinned `dhanhq` 2.3.0rc1 SDK predates Conditional Triggers (API v2.5) and does not cover them. **Dry-run by default**; placing a real order needs both `dry_run=False` *and* `DHAN_ALLOW_LIVE_ORDERS=1`. Verification/discovery tooling like the rest of this directory — not the trading-engine's code, and per CLAUDE.md Rule 2 never importable by Sentinel or TradeW-AI. Companion note: `knowledge/API/2026-08-11 - Dhan Algo Strategies.md`.

  ```bash
  python scripts/dhan_algo_strategies.py list-strategies
  ```

**Planned (not yet written):**
- `bootstrap` — one-command local dev setup (installs deps across `apps/`, `services/`, `packages/`; copies the root `.env.example` → `.env` and `apps/web/.env.local.example` → `.env.local` — updated 2026-08-04, env config is now consolidated at the repo root, not per service)
- `codegen` — regenerates `packages/sdk` from `services/api`'s OpenAPI spec
- `seed` — database seed script (successor to the audited `tradew-prototype/backend/prisma/seed.ts`)
- `migrate-check` — CI guard that fails if `packages/database`'s schema and migration history drift apart (the exact failure mode found in the audit, where a migration existed for fields the schema didn't have)

**Status:** the four items above are unwritten. Write these as the services they support come online — a seed script for a database that doesn't exist yet has nothing to seed.
