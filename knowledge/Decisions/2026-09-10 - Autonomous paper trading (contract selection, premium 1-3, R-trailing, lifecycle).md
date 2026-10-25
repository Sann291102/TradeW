---
type: decision
date: 2026-09-10
tags: [decision, autonomous-engine, paper-execution, options, trailing, risk, learning]
---

# Autonomous paper trading: contract selection, premium 1:3, R-trailing, full lifecycle

**Read before touching `services/api/src/autonomous/*`, the `AutonomousTrade`
table, or `strategy-core`'s `trailing.ts` / `option-premium.ts`.**

The brain now trades paper money on NIFTY, BANKNIFTY, SENSEX and GOLD, end to
end, with no Sentinel involvement.

## The one thing that could not be reused

`paper-execution.service.ts` gets its option contract from **Sentinel**
(`evaluation.strikes.selected`, `evaluation.expiry`). Reusing that path would
have been convenient and would have reintroduced, at the last possible moment,
the exact dependency three phases removed — the brain would decide
independently and then ask Sentinel what to buy.

So `ContractSelectorService` selects from the **bridge's own option chain**
(`/optionchain/expirylist` then `/optionchain`), which is a data source rather
than a second opinion. Everything else was genuinely reused: `OrderService.
placeOrder`, `PaperWallet`, `evaluatePolicy` (plain data in, no Sentinel),
`assessFreshness`, `modelPaperFill`, `computeDailyDrawdown`/`computeExposure`,
`contractSymbol`, `MarketPriceService.resolveInstrument`.

## Premium 1:3 is the gate that actually bites

A 3R index setup is **not** a 3R option trade, and this is not a rounding
difference. Measured live on 2026-09-10:

- NIFTY 3R structural plan → contract pays **2.7:1** → REFUSED
- SENSEX 3R structural plan → contract pays **2.56:1** → REFUSED
- A wider-stop NIFTY plan → **3.04:1** → accepted and traded

The killer is theta against a tight structural stop: on SENSEX, 46.62 of
one-day decay against 68.46 of premium risk. **Tight structural stops and long
options are close to incompatible**, and the gate says so instead of trading it.

### The projection had a real bug, caught by a test

The first model was the textbook expansion `δ·ΔP + ½γ·ΔP²`. It is only valid
near the expansion point, and it fails in the direction that flatters the
trade: with real chain greeks (δ 0.52, γ 0.0004) a **5,000-point fall projected
the premium UP from 154 to 2,541** — a catastrophic move reported as a windfall.
Sizing risk off that is worse than having no model.

Replaced with an integral of a **clamped** delta (`δ' = clamp(δ + γ·ΔP, 0, 1)`
for calls, averaged over the move), which is monotonic by construction and
therefore cannot turn an adverse move into a profit. Pinned by a monotonicity
regression in both directions.

## The option position is LONG in premium space

**Caught by the live lifecycle proof, not by a unit test.** A bearish index read
is expressed by BUYING a put, so the position is long the premium: stop below
entry, target above. The first version stored the INDEX direction on the trade
row, the position manager read `direction: 'short'`, concluded the stop was
above the entry, and **exited the position on the very tick it opened**.

`AutonomousTrade.direction` now holds the TRADABLE direction (always `long` for
an option, the index direction for a future). The index view is not lost —
`optionType` carries it (CE bullish, PE bearish). Two regressions pin it.

## Sizing is NOT `planRisk`

`planRisk` risks the WHOLE premium, which is correct for a long option held
without a stop. The autonomous brain always has one, so its risk per lot is
`(entry − stop) × lotSize`. Sizing off the full premium when a stop exists
systematically under-sizes — a trade risking 30 of a 150 premium would take a
fifth of the intended position and make every realised R a fifth of the plan.
Two correct models for two different paths; `sizeFromRisk` is the second, and
it **refuses rather than tightening a stop to fit a budget**.

## Trailing lives in `strategy-core`

R-based, one pure function, configured in one object
(`initialRRMin` 3, `activationR` 1, `lockR` 0.5, `stepR` 1). Verified on the
brief's own example: 89→84, 99→94, 109→104, 119→114. Two invariants are
enforced *inside* the function so no caller has to remember them: a stop never
moves backwards, and steps are counted from the **high-water mark** rather than
the live price — trailing off the current price would let a stop that had
ratcheted to +2.5R relax on a pullback.

It is in the package, not the service, because a backtest that trailed
differently from the live engine would measure a strategy nobody runs.

## Idempotency is a constraint, not a check

`AutonomousTrade.candidateId` is UNIQUE, and the row is **claimed before the
order is placed**. A check-then-place races: two ticks can both read "no trade
yet". The ordering matters too — an unclaimed order is a position nobody
manages, while a claimed row with no order is a visible, repairable
inconsistency.

## No chasing

If price has run more than `MAX_ENTRY_DRIFT_R` (0.25R) in the trade's favour
before the order goes in, the remaining reward:risk is no longer the one the
gate approved. The candidate expires; nothing is re-planned. Movement AGAINST
the trade is not chasing — that entry is better than planned.

## `lastManagedAt` is stamped on every pass

Including one that changed nothing. Writing only on a change made "managed,
nothing to do" and "not managed at all" identical in the table — the same
blindness that hid a frozen scheduler for three hours in September. One small
write a minute per open position buys the ability to tell a live manager from a
dead one.

## SENSEX

Added to `TRADABLE_SPECS` only after verifying against the running bridge:
securityId 51 on `IDX_I`, a live `/quotes` row, and options that stream on
**BSE_FNO** rather than NSE_FNO — a distinction the bridge already handles and
which had previously dropped every SENSEX option tick. `lotSize: null`
(resolved per contract) because BSE has changed it more than once.

## Known limitations, stated rather than hidden

- **GOLD cannot be sized by this account.** One MCX lot is 100 g ≈ ₹15.4M
  notional; a 1.5% risk budget on a ₹0.89M wallet cannot buy one. GOLDM (10 g)
  is the right instrument and has **no bridge feed**, so it stays
  `tradeable: false`. GOLD will refuse on sizing until either is addressed.
- **Vega is not modelled.** A chain snapshot predicts no IV move, so the premium
  floor is applied strictly rather than generously.
- The first executed trade in the dataset (`lifecycle-proof`, exited STOP at
  +0.01R) is an artifact of the direction bug above. It is left in place rather
  than deleted — editing trade records to improve a report is the opposite of
  what this dataset is for — but it should be excluded from any evidence claim.

Related: [[Decisions/2026-09-09 - The autonomous brain is a parallel learner, not a backup execution path]],
[[Decisions/2026-09-08 - Autonomous decision core extracted to strategy-core (Sentinel no longer authorises trades)]],
[[Patterns/2026-09-09 - Autonomous scanner and the market-data port]].
