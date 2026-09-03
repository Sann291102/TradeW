# services/api 🟢

The NestJS backend — the single public-facing aggregator ("BFF") for every `apps/*` client. No frontend ever calls another service directly; it always goes through here (ARCHITECTURE.md §1).

**Source mapping (per CONSOLIDATION-PLAN.md §2.1):**
- Base: `TradeW-Setup-main/tradew-prototype/backend` — chosen because its schema is consistent with its own migrations, it uses `env("DATABASE_URL")` correctly, and it has the more mature refresh-token/audit-log auth design.
- Ported in: the top-level copy's `watchlists` module, plus the `Watchlist`/`WatchlistItem` Prisma models that need to be written from scratch (the feature was committed but never actually functional in either source copy).
- **Do not** carry over the top-level copy's `prisma/schema.prisma` as-is — it contains the leaked Neon credential flagged in the consolidation plan §0. Rotate that credential before this folder is populated.

**Owns:** instruments, market-data proxying (to `services/market-data`), order orchestration (proxies to `services/trading-engine`), watchlists, user preferences, paper/sim account state.

**Auth today:** the auth module lives here as an in-process module, not a separate deployed service — see ARCHITECTURE.md §2.1 for why, and `services/auth/README.md` for the extraction plan.

**Calls out to:** `services/trading-engine` (internal REST, service token — never a user JWT), `services/market-data`, `services/ai-orchestrator`, `services/notification`, `services/analytics`. See ARCHITECTURE.md §3 for the exact order-flow sequence.

**Depends on:** `packages/database`, `packages/types`, `packages/shared`.

**Status:** populated 2026-07-16 from `TradeW-Setup-main/tradew-prototype/backend` (copied, original untouched). Prisma schema now lives in `packages/database` (this package's `prisma` config points there). Watchlists module port still pending.

**Autonomous paper agents (`src/paper-execution/`).** This service also runs the platform's only order-*placing* agents. Three leader-elected loops — manage (2 s), evaluate (30 s), reconcile (15 s) — call `services/sentinel` for a decision, size it, place it through the **same** `OrderService` a human order ticket uses, then manage it to a stop, a target or a trail and journal the result. **PAPER only, structurally:** `ExecutionEnvironment` has exactly one member and there is no broker order path in this application. Off by default (`PAPER_EXECUTION_ENABLED`), and each profile is armed separately from the audited admin console. See [`docs/product-architecture/AUTONOMOUS-PAPER-AGENTS.md`](../../docs/product-architecture/AUTONOMOUS-PAPER-AGENTS.md).
