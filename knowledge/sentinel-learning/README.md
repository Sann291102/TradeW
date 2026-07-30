# Sentinel Learning Vault

The authoring and research layer for Sentinel's knowledge. This Obsidian vault is the **upstream source** that feeds the Sentinel Brain — it is never read at runtime.

## This is not the Brain

| | This vault (`knowledge/sentinel-learning/`) | Sentinel Brain (`services/sentinel/src/brain/`) |
|---|---|---|
| What it is | Obsidian vault — human and AI authored notes | Postgres + pgvector + Knowledge Graph |
| Purpose | Research, author, review, refine knowledge | Runtime reasoning, retrieval, scoring |
| Read by | Humans, coding agents, ingestion pipeline | Sentinel service on every `/observe` call |
| Contains | Notes, summaries, strategy docs, book extracts | `MemoryRecord`, `ConceptNode`, `GraphEdge` |
| Format | Markdown (Obsidian) | Structured rows + embeddings |
| When it changes | Continuously — authors add, revise, review | On ingestion pipeline runs and runtime learning |
| Governed by | This README | `SENTINEL-KNOWLEDGE-GRAPH.md`, `ARCHITECTURE.md` |

## This is not `knowledge/` (the parent)

The parent `knowledge/` directory is the **engineering vault** for coding agents working on the TradeW codebase (architecture decisions, debugging notes, implementation plans). It is governed by `CLAUDE.md` Rule 4 and is never wired into the Sentinel runtime.

This vault holds **market and trading knowledge** — concepts, strategies, psychology, book-derived insights — that eventually flows into the Brain. The two vaults have completely different audiences, purposes, and governance. Do not mix them.

## This is not `knowledge-base/`

`knowledge-base/` at the repo root holds the **canonical concept ontology** — 66+ YAML files in 15 domains, validated by `concept.schema.ts`, seeded into Postgres by `ontology:seed`. Those are the Brain's structured, version-controlled source of truth.

This vault is the **upstream** of `knowledge-base/`. Research, drafts, and AI-generated summaries live here first. When a concept is refined and reviewed, it graduates into a `knowledge-base/` YAML file through a deliberate promotion step — never automatically.

## Knowledge flow

```
Trading Books (docs/Trading Books/)
        │
        ▼
┌─────────────────────────────┐
│  Sentinel Learning Vault    │  ◄── You are here
│  (knowledge/sentinel-       │
│   learning/)                │
│                             │
│  Research → Draft → Review  │
│  Book notes, concept drafts │
│  strategy analysis, psych   │
│  patterns, AI summaries     │
└──────────┬──────────────────┘
           │ Ingestion pipeline (Phase 2)
           ▼
┌─────────────────────────────┐
│  Concept Ontology           │
│  (knowledge-base/*.yaml)    │
│                             │
│  Validated, linted, semver  │
│  15 domains, 13 relations   │
└──────────┬──────────────────┘
           │ ontology:seed (existing)
           ▼
┌─────────────────────────────┐
│  Sentinel Brain             │
│  (Postgres + pgvector)      │
│                             │
│  ConceptNode, ConceptEdge   │
│  MemoryRecord, GraphNode    │
│  GraphEdge                  │
│                             │
│  ↕ Runtime learning         │
│  ConceptObservation         │
│  ConceptPromotion           │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  Sentinel Runtime           │
│  Strategy Engine, Confidence│
│  Engine, Market Intelligence│
│  Orchestrator, Vocabulary   │
└─────────────────────────────┘
```

**Key principle:** the vault teaches concepts; it never creates executable trading logic. Strategy rules remain explicitly defined in code (`strategy-rules.ts`) and reviewed before activation. Books improve understanding, reasoning, and explanations — not detection math.

## Vault structure

| Folder | Purpose |
|---|---|
| `00 Inbox` | Unprocessed notes, raw captures, quick ideas |
| `01 Concepts` | Refined concept notes ready for review |
| `02 Strategies` | Strategy analysis, documentation, rule mappings |
| `03 Indicators` | Technical indicator explanations and behavior notes |
| `04 Market Structure` | Structure, trend, range, timeframe hierarchy |
| `05 Institutional Concepts` | ICT, SMC, order flow, institutional footprints |
| `06 Psychology` | Trading psychology patterns and behavioral analysis |
| `07 Risk Management` | Position sizing, exposure, drawdown, risk controls |
| `08 Options` | Options-specific knowledge — greeks, IV, chains |
| `09 Futures` | Futures, basis, rollover, cost of carry |
| `10 Books` | Book summaries, chapter notes, extracted insights |
| `11 AI Summaries` | AI-generated summaries and synthesis |
| `12 Knowledge Graph` | Relationship maps, domain overviews, gap analysis |
| `13 Research` | External research summaries with citations |
| `14 Experiments` | Hypotheses, backtesting notes, observations |
| `15 Generated Concepts` | AI-proposed concepts awaiting human review |
| `16 Reviews` | Periodic vault reviews, quality audits |
| `Templates` | Note templates for consistent authoring |
| `Attachments` | Images, diagrams, charts referenced by notes |

## Templates

Templates live in `Templates/` and follow Obsidian template conventions. Each template includes frontmatter fields that map to the Brain's data model, so notes authored here can be ingested cleanly in Phase 2.

Available templates:
- **Concept** — maps to `knowledge-base/` YAML and ultimately to `ConceptNode`
- **Strategy** — maps to `StrategyDefinition` in `strategy-engine.service.ts`
- **Book** — structured book/chapter summary, never verbatim reproduction
- **Psychology** — behavioral pattern analysis, maps to `trading-psychology` domain
- **Indicator** — technical indicator explanation, maps to `technical-analysis` domain
- **Market Structure** — structural concept, maps to `market-structure` domain

## Authoring rules

1. **No directive language.** Describe what is observable, never what to do. The Brain's `concept.schema.ts` lints for imperative trading advice — notes authored here should pass the same bar. "Traders often experience the urge to add to a losing position" is fine; "Add to your position here" is not.

2. **No verbatim book reproduction.** Extract concepts, summarize ideas, build original educational notes. Never copy paragraphs from copyrighted sources. Short attributed quotes (under 15 words) for context are acceptable.

3. **Link liberally.** Use `[[concept-name]]` links between notes. The ingestion pipeline (Phase 2) will use these links to propose `ConceptRelation` edges in the knowledge graph.

4. **Use frontmatter.** Every note should have YAML frontmatter with at least `type`, `domain`, `status`, and `tags`. This metadata drives the ingestion pipeline.

5. **Concepts graduate, they don't teleport.** A concept starts as a draft in this vault, gets reviewed, and only then is manually promoted to a `knowledge-base/` YAML file. The ingestion pipeline (Phase 2) will assist but never auto-promote.

6. **Never delete.** Mark notes as `status: deprecated` with a `superseded_by` field instead. This mirrors the Brain's own rule (CLAUDE.md Rule 1 applied to data).

## Relationship to the existing Brain

The Brain has three layers this vault maps to:

### 1. Concept Ontology (`knowledge-base/` → `ConceptNode`/`ConceptEdge`)
- 15 domains: market-structure, price-action, options, technical-analysis, volume, market-microstructure, macroeconomics, trading-psychology, risk-management, institutional-concepts, company-fundamentals, derivatives, sentiment, patterns, glossary
- 13 relation types: is_a, part_of, causes, precedes, confirms, contradicts, invalidates, depends_on, similar_to, measured_by, mitigates, amplifies, example_of
- Each has polarity (supporting/opposing/neutral) and transitivity
- Vault notes in `01 Concepts` through `09 Futures` map to these domains

### 2. Memory Store (`MemoryRecord` + pgvector embeddings)
- Free-text knowledge chunks with vector embeddings
- Ingested via `ConceptLearningEngine.ingest(LearnInput)`
- `LearnInput`: `{kind, content, userId?, namespace?, sourceReference?, tags?}`
- Vault notes in `10 Books` and `11 AI Summaries` would feed this layer

### 3. Strategy Engine (`StrategyDefinition` + `strategy-rules.ts`)
- Declarative strategy definitions: id, name, rules[], invalidations[], biasSource, confidence weight
- ~40 named rule predicates in the rule vocabulary
- Vault notes in `02 Strategies` document these but never create new executable rules
- New rules require code changes in `strategy-rules.ts`, reviewed and tested

## Future ingestion architecture (Phase 2 — not implemented)

The ingestion pipeline will:
1. **Parse** books from `docs/Trading Books/` (PDF text extraction)
2. **Chunk** documents into semantically coherent sections
3. **Extract** concepts, entities, and relationships
4. **Draft** vault notes in `15 Generated Concepts/` for human review
5. **Ingest** reviewed notes into the Brain via `ConceptLearningEngine.ingest()`
6. **Propose** new `knowledge-base/` YAML files for concepts that graduate
7. **Link** related concepts using the 13-relation vocabulary

The pipeline never modifies source books, never auto-promotes concepts, and never creates executable strategy rules.

## Getting started

1. Open this folder as a vault in Obsidian
2. Enable the Templates core plugin and set `Templates` as the template folder
3. Create new notes using the templates (`Ctrl/Cmd + T` or the template picker)
4. Start in `00 Inbox` for quick captures; move to the right folder when refined
5. Link related notes with `[[wikilinks]]`
6. Use tags from the Brain's domain vocabulary for consistency
