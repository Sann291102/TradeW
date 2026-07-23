---
id: iron-butterfly
name: Iron Butterfly
category: volatility
tier: advanced
concept: implied-volatility
summary: A short straddle with protective wings bought on both sides. Four legs, one expiry — maximum profit at the centre strike, loss capped at the wing width.
legs:
  - action: BUY
    kind: PE
    strike: ATM-2
    ratio: 1
    expiry: near
  - action: SELL
    kind: PE
    strike: ATM
    ratio: 1
    expiry: near
  - action: SELL
    kind: CE
    strike: ATM
    ratio: 1
    expiry: near
  - action: BUY
    kind: CE
    strike: ATM+2
    ratio: 1
    expiry: near
net: credit
outlook: direction-neutral, expecting price to settle near the centre strike
maxProfit: Net credit received, at the centre strike
maxLoss: Wing width minus net credit
breakeven: Centre strike minus credit, and centre strike plus credit
greeks:
  delta: neutral
  gamma: negative
  theta: positive
  vega: negative
chartNote: >
  The middle line is where the position pays most and the outer two are where
  the loss stops growing — it wants price pinned to the centre.
---

# Iron Butterfly

Four legs, one expiry: a short straddle at the centre strike, with a long put
below and a long call above. Equivalently, a bull put spread and a bear call
spread sharing the same short strike.

## The structure

- Buy a put below the centre
- Sell a put at the centre
- Sell a call at the centre
- Buy a call above the centre

Net credit, and a larger one than an iron condor of the same wing width,
because the short legs are at the money rather than out of it.

## What it is exposed to

**Theta** positive and large — two at-the-money short legs carry the most
extrinsic value available to decay.

**Gamma** negative and sharply so near the centre, bounded by the wings.

**Vega** negative, bounded.

## Against the iron condor

Same four-leg shape, same defined risk, different distribution.

| | Iron butterfly | Iron condor |
|---|---|---|
| Short strikes | Together, at the money | Apart, out of the money |
| Credit | Larger | Smaller |
| Profit zone | Narrow, peaked at the centre | Wide, flat between shorts |
| Probability of max profit | Low | Higher |
| Risk-reward | Better | Worse |

The butterfly pays more and wins less often; the condor pays less and wins more
often. Neither dominates. The butterfly's profit is a peak rather than a
plateau — it is realised in full only if the underlying settles at the centre
strike, and it decays away from there in both directions.

Notably, the butterfly's *breakevens* are often wider than its narrow profit
peak suggests, because the credit received is large. A position can be
profitable across a reasonable range while only achieving maximum profit at one
point.

## Indian market specifics

**Expiry-day pinning.** Underlyings sometimes settle close to strikes with
large open interest, an effect associated with market-maker hedging and with
the max-pain concept — which is contested and carries low confidence in this
repo's own ontology (`knowledge-base/options/max-pain.yaml`). An iron butterfly
placed at a high-open-interest strike is a position whose best outcome depends
on an effect that is not reliably established. It is worth knowing that the
association is debated rather than assumed.

**Weekly NIFTY concentration.** With NIFTY the only NSE index carrying weeklies
since November 2024, expiry-day butterflies concentrate there. Centre-strike
gamma on a Tuesday afternoon is extreme; the wings are what make the structure
survivable, and their width is the only thing standing between the position and
a full-width loss.

**Costs.** Four legs each way. Because a butterfly's wings are typically
narrower than a condor's, cost as a fraction of maximum profit is high, and on
very narrow butterflies it can exceed the theoretical edge entirely.

**Margin.** Defined-risk treatment, well below a naked short straddle. The 2%
expiry-day extreme loss margin applies to both short legs.

**Physical settlement.** On a stock butterfly, an at-the-money short leg
finishing marginally in the money is assigned, creating a full-contract-value
obligation on E+2. With both short legs at the same strike, one of them is
nearly always in the money by some amount at settlement.

## How it typically fails

The underlying drifts away from the centre and stays there. Unlike a condor,
which tolerates drift within a wide band, the butterfly starts losing
immediately as the underlying leaves the centre strike. The second failure is
cost: on a narrow butterfly, eight legs of brokerage and STT against a small
credit leave very little margin for the position to be right.

## Related

- `strategies/volatility/iron-condor.md` — wider shorts, flatter payoff
- `strategies/volatility/short-straddle.md` — the same core without wings
- `foundations/payoff-diagrams.md` — reading a peaked payoff
