---
type: decision
date: 2026-09-07
tags: [decision, paper-execution, risk, learning, autonomous-agents]
---

# Autonomous paper lifecycle — kill switch, excursions, staged learning, partial exits

**Read before touching `services/api/src/paper-execution/*`, `ExecutionControl`, `ExecutionImprovement`, or anything that claims an agent "learns".**

Extends the [[Decisions/2026-08-30 - Autonomous paper agents (complete entry-to-exit cycle)]] loop with the four things it did not have: an operator kill switch, excursion/post-trade analytics, a staged learning pipeline, and partial profit taking. Same architecture — no second orchestrator, no second OMS, `src/sim` untouched, `ExecutionEnvironment` still has exactly one member.

## The reframing finding

The brief asked to "make the bots ready for LIVE trading tomorrow". **There is no live-money path in this repository and there never was**: `enum ExecutionEnvironment { PAPER }` has one member, every `placeOrder` routes to the paper OMS, `services/trading-engine/` is a README-only stub, and Dhan's order APIs are gated behind **static-IP whitelisting with a 7-day change lock** (SEBI algo regulation) that no amount of engineering shortens. Live money was declared out of scope and the work was redirected to completing the PAPER lifecycle. Audit: `docs/AUTONOMOUS-PAPER-LIFECYCLE-READINESS-2026-09-07.md`.

## Five load-bearing decisions

**1. The kill switch is DURABLE, and halting is not flattening.** `ExecutionLoopStatus` is deliberately process-local (a persisted copy would keep asserting "running" after the process died); a HALT is the opposite kind of fact — an operator instruction that must outlive a restart, or a crash/deploy/leader-failover silently resumes trading a human stopped. So it is one row (`ExecutionControl`, id `'global'`), re-read **in the execution path** on every pass — inside `runProfile`, never in the scheduler, because a kill switch living in the orchestrator stops working exactly when the orchestrator is what broke. It gates the hand-run route too, so a halt cannot be stepped around by forcing a pass. **`halt` and `flatten` are two endpoints on purpose**: one button that stopped entries *and* dumped the book would be the most destructive control in the console while looking like the safe one — the same trap the old disarm had. The manager is never gated on the halt; open positions keep their stop, target and trail. `KILL_SWITCH` is in `RecordedExitReason` but **not** in `ExitReason`, so `decidePosition` structurally cannot emit it and an operator flatten is never confusable with a market exit.

**2. Two bounds the existing risk model could not express.** `maxLossPerDay` is ABSOLUTE and never fires on a day that runs +50,000 and hands back 45,000 — realised P&L stays positive and the floor passes on every pass. `maxDrawdownPct` is that give-back bound, computed from the day's `Trade` rows (no stored high-water mark, so it cannot drift from the ledger) with the **peak seeded at 0** so a day that is red throughout still reports a drawdown. `maxPortfolioExposurePct` bounds the SUM: `capitalAllocationPct` bounds one position, and nothing bounded three positions at 20% each committing 60% of the account. Both null-by-default, and **an unmeasurable bound is never a stop** (null denominators report "could not be measured", never 0%).

**3. MFE/MAE are sampled or lost.** No intraday price series is stored per position, so the excursions are knowable only while the position is open. `lowWaterPrice` is the mirror of the existing `highWaterPrice`, **drives nothing** (no exit, no trail, no sizing reads it) and exists solely so the journal can say how close a trade came to its stop. Seeded to the entry price — a zero would report a 100% adverse excursion on every position that had not yet ticked. The payoff is the separation `postTradeAnalysis` enforces: **P&L is not thesis correctness**. A trade that ran +2R and then stopped out was RIGHT and badly managed; judging it by result teaches the agent to stop taking a setup that works. `thesisCorrect` is measured on favourable excursion (≥1R true, <0.25R false, **null in the ambiguous band** — a forced boolean makes every ambiguous trade vote).

**4. Learning is staged, and the dangerous proposal is UNREPRESENTABLE.** experience → learning → candidate → validation → promotion. Two properties do the work: **candidates are generated from ACCUMULATED history, never from the session** (three catastrophic losses in one day propose nothing — the sample floor is checked against lifetime bucket counts), and **`IMPROVEMENT_KINDS` is a closed set in which every member is risk-neutral or risk-reducing**. There is no member that widens a stop, raises size or exposure, lifts a loss limit or lowers the confidence floor — the same technique that makes live money impossible upstream. Validation is a **chronological** holdout (never random: a random split leaks same-session, same-regime trades onto both sides), and **inconclusive is a first-class result** — `TRAIL_STEP_TIGHTEN` cannot be judged from a journal that only records what happened under the trail that was in force, so it returns `conclusive: false` and can never reach VALIDATED rather than being waved through. `promote()` is the **only writer of PROMOTED** in the codebase, requires an operator, requires VALIDATED, and re-checks `isRiskReducing` so that adding a loosening kind later fails loudly instead of quietly widening risk. **No scheduled caller promotes anything** — the nightly job runs the cycle and validation only.

**5. Partial exits rank BELOW every full-exit condition.** A tick that has hit its stop, target, trail or invalidation takes that exit instead — reducing a position that should be closed entirely leaves risk on the table. The atomic claim is on `partialExitCount`, not on `state` (the position stays OPEN by definition), so two passes two seconds apart cannot each sell half; and the count advances **before** the order, so a failed partial is never retried — a partial not taken is a missed optimisation, a partial taken twice is an unintended position change. Quantity is **floored to whole lots** (`placeOrder` rejects anything else) and a "partial" that would close everything is refused: that is an exit wearing the wrong name, and it would bypass the precedence order and mislabel the journal.

## Gotchas worth the read

- **`paper-lifecycle.spec.ts`'s cleanup deletes `strategyCalibration` for agents `sentinel-alpha`/`sentinel-beta`** — the agent on every real seeded profile. It is harmless only while that table is empty. Run it against a scratch database (`TEST_DATABASE_URL`), never the dev one.
- `ExecutionPosition` has **no `instrument` relation**, only `instrumentId`. The manager batch-loads lot sizes in one query per pass rather than joining.
- `ExecutionJournal.intentId` is a real FK — a journal fixture needs real `ExecutionIntent` rows.
- `User` has no `name` column.
- Vitest's `include` in `services/api/vitest.config.ts` is a deliberate **allowlist**; a new spec file that is not added there silently never runs.

## Evidence

Typecheck clean; **1026 API unit tests + 68 admin tests** pass; **14 end-to-end lifecycle scenarios** against real Postgres (entry → plan → stop/target/trail/invalidation/emergency → disarm-does-not-strand → duplicate prevention → calibration consumed by the next decision → two agents concurrently), extended with assertions that MFE/MAE and `postTradeAnalysis` are genuinely populated by the live 2-second manager. Two runtime scripts against real Postgres: `verify:kill-switch` **17/17** (durable across service instances, halts an ARMED profile, resumes) and `verify:learning` **20/20** (cycle applies nothing; a PROPOSED candidate **cannot** be promoted; out-of-sample validation supports; promotion records the operator and never loosens; re-runs do not duplicate). API boots clean with all 9 new routes mapped.

**The unit and lifecycle runs above used scripted prices with the market closed.** The live-session evidence is below.

## First live-market session (2026-09-07, Monday)

**The loop had never run in its life**, and the cause was one missing line: `PAPER_EXECUTION_ENABLED` was **not present in `.env` at all**, so `ExecutionSchedulerService` logged "no timers started" on every boot since it was written. Adding it started the loop at 10:49:13 IST.

Verified live, during the open session: the Dhan bridge ticking (NIFTY 23,790, `source: dhan`, 0–1 s old, 227 front-expiry strikes, 56 candles), and **1,616 evaluations** across 10:00–15:25 at exactly the 30 s cadence, three per tick — one per armed profile, confirmed by the `OBSERVE NIFTY` timestamps clustering in threes.

**Zero trades, and the gate is named precisely:** `published=false` and `sideInFocus=null` on all 1,616, `blockedBy=state-permits-guidance` on all 1,616, with confidence min 44.1 / p50 51.4 / **max 58.1 against a 70 floor**. The session state never left `STRATEGY_DETECTION`/`VALIDATION` for a guidance-permitting state. Two independent gates were unsatisfied all day; neither is a fault.

**The downstream path was audited and is CLEAR** (`verify:execution-path`, new): contract resolves through the scrip master (`NIFTY:20260908:23750:CE`, lot 65), live premium readable (92.35/92.50), feed fresh, wallet funded, risk plan sizes 65 @ 92.5 with stop 60.13 / target 189.61, affordable, drawdown and exposure inside bounds, discipline would not block. The only policy failure after 15:10 is `before-square-off`, which is the designed entry cutoff. So nothing between `executable=true` and the OMS is silently blocking.

**The observability gap this exposed, and closed:** 1,616 evaluations left **no queryable trace** — the only evidence the loop had run was a text log in another service, so "waiting" and "dead" were still indistinguishable from the database. `ExecutionEvaluationLog` is the fix: one row per pass with an 11-member outcome enum (WAIT / REJECTED / PLANNED / SUBMITTED / FILLED / DUPLICATE / FAILED / HALTED / MARKET_CLOSED / DISABLED / UNAUTHORIZED), the groupable `checkId`, and the live confidence/spot/regime — because "how close did it get all day?" is the first question a quiet session raises. It is written **fire-and-forget with its own catch**: observability that can fail an execution decision is worse than none. `ExecutionIntent` deliberately still records only DECISIONS; this is the attendance record.

Gotchas from the day: `Order` has no `createdAt` (it is `placedAt`); `ExecutionIntent` has no `orderId` scalar (the relation is `order`); a `grep -oE "[0-9]{2}:"` hour filter silently drops every single-digit PM hour and made a healthy loop look dead for three hours; and both nest watchers restart on a `package.json` edit, which is what produced intermittent `fetch failed` against Sentinel mid-restart.
