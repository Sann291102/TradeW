---
type: decision
date: 2026-08-30
tags: [decision, sentinel, execution, oms, paper-trading, admin, risk, learning]
---

# Autonomous paper agents — the complete entry-to-exit cycle

[[Decisions/2026-08-18 - Sentinel paper execution loop (execution capability, not a second Sentinel)]]
built the entry half: a decision, a policy check, an order. It could open a
position and it could square one off at 15:10 — and **nothing in between**. No
stop, no target, no trail, no thesis-failure exit, no journal, no feedback. An
agent that can only open and wait is not a trading agent; it is a lottery ticket
with an idempotency key.

This closes the loop. Same architecture, extended — no second orchestrator, no
second OMS, no second scheduler, and `services/api/src/sim` still byte-for-byte
the same OMS a human order ticket uses.

## The boundary, restated because it is the whole point

Everything below is **PAPER**. `ExecutionEnvironment` still has exactly one
member, there is still no broker order path anywhere in this application, and
these agents *read* a live Dhan feed and *write* only to `Order`/`Trade`/
`Position` rows in their own account. "Live market data, in-app paper orders" is
not a policy here — it is the absence of an enum value to route anywhere else.

## The load-bearing decisions

### 1. Direction comes from the INDEX. The chain only picks the contract.

`services/sentinel/src/execution/index-direction.ts` reads five weighted signals
of the index — EMA structure, VWAP side, session trend, swing structure, opening
range — and **never touches the option chain**. There is a spec that asserts
exactly that, because the failure it prevents is subtle and expensive: a rising
CE premium is evidence about *that contract's* supply and demand, and reading it
as evidence about market direction means the agent buys strength in whatever it
happens to be looking at. Direction is settled first; only then does the chain
choose a strike, and only on the side direction already implies
(`alignedOptionSide`).

**The trap in weighting abstentions.** The participation floor originally never
fired: a read that abstains contributes 0 to both numerator and denominator, so
one surviving read out of five scored 1.0 and looked unanimous. The fix is
`NOMINAL_TOTAL_WEIGHT` — a *fixed* denominator, so silence reads as silence
rather than as agreement. Any weighted-vote gate in this repo has this bug
waiting in it.

### 2. YAML cannot grant itself the right to trade

`StrategyDefinition.agentTradable` exists, and `normaliseDefinition` — the loader
for `knowledge-base/*.yaml` strategy files — **deliberately does not read it**.
Only the four code-defined strategies (`agent-smc-structure-shift`,
`agent-trend-momentum`, `agent-opening-range-expansion`,
`agent-exhaustion-reversal`) can place an order. A data file that can promote
itself to an order-placing strategy is a config change that ships an order path.

### 3. "3% risk / 9% reward / 20% allocation" — of *what*, decided and documented

The requirement was three bare percentages. Three different readings were
coherent; the repo's own `knowledge-base/risk-management/position-sizing.yaml`
("a predetermined fraction of capital") settles it:

- **20% of wallet equity** is the allocation ceiling — the most premium that may
  be at risk of total loss in one position.
- **3% of wallet equity** is the loss realised *if the stop is hit*. NOT 3% of
  premium: a 3%-of-premium stop on a ₹120 option is 3.6 points, which is noise,
  and an agent stopped out by noise learns nothing except that stops don't work.
- **9% of wallet equity** is the target, i.e. a fixed **3R**.

**The circularity, and how it is broken.** Quantity depends on stop distance;
stop distance sized to spend the risk budget depends on quantity. `planRisk`
orders it: floor the stop first (`MIN_STOP_FRACTION`), cap quantity by budget,
allocation and lots, *then* widen the stop to spend what is left, capped at
`MAX_STOP_FRACTION`. `riskAtStop ≤ riskBudget` becomes structural rather than
checked.

**A rounding bug the sweep found.** `round2(stopDistance)` can round *up*, and a
stop 0.005 wider than planned put `riskAtStop` at ₹1506.45 against a ₹1500
budget. It is `floor2` now: rounding may only ever reduce risk. This is the kind
of defect no example test finds and a sweep finds in one run.

### 4. ONE exit decision, with a written precedence

`position-decision.ts` `decidePosition()` is a pure function and the **only**
place a position's fate is decided:

```
EMERGENCY > STOP > TARGET > TRAIL > INVALIDATED > SQUARE_OFF
```

Two or more services each holding a defensible opinion about the same position is
how a position gets exited twice, or held through its stop because the other
service "had it". EMERGENCY sits above STOP on purpose: a stale or missing quote
means the stop cannot be evaluated, and an unevaluatable stop is a reason to be
flat, not a reason to wait.

### 5. Disarming stops NEW ENTRIES. It does not abandon an open position.

Before this change `ExecutionLifecycleService.squareOff` filtered on
`{ enabled: true }`, so disarming an agent that held a position stopped the
square-off that would have closed it. The operator's mental model ("I turned it
off") and the system's behaviour ("it is still long, unmanaged, overnight")
diverged at the worst possible moment.

`manageAll` selects on `state = OPEN`; `squareOff` no longer reads `enabled` at
all; and — the part that makes it stay fixed — **`PositionFacts` has no `enabled`
field**, so no future call site can reintroduce the coupling without first adding
it back to the type.

### 6. The cadence is derived from the feed, not chosen

Reading `live-feed-server.ts` rather than guessing: `/quotes` is served from an
in-memory WebSocket tick map with no upstream call and no rate limit;
`/optionchain` has a 2 s TTL with live prices overlaid; `/candles` is cached 60 s;
Dhan's own chain limit is ~1 call / 3 s. So: **manage 2 s** (the fastest the chain
can actually refresh), **evaluate 30 s** (the candle cache means faster is the
same data), **reconcile 15 s**. Three separate `JobLease` leases, so a slow 30 s
evaluation cannot stall the 2 s loop that is holding a stop.

"Every 1 second" was available and would have been a lie: the same 2-second body
served twice.

### 7. Learning that can only ever tighten

`StrategyCalibration` buckets by (agent, symbol, strategy, **version**, regime),
needs `MIN_CALIBRATION_TRADES = 8` before it moves anything, and derives its
adjustment from **average R, not win rate** — a bucket winning 70% of the time
with +0.3R wins and −1.5R losses is a losing bucket, and win rate promotes it.

The single most important line in the module:

```ts
export function applyCalibration(profileFloor: number, adjustment: number): number {
  return Math.max(PLATFORM_CONFIDENCE_FLOOR, profileFloor + adjustment);
}
```

`PLATFORM_CONFIDENCE_FLOOR = 70` is a clamp, not a default, and it is swept in
the spec across adjustments **far outside** the legal range — because a row
written by a restore or a manual edit is not constrained by `floorAdjustment`.
Learning can raise the bar and can relax a *stricter-than-platform* profile back
toward 70. It cannot go below it, and it cannot reach a stop, a target, a trail,
a risk budget, an arming state or a line of source code — asserted structurally
by pinning the module's entire export surface in a test.

## What "it learns" means here, concretely

A closed trade writes an `ExecutionOutcome`, which
`ExecutionJournalService.write` folds into `StrategyCalibration` **before**
writing the journal row, so the journal records the calibration version it
produced. The next intent in that bucket stores `calibrationVersion` and
`calibrationAdjustment` — the values it actually consumed. Trade N → bucket vN →
trade N+1 reading vN is therefore a join, not a claim. `paper-lifecycle.spec.ts`
walks it from v1 to v10 and watches the floor engage at the 8-trade boundary.

Everything else this repo calls learning is still logging.

## Verified

- Schema: all 36 migrations apply to a fresh Postgres; `prisma migrate diff`
  returns **"This is an empty migration"** — zero drift between the schema and
  the hand-written migration.
- `services/sentinel` **584/584** (31 files); `services/api` **672 passed + 1
  skipped** (46 files) with a clean typecheck; `apps/admin` **68/68**.
- `paper-lifecycle.spec.ts` — **15 end-to-end scenarios against real Postgres**,
  not mocks: entry through the real `OrderService`, stop, target, trail across
  multiple steps, invalidation, emergency on a stale feed, square-off, disarm
  with an open position, NIFTY and SENSEX simultaneously with separate buckets.
- Market was **CLOSED**. Every scenario drives a scripted price series; the
  cadence claims are derived from the bridge's source and its cache constants.
  **This is not a live-market verification.**

## Traps found while building, worth knowing

- **`vitest` cannot construct a Nest service.** esbuild does not emit
  `emitDecoratorMetadata`, so Nest DI resolves every constructor param to
  `undefined`. Construct services by hand in specs — the convention the rest of
  the API suite already follows.
- **The manager exits on the BID, not the LTP.** A test that drives the LTP to
  the stop and expects an exit will sit there forever. `readPremium` uses the bid
  because that is what a long position actually gets out at.
- **The 15-minute idempotency bucket bites tests.** Two scenarios at 12:40 and
  12:48 are one idempotency key; the second silently produces no order. Space
  scripted trade times more than 15 minutes apart.
- **A daily-loss gate will stop your test suite** and it is right to. Raise the
  fixture's `maxLossPerDay`; assert the gate's own behaviour in the policy spec
  where it belongs.

Related:
[[Decisions/2026-08-18 - Sentinel paper execution loop (execution capability, not a second Sentinel)]],
[[Decisions/2026-08-18 - Sentinel paper execution bound to real TradeW user accounts]],
[[Gotchas/2026-08-18 - Paper orders invisible in Admin_Web is usually no order, not a read bug]],
[[Gotchas/2026-08-20 - A limit and the display of that limit must be one function]].
Full reference: `docs/product-architecture/AUTONOMOUS-PAPER-AGENTS.md`.
