---
type: research
date: 2026-07-17
tags: [research, audit, sentinel, brain]
status: verified
---

# Audit: Sentinel Persistent Knowledge Brain (end-to-end)

## For future Claude
Read this before re-auditing the Brain from scratch or assuming it's stubbed because [SENTINEL_BRAIN_PROGRESS.md](../../SENTINEL_BRAIN_PROGRESS.md) says "78%". It isn't stubbed — every line of code is real and wired. The 22% gap is entirely **operational** (no local Postgres running yet), not missing code. Verified by reading every file in `services/sentinel/src/brain/`, its `packages/ai-core` dependencies, the Prisma schema/migrations, and the DI wiring in `app.module.ts` — not by trusting the progress doc's claims.

## Scope
Audited: `PrismaMemoryStore`, `PrismaKnowledgeGraph`, `ConceptLearningEngine`, `KnowledgeCenterService`, plus every other `services/sentinel/src/brain/*` file, their `@tradew/ai-core` dependencies (`DefaultLearningEngine`, `DefaultNeuralBrain`, `DefaultRetriever`, `ProviderManager`), the Prisma schema/migrations, DI wiring, and local runnability. No code was changed — audit only, per instruction.

## 1. What's implemented (real, not stubbed)

| Component | File | Verdict |
|---|---|---|
| `PrismaMemoryStore` | `services/sentinel/src/brain/prisma-memory-store.ts` | Real. `store`/`get`/`search`/`connect`/`update`/`stats` all hit Postgres via Prisma. `embedding` is `Unsupported("vector")` in the schema (Prisma can't type pgvector columns), so writes/reads go through raw `$executeRaw`/`$queryRaw` with the `<=>` cosine-distance operator — the documented workaround, correctly implemented. No embedder configured → falls back to `ILIKE` text search, not a crash. |
| `PrismaKnowledgeGraph` | `prisma-knowledge-graph.ts` | Real. `upsertNode`/`upsertEdge`/`neighbors`/`path` (BFS, ≤4 hops, explicitly documented as unweighted, not Dijkstra) all hit real `GraphNode`/`GraphEdge` tables. |
| `ConceptLearningEngine` | `concept-learning.service.ts` | Real. Regex/hint-based entity extraction (symbols, patterns, sectors), writes entities onto the memory record, upserts graph nodes, links `mentions` and `co_occurs_with` edges. |
| `KnowledgeCenterService` | `knowledge-center.service.ts` | Real but thin by design — composes `Retriever.retrieve()` and `MemoryStore.stats()`. Exposed via `POST /brain/search`, `GET /brain/stats` in `app.controller.ts`. |
| `HistoricalSimilarityService`, `MarketContextService`, `OutcomeLearningService`, `PatternRecognitionService`, `ResearchTriggerService`, `StrategyIntelligenceService` | `brain/*.ts` | All real, all defensively wrapped (try/catch, degrade-not-crash), all **actually called** from `sentinel-orchestrator.service.ts`'s `observe()` flow (verified — not dead code). |
| `DefaultLearningEngine`, `DefaultNeuralBrain`, `DefaultRetriever`, `ProviderManager` | `packages/ai-core/src/brain/impl.ts`, `providers/*` | Real. Provider-agnostic (Anthropic/OpenAI/NVIDIA NIM/Ollama for LLM, Voyage/NVIDIA/OpenAI for embeddings, Tavily/Brave/Firecrawl/Anthropic-web-search for research), config-driven, zero hardcoded provider names in consumer code. |
| DI wiring | `app.module.ts` | Every Brain service is registered and injected correctly; nothing defined-but-unused. |
| Prisma schema | `packages/database/prisma/schema.prisma` | `MemoryRecord`, `MemoryRelation`, `GraphNode`, `GraphEdge` models are complete and match what the code expects field-for-field. |
| Migration | `migrations/20260716000000_ai_foundation_entitlements/migration.sql` | Real SQL, includes `CREATE EXTENSION IF NOT EXISTS "vector"` and all four brain tables with correct indexes/FKs. |
| Generated Prisma client | `node_modules/.prisma/client/` | Already generated and current (`schema.prisma` copy inside it includes `MemoryRecord`; `index.d.ts` has the typed methods) — `prisma generate` has already been run against the latest schema. |
| API surface | `app.controller.ts` | `POST /observe`, `GET /observations`, `POST /explain`, `POST /brain/search`, `GET /brain/stats`, `GET /brain/strategy` — all real handlers, all guarded by `ServiceTokenGuard`. |

Grep for `TODO`, `FIXME`, `not implemented`, `stub`, `placeholder` across `services/sentinel/src/` and `packages/ai-core/src/`: **zero matches.**

## 2. What's stubbed

**Nothing found.** No component in the audited scope is a stub — every method has a real implementation, not a `throw new Error('not implemented')` or a hardcoded return.

## 3. What's broken

**Nothing found in the code itself.** The only defect is documentation drift: `infra/docker/README.md` claims a `docker-compose.yml` "already present in `TradeW -(Setup & Paper)\TradeW-Setup-main\tradew-prototype\`" — **that path does not exist** (confirmed: only `Planning/tradew-site` exists there, no `tradew-prototype` folder, no compose file anywhere in the workspace outside unrelated third-party repos). This README's premise is false; a compose file needs to be written from scratch, not adapted from a reference that isn't there.

## 4. Blockers preventing local execution

Everything below is **operational absence**, not missing code:

1. **No `.env` file anywhere** — only `services/sentinel/.env.example`. `DATABASE_URL`, `SERVICE_TOKEN`, and all AI provider keys are unset.
2. **No local Postgres.** `psql` is not installed; no container is running. Docker Desktop **is** installed (v29.6.1) and can run Postgres+pgvector.
3. **No docker-compose.yml exists** (see §3) — `infra/docker/README.md` itself says "Status: empty, not yet written."
4. **Migrations have never been applied to a real database** — confirmed by `SENTINEL_BRAIN_PROGRESS.md`'s own admission ("No live Postgres in this environment to verify the persistence layer end-to-end") and by the absence of any reachable Postgres in this environment.
5. **No AI provider keys configured** — not a hard blocker (every Brain service degrades gracefully without one: text-search fallback instead of vector search, deterministic composition instead of LLM summarization), but semantic search, summarization, and research triggering won't do anything beyond degraded mode until at least `VOYAGE_API_KEY` (or another embedding provider) is set.
6. **No `dev:sentinel` convenience script** at the workspace root — `package.json` has `dev:api` and `dev:web` but nothing for `services/sentinel`; must `cd services/sentinel && npm run start:dev` manually. Minor, not blocking.

## 5. Exact steps to make the Brain operational locally

```bash
# 1. Postgres + pgvector, via Docker (no docker-compose.yml exists yet — run directly)
docker run -d --name tradew-postgres \
  -e POSTGRES_USER=tradew -e POSTGRES_PASSWORD=tradew -e POSTGRES_DB=tradew \
  -p 5432:5432 pgvector/pgvector:pg16

# 2. Configure env — copy the example and fill in the real DATABASE_URL (already correct
#    in .env.example for the container above) + SERVICE_TOKEN
cp services/sentinel/.env.example services/sentinel/.env
# also needed: services/api/.env (must share the same SERVICE_TOKEN) and packages/database
# needs DATABASE_URL in its own environment for the Prisma CLI — export it or add a
# packages/database/.env with the same DATABASE_URL

# 3. Apply migrations (creates the vector extension + all tables, including MemoryRecord/GraphNode)
npm run db:migrate         # = prisma migrate deploy, from workspace root

# 4. Regenerate the Prisma client (only strictly needed if the schema changes again —
#    the committed client already matches the current schema)
npm run db:generate

# 5. (Optional but recommended) Set at least one embedding provider so search is real
#    vector similarity instead of the ILIKE text-match fallback:
#    VOYAGE_API_KEY=... in services/sentinel/.env

# 6. Run Sentinel
cd services/sentinel && npm run start:dev
```

## 6. Verification path (Sentinel → Save → Retrieve → Semantic search → Knowledge graph)

Once the above is running, confirm end-to-end with the service token from `.env`:

```bash
# health check
curl http://localhost:4010/health

# trigger an observation — this is what feeds Pattern Recognition → memory.store()
curl -X POST http://localhost:4010/observe -H "x-service-token: $SERVICE_TOKEN" \
  -H "Content-Type: application/json" -d '{"symbol":"NSE:RELIANCE", ...}'
# (see domain.ts ObserveRequest for the exact required shape)

# retrieve — exercises PrismaMemoryStore.search() + Retriever
curl -X POST http://localhost:4010/brain/search -H "x-service-token: $SERVICE_TOKEN" \
  -H "Content-Type: application/json" -d '{"query":"RELIANCE pattern"}'

# stats — confirms rows actually landed in MemoryRecord
curl http://localhost:4010/brain/stats -H "x-service-token: $SERVICE_TOKEN"

# knowledge graph — confirmed indirectly: brain/search results carry entities;
# a direct graph query endpoint doesn't exist yet (KnowledgeCenterService doesn't
# expose PrismaKnowledgeGraph directly — only via ConceptLearningEngine's writes).
```

This was **not run** in this session (no Postgres available in this environment) — the above is the exact, code-verified sequence, not an assumption.

## Bottom line

The Sentinel Brain is not "partially stubbed" — it's **complete, real, defensively-coded application code that has never been run against a live database.** The 78% figure in the progress doc reflects unfinished *feature scope* (Portfolio Intelligence, semantic outcome labels), not unfinished *implementation* of the components audited here. Phase 2 (make it runnable) is pure ops: stand up Postgres+pgvector, apply the existing migration, set env vars. No code changes are needed to reach a working local Brain.

## Update 2026-07-21 — blockers resolved

Every blocker in §4 was operational, and per [[../Research/2026-07-18 - Backend audit (Milestone 4 Step 0)]] (one day later) they were in fact cleared: Postgres was stood up, migrations were applied live with **zero drift** (`prisma migrate status` clean against 3, later 5, migrations), and real row data exists (`User` 5 rows, `Instrument`/`Quote` 14 rows each, etc.). The verification curl sequence in §6 was still not confirmed as actually run — treat that specific sequence as still unverified even though the underlying DB is live. A ground-truth code pass on 2026-07-21 additionally confirmed `services/sentinel/src/brain/` remains real, substantive code (818 lines across 11 files) with no stubs — this audit's core conclusion holds.

One correction to this note's own framing: `packages/ai-core` (referenced here as the Brain's dependency) is also where the *actual* TradeW AI agent logic lives (~1,697 lines) — not in `services/tradew-ai`, which remains a README-only stub. Any future work assuming `services/tradew-ai` has runnable code should check `packages/ai-core` first.

## Related
- [[../_INDEX.md]]
- [SENTINEL_BRAIN_PROGRESS.md](../../SENTINEL_BRAIN_PROGRESS.md)
- [[../Decisions/2026-07-17 - Obsidian Knowledge Layer adopted]]
- [[../Research/2026-07-18 - Backend audit (Milestone 4 Step 0)]]
