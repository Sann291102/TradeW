---
type: decision
date: 2026-07-21
tags: [decision, sentinel, brain, knowledge-graph, ontology]
status: implemented
---

# Sentinel Concept Knowledge Graph — second graph, living ontology

## For future Claude
There are now **three** things in this repo called "knowledge". Getting them confused is the most likely mistake here, so check this table before touching any of them.

| Path | What | Runtime? |
|---|---|---|
| `knowledge/` | Obsidian vault — engineering memory for coding agents (this file) | never |
| `knowledge-base/` | Concept ontology — market knowledge Sentinel reasons over, YAML | yes, seeded to Postgres |
| `GraphNode`/`GraphEdge` tables | Entity graph — "these co-occurred" | yes, pre-existing |

The `/knowledge` route in `apps/web` visualises the **vault** (files, wiki-links). It is unrelated to the concept graph and was not touched.

## Decision
Build the product-facing knowledge graph as a **concept ontology with a closed semantic relation vocabulary**, sourced from version-controlled YAML and projected into Postgres — not as a store of raw market data, and not by overloading the existing entity graph.

## Why new tables rather than `GraphNode.entityType = 'concept'`
`KNOWLEDGE-GRAPH.md` §2 says "don't build new infrastructure — extend Sentinel's Brain". New tables in the *same* database still honours that (same service, same Prisma schema owner, no new store). Overloading `GraphNode` was rejected because:
- `domain`, `status`, `confidence` need to be indexed query dimensions; inside a `properties` JSON blob they aren't.
- Runtime reinforcement needs its own append-only log and per-edge learned columns, which have no home on `GraphEdge`.
- At the target scale (thousands of concepts) the JSON blob becomes unqueryable.

## The four-layer separation (the part worth remembering)
1. **YAML canonical** — humans author, PR-reviewable.
2. **Postgres projection** — droppable and rebuildable from YAML.
3. **`ConceptObservation`** — append-only runtime log, never mutated.
4. **`ConceptPromotion`** — proposals queue; Sentinel *cannot* promote its own findings.

The reseed contract: seeding rewrites canonical columns only and never touches `learnedWeight`, `supportCount`, `refuteCount`, `observationCount` or observations. **Verified** — a reseed after 11 observations preserved `learnedWeight` 0.903125 and counters 8/2 while updating 7 changed concepts and skipping 59 by checksum.

If you edit `scripts/seed-ontology.ts`, do not add the learned columns to any `update:` block. That single mistake would silently wipe runtime learning on the next seed, and nothing would fail loudly.

## Non-obvious design choices
- **Closed 13-relation vocabulary.** Each carries `polarity` and `transitive`, which the reasoner depends on. An unrecognised relation wouldn't error — it would silently weight a conclusion wrong.
- **Non-transitive relations terminate paths.** "A contradicts B, B contradicts C" implies nothing about A and C. `explainPath` refuses to chain them; a naive graph walk manufactures conflict here.
- **Best-first, not BFS.** The existing `PrismaKnowledgeGraph.path()` is unweighted BFS. The concept graph scores paths by weight product with per-relation decay, because the shortest and strongest paths differ and explanations want the strongest.
- **No inverse relations.** No `contains`/`has_subtype`/`caused_by`. Declare on the specific concept pointing at the general one; traversal reads both directions. I tripped over this four times while authoring — the loader catches it.
- **Symmetric relations must be declared once.** Declaring `contradicts` on both sides creates two edges for one fact and double-reports in explanations. Found 8 instances via a loader check added after the smoke test surfaced a duplicate.
- **Contested knowledge is carried, not omitted** (`max-pain`, `put-call-ratio` at low confidence with the caveat in the explainer text).

## Compliance
Directive-language lint in `concept.schema.ts` runs on every load over `summary`/`definition`/`explainer`/`observable_when`; validation failure blocks seeding. It matches **imperative phrasing, not vocabulary** — "the urge to book profits early" passes, "Book profits here" fails, "buy-side liquidity" and "stop-loss clustering" must never trip it. I had to narrow the patterns once for exactly this reason.

## State
Implemented and verified: schema + migration `20260721000000_sentinel_concept_knowledge_graph` (applied, clean status), 66 concepts / 273 relations across 15 domains, loader, `ConceptGraphService`, `ConceptReinforcementService`, seeder, smoke test.

**Not built:** read API, UI, orchestrator wiring (the services are registered in `app.module.ts` but `observe()` doesn't call them yet), embeddings, promotion-review surface.

## Gotcha hit during this work
`prisma generate` fails with `EPERM ... rename query_engine-windows.dll.node` while any `services/api` process is running — the compiled `dist/main` processes hold the DLL, and killing only the `nest --watch` parents is not enough. Stop every `node.exe` running the API before generating.

## Related
- [[../_INDEX.md]]
- `docs/product-architecture/SENTINEL-KNOWLEDGE-GRAPH.md` — canonical spec
- `knowledge-base/README.md` — authoring guide
- [[../Research/2026-07-17 - Sentinel Brain audit]]
- [[2026-07-17 - Genesis v2 blueprint added as new product-architecture docs]]
