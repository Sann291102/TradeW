# Autonomous Paper Agents

**Status:** implemented 2026-08-30 · **Environment: PAPER ONLY**

Two autonomous agents — one on NIFTY, one on SENSEX — that read live market
data, decide, place **in-app paper orders**, manage those positions to an exit,
record a journal, and feed one bounded calibration value back into the next
decision.

> ## The boundary, first
>
> These agents place **paper orders only**. `ExecutionEnvironment` has exactly
> one member, `PAPER`, so live money is unrepresentable in the schema; there is
> no broker order path anywhere in `services/api`, `services/sentinel` or
> `packages/*`; and `OrderService` — the one thing that creates an order — has
> no HTTP client and no broker SDK. Broker credentials exist, and the only code
> that reads them (`services/market-data/scripts/live-feed-server.ts`) calls
> `/charts/*` and `/optionchain` and nothing else.
>
> The agents consume **live market data**. They do not send orders anywhere.

---

## 0. One market read, three consumers

The agents do not have a market engine of their own, and neither does the
assistant. Everything below is computed from **one** `MarketSnapshot`, composed
by `MarketIntelligenceService.snapshot(symbol, interval)`:

```
MarketIntelligenceService.snapshot()        ← the canonical MarketSnapshot
  ├─ SentinelOrchestrator        → /observe             premium verdict, the workspace
  ├─ ExecutionEvaluationService  → /execution/evaluate  THESE agents
  └─ MarketObservationService    → /market-observation  Tara, measurements only
```

Added 2026-08-31: the third branch. Tara answers "analyse NIFTY on 15m" from a
projection of the same snapshot — the same EMA, the same VWAP, the same swing
structure, the same option-chain aggregates — so **the assistant and the agents
can never describe two different markets**. There is no second indicator
implementation on the assistant path and there must not be one.

What the third branch deliberately cannot see: `sideInFocus`, the publication
gate, `strategyAdvice`, `confidence`, the strike evaluation, `EvidenceRead`.
Those are how an agent DECIDES, and they are gated. Tara gets what was
measured; the agents get what was measured plus everything needed to act on it.
The split is the difference between an analyst surface and an execution
surface, and it is enforced by type shape rather than by convention
(`services/sentinel/src/intelligence/market-observation.ts`).

## 1. The pipeline

```
LIVE MARKET (Dhan)
  │
  ├─ live-feed-server.ts ── WebSocket tick map + REST charts/chain
  │
  ▼
FAST OBSERVATION ─────────────────────────────────────── 3 loops, 3 cadences
  │   evaluate 30s  · manage 2s · reconcile 15s
  ▼
DATA-QUALITY GATE          services/sentinel/src/execution/data-quality.ts
  │   candle count · newest-bar age · spot present
  ▼
SENTINEL MARKET CONTEXT    SentinelOrchestratorService.observeInternal
  │   one market read → snapshot + detections + the ObserveResponse
  ▼
STRATEGY AGENTS            4 agent-tradable strategies (strategy-engine.service.ts)
  │   validated detection, on THIS profile's roster, agreeing with the side
  ▼
IMPORTANT EVIDENCE ONLY    services/sentinel/src/execution/evidence.ts
  │   exactly the keys the strategy declares — nothing else is read
  ▼
INDEX DIRECTION            services/sentinel/src/execution/index-direction.ts
  │   index-only vote; must agree with the option side or nothing trades
  ▼
CONFIDENCE ≥ 70            publication gate → sideInFocus → profile floor
  ▼                        → calibrated floor, clamped at 70
OPTION CONTRACT            strike-candidates.ts — ITM/ATM/OTM, one selected
  ▼
FRESHNESS + RISK + POLICY  execution-freshness.ts · execution-risk.ts · execution-policy.ts
  ▼
PAPER ENTRY                OrderService.placeOrder ← the existing paper OMS
  ▼
MANAGED POSITION           ExecutionPosition (stop, target, trail, high-water)
  │
  ├─ every 2s ─▶ PositionManagerService.manageAll
  │                └─ decidePosition() — ONE decision, this precedence:
  │                     1 EMERGENCY  2 STOP  3 TARGET
  │                     4 TRAIL      5 INVALIDATION  6 SQUARE-OFF
  ▼
PAPER EXIT                 OrderService.exitPosition (an ordinary MARKET order)
  ▼
REALIZED P&L               computed by the OMS, never recomputed
  ▼
TRADE JOURNAL              ExecutionJournal — one row per completed trade
  ▼
CALIBRATION                StrategyCalibration — one bounded value, versioned
  ▼
NEXT DECISION              reads that version, and records which it read
```

---

## 2. The two agents

Seeded **disarmed** by `npm run agents:seed -w @tradew/database`.

| | NIFTY agent | SENSEX agent |
|---|---|---|
| Profile | `sentinel-alpha-nifty` | `sentinel-beta-sensex` |
| Agent id | `sentinel-alpha` | `sentinel-beta` |
| Strategies | `agent-smc-structure-shift`, `agent-trend-momentum` | `agent-opening-range-expansion`, `agent-exhaustion-reversal` |
| Account | dedicated machine account (`SYSTEM_PAPER`) | dedicated machine account |
| Capital / risk / reward | 20% / 3% / 9% of equity | 20% / 3% / 9% of equity |
| Trail step | 3 premium points | 3 premium points |
| Square-off | 15:10 IST | 15:10 IST |

They are not one agent run twice. The roster is a **hard filter**: a detection
from a strategy not on a profile's list can never become that agent's trade, so
the same market read reaches different conclusions for each. The split is a
starting configuration, recorded so it is visible and changeable — the
per-(agent, symbol, strategy, regime) calibration is what will eventually say
whether it was right.

They share nothing: separate accounts, separate wallets, separate idempotency
keys (the profile id is part of the key), separate risk counters, separate
calibration buckets. Asserted in `paper-lifecycle.spec.ts`.

---

## 3. The four strategies

All four are **direction-agnostic** — both CE and PE are reachable. The eight
pre-existing observation strategies are deliberately NOT agent-tradable: several
are built on bullish-only predicates (`price_above_vwap`, `ema_fast_above_slow`)
and none declares what would invalidate a *position* as opposed to a *setup*.

| Strategy | Thesis | Rules | Exit rules | Regimes | Knowledge |
|---|---|---|---|---|---|
| `agent-smc-structure-shift` v1.0.0 | A confirmed swing-structure break that displaced with participation and returned into its order block | `structure_break_confirmed`, `displacement_bar`, `order_block_mitigated`, `volume_supports_move` | `structure_reversed`, `structure_shift_invalidated` | trending, breaking-out | `swing-point`, `trend`, `institutional-order-flow`, `liquidity`, `volume-confirmation`, `block-trade` |
| `agent-trend-momentum` v1.0.0 | Join an accelerating trend after a quiet pullback, on the side EMA and VWAP agree on | `ema_stack_aligned`, `trend_momentum_confirmed`, `price_beyond_vwap`, `pullback_volume_lower` | `momentum_faded`, `vwap_reclaimed_against`, `structure_reversed` | trending | `trend`, `moving-average`, `vwap`, `volume-confirmation`, `market-breadth` |
| `agent-opening-range-expansion` v1.0.0 | A decisive opening-range break that is expanding the session range on real volume | `orb_breakout`, `session_range_expanding`, `volume_supports_move`, `price_beyond_vwap` | `orb_reentry`, `momentum_faded` | breaking-out, trending | `range-expansion`, `breakout`, `volume-confirmation`, `vwap`, `trend-day` |
| `agent-exhaustion-reversal` v1.0.0 | Fade a stretched move that ran a 20-bar liquidity pool and was rejected | `liquidity_pool_swept`, `momentum_stretched`, `rejection_bar`, `sweep_volume_spike` | `sweep_not_reclaimed`, `range_broken`, `structure_reversed` | ranging, consolidating | `liquidity-sweep`, `stop-loss-clustering`, `relative-strength-index`, `false-breakout`, `max-pain` |

### Knowledge provenance

```
knowledge-base/<domain>/<concept>.yaml
  → StrategyDefinition.knowledgeConcepts
    → StrategyDefinition.evidenceKeys → EVIDENCE_READERS[key].concept
      → ExecutionIntent.evidence
        → the decision
```

`services/sentinel/src/execution/strategy-knowledge.spec.ts` asserts every link
against the knowledge base **on disk**: a renamed concept fails a test rather
than silently leaving a strategy citing nothing.

The knowledge is connected as **explicit deterministic rules**, not as prompt
text. No LLM is on the decision path.

---

## 4. Capital and risk: three percentages, three bases

`services/api/src/paper-execution/execution-risk.ts`

| Setting | Default | **Percentage of WHAT** |
|---|---|---|
| `capitalAllocationPct` | 20% | the paper account's **EQUITY** (cash + margin blocked). The most premium ONE position may cost. |
| `riskPerTradePct` | 3% | the paper account's **EQUITY**. The most this trade may LOSE before its stop fires. |
| `rewardPerTradePct` | 9% | the paper account's **EQUITY**. 9 against 3 is a clean 3R. |
| `trailStepPoints` | 3 | **PREMIUM POINTS of the traded option** — not index points. |

**Why risk is of the account, not of the trade.**
`knowledge-base/risk-management/position-sizing.yaml` defines sizing as *"the
loss incurred if a position fails represents a predetermined fraction of
capital."* The alternative reading — 3% of the premium paid — is incoherent for
options: a 3%-of-premium stop on a ₹120 contract is 3.6 points, which is
intraday noise, so every position would be stopped within seconds and the "risk
model" would be a random exit generator.

### The sizing order (and why it is this order)

There is a real circularity: quantity depends on the stop distance, and the stop
distance depends on quantity. Resolved in one direction:

1. Assume a **floor** stop distance = 10% of premium (`MIN_STOP_FRACTION`) — the
   tightest stop that is a stop rather than noise.
2. Cap quantity by what that floor permits inside the risk budget, by the
   allocation ceiling, and by the profile's own `lots`. The tightest binds.
3. **Then** widen the stop to spend the remaining budget, capped at 35% of
   premium (`MAX_STOP_FRACTION`) so a stop is never "wait for expiry".

Step 3 only ever *reduces* the distance below `riskBudget / quantity`, so
**realised risk can never exceed the budget**. Asserted over a swept input
space in `execution-risk.spec.ts` (>600 planned positions), not argued for.

Worked example — ₹10L equity, ₹120 premium, lot 75, `lots: 20`:

```
allocationCeiling  ₹2,00,000   (20% of equity)
riskBudget         ₹30,000     (3%)
rewardTarget       ₹90,000     (9%)
lotsByRisk         33          at the 12-point floor stop
lotsByAllocation   22          ₹9,000/lot
lots               20          ← the profile binds
quantity           1,500       allocated ₹1,80,000  (≤ ceiling ✓)
stopDistance       20.00 pts   = 30,000 / 1,500, inside the 42-point cap
riskAtStop         ₹30,000     (= budget ✓)
targetDistance     60.00 pts   = 3 × stop
stop 100.00 · target 180.00
```

**Known limitation, stated plainly:** the stop is a fraction of the *premium*,
not a structural index level translated through delta.
`knowledge-base/risk-management/stop-loss-placement.yaml` describes structural
placement as better practice and it is right — but converting an index level to
a premium level needs a delta, and the option chain this platform reads carries
OI, volume and IV but **not Greeks**. Deriving one from IV would mean pricing
the option ourselves and presenting the output as market data.

---

## 5. Trailing

`computeTrail` in `execution-risk.ts`. Every `trailStepPoints` of favourable
movement **from entry** advances protection one step:

```
entry 120, step 3
  high 122  → 0 steps → no trail
  high 123  → 1 step  → trail 120  (breakeven)
  high 126  → 2 steps → trail 123
  high 129  → 3 steps → trail 126
```

Computed from the **high-water mark**, never the current price, so a retrace can
never loosen protection. Quantised to whole steps so each write is a real event
— a continuous trail would rewrite the level every tick and append hundreds of
meaningless rows. Every ratchet is an `ExecutionTrailAdjustment` row with its
`from`, `to`, trigger price and reason.

The effective stop is `max(initialStop, trail)`. The initial stop is **never
rewritten**, so the journal can state what was risked at entry.

---

## 6. Exit precedence

`services/api/src/paper-execution/position-decision.ts` — one pure function,
one action per observation. Five services fighting over one position is how a
paper book gets two exits for one entry.

| # | Reason | Fires when |
|---|---|---|
| 1 | `EMERGENCY` | no premium readable · feed not ticking · past 15:30 IST · venue reports closed |
| 2 | `STOP` | premium ≤ initial stop |
| 3 | `TARGET` | premium ≥ target |
| 4 | `TRAIL` | premium ≤ trailing level (and the trail is above the initial stop) |
| 5 | `INVALIDATED` | the strategy's own `exitRules` fired |
| 6 | `SQUARE_OFF` | IST minute ≥ the profile's `squareOffMinute` |

**Stop above target** because a bar spanning both more likely traded the near
side first, and being wrong about a stop costs money while being wrong about a
target costs profit. **Emergency first** because every rule below it needs a
price that the emergency case says we do not have — holding through an
unmanageable state is a decision to carry unbounded risk for an unknown time.

---

## 7. Disarm

**Disarming stops NEW entries. It does not abandon an open position.**

This was a real defect before 2026-08-30: `squareOff` filtered on
`enabled: true`, so disarming an agent holding a position stranded that position
with no stop, no target and no square-off until a human noticed. The most
dangerous button in the console was the one labelled safe.

Now:
- `PositionManagerService.manageAll` selects on **position state only**.
- `ExecutionLifecycleService.squareOff` no longer filters on `enabled`.
- `decidePosition` takes **no `enabled` flag at all** — it cannot express the bug.
- The console shows `disarmed — still managed to exit` on such a position.

Asserted in `paper-lifecycle.spec.ts` (scenarios 19 + 20).

---

## 8. Observation cadence

| Loop | Interval | Reads | Why that number |
|---|---|---|---|
| Evaluate | 30 s | candles, option chain, strategy engine, Sentinel | The bridge caches `/candles` upstream for 60 s and the engine reads 15-minute bars. Faster spends quota to re-derive an unchanged read. |
| **Manage** | **2 s** | one option premium + feed liveness | `/quotes` is served from the bridge's in-memory tick map — no upstream call, no rate limit. `/optionchain` caches for exactly 2 s and **overlays live WebSocket prices** onto the cached body. So a 2 s poll is a free cache hit with live prices, or one refresh — against Dhan's ~3 s per-underlying chain limit. **This is the fastest cadence the existing feed genuinely supports.** |
| Reconcile | 15 s | local rows | Notices a fill and finalises a closed position's record. |

Thesis state (whether a strategy's exit rules have fired) is computed on the
**evaluate** tick and cached in memory for the fast loop — so the 2 s loop never
calls Sentinel. Cache TTL is 3× the evaluate interval; past that the manager
simply stops considering thesis exits, which is the safe direction.

All three are leader-elected and guarded against overlapping passes.

---

## 9. Entry gate

Every one of these must hold. Each produces a machine-readable id visible in the
execution trace and the rejection breakdown.

**Sentinel side** (`services/sentinel`)
`stale-data` · `no-side-in-focus` · `below-threshold` · `no-agent-strategy` ·
`index-direction-conflict` · `evidence-conflict` · `no-option-chain` ·
`no-tradable-strike`

**API side** (`execution-policy.ts`)
`profile-enabled` · `environment-paper` · `quote-freshness` · `market-open` ·
`before-square-off` · `index-direction` · `confidence-floor` ·
`max-open-positions` · `max-orders-per-day` · `daily-loss-limit` ·
`risk-plan` / `allocation-ceiling` / `risk-budget` · `affordable`

**Account side** (`execution-account.ts`)
`environment-paper` · `account-exists` · `scope-matches-account` · `consent` ·
`market-allowed` · `agent-allowed`

`index-direction` and `environment-paper` are checked on **both** sides of the
network hop, deliberately: this side must not take a remote service's word for
the two properties that decide direction and environment.

### Protections that exist

stale bars · stale quotes · unmeasurable quote age (fails) · insufficient candle
history · missing spot · missing chain · no tradable strike · conflicting
evidence · index/side disagreement · market closed · past square-off · duplicate
position (3 independent mechanisms) · daily loss limit · daily order limit ·
open-position limit · missing stop (unrepresentable — the plan is written before
the order) · missing target (same) · invalid contract · invalid quantity ·
account not armed · consent revoked · unpermitted market · unpermitted agent

### Not modelled — stated plainly

- **Option-level quote age.** `/optionchain` carries no timestamp anywhere. The
  index tick's age is used as a **proxy** for feed liveness, and is recorded as
  such in the fill model and the journal. A feed that is alive but has not
  printed *this strike* in ten minutes would pass.
- **Greeks.** Not published by the chain, so no delta-derived stop.
- **Depth / market impact.** Not published, so not modelled.
- **Partial fills.** The paper OMS has none.

---

## 10. Paper fill model

`execution-fill.ts`. Records how the price was arrived at, and detects the
**synthetic** bid/ask that `MarketPriceService` substitutes (`ltp × 0.9995 /
1.0005`) when a Dhan quote-mode tick carries no depth. A P&L measured against
that invented 10bp spread is systematically optimistic against a real option
book; a journal that cannot tell the two apart reads as more accurate than it
is. Every model states its own assumptions, including that slippage is a
**floor** when the spread was synthetic.

---

## 11. Trade journal

`ExecutionJournal`, one row per completed trade, written at the close. A
denormalised snapshot rather than a view: a view over six living tables answers
a different question every time it runs.

Records: agent · market · strategy + version · regime · entry/exit times and
prices · underlying, expiry, strike, option type, contract symbol, securityId ·
quantity and lots · index direction and strength · confidence · the strategy's
**declared evidence** · confirmations · data quality · rationale · publication
gate · option context · policy checks · wallet equity · allocated capital · risk
budget · reward target · initial stop and target · the full risk plan · the fill
model · complete trailing history · exit reason and detail · invalidation reason
· holding seconds · realized P&L · charges · **R multiple** · result · and the
calibration bucket and version this outcome produced.

`realizedPnl` is **copied** from `ExecutionOutcome`, which copied it from the
`Trade` rows the OMS booked. Three copies of one number, none computed twice.

---

## 12. Learning — bounded, and checkable

`execution-calibration.ts` + `execution-calibration.service.ts`

A completed trade may move **exactly one number**: `confidenceAdjustment`, in
whole confidence points, on a `StrategyCalibration` row keyed by
`(agent, symbol, strategyId, strategyVersion, regime)`.

**It moves a BAR, not a MEASUREMENT.** Scaling confidence would forge the
evidence — a recorded 80% that no observation produced, inherited by every
downstream record. Moving the entry *floor* leaves the measurement alone and
changes only how much of it this bucket has earned the right to act on.

- Derived from **average R**, not win rate. A bucket that wins 70% and loses 3×
  what it makes is a losing bucket; win rate alone would promote it.
- Requires **8 completed trades** before it moves anything (the same floor
  `StrategyIntelligenceService.MIN_SAMPLE` and the live-performance gate use).
- Bounded `[-5, +15]`, asymmetric: harder is cheap, easier is bounded.
- `applyCalibration(profileFloor, adjustment)` clamps at
  `PLATFORM_CONFIDENCE_FLOOR = 70` **unconditionally**. No value in the table —
  including one written by a restore or a manual edit — can produce an effective
  floor below 70. Swept in `execution-calibration.spec.ts` across adjustments
  from −500 to +500.

**Learning cannot reach** the 70% floor, a stop, a target, a trail, a risk
budget, an arming state, a data-freshness allowance, or any source code. Those
are recomputed from the profile and the module constants on every pass.

### The loop is a join, not a claim

```
trade #1 closes → ExecutionJournal.calibrationVersion = the version it PRODUCED
trade #2 decides → ExecutionIntent.calibrationVersion = the version it CONSUMED
```

If the second ≥ the first, that outcome reached that decision. Asserted in
`paper-lifecycle.spec.ts` scenario 24+25, which observes the bucket advance
v1→v10 and the floor adjustment engage at the 8-trade mark.

---

## 13. Admin arming — three switches, three mechanisms

| Switch | Where | Who | Effect |
|---|---|---|---|
| `PAPER_EXECUTION_ENABLED=true` | API process env | whoever deploys | timers exist at all |
| `ExecutionProfile.enabled` | database | admin/operator, audited | this agent takes NEW entries |
| `User.agentPaperTradingEnabledAt` | database | admin/operator, audited | a `USER_PAPER` binding may trade a real person's account |

All three are **server-enforced**. `AdminAccessGuard` requires `ADMIN_API_TOKEN`
plus one identity factor (product-admin JWT + `User.isAdmin`, or a signed
operator assertion). The console's proxy is deny-by-default. The frontend is not
authoritative anywhere.

`ExecutionProfileService.upsert` re-runs the account gate at **write** time, and
`runProfile` re-runs it on **every pass** — consent is revocable, and a cached
grant is a grant that survives its revocation.

---

## 14. Observability

| Endpoint | Shows |
|---|---|
| `GET /admin/execution/positions` | every open position: live price, stop, target, **effective stop**, trail steps, high-water, unrealised P&L, and whether its profile is disarmed-but-managed |
| `GET /admin/execution/agents` | each agent's **last decision**, including the passes that correctly did nothing, with every gate |
| `GET /admin/execution/journal` | completed trades in full |
| `GET /admin/execution/calibration` | every bucket, its sample, its adjustment, and whether it has reached the sample floor |
| `GET /admin/execution/status` | is the loop ticking (process state, not a database count) |
| `GET /admin/execution/rejections` | today's refusals grouped by the gate that produced them |
| `GET /admin/execution/trace/:intentId` | full provenance of one decision |

All read-only. None can change what it is watching.

---

## 15. Files

**Sentinel** — `services/sentinel/src/`
`execution/data-quality.ts` · `execution/index-direction.ts` ·
`execution/evidence.ts` · `execution/execution-evaluation.service.ts` ·
`execution/strike-candidates.ts` · `intelligence/strategy-engine.service.ts` ·
`intelligence/strategy-rules.ts` · `orchestrator/sentinel-orchestrator.service.ts`

**API** — `services/api/src/paper-execution/`
`execution-risk.ts` · `execution-fill.ts` · `execution-freshness.ts` ·
`execution-calibration.ts` · `position-decision.ts` ·
`position-manager.service.ts` · `execution-calibration.service.ts` ·
`execution-journal.service.ts` · `paper-execution.service.ts` ·
`execution-lifecycle.service.ts` · `execution-scheduler.service.ts` ·
`execution-policy.ts` · `execution-account.ts` · `execution-profile.service.ts`

**Schema** — `packages/database/prisma/schema.prisma`,
migration `20260830000000_autonomous_paper_agents`

**Seed** — `packages/database/scripts/seed-autonomous-agents.ts`

**Console** — `apps/admin/src/app/(console)/orders/page.tsx`

---

## 16. Running it

```bash
# 1. Migrate
npm run db:migrate -w @tradew/database

# 2. Create both agents, DISARMED
npm run agents:seed -w @tradew/database

# 3. Turn the process switch on (API environment)
PAPER_EXECUTION_ENABLED=true

# 4. Arm each agent in the admin console (audited)
POST /admin/execution/profiles/:id/enabled  { "enabled": true }

# 5. Watch
GET /admin/execution/agents
GET /admin/execution/positions
```

The market-data bridge (`live-feed-server.ts`) must be running with a valid Dhan
credential, or every pass is refused by the data-quality and freshness gates —
correctly, and visibly.
