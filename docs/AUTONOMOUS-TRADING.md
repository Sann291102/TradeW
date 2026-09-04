# Autonomous trading — the mandate, the switches, and why nothing is trading yet

**Status:** 🟢 running in `PAPER`. **Decision of record:** [ADR-046](handbook/26-decision-records.md#adr-046--ai-initiated-orders-under-registration-and-inside-a-mandate), which superseded ADR-002 on 2026-09-01.

This document answers two questions that get asked in the same breath:

1. *Are we allowed to auto-trade?* — Yes, inside a mandate. That is ADR-046, and §1 summarises what it permits.
2. *Then why can't I see the bots buying and selling?* — Almost certainly because nothing is armed. §3 is the diagnosis in order of likelihood; §4 is the arming procedure.

---

## 1. What a mandate is

An agent has **no ambient order capability**. It can trade exactly what one `ExecutionProfile` row says it can, and nothing else:

```
   WHAT      symbol · strategyIds (its strategy roster) · long options only
   HOW BIG   lots · capitalAllocationPct · riskPerTradePct · rewardPerTradePct
   HOW OFTEN maxOrdersPerDay · maxOpenPositions
   HOW BAD   maxLossPerDay · squareOffMinute
   HOW GOOD  minConfidence · minCandles · maxBarAgeMinutes
   WHERE     environment — PAPER only today
   FOR WHOM  accountUserId, plus that account's own recorded consent
```

Two agents on two symbols with two strategy rosters are genuinely two different agents, because the same market read reaches different conclusions for each. That is the point of the roster being on the mandate rather than in code.

`ExecutionEnvironment` still has exactly one member, `PAPER`. Nothing in the schema can represent live money, so "arm it live" is not currently a thing anyone can do by flipping a setting — it is unbuilt work, gated behind the registration particulars in ADR-046.

---

## 2. What has to be true before an order exists

Five gates, in order. Every one can only ever **subtract** from what Sentinel already published; none of them can create a side.

| # | Gate | Refuses when | Code |
|---|---|---|---|
| 1 | Data quality | bars are stale or too few | `execution/data-quality.ts` |
| 2 | Agent strategy | no validated setup from this profile's roster | `intelligence/strategy-engine.service.ts` |
| 3 | Index direction | the index's own read disagrees with the option side | `execution/index-direction.ts` |
| 4 | Strategy evidence | the strategy's own declared evidence doesn't support it | `execution/evidence.ts` |
| 5 | **Option positioning** | the option book is positioned against the side | `execution/option-positioning.ts` |

Before those five, Sentinel's own four-condition publication gate has to have published a side at all — and **not publishing is the normal resting state**, not a fault. The commonest verdict by a wide margin is `no-side-in-focus`.

Then risk policy (daily loss, open positions, orders today, square-off window), then a tradable strike, then a live-feed freshness check, and only then an order.

An agent that places two or three trades a day is behaving as designed. An agent that places twenty is a bug.

---

## 3. "I don't see the bots buying and selling" — diagnose in this order

### 3.1 Is the loop's clock even running?

```
   GET /admin/execution/status
```

Look at `enabled`. If it is `false`, `PAPER_EXECUTION_ENABLED` is not `"true"` in the API process's environment and **no timers were ever created**. Nothing else in this list matters until that is fixed. The service says so at boot:

```
   paper execution loop is disabled (PAPER_EXECUTION_ENABLED is not "true") — no timers started.
```

When it is on, the same payload carries `lastEvaluateAt`, `lastManageAt` and `lastManage` (`evaluated / held / trailed / exited / errors`). Those are the "is it cooking" signals — a loop that is alive but doing nothing still stamps them.

Note the three cadences, which are deliberately different: **evaluate** every 30 s (entries), **manage** every 2 s (stops, targets, trails), **reconcile** every 15 s (outcomes).

### 3.2 Is any profile armed?

```
   GET /admin/execution/profiles
```

Arming is **two deliberate acts in two mechanisms**, by design: the process flag *and* the profile's own `enabled` column. The seed script creates the NIFTY and SENSEX agents **disarmed** and deliberately flips neither:

```
   npm run agents:seed -w @tradew/database            # create, disarmed
   npm run agents:seed -w @tradew/database -- --list  # show what exists
```

### 3.3 Does the account consent?

A mandate bound to a real person's account (`USER_PAPER`) additionally requires that person's recorded consent — `User.agentPaperTradingEnabledAt`, granted through `POST /admin/execution/accounts/:userId/agent-trading`, which is audited with the operator who did it. A machine account (`SYSTEM_PAPER`, no password hash, no Google id, nobody can sign in) does not.

```
   GET /admin/execution/profiles/:id/authorization
```

tells you which binding a profile has and what it is still missing.

### 3.4 Is it running and refusing?

This is the interesting case, and the one people mistake for "it's broken". Force a pass and read the verdict:

```
   POST /admin/execution/profiles/:id/run
   GET  /admin/execution/rejections
```

Every refusal is its own verdict with its own meaning, and each carries the confirmations that produced it:

| Verdict | What it actually means |
|---|---|
| `no-side-in-focus` | Sentinel observed and published nothing. **The designed resting state.** |
| `below-threshold` | It published, under this profile's own confidence floor. |
| `stale-data` | Refusing to decide on bars this old. |
| `no-agent-strategy` | A side was published off a strategy this agent does not trade. |
| `index-direction-conflict` | The index reads one way, the option side the other. |
| `evidence-conflict` | The strategy's own declared evidence doesn't support it. |
| `positioning-conflict` | The option book is positioned against the side. |
| `no-option-chain` | No chain was published at evaluation time. |
| `no-tradable-strike` | A chain, but nothing in it passed liquidity and premium checks. |

A long run of `no-side-in-focus` outside a trending session is not a fault. A long run of `stale-data` is — check the market-data bridge.

### 3.5 Is the market open?

The loop evaluates against the market clock. Outside session hours there is nothing to decide, and the square-off minute (15:10 IST by default) closes what is open before the day ends.

---

## 4. Arming, in order

```
   1.  npm run agents:seed -w @tradew/database          create the mandates, disarmed
   2.  review GET /admin/execution/profiles             read what each one may do
   3.  PAPER_EXECUTION_ENABLED=true  → restart the API  the clock
   4.  POST /admin/execution/profiles/:id/enabled       the mandate
   5.  (USER_PAPER only) POST /admin/execution/accounts/:userId/agent-trading
   6.  GET /admin/execution/status                      confirm the timers are live
```

Then watch, in this order: `GET /admin/execution/status` (is it ticking), `/admin/execution/rejections` (what is it refusing and why), `/admin/execution/intents` (what did it decide), `/admin/execution/positions` (what is it holding).

Every armed mandate is revocable in one act — step 4 in reverse — and the process flag stops everything at once.

---

## 5. What the agent records, and how it improves

Every decision writes an `ExecutionIntent` **in the same insert that claims its idempotency key**, so a position can never exist without the plan that governs it. It carries the evidence, all five gates, the option book (levels *and* today's change in open interest), the wallet equity, the risk budget, the planned entry, the stop and the target.

Every completed trade writes an `ExecutionJournal` row and folds into a calibration bucket keyed on `(agent, symbol, strategy, strategyVersion, regime)` — because a setup that works in a trend and fails in a range averages to "mediocre everywhere". A later intent records the calibration version it *read*. Those two columns joined are the evidence that an outcome actually reached a decision, rather than an assertion that it did.

The option book is copied onto both rows on purpose: `previous_oi` is the previous *session's* close and is overwritten every morning, so a decision's change in open interest is either recorded at decision time or gone by the time the daily loop asks for it.

---

## 6. What did **not** change with ADR-046

- **ADR-003 stands.** Sentinel never gates, delays, or adds a confirmation step to a *human's* order flow. Sentinel can be entirely down and the platform stays fully functional.
- **ADR-004 stands.** No surface tells a person what to do. No Buy/Sell/Entry/Target language in an agent, a prompt, a card, a notification, an email or an export — enforced by `vocabulary.ts` on output, not merely requested in a prompt.
- **`services/tradew-ai` has no order path at all.** A conversational runtime with an order tool is a different and much worse thing than a mandated execution loop, and nothing in ADR-046 authorises it.

An agent acting inside its own mandate is not advice given to anyone. That distinction is the whole architecture.
