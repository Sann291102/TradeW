---
type: pattern
date: 2026-08-05
tags: [sentinel, reasoning, architecture]
---

# Sentinel reasoning-engine merge — Engine 1 reads Engine 2 as corroboration

**Read before touching `SentinelOrchestratorService.decide()` or assuming
Sentinel's two reasoning engines are still unconnected.** Phase 1 of a
7-phase consolidation plan (full plan: user-approved task, "Sentinel
Reasoning Consolidation & Enhancement"). Related:
[[2026-08-03 - SentinelIntelligence (second reasoning engine, citation-grounded)]],
[[2026-08-04 - SentinelIntelligence continuous reasoning (the watch asks the questions)]],
[[2026-07-26 - Sentinel Master Plan integration (12 modules into the existing service)]].

## What changed

`SentinelOrchestratorService.decide()` (`orchestrator/sentinel-orchestrator.service.ts`)
now reads `SentinelIntelligenceService.latestRun(symbol)` — a cache read, not
a call into Engine 2's pipeline — and judges whether it agrees with Engine 1's
own leading detection. Exported as `buildCrossValidation()` (pure function,
tested directly in `orchestrator/cross-validation.spec.ts`, 5 tests). The
result is attached to a new, purely-additive `ObserveResponse.crossValidation`
field (`domain.ts`), separate from `synthesis`.

## The decision that shaped this: corroboration, not a merge of shells

Two engines exist: Engine 1 (`orchestrator/`, production `/observe`, zero
direct tests, owns the state machine/timeline/Brain writes) and Engine 2
(`sentinel-intelligence/`, 139 tests, citation-grounded three-gate synthesis,
UI-orphaned since `f897383` on explicit product direction). Rebuilding
`/observe` on Engine 2's request-response shell would mean re-deriving session
continuity and timeline dedup for no benefit — Engine 2's value was never its
shell. So Engine 1 stays the only `/observe` entry point and the only thing
that can change what gets said; Engine 2's rigor (citations, structural
uncited-verdict dropping, the three-gate) enters only as corroboration on an
answer Engine 1 was already going to give.

**Zero new infrastructure needed.** `SentinelIntelligenceService.latestRun()`
already existed (populated by `MarketWatchService`'s background reasoning,
added in an earlier phase of this same branch's work) — this phase is the
first thing that actually reads it.

## Three behaviors, deliberately

- `latestRun` is `null` or its own gates didn't clear (`surfaced: false`) →
  Engine 1's output is **byte-identical** to before this change. Engine 2's
  background coverage is intentionally sparse (only cooldown-cleared new
  setups), so this is the common case and must never regress.
- Agrees (`leadingStance` matches Engine 1's bias, *or* the pattern ids
  match — stance-label mismatches happen, e.g. `no-read` vs a bias derived
  from trend direction, so pattern-id agreement is checked independently) →
  Engine 2's top 2 citations are appended into `composeGuidance()`'s evidence
  list, so the LLM-polished (or deterministic-fallback) prose gets real quotes
  instead of staying freeform.
- Disagrees → **never suppresses Engine 1's read.** Making Engine 1 hostage to
  Engine 2's coverage gaps would be strictly worse than today. The conflict is
  not currently surfaced anywhere (deferred — `explain.buildWhy()` was
  identified as the natural home but not wired in this phase, since the
  vision doc's own Phase 1 scope was corroboration only, not conflict
  reporting).

## The `synthesis` name collision, resolved by not colliding

Both engines had a field called `synthesis` with incompatible shapes (Engine
1: prose; Engine 2: gate/verdict object). Fixed by never merging them —
`ObserveResponse.synthesis` is untouched, `crossValidation` is a new sibling
field. `domain.ts` already had a precedent for avoiding a hard dependency on
`sentinel-intelligence/types` (the existing duplicated `KnowledgeCitation`) —
followed the same pattern for a new `CrossValidationConcept` (mirrors
`SupportingConcept`).

## Not done in this phase (later phases per the plan)

- No UI surfaces `crossValidation` yet (Phase 3 — a `Badge` on the existing
  conclusion card, never a second panel, per the `f897383` product decision).
- Disagreement is computed but not reported anywhere user- or admin-visible.
- `decide()`'s numeric confidence score is untouched by corroboration —
  deliberately, to avoid touching the confidence engine's math in a phase
  scoped to be invisible to users.

## Verification

`services/sentinel`: `tsc --noEmit` clean, `vitest run` — 144/144 pass (139
pre-existing + 5 new in `cross-validation.spec.ts`, added to `vitest.config.ts`'s
allowlist). `services/api`: `tsc --noEmit` clean (confirms no cross-service
type coupling broke). Not yet done: a live `/observe` smoke test with a real
`latestRun` populated — the unit tests cover `buildCrossValidation` directly,
which is the entire new logic surface; `decide()`'s wiring of it into
`composeGuidance()` was read-reviewed but not exercised end-to-end.
