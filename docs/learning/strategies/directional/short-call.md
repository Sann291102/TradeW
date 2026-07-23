---
id: short-call
name: Short Call
category: directional
tier: advanced
concept: option-greeks
summary: A single sold call. Premium is received upfront and kept if the underlying stays below the strike, but loss above the strike is unbounded and margin is required throughout.
legs:
  - action: SELL
    kind: CE
    strike: ATM+2
    ratio: 1
    expiry: near
net: credit
outlook: neutral-to-bearish
maxProfit: The premium received
maxLoss: Unlimited above the strike
breakeven: Strike plus premium received
greeks:
  delta: negative
  gamma: negative
  theta: positive
  vega: negative
chartNote: >
  The line marks the strike; the premium is kept in full anywhere below it, and
  losses grow without limit the further the underlying rises above it.
---

# Short Call

A naked short call is one sold call with no offsetting long position. It is the
structure with the least bounded risk profile available to a retail
participant, and it is presented here because understanding it is a
prerequisite for understanding every spread built on top of it — not because
the risk profile is comparable to the others in this section.

## The structure

One leg: sell a call, typically out of the money. Premium is credited at entry.
Margin is blocked and marked to market daily.

Unlike a long option, where the maximum loss is known at entry and already
paid, a short call's obligation grows with the underlying. There is no upper
bound on how far an index or a stock can rise.

## What it is exposed to

Every greek reverses relative to a long call.

**Delta** is negative — the position loses as the underlying rises.

**Gamma** is negative, and this is the defining hazard. Negative gamma means
the position's delta worsens as the underlying moves against it: the higher the
underlying goes, the faster the position loses per additional point. Gamma
magnitude peaks at the money and rises steeply into expiry, so a short call
that is comfortably out of the money on Friday can be the dominant risk in an
account by Tuesday afternoon.

**Theta** is positive. This is the source of return — extrinsic value decays
into the seller's favour each day.

**Vega** is negative. A rise in implied volatility increases the option's value
and therefore the loss, independently of direction.

## Payoff

At expiry, anywhere at or below the strike, the call expires worthless and the
full premium is retained. Above the strike, loss accrues one-for-one with the
underlying, offset by the premium received. Breakeven is strike plus premium.

The distribution of outcomes is the point: a high probability of a small gain,
against a low probability of a loss with no defined ceiling. Expectancy is not
determined by win rate. See `risk/expectancy.md`.

## Indian market specifics

**Margin.** SPAN plus exposure margin is blocked at entry and recomputed
through the day. SEBI moved position-limit monitoring to multiple intraday
snapshots from April 2025, so intraday breaches are now caught rather than
netted out by close.

**Expiry-day margin.** An additional 2% extreme loss margin applies to short
option positions on expiry day, in force since November 2024. Separately, the
calendar-spread margin benefit was withdrawn on expiry day from February 2025 —
a short call that was margin-offset by a longer-dated leg loses that offset on
the day it matters most.

**STT.** 0.15% of premium on the sale. If assigned, the exercise-side STT of
0.15% of intrinsic value applies to the counterparty, not the writer.

**Physical settlement.** A short stock call finishing in the money obliges
delivery of shares on E+2. A writer without the stock must buy it, at whatever
price the market offers, on a compressed timeline. Delivery margins begin four
trading days before expiry. This is a materially different risk from an index
short call, which is cash settled.

**Gap risk.** Indian equities and indices can gap on overnight global cues,
policy announcements and results. A short call carries the gap in full: there
is no stop-loss that executes between the previous close and the opening
print.

## How it typically fails

The characteristic loss is not gradual. A short call sold far out of the money
prints many small gains, which raises confidence and usually position size, and
the loss when it arrives arrives at a size calibrated to the enlarged position
rather than the original one. Negative gamma is what converts a modest adverse
move into a disproportionate loss late in the contract's life.

## Related

- `strategies/directional/covered-call.md` — the same leg with stock held
  against it, which bounds the upside loss
- `strategies/vertical-spreads/bear-call-spread.md` — the same leg with a
  further call bought above it, which caps the loss at the spread width
- `greeks/gamma.md` — why the risk accelerates rather than accrues
