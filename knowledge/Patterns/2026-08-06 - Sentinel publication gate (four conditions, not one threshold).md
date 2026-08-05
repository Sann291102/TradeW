---
type: pattern
date: 2026-08-06
tags: [sentinel, reasoning, confidence, gate]
---

# Sentinel publication gate — four conditions, not one threshold

**Read before touching `SentinelOrchestratorService.decide()`,
`ConfidenceEngine`'s threshold, or anything that decides what reaches a
trader.** Phase 1 of the finalized six-phase product vision. Related:
[[2026-08-05 - Sentinel reasoning-engine merge (Engine 1 reads Engine 2 as corroboration)]]
(supplies the `crossValidation` this reads),
[[2026-08-04 - SentinelIntelligence live-performance gate (books must be proven live)]]
(the same asymmetry, applied in Engine 2),
[[2026-07-26 - Sentinel Master Plan integration (12 modules into the existing service)]].

## The rule that changed

`SENTINEL_MASTER_PLAN.md` principle 3 and `DEFAULT_CONFIDENCE_THRESHOLD` both
said **≥ 85% confidence publishes**. That single check was the entire gate on
market guidance (`decide()`, formerly `if (ctx.confidence.meetsThreshold && …)`).

It is now **four conditions, all required** (`orchestrator/publication-gate.ts`):

1. combined adaptive confidence ≥ **70** (`PUBLICATION_CONFIDENCE_THRESHOLD`),
2. every mandatory strategy confirmation validated,
3. no conflicting evidence, and
4. ≥ 2 independent corroborating sources.

**The threshold went DOWN (85 → 70) and the gate got STRICTER.** That is the
point, and it is the thing to understand before "restoring" the 85. The 85 was
doing structural filtering bluntly: it suppressed genuinely corroborated setups
for being 84% certain, while still in principle admitting an 86% assembled
mostly from factors reporting *no data* (several factors return a neutral
45–55 when their input is absent — see `ConfidenceEngine`'s `optionChainSupport`
and `newsEnvironmentAlignment`, both of which currently run on empty inputs
because `getOptionChain`/`getNews` return `[]`). Quality now comes from
corroboration, not from a high percentage.

User decision, 2026-08-06, recorded verbatim in-session: *"Sentinel must never
publish an observation based on confidence alone."*

## Why the threshold is fixed while the weights adapt

Phase 4 drives `ConfidenceEngine.recalibrate()` from real outcomes, so factor
weights self-tune per regime and per strategy. The **publication threshold
itself is a constant and must stay one.** A system that can move its own bar
can quietly lower it, and no audit of a past observation could then say what
bar it actually cleared. Weights adapt; the gate does not.

`resolveThreshold()` enforces the corollary: a request may **raise** the bar,
never lower it (`Math.max(70, requested)`). Without that floor, any caller
could opt out of the publication rule by passing `confidenceThreshold: 0` —
the web client already sends its own value (72), so this is a live path, not a
hypothetical.

## Three decisions worth not re-deriving

- **Engine 2's silence is not disagreement.** `crossValidation` is null
  whenever SentinelIntelligence has no recent background run, and its coverage
  is deliberately sparse (only cooldown-cleared new setups). Counting null as a
  conflict would make Engine 1 hostage to Engine 2's coverage gaps — strictly
  worse than before the merge. Only a *surfaced and disagreeing* run is a
  conflict. Pinned by a test.
- **The leading detection does not corroborate itself.** It is the claim under
  test; counting it would make condition 4 satisfiable by the very thing being
  checked. Corroboration comes only from session structure, a live-market track
  record, or Engine 2 — three genuinely independent ways of being right.
- **Risk warnings are exempt, as they are in Engine 2.** The composite
  behavioural/trap path keeps its own independent threshold. A revenge-trading
  or trap warning matters whether or not a technical setup confirmed, and
  trapping a corroborated safety signal behind a strategy-confirmation
  requirement would fail exactly where the product exists to help. Same
  asymmetry as the live-performance gate's `risk-elevated` exemption.

## Wait and Watch now explains itself

The old gate produced `synthesis: null` and nothing else — silence with no
reason, which teaches nothing in an educational product. `decide()` now records
the binding constraint on the timeline and returns a `publication` field
(present whether or not anything published) carrying every condition, passed or
failed, with readable evidence.

`waitAndWatchReason` names the **binding** constraint specifically, not the
first check that happened to fail: "the retest volume rule has not confirmed"
rather than "confidence too low". `WaitingForConfirmation` in
`apps/web/src/components/sentinel/SideInFocusCard.tsx` renders the full
condition list.

`services/api` needed **no change** — `sentinel.service.ts` does
`return res.json()`, passing the body through unmodified, so new response
fields reach the web client for free. Worth knowing before writing forwarding
code for a future field.

## Verified, and not

Verified: `services/sentinel` `vitest run` **166/166** (144 pre-existing + 22
new in `publication-gate.spec.ts`, added to the `vitest.config.ts` allowlist),
`tsc --noEmit` clean in both `services/sentinel` and `apps/web`.

**Not verified:** no live `/observe` run against a real feed. This dev
environment has no live Dhan bridge and no backfilled `Candle` rows, so
`/observe` 503s at the data layer before reaching the gate — the same
environment gap recorded in
[[2026-08-05 - Sentinel multi-strategy selection (Phase 2 of reasoning consolidation)]].
The gate is covered by direct unit tests only; its wiring into `decide()` was
read-reviewed, not exercised end-to-end.

**Expected consequence, stated plainly:** on a cold Brain, condition 4 will
often be the binding constraint — historical corroboration needs outcome-tagged
occurrences that only accumulate in normal operation. Directional reads will be
quieter than the raw confidence score suggests until the Brain populates. That
is the gate working, not a regression.

## Still open (Phases 2–6)

`SENTINEL_MASTER_PLAN.md` Module 12's recalibration loop exists as
`ConfidenceEngine.recalibrate()` but **is still never called with real backtest
data** — "adaptive" confidence is adaptive by design and static in fact until
Phase 4 lands. Option chain and news remain empty inputs
(`CandleMarketDataProvider.getOptionChain`/`getNews` return `[]`), so two of
the seven confidence factors run permanently neutral.
