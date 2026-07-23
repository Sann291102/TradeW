---
id: bear-put-spread
name: Bear Put Spread
category: vertical-spread
tier: intermediate
concept: option-greeks
summary: A long put with a short put below it in the same expiry. The sale reduces the cost and caps the gain at the lower strike.
legs:
  - action: BUY
    kind: PE
    strike: ATM
    ratio: 1
    expiry: near
  - action: SELL
    kind: PE
    strike: ATM-2
    ratio: 1
    expiry: near
net: debit
outlook: moderately-bearish
maxProfit: Spread width minus net debit
maxLoss: Net debit paid
breakeven: Higher strike minus net debit
greeks:
  delta: negative
  gamma: mixed
  theta: mixed
  vega: negative
chartNote: >
  The two lines are the strikes; profit builds as price falls between them and
  stops growing at the lower line.
---

# Bear Put Spread

The mirror of the bull call spread. Two legs in the same expiry: a bought put
and a sold put at a lower strike. Also called a put debit spread.

## The structure

The higher strike is the long leg, the lower strike the short leg, same expiry. Net debit, since the
higher put is worth more.

## What it is exposed to

**Delta** negative, smaller in magnitude than an outright long put.

**Gamma and theta** mixed, changing character depending on where the underlying
sits relative to the two strikes — gamma-positive near the long strike,
gamma-negative near the short one, roughly offsetting between them.

**Vega** net negative and small in magnitude.

This last point is where the bear put spread earns its place, and the reason is
specific to puts rather than general to spreads. Index put skew means the lower
strike carries *higher* implied volatility than the higher strike. Selling the
lower strike therefore sells the more expensive volatility and buys the
cheaper. A bear put spread partially monetises skew, which an outright long put
pays for in full.

The practical consequence: in a high-VIX environment, a bear put spread is
substantially cheaper relative to an outright put than the same comparison
would be for calls in a high-volatility environment. The steeper the skew, the
better the spread compares.

## Payoff

- Above the higher strike at expiry: both expire worthless, net debit lost.
- Between the strikes: the long put has intrinsic value, the short does not.
- At or below the lower strike: both in the money, difference fixed at spread width.

Maximum profit is spread width minus net debit. Maximum loss is the net debit.
Breakeven is the higher strike minus the net debit.

## Indian market specifics

**Skew is the reason to prefer this over a long put**, and it is also the
reason the maximum profit looks smaller than expected. Selling the expensive
lower strike brings in more premium, which lowers the debit — but the lower
strike is priced richly precisely because large downside moves happen. The
capped payoff forfeits exactly the scenario the skew is pricing.

**Margin.** Treated as a hedged position, so margin is a fraction of the naked
short put's.

**Physical settlement asymmetry.** On a stock spread settling between the
strikes, the long put is exercised and the short is not — obliging delivery of
shares on E+2. The trader must have or acquire the stock. Index spreads are
cash settled.

**Costs.** Four legs of brokerage across entry and exit, STT of 0.15% of
premium on each sold leg.

## How it typically fails

The same way its bullish counterpart does — it caps the move it was built for.
A bear put spread held through a genuine market break captures only to the
lower strike, while the skew it sold reprices violently against the short leg
on the way down. In a fast decline the spread's mark-to-market can look far
worse than its expiry payoff, because the short leg's implied volatility rises
faster than the long leg's.

## Related

- `strategies/directional/long-put.md` — uncapped, more expensive, long vega
- `strategies/vertical-spreads/bear-call-spread.md` — same view, expressed for a credit
- `volatility/smile-and-skew.md` — why the lower strike is the expensive one
