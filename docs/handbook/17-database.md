# Chapter 17 — Database

**Status: 🟢 for the schema (21 models, 6 enums, 719 lines, 10 migrations, zero drift). 🔵 for Redis, partitioning, retention, and a rehearsed restore.**

---

## 17.1 One database, one schema owner

**PostgreSQL 16 with the `vector` extension.** One instance. One `schema.prisma`, owned by `packages/database`.

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [vector]
}
```

### 17.1.1 Why pgvector and not a dedicated vector database

Locked decision Q4: **no external vector store.**

| | pgvector | Pinecone / Weaviate / Qdrant |
|---|---|---|
| Operational surface | one database | two |
| Transactions across relational + vector | ✅ | ❌ |
| Joins between a memory and its concept | ✅ | application-side |
| Backup | one `pg_dump` | two systems, two schedules |
| Cost | included | a second bill |
| Scale ceiling | ~10⁶–10⁷ vectors comfortably | far higher |

At our scale the ceiling is irrelevant and every other row favours pgvector. The extraction trigger is vector search p95 exceeding ~200 ms after indexing — not row count.

### 17.1.2 ARCH-5 — one schema owner per table

Two runtimes share the instance; neither shares ORM ownership of a table.

```
   services/api      owns  User RefreshToken UserPreference AuditEvent
                            Plan PlanGrant Subscription EntitlementOverride
                            UsageCounter Order Trade Position PaperWallet
                            JournalEntry

   services/market-data owns Instrument Quote  (+ Candle, OptionMetrics 🔵)

   services/sentinel owns  MemoryRecord MemoryRelation GraphNode GraphEdge
                            ConceptNode ConceptEdge ConceptObservation
                            ConceptPromotion SentinelObservation NewsEvent
```

`services/sentinel` runs **its own `PrismaService`** against its own tables. Sharing an instance is fine; two ORMs writing one table is not.

---

## 17.2 The model map

```
 IDENTITY                    ENTITLEMENTS                 TRADING
 ────────                    ────────────                 ───────
 User ──┬── RefreshToken     Plan ── PlanGrant            Instrument ── Quote
        ├── UserPreference     │                              │
        ├── AuditEvent         └── Subscription ── User        ├── Order ── Trade
        ├── JournalEntry                                       ├── Position
        └── PaperWallet       EntitlementOverride ── User      └── (Candle 🔵)
                              UsageCounter                     (OptionMetrics 🔵)

 AI MEMORY                   CONCEPT ONTOLOGY             OBSERVATION
 ─────────                   ────────────────             ───────────
 MemoryRecord ──┐            ConceptNode ──┬── ConceptEdge   SentinelObservation
                ├── MemoryRelation          └── ConceptObservation   NewsEvent
 GraphNode ─────┴── GraphEdge               ConceptPromotion
```

21 models. Six enums: `InstrumentType`, `OrderSide`, `OrderType`, `OrderValidity`, `ProductType`, `OrderStatus`, plus `SubscriptionStatus` and `QuotaPeriod`.

---

## 17.3 Schema conventions

| Convention | Applied |
|---|---|
| `String @id @default(uuid())` everywhere | no sequential ids to enumerate 🔒 |
| `createdAt` / `updatedAt` on mutable models | `@default(now())` / `@updatedAt` |
| Money as `Decimal @db.Decimal(12,2)` | **never `Float`** |
| Wallet balances `Decimal(14,2)` | larger magnitude |
| Enums for closed sets | not free-text strings |
| Soft delete via `active` | never a hard delete |
| `Json` for open-ended structures | preferences, evidence, metadata |
| `String[]` for tag-like lists | Postgres-native arrays |
| `///` doc comments on non-obvious columns | they reach the generated client |

### 17.3.1 ⚠️ Money is never a Float

```prisma
price        Decimal? @db.Decimal(12, 2)
avgFillPrice Decimal? @db.Decimal(12, 2)
realizedPnl  Decimal  @db.Decimal(12, 2)
cashBalance  Decimal  @db.Decimal(14, 2)
```

`0.1 + 0.2 !== 0.3` in IEEE-754. In a P&L ledger that becomes a balance that drifts by fractions of a paisa per trade and never reconciles. `Decimal(12,2)` gives exact base-10 arithmetic up to ₹9,999,999,999.99.

> The cost: Prisma returns `Decimal` objects, so every read into arithmetic needs `Number(...)`. You will see `Number(wallet.cashBalance)` throughout `sim/`. That is the correct trade — an explicit conversion at the boundary, not silent float arithmetic in the ledger.

### 17.3.2 Doc comments reach the client

```prisma
/// MARKET fills immediately at the live price. LIMIT rests until the market
/// reaches `price`. SL (stop-loss limit) rests untriggered until the live
/// price crosses `triggerPrice`, then behaves like a LIMIT at `price`.
enum OrderType { MARKET LIMIT SL SL_M }
```

`///` comments are emitted into the generated Prisma client, so they appear in editor hover text. The schema is the documentation, at the point of use.

---

## 17.4 Indexes

### 17.4.1 What exists 🟢

| Model | Index | Serves |
|---|---|---|
| `User` | `email @unique` | login |
| `RefreshToken` | `tokenHash @unique`, `[userId]`, `[expiresAt]` | refresh, revoke-all, cleanup |
| `UserPreference` | `[userId,key] @unique`, `[userId]` | upsert, list |
| `AuditEvent` | `[userId,createdAt]`, `[eventType,createdAt]` | ⚖️ per-user and per-type audit queries |
| `Instrument` | `symbol @unique`, `[exchangeSegment,securityId] @unique`, `[exchangeSegment]`, `[active]`, `[isin]` | lookup, Dhan addressing, filtering |
| `Quote` | `instrumentId @unique`, `[instrumentId]` | latest-snapshot semantics |
| `Order` | `[userId,placedAt]`, `[status]`, `[userId,status]` | order book, **matching engine**, filtered views |
| `Trade` | `[userId,executedAt]`, `[orderId]` | trade book, fills-for-order |
| `Position` | `[userId,instrumentId,productType] @unique`, `[userId]` | upsert-on-fill, positions list |
| `MemoryRecord` | `[namespace,userId]`, `[createdAt]` | scoped retrieval |
| `ConceptNode` | `conceptId @unique`, `[domain]`, `[status,confidence]`, `[origin]` | graph traversal, filtering |
| `ConceptEdge` | `[fromId,toId,relation] @unique`, `[fromId,relation]`, `[toId,relation]`, `[origin,status]` | bidirectional traversal |
| `SentinelObservation` | `[userId,createdAt]`, `[agent,createdAt]`, `[symbol,createdAt]` | feed, per-agent, per-symbol |

### 17.4.2 The index that carries the most load

```prisma
model Order { @@index([status]) }
```

The matching engine runs this every three seconds, forever:

```sql
SELECT * FROM "Order" WHERE status IN ('OPEN','TRIGGER_PENDING');
```

Without the index that is a sequential scan of every order ever placed, 20 times a minute, growing without bound.

🔵 **The refinement, when the table grows:** a partial index, because resting orders are a tiny fraction of all orders.

```sql
CREATE INDEX order_resting_idx ON "Order" (status)
  WHERE status IN ('OPEN', 'TRIGGER_PENDING');
```

A partial index stays small regardless of how many `FILLED` rows accumulate.

### 17.4.3 The composite-index rule

`[userId, createdAt]` serves `WHERE userId = ? ORDER BY createdAt DESC` and also `WHERE userId = ?` alone. `[createdAt, userId]` serves neither well.

> **Leftmost-prefix rule: order composite index columns by equality-filter first, range/sort second.**

### 17.4.4 Missing 🔵

| Missing index | Needed for |
|---|---|
| pgvector IVFFlat/HNSW on `MemoryRecord.embedding` | **semantic search is currently a sequential scan** |
| pgvector index on `ConceptNode.embedding` | same |
| `Subscription [userId, status]` | exists 🟢 |
| `ConceptObservation [conceptId, observedAt]` | exists 🟢 |
| `NewsEvent GIN on symbols[]` | symbol-filtered news |
| `Instrument` trigram on `symbol`/`displayName` | fuzzy instrument search |

**The vector index is the important omission.** Without it every similarity query scans the whole table. At a few thousand memories that is imperceptible; at a hundred thousand it is the slowest query in the system.

```sql
CREATE INDEX memory_embedding_idx ON "MemoryRecord"
  USING hnsw (embedding vector_cosine_ops);
```

HNSW over IVFFlat: better recall/latency, no training step, and it handles incremental inserts — which matters because memories are written continuously.

---

## 17.5 Partitioning 🔵

Nothing is partitioned. The three tables that will need it:

| Table | Growth driver | Strategy | Trigger |
|---|---|---|---|
| `SentinelObservation` | every triggered signal, every observe | monthly `RANGE` on `createdAt` | > 50M rows |
| `AuditEvent` | ⚖️ every auth and admin action | monthly `RANGE` on `createdAt` | > 50M rows |
| `Candle` 🔵 | instruments × timeframes × bars | `RANGE` on `openTime`, or `LIST` on `timeframe` | at creation |
| `Trade` | fills | probably never at our scale | — |

### 17.5.1 Why `Candle` should be partitioned from day one

```
   200 instruments × 5 timeframes × 375 bars/day × 250 days
   ≈ 94 million rows per year of 1-minute data alone
```

Retrofitting partitioning onto a populated table requires a full rewrite under a lock. Creating it partitioned costs nothing. This is one of the few cases where anticipating scale is correct — because the cost of anticipating is zero and the cost of retrofitting is an outage.

### 17.5.2 ⚖️ Audit partitioning is a retention mechanism

Regulatory retention is expressed in years. Monthly partitions make "drop everything older than seven years" an instant `DROP TABLE` on a partition rather than a `DELETE` scanning tens of millions of rows.

⚖️ **But note CLAUDE.md Rule 1.** Dropping an audit partition is deletion. It requires an explicit, documented retention policy signed off by the compliance owner, and archival to cold storage (S3 with object lock) **before** the drop. It is the one place where "never delete" is negotiated rather than obeyed, and the negotiation is written down.

---

## 17.6 Migrations

### 17.6.1 The history 🟢

| Migration | Adds |
|---|---|
| `20260710000000_init` | baseline |
| `20260710000100_sprint1_identity` | refresh tokens, preferences, audit |
| `20260716000000_ai_foundation_entitlements` | memory, graph, plans, subscriptions, quotas |
| `20260718000000_market_data_quote_revision` | `Quote` `@@unique` + `source` |
| `20260718000001_market_data_quote_ohlc_fields` | OHLC on `Quote` |
| `20260721000000_sentinel_concept_knowledge_graph` | the concept ontology (4 tables) |
| `20260721010000_instrument_broker_identity` | Dhan `securityId`/`exchangeSegment`/… |
| `20260721020000_instrument_type_future` | `FUTURE` enum value |
| `20260722100000_oms_order_lifecycle_enums` | order enums |
| `20260722100001_oms_order_lifecycle` | order/trade/position lifecycle columns |

**Zero drift** against the live database, verified.

Note the pattern in the last two: **enums in a separate, earlier migration from the columns that use them.** Postgres will not let a new enum value be used in the same transaction that creates it. Splitting is not fastidiousness — it is the only thing that works.

### 17.6.2 ⚠️ `prisma migrate dev` does not work here

> **Gotcha, cost: an afternoon.**

```
   prisma migrate dev  refuses to run in a non-interactive / non-TTY shell,
   even with --create-only.
```

Every migration in the list above was hand-authored. The working procedure:

```bash
# 1. Edit schema.prisma

# 2. Generate the SQL by diffing against the LIVE database
npx prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel packages/database/prisma/schema.prisma \
  --script > migration.sql

# 3. Review it. Hand-edit if needed (enum splits, data backfills, index concurrency)

# 4. Create the migration directory and file
mkdir -p packages/database/prisma/migrations/$(date +%Y%m%d%H%M%S)_descriptive_name
mv migration.sql .../migration.sql

# 5. Apply
npm run db:migrate:deploy
```

### 17.6.3 ⚠️ Always diff against the live database, not the schema file

> **The most valuable database lesson in the vault.**

```
   ❌ prisma migrate diff --from-migrations … --to-schema-datamodel …
   ✅ prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel …
```

**Why:** `schema.prisma` can be edited ahead of any migration during a design conversation. It then silently drifts from what is actually applied. Diffing schema-against-schema reproduces the drift into the new migration; diffing against the live database catches it.

This is exactly how the pre-existing drift was found during Market Data Migration 1 — `schema.prisma` had columns no migration had ever shipped.

### 17.6.4 Migration safety rules

```
   □ Additive first. New columns are nullable or have a default.
   □ Never rename in one step. Add new → backfill → dual-write →
     switch reads → drop old, across separate deploys.
   □ Never drop a column in the same release that stops using it.
   □ Enum values in their own migration, before use.
   □ CREATE INDEX CONCURRENTLY on populated tables (it cannot run
     inside a transaction — mark the migration accordingly).
   □ Backfills in batches, never one UPDATE over millions of rows.
   □ ⚖️ Never DELETE. Soft-delete or archive.
   □ State the rollback plan in the PR — or state that it is
     forward-only by design and why.
```

### 17.6.5 Deployment

```bash
$COMPOSE run --rm migrate    # one-shot container, BEFORE the app starts
$COMPOSE up -d
```

Migrations run as a separate one-shot service that fails loudly and independently. No application container ever starts against an un-migrated database.

---

## 17.7 Redis 🔵

**Not deployed.** Specified for four roles, in priority order:

| Role | Purpose | Priority |
|---|---|---|
| **Leader lock** | matching-engine single-runner election (OPS-1) | **P0 for multi-replica** |
| **Rate limiting** | sliding window at the ingress (SEC-4) | **P0 for release** |
| **Cache** | market snapshots, entitlement decisions, retrieval results | P1 |
| **Event bus** | Redis Streams (Chapter 5 §5.5.4) | P2 |

### 17.7.1 Key conventions 🔵

```
   lock:matching-engine                    SET NX PX 10000
   ratelimit:{scope}:{id}:{window}         sliding window
   cache:snapshot:{symbol}:{15m-bucket}    TTL to next bar close
   cache:entitlement:{userId}:{capability} TTL 60 s
   cache:retrieval:{hash}                  TTL 5 min
   stream:orders                           Redis Stream
   stream:market                           Redis Stream
```

**`cache:snapshot` keys on the bar bucket, not on a wall-clock TTL** (Chapter 9 §9.3.3) — every observer within a bar sees identical structure, and invalidation happens exactly when new information arrives.

### 17.7.2 The rule that keeps Redis safe

> **Redis is a cache and a coordination primitive. It is never the source of truth.**

Every Redis key must be reconstructible from Postgres. A `FLUSHALL` should cost latency, never data. The one exception — the leader lock — is *designed* to be lost: the lease expires, another instance acquires it, and the system continues.

---

## 17.8 Data retention ⚖️🔵

No retention policy exists. Specified:

| Data | Retention | Basis |
|---|---|---|
| `User` | while active + 3 years after deletion request | ⚖️ DPDP; financial-record obligations |
| `AuditEvent` | **7 years** | ⚖️ SEBI |
| `Order` / `Trade` / `Position` | 7 years | ⚖️ SEBI |
| `SentinelObservation` | 3 years | ⚖️ defensibility of past observations |
| `JournalEntry` | while the account exists; deletable on request | ⚖️ DPDP — personal data |
| `MemoryRecord` (user-scoped) | 2 years or `staleAfter` | relevance |
| `MemoryRecord` (global) | indefinite | institutional knowledge |
| `Quote` | current only (it is a snapshot) | — |
| `Candle` 🔵 | 5 years intraday, indefinite daily | matches Dhan's own availability |
| `RefreshToken` (revoked) | 90 days | forensics, then prune |

### 17.8.1 ⚖️ DPDP and the right to erasure

The DPDP Act 2023 grants erasure rights, which collide with SEBI's retention obligations. The resolution:

```
   ERASE                          RETAIN (legal obligation)
   ─────                          ─────────────────────────
   JournalEntry.content           Order / Trade / Position
   UserPreference                 AuditEvent
   user-scoped MemoryRecord       Subscription
   name, contact details

                    ↓
   PSEUDONYMISE the retained rows:
   User.email → 'deleted-{uuid}@erased.invalid'
   passwordHash → a random unusable value
   Personal identifiers stripped; the transaction
   record survives, unlinkable to a person.
```

**This must be designed before the first erasure request, not after.** A user asking to be deleted while their trade history is legally retained is a scenario with a correct answer and no room for improvisation.

---

## 17.9 Backup 🟡

### 17.9.1 What exists

`infra/docker/backup.sh` — a `pg_dump`-based script, written and untested against a real deployment.

### 17.9.2 The specified policy 🔵

| Layer | Frequency | Retention | Location |
|---|---|---|---|
| Continuous WAL archiving | streaming | 7 days | object storage |
| Full logical dump | daily 02:00 IST | 30 days | object storage, encrypted |
| Weekly full | Sunday | 12 weeks | separate region |
| Monthly full | 1st | 7 years ⚖️ | cold storage, object lock |
| Pre-migration snapshot | every deploy with a migration | 7 days | local + object storage |

### 17.9.3 RPO and RTO

| | Target | Achieved by |
|---|---|---|
| **RPO** (max data loss) | ≤5 min | WAL archiving |
| **RTO** (max downtime) | ≤1 h | documented restore + rehearsed runbook |

### 17.9.4 ⚠️ The rule that makes backups real

> **A backup that has never been restored is not a backup. It is a file.**

**Quarterly restore drill, mandatory:**

```
   1. Provision a clean database instance
   2. Restore the most recent full backup
   3. Replay WAL to a chosen point in time
   4. Run the schema check: does prisma migrate diff report zero drift?
   5. Run a data-integrity check:
        · row counts per table against the source
        · a known user's PaperWallet balance
        · SUM(realizedPnl) over Trade for that user
   6. Record the wall-clock time taken → this is your REAL RTO
   7. Update the runbook with anything that surprised you
```

Step 6 is the point of the exercise. The RTO in a document is a hope; the RTO from a drill is a number.

---

## 17.10 Disaster recovery ⚖️

| Scenario | Detection | Response | Data loss |
|---|---|---|---|
| Single query blocking | slow-query log | terminate; add an index | none |
| Connection exhaustion | 500s, pool errors | check for a stray `new PrismaClient()`; raise pool | none |
| Disk full | monitoring | extend volume; prune WAL | none |
| Corruption | checksums, errors | restore + WAL replay | ≤RPO |
| Instance loss | health check | restore to new instance | ≤RPO |
| Region loss | manual | restore weekly cross-region backup | ≤7 days |
| Accidental `DELETE`/`DROP` | ⚖️ audit + alarm | point-in-time recovery to just before | ≤RPO |
| Ransomware / malicious deletion | anomaly detection | restore from object-locked cold storage | ≤1 month |

**The object-locked monthly backup exists for the last row specifically.** An attacker with database credentials can delete every backup they can reach; a WORM-locked object cannot be deleted by anyone, including us, until its retention expires.

---

## 17.11 Query patterns and performance

### 17.11.1 The N+1 rule

```ts
// ❌ N+1 — one query per position
const positions = await prisma.position.findMany({ where: { userId } });
for (const p of positions) {
  const instrument = await prisma.instrument.findUnique({ where: { id: p.instrumentId } });
}

// ✅ one query
const positions = await prisma.position.findMany({
  where: { userId }, include: { instrument: true },
});
```

The codebase uses `include` correctly throughout — `MatchingEngineService` loads `{ include: { instrument: true } }` precisely so its per-order loop is in-memory.

### 17.11.2 Transaction discipline

```ts
return this.prisma.$transaction(async (tx) => {
  const order = await tx.order.create({ … });
  return this.executeFill(tx, order, …);
});
```

**Every money-touching mutation is transactional.** The `tx` client is threaded through helper functions — note `executeFill(tx, …)` takes the transaction client as its first argument rather than using `this.prisma`. That is what makes composition inside a transaction possible, and it is a pattern to copy.

> ⚠️ **Never `await` a network call inside a transaction.** It holds a row lock for the duration of an HTTP round trip. Fetch the price *before* opening the transaction — which is exactly what `OrderService.placeOrder` does.

### 17.11.3 Query budget

| Query class | Target |
|---|---|
| Point lookup by unique key | ≤2 ms |
| Indexed list, ≤100 rows | ≤10 ms |
| Matching-engine resting scan | ≤20 ms |
| Portfolio summary (2 queries) | ≤30 ms |
| Vector similarity (indexed) 🔵 | ≤50 ms |
| Vector similarity (unindexed, today) | **unbounded — grows linearly** |
| Concept graph traversal, 3 hops | ≤80 ms |

### 17.11.4 Connection pooling

Prisma defaults to `num_cpus × 2 + 1`. With N API replicas that is N × pool_size connections against Postgres's `max_connections` (default 100).

🔵 **At 4+ replicas, add PgBouncer in transaction mode.** Note that transaction-mode pooling is incompatible with prepared statements — Prisma needs `?pgbouncer=true` on the connection string.

---

## 17.12 Local development

```bash
docker compose -f infra/docker/docker-compose.yml up -d
npm run db:generate
npm run db:migrate
npm run ontology:validate && npm run ontology:seed
```

| Detail | Why |
|---|---|
| `pgvector/pgvector:pg16` | plain `postgres:16` fails at migration — the extension is required |
| Host port **5433** | avoids colliding with a locally installed Postgres |
| pgAdmin on **5050** | added 2026-07-21 for exactly this |

> ⚠️ **`npm run db:generate` after every schema change and every branch switch that touched the schema.** `nest build` fails with cryptic type errors when the Prisma client is stale.

> ⚠️ **`seed.ts` is broken** — `seedDemoAccount()` throws `bcrypt.hash is not a function`, a `ts-node` ESM/CJS interop issue. Pre-existing, unfixed (TD-1).

---

## 17.13 Database debt

| ID | Debt | Severity | Fix |
|---|---|---|---|
| DB-1 | **No pgvector index** — similarity search is a sequential scan | high | HNSW index |
| DB-2 | No Redis | high | deploy; unblocks OPS-1, SEC-4, caching |
| DB-3 | No retention policy ⚖️ | high | write it; implement pseudonymisation |
| DB-4 | Backup never restored | **high** | quarterly drill |
| DB-5 | No partitioning strategy | medium | partition `Candle` at creation |
| DB-6 | `seed.ts` broken (TD-1) | medium | fix ts-node interop |
| DB-7 | No `Candle`/`OptionMetrics`/`CorporateAction` | medium | Migrations 2–4 |
| DB-8 | No slow-query logging | medium | `log_min_duration_statement` |
| DB-9 | No connection pooler | low | PgBouncer at 4+ replicas |
| DB-10 | `staleAfter` modelled but unenforced | low | expiry job (needs a scheduler) |

**DB-4 is the one to fix first.** Every other item degrades performance or delays a feature. An unrestorable backup loses the company.

---

*Next: [Chapter 18 — AI Architecture](18-ai-architecture.md)*
