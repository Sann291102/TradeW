# Continuous Learning Pipeline — Product Blueprint

Status: design, pre-implementation. Cross-cutting system connecting live market data to the [Research Vault](RESEARCH-VAULT.md), [Knowledge Graph](KNOWLEDGE-GRAPH.md) and [Learning Hub](LEARNING-HUB.md), added by the Genesis v2 brief. Governed by [`TRADEW-OS.md`](TRADEW-OS.md) §4 (knowledge lifecycle). Orchestrated by n8n as a background agent sequence (`AGENT-ARCHITECTURE.md` §3, `N8N-WORKFLOWS.md`) — n8n sequences the stages; every stage's reasoning lives in an agent.

## 1. Pipeline stages

The core lifecycle rule (`TRADEW-OS.md` §4): **evidence enters the Research Vault as raw, and only becomes Knowledge after validation.** The left half of this pipeline populates the Research Vault; the Validation Engine is the one-way gate; the right half writes validated Knowledge.

```
Realtime Market (services/market-data)
        │
        ▼
Market Data Agent            — detects candidate events (breakouts, unusual volume/OI, news-correlated moves)
        │
        ▼
Research Vault: raw record   — candidate + provenance written as stage=research, status=raw (RESEARCH-VAULT.md §4)
        │
        ▼
Research Agent                — TradeW AI's existing Company/News/Technical Analysis agents, invoked on the candidate
        │
        ▼
Historical Comparison Agent  — queries Knowledge Graph for similar past Market Event/Pattern nodes
        │
        ▼
News Research Agent           — correlates with news feed (shared with TradeW AI's News Analysis agent)
        │                        [research record now status=validating]
        ▼
Validation Engine             — NEW component, §2 — the one-way gate (TRADEW-OS.md §4)
        │
        ▼
Confidence Score              — attached to the candidate
        │
        ▼   (promote only if score clears threshold; else record stays in Vault as status=rejected)
Knowledge Graph                — node + edges written as stage=knowledge, status=validated (KNOWLEDGE-GRAPH.md §5)
        │
        ▼
Concept Learning Engine        — existing Sentinel Brain component, extracts entities, links edges
        │
        ▼
Learning Hub                   — validated Concept/Historical Example/Outcome nodes become lesson candidates
        │
        ▼
Sentinel Brain                 — same Postgres store; new nodes are immediately available as historical context
        │
        ▼
Permanent Storage              — archived/versioned, never deleted (KNOWLEDGE-GRAPH.md §4)
```

The Research Vault and Knowledge Graph are the **same physical store** (Sentinel's Brain), separated by the `stage`/`validation_status` discriminator, not two databases (`RESEARCH-VAULT.md` §2) — consistent with the "extend, don't duplicate" rule (`TRADEW-OS.md` §2.1).

## 2. Validation Engine — new component

This is the one genuinely new backend component the pipeline requires (everything upstream reuses existing TradeW AI agents and market-data; everything downstream reuses the Sentinel Brain). Responsibilities:

- Cross-checks the Research/Historical Comparison/News agents' outputs for agreement (not a single LLM call self-grading its own output — at minimum, corroboration across ≥2 independent signals, same "composite signal, not single trigger" discipline as Sentinel's Trap Detection, `SENTINEL.md` §3).
- Emits a 0–1 confidence score, attached to the candidate node before it's written.
- Runs as part of `services/tradew-ai` (it's a research-pipeline concern, not a new runtime) — no new service.

## 3. Nothing enters permanent memory unvalidated

This is the pipeline's core guarantee, matching the brief verbatim. A candidate that fails validation is discarded, not silently retried into existence — if the same pattern recurs with better corroboration later, it re-enters the pipeline as a new candidate on its own merits.

## 4. Cadence

Not every market tick runs the full pipeline — that would flood the graph with noise. The Market Data Agent's event-detection step is the gate: only candidates that look like a genuine pattern/event trigger the downstream chain. Exact thresholds are a tuning decision made once `services/market-data`'s event-detection logic exists, not specified here.

## 5. Relationship to Sentinel's real-time observation loop

Sentinel's existing `observe()` flow (`sentinel-orchestrator.service.ts`) is user-triggered/real-time and already writes to the same Brain. This pipeline is the **background, non-user-triggered** counterpart — it doesn't wait for a specific user's action, it continuously mines the market for material worth adding to permanent memory. The two write to the same store but run on different triggers; neither depends on the other's completion.

## 6. Data dependencies

- `services/market-data` — realtime OHLC/volume/OI/news feed
- `services/tradew-ai` — Company/News/Technical Analysis agents (reused, not duplicated) + new Validation Engine
- Sentinel Brain / Knowledge Graph (Postgres + pgvector) — write target
