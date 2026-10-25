---
type: decision
date: 2026-09-08
tags: [decision, strategy-core, paper-execution, backtest, architecture, sentinel]
---

# Autonomous decision core extracted to `@tradew/strategy-core`

**Read before touching `packages/strategy-core`, the autonomous engine, or any
claim that a backtest measures the strategy the bot runs.**

## The brief

The trading philosophy changed: Sentinel must stop being the thing that decides
what the bot trades. The autonomous engine finds its own setups, derives its own
entry and structural invalidation, targets exactly 3R, journals the reasoning,
and must keep working with Sentinel **completely disabled**. Backtest and
paper/live must call the SAME decision layer — only data and execution differ.

## What the audit found (and it changed the plan)

Most of the architecture already existed and was disconnected:

- **The market-neutral contract was already written and completely unwired.**
  `paper-execution/markets/` holds `strategy-signal.ts`, `execution-adapter.ts`,
  `spot-adapter.ts`, `futures-adapter.ts` and an isolation spec — and *nothing
  outside that folder imported any of it*. Its own header already made the
  argument: "`ExecutionIntent` is not a trade intent. It is an NSE index-option
  order."
- **Sentinel's coupling to execution is ONE line** — `paper-execution.service.ts:290`,
  `await this.sentinel.evaluate(...)`. Everything downstream (policy, risk,
  account, fill, journal) is already Sentinel-free. Decoupling is a port swap.
- **The decision core was already market-agnostic, just in the wrong process.**
  `strategy-rules.ts` is declarative predicates over a `MarketSnapshot`, each
  returning `{ok, note}` with real numbers — exactly the substrate a
  derived-from-data explanation needs.
- **Two unrelated strategy implementations existed**: live ran the declarative
  setup engine, backtest ran a hardcoded EMA-cross loop. A backtest of a
  strategy the live engine does not run measures nothing.

## The decisions

**1. A package, not a service.** `@tradew/strategy-core` holds the decision
framework — no Nest, no I/O, no venue knowledge. `index.ts` states the invariant
that keeps it honest: **nothing here may import from `services/*`**, because a
dependency in that direction puts strategy logic back inside a service and
re-opens the split, and would make the engine depend on Sentinel again.

**2. Extraction was a MOVE, proven by diff, not a rewrite.** `indicators.ts` and
`market-structure.ts` are byte-identical; `rules.ts` differs by exactly one
import line. The old paths remain as **named** re-export shims (never
`export *` — a shim that exports more than the file it replaces is not a shim),
so no import site in the tree changed. Evidence: Sentinel 671 → 684 tests green,
API 1068 green.

**3. `archetype` is the genuinely new idea.** A setup that says "the opening
range broke on volume" describes a thesis and names no price. The old path
papered over that by sizing from account percentages (`riskPerTradePct` 3%,
`rewardPerTradePct` 9%), which yields 1:3 *arithmetically* while the stop lands
wherever the arithmetic put it. **That is a budget, not an invalidation.** Each
setup now declares where its thesis dies — `range-break`, `structure-shift`,
`pullback-swing`, `sweep-reclaim`, `signal-bar` — and `levels.ts` reads a real
price off the chart. Order: anchor → risk → 3R. Nothing may move a stop to make
a ratio work, and a test sweeps final-bar depths asserting the stop is *always*
anchor-minus-buffer or there is no plan at all.

**4. Every threshold is in ATR, never percent or points.** One set of numbers
must serve NIFTY at ~23,600, BTC at ~78,000 and an MCX gold lot at ~155,000, in
three currencies. "0.3% away" is a different claim about each; "0.4 ATR away" is
the same claim about all three. This is what makes market-agnosticism real
rather than aspirational. A null ATR is *cannot say* and refuses — never zero,
which would make every check pass.

**5. Rejections are journalled; ticks are not.** The previous ledger wrote a row
per profile per 30s whatever happened, and 5,202 of its 5,223 rows said
`MARKET_CLOSED` — 98% noise, unusable. `isMeaningfulCandidate` keeps validated
setups and **one-rule near-misses** (the most informative row in the table) and
drops everything else. Rejection reasons are a **closed set** for the same
reason `IMPROVEMENT_KINDS` is closed: the feedback layer counts them, and free
text cannot be counted.

**6. Decision-time state is immutable.** The outcome will be written to a
separate record referencing the candidate. "Was the original reasoning correct?"
is only answerable if the original reasoning still says what it said before the
answer was known.

**7. EMA-cross ported, not retired — and marked `long-only`.** `rules.ts` carries
an explicit warning that `price_above_vwap` and `ema_fast_above_slow` are
bullish-ONLY predicates, so a setup built on them "is structurally incapable of
taking the short side". The port uses them because that is the rule the backtest
actually measured, so `directionality` is now a declared field: **a long-only
strategy measured across a falling season is abstaining, not underperforming,
and those must not look alike.** It gets no special standing otherwise.

## Two lists, and why that is safe

`AGENT_SETUPS` (core) and `BUILT_IN_STRATEGIES` (Sentinel) share four ids.
Merging them would push Sentinel's presentation metadata (knowledge concepts,
evidence keys and weights) into a package that must stay free of it. Two lists
sharing ids is the "two representations, both valid, silently disagreeing"
failure this repo has recorded three times — so
`src/intelligence/setup-conformance.spec.ts` asserts the shared fields equal and
pins `resolveBias` (the one genuine duplication) branch by branch. **If it
fails, do not loosen the comparison — decide which list is right and change the
other.** It is registered in Sentinel's vitest `include` allowlist, without
which it would silently never run.

## The stale-`dist` trap, pre-empted

The package is consumed via `main: dist/index.js`, so a service reads the BUILT
output while `tsc --noEmit` and the package's own vitest both read `src/`. Edit
the core, forget to build, and the engine decides differently in the market than
in the tests **with every signal green** — the same class as the stale
`dist/main.js` session and the `@tradew/database` drift. Mitigated by
`scripts/build-if-stale.mjs`, mirroring `@tradew/database`'s copy (conditional,
because `start:all` boots services concurrently), wired into `predev:api` and a
new `predev:sentinel`.

Related: [[Decisions/2026-09-07 - Autonomous paper lifecycle (kill switch, excursions, staged learning, partial exits)]],
[[Decisions/2026-09-07 - Multi-market experiment (BTC, Gold) and the chart-reuse question answered]],
[[Gotchas/2026-09-08 - The bot placed zero orders because the laptop slept through market open]].
