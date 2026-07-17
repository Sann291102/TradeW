---
type: research
date: 2026-07-17
tags: [research, database, oracle, migration, prisma, assessment]
status: blocked-pending-decision
---

# Oracle Database migration — architecture assessment

## For future Claude
Read this before writing any Oracle migration code. The headline: **standardizing TradeW on Oracle is not a database migration — it's a full replacement of the ORM (Prisma), which Oracle has never supported and has no plan to support.** That collides head-on with the task's own constraints ("do not redesign, keep changes small and reversible"). No code was changed. A design decision is required from the user before implementation — see the decision section at the end.

## 1. Scope reality check (verified by grep, not assumed)

- **SQL Server: does not exist in this codebase.** Zero matches for `sqlserver` / `mssql` / `tedious` / `node-mssql` anywhere outside `node_modules`. The task says Oracle "replaces PostgreSQL and Microsoft SQL Server," but there is no SQL Server to replace — that half of the scope is moot.
- **PostgreSQL: the single datastore, everywhere, exclusively through Prisma.** One datasource, `provider = "postgresql"` in `packages/database/prisma/schema.prisma:7`. Prisma `5.22.0` (`@prisma/client` + `prisma` CLI).
- The only other DB mentioned in the repo is **SQLite**, and only in *documentation* for the not-yet-built Python `services/trading-engine` (`ARCHITECTURE.md`) — no code.

## 2. The blocking finding: Prisma cannot talk to Oracle

Prisma ORM's datasource providers are **postgresql, mysql, sqlite, sqlserver, mongodb, cockroachdb — there is no `oracle` provider**, and per Prisma's own 2026 docs and changelog there is no plan to add one (long-standing open request, prisma/prisma#2853). Confirmed against current sources (see Sources).

This is not a SQL-syntax difference that a migration tool can bridge. Prisma is generated at build time against a specific provider; the entire query engine, the generated client's types, the migration engine, and `$queryRaw`/`$executeRaw` all assume a supported provider. **To use Oracle, Prisma must be removed and replaced with an Oracle-capable data layer** (the official `node-oracledb` driver, or an ORM that supports it — TypeORM, Sequelize, MikroORM, or a query builder like Knex with the `oracledb` dialect).

That makes this task, as literally specified, internally contradictory:
- Goal: standardize on Oracle.
- Constraint 8: "Do not redesign the application. Preserve the existing architecture."
- Constraint 9: "Keep all changes small, reviewable, and reversible."
- Reality: Oracle ⇒ rip out Prisma across the whole data layer ⇒ a redesign of persistence that cannot be small or trivially reversible.

The constraints can't all hold at once. That trade-off is a decision only the user can make; it is documented here, not silently resolved.

## 3. Files affected (the blast radius)

**Data layer — 18 files import/use Prisma, ~62 call sites.** Every one is rewritten under an ORM swap:

- Schema & migrations: `packages/database/prisma/schema.prisma`, `packages/database/prisma/migrations/*` (3 migrations), `packages/database/prisma/seed.ts`, `packages/database/package.json`
- services/api: `prisma/prisma.service.ts`, `prisma/prisma.module.ts`, `auth/auth.service.ts`, `entitlements/entitlements.service.ts`, `instruments/instruments.service.ts`, `market-data/market-data.service.ts`, `sim/sim.service.ts`, `sim/sim.controller.ts`, `sentinel/sentinel.service.ts`
- services/sentinel: `prisma.service.ts`, `app.module.ts`, `brain/prisma-memory-store.ts`, `brain/prisma-knowledge-graph.ts`, `brain/outcome-learning.service.ts`, `brain/strategy-intelligence.service.ts`, `compliance/compliance.service.ts`, `intelligence/news-intelligence.service.ts`

**Config & infra:**
- `services/api/.env.example`, `services/sentinel/.env.example` — `DATABASE_URL=postgresql://…` (Oracle uses a different connection-string shape: `user/pass@host:1521/service`, and `node-oracledb` may need the Oracle Instant Client)
- `infra/docker/docker-compose.yml` — `pgvector/pgvector:pg16` container → would become an Oracle image (e.g. `container-registry.oracle.com/database/free:latest`; note Oracle licensing even for dev images)
- `infra/docker/README.md`, `infra/README.md`, `infra/terraform/README.md`

**Docs referencing Postgres/pgvector:** `ARCHITECTURE.md`, `packages/database/README.md`, `SENTINEL_BRAIN_PROGRESS.md`, `docs/ai/DISTILLATION.md`, and several service READMEs.

## 4. Postgres-specific features in use → Oracle equivalents

| Postgres feature (where) | Oracle equivalent | Notes |
|---|---|---|
| `String[]` array columns — `MemoryRecord.tags`, `SentinelObservation.evidence` (schema `String[]`) | No native array type | Oracle has no `text[]`. Model as a child table, a JSON array (`JSON`/`CLOB`), or `VARRAY`. Behavioural change; queries like `tags && ARRAY[...]` (`prisma-memory-store.ts`) must be rewritten. |
| `Json` / `Json?` — preferences, metadata, entities | `JSON` type (21c+) or `CLOB` with `IS JSON` | Broadly workable on modern Oracle; JSON path query syntax differs. |
| `Decimal @db.Decimal(12,2)` (money/price columns) | `NUMBER(12,2)` | Clean 1:1 mapping. |
| `@default(uuid())` string PKs | `RAW(16)`/`VARCHAR2(36)` + app-side UUID, or `SYS_GUID()` | uuid() is generated app-side by Prisma today, so this is portable — keep generating in app code. |
| enums (`InstrumentType`, `OrderStatus`, …) | `VARCHAR2` + `CHECK` constraint | Oracle has no native enum type. |
| `ILIKE` case-insensitive search (`prisma-memory-store.ts` text fallback) | `LOWER(col) LIKE LOWER(:q)` or case-insensitive collation | Syntax rewrite. |
| Identifier casing — Prisma quotes `"MemoryRecord"`, `"userId"` (camelCase) | Oracle folds unquoted identifiers to UPPERCASE | All raw SQL with quoted mixed-case identifiers must be revisited; a major source of subtle breakage. |
| Auto `createdAt/updatedAt` via Prisma `@default(now())`/`@updatedAt` | `DEFAULT SYSTIMESTAMP` + trigger for updated-at | `@updatedAt` is Prisma-side; on a new ORM it's re-implemented. |

## 5. pgvector → Oracle (the Sentinel Brain's hardest dependency)

The Persistent Knowledge Brain (`services/sentinel/src/brain/prisma-memory-store.ts`) is the deepest Postgres coupling:
- `embedding Unsupported("vector")?` column (schema) + `CREATE EXTENSION vector` (migration `20260716000000_ai_foundation_entitlements`).
- Raw SQL: cosine similarity via the `<=>` operator, `${vector}::vector` casts, and the pgvector index. Written as raw SQL precisely because Prisma can't type the vector column.

**Oracle path:** Oracle **23ai** ships *AI Vector Search* — a native `VECTOR` datatype and `VECTOR_DISTANCE(v1, v2, COSINE)` function with vector indexes. It is genuinely capable, but:
- Requires **Oracle 23ai or newer** — older Oracle (19c, 21c) has **no** native vector type; there the Brain's semantic search would have to fall back to text-only or an external vector store.
- The raw SQL is a full rewrite (different operator, different cast, different index DDL, different driver bind syntax via `node-oracledb`).
- The existing degraded-mode text fallback (no embedding provider) already exists and survives — so a phased path could keep vectors on a separate system initially.

## 6. Prisma feature behaviour on Oracle

Not applicable in the usual sense — Prisma does not run on Oracle at all, so there is no "Prisma-on-Oracle behaves differently" matrix. The relevant migration cost is the ORM replacement itself: type-safe generated client, `select`/`include` graph loading, transactions (`$transaction`), migration engine (`prisma migrate`), and raw SQL helpers all have to be re-expressed in the replacement (TypeORM decorators + repositories, or Sequelize models, or raw `node-oracledb`). ~62 call sites, plus the migration history, plus the seed script.

## 7. Migration options

- **A — Reconsider Oracle / stay on Postgres.** With no SQL Server to consolidate and a working Prisma+pgvector stack, the cost/benefit of Oracle is poor unless there's an external mandate (licensing, corporate standard, existing Oracle estate). Lowest risk by far; honours "don't redesign." *Open question: what is driving the Oracle requirement?*
- **B — Oracle via an ORM swap to TypeORM (or Sequelize) + Oracle 23ai.** The only path that reaches "all-Oracle." Explicitly a persistence-layer redesign: replace Prisma across 18 files/62 call sites, re-model the schema (arrays, enums, JSON), rewrite migrations, rewrite the pgvector raw SQL against 23ai vector search. Multi-week; each service is a reviewable increment, but the whole is not "small/reversible." Must be done with the DB actually running (Phase 2 was never completed — no Postgres nor Oracle is running yet), so nothing can be validated end-to-end until an instance exists.
- **C — Hybrid.** Oracle for relational tables via the new ORM; keep vectors on pgvector or a dedicated vector store. Reduces the 23ai hard dependency but introduces polyglot persistence — arguably a bigger architecture change, not smaller.

## Decision required (why implementation is paused)

Per the task's own sequencing ("only after the report is complete, begin implementing") — the report's conclusion is that implementation cannot proceed under the stated constraints without a choice: **accept a persistence-layer redesign (drop Prisma), or reconsider Oracle.** Beginning to write Oracle code now would (a) require ripping out Prisma — a redesign the task forbids — and (b) be unvalidatable, since no database instance is running. This is escalated to the user rather than resolved silently.

## Sources
- Prisma supported databases (no Oracle): https://www.prisma.io/docs/orm/reference/supported-databases
- Oracle support request (open, no plan): https://github.com/prisma/prisma/issues/2853
- TypeORM supports Oracle (alternative ORM): https://www.pkgpulse.com/guides/typeorm-vs-prisma-2026

## Related
- [[../Plans/2026-07-17 - Platform audit and implementation roadmap]]
- [[../Research/2026-07-17 - Sentinel Brain audit]]
- [[../_INDEX.md]]
