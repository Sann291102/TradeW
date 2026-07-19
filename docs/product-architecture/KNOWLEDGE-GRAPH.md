# Institutional Knowledge Graph — Product Blueprint

Status: design, pre-implementation. Cross-cutting system, added by the Genesis v2 brief. Governed by [`TRADEW-OS.md`](TRADEW-OS.md) §4 (knowledge lifecycle). This graph holds **validated** knowledge only; its raw-evidence counterpart is the [Research Vault](RESEARCH-VAULT.md) — the two are the same physical store separated by a stage discriminator (`RESEARCH-VAULT.md` §2), never two databases.

## 1. This is not `TradeW/knowledge/`

`TradeW/knowledge/` is an Obsidian vault scoped strictly to **engineering/coding-agent memory** for people (and Claude) building TradeW — architecture decisions, debugging notes, implementation plans. Per its own `_INDEX.md` and `CLAUDE.md` Rule 4, it explicitly excludes live market data and real-time analytics, and is never wired into the production runtime. The direction update (§9) reaffirms this separation as a hard rule.

This document describes a different thing: a **product feature** — the platform's own permanent, growing institutional memory of *validated* markets, patterns, and lessons, consumed by users (via Learning Hub) and by Sentinel/TradeW AI (as context). The two systems must stay separate; this doc is the canonical spec for the product-facing one.

## 2. Don't build new infrastructure — extend Sentinel's Brain

`services/sentinel/src/brain/` already implements exactly the primitives this feature needs, audited and confirmed real (not stubbed) as of 2026-07-17:

| Existing component | Reused for |
|---|---|
| `PrismaMemoryStore` (Postgres + pgvector, `MemoryRecord`/`MemoryRelation`) | storing graph node content + embeddings |
| `PrismaKnowledgeGraph` (`GraphNode`/`GraphEdge`, BFS `neighbors`/`path`) | the News→Pattern→Concept→Lesson chain (§3) |
| `ConceptLearningEngine` | entity extraction (symbols, patterns, sectors) that seeds graph nodes/edges |
| `DefaultRetriever` / `KnowledgeCenterService` | semantic search over the graph |

The product-facing Knowledge Graph is therefore **the same Postgres+pgvector store**, with two additions, not a new service:

1. A **node-type taxonomy** matching §3 below (currently `ConceptLearningEngine` extracts symbols/patterns/sectors generically — this adds the specific node kinds the brief asks for: News, Market Event, Pattern, Indicator, Concept, Historical Example, Backtest, Outcome, Lesson, Research).
2. A **read API surface for non-Sentinel consumers** — today `KnowledgeCenterService` only exposes graph data indirectly through `ConceptLearningEngine`'s writes (per the Brain audit, no direct graph-query endpoint exists yet). Learning Hub's lesson generation and TradeW AI's research agents need a direct `GET /brain/graph/:nodeId/neighbors`-style read path, gated the same way (`ServiceTokenGuard`, internal-only, called via `services/api`).

## 3. Node types and the canonical chain

```
News → Market Event → Pattern → Indicator → Concept → Historical Example
     → Backtest → Outcome → Lesson → Research → Sentinel Memory → Knowledge Graph
```

Nothing exists in isolation — every node created by the [Continuous Learning Pipeline](CONTINUOUS-LEARNING-PIPELINE.md) must land with at least one edge to an existing node (a new Pattern links to the Indicator(s) that detected it and the Market Event that triggered it, etc.). A node with zero edges after pipeline processing is a pipeline bug, not a valid end state.

## 4. Permanence rule

Knowledge is never deleted. Superseded or contradicted nodes are archived (soft-flagged, not removed) and superseded by a new version with an edge back to what it replaces — same pattern as `TradeW/CLAUDE.md` Rule 1's "archive, never delete" for code, applied to data. This is what lets the graph "continuously grow over months and years" per the brief without losing provenance.

## 5. Validation gate

A node only becomes readable by Learning Hub or citable by TradeW AI/Sentinel after the pipeline's Validation Engine assigns it a confidence score above threshold (see `CONTINUOUS-LEARNING-PIPELINE.md` §2). Below threshold, it stays in the graph (for audit/debugging) but is excluded from consumer queries — mirrors Sentinel's Compliance & Audit agent logging everything while only the Orchestrator's synthesized output reaches the user.

## 6. Consumers

- **Learning Hub** — lesson generation sources Concept/Historical Example/Outcome nodes (`LEARNING-HUB.md` §3)
- **TradeW AI** — research agents cite graph nodes for historical-comparison context, never as a standalone answer
- **Sentinel** — already the graph's primary writer via `ConceptLearningEngine`; gains richer read context as node-type coverage grows

## 7. Open items

- Exact API shape for the new read endpoints — design when Learning Hub content generation is actually being built, not speculatively now.
- Embedding provider for graph node content currently falls back to `ILIKE` text search with no key configured (per Brain audit) — the same operational gap applies here, not a new one.
