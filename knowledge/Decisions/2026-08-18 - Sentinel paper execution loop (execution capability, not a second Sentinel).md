---
type: decision
date: 2026-08-18
tags: [decision, sentinel, execution, oms, paper-trading, admin]
---

# Sentinel paper execution loop

Sentinel can now place **paper** orders in its own system-owned account, so its
reasoning can be scored against filled trades instead of only against charts.

## What was built, and where it lives

| Concern | Location | New? |
|---|---|---|
| Three-strike evaluation | `services/sentinel/src/execution/strike-candidates.ts` | new |
| Execution-facing read of an observation | `services/sentinel/src/execution/execution-evaluation.service.ts` → `POST /execution/evaluate` | new |
| Execution profile / intent / candidates / outcome | `packages/database/prisma/schema.prisma` | new models |
| Decide → validate → submit | `services/api/src/paper-execution/` | new |
| Order, margin, fill, position, P&L | `services/api/src/sim/*` | **unchanged** |
| Operator surface | `apps/admin` Orders & OMS + `AdminController` | extended |

## The decisions worth keeping

**One Sentinel.** `ExecutionEvaluationService` *calls* `SentinelOrchestratorService.observe`
— the same call `apps/web` drives. It adds strike selection and nothing else.
No second orchestrator, strategy engine, market-data engine or matching engine
was created. `services/trading-engine` is still an unpopulated stub; the real
paper OMS is and remains `services/api/src/sim`.

**The dependency arrow runs `PaperExecutionModule → SimModule`, never back.**
That is the structural claim behind "Sentinel is never a gate in the order flow"
(Rule 2). The OMS gained no awareness of Sentinel; deleting the execution module
from `AppModule` removes agent execution and changes nothing a trader sees.

**Why this does not violate Rule 2.** Rule 2 governs the *user's* order flow.
`services/sentinel` still cannot write an order — no Prisma binding to
Order/Trade/Position, no OMS client. Every order the loop places belongs to a
dedicated `User` row that has no password hash and cannot log in. Nothing in a
trader's order path reads the loop.

**Strike selection is off the `/observe` contract, deliberately.**
`intelligence/contract-alignment.ts` records that ranking contracts by
attractiveness is a recommendation however it is phrased. Selecting one strike
out of three *is* that ranking — so it lives on a service-token-only route whose
output is rendered solely in the admin console, and `ObserveResponse` is
unchanged. Two additive fields were added to observe: `runId` (already generated,
simply never returned) and an opt-in `optionChain` behind `includeOptionChain`.

**Live money is unrepresentable, not merely disabled.** `ExecutionEnvironment`
has exactly one member, `PAPER`. There is no enum value to route to, so no env
var or compromised admin session can move the loop onto real capital. Adding
`LIVE` would be a migration plus a review — the right size of decision for that
step. `evaluatePolicy` still refuses a non-PAPER value, which only a row written
outside this application could carry.

**The idempotency key excludes the Sentinel run id.** This is the
counter-intuitive part and the one most likely to be "fixed" wrongly later.
`runAgentRun` mints a fresh uuid per call, so keying on the run would produce a
new key every tick and open a position per poll — the precise failure
idempotency exists to prevent. The key is the *decision's content*: profile +
contract + side + a 15-minute IST wall-clock bucket. The run id is still stored
on the intent as the provenance link. Three independent guards:
`ExecutionIntent.idempotencyKey @unique`, `Order.executionIntentId @unique`, and
`maxOpenPositions`.

**Rejected candidates are persisted.** "Why this strike" is only answerable if
the two that lost, and the check each failed, survive. An unpriced leg and a leg
priced at zero are recorded as different facts.

## Verified at runtime, not just compiled

`npm run verify:paper-execution -w @tradew/api` — 41 checks, all production
classes, real Postgres, real live-feed bridge. On 2026-08-18 it resolved
`NIFTY:20260818:24300:CE` (lot 65) through the broker scrip master, filled at
77.2 via the real `OrderService`, produced a real position and wallet debit
(₹10,00,000 → ₹9,94,980.49), squared off, and recorded a `LOSS -26` outcome.
Five concurrent passes produced one order.

The script substitutes exactly two things and prints which: the Sentinel
*decision* when the live gate publishes no side (it did not — the market was
shut), and the single fact "is the exchange open" so the path downstream of the
session gate can run outside market hours. Everything else is real.

## Known gap found while doing this (pre-existing, not introduced)

**`AgentRun` / `AgentActivity` / `AiCallLog` are empty platform-wide.** Only
`services/api` calls `setTelemetrySink`; `services/sentinel` runs in its own
process and installs none, so `runAgentRun` there emits into the void. Sentinel
observations produce a real `runId` but no row. Consequence for this feature:
the execution trace's Sentinel stage reports the run id (durable, stored on the
intent) but cannot enrich it with agents/duration. The admin Agents page is
affected the same way. See [[Gotchas/2026-08-18 - Sentinel telemetry sink is never installed]].

Related: [[Decisions/2026-08-12 - Cognition network (perceptors + four layers)]],
[[Decisions/2026-08-15 - Sentinel-py personal strategy watcher (additive Python runtime)]].
