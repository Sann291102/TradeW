---
id: long-strangle
name: Long Strangle
category: volatility
tier: intermediate
concept: implied-volatility
summary: A long out-of-the-money call paired with a long out-of-the-money put in the same expiry. Cheaper than a straddle, with wider breakevens and a flat loss zone between the strikes.
legs:
  - action: BUY
    kind: PE
    strike: ATM-2
    ratio: 1
    expiry: near
  - action: BUY
    kind: CE
    strike: ATM+2
    ratio: 1
    expiry: near
net: debit
outlook: direction-neutral, expecting a large move
maxProfit: Unlimited on the upside, bounded by zero on the downside
maxLoss: Total premium paid, anywhere between the two strikes
breakeven: Upper strike plus total premium, and lower strike minus total premium
greeks:
  delta: neutral
  gamma: positive
  theta: negative
  vega: positive
chartNote: >
  The two lines are the strikes; the full premium is lost anywhere between them,
  and the position only pays beyond the breakeven markers outside them.
---

# Long Strangle

A long out-of-the-money call and a long out-of-the-money put, same expiry. The
lower-cost relative of the long straddle.

## The structure

Two long legs at different strikes, both out of the money, usually placed
symmetrically around spot. Total premium is lower than the equivalent straddle
because neither leg has intrinsic value and both are further from the money.

## What it is exposed to

The same four exposures as a long straddle, all attenuated.

**Gamma** positive but lower at entry than a straddle's, since gamma peaks at
the money and both legs are away from it. Gamma rises as the underlying
approaches either strike.

**Theta** negative but smaller in absolute terms — out-of-the-money options
carry less extrinsic value to lose per day.

**Vega** positive. Note that out-of-the-money options carry proportionally more
vega relative to their price than at-the-money options do, so a strangle is
more *percentage*-sensitive to a volatility change than a straddle, even though
its absolute vega is lower.

## Payoff versus the straddle

The comparison is the reason to choose between them, and it is not simply
"cheaper".

A straddle loses its maximum only at exactly one price. A strangle loses its
maximum across the entire range between the strikes — a much larger set of
outcomes. In exchange, the maximum is a smaller number.

A strangle's breakevens are further apart than a straddle's on the same
underlying, so it needs a larger move to profit, but it needs less money at
risk to get there. Which is preferable depends on the shape of the expected
move rather than on cost alone: a strangle suits a scenario where a very large
move is plausible, a straddle where a moderate one is.

## Indian market specifics

**Skew makes the strangle asymmetric.** The out-of-the-money put trades at
higher implied volatility than the equidistant out-of-the-money call. A
symmetric-strike strangle is therefore not a symmetric-cost position — more of
the premium is spent on the put side. Choosing strikes by equal premium rather
than equal distance produces a differently shaped position, with the call
strike closer to spot than the put.

**Event pricing.** As with straddles, implied volatility rises into scheduled
events and collapses after. A strangle bought into an event faces the same
volatility crush, and because out-of-the-money options are proportionally more
vega-sensitive, the percentage damage from the crush is worse.

**Liquidity.** Strikes two or three steps out in NIFTY weeklies are liquid.
The equivalent strikes in a monthly-only index like BANKNIFTY, or in a single
stock, may not be — and a strangle's economics are sensitive to paying the
spread on two legs at entry and two at exit.

**Expiry cadence.** NIFTY weekly on Tuesday, BANKNIFTY and the other indices
monthly on the last Tuesday, SENSEX weekly on Thursday. A monthly-only strangle
holds gamma for weeks rather than days, changing the theta burden
substantially.

## How it typically fails

The underlying moves, but not far enough. A strangle rewards magnitude, and a
move that would have paid a straddle handsomely can leave a strangle at a total
loss because it never cleared the further strike. The second pattern is the
event trade described above.

## Related

- `strategies/volatility/long-straddle.md` — narrower breakevens, higher cost
- `strategies/volatility/short-strangle.md` — the other side
- `volatility/smile-and-skew.md` — why the two legs are not priced symmetrically
