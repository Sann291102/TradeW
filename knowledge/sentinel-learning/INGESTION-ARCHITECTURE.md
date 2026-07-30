# Ingestion Architecture

How the Sentinel Learning Vault feeds the Sentinel Brain. This document is the design specification for Phase 2 — no implementation exists yet.

## Architecture overview

```
                    AUTHORING LAYER                                    RUNTIME LAYER
                    (this vault)                                       (Sentinel Brain)

  ┌──────────────────────┐
  │  Trading Books       │
  │  docs/Trading Books/ │
  │  (14 PDFs, read-only)│
  └──────────┬───────────┘
             │
     ┌───────▼───────┐
     │ Document Parser│  Extract text from PDF
     │ (pdf-parse)    │  Preserve chapter/section structure
     └───────┬───────┘
             │
     ┌───────▼───────┐
     │ Chunker       │  Split into semantically coherent sections
     │               │  Target: 500-1000 tokens per chunk
     │               │  Preserve: chapter, section, page metadata
     └───────┬───────┘
             │
     ┌───────▼───────────────┐
     │ Concept Extractor     │  Identify trading concepts in each chunk
     │ (LLM-assisted)        │  Map to existing 15 Brain domains
     │                       │  Detect relationships between concepts
     │                       │  Extract strategy structures
     │                       │  Identify psychological patterns
     └───────┬───────────────┘
             │
     ┌───────▼───────────────┐
     │ Vault Writer          │  Create notes in this vault:
     │                       │  - Book notes in 10 Books/
     │                       │  - Concept drafts in 15 Generated Concepts/
     │                       │  - AI summaries in 11 AI Summaries/
     │                       │  - Strategy analyses in 02 Strategies/
     │                       │  - Psychology patterns in 06 Psychology/
     └───────┬───────────────┘
             │
     ┌───────▼───────┐
     │ Human Review  │  Review generated notes for:
     │ (manual)      │  - Accuracy
     │               │  - No directive language
     │               │  - No verbatim reproduction
     │               │  - Correct domain mapping
     │               │  - Relationship accuracy
     └───────┬───────┘                                    ┌─────────────────────────────┐
             │                                            │  Sentinel Brain              │
     ┌───────▼───────────────┐                           │                             │
     │ Brain Ingestion       │                           │  ┌───────────────────────┐  │
     │                       │──── Concepts ────────────▶│  │ ConceptNode           │  │
     │ Two paths:            │     (YAML promotion)      │  │ ConceptEdge           │  │
     │                       │                           │  │ knowledge-base/*.yaml │  │
     │ 1. Concept promotion  │                           │  └───────────────────────┘  │
     │    Vault note →       │                           │                             │
     │    knowledge-base/    │                           │  ┌───────────────────────┐  │
     │    YAML → ontology:   │                           │  │ MemoryRecord          │  │
     │    seed               │──── Memory ──────────────▶│  │ (pgvector embeddings) │  │
     │                       │     (LearnInput API)      │  │ GraphNode / GraphEdge │  │
     │ 2. Memory ingestion   │                           │  └───────────────────────┘  │
     │    Vault note →       │                           │                             │
     │    ConceptLearning    │                           │  ┌───────────────────────┐  │
     │    Engine.ingest()    │                           │  │ Strategy Engine        │  │
     │                       │──── Strategy proposals ──▶│  │ strategy-rules.ts     │  │
     │                       │     (code review)         │  │ strategy-engine.ts    │  │
     └───────────────────────┘                           │  └───────────────────────┘  │
                                                          └─────────────────────────────┘
```

## Two ingestion paths

### Path 1: Concept promotion (structured knowledge)

For well-defined trading concepts that should become permanent nodes in the knowledge graph.

```
Vault note (01 Concepts/) → Review → knowledge-base/<domain>/<id>.yaml → ontology:seed → ConceptNode + ConceptEdge
```

**Interface:** `knowledge-base/` YAML format (see `knowledge-base/README.md`)
- Required fields: id, name, domain, summary, definition, explainer, observable_when, relations
- Validation: `parseConcept()` in `concept.schema.ts`
- Lint: `lintDirectiveLanguage()` checks all user-facing fields
- 15 domains, 13 relation types (with polarity + transitivity)
- Seeding is idempotent — never overwrites `learnedWeight` or `ConceptObservation` rows

### Path 2: Memory ingestion (unstructured knowledge)

For book summaries, AI-generated analysis, research notes, and other free-text knowledge that enriches the Brain's retrieval without requiring a formal concept structure.

```
Vault note (10 Books/, 11 AI Summaries/) → ConceptLearningEngine.ingest(LearnInput) → MemoryRecord + GraphNode + GraphEdge
```

**Interface:** `LearnInput` from `packages/ai-core/src/brain/interfaces.ts`
```typescript
interface LearnInput {
  kind: LearnEventKind;  // 'observation' | 'pattern' | 'research' | 'learning' | 'qa'
  content: string;
  userId?: string | null;
  namespace?: string;      // use 'sentinel-learning' for vault-sourced knowledge
  sourceReference?: string; // e.g. 'book:day-traders-bible:ch3'
  tags?: string[];
}
```

The `ConceptLearningEngine` automatically:
1. Summarizes and embeds the content (via base `LearningEngine`)
2. Extracts entities (symbols, patterns, sectors)
3. Writes entities onto the `MemoryRecord`
4. Upserts `GraphNode`s for each entity
5. Creates `mentions` and `co_occurs_with` edges

### Path 3: Strategy proposals (executable knowledge)

For strategy patterns identified in books. These NEVER auto-deploy.

```
Vault note (02 Strategies/) → Human proposes → Code review → strategy-rules.ts changes → strategy-engine.service.ts definition → test → deploy
```

**Interface:** `StrategyDefinition` from `strategy-engine.service.ts`
```typescript
interface StrategyDefinition {
  id: string;
  name: string;
  rules: string[];           // must be known rule names from strategy-rules.ts
  invalidations: string[];
  idealSession?: string;     // IST window 'HH:mm-HH:mm'
  baseConfidenceWeight: number; // 0..1
  biasSource: BiasSource;    // orb | cpr | vwap | ema | sweep | failed-breakout | structure | wyckoff | trend
  enabled: boolean;
  source: 'built-in' | 'user-yaml';
}
```

New rules require implementation in `strategy-rules.ts` (code, not YAML).

## What the pipeline never does

1. **Never modifies source books** — books are read-only input
2. **Never auto-promotes concepts** — human review is always required
3. **Never creates executable strategy rules** — rules are code, reviewed separately
4. **Never reproduces copyrighted text** — extracts concepts, creates original summaries
5. **Never writes directive language** — all output passes `lintDirectiveLanguage()`
6. **Never overwrites runtime learning** — `learnedWeight`, support/refute counters, and `ConceptObservation` rows are preserved across reseeds

## Metadata preservation

Each ingested piece carries provenance:
- `sourceReference`: `book:<book-id>:ch<N>` or `vault:<folder>/<note-id>`
- `namespace`: `sentinel-learning`
- `tags`: Brain domain(s), source type, ingestion batch ID
- `userId`: null (system knowledge, not user-specific)

## Chunking strategy

- **Target size:** 500-1000 tokens per chunk
- **Boundaries:** respect chapter/section breaks; never split mid-paragraph
- **Overlap:** 50-token overlap between chunks for context continuity
- **Metadata per chunk:** book title, chapter, section, page range, chunk index

## Embedding model

Uses whatever embedding provider `packages/ai-core` is configured with (currently supports OpenAI, NVIDIA NIM, or local). The Brain's `MemoryStore` handles embedding generation transparently — the ingestion pipeline passes raw text via `LearnInput.content`.

## Deduplication

Before ingesting a vault note:
1. Search existing `MemoryRecord`s by `sourceReference`
2. If found, compare content hash — skip if unchanged
3. If changed, update the existing record rather than creating a duplicate

Before promoting a concept:
1. Check `knowledge-base/` for an existing concept with the same or similar `id`
2. If found, update rather than duplicate
3. Run `ontology:validate` to catch dangling relations

## Implementation plan (Phase 2)

1. **Book parser script** — `services/sentinel/scripts/ingest-books.ts`
2. **Vault writer** — generates Obsidian notes from parsed chunks
3. **Concept extractor** — LLM-assisted concept identification
4. **Promotion helper** — converts reviewed vault notes to `knowledge-base/` YAML
5. **Memory ingester** — batch `ConceptLearningEngine.ingest()` calls
6. **Progress tracker** — updates book note checklists
