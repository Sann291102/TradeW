---
type: pattern
date: 2026-08-06
tags: [sentinel, reasoning, learning, visual, architecture]
---

# Sentinel Phases 2–6 — behaviour, lifecycle, calibration, annotations, cross-validation

**Read before touching `intelligence/market-structure.ts`,
`strategy/`, `improvement/adaptive-calibration.service.ts`, or
`orchestrator/institutional-cross-validation.ts`.** Continues
[[2026-08-06 - Sentinel publication gate (four conditions, not one threshold)]]
(Phase 1). Related:
[[2026-08-05 - Sentinel reasoning-engine merge (Engine 1 reads Engine 2 as corroboration)]],
[[2026-08-04 - SentinelIntelligence continuous market watch (polling, not a sixth WebSocket)]],
[[2026-07-26 - Sentinel Master Plan integration (12 modules into the existing service)]].

All five phases are additive. `SentinelOrchestratorService.decide()`, the state
machine, the timeline and both reasoning engines keep their existing contracts.

## Phase 2 — behaviour, not just indicators

`intelligence/market-structure.ts` (pure) + `market-behaviour.service.ts`.
Swing detection → structure state (uptrend/downtrend/range) → **break of
structure vs change of character** → liquidity pools and sweeps →
continuation/reversal read.

Three decisions worth not re-deriving:

- **BOS and CHoCH are distinguished deliberately.** They look identical on a
  chart and mean opposite things: a higher high in an uptrend continues it, a
  higher high in a *downtrend* breaks it and is the earliest structural
  evidence of reversal. Collapsing them into "a level broke" destroys exactly
  the information a trader needs.
- **A sweep is defined by the CLOSE, never the wick.** Trading beyond a level
  and closing beyond it is *acceptance* (the market revalued); trading beyond
  and closing back inside is a *sweep* (the move existed to reach stops). The
  two are indistinguishable until the bar closes.
- **Regime classification is borrowed, not re-implemented.**
  `regimeFromProfile` was made `export` and is reused. A second classifier
  reading the same snapshot would eventually disagree with
  `RegimeIntelligenceService` with no principled way to say which was right —
  that file's own header already warned about this.

Behaviour feeds the Phase 1 gate as both a corroboration source (well-supported
continuation in the setup's direction) and a conflict (well-supported reversal
risk against it), floored at `MIN_BEHAVIOUR_STRENGTH = 0.35` so a marginal
structural wobble cannot veto an otherwise clean setup.

## Phase 3 — a SECOND state machine, per strategy

`strategy/strategy-lifecycle.ts` (pure reducer) + `.service.ts` (tracking).
Watching → Forming → Confirmed → Side in Focus → Active → Momentum Weakening →
Move Complete → Invalidated → Learn.

**This does not replace `state-machine/`.** That one describes the *session*
and seven surfaces key off its semantics. With multi-strategy selection a
trader pins several strategies at once and they are rarely at the same stage,
so one global label has to describe all of them and therefore describes none.

- **Invalidation is checked FIRST**, before any progression. Checking
  progression first would let a strategy reach MOVE_COMPLETE on the same tick
  its invalidation fired, recording a success the market did not give.
- **FORMING → WATCHING is legal and is not a failure.** A setup that never went
  live did not fail; recording it as failed pollutes the outcome sample the
  Brain learns from. A setup that reached CONFIRMED and then vanished *is* an
  invalidation.
- **SIDE_IN_FOCUS requires the publication gate, not just a rule match** —
  otherwise Phase 1's four conditions are bypassed by the lifecycle.
- **`WATCHING`/`FORMING` → `SIDE_IN_FOCUS` is reachable directly.** A test
  caught this: observations are discrete samples ~1 min apart, and a setup can
  confirm *and* clear the gate between two of them. Forcing an intermediate
  tick made the lifecycle report a state the market had already left. `ACTIVE`
  stays unreachable from those states — the move cannot be underway before a
  side was ever in focus.
- **Move completion is measured in the setup's direction**, not absolute:
  a bearish setup completes when price *falls*. Absolute measurement would
  complete a bearish setup on the rally that proved it wrong.

Option context (`strategy/option-context.ts`) names the underlying, ATM strike,
CE/PE and positioning. The legality boundary: **naming the contract a read is
ABOUT is context; instructing a trader to transact in it is a directive.** The
type carries no entry/target/stop/size field, so the boundary is structural.
Strike intervals are per-instrument (NIFTY 50, BANKNIFTY 100) — wrong rounding
produces a strike that does not trade and reads as authoritative.

## Phase 4 — the loop that was never running

**The correction:** the vault previously said `recalibrate()` was never called.
More precisely — `ContinuousImprovementService.run()` *does* call it, but `run()`
was reachable **only from an HTTP endpoint** (`app.controller.ts:167`). Nothing
scheduled it, so unless an operator called it by hand, nothing ever
recalibrated. Adaptive confidence was adaptive by design and static in fact.

`improvement/adaptive-calibration.service.ts` adds the daily post-close pass and
calibrates **per (regime, strategy)** rather than one global factor — Module
12's own example is that ORB retests work in trending markets and poorly in
ranges, which a single weight cannot express and whose average makes the
strategy look mediocre everywhere instead of good somewhere.

- Required a schema-free change to `PatternRecognitionService.recordOccurrence`,
  which **dropped `signal.data`** — the regime would never have persisted. Now
  read from `signal.data.regime`; pre-existing occurrences bucket as `unknown`
  rather than being discarded.
- The regime is stamped **when the setup forms**, not when it resolves — the
  outcome belongs to the regime it formed in.
- Reliability is a **±25% multiplier, never a veto**. A silenced strategy can
  never demonstrate it recovered, and suppression would also hide it from the
  trader's own judgement.
- Reuses the Brain's existing 8-sample floor rather than introducing a third
  threshold.
- **Runs only after the close.** Rewriting scoring weights mid-session would
  mean two observations minutes apart were scored by different models with
  nothing in either response saying so.

## Phase 5 — reasoning as drawings

`sentinel-intelligence/visual/reasoning-annotations.ts` converts Phase 2/3
output into the **existing** `ChartAnnotation` contract. The annotation engine
already drew charts, but only from *learned TradingView rules* — a trader had
to teach Sentinel a spec first, while the orchestrator computed structure,
liquidity, S/R and lifecycles every observation and drew none of it.

Inherited guarantees kept: every annotation requires `explanation`,
`triggeredBy` and `confidence`; **partial setups draw nothing** (only CONFIRMED
onward); an **invalidated setup stays on the chart at reduced confidence**
rather than vanishing — a level that mattered and then broke is information,
and a chart that erases its own history teaches nothing.

## Phase 6 — cross-validation across evidence, not engines

`orchestrator/institutional-cross-validation.ts`. `buildCrossValidation` asks
whether the two *engines* agree — useful, but not what a desk means. This asks
whether **technicals, structure, option positioning, historical outcomes and
news** agree with each other, and reports consensus, dissent and abstention.

- **Abstention is not neutrality, and this is the load-bearing decision.** A
  dimension with no data abstains. Option chain and news return empty for every
  symbol today; counting them neutral would report five dimensions in mild
  agreement when only three actually looked.
- **Purely informational — it is not a sixth gate.** `publication` remains the
  only authority on what surfaces.
- **A bug the type-checker caught:** `NewsIntelligenceService` emits under
  `agent: 'market-technical'` (there is no `'news'` member of `SignalAgent`), so
  filtering technicals by agent alone counted the news signal twice — once as a
  technical vote and once as its own dimension. Excluded by name.

## Verified, and not

Verified: `vitest run` **258/258** (144 pre-existing + 114 new across 6 new
suites), `tsc --noEmit` **clean in `services/sentinel`, `apps/web` and
`services/api`**, and **`npm run verify:runtime` 37/37 PASS** — the real
`AppModule` DI graph booting with all three new injectable services, asserting
on the actual `/observe` response rather than unit fixtures, so a service that
resolves in DI but is never called still fails.

**Not verified — external dependencies, flagged rather than worked around:**

- **No live market data.** No Dhan bridge and no backfilled candles in this
  environment, so `/observe` 503s at the data layer against real data. Every
  assertion above runs against the harness's stubbed `MARKET_DATA`.
- **Option chain and news are empty in production**
  (`getOptionChain`/`getNews` return `[]`). Phase 3's option context and two of
  Phase 6's five dimensions therefore degrade honestly rather than being
  exercised. **Needs a data-provider decision.**
- **Phase 5 has no TradingView binding.** The Charting Library is a licensed
  product that must be obtained from TradingView; the backend contract is ready
  and the client-side binding cannot be written without it. **Needs a licensing
  decision.**
- `AdaptiveCalibrationService`'s daily pass has never fired on a real schedule —
  `calibrationFrom` is unit-tested, the timer is not.
