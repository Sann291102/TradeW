---
id: long-put
name: Long Put
category: directional
tier: beginner
concept: option-greeks
summary: A single bought put. Loss is capped at the premium paid; gain accrues as the underlying falls below the strike, bounded only by the underlying reaching zero.
legs:
  - action: BUY
    kind: PE
    strike: ATM
    ratio: 1
    expiry: near
net: debit
outlook: bearish
maxProfit: Strike minus premium, reached if the underlying goes to zero
maxLoss: The premium paid
breakeven: Strike minus premium paid
greeks:
  delta: negative
  gamma: positive
  theta: negative
  vega: positive
chartNote: >
  The line marks the strike; the position only starts making money below the
  strike minus the premium paid, and everything above that line is the loss of
  premium.
---

# Long Put

A long put is one bought put option — the bearish mirror of the long call, with
one asymmetry that matters.

## The structure

One leg: a long put, usually at or near the money, in the near expiry. Premium
is paid upfront in full.

## What it is exposed to

**Direction (delta).** Negative. An at-the-money put has a delta near −0.5,
gaining roughly ₹0.50 per ₹1 the underlying falls, with delta moving toward
−1.00 as it goes deeper in the money.

**Acceleration (gamma).** Positive, peaking at the money and rising into
expiry, exactly as for a call.

**Time (theta).** Negative. Extrinsic value bleeds away daily.

**Volatility (vega).** Positive. A long put gains if implied volatility rises.

This last exposure is where puts differ from calls in practice. Equity index
implied volatility is persistently skewed — downside strikes trade at higher
implied volatility than equivalent upside strikes, because demand for downside
protection is structural rather than speculative. Two consequences follow. A
put is generally more expensive than the equidistant call. And falling markets
tend to raise implied volatility, so a long put often gains on both delta and
vega at once, which is why puts are convex in a way calls are not.

## Payoff

Above the strike at expiry, the put expires worthless and the premium is lost.
Below the strike, intrinsic value accrues as the underlying falls. Breakeven at
expiry is strike minus premium paid.

Maximum gain is bounded, unlike a long call: an underlying cannot fall below
zero, so the most a put can be worth is the strike itself, less the premium
paid. In practice this bound is theoretical for an index.

## Indian market specifics

**Skew makes entry cost asymmetric.** Because index puts carry a volatility
premium, a long put bought in calm conditions is paying for that skew. The same
put bought after a fall is paying an even larger one, since implied volatility
has already risen — buying protection after the move is materially more
expensive than before it.

**India VIX** is computed from NIFTY option prices and is the standard
reference for whether index implied volatility is historically high or low.
A long put entered when VIX is depressed has a very different vega profile
from one entered when it is elevated.

**Cost and settlement.** No STT on purchase. STT of 0.15% of intrinsic value
on exercise. A stock put finishing in the money obliges *delivery* of shares
on E+2 — the holder must have the stock or buy it. Index puts are cash
settled.

**Expiry cadence.** NIFTY weeklies expire Tuesday; BANKNIFTY and the other
indices are monthly-only, last Tuesday. SENSEX weeklies expire Thursday on BSE.

## How it typically fails

Holding a long put through a drift-upward market is the common loss: theta and
falling volatility compound, and the position bleeds on two exposures at once
even when the underlying barely moves. The second pattern is buying puts as
insurance during a panic, when skew and VIX have already repriced, and then
watching volatility normalise faster than the underlying falls.

## Related

- `strategies/vertical-spreads/bear-put-spread.md` — same view, cheaper, capped
- `strategies/directional/protective-put.md` — the same leg used as a hedge
  against held stock rather than as a directional position
- `volatility/smile-and-skew.md` — why puts cost what they cost
