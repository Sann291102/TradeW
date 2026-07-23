---
id: long-straddle
name: Long Straddle
category: volatility
tier: intermediate
concept: implied-volatility
summary: A long call and a long put at the same strike and expiry. The position gains on a large move in either direction and loses if the underlying stays still.
legs:
  - action: BUY
    kind: CE
    strike: ATM
    ratio: 1
    expiry: near
  - action: BUY
    kind: PE
    strike: ATM
    ratio: 1
    expiry: near
net: debit
outlook: direction-neutral, expecting a large move
maxProfit: Unlimited on the upside, bounded by zero on the downside
maxLoss: Total premium paid, if the underlying settles exactly at the strike
breakeven: Strike plus total premium, and strike minus total premium
greeks:
  delta: neutral
  gamma: positive
  theta: negative
  vega: positive
chartNote: >
  The single line is the strike; the position needs price to finish outside
  either breakeven marker, and loses most if it finishes right on the line.
---

# Long Straddle

A long call and a long put at the same strike, same expiry — almost always at the
money. The position has no directional view; it has a view about magnitude.

## The structure

Two long legs, one strike. Total premium is the sum of both, and that total
is the maximum loss.

Delta is roughly zero at entry because the call's positive delta and the put's
negative delta offset. The position is not betting on direction. It is betting
that realised movement will exceed what implied volatility has priced in.

## What it is exposed to

**Gamma** strongly positive. This is the engine. As the underlying moves in
either direction, the position acquires delta in the direction of the move —
it gets longer as price rises and shorter as price falls. That self-correcting
property is what produces gain from movement alone.

**Theta** strongly negative, and it is paid twice. Two long options both decay,
and both are at the money where extrinsic value is greatest. An at-the-money
straddle in the final days of a weekly contract loses value at a rate that
surprises people who have only held single options.

**Vega** strongly positive. The position gains if implied volatility rises even
without the underlying moving.

The tension between gamma and theta is the whole trade. Gamma pays when the
underlying moves; theta charges rent for the privilege of holding gamma. The
position is profitable when realised volatility exceeds implied volatility over
the holding period — that is the actual condition, stated precisely.

## Payoff

At expiry the position is worth the distance between the underlying and the
strike, in either direction. It is profitable beyond strike ± total premium.
Maximum loss occurs at exactly the strike, where both legs expire worthless.

The breakevens are wide. Both legs' premiums must be recovered by movement in
*one* direction, since only one leg can finish in the money. This is why a
straddle needs a genuinely large move, not merely a directional one.

## Indian market specifics

**The event problem.** Straddles are most often bought before scheduled events
— results, RBI policy, budget, election counting. Implied volatility rises into
those events precisely because everyone anticipates movement. The straddle
bought the day before is paying an inflated premium, and when the event passes,
implied volatility collapses regardless of outcome. The underlying can move
substantially and the straddle can still lose, because the vega loss exceeds
the gamma gain.

This is the most reliable way to lose money on a correct forecast, and it is
covered in `volatility/volatility-crush.md`.

**Weekly decay.** With only NIFTY carrying weekly contracts on NSE since the
November 2024 rationalisation, weekly straddles concentrate in one instrument.
A NIFTY weekly straddle held from Wednesday into Tuesday expiry faces
near-vertical theta in its final sessions.

**India VIX** is the reference for whether the straddle is being bought cheap
or dear. An at-the-money straddle's price is approximately the market's
expected move over the contract's life — comparing that implied move against
the underlying's recent realised range is the comparison the position depends
on.

**Cost.** Two legs in, two out, plus STT on both sold legs at exit. On a weekly
NIFTY straddle these costs are small relative to premium, but on an illiquid
stock straddle the bid-ask on two legs can consume a meaningful share of the
expected move.

## How it typically fails

Buying before an event and holding through it, as above. Second: holding
through a quiet period and paying theta on both legs for days while the
underlying oscillates within the breakevens — being right that a move is coming
but wrong about when, which for a decaying position is the same as being wrong.

## Related

- `strategies/volatility/long-strangle.md` — cheaper, wider breakevens, same idea
- `strategies/volatility/short-straddle.md` — the other side of this trade
- `volatility/historical-vs-implied.md` — the comparison that determines the outcome
