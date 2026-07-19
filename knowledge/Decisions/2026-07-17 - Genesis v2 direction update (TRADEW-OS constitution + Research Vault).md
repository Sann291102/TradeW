---
type: decision
date: 2026-07-17
tags: [decision, product-architecture, genesis-v2, tradew-os]
status: active
---

# Decision: Genesis v2 direction update — TRADEW-OS constitution, Research Vault, explainability, continuity, agent layer

## Context
After the first Genesis v2 blueprint (9 new docs, see [[2026-07-17 - Genesis v2 blueprint added as new product-architecture docs]]), the user sent a **direction update** — explicitly "not a rewrite." It confirmed the existing direction (esp. "extending the Sentinel Brain rather than a new AI memory system" was called out as a good decision) and added five genuinely new things plus one reconciliation.

## What was added (5 new docs + 1 reconciliation)
- **`docs/product-architecture/TRADEW-OS.md`** — NEW constitutional source of truth. Sits above ARCHITECTURE.md. Defines philosophy, the non-negotiable principles (extend-don't-duplicate, one ingress, no AI trades, AI services independent + orchestrate at api, explainability, versioned-never-deleted), AI orchestration, knowledge lifecycle, module boundaries, extension rules, scalability, performance, maintainability. **Every future doc must reference it.**
- **`docs/product-architecture/RESEARCH-VAULT.md`** — NEW. Raw evidence vs. validated knowledge. Same physical store as the Knowledge Graph (Sentinel Brain), separated by a `stage`/`validation_status` discriminator — NOT a new database (extend-don't-duplicate).
- **`docs/product-architecture/EXPLAINABILITY.md`** — NEW core principle. Every premium conclusion must show reasoning/evidence/historical-examples/confidence/sources/why-it-changed. This is WHY the memory arch is shaped as it is (research/knowledge split, provenance, versioning, confidence scoring).
- **`docs/product-architecture/WORKSPACE-CONTINUITY.md`** — NEW. Resume-on-return via a `workspace_session` layer in services/api that *references* domain data, never duplicates it.
- **`docs/product-architecture/AGENT-ARCHITECTURE.md`** — NEW. Modular agent roster (Market/Research/News/Learning/Memory/Chart/Portfolio/Risk/Behavior/Sentinel) mapped onto EXISTING agents in the pillar docs — a naming/contract layer, not 10 new services. Key rule: **n8n orchestrates agents, never contains business logic.**

## The one reconciliation (important — touched a binding doc)
Direction update §5 says "TradeW AI should automatically invoke Sentinel when premium intelligence is required and subscription allows." ARCHITECTURE.md §9 says tradew-ai and sentinel have NO direct arrow between them. **Reconciled without contradicting the binding doc:** the escalation is orchestrated at `services/api` (the existing aggregator + entitlement chokepoint) — api fans a single user request out to both tradew-ai and sentinel and merges. tradew-ai still never calls sentinel directly. Documented in TRADEW-OS.md §2.4 and TRADEW-ASSISTANT.md §6 (with a diagram). This is the pattern to preserve for ALL future cross-AI-service coordination.

## Edits to existing docs (targeted, per Rule 1)
- CONTINUOUS-LEARNING-PIPELINE.md — inserted the Research Vault raw-record stage before the Validation Engine gate; noted n8n orchestrates the sequence.
- KNOWLEDGE-GRAPH.md — header now scopes it to validated knowledge only, points at Research Vault for raw.
- N8N-WORKFLOWS.md — added the "orchestration not logic" framing up top.
- GENESIS-V2-BLUEPRINT.md — added constitution row + direction-update additions to the deliverable map; roadmap now folds Research Vault into Phase 5, explainability/auto-invoke into Phase 8, continuity as Phase 10.
- README.md — TRADEW-OS.md is now reading-order step 1; new docs registered.

## Bottom line for future work
TRADEW-OS.md is now the top of the doc hierarchy — read it first, reference it in anything new. The extend-don't-duplicate philosophy is now constitutional (§2.1). Nothing was implemented; still design/pre-implementation, Phase 1 (HTML→React) remains the first build step. No code, no deletions.

## Related
- [[../_INDEX.md]]
- [[2026-07-17 - Genesis v2 blueprint added as new product-architecture docs]]
- [[../Research/2026-07-17 - Sentinel Brain audit]]
- [[2026-07-17 - Obsidian Knowledge Layer adopted]]
