---
type: plan
date: 2026-08-20
tags: [plan, agent-lab, sentinel, paper-trading, agents, memory, knowledge-graph, admin]
---

# Agent Trading Laboratory — audit and architecture plan

**Phase 0 is built and verified** (see the section at the end); Phases 1-4 are
plan only. Product brief: an admin-only laboratory
where TradeW's agents observe live markets, choose a strategy, execute paper
trades autonomously, explain outcomes, and accumulate validated evidence.

Full plan (sections A–L, all 35 requirements mapped):
published artifact `Agent Lab Blueprint`, 2026-08-20.

## The finding that reframes the work

**TradeW already has a multi-agent system.** Roughly 70% of the vision is
running code. The Lab is mostly assembly and governance, not construction.

Verified real: **ten** specialist agents on one `IntelligenceAgent` contract
(market, news, options-chain, risk, strategy, trap, emotion, compliance,
historical-pattern, learning) with `AgentContext` computing the market read
**once** so agents cannot disagree from reading different ticks; `VerdictBuilder`
making an uncited knowledge claim structurally unconstructible; the per-strategy
lifecycle already ending `INVALIDATED → LEARN`; `CognitiveProposal` already
providing operator-gated learning governance with no `execute` kind; four memory
systems (pgvector `MemoryRecord`, entity graph, concept graph, `NeuralSynapse`
Hebbian weights); 17 perceptors; and 15 ingested knowledge-base topic folders.

## Nine gaps, and the three that bite

1. **Agent telemetry is empty platform-wide.** `AgentRun` / `AgentActivity` /
   `AiCallLog` hold zero rows — `setTelemetrySink` is only called in
   `services/api` while all agent work runs in the Sentinel process. The control
   room's headline feature has **no data source**. Plan works around it with an
   `ExperimentEvent` log written by `services/api`; the platform gap remains.
2. **`services/tradew-ai` is a shell** (its own README says so). The product
   brief's `TradeW AI → Sentinel` topology would route the Lab through an empty
   service — and would create the `tradew-ai ↔ sentinel` arrow `TRADEW-OS.md`
   §2.4 forbids. **Recommendation: `services/api` is the only coordinator**,
   which is the arrow the paper loop already uses.
3. **No message bus of any kind** — no EventEmitter2, BullMQ, Kafka or Redis
   queue. Everything coordinates through Postgres + polling + `JobLease`. Agent
   messages should be an append-only typed table, not a broker.

Also missing: command plane, experiment record, post-trade analysis, any chart
in `apps/admin`, and — from the backtest work — **zero historical option
candles** with only three indices carrying intraday bars, so "five index
environments" needs a backfill first.

## Positions taken against the brief

**Graphify: recommended against.** Zero references in the repo and no current
maintained product by that name identifiable. Adopting it means a second graph
store beside Postgres, where three graph structures plus pgvector already share
one transaction boundary — experiments and their edges could no longer be
written atomically, and "the graph disagrees with the database" becomes a
permanent bug class. Get the real-time behaviour by writing edges **as
experiments run, in the existing tables**.

**Polymarket: not yet.** No liquid markets on NSE intraday direction. Its real
content is macro event probability — a slow **regime** input, never an entry
trigger. If added, it enters like news: cited `EvidenceItem` with `staleAfter`,
and only into regime classification.

**"Fewer limits" splits in two, and only one half is negotiable.** Product
limits (confidence floor, orders/day, open positions, loss limit, session
window, square-off, capital allocation) are configurable in LAB mode. Technical
invariants (PAPER environment, idempotency, account authorization, lot validity,
margin, reconciliation, leader election, kill switch, audit) stay in the
execution path with **no configuration surface at all**.

**Authority is split three ways** so no component can trade on its own say-so:
Sentinel *observes* and may never authorize; Lab Policy *authorizes* and may
never observe; Paper Execution *executes* and may never decide.

## Things to know before building

- **The kill switch must be evaluated in the execution path, not the
  orchestrator** — one that lives in the orchestrator stops working exactly when
  the orchestrator is what broke.
- **`MemoryRecord.staleAfter` is honoured on read** (the cognition store filters
  expired rows out of retrieval) but **nothing in production ever writes a
  value** — only a test script does. The decay mechanism is built and idle.
- **The paper OMS fills MARKET orders instantly at last-traded price.** For a
  research lab that is optimistic and inflates every result. The backtest
  simulator already models slippage properly; the same treatment belongs here.
- **`PaperWallet.startingBalance` is documented as never changing after
  creation**, and `cashBalance` / `realizedPnl` / every performance metric derive
  from it. The ₹5L→₹2L→₹1L paid-reset business model therefore needs a
  generation/reset-event design and must be **its own workstream**, never folded
  into the Lab.
- **Setup fingerprint** — a stable hash of (strategy + confirmed rule set +
  regime + timeframe) on every experiment makes "have we seen this before" an
  indexed lookup with no embedding and no threshold to tune. Cheap now,
  requires recomputing history if retrofitted.

## Phasing

Phase 0 the `ExperimentEvent` log (everything else renders from it) → Phase 1
one index end-to-end on the existing paper engine → Phase 2 strategy selection,
typed commands, charts, all ten verdicts → Phase 3 learning candidates validated
through the existing backtest platform → Phase 4 scale and other markets via a
`MarketAdapter`.

**Twelve open product questions** are recorded in section L of the artifact;
four block Phase 1 (publication-gate vs raw detections, account/profile model,
scope of the 8-trade/8-position limits, consecutive-loss stop).

## Phase 0 — BUILT and verified (2026-08-20)

Migration `20260820140000_agent_lab_phase0`: `ExperimentEvent` + `LabEventKind`
/ `LabEventSeverity`, and two additive columns on `ExecutionProfile`
(`labEnabled`, `labTimeframe`). `services/api/src/lab/` holds the module; the
console page is `apps/admin/(console)/lab`.

Three decisions worth keeping:

**The event table IS the message bus.** No broker was introduced. The repo has
none, coordinates entirely through Postgres + polling + `JobLease`, and putting
the Lab's audit trail anywhere other than the database it must be reconciled
against would have been the wrong trade.

**`labEnabled` is deliberately NOT `enabled`.** The first answers "should the
Lab watch this market and narrate it", the second answers "may this profile
place orders". Phase 0 needs the first without granting the second, and a
profile can sit observed-but-disarmed indefinitely.

**Emission is phase-gated in code, not by discipline.** `EMITTABLE_IN_PHASE_0`
is data, `LabEventService.emit` refuses anything outside it, and the harness
asserts a `TRADE_PROPOSAL` cannot be written. The brief's one hard requirement
was "no fake dashboard"; the cheapest way to violate it is to emit a kind whose
machinery does not exist, so that is made impossible rather than forbidden.

**The gotcha, found by `verify:agent-lab` and invisible in review:**
`healthFingerprint` originally hashed `blockedBy`, which reads naturally and is
wrong — those strings embed live values ("newest bar … (779949s old)"), so the
fingerprint changed every second and every tick looked like a fresh
degradation. The result was a health event AND a skip event per tick, i.e.
precisely the flood the fingerprint exists to prevent, with the mechanism
apparently working. **A change-detection fingerprint must be built from status,
never from prose describing the status.** Regression pinned in
`lab-phase0.spec.ts`.

Verified: 33 unit tests + **40/40 runtime checks** against real Postgres and
real Sentinel, including the HTTP boundary (anonymous denied, admin token alone
denied, no lab route outside `/admin`) and the isolation claim (zero Order,
Trade, Position, PaperWallet or ExecutionIntent rows). The gate was exercised
truthfully: NIFTY bars are nine days stale, so the Lab correctly reported
WAITING rather than observing.

Related: [[Decisions/2026-08-20 - Backtesting platform (sentinel replays, api owns the money)]],
[[Decisions/2026-08-18 - Sentinel paper execution loop (execution capability, not a second Sentinel)]],
[[Decisions/2026-08-12 - Cognition network (perceptors + four layers)]],
[[Gotchas/2026-08-18 - Sentinel telemetry sink is never installed]].
