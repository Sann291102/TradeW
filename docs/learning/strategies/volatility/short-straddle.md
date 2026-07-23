---
id: short-straddle
name: Short Straddle
category: volatility
tier: advanced
concept: implied-volatility
summary: A short call and a short put at the same strike and expiry. Premium is kept if the underlying stays near the strike; loss grows without limit as it moves away in either direction.
legs:
  - action: SELL
    kind: CE
    strike: ATM
    ratio: 1
    expiry: near
  - action: SELL
    kind: PE
    strike: ATM
    ratio: 1
    expiry: near
net: credit
outlook: direction-neutral, expecting little movement
maxProfit: Total premium received, if the underlying settles exactly at the strike
maxLoss: Unlimited on the upside, very large on the downside
breakeven: Strike plus total premium, and strike minus total premium
greeks:
  delta: neutral
  gamma: negative
  theta: positive
  vega: negative
chartNote: >
  The single line is the strike; the full premium is kept only if price finishes
  near it, and losses grow in both directions beyond the breakeven markers.
---

# Short Straddle

A short call and a short put at the same strike, same expiry. The mirror of the long
straddle, and the structure with the most concentrated risk profile in common
retail use in the Indian market.

## The structure

Two short legs at one strike, usually at the money. Premium from both is
credited at entry. Margin is blocked on both.

Delta is near zero at entry. The position is short movement.

## What it is exposed to

**Theta** strongly positive, collected on two at-the-money legs — the largest
theta available from any two-leg structure. This is the attraction.

**Gamma** strongly negative, and this is the entire risk. The position acquires
delta *against* the direction of movement: it becomes short as the underlying
rises and long as it falls. Every point of movement makes the next point more
expensive. Gamma magnitude peaks at the money and rises steeply into expiry,
so the position is most dangerous exactly where and when it earns the most
theta.

There is no way to separate these. The theta is compensation for the gamma.

**Vega** strongly negative. A volatility expansion damages the position
independently of direction.

## Payoff

Maximum profit is the full premium, achieved only if the underlying settles
exactly at the strike. Losses accrue in both directions beyond strike ± total
premium — unbounded above, bounded only by zero below.

The distribution is extreme: a high probability of a moderate gain against a
low probability of a loss with no defined ceiling. This is the payoff shape
that win-rate statistics describe worst.

## Indian market specifics

This structure interacts with Indian market rules more than any other in this
folder, and every interaction runs the same direction.

**Expiry-day margin.** An additional 2% extreme loss margin on short option
positions applies on expiry day, in force since November 2024 — precisely when
a short straddle's gamma is at its maximum.

**Calendar-spread benefit withdrawn.** From February 2025, margin offset from
positions in other expiries is not available on expiry day. A short straddle
partially hedged by longer-dated longs loses that margin relief on the day it
is most needed.

**Intraday position monitoring.** Since April 2025 position limits are checked
at multiple points during the day rather than at close, so an intraday
expansion cannot be quietly netted out before the snapshot.

**Gap risk.** The position is held overnight against global cues, results and
policy. A gap opens beyond the breakeven with no opportunity to exit in
between. No stop-loss executes across a gap.

**Physical settlement.** On a stock straddle, whichever leg finishes in the
money is assigned, producing a delivery or receipt obligation for the full
contract value on E+2 — a cash requirement unrelated to the margin the position
was sized against.

**Weekly concentration.** Since only NIFTY carries an NSE weekly, short-dated
straddle flow concentrates there, which is also where gamma is sharpest.

## How it typically fails

It works, repeatedly, and that is the mechanism of failure. A short straddle
retains premium in most expiries, which builds a track record that justifies
larger size, which is then in place when a gap or a volatility expansion
arrives. The loss is not proportional to the gains that preceded it and is not
bounded by them.

Every element of SEBI's post-2024 derivatives framework — the margin additions,
the expiry-day treatment, the contract-value floor — is a response to the
aggregate of these positions, which is itself informative about the risk
profile.

## Related

- `strategies/volatility/iron-butterfly.md` — the same structure with wings
  bought, converting unbounded loss to a defined one
- `strategies/volatility/short-strangle.md` — wider strikes, less theta, more room
- `greeks/gamma.md` — why the loss accelerates
- `risk/tail-risk.md` — why win rate does not describe this
