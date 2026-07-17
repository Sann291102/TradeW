---
type: decision
date: 2026-07-17
tags: [decision, knowledge-management]
status: accepted
---

# Decision: Adopt an Obsidian knowledge layer for engineering memory

## For future Claude
Read this before assuming Sentinel's Persistent Knowledge Brain is TradeW's only memory system, or before wondering why a second one exists. This vault (`TradeW/knowledge/`) is a deliberately separate, second memory system — read the scope split below before adding anything here.

## Context
Sentinel already has a production "Persistent Knowledge Brain" (`services/sentinel/src/brain/`) — Postgres + pgvector, `PrismaMemoryStore` / `PrismaKnowledgeGraph`, entity/concept graph, ~78% complete per [SENTINEL_BRAIN_PROGRESS.md](../../SENTINEL_BRAIN_PROGRESS.md). That system stores *trading-domain* knowledge (market patterns, symbol history, pattern outcomes) consumed by the live Sentinel agent at runtime.

Separately, the user requested an Obsidian-based memory layer so AI coding agents (Claude Code, and any other coding assistants used on this repo) stop re-deriving the same architecture research and re-solving the same problems every session — an *engineering*-domain memory problem, not a trading-domain one.

## Decision
Build the Obsidian layer as `TradeW/knowledge/` — a new, git-tracked vault inside the monorepo, scoped to **engineering/development knowledge for AI coding agents only**:
- Architecture and project decisions, engineering patterns, debugging discoveries, research summaries, agent-responsibility notes, implementation plans, API integration notes.
- Explicitly excluded: live market data, real-time analytics, trading-domain memory (stays in Sentinel's Postgres Brain), raw session logs/transcripts.

**Rejected — reuse the user's personal Obsidian Mind vault** (`C:/Users/vivek/my-vault`): already mixes career/performance-review content with engineering notes, and isn't git-tracked with this repo, so it wouldn't travel with the codebase or be reviewable via PR alongside the code it documents.

**Rejected — wire this into the production Sentinel/TradeW-AI services at runtime**: would duplicate or compete with the already-built Postgres Brain, and [docs/product-architecture/README.md](../docs/product-architecture/README.md) explicitly gates new implementation on review ("no implementation should begin against it until it's reviewed") — a production integration is a separate decision the user hasn't made yet.

## Workflow
For every substantive task: search this vault (start at [[_INDEX.md]], then grep) → retrieve and reuse existing notes instead of re-deriving → reason only on what's genuinely new → if the result has long-term value, create or update the relevant note → link related notes. Full protocol lives in the project root `CLAUDE.md`, Rule 4.

## Consequences
- `_INDEX.md` is the entry point — read it before searching, to keep token usage low.
- Before adding a note, search for an existing one on the same topic; update/link rather than duplicate.
- If a future task needs the production agents themselves to consume durable knowledge at runtime, that's a new architecture decision requiring product-architecture review — not an extension of this vault.

## Related
- [[_INDEX.md]]
- [SENTINEL_BRAIN_PROGRESS.md](../../SENTINEL_BRAIN_PROGRESS.md)
- [docs/product-architecture/README.md](../docs/product-architecture/README.md)
