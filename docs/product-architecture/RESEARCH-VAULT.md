# Research Vault — Product Blueprint

Status: design, pre-implementation. New system introduced by the Genesis v2 direction update (§11). Governed by [`TRADEW-OS.md`](TRADEW-OS.md) §4 (knowledge lifecycle).

## 1. The distinction this exists to enforce

**Research is raw evidence. Knowledge is validated understanding.** These are different things and the platform must never conflate them:

| | Research Vault | Knowledge Graph (`KNOWLEDGE-GRAPH.md`) |
|---|---|---|
| Contains | raw, unvalidated evidence as collected | validated, confidence-scored, relationship-linked understanding |
| Trust level | provisional — may be wrong, incomplete, or contradictory | institutional truth, citable by Sentinel/Learning Hub |
| Entry gate | low — evidence enters freely as it's gathered | high — only after the validation pipeline clears it |
| Lifecycle | may be discarded, superseded, or promoted | versioned, never deleted (`TRADEW-OS.md` §2.7) |
| Consumers | the Continuous Learning Pipeline's validation stages | Learning Hub, Sentinel, TradeW AI research answers |

A piece of research that never passes validation stays in the Vault as evidence (useful for audit and for re-validation later if corroboration arrives) but never becomes Knowledge. This is the direction update's rule verbatim: *"Only validated research should become institutional knowledge."*

## 2. Extend the Brain, don't build a new store

Per `TRADEW-OS.md` §2.1 (extend before you build), the Research Vault is **not a new database** — it's a distinct record class within Sentinel's existing Postgres+pgvector Brain (`PrismaMemoryStore`, audited real, not stubbed). Concretely:

- Research records live in the same store as Knowledge nodes, tagged with a `stage` discriminator (`research` vs `knowledge`) and a `validation_status` (`raw` / `validating` / `validated` / `rejected` / `superseded`).
- Consumer queries filter by stage: Sentinel/Learning Hub read only `stage=knowledge, validation_status=validated`; the pipeline's validation stages read `stage=research`.
- Embeddings, entity extraction (`ConceptLearningEngine`), and semantic search work identically across both — the difference is trust/visibility, enforced by the stage filter, not a separate engine.

This keeps the "extend the Sentinel Brain" philosophy the direction update explicitly praised, rather than standing up a parallel research database.

## 3. Research sources

Per the direction update §11:

- Market data (`services/market-data`)
- News (shared feed with TradeW AI's News Analysis agent)
- Macro events / economic calendar
- Filings (company disclosures)
- Historical observations (prior Sentinel `observe()` outputs)
- Community discussions

Each source is ingested by its corresponding agent (`AGENT-ARCHITECTURE.md` — News Agent, Market Agent, Research Agent) into a Research record with provenance (source, timestamp, raw payload reference) attached. Provenance is mandatory — it's what makes the eventual Knowledge node explainable (`EXPLAINABILITY.md` requires "data sources").

## 4. Promotion path (Research → Knowledge)

The Research Vault is the **first stop** in the Continuous Learning Pipeline, not a parallel track:

```
Sources → Research record (stage=research, validation_status=raw)   ← Research Vault
        → Historical comparison + News correlation (validating)
        → Validation Engine + Confidence scoring
        → promote to Knowledge node (stage=knowledge, validated)     ← Knowledge Graph
```

See `CONTINUOUS-LEARNING-PIPELINE.md` for the full stage list. The Vault owns the left half (raw → validating); the Knowledge Graph owns the right half (validated onward).

## 5. Explainability hook

When Sentinel or TradeW AI cites a piece of Knowledge, the explainability contract (`EXPLAINABILITY.md`) requires it to be able to trace back to the **Research records** that supported it — the raw evidence, its sources, and the validation confidence that promoted it. The Research Vault is therefore also the evidence backing store for every explainable premium conclusion, not just a pipeline staging area.

## 6. Open items

- Exact `stage`/`validation_status` column additions to the Brain's Prisma schema — an implementation-time migration, designed when Phase 5/6 (`GENESIS-V2-BLUEPRINT.md` §7) is built, not now.
- Retention policy for long-unvalidated `raw` research (keep-forever for audit vs. time-boxed archive) — a tuning decision, flagged open.
