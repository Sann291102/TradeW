---
type: decision
date: 2026-07-17
tags: [decision, product-architecture, genesis-v2]
status: active
---

# Decision: Genesis v2 brief implemented as new product-architecture docs, not a rewrite

## Context
User pasted the "TradeW Genesis v2" brief — a 20-deliverable request for a unified platform blueprint (Learning Hub as a 4th pillar, an in-app Obsidian-style knowledge graph, continuous learning pipeline, monetization, onboarding, TradingView workspace, floating AI assistant with voice/nav commands, n8n catalog, motion/accessibility/performance guidance, phased roadmap).

## Decision
Confirmed with the user via AskUserQuestion before writing anything:
1. **Extend, don't rewrite.** `ARCHITECTURE.md`, `TRADEW-AI.md`, `SENTINEL.md` stay binding as-is. New docs added alongside them under `docs/product-architecture/`.
2. **Split into focused docs**, matching the existing one-doc-per-system pattern, plus one summary doc (`GENESIS-V2-BLUEPRINT.md`) mapping all 20 brief deliverables to where they're answered.
3. **The in-app "Obsidian Knowledge System" the brief describes is a separate system from `TradeW/knowledge/`** (this vault, engineering-memory-only per this file's own Rule 4). The product-facing graph reuses Sentinel's already-implemented Postgres+pgvector Brain (`PrismaMemoryStore`/`PrismaKnowledgeGraph`/`ConceptLearningEngine` — see [[../Research/2026-07-17 - Sentinel Brain audit]]) rather than standing up new infrastructure.

## New docs created
- `docs/product-architecture/LEARNING-HUB.md` — 4th pillar
- `docs/product-architecture/KNOWLEDGE-GRAPH.md` — product-facing graph, extends Sentinel's Brain
- `docs/product-architecture/CONTINUOUS-LEARNING-PIPELINE.md` — market data → validated graph nodes
- `docs/product-architecture/TRADEW-ASSISTANT.md` — voice + navigation-command extension of the existing TradeW AI ambient copilot (not a new AI system)
- `docs/product-architecture/SUBSCRIPTIONS.md` — Demo Trading, Learning Hub lifetime, Sentinel tiers, entitlement gating
- `docs/product-architecture/ONBOARDING.md` — signup-to-trading flow
- `docs/product-architecture/TRADINGVIEW-WORKSPACE.md` — tv.tradew-setup.com embed
- `docs/product-architecture/N8N-WORKFLOWS.md` — concrete workflow catalog, extends `ARCHITECTURE.md` §5
- `docs/product-architecture/GENESIS-V2-BLUEPRINT.md` — summary, deliverable map, motion/accessibility/performance sections, phased roadmap

`docs/product-architecture/README.md` updated to reference all of the above in reading order.

## Why this matters for future work
The single most load-bearing finding: **don't build new AI/storage infrastructure for the knowledge graph or continuous learning pipeline** — the Sentinel Brain audit already confirmed `PrismaMemoryStore`, `PrismaKnowledgeGraph`, and `ConceptLearningEngine` are fully implemented, not stubbed. The product-facing Knowledge Graph is an extension (node-type taxonomy + a new read API) of that existing store, not a new service. Anyone implementing Phase 5/6 of the roadmap (`GENESIS-V2-BLUEPRINT.md` §7) should start by reading the Brain audit, not by scaffolding a new Postgres schema.

## Status
All docs are design/pre-implementation, same review gate as the rest of `docs/product-architecture/`. No code was written. Next step per the brief's own instruction ("do not start coding immediately") is review, then Phase 1 (terminal modernization) per the roadmap.

## Related
- [[../_INDEX.md]]
- [[../Research/2026-07-17 - Sentinel Brain audit]]
- [[2026-07-17 - Obsidian Knowledge Layer adopted]]
