---
id: iron-condor
name: Iron Condor
category: volatility
tier: advanced
concept: implied-volatility
summary: A short strangle with protective wings bought outside both strikes. Four legs, one expiry — premium is kept between the short strikes and loss is capped at the wing width.
legs:
  - action: BUY
    kind: PE
    strike: ATM-4
    ratio: 1
    expiry: near
  - action: SELL
    kind: PE
    strike: ATM-2
    ratio: 1
    expiry: near
  - action: SELL
    kind: CE
    strike: ATM+2
    ratio: 1
    expiry: near
  - action: BUY
    kind: CE
    strike: ATM+4
    ratio: 1
    expiry: near
net: credit
outlook: direction-neutral, expecting little movement
maxProfit: Net credit received, anywhere between the short strikes
maxLoss: Wing width minus net credit
breakeven: Short put strike minus credit, and short call strike plus credit
greeks:
  delta: neutral
  gamma: negative
  theta: positive
  vega: negative
chartNote: >
  The inner two lines are where the premium is kept and the outer two are where
  the loss stops growing — the position wants price to finish between the inner
  pair.
---

# Iron Condor

Four legs, one expiry: a bull put spread below the market and a bear call
spread above it. Equivalently, a short strangle with protective wings.

## The structure

- A long put, far out of the money
- A short put, nearer the money
- A short call, nearer the money
- A long call, far out of the money

Net credit. The two bought wings cost less than the two sold inner legs bring
in, since they are further from the money.

The two wings are insurance, not profit centres. They exist to bound the loss
and to collapse the margin requirement.

## What it is exposed to

**Theta** positive, from the two short legs, partially given back to the two
long legs. Net theta is lower than a comparable short strangle's.

**Gamma** negative near the short strikes, but bounded — as the underlying
moves past a short strike toward the corresponding wing, the long leg's
positive gamma progressively offsets the short leg's negative gamma. Beyond
the wing, the position's delta is flat. This is the structural difference from
a strangle, where delta deterioration never stops.

**Vega** negative but bounded, for the same reason.

## Payoff

- Between the short strikes: both spreads expire worthless, full credit retained.
- Between a short strike and its wing: that spread is partially in the money, loss accrues.
- Beyond a wing: loss fixed at wing width minus net credit.

Maximum profit is the net credit, realised across the whole range between the
short strikes. Maximum loss is the width of one wing minus the credit — only
one side can lose, since the underlying cannot finish both above the call
strike and below the put strike.

That last point is frequently miscounted. Margin and risk are computed on one
side, not both.

## The trade-off against a short strangle

The comparison is the real content of this lesson.

| | Short strangle | Iron condor |
|---|---|---|
| Credit | Higher | Lower |
| Maximum loss | Unbounded | Wing width minus credit |
| Margin | Large | Substantially smaller |
| Return on margin | Can be higher in quiet periods | More stable |
| Behaviour in a tail move | Loss unbounded | Loss stops at the wing |

The condor collects less and cannot be destroyed by a single move. Whether the
forfeited credit is worth the bounded tail is the allocation decision; the
structures are not interchangeable and the diagrams do not make the difference
obvious.

## Indian market specifics

**Margin efficiency is the main practical driver.** A four-leg defined-risk
position attracts a fraction of the strangle's margin, which is why condors are
common in Indian retail books despite the smaller credit.

**Costs are four legs in and four legs out.** Eight brokerage charges plus STT
on every sold leg. On a narrow condor in a weekly contract, total cost can
consume a large share of the credit. This is the most cost-sensitive structure
in this folder, and narrow wings make the ratio worse, not better.

**Strike steps.** NIFTY 50 points, BANKNIFTY 100. The `ATM±2` / `ATM±4` in the
frontmatter are strike *steps*, so the same lesson produces a 100-point-wide
wing in NIFTY and a 200-point one in BANKNIFTY. Live steps come from the scrip
master.

**Expiry-day treatment.** The 2% extreme loss margin on short options applies
to both short legs. The February 2025 withdrawal of calendar-spread benefit
does not affect a single-expiry condor.

**Weekly versus monthly.** With BANKNIFTY, FINNIFTY and MIDCPNIFTY monthly-only
since November 2024, a condor in those indices is held for weeks. Theta accrues
more slowly and there is far more time for the underlying to reach a short
strike.

**Physical settlement.** On a stock condor settling between a short strike and
its wing, the short leg is assigned and the long is not — creating a
full-contract-value delivery obligation on E+2 despite the position being
defined-risk. Index condors settle in cash.

## How it typically fails

Two ways, and they are opposite.

Held to expiry, the condor's high hit rate is real and the occasional full-width
loss is the payoff working as designed — problematic only if size was calibrated
to the hit rate.

Managed actively, the more common failure is adjusting a threatened side into a
larger position, converting a defined loss into a rolling one. The wings bound
the original position, not its successors.

## Related

- `strategies/volatility/short-strangle.md` — the undefined-risk version
- `strategies/volatility/iron-butterfly.md` — same idea, short strikes together
- `strategies/vertical-spreads/bull-put-spread.md` — this position's lower half
- `strategies/vertical-spreads/bear-call-spread.md` — its upper half
