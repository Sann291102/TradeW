---
type: decision
date: 2026-08-12
tags: [decision, ai-core, cognition, admin, learning]
---

# Cognition network — perceptors and the four layers

**Status:** shipped (Phase 1). Registered by default, runs only under `COGNITION_ENABLED=true`.

## What was asked for, and what it turned into

The ask was a "Perceptors and Neural Networks" tab on the admin page, with four
layers, machine learning, LangChain, and coverage of Sentinel, learning,
application development, bugs, and Tara — "A-Z".

What the codebase actually needed, once surveyed, was narrower and more useful:
the platform already had **four disconnected ways of noticing things** and **no
way of noticing that it had stopped noticing**.

| Surface | Watched by | Answered "is it behaving?" | Answered "is it improving?" |
| --- | --- | --- | --- |
| Market | Sentinel | yes | partly (adaptive calibration) |
| API / app | `ApiCallLog`, `AiCallLog` + the admin console | yes | no |
| Knowledge | the learning pipeline | no | no |
| Tara | nothing beyond the current turn | no | no |

Nothing kept a **scored** record of whether what the system noticed turned out to
matter. That is the gap this closes.

## The decision

Build a four-layer perceptor network in `packages/ai-core/src/cognition/`, hosted
by `services/api`, surfaced at `/admin/cognition`.

```
L1 Perception     sensors, burst collapsing, salience gate
L2 Encoding       stable signature + (when an embedder exists) a vector
L3 Association    learned weights ∪ semantic proximity ∪ asserted graph edges
L4 Consolidation  promotion to memory, operator proposals, weight updates
```

**Why four and not three or six.** Each boundary exists because the two sides
fail differently and must be diagnosable separately: L1 fails by going silent or
flooding; L2 by encoding two things identically; L3 by associating everything or
nothing; L4 by remembering noise or never learning. Collapse any pair and one of
those failures becomes invisible from outside — which was the pre-existing state.

## Three decisions worth recording

### 1. Native on ai-core, with a *structural* LangChain adapter

`packages/ai-core` already owns providers, memory, vector store, knowledge graph,
RAG, tools and the agent runtime, and ARCHITECTURE Rule 2 says products depend on
it and only it for intelligence primitives. Importing LangChain would have meant
two provider wrappers, two memory contracts, and — the disqualifying part —
`instrumentLlmProvider` bypassed, so every LangChain call would be missing from
the admin console's cost and latency figures.

LangChain's core interfaces are structural (`getRelevantDocuments`,
`loadMemoryVariables`/`saveContext`, `{pageContent, metadata}`), and TypeScript is
structurally typed. `cognition/langchain-adapter.ts` implements those shapes with
**no import and no dependency**, so a LangChain chain can consume the brain and
type-check against it. If the full class hierarchy is ever needed, the honest
next step is a separate `@tradew/langchain` package depending on both — so
LangChain's weight lands on the one service that asked for it.

### 2. The learning is online reward-modulated Hebbian, not backprop

Stated plainly because calling it a neural net would cost real time the first
time someone tries to tune it like one.

```
Δw = η · (r − w) · coactivation · eligibility
```

- **`(r − w)` is a delta rule.** Without it, plain co-occurrence counting makes
  anything that fires often maximally important regardless of ever being right.
  This is the single most important term.
- **`r = 0.5` is neutral, not 0.** An unjudgeable outcome must leave weights
  untouched. Encoding "unknown" as zero teaches the network that everything it
  was never told about was wrong, and it unlearns itself into silence.
- **Firing never moves a weight.** Only a scored outcome does. Otherwise the
  loudest sensor wins whether or not it was ever correct.
- **Weights decay toward `WEIGHT_INITIAL`** with a 30-day half-life, computed on
  read from `lastActivatedAt` (not by a sweep job, which would answer differently
  depending on when it last ran). A pattern that has not fired in a month is a
  fossil, not knowledge.

Backprop was rejected on data shape, not on ambition: TradeW produces a slow
trickle of weakly-labelled outcomes from a distribution that shifts with the
market regime. An online associative rule is learnable from the first ten
examples and — decisively — every weight is a named pair an operator can read.

### 3. Full application *perception*, never actuation

The request included "full application control". It is implemented as perception
plus **proposals**: L4's most consequential output is a `CognitiveProposal` row
with status `pending`, and an operator is the actuator. There is deliberately no
`execute` kind and no execution path.

A market hypothesis never becomes a proposal at all — Sentinel's publication gate
owns everything that reaches a trader, and a second path from a system with no
compliance review is exactly what ARCHITECTURE Rule 2 forbids.

## The sensors (17, five domains)

| Domain | Perceptors |
| --- | --- |
| `application` | error-rate, latency, ai-failures, ai-cost, stuck-orders, **agent-silence** |
| `market` | sentinel-observations, publication-gate, news |
| `assistant` | conversation (pushed), refusals, latency |
| `learning` | corpus-growth, concept-promotions, **concept-quality** |
| `platform` | job-leases, auth-anomaly |

Two are worth singling out:

- **`application.agent-silence`** is the reason the domain exists. Every other
  sensor fires on something happening; this one fires on something *not*
  happening. A Sentinel agent that quietly stopped being scheduled produces no
  errors, no latency, no cost and no rows — it just goes quiet, and every
  dashboard stays green.
- **`learning.concept-quality`** reads `ConceptObservation.outcome`, the closest
  thing the platform has to ground truth about its own knowledge. Grouped **per
  concept**, because the aggregate is always reassuring: the many concepts that
  work drown out the few that do not, and the few that do not are the point.

## Promotion bar: confidence AND corroboration

Mirrors Sentinel's publication gate rather than inventing a second standard —
`confidence ≥ 0.7` **and** more than one independent perceptor. The second gate
looks redundant until a single miscalibrated sensor produces a stream of
0.9-confidence nonsense; no confidence threshold alone stops that becoming
permanent knowledge. See [[Decisions/2026-07-21 - Sentinel Concept Knowledge Graph (living ontology)]].

## Retention is deliberately not uniform

`Percept` and `CognitiveEpisode` are high-volume and disposable — pruned to 30
days. **`NeuralSynapse` is never pruned.** A weight is weeks of accumulated
outcomes and cannot be recomputed from any other table; truncating it is data
loss in the ordinary sense. A retention job that treats these tables alike would
quietly delete everything the network has learned. The `prune()` method omits it
on purpose and must keep omitting it.

## Known limitations, recorded rather than hidden

1. **No embedder in `services/api`.** The API holds no provider credentials
   (single-ingress, ARCHITECTURE §1), so L2 produces signatures but no vectors,
   and L3 falls back to lexical concept matching. Designed for: a weak match
   creates a weak synapse that stays weak unless outcomes reinforce it, so a bad
   guess costs one low-weight edge, not a wrong conclusion. Wiring an embedder
   changes one method.
2. **Eligibility traces are in-memory.** An episode scored after a restart
   updates the episode row but moves no weights. Reconstructing traces from
   persisted percepts would fabricate coactivation values that were never
   recorded, and a learning system fed invented inputs is worse than one that
   occasionally learns nothing.
3. **Baselines are short** (the immediately preceding window). Better
   operationally, worse statistically — a slow drift is invisible to the
   perceptors and shows only in the weight history.

## Related

- [[Decisions/2026-07-17 - Obsidian Knowledge Layer adopted]] — why this vault and Sentinel's Postgres Brain are separate systems. The cognition network writes to the **Brain** (`MemoryRecord`, namespace `cognition`), never to this vault.
- [[Plans/2026-08-11 - AI Operating System (eight layers, Phase 1 spine shipped)]] — the assistant spine this network's `assistant` domain observes.
- `apps/web/src/app/admin/README.md` — the console section.
