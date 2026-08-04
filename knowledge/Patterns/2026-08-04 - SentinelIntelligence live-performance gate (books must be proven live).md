# SentinelIntelligence live-performance gate — books must be proven live

**Read before changing any surfacing gate in
`services/sentinel/src/sentinel-intelligence/synthesis/`.** The gate is now
three conditions, not two. Related:
[[2026-08-03 - SentinelIntelligence (second reasoning engine, citation-grounded)]]
(the engine this gates), [[2026-07-26 - Sentinel Master Plan integration (12 modules into the existing service)]]
(the orchestrator's own two gates, unchanged), [[Decisions/2026-07-21 - Sentinel Concept Knowledge Graph (living ontology)]].

Branch `feat/knowledge-workspace`. ~150 lines across 6 files. UI untouched by
design — this is entirely a change to what earns the right to reach a trader.

## The hole the existing two gates could not see

The engine gated on aggregate confidence ≥ 0.70 **and** ≥ 2 corroborating
agents. Both measure *agreement among agents reading the book corpus*. Neither
measures whether the corpus is right about **this instrument**.

Ten agents can agree, at 90% confidence, from four different books, about a
setup those books describe beautifully and that has never once resolved in this
live market. Every existing gate clears. The observation surfaces. Nothing in
the pipeline was capable of noticing.

So the third condition: **a directional read must name a pattern that has
actually resolved in a live market enough times to mean anything.** Confidence
is agreement; live outcomes are evidence. They are not substitutes, exactly as
confidence and corroboration are not substitutes for each other.

## Why `risk-elevated` is exempt — and this is the load-bearing decision

The gate applies to `bullish`/`bearish` only.

A directional read carries an implicit claim that a setup *is working*. That
claim has to be earned against live outcomes. A `risk-elevated` reading makes
no such claim — it reports a hazard the agents can see in the data right now,
and Sentinel's entire mandate is behavioural safety. Withholding a corroborated
warning because the pattern lacked a track record would make the product less
safe in precisely the situation it exists for.

This mirrors the existing rule that `risk-elevated` stays off the directional
axis (2026-08-03 note). The same asymmetry, applied to a different gate: a
directional read must earn its way out; a safety warning must not be trapped in.

Pinned by `gate.spec.ts` — "never withholds a corroborated risk warning for
lack of a track record."

## The floor is the Brain's floor, deliberately

"Enough times" reuses `StrategyIntelligenceService.MIN_SAMPLE` (8
outcome-tagged occurrences) via `baseRateFor().reliable`, rather than
introducing a second threshold. That constant already encodes the decision
about where a base rate stops being false precision; a second, independently
tuned floor would be two answers to one question, drifting apart silently.

The data comes from the Brain's outcome-tagged occurrences — the store the
**orchestrator** writes to on every triggered signal
(`PatternRecognitionService.recordOccurrence`, tagged by
`OutcomeLearningService` after 15 minutes). This is the first read SentinelIntelligence
does from that store, and it is the point: both engines are now judged against
one shared record of what actually happened, not two separate tallies that
could disagree.

## Shape decisions worth not re-deriving

- **The gate stays pure and synchronous.** `SynthesisService.synthesize()` takes
  the live-performance result as an *input*; it does not look it up. The lookup
  is async and Prisma-backed, and pushing it inside would have made the single
  most important behavioural guarantee in the module untestable without a
  container and a database. `gate.spec.ts` still constructs the service with
  `new SynthesisService(config)` and no infrastructure.
- **The pattern is resolved before synthesis, by the caller.** `resolvePattern()`
  was extracted from what `compose()` was doing privately *after* the gates, so
  the gate and the observation are provably arguing about the same pattern.
- **It fails closed.** A Prisma outage returns `{ sample: 0, reliable: false }`,
  which holds a directional read back. A database being down must never be the
  reason an unvalidated setup reaches a trader.
- **The env toggle is opt-out, not opt-in.** `SI_REQUIRE_LIVE_PERFORMANCE=false`
  disables it; *any* other value, including absent, empty or malformed, leaves
  it on. A config typo must not quietly restore ungrounded surfacing.
- **`livePerformance` is recorded on every run**, surfaced or not, so the audit
  trail shows what the gate was judged against rather than only its verdict.

## The expected consequence, stated plainly

On a cold or lightly-populated Brain, **directional observations will mostly
stay silent**, and the silence reason will say so with the occurrence count.
That is the gate working, not a regression. Risk warnings are unaffected.
Surfacing recovers as the orchestrator accumulates outcome-tagged occurrences
in normal operation.

## Verified, and not

Verified: 24 gate tests pass (9 new), 112 across `services/sentinel`. `tsc`
error count identical before and after (40, all pre-existing — the Prisma client
has no `conceptNode`/`conceptEdge` models generated).

**Not verified:** no end-to-end run against a populated Brain — the behaviour
against real accumulated occurrences is pinned by unit tests only. The
orchestrator's own `/observe` gates were not touched.

## Still open

`SentinelIntelligence` computes market state **once per HTTP request**
(`computeSharedState`) and so does the orchestrator (`market.snapshot()` per
`/observe`); the web client polls neither. Neither engine "watches the charts
continuously" despite reading genuinely live ticks. A push contract exists at
`packages/market-data/src/contracts/feed.ts` and has never been wired into
`services/sentinel`. Continuous watching is Phase 2 and is not what this note
describes.
