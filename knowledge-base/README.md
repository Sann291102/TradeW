# `knowledge-base/` — Sentinel's Concept Ontology

The canonical, version-controlled source of truth for the **Sentinel Concept
Knowledge Graph**: the structured body of market knowledge Sentinel reasons
over to explain what it observes.

Canonical spec: [`docs/product-architecture/SENTINEL-KNOWLEDGE-GRAPH.md`](../docs/product-architecture/SENTINEL-KNOWLEDGE-GRAPH.md).

## This is not `knowledge/`

Two directories in this repo have similar names and completely different jobs.
Confusing them is the single most likely mistake here.

| | `knowledge/` | `knowledge-base/` (this folder) |
|---|---|---|
| What it is | Obsidian vault, engineering memory for coding agents | Sentinel's market-concept ontology |
| Audience | Developers and Claude, working *on* TradeW | Sentinel's runtime, and users through it |
| Contains | Architecture decisions, debugging notes, plans | Market concepts and their semantic relations |
| Unit | A markdown note about the codebase | A YAML concept about markets |
| Runtime | Never wired into production | Seeded into Postgres, read on every observation |
| Governed by | `CLAUDE.md` Rule 4 | `SENTINEL-KNOWLEDGE-GRAPH.md` |

Market knowledge never goes in `knowledge/`. Engineering knowledge never goes
here.

## Layout

One folder per domain, one file per concept, named `<concept-id>.yaml`:

```
knowledge-base/<domain>/<concept-id>.yaml
```

The fifteen domains are closed — they are defined in
[`services/sentinel/src/brain/ontology/domains.ts`](../services/sentinel/src/brain/ontology/domains.ts)
and are an indexed query dimension. A concept that fits none of them is a
reason to discuss the taxonomy, not to add a folder.

## Concept file format

```yaml
id: liquidity-sweep          # kebab-case, globally unique, must match the filename
name: Liquidity Sweep
domain: price-action         # must be one of the 15
aliases: [stop hunt, liquidity grab]
status: canonical            # canonical | proposed | deprecated
maturity: established        # established | emerging | contested
confidence: 0.85             # 0..1 — gates user-facing exposure
summary: One line, <= 220 chars.
definition: >
  Precise reference prose.
explainer: >
  The educational text users actually read.
observable_when:             # evidence cues, never thresholds to act on
  - price extends beyond a prior swing point then reverses within a few bars
relations:
  - to: stop-loss-clustering
    type: depends_on         # must be one of the 13 relation types
    weight: 0.95
    note: Why this link exists.
examples:
  - title: Prior-day low swept before reversal
    context: What was observed.
    outcome: What followed.
    date: 2024-06-04
sources: []
tags: []
```

`status: deprecated` additionally requires `superseded_by`.

## The thirteen relation types

The vocabulary is **closed** — defined in
[`relations.ts`](../services/sentinel/src/brain/ontology/relations.ts). Each
carries a polarity and a transitivity flag that the reasoner depends on, so an
unknown relation would silently weight conclusions wrong rather than fail
loudly.

| Relation | Reads (from → to) | Chains? | Polarity |
|---|---|---|---|
| `is_a` | is a kind of | yes | neutral |
| `part_of` | is part of | yes | neutral |
| `causes` | causes | yes | supporting |
| `precedes` | typically precedes | yes | neutral |
| `confirms` | confirms | no | supporting |
| `contradicts` | contradicts (symmetric) | no | opposing |
| `invalidates` | invalidates | no | opposing |
| `depends_on` | depends on | yes | neutral |
| `similar_to` | is similar to (symmetric) | no | neutral |
| `measured_by` | is measured by | no | supporting |
| `mitigates` | mitigates | no | opposing |
| `amplifies` | amplifies | no | supporting |
| `example_of` | is an example of | no | neutral |

There is no `contains`, `has_subtype` or `caused_by` — the vocabulary is
directional, so declare the edge on the more specific concept and point it at
the more general one.

## Rules

1. **Every concept links to at least one other.** An isolated concept cannot be
   reasoned over and is treated as an authoring error.
2. **No directive language.** Concepts describe what is observable, never what
   to do. `summary`, `definition`, `explainer` and `observable_when` are
   automatically linted for imperative trading advice, per `CLAUDE.md` Rule 2
   and `ARCHITECTURE.md` §1.3. Descriptive prose about behaviour is fine
   ("the urge to book profits early"); instructions are not.
3. **Never delete a concept.** Set `status: deprecated` and `superseded_by`.
   The graph is permanent so that past explanations remain traceable —
   `CLAUDE.md` Rule 1 applied to data.
4. **Contested knowledge is welcome, dishonest confidence is not.** Set
   `maturity: contested` and a low `confidence` (see `max-pain.yaml` and
   `put-call-ratio.yaml`). Carrying a weakly-evidenced concept honestly is more
   useful than omitting it and leaving users to meet it without the caveat.
5. **Relations are declared once**, on whichever side reads more naturally.
   The traversal layer walks edges in both directions.

## Validating and seeding

```bash
npm run ontology:validate   # parse + lint every file, resolve all relation targets
npm run ontology:seed       # validate, then project into Postgres (idempotent)
```

Validation runs with no database and is safe to run anywhere. Seeding rewrites
only canonical columns — it never touches `learnedWeight`, the support/refute
counters, or `ConceptObservation` rows, so runtime learning survives every
reseed.

## How the ontology grows

YAML is canonical; Postgres is a projection. Sentinel **never edits these
files**. When runtime observation suggests a new concept or relation, it
writes a `ConceptPromotion` row for human review. A person accepts it by
editing YAML here, and the next reseed makes it canonical.

That one-way flow is deliberate: it keeps the ontology reviewable in pull
requests as it grows toward thousands of concepts, and prevents the runtime
from silently rewriting its own source of truth.
