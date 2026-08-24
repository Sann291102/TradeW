# The System Graph — implementation map

*Written 2026-08-24, alongside the Knowledge Graph + Neural Network upgrade.*

The admin console's Knowledge Graph and its Perceptrons & Neural Network page
are **two projections of one dataset**, not two visualisations of two datasets.
This document is the map of what that dataset is made of, where every part of
it comes from, and what each visual property means.

The governing rule: **every node and every edge originates in something the
platform actually persisted or actually declared.** There is no synthetic,
demo or padding data anywhere in this pipeline, and there is deliberately no
code path that could introduce any.

---

## 1. What was there before

| | Knowledge Graph | Perceptrons & Neural Network |
|---|---|---|
| Data | 105 markdown files under `knowledge/` | the cognition network's own counters |
| Node kinds | 1 (a note) | 3 (domain, layer, output) |
| Edge kinds | 1 (`links to`) | 1 (`flows into`) |
| Connection to the platform | none | none |
| Interaction | drag, hover | click a node |
| Rendering | SVG, ~150 nodes, O(n²) layout in React state | static SVG |

Both were accurate about their narrow subject and neither described TradeW.
The Knowledge Graph was a picture of the engineering vault labelled as the
knowledge graph of a trading system; the neural page was a five-box pipeline
diagram that made a system with hundreds of live parts look like four stages.

---

## 2. Real data sources, as inventoried

Three admissible origins, recorded on every node as `source`. There is no
fourth.

### `code` — read out of the running process

| Source | What it yields | How |
|---|---|---|
| Nest `ModulesContainer` | 30 modules, 31 controllers, **222 routes** with method, path, handler, module, and the guards on each | `TopologyService` reads `path`/`method`/`__guards__` decorator metadata from the container that actually booted |
| Prisma DMMF | 59 tables and their real relation fields | `Prisma.dmmf.datamodel.models` |
| Workspace manifest | 2 apps, 4 services, 5 packages, and the `@tradew/*` dependencies between them | each unit's own `package.json` |
| `agents/<system>/definitions.json` | 6 agents with tier, guardrails, allowed tools | the same files the AI runtime loads |
| Environment | 10 external providers, and whether each is *configured* | presence of the credential variable — never its value |

Reading the container rather than scanning source is the difference between
"the repo mentions this route" and "this API serves this route". Only the
second belongs on an operations console.

### `database` — rows in Postgres

| Table(s) | Becomes |
|---|---|
| `ApiCallLog` | route request counts, error counts, latency, last activity; grouped `error` nodes |
| `AiCallLog` | `model` nodes, agent cost/latency, and **the route → agent join via `requestId`** |
| `AgentActivity`, `AgentRun` | agent → agent `calls` edges, direction taken from `peer` on `sending` transitions |
| `ConceptNode`, `ConceptEdge`, `ConceptObservation` | the reasoning ontology, its learned weights, and its `learning` events |
| `MemoryRecord`, `MemoryRelation` | memories and their relations |
| `Percept`, `PerceptorState`, `CognitiveEpisode`, `CognitiveProposal` | signals, sensor health, passes, proposals |
| `NeuralSynapse` | `learned_from` edges — the densest and most valuable edges on the graph |
| `GraphNode`, `GraphEdge` | the market entity graph |
| `Instrument`, `NewsEvent` | instruments, their underlyings, news sources |
| `ResearchCompany`, `UserStrategy` | research subjects and strategies |
| `ExecutionProfile`, `ExecutionIntent`, `ExecutionOutcome` | experiments, decisions, and the outcomes that scored them |
| `SentinelObservation` | agent observations, bridged to instruments |
| `AuditEvent`, `OperatorAccount` | security findings, deployments, the operator population |
| `JobLease` | leader-elected background loops and whether they are held |

### `vault` — files on disk

`knowledge/*.md` and the links inside them, via the existing
`KnowledgeService` index. Now **one cluster inside the graph** rather than the
entire graph.

### Event infrastructure — reused, not replaced

`TelemetryService.bus` (HTTP requests, LLM calls, agent transitions, run
boundaries) and `KnowledgeService.changes` (vault writes). `GraphEventsService`
*translates* these into graph events; it does not introduce a second publishing
mechanism, because the one a future feature forgets to publish to is the one
that makes the graph quietly wrong.

---

## 3. The vocabulary

**9 domains** (the clusters): application, cognition, knowledge, market,
research, execution, security, infrastructure, ai.

**32 node kinds**, each naming its backing store in
`services/api/src/graph/graph.types.ts`. A kind with no backing store cannot
be added.

**21 relation types**, closed: `depends_on`, `calls`, `uses`, `used_by`,
`produces`, `consumes`, `related_to`, `supports`, `contradicts`,
`derived_from`, `learned_from`, `tested_by`, `validated_by`, `supersedes`,
`part_of`, `triggered_by`, `implemented_by`, `exposed_by`, `stored_in`,
`researched_by`, `observed_by`.

Each relation declares whether it is directed and what it is called from the
other end (`inverse`). That is what lets **one stored edge** read correctly at
both ends — "exposes" on a controller, "exposed by" on a route — with no second
row in the graph.

---

## 4. The visual contract

Published by `GET /admin/graph/meta` and rendered verbatim as the console's
legend, so the legend **cannot drift from the renderer**.

| Visual property | Field | Meaning |
|---|---|---|
| node radius | `importance` | declared weight blended with degree centrality and observed traffic |
| node halo + pulse | `activity` | recency-weighted activity; 0 means nothing has happened |
| node opacity | `confidence` | how sure the platform is this node means what it says |
| node fill tone | `status` | healthy, degraded, failing, idle, armed, pending |
| node rim glyphs | `glyphs` | real counters: requests, errors, observations, LLM calls |
| edge width | `strength` | traffic volume, dependency weight, or learned synapse weight |
| edge opacity | `confidence` | evidential confidence in the relationship |
| edge dashes | `confidence < 0.35` | weak or indirect — an unscored synapse, an unobserved prior |
| edge arrowhead | `relation.directed` | data or request flow direction |
| edge animation | `activity` | a travelling pulse, only while the relationship carries traffic |
| edge colour | `state` | red = contradiction; amber = warning |
| combo | `cluster` | the domain a node collapses into at low zoom |
| visibility | `tier` | semantic zoom: 0 = spine and hubs, 1 = services/agents/concepts, 2 = evidence |

Nothing else is encoded visually. A renderer that wants to say something new
gets a data field here first.

Two of these deserve their reasoning stated:

- **`confidence` on a synapse.** A `NeuralSynapse` with `reinforcements = 0` is
  a *guess* — no outcome has ever scored it. It is drawn at 0.3 confidence, so
  dashed and faint, rather than at the same weight as a proven association.
  Presenting a guess as a finding is the specific failure this graph exists to
  avoid.
- **`state = contradiction`.** Reserved for edges that genuinely assert
  disagreement: a `contradicts` concept edge, a relation whose refutations
  outnumber its supports, a `NeuralSynapse` whose mean reward is below 0.3, and
  a losing `ExecutionOutcome` — where the decision claimed one thing and reality
  answered another.

---

## 5. Performance — why the browser never sees the whole graph

The backend graph may grow to whatever the platform's history makes it. The
viewport may not. Four mechanisms, in the order they bite:

1. **Semantic zoom (`maxTier`).** First paint asks for tier 0 and gets ~23
   nodes out of 510. Detail arrives only when the camera has earned it.
2. **Neighbourhood loading.** `GET /admin/graph/neighborhood` walks outward
   breadth-first with a *per-ring* budget, so a hub with 400 neighbours cannot
   consume the whole budget at depth 1.
3. **Server-side filtering.** Domain, kind, relation, time, confidence,
   importance and activity are applied before serialisation — a filtered view
   is *cheaper* on the wire, not the same payload made invisible.
4. **Aggregation.** Domains collapse into combos carrying whole-graph counts.

Plus: one snapshot serves every reader for 30s; a rebuild in flight serves the
previous snapshot rather than blocking; a failed rebuild never destroys a
working one; and the hard server ceiling is 900 nodes per slice regardless of
what a caller asks for.

Every response carries `totals`, `truncated` and `builtAt`, so the console says
"220 of 4,318, this node has 41 more neighbours, snapshot 12s old" rather than
implying a fragment is everything.

---

## 6. Degradation is reported, never hidden

Each source is wrapped in `safe()`. A failure names the source in
`snapshot.degraded` and the build continues; the console renders that list as a
banner. Between "the market cluster is empty because nothing happened" and
"the market cluster is empty because the query threw", only the second is a
problem — and an operator cannot act on the difference unless it is shown.

---

## 7. Persistence

The visualisation is never the source of truth. Every endpoint under
`/admin/graph/*` is a **GET**, and the proxy allowlist has a test asserting that
no write on this surface is forwarded. There is no way for the console to pin,
hide or delete a node, and no way to erase a historical relationship — those are
owned by the tables that hold them, and this module has no reason to be able to
destroy one.

---

## 8. Bug found and fixed along the way

Wiring the route-activity channel surfaced a **pre-existing telemetry outage**.

`ApiCallLog.userId` and `AiCallLog.userId` are foreign keys to `User`.
`AdminAccessGuard` sets `req.user.sub` to `operator:<OperatorAccount.id>` for
console requests — deliberately prefixed, with its own comment warning that
nothing should ever join it against the user table. `ApiCallInterceptor` wrote
exactly that value into the column.

The insert is a `createMany`, so the constraint violation did not lose one row:
**it threw for the whole buffered batch**, discarding every unrelated request
logged in the same two-second window. An open admin console silently punched
holes in the API's own telemetry, and the only evidence was a warning line in
the service log. Everything reading those tables — the API telemetry page, AI
cost attribution, and now the graph's route activity — was quietly wrong.

Fixed in `telemetry/api-call.interceptor.ts` via `productUserId()`, which
returns `undefined` for an operator principal. The operator's identity is not
lost: it is recorded where it belongs, in `AuditEvent`, by the handlers that
take privileged actions. Pinned by
`src/telemetry/telemetry-attribution.spec.ts`.

---

## 9. Verified against a live system

Booted against real Postgres 16 + pgvector with migrations applied, real
operator credentials, and real traffic:

```
504 nodes · 1,043 edges · built in 107ms · degraded: []

application 294   knowledge 105   infrastructure 64   cognition 22
market 10         ai 6            research 2          security 1

route 222   table 59   controller 31   module 30   perceptor 17
note 105    source 10  agent 6         job 5       layer 4
```

Confirmed working end to end:

- **222 routes** discovered from the running container, with correct auth
  posture — an unguarded route reports `public`, never a reassuring default.
- **Route traffic** → importance, activity, status and glyphs
  (`GET /health` req=27; `POST /auth/login` req=5 err=5 → `failing`).
- **Error grouping** → an `error` node with a real rate, joined by a
  warning-state edge carrying its evidence string.
- **Node inspector** → real fields, real inverse-labelled relations, and 12
  real `ApiCallLog` rows as event history.
- **Semantic zoom** → 23 of 510 nodes on first paint, 20 marked truncated.
- **Clusters** → whole-graph counts, not slice counts.
- **SSE stream** → 30 real events; `route.activity` at intensity 0.30,
  `error.generated` at 1.00, node ids matching graph node ids exactly.
- **Vault write** → `knowledge.created` with the right node id, then a single
  debounced `graph.rebuilt`; delete likewise.
- **Signal path with no LLM traffic** → returns empty. It does *not* fabricate
  an illustrative trace, which on a screen whose whole claim is "this actually
  happened" would be the worst possible thing to draw.

---

## 10. Where the code lives

```
services/api/src/graph/
  graph.types.ts        vocabulary, wire shapes, the published visual contract
  topology.service.ts   static: container routes/controllers/modules, DMMF, workspace, agents
  graph.projection.ts   builds one snapshot from every real source
  graph.service.ts      cache, slices, neighbourhoods, search, inspector, signal paths
  graph.events.ts       translates the existing buses into graph events
  graph.controller.ts   GET /admin/graph/* (+ SSE), operator-gated
  graph.module.ts       registered LAST in AppModule — see below

apps/admin/src/
  lib/graph.ts            typed client, palette, SSE subscribe
  lib/graphLayout.ts      dependency-free force simulation + camera
  lib/useSystemGraph.ts   shared state for both pages
  components/graph/       GraphCanvas, GraphControls, NodeInspector, GraphLegend, SignalPathStrip
  app/(console)/knowledge/page.tsx   the investigative projection
  app/(console)/cognition/page.tsx   the live signal projection
  app/api/stream/graph/route.ts      SSE proxy
```

**`GraphModule` must stay last in `AppModule`'s import list.** It reads the
container's own module registry to discover routes; a module registered after
it would be missing from the graph — silently, which is the worst way for an
operations map to be wrong.
