---
type: pattern
date: 2026-08-06
tags: [sentinel, gate, testing, tooling, ui]
---

# Sentinel pre-live-validation hardening — two gates collapsed into one

**Read before touching `StrategyAdvisorService.sideInFocus`, or
`tsconfig.scripts.json` in any service.** Closes the P0/P1/P2 items from the
production readiness audit that did not need live data. Continues
[[2026-08-06 - Sentinel publication gate (four conditions, not one threshold)]]
and [[2026-08-06 - Sentinel Phases 2-6 (behaviour, lifecycle, calibration, annotations, cross-validation)]].

Live-session procedure: `docs/SENTINEL-LIVE-VALIDATION-RUNBOOK.md`.

## The P0 defect: a second, weaker gate nobody noticed

Phase 1 wired the four-condition gate into `decide()`, which governs
`ObserveResponse.synthesis`. **`sideInFocus` is computed on a different path**
and still gated on `confidence.meetsThreshold && guidanceState` alone.

So a Side in Focus — a *directional* read, the most consequential thing
Sentinel surfaces — could reach a trader at 71% confidence with a mandatory
strategy rule unmet, conflicting evidence present, and zero independent
corroboration. The binding product rule names Side in Focus explicitly.

**The general lesson: adding a gate is not the same as removing the old one.**
Grep for every consumer of the value the new gate was supposed to govern. Here
the audit found it only because the response fields were enumerated one by one.

Fixed by passing the `PublicationDecision` into `sideInFocus` as a **required**
parameter. Required, not optional — an optional gate is one a future call site
can forget, which is exactly the mistake being corrected. The decision is
passed rather than recomputed for the same reason the live-performance check is
passed into `SynthesisService.synthesize`: two evaluations of one rule
eventually disagree, and the silent one is the one a trader sees.

## `tsconfig.scripts.json` typechecked ZERO files — for months

`tsconfig.json` has `"exclude": ["node_modules", "dist", "scripts"]`.
`tsconfig.scripts.json` extends it and lists `"include": ["scripts/**/*.ts", ...]`.

**`exclude` is inherited through `extends` and is applied AFTER `include`.** So
the scripts project resolved to nothing, and `npx tsc -p tsconfig.scripts.json`
exited 0 while checking no script at all. The harnesses run under
`ts-node -T` (transpile only), so nothing else caught their type errors either.

This is why breaking `sideInFocus`'s signature produced **no** compile error —
it would have surfaced as a runtime assertion failure in a harness nobody runs
on a schedule. Fixed by declaring `"exclude": ["node_modules", "dist"]` in the
scripts config to override the inherited value. **25 latent errors** surfaced
immediately (an `assert(cond, message)` helper whose `message` was required
while every second call site omitted it; two `TrendAnalysis` fixtures missing
`volumeStrength`; a `MarketDataProvider` stub missing `name`; an unvalidated
CLI string flowing into a `CandleInterval`).

**Check this pattern in every other service** — the same `extends` + `exclude`
shape is the default shape.

## Date eviction, not a market-close hook

The audit flagged `StrategyLifecycleService.tracked` growing unbounded, with a
`clearSession()` that nothing called. The obvious fix — call it from a
market-close hook — fails in both cases that matter: a scheduled job does not
run on a process restarted after the close, and a client-driven call never
arrives from a tab that was closed.

Instead every `advance()` evicts entries whose stamped IST date is not today,
plus a 5 000-entry cap as a backstop for a single pathological day. The session
key already carries its own date, so a stale entry is identifiable without
remembering anything about how it was created. `clearSession()` is kept for
explicit disposal; it is no longer load-bearing.

## Other findings worth not rediscovering

- **`market-clock.spec.ts` now runs.** It existed for months outside the vitest
  allowlist. It passes (+28 tests), including the pinned KNOWN-GAP assertions
  recording that the clock is day-of-week and holiday blind. Suite: **292**.
- **`warn` is not a Tailwind token.** The preset defines
  `amber`/`amber-bg` for warnings; `bg-warn-bg` renders nothing with no build
  warning. Third instance of this class of bug in the vault after `bg-surface`
  and `/opacity` modifiers — **grep the preset before using a colour name.**
- **`package.json` had a duplicate `"test"` key**, which esbuild warned about on
  every vitest run. Removed.
- **`engineTwo` was a dead parameter** on `CrossValidationInput` — declared,
  passed, never read. Removed with a note explaining why Engine 2 is *not* a
  sixth evidence dimension: it is a second reader of the same evidence, and
  folding it in would count technicals and structure twice.
- **`app.module.ts`'s `MARKET_DATA` comment was stale**, still describing a
  simulator fallback removed on 2026-07-26. Corrected — a comment describing a
  safety net that no longer exists is worse than no comment.
- **Publication decisions and confidence were not logged at all.** One
  structured `OBSERVE` line per observation now carries detections, the gate
  decision and its binding constraint, confidence, structure/behaviour, regime,
  consensus, lifecycle transitions and the surfaced side. Instrumentation only.

## UI: the intelligence existed and was invisible

`MarketReasoningPanel.tsx` renders `marketBehaviour`, `strategyLifecycles` and
`institutionalCrossValidation` — three of the five response fields that nothing
consumed. Abstaining dimensions are styled deliberately *unlike* a vote, so "no
data" cannot read as mild agreement.

## Verified, and not

Verified: **292/292** unit tests, **37/37** runtime assertions, **20/20**
advisor harness, **0 type errors** across `services/sentinel` (src *and*
scripts), `services/api` and `apps/web`. `/sentinel` renders with no React or
compile errors (only `ECONNREFUSED` to backends that were not running).

**Not verified:** the new panel has never rendered with real data — `/observe`
503s without a feed, and the panel returns null when there is nothing to show,
so it cannot be seen until the live session. The `OBSERVE` log line executes
(every harness `observe()` passes with it in place) but its **rendered text has
never been displayed** — Nest's logger is suppressed under
`Test.createTestingModule`. Eyeball it at 09:15.
