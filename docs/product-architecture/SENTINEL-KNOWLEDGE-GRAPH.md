# Sentinel Concept Knowledge Graph — Reasoning Ontology

Status: **Phase 1 + 2 implemented and verified** (2026-07-21); a read/reasoning surface has since landed (2026-08). Schema, ontology, loader, reasoning layer, reinforcement loop and seeding are live against Postgres. The concept graph is now reachable at runtime via `services/sentinel`'s `reasoning.controller.ts` and is surfaced in the `apps/admin` reasoning/knowledge consoles — so §10's "Read API and UI are not built" is now largely closed (a trader-facing UI in `apps/web` is still the open piece).

Governed by [`TRADEW-OS.md`](TRADEW-OS.md) §4 (knowledge lifecycle). This is the structured market knowledge Sentinel reasons over to *explain* what it observes. It is a core product capability, not an internal tool.

---

## 1. Three things called "knowledge" — do not confuse them

| | `knowledge/` | `knowledge-base/` | `GraphNode`/`GraphEdge` |
|---|---|---|---|
| **What** | Obsidian vault | Concept ontology (this doc) | Entity graph |
| **Unit** | A note about the codebase | A market concept | A symbol, sector, memory record |
| **Edges mean** | "these notes link" | "this causes / contradicts / confirms that" | "these co-occurred" |
| **Audience** | Developers and Claude | Sentinel's runtime, users through it | Sentinel internals |
| **Runtime** | Never | Seeded into Postgres, read per observation | Live, written by `ConceptLearningEngine` |
| **Governed by** | `CLAUDE.md` Rule 4 | This document | Brain Phase 1 design |

The user-facing distinction that matters: **the vault graph visualises files; this graph reasons about markets.** They share no tables, no code path and no audience.

### Relationship to the entity graph

`GraphNode`/`GraphEdge` already exists and stays exactly as it is. It records that `NSE:RELIANCE` and `bull_trap` appeared together — useful, but nothing can be *reasoned* from `co_occurs_with`. The concept graph records what things mean, which is what makes traversal produce an explanation.

The two are bridged by `ConceptObservation.symbol`, not by a foreign key. That is deliberate: the concept graph must stay instrument-agnostic so a concept learned on one symbol applies to all of them.

---

## 2. Relationship to `KNOWLEDGE-GRAPH.md`

[`KNOWLEDGE-GRAPH.md`](KNOWLEDGE-GRAPH.md) specifies the **evidence lifecycle** — the News → Market Event → Pattern → … → Lesson chain by which raw observation becomes validated knowledge, and its permanence and validation rules.

This document specifies the **concept ontology** — the durable, timeless knowledge that evidence is interpreted *against*. They are complementary layers over one store, not competing designs:

- `KNOWLEDGE-GRAPH.md` answers "how does something become knowledge?"
- This answers "what does Sentinel know, and how does knowing it produce an explanation?"

Both extend Sentinel's Brain rather than adding infrastructure, per `KNOWLEDGE-GRAPH.md` §2. The permanence rule (§4 there) and validation gate (§5 there) apply here unchanged and are implemented in §6 and §7 below.

---

## 3. The living-ontology model

```
knowledge-base/*.yaml          ←── humans author and review here (canonical)
        │
        │  ontology:seed  (idempotent, checksum-skipped)
        ▼
ConceptNode / ConceptEdge      ←── runtime graph, reasoned over per observation
        │                            canonical columns │ learned columns
        │                                              ▲
        │  observation                                 │ derived from
        ▼                                              │
ConceptObservation             ─────────────────────────┘
   (append-only)
        │
        │  repeated support
        ▼
ConceptPromotion               ←── human reviews, edits YAML, reseeds
   (queue, never auto-merged)
```

Four properties this buys, each load-bearing:

1. **YAML is the source of truth.** The ontology stays reviewable in pull requests as it grows toward thousands of concepts. A knowledge change is a diff, not an opaque database write.
2. **Postgres is a projection.** It can be dropped and rebuilt from YAML at any time.
3. **Runtime learning is separate and additive.** Reinforcement writes `learnedWeight` and counters; it never touches `weight`. Reseed rewrites canonical columns; it never touches learned ones. Neither can corrupt the other.
4. **Sentinel proposes, humans dispose.** The runtime cannot promote its own findings into canonical knowledge. It queues them. This is the safeguard against the graph drifting into self-confirming nonsense over months of unsupervised operation.

**Verified end-to-end:** a reseed after 11 observations preserved `learnedWeight` 0.903125, counters 8/2, all observations and the pending promotion, while updating 7 changed concepts and skipping 59 unchanged by checksum.

---

## 4. Domains

Fifteen, closed, defined in [`domains.ts`](../../services/sentinel/src/brain/ontology/domains.ts):

`market-structure` · `price-action` · `options` · `technical-analysis` · `volume` · `market-microstructure` · `macroeconomics` · `trading-psychology` · `risk-management` · `institutional-concepts` · `company-fundamentals` · `derivatives` · `sentiment` · `patterns` · `glossary`

Domain is an indexed query dimension and a UI grouping, so the list is closed by design. A concept fitting none of them is a taxonomy discussion, not a new folder.

**Seeded today: 66 concepts, 273 relations, all 15 domains populated.**

---

## 5. Semantic relations

Thirteen types, closed vocabulary, defined in [`relations.ts`](../../services/sentinel/src/brain/ontology/relations.ts). Each carries three properties the reasoner depends on:

- **polarity** — `supporting` raises confidence, `opposing` lowers it, `neutral` navigates
- **transitive** — whether the reasoner may chain it across hops
- **hop decay** — per-step confidence multiplier when chained

| Relation | Reads | Transitive | Polarity | Decay |
|---|---|---|---|---|
| `is_a` | is a kind of | yes | neutral | 0.95 |
| `part_of` | is part of | yes | neutral | 0.95 |
| `causes` | causes | yes | supporting | 0.75 |
| `precedes` | typically precedes | yes | neutral | 0.70 |
| `confirms` | confirms | no | supporting | 0.85 |
| `contradicts` | contradicts *(symmetric)* | no | opposing | — |
| `invalidates` | invalidates | no | opposing | — |
| `depends_on` | depends on | yes | neutral | 0.90 |
| `similar_to` | is similar to *(symmetric)* | no | neutral | — |
| `measured_by` | is measured by | no | supporting | 0.90 |
| `mitigates` | mitigates | no | opposing | 0.85 |
| `amplifies` | amplifies | no | supporting | 0.80 |
| `example_of` | is an example of | no | neutral | 0.70 |

The vocabulary is closed because `polarity` and `transitive` are load-bearing. An unrecognised relation string wouldn't fail loudly — it would silently weight a conclusion wrong, which is worse.

**Non-transitivity is the important half.** "A contradicts B, B contradicts C" says nothing about A and C. A naive graph walk chains it anyway and manufactures conflict the ontology never asserted. The traversal in `explainPath` terminates on non-transitive relations for exactly this reason.

The vocabulary is directional and has no inverses (`contains`, `has_subtype`, `caused_by` do not exist). Declare an edge on the more specific concept pointing at the more general one; traversal reads edges in both directions and narrates the inverse reading.

---

## 6. Permanence

Knowledge is never deleted — `CLAUDE.md` Rule 1 applied to data.

- A concept removed from YAML is marked `deprecated` by the next reseed, never dropped.
- A relation removed from YAML has its edge marked `deprecated`, never dropped.
- `ConceptObservation` is append-only. A learned weight is always re-derivable from the log, so a past explanation's evidence never changes underneath it.
- Foreign keys are `ON DELETE RESTRICT`, so an accidental delete errors instead of cascading.

Verified: removing 8 duplicate relations from YAML produced 8 `deprecated` edges and zero deletions.

---

## 7. Validation gate

Every concept and edge carries `status` (`canonical` | `proposed` | `deprecated`) and `confidence` (0–1).

Consumer queries return `canonical` above a 0.5 confidence floor. `proposed` and `deprecated` stay in the graph for audit and provenance but require an explicit opt-in that only internal tooling uses. This mirrors Sentinel's Compliance & Audit agent logging everything while only the Orchestrator's synthesis reaches the user.

**Contested knowledge is carried honestly rather than omitted.** `max-pain` and `put-call-ratio` are seeded at `maturity: contested` with low confidence and explainer text stating why the evidence is weak. Users will encounter these concepts elsewhere; meeting them here with the caveat attached is more useful than silence.

---

## 8. Compliance boundary, enforced mechanically

`CLAUDE.md` Rule 2 and `ARCHITECTURE.md` §1.3 forbid Buy/Sell/Entry/Target output. For the ontology this is enforced by a lint in [`concept.schema.ts`](../../services/sentinel/src/brain/ontology/concept.schema.ts) that runs over `summary`, `definition`, `explainer` and `observable_when` on every load — validation fails the build, so directive language cannot reach the database.

The lint matches **imperative phrasing, not vocabulary**. "The urge to book profits early" is legitimate psychology; "Book profits here" is not. "Buy-side liquidity" and "stop-loss clustering" are analytical nouns and must not trip it. Precision in both directions matters — a lint that blocks honest authoring gets disabled, and a lint that misses advice is worthless.

`observable_when` entries state *evidence cues*, never thresholds to act on.

---

## 9. Reasoning

[`ConceptGraphService`](../../services/sentinel/src/brain/ontology/concept-graph.service.ts) provides:

- **`explainPath(from, to)`** — best-first search over `-log(weight)`, not BFS. The shortest path and the strongest path are frequently different, and an explanation should show the strongest. Returns narrated steps plus a score.
- **`explainObservation(conceptIds[])`** — the core explainability call. Returns supporting evidence, contradicting evidence, and the paths connecting the detected concepts to each other. **Never collapses these into a verdict** — surfacing conflict is the point, per [`EXPLAINABILITY.md`](EXPLAINABILITY.md).
- **`similarConcepts(id)`** — historical similarity from declared `similar_to`/`is_a` edges plus structural similarity via shared neighbours. Declared analogy is stronger evidence but far sparser, so both are used and the basis is reported.
- **`neighbors`**, **`search`**, **`byDomain`**, **`stats`**.

Working example from the smoke test, crossing four domains:

> **fomo → risk-of-ruin** (score 0.241)
> Fear of Missing Out is a precondition for Overtrading; Overtrading is caused by Revenge Trading; Revenge Trading amplifies Risk of Ruin.

Semantic search over concepts is not yet live: the `embedding` column exists but nothing populates it until an embedding provider is configured — the same operational gap `PrismaMemoryStore` has. `search()` falls back to text match, and its signature won't change when embeddings arrive.

---

## 10. Not built yet

- **Read API.** No `GET /brain/concepts/...` endpoints on `services/sentinel`, and no proxy in `services/api`. Consumers reach the graph through the injected services only.
- **UI.** No Sentinel Knowledge Graph visualisation. It belongs in the `/sentinel` workspace — inside the shared shell like every other workspace (`ARCHITECTURE.md` §2.2, `SENTINEL.md` §5) — and specifically **not** in `apps/web`'s `/knowledge` route, which stays the engineering vault viewer. *(An earlier draft of this line said "Sentinel's standalone app shell", inheriting a since-reversed assumption that Sentinel was a separate application. The conclusion is unchanged: two different graphs, two different surfaces.)*
- **Orchestrator wiring.** `sentinel-orchestrator.service.ts`'s `observe()` flow does not yet call `explainObservation` or `ConceptReinforcementService.record()`. The services are registered in `app.module.ts` and ready to inject; nothing calls them in the live path yet.
- **Embeddings.** See §9.
- **Promotion review UI.** `pendingPromotions()` exists; there is no surface for a human to act on it.

---

## 11. Commands

```bash
npm run ontology:validate   # parse + lint + resolve all relations. No database needed.
npm run ontology:seed       # project YAML into Postgres (idempotent)
npm run ontology:seed -- --dry
npm run ontology:smoke      # end-to-end reasoning + reinforcement check (needs seeded DB)
```

Authoring guide: [`knowledge-base/README.md`](../../knowledge-base/README.md).
