---
id: short-strangle
name: Short Strangle
category: volatility
tier: advanced
concept: implied-volatility
summary: Sell an out-of-the-money call and an out-of-the-money put in the same expiry. Full premium is kept anywhere between the strikes; loss beyond them is unbounded.
legs:
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
net: credit
outlook: direction-neutral, expecting little movement
maxProfit: Total premium received, anywhere between the two strikes
maxLoss: Unlimited on the upside, very large on the downside
breakeven: Upper strike plus total premium, and lower strike minus total premium
greeks:
  delta: neutral
  gamma: negative
  theta: positive
  vega: negative
chartNote: >
  The two lines are the strikes; the full premium is kept anywhere between them,
  and losses grow without limit beyond the breakeven markers outside them.
---

# Short Strangle

Sell an out-of-the-money call and an out-of-the-money put, same expiry. The
most widely used undefined-risk premium-selling structure in the Indian retail
market.

## The structure

Two sold legs, both out of the money. Premium from both is credited. Margin is
blocked on both legs, though exchanges grant some offset for the opposing
directional exposure.

## What it is exposed to

**Theta** positive across a wide price range — the structural attraction. Unlike
a short straddle, which realises maximum profit at exactly one price, a short
strangle realises maximum profit anywhere between its strikes. That wide
profit plateau is what makes it feel safer than it is.

**Gamma** negative, low while the underlying sits mid-range, rising sharply as
price approaches either strike. The risk is not uniform across the position's
life: it is negligible for most of the holding period and then concentrated.

**Vega** negative. A volatility expansion damages both legs at once.

## Why the wide plateau is misleading

The payoff diagram's flat top spans a wide range, which reads as a large margin
of safety. What the diagram does not show is that the position's risk is not
distributed across that range — it is entirely in the tails, and the tails are
where the position has no defined loss.

A short strangle's profit is capped and known. Its loss is neither. The wide
plateau increases the probability of the capped outcome without changing the
magnitude of the uncapped one.

## Indian market specifics

Every structural rule that applies to the short straddle applies here.

**Expiry-day extreme loss margin** of 2% on short options, since November 2024.

**Calendar-spread margin benefit withdrawn on expiry day**, February 2025 — a
strangle margin-offset by longer-dated positions loses that offset on expiry
day.

**Intraday position-limit monitoring** at multiple snapshots since April 2025.

**Contract-value floor.** SEBI's November 2024 increase of minimum index
contract value to ₹15–20 lakh means a single strangle's notional exposure is
substantial. The margin blocked is a fraction of that notional; the loss in a
tail move is not.

**Gap risk** is the dominant hazard. Both legs are exposed overnight. An
opening gap beyond a strike converts a comfortable position into a large loss
with no intervening opportunity to act.

**Skew.** The put leg collects more premium than the equidistant call leg.
Selecting strikes by equal premium rather than equal distance places the put
strike further from spot than the call — a materially different risk
distribution from the symmetric version, and generally the more considered
construction.

**Physical settlement** on stock strangles: whichever leg finishes in the money
creates a full-contract-value obligation on E+2.

## The defined-risk equivalent

An iron condor is a short strangle with further-out wings bought on both sides.
It collects less premium, caps the loss at the wing width, and reduces margin
substantially. The comparison between the two is the central capital-allocation
question in premium selling, and is set out in
`strategies/volatility/iron-condor.md`.

## How it typically fails

Long sequences of full-premium expiries, size scaled to that experience, and a
single gap or volatility expansion that removes more than the sequence
contributed. The structure's reliability is real; it is the loss distribution
that is misread, not the win rate.

## Related

- `strategies/volatility/iron-condor.md` — the defined-risk version
- `strategies/volatility/short-straddle.md` — narrower, more theta, more gamma
- `risk/position-sizing.md` — sizing against notional rather than margin
