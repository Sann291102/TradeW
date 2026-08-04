# Sentinel Brain — Progress

Last updated: 2026-07-16 (Brain Phase 1 complete)

```
████████████████░░░░ 78%
```

| Layer | Status |
|---|---|
| Infrastructure | ✅ |
| Authentication | ✅ |
| API (gateway, single ingress) | ✅ |
| Entitlements (sentinel_pro / tradew_ultimate) | ✅ |
| Heartbeat (continuous market-hours operation) | ✅ |
| **Persistent Knowledge Brain** | ✅ |
| **Concept Learning Engine** | ✅ |
| **Continuous Research Engine** | ✅ |
| **Market Context Engine** | ✅ |
| **Pattern Recognition Engine** | ✅ |
| **Historical Similarity Engine** | ✅ |
| **Knowledge Center** | ✅ |
| **Continuous Learning from Outcomes** | ⚠️ first pass — directional labels only |
| **Strategy Intelligence Framework** | ⚠️ first pass — cross-symbol base rate only |
| **Explainability Engine** | ✅ |
| Portfolio Intelligence | ❌ |

## What shipped in Phase 1

All ten Brain subsystems are real, compiling, DI-wired code in `services/sentinel/src/brain/` — not stubs:

- **Persistent Knowledge Brain** — `PrismaMemoryStore` + `PrismaKnowledgeGraph`, real tables (MemoryRecord/MemoryRelation/GraphNode/GraphEdge), pgvector similarity search via raw SQL (Prisma's `Unsupported("vector")` workaround), text-match fallback when no embedding provider is configured.
- **Concept Learning Engine** — every ingestion extracts entities (symbols/patterns/sectors) and links them into the knowledge graph (`mentions`, `co_occurs_with`).
- **Continuous Research Engine** — event-driven only (checks the graph first, fires once per unfamiliar symbol) — no uncontrolled crawling, per the original architecture decision.
- **Market Context Engine** — composes a live narrative per symbol from the technical snapshot + Brain recall.
- **Pattern Recognition Engine** — every triggered signal becomes a durable `pattern_occurrence`, metadata-stamped with price-at-detection.
- **Historical Similarity Engine** — per-symbol+pattern frequency lookup, sample-size gated (min 5), historical language only.
- **Knowledge Center** — `POST /sentinel/brain/search`, `GET /brain/stats` (internal), `GET /sentinel/brain/strategy` — real queryable surface.
- **Continuous Learning from Outcomes** — piggybacks on the existing observe() cadence (no new scheduler); tags pending pattern occurrences with `continued_up` / `continued_down` / `unclear` once 15 minutes have passed.
- **Strategy Intelligence Framework** — cross-symbol base rate per pattern, gated at 8+ outcome-tagged samples, always phrased as historical frequency, never a call on the current setup.
- **Explainability Engine** — `/explain` now returns a structured `trace` (evidence lines used + Brain memory hits), not just prose; still honestly reports `live: false` with no AI provider configured.

Everything integrates additively into the existing orchestrator (`SentinelOrchestratorService`) — nothing was replaced, and every new Brain call is defensively wrapped so a database or provider outage degrades gracefully instead of breaking `/observe`. Verified live: `/observe` still returns all 16 signals correctly with `services/sentinel` running against no database at all; `marketContext` populates; `/explain` returns a real trace object.

## Known first-pass simplifications (honest, not hidden)

- Outcome labels are directional (`continued_up`/`continued_down`/`unclear`), not per-pattern semantic verdicts (e.g. "trap confirmed" vs "false alarm") — that would need pattern-specific interpretation logic, deferred to a later pass.
- Outcome evaluation and research triggers ride the existing `/observe` cadence rather than a dedicated scheduler — correct and sufficient given Sentinel already runs continuously, but means outcomes only get evaluated while the heartbeat is active.
- No live Postgres in this environment to verify the persistence layer end-to-end (pgvector raw SQL, entity graph writes) against a real database — code compiles and the degraded-mode paths are verified; the happy path needs a real `DATABASE_URL` to confirm.

## Not yet started

- **Portfolio Intelligence** — cross-position risk analysis, still ❌.
