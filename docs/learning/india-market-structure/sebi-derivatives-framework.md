---
id: sebi-derivatives-framework
name: SEBI's Index Derivatives Framework
category: india-market-structure
tier: intermediate
summary: The six measures SEBI introduced from October 2024 onward, what each one changed, and how they interact with short option positions.
---

# SEBI's Index Derivatives Framework

Between October 2024 and April 2025, SEBI introduced a connected set of
measures that reshaped index derivatives trading in India. They are usually
listed as six items. Understanding them as a set matters more than memorising
them individually, because they converge on the same target: short-dated short
option positions held into expiry.

*Verified 24 July 2026.*

## The six measures

| Measure | Effective | What changed |
|---|---|---|
| Upfront premium collection | Oct 2024 | Option buyers pay the full premium at entry; no intraday leverage on purchases |
| Contract size increase | Nov 2024 | Minimum index contract value raised to ₹15–20 lakh from ₹5–10 lakh |
| Weekly expiry rationalisation | Nov 2024 | One weekly index per exchange — NIFTY on NSE, SENSEX on BSE |
| Expiry-day extreme loss margin | Nov 2024 | Additional 2% ELM on short option positions on expiry day |
| Calendar-spread benefit withdrawn | Feb 2025 | No margin offset across expiries on expiry day |
| Intraday position-limit monitoring | Apr 2025 | Limits checked at multiple points intraday, not only at close |

## How they interact

Read individually, each looks like a modest administrative change. Read
together, they describe a single position type being progressively constrained:
a short option, in a short-dated contract, held into expiry, sized against
margin rather than notional.

**Upfront premium collection** removed the ability to fund option purchases
intraday, which had allowed positions larger than the account could settle.

**The contract-value floor** raised the minimum notional exposure per lot. This
is the measure most often misread as "lot sizes went up". What SEBI fixed is
the *contract value* band; lot size is the dependent variable, recalculated
whenever the index level drifts far enough that the notional leaves the band.
This is why NIFTY's lot size has been revised more than once and will be again.
See `india-market-structure/contract-value-and-lot-size.md`.

**Weekly rationalisation** removed four of NSE's five weekly indices, ending a
structure where an expiry fell on nearly every trading day.

**The expiry-day ELM and the calendar-spread withdrawal** both target the same
session. Gamma on expiry day is at its maximum, and both measures increase the
capital a short position must hold precisely then. The calendar-spread
withdrawal is the sharper of the two: a position that was margin-offset by a
longer-dated hedge loses that relief on the day the hedge is least effective,
because a far-dated option does not respond to a near-dated gamma event.

**Intraday monitoring** closed the gap between real intraday exposure and
end-of-day reported exposure.

## What this means for position sizing

The framework's implicit message is that margin is not a measure of risk.

A short option position's margin can be a small fraction of its notional
exposure. SEBI's response was to raise the notional floor, add margin
specifically where risk concentrates, and remove offsets that understated it.
Sizing a book against blocked margin rather than against contract value
produces a position that satisfies every rule and still cannot absorb a tail
move.

`risk/position-sizing.md` covers the arithmetic.

## What it does not do

None of these measures caps loss on a short option. A naked short call retains
unbounded loss; a short strangle retains unbounded loss on both sides. The
framework raises the capital required to hold such positions and reduces the
leverage available, but the payoff shape is unchanged.

Defined-risk structures — spreads, condors, butterflies — bound the loss
structurally rather than by regulation, and receive materially lower margin as
a result. That margin differential is the mechanism by which the framework
pushes activity toward bounded structures.

## Related

- `india-market-structure/expiry-architecture.md` — the schedule these rules produced
- `india-market-structure/margins.md` — SPAN, exposure and ELM in detail
- `india-market-structure/contract-value-and-lot-size.md` — why lot sizes keep changing
- `strategies/volatility/short-strangle.md` — the position most affected
