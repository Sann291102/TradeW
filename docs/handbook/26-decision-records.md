# Chapter 26 — Decision Records

Every architectural decision of consequence, why it was made, and — more usefully — **what was rejected and why**.

The rejected alternatives are the point. A decision without its alternatives is an assertion, and it will be re-litigated by the next engineer who has the rejected idea and no record that it was already considered.

**Format:** ADR-NNN · title · date · status · context · decision · rejected alternatives · consequences.

---

## 26.0 Index

| ADR | Title | Status |
|---|---|---|
| 001 | One public ingress (ARCH-1) | ✅ accepted |
| 002 | No AI-initiated trades (ARCH-2) | ✅ accepted |
| 003 | Sentinel never gates the order flow (ARCH-3) | ✅ accepted |
| 004 | Observation, never advice (ARCH-4) | ✅ accepted |
| 005 | One schema owner per table (ARCH-5) | ✅ accepted |
| 006 | Modular monolith, with written extraction triggers | ✅ accepted |
| 007 | `services/auth` as a contract boundary, not a deployable | ✅ accepted |
| 008 | Redis Streams before Kafka | ✅ accepted |
| 009 | Sentinel receives trade DTOs; never queries trading tables | ✅ accepted |
| 010 | Deterministic core, LLM as stylist | ✅ accepted |
| 011 | The composite gate: ≥2 signals AND ≥0.7 weight | ✅ accepted |
| 012 | pgvector, not an external vector database | ✅ accepted |
| 013 | Provider abstraction with logical tiers | ✅ accepted |
| 014 | A second graph: the concept ontology | ✅ accepted |
| 015 | Learned columns separated from canonical columns | ✅ accepted |
| 016 | Sentinel proposes; only humans promote | ✅ accepted |
| 017 | Paper OMS fills against live prices, not the `Quote` table | ✅ accepted |
| 018 | Simplified simulated margin, documented as such | ✅ accepted |
| 019 | Polling matching engine, not an event-driven book | ✅ accepted |
| 020 | Session anchor columns, not a snapshot table | ✅ accepted |
| 021 | `services/market-data` is a singleton, permanently | ✅ accepted |
| 022 | `Quote` is a latest-snapshot table | ✅ accepted |
| 023 | Depth is never persisted | ✅ accepted |
| 024 | Ornstein–Uhlenbeck simulator, not a random walk | ✅ accepted |
| 025 | Binary parser is pure and synchronous | ✅ accepted |
| 026 | Zustand, not Redux or Context | ✅ accepted |
| 027 | Five-zone dock, not floating windows | ✅ accepted |
| 028 | `packages/ui` is source-only, no build step | ✅ accepted |
| 029 | npm workspaces, not pnpm or Turborepo | ✅ accepted |
| 030 | `lightweight-charts` before the TradingView library | ✅ accepted |
| 031 | Client-side indicators for display, server-side for signals | ⚠️ accepted with debt |
| 032 | Entitlement gates reasoning, never visibility | ✅ accepted |
| 033 | Order placement is never gated by tier | ✅ accepted |
| 034 | The entitlement decision is a typed object, not a boolean | ✅ accepted |
| 035 | Archive, never delete | ✅ accepted |
| 036 | Two knowledge systems, deliberately separate | ✅ accepted |
| 037 | Sentinel is a workspace, not a standalone product | ⛔ reversed, then reinstated |
| 038 | Staying on PostgreSQL (Oracle migration rejected) | ✅ accepted |
| 039 | Single VM before Kubernetes | ✅ accepted |
| 040 | Same-origin routing to eliminate CORS | ✅ accepted |
| 041 | Self-imposed limits, observed and never enforced | ✅ accepted |
| 042 | Directional outcome labels, not confirmed/failed | ✅ accepted |
| 043 | Withhold statistics below a sample size | ✅ accepted |
| 044 | The distillation path via provider abstraction | ✅ accepted |
| 045 | `trading-engine` remains un-migrated pending approval | ✅ accepted |

---

## ADR-001 — One public ingress (ARCH-1)
**2026-07-16 · ✅ accepted**

**Context.** Four inherited codebases with several network surfaces. `apps/*` could plausibly call any service directly.

**Decision.** `apps/*` reach the backend **only** through `services/api`. Every other service is unreachable from the internet, enforced by network topology (Caddy routes only `web` and `api`) and by `ServiceTokenGuard`.

**Rejected.**
- *Direct service calls from the browser* — five places to get auth wrong, five audit surfaces, five rate-limit surfaces. ⚖️ A regulator's "show me everything this user did" would have five answers.
- *An API gateway product* — operational cost for a routing problem a reverse proxy already solves.

**Consequences.** One extra hop for Sentinel (single-digit ms, off the critical path). One documented exception: TradingView strategy webhooks go directly to `trading-engine`, because routing them through the API would add a **second signature-verification surface** — more attack surface, not less.

---

## ADR-002 — No AI-initiated trades (ARCH-2)
**2026-07-16 · ✅ accepted**

**Decision.** No AI service can place, modify, or cancel an order. Enforced three ways: no tool exists in the registry, no HTTP client exists, no arrow exists in the dependency graph.

**Rejected.**
- *A gated tool with a confirmation step* — the gate is one config change from being removed, and the capability's existence is the risk.
- *"Just for backtesting"* — a backtest path that can place orders is an order path.

**Consequences.** Some genuinely useful automation is impossible. Accepted permanently, at every roadmap horizon. ⚖️ The regulatory distance between "analyses" and "executes" is the company's entire compliance posture.

---

## ADR-003 — Sentinel never gates the order flow (ARCH-3)
**2026-07-16 · ✅ accepted**

**Context.** A behavioural risk system's instinct is to be a gate. That is what a risk system *is*.

**Decision.** Sentinel observes **in parallel**. It cannot block, delay, or add a confirmation step, and it is never a synchronous dependency of order placement.

**Rejected.**
- *Block above a confidence threshold* — makes Sentinel a trading decision-maker. ⚖️ Regulatory category change.
- *A 3-second cooling-off delay* — feels harmless; makes Sentinel a latency dependency and a single point of failure for the platform's core function.
- *A confirmation dialog when Sentinel objects* — feels like a compromise; is still Sentinel deciding whether an order is easy or hard to place.

**Consequences.** ⭐ **Sentinel — the most complex service in the platform — can be entirely down and the platform remains fully functional.** That reliability property is worth more than the intervention given up. Product-wise: a system that blocks you is a system you route around; a system that observes you is one you argue with, and arguing is how a habit gets noticed.

---

## ADR-004 — Observation, never advice (ARCH-4)
**2026-07-16 · ✅ accepted**

**Decision.** No Buy/Sell/Entry/Target/Stop language anywhere — agent, prompt, card, notification, email, or export. Output is fixed at **evidence → pattern name → soft suggestion**.

**Enforced by** `CORE_GUARDRAILS` in every prompt, a deterministic composer that produces the structure without a model, un-trimmable guardrails in the context manager, and ⚖️ a compliance-language test suite.

**Rejected.**
- *Advice with a disclaimer* — a disclaimer does not change what the sentence is.
- *Advice for entitled users only* — entitlement does not change regulatory category.

**Consequences.** Simultaneously the product identity, the compliance posture, and a hard architectural rule. It is what makes the platform defensible and it is what makes it different.

---

## ADR-005 — One schema owner per table (ARCH-5)
**2026-07-16 · ✅ accepted**

**Decision.** Two runtimes may share a Postgres instance; never one ORM ownership over one table from two places. `services/sentinel` runs its own Prisma client against its own tables.

**Rejected.** *A shared Prisma client across services* — a schema change in one service silently breaks another, and migration ownership becomes ambiguous.

---

## ADR-006 — Modular monolith, with written extraction triggers
**2026-07-16 · ✅ accepted**

**Context.** `services/` contains eight folders. Only three run.

**Decision.** Build to the *boundary*; deploy the *monolith*. Every "should we split this out?" is answered by a **measured condition**, written down (Chapter 5 §5.7) — never by taste.

**Rejected.**
- *Microservices from day one* — eight deployables, eight pipelines, eight on-call surfaces, for a system with no users.
- *A single service with no boundaries* — extraction later becomes a rewrite rather than a lift.

**Consequences.** ⚠️ Folder names suggest a multi-service fleet; the process count is five. This surprises every new engineer and is documented in Chapter 1 §1.8 and Chapter 5 §5.2 for that reason.

---

## ADR-007 — `services/auth` as a contract boundary, not a deployable
**2026-07-16 · ✅ accepted**

**Decision.** The folder exists **now** as the extraction seam; the module runs inside `services/api`. Trigger: ~50k concurrent sessions.

**Consequences.** Pay the design cost early (cheap); pay the operational cost late (expensive). The extraction becomes a lift of an already-isolated module, not a rewrite.

---

## ADR-008 — Redis Streams before Kafka
**2026-07-16 · ✅ accepted**

**Decision.** When an event bus is needed, start with Redis Streams. Graduate to Kafka **only** when a concrete durability, replay, or consumer-group requirement genuinely cannot be met by Redis.

**Rejected.** *Kafka now* — the architecture document's 1M-concurrent-session target is a v2.0 destination, not a v0.3 starting point. Adopting Kafka before there is load to justify its operational cost is over-engineering with a name.

---

## ADR-009 — Sentinel receives trade DTOs; never queries trading tables
**2026-07-16 · ✅ accepted**

**Context.** Sentinel's Emotion Intelligence needs the user's own trade history. The obvious design gives it a Prisma client.

**Decision.** `services/api` passes `TradeSummary[]` on the `/observe` request body. Sentinel has **no** trading credentials and issues **no** trading queries.

**Rejected.** *Give Sentinel database access* — easier, and it would mean a compromised Sentinel could exfiltrate every user's positions.

**Consequences.** ⭐ Three properties for the price of one interface: 🔒 blast radius (Sentinel cannot see what it cannot query), decoupling (a DTO contract, not a schema dependency), and testability (`emotion.signals(trades)` is a pure function over an array literal — the easiest thing in the codebase to test).

---

## ADR-010 — Deterministic core, LLM as stylist
**2026-07-17 · ✅ accepted**

**Decision.** All analysis is deterministic. The LLM only rewrites already-decided evidence into prose, and its failure falls back to a template producing the same structure.

**Rejected.** *Send market data to a model and ask what it thinks* — non-reproducible, unauditable, expensive per call, latency-unbounded, and one prompt injection away from a ⚖️ compliance incident.

**Consequences.** ⭐ The single most important AI decision in the platform. Compliance is guaranteed by code rather than by model behaviour; the system is fully functional with no API key; output is reproducible and therefore debuggable; and cost scales with *surfaced* observations rather than with observation attempts.

---

## ADR-011 — The composite gate: ≥2 signals AND ≥0.7 weight
**2026-07-17 · ✅ accepted**

**Decision.** No single signal ever produces a user-facing warning. Both conditions are load-bearing: weight alone would let one heavy signal plus rounding through; count alone would let two trivial signals through.

**Rejected.**
- *Surface every triggered signal* — the product becomes an alert system, which is the thing it exists not to be.
- *A single confidence threshold* — one indicator crossing a line is noise; several unrelated observations agreeing is information.

**Consequences.** ⭐ It is simultaneously the quality gate and the cost gate: the LLM runs on <15% of calls. Changing either constant **requires an RFC** — they define what the product *is*, not how it is configured.

---

## ADR-012 — pgvector, not an external vector database
**2026-07-16 · ✅ accepted (locked Q4)**

**Decision.** Vectors live in the same Postgres as everything else.

**Rejected.** *Pinecone / Weaviate / Qdrant* — a second operational surface, a second backup schedule, a second bill, and no transactions or joins across relational and vector data.

**Consequences.** Ceiling around 10⁶–10⁷ vectors, which is far beyond our horizon. ⚠️ **The HNSW index is still missing (DB-1)** — without it, similarity search is a sequential scan, and memories are written continuously.

---

## ADR-013 — Provider abstraction with logical tiers
**2026-07-16 · ✅ accepted (locked Q5)**

**Decision.** No provider name appears in any type. Code requests `tier: 'fast' | 'balanced' | 'deep'`; configuration maps tiers to models. `ProviderSelection` holds ordered preference arrays, so fallback is first-class.

**Consequences.** Model upgrades, cost tuning, and vendor migration are all configuration changes. ⭐ It is also what makes ADR-044 (distillation) a config change rather than a rewrite.

---

## ADR-014 — A second graph: the concept ontology
**2026-07-21 · ✅ accepted**

**Context.** `GraphNode`/`GraphEdge` exists with two relations, `mentions` and `co_occurs_with`. Principle "extend before you build" says extend it.

**Decision.** Build a **second, semantic** graph: `ConceptNode`/`ConceptEdge`, 66 concepts, 273 relations, 15 domains, a **closed 13-relation vocabulary** with `polarity` and `transitive` per relation.

**Rejected.** *Extend the entity graph* — "A `mentions` B" carries no meaning a reasoner can use. Extending it would mean overloading a structural graph with semantics it cannot express.

**Why the vocabulary is closed.** `polarity` and `transitive` are load-bearing: `causes` chains with decay; `contradicts` explicitly does **not** chain (*"A contradicts B, B contradicts C says nothing about A and C, and chaining it would manufacture false conflict"*); `is_a` chains but asserts nothing. An unknown relation string would be traversed with defaults and silently weight a conclusion wrong.

**Consequences.** This is the exception that defines "cleanly" in "extend before you build" (Chapter 1 §1.4.1). Two graphs, bridged by `ConceptObservation.symbol`, never joined.

---

## ADR-015 — Learned columns separated from canonical columns
**2026-07-21 · ✅ accepted**

**Decision.** The seeder rewrites only canonical columns and **never** touches `learnedWeight`, `supportCount`, `refuteCount`, `observationCount`, `lastObservedAt`, or `observations`.

**Consequences.** ⭐ A reseed is a **boring, idempotent operation** rather than a data-loss event. The ontology can be regenerated from YAML at any time without destroying what the system learned in production. A small schema decision with a large operational payoff.

---

## ADR-016 — Sentinel proposes; only humans promote
**2026-07-21 · ✅ accepted**

**Decision.** Runtime learning writes a `ConceptPromotion` row. A human reviews it, edits the YAML, and the next reseed makes it canonical. **Sentinel never edits the canonical source.**

**Rejected.** *Auto-promote above a confidence threshold* — the ontology is what the product's reasoning is *made of*. A system that edits its own axioms drifts, and nothing catches the drift.

**Implementation note.** `dedupeKey` is a service-computed stable key rather than a composite `@@unique`, because Postgres treats NULLs as distinct and most columns are nullable — a composite constraint would not actually dedupe.

---

## ADR-017 — Paper OMS fills against live prices, not the `Quote` table
**2026-07-22 · ✅ accepted**

**Context.** `Quote` is written by `services/market-data`, which defaults to the simulator. The paper OMS could read it trivially.

**Decision.** `MarketPriceService` reads the **live Dhan bridge** — the same source the user's chart shows.

**Rejected.** *Read `Quote`* — *"Filling paper orders against that would silently diverge from the real price the user is looking at on screen — confusing at best, wrong at worst."*

**Consequences.** A paper fill at a price the user cannot see is not a lesson; it is a bug that happens to run. This is ADR-033's mission rule expressed in code.

---

## ADR-018 — Simplified simulated margin, documented as such
**2026-07-22 · ✅ accepted**

**Decision.** Approximate margin (100% option BUY / 100% CNC / 15% option SELL and FUTURE / 20% MIS) with a docstring stating plainly that it is **not** SPAN.

**Rejected.**
- *Implement real SPAN* — a project, not a function: exchange-published scenario arrays, intraday recomputation, cross-margining.
- *No margin at all* — then "available balance" means nothing and "insufficient margin" can never reject.

**Consequences.** ⭐ The failure mode being avoided is not "the margin is approximate" — it is *"the margin is approximate and a future engineer assumes it isn't."* Documented at the point of implementation is worth more than a wiki page.

---

## ADR-019 — Polling matching engine, not an event-driven book
**2026-07-22 · ✅ accepted**

**Decision.** A 3-second `setInterval` loads all resting orders and evaluates each against **one cached price snapshot**.

**Why it is correct rather than lazy.** One `/quotes` call covers every resting order regardless of count — **polling cost does not scale with order volume.** Cost per tick is one query + one bridge call + N in-memory comparisons.

**Rejected.** *A real order book with price-level indexing* — there is no exchange to rest on and no counterparty; it would be an elaborate simulation of something the paper engine does not have.

**Consequences.** ⚠️ With N replicas the engine runs N times (OPS-1). A Redis leader lock is required before any multi-replica deploy.

---

## ADR-020 — Session anchor columns, not a snapshot table
**2026-07-22 · ✅ accepted**

**Decision.** Four columns on `Position` (`sessionOpenQty`, `sessionOpenAvgPrice`, `sessionOpenMarketPrice`, `sessionAnchorAt`), refreshed lazily on first touch of a new IST day.

**Rejected.** *A `PositionSnapshot` table written by a 09:15 IST cron* — requires a scheduler, leader election, monitoring for silent failure, a backfill path, and a decision about intraday-opened positions.

**Consequences.** ⭐ Four columns and a lazy check replace an entire operational dependency, for data nobody queries historically. Looks like a shortcut; is the right answer.

---

## ADR-021 — `services/market-data` is a singleton, permanently
**2026-07-21 · ✅ accepted**

**Decision.** One replica. Not "for now" — **by design.**

**Why.** The broker feed connection set is a **per-account resource**: 5 WebSocket connections per user, 1 quote request/second account-wide. A second replica does not double throughput; it halves each replica's budget and doubles the chance of a rate-limit ban.

**Scaling path when one is insufficient:** fan-out (one writer, N stateless readers), then partition by account, then vertical. **Never replication.**

**Consequences.** ⚠️ **The most likely architecture mistake a new engineer will make** is "market-data is a bottleneck, add replicas." The failure mode is a rate-limit ban on the production broker account during market hours.

---

## ADR-022 — `Quote` is a latest-snapshot table
**2026-07-18 · ✅ accepted**

**Decision.** One row per instrument, `instrumentId @unique`, updated in place. Established by architecture review **with evidence**, not assumption. Added `source` so simulated and live are distinguishable.

**Consequences.** Because it is a snapshot, writes can be coalesced to every 2–5 s for free — nothing is lost, because the previous value was going to be overwritten. That is what makes the tick-throttling ladder possible.

**Process finding.** The review discovered pre-existing drift: `schema.prisma` had columns no migration had shipped. **Always diff a migration against the live DB, not the schema file.**

---

## ADR-023 — Depth is never persisted
**2026-07-18 · ✅ accepted**

**Decision.** Level-2 depth streams to the UI and is discarded.

**Why.** A five-level ladder changing many times per second is enormous write volume for data whose value expires in under a second.

---

## ADR-024 — Ornstein–Uhlenbeck simulator, not a random walk
**2026-07-21 · ✅ accepted**

**Context.** Two simulators existed and **disagreed on the same symbol at the same instant** — flagged High severity, because Sentinel would compute a signal from one price while the UI showed another.

**Decision.** Keep the better one (mean-reverting, anchored to real `previousClose`, deterministic per `(symbol, trading-day)`), move it **verbatim** into `packages/market-data`, and make it framework-free.

**Why OU and not a random walk.** ⭐ A random walk has no support or resistance, so `swingLevels()` finds noise, so **the trap detectors never fire, so Sentinel is undevelopable outside market hours.** The OU choice is load-bearing, not a flourish.

---

## ADR-025 — Binary parser is pure and synchronous
**2026-07-21 · ✅ accepted**

**Decision.** No network, no credentials — a pure function over a `Buffer`.

**Why.** *"The riskiest part of the WebSocket integration is byte-offset arithmetic, and this way it is fully verifiable before a live connection ever exists."*

**Consequences.** Testable with a hex literal, at any time, with no broker account. `'unknown'` is a first-class return value, so a vendor adding a feed code logs and continues rather than crashing ingestion.

---

## ADR-026 — Zustand, not Redux or Context
**2026-07-18 · ✅ accepted**

**Decision.** Zustand (~1 KB) with selector-scoped subscriptions.

**Why the decisive factor is re-render granularity.** Context re-renders every consumer in the subtree. In a terminal where quotes update several times per second across ~560 option-chain cells, that difference is the entire performance story.

**Consequences.** ⚠️ Persisted stores need `skipHydration: true` + manual `rehydrate()`, and no `Math.random()`/`Date.now()` in seed data — otherwise SSR hydration mismatches.

---

## ADR-027 — Five-zone dock, not floating windows
**2026-07-18 · ✅ accepted**

**Decision.** `left | main | auxA | auxB | right`, with `right` stacking vertically.

**Rejected.** *Free-floating windows* — a geometry graph instead of a `PanelState[]`, ambiguous keyboard focus order, no coherent responsive story, and permanent z-index management.

**Consequences.** Less flexibility, which no user has asked for. The layout serialises as a plain array, which is what makes ADR-020-style server-side continuity a transport change rather than a redesign.

---

## ADR-028 — `packages/ui` is source-only, no build step
**2026-07-18 · ✅ accepted**

**Decision.** `main` points at `./src/index.ts`; consumed via Next's `transpilePackages`.

**Consequences.** Edit a component → HMR immediately; no stale `dist/`; no build ordering in CI. ⚠️ Only consumable by bundlers that transpile it — revisit when `apps/mobile` (Metro) needs it.

---

## ADR-029 — npm workspaces, not pnpm or Turborepo
**2026-07-16 · ✅ accepted**

**Decision.** npm workspaces, no task-graph tool.

**Why.** "The tool everyone already has" beats a marginal improvement at this size. Trigger for Turborepo: a full build exceeding ~5 minutes, or CI cost becoming material.

**Consequences.** ⚠️ Build order is *declaration order*, not a graph. Fragile as packages grow (TD-9).

---

## ADR-030 — `lightweight-charts` before the TradingView library
**2026-07-22 · ✅ accepted**

**Decision.** Apache-2.0 `lightweight-charts` (~45 KB) for terminal panels; a licensed TradingView **workspace** later as a separate surface (Phase 9).

**Consequences.** Drawing tools and indicators must be built (Chapter 13 §13.9). Total control over the render path, which is what made `series.update()`-per-tick and IST-pinned axes possible. **OD-4** (hosting model) remains open.

---

## ADR-031 — Client-side indicators for display, server-side for signals
**2026-07-22 · ⚠️ accepted with debt**

**Decision.** Compute on the client when the inputs are already there and the output is only displayed; compute on the server when it needs data the client lacks **or** feeds a ⚖️ signal that must be reproducible for the audit trail.

**Why.** An EMA over 500 candles is ~50 μs locally versus a 50–200 ms round trip.

**⚠️ The accepted debt (TD-4).** RSI exists in two implementations. Different smoothing conventions produce a chart showing 70.1 while an evidence line says 69.8 — and the entire credibility of an observation rests on its numbers being checkable. **Fix: `packages/indicators`.** Until then, change both.

---

## ADR-032 — Entitlement gates reasoning, never visibility
**2026-07-18 · ✅ accepted**

**Decision.** An unentitled user always **sees** Sentinel in the sidebar, enters the workspace, and finds a locked state with an upgrade CTA — never a hidden nav item, a 404, or a silent absence.

**Why.** Hiding a feature teaches the user the product is smaller than it is. Showing it locked teaches them what they are missing. More honest **and** better business.

---

## ADR-033 — Order placement is never gated by tier
**2026-07-17 · ✅ accepted**

**Decision.** No plan, tier, or trial state limits order placement, count, or type.

**Rejected.** *Meter paper trades* — the most obvious monetisation lever, what most competitors do, and it converts well.

**Why rejected.** The mission is "learn before you risk real money." **A platform that meters practice has inverted its own mission for revenue.** We gate intelligence, never execution.

---

## ADR-034 — The entitlement decision is a typed object, not a boolean
**2026-07-18 · ✅ accepted**

**Decision.** `EntitlementDecision { allowed, reason, quota?, decidedAt }` with nine `reason` values, surfaced in the 403 body.

**Why.** A boolean tells the UI to show a lock. A reason tells it *which* lock: "start your trial" ≠ "50 of 50 research runs used" ≠ "your payment failed." It is also what makes support tractable — *"it says I can't access Sentinel"* is unanswerable; `reason: 'quota_exhausted'` is a one-line answer.

---

## ADR-035 — Archive, never delete
**2026-07-14 · ✅ accepted (CLAUDE.md Rule 1)**

**Decision.** Superseded code goes to `archive/`. Not even in bypass-permissions mode. Applied at the data layer too: `Instrument.active` soft-delete, `RefreshToken.revokedAt`, append-only `ConceptObservation`, retained flattened `Position` rows, and **retained reversed decisions**.

**Why.** In a trading system, *"why did we stop doing it the old way?"* is asked at 3 a.m. during an incident, and `git log` archaeology is a bad answer.

**⚖️ The one negotiated exception.** Regulatory retention pruning (Chapter 17 §17.5.2) requires an explicit written policy, compliance sign-off, and archival to object-locked cold storage **before** any drop.

---

## ADR-036 — Two knowledge systems, deliberately separate
**2026-07-17 · ✅ accepted**

**Decision.** `TradeW/knowledge/` (Obsidian, knowledge about *building* TradeW, **never in the runtime**) and `TradeW/knowledge-base/` (YAML, knowledge about *markets*, **seeded into the runtime**).

**Why.** Mixing them means a 3 a.m. debugging note could be cited in a user-facing market observation.

---

## ADR-037 — Sentinel is a workspace, not a standalone product
**2026-07-21 · ⛔ reversed, then reinstated the same day**

**The sequence.**
1. Sentinel is a workspace inside TradeW (original).
2. **2026-07-21 morning:** re-specified as a standalone product — own marketing site, own application, no shared navigation.
3. **2026-07-21 same day:** **reversed.** Never executed in code.

**Why it was reversed.** It created a direct conflict with `TRADEW-OS.md` §1's *"never separate products bolted together."* And an earlier chrome-less attempt had already been built and reverted for a concrete reason preserved in `nav-config.tsx`: *"that left no way to navigate back out to the rest of the app, a dead end rather than 'standalone.'"*

⭐ **The general heuristic this produced:**

> **A change that requires amending the constitution to stop being a violation is a signal to re-check the change.**

**Consequences.** `STANDALONE_ROUTES: string[] = []` remains in the codebase — the mechanism kept, the usage withdrawn, with the reason in a comment. The rejected direction's note is **retained** under ADR-035 for its still-accurate ground-truth findings. **Marketing surface ≠ application architecture:** a Sentinel landing page is fine; the rule binds from sign-in onward.

---

## ADR-038 — Staying on PostgreSQL (Oracle migration rejected)
**2026-07-17 · ✅ accepted (resolved 2026-07-17)**

**Context.** An Oracle standardisation was proposed.

**Decision.** Stay on PostgreSQL.

**Why.** Prisma has **no Oracle provider** — standardising meant full Prisma removal. pgvector requires Oracle 23ai. There was no SQL Server to replace. The cost was a rewrite of the entire data layer for zero product benefit.

---

## ADR-039 — Single VM before Kubernetes
**2026-07-17 · ✅ accepted**

**Decision.** One OCI Ampere A1 (arm64) VM with docker compose. `infra/k8s/` and `infra/terraform/` remain README-only.

**Why.** ₹0 versus ₹15,000+/month; hours versus weeks to first deploy; `docker compose logs` versus `kubectl` archaeology. Trigger: load a single VM demonstrably cannot serve — **not** a feeling that a real company runs Kubernetes.

**Consequences.** The compose topology maps one-to-one onto Deployments, so the migration is mechanical.

---

## ADR-040 — Same-origin routing to eliminate CORS
**2026-07-17 · ✅ accepted**

**Decision.** Caddy serves the app and strips `/api/*` before proxying to the API. The browser makes same-origin requests.

**Consequences.** No preflight, no CORS headers, no cookie `SameSite` complications in production. `enableCors` in `main.ts` exists for local development only, where the dev server runs on a different port — and its permissive branch is gated on `NODE_ENV`, unreachable in production.

---

## ADR-041 — Self-imposed limits, observed and never enforced
**2026-07-21 · ✅ accepted**

**Decision.** Daily loss limits, trade limits, and position-size limits are **set by the user** and **observed** by the platform. TradeW never blocks an order for crossing one.

**Rejected.** *Platform-enforced limits* — ⚖️ makes the platform a trading decision-maker; behaviourally, users learn to raise the limit or route around it; and it puts a limit service in the order path (ARCH-3).

**The output that defines it:**

> *"You set a ₹10,000 daily loss limit. Today's realised P&L is −₹11,400 across 9 trades. You have crossed this limit on 3 of the last 20 sessions. On those 3 days, trades placed after crossing it added a further −₹18,200. **This is an observation, not a restriction.**"*

---

## ADR-042 — Directional outcome labels, not confirmed/failed
**2026-07-21 · ✅ accepted**

**Decision.** `OutcomeLearningService` labels pattern occurrences `continued_up` / `continued_down` / `unclear`.

**Rejected.** *`confirmed` / `failed`* — *"would require opinionated per-pattern interpretation this phase doesn't build yet."*

**Why.** "Did the bull trap confirm?" requires deciding what confirmation *means*, which is a modelling opinion. "Did price go up or down?" is a fact. **Record facts now; layer interpretation later, when there is enough data to validate the interpretation.**

---

## ADR-043 — Withhold statistics below a sample size
**2026-07-21 · ✅ accepted**

**Decision.** `HistoricalSimilarityService` sets `sampleTooSmall` below 5 outcome-tagged samples and withholds the verdict.

**Why.** "This pattern resolved upward 100% of the time" on a sample of two manufactures false confidence in a domain where false confidence is expensive.

**Consequences.** ⭐ The willingness to say *"I don't have enough data to tell you"* is what makes the rest of the output trustworthy. Generalised as DP7 (withhold rather than mislead) and applied to Market Context's unavailable dimensions and to behavioural statistics.

---

## ADR-044 — The distillation path via provider abstraction
**2026-07-17 · ✅ accepted**

**Decision.** News classification runs through `ProviderManager`. Pointing `NVIDIA_NIM_BASE_URL` at a distilled student model switches inference **with zero code change**.

**Why news classification.** High volume, low complexity, a closed 13-category output set, and `NewsEvent.classifiedBy` makes the training set self-accumulating and filterable by teacher.

**Consequences.** ~10–50× cheaper per classification when it lands. Only possible because of ADR-013.

---

## ADR-045 — `trading-engine` remains un-migrated pending approval
**2026-07-14 · ✅ accepted**

**Decision.** `extreme_algo_package` — a working Dhan options bot handling **real money** — stays at the LLC root, audited but not migrated. Migration requires explicit execution approval.

**Why.** Migration is not a file move: reworking persistence onto shared Postgres with explicit table ownership, converting its REST API to internal-only with service-token auth, wiring it into aggregation, and re-validating the HMAC webhook path. **Every step can lose someone's money if done carelessly.**

**Two decisions already made about it.**
1. `order_poller.py`'s polling-based fill reconciliation is **kept exactly as it is** — it is a good safety net, not a stopgap. Polling is how you find out about a fill whose webhook never arrived.
2. Its REST API becomes **internal-only**. Never public, never called with an end-user JWT.

---

## 26.1 Open decisions

Deliberately unresolved. Guessing would be worse than leaving them open.

| ID | Question | Blocks | Owner |
|---|---|---|---|
| **OD-1** | Schema split when `trading-engine` moves off SQLite | real-money migration | architecture |
| **OD-2** | `apps/mobile`: React Native or native? | Y3 mobile | product + architecture |
| **OD-3** | Billing provider (Razorpay assumed, not decided) | monetisation | product |
| **OD-4** | TradingView hosting: self-host vs. licensed white-label | Phase 9 | product + legal |
| **OD-5** | When to migrate `extreme_algo_package` | real money | CTO |
| **OD-6** | Reconciling the two simulated engines before Migration 2 | `Candle` | architecture |
| **OD-7** | Fundamentals data source for the screener | screener | product |
| **OD-A** | ⚠️ **Dhan partner account vs. per-user accounts** | live market data | CTO + legal |
| **OD-B** | Dhan data API cost | budget | CTO |
| **OD-C** | Static IP reservation (needed if order APIs are ever in scope) | future orders | infra |
| **OD-D** | Dhan's contradictory daily quota (7,000 or 100,000) | backfill planning | infra |

### 26.1.1 OD-A is the one that matters most

Redistributing one account's exchange data to many end users is a **licensing question, not a technical one** — NSE/BSE license data redistribution separately, and it must be confirmed with Dhan in writing.

⭐ **The engineering hedge:** the ingestor is designed to be per-credential-set either way, so the answer changes *configuration*, not architecture. **That is the right way to handle a blocking external unknown — make the design indifferent to the answer.**

---

## 26.2 Writing a new ADR

```markdown
# ADR-NNN: <title>
Date · Status: proposed | accepted | rejected | superseded by ADR-MMM | ⛔ reversed

## Context
What forced a decision. Evidence, not assertion.

## Decision
What we do. Present tense, specific.

## Rejected alternatives
⭐ THE MOST VALUABLE SECTION.
For each: what it was, and why not.
Include "do nothing" if it was genuinely considered.

## Consequences
Better. Worse. What we accept. What this constrains later.

## ⚖️🔒 Compliance / security implications
Or "none, because …"
```

### Rules

```
   □ One decision per ADR
   □ ⭐ Rejected alternatives are MANDATORY — an ADR without them is
     an assertion, and it will be re-litigated
   □ Never edit an accepted ADR — supersede it with a new one
   □ ⛔ Reversed decisions are RETAINED with the reasoning (ADR-035)
   □ Add a row to §26.0 and a note in knowledge/Decisions/
   □ ⚠️ If it requires amending TRADEW-OS.md → stop, re-check the change
```

---

*Next: [Chapter 27 — Future Vision](27-future-vision.md)*
