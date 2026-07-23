---
id: bull-put-spread
name: Bull Put Spread
category: vertical-spread
tier: intermediate
concept: option-greeks
summary: A short put with a long put below it in the same expiry. Premium is received upfront and the long leg caps the loss at the spread width.
legs:
  - action: SELL
    kind: PE
    strike: ATM-1
    ratio: 1
    expiry: near
  - action: BUY
    kind: PE
    strike: ATM-3
    ratio: 1
    expiry: near
net: credit
outlook: neutral-to-bullish
maxProfit: Net credit received
maxLoss: Spread width minus net credit
breakeven: Higher strike minus net credit
greeks:
  delta: positive
  gamma: mixed
  theta: positive
  vega: negative
chartNote: >
  The credit is kept in full above the upper line; the lower line is where the
  loss stops growing, which is what the bought put is paying for.
---

# Bull Put Spread

Two legs in the same expiry: a sold put and a bought put at a lower strike.
Also called a put credit spread. The same directional view as a bull call
spread, expressed for a credit rather than a debit.

## The structure

The higher strike is the short leg, the lower strike the long leg. Net credit, since the higher put
is worth more.

The long leg is not there to make money. It is there to convert an unbounded
obligation into a defined one, and to collapse the margin requirement. Both
effects are the reason this structure, rather than the naked short put,
dominates retail premium selling in India.

## What it is exposed to

**Delta** positive but modest.

**Theta** positive — the position's primary source of return. Both legs decay,
but the short leg is nearer the money and therefore carries more extrinsic
value to lose, so the net is favourable.

**Gamma** negative in the region that matters. As the underlying approaches the
short strike, the position's delta deteriorates at an accelerating rate. Gamma
magnitude rises into expiry, which is why a credit spread that is safely out of
the money with a week to run can become the account's dominant exposure within
two sessions.

**Vega** negative. Rising implied volatility widens both legs, and the short
leg widens more.

The correlation problem from the naked short put persists here in reduced form:
falling markets raise implied volatility, so delta and vega deteriorate
together. The long leg bounds how bad this gets, but does not prevent the
mark-to-market from moving faster than the underlying alone implies.

## Payoff

- At or above the higher strike at expiry: both expire worthless, full credit retained.
- Between the strikes: the short put is in the money, the long is not; loss accrues.
- At or below the lower strike: both in the money, loss fixed at spread width minus credit.

Maximum profit is the net credit. Maximum loss is the spread width minus the
credit. Breakeven is the higher strike minus the credit.

## The risk-reward is inverted, and that is the point

A credit spread typically risks several rupees to make one. A spread collecting
30% of its width risks 70 to make 30. This is not a defect — it is the
compensation structure for a position that wins most of the time. Expectancy
depends on whether the win rate exceeds the ratio the payoff demands, not on
whether the ratio looks attractive. See `risk/expectancy.md`.

Reading the credit as "income" and the loss as an aberration is the single most
common misreading of this structure.

## Indian market specifics

**Skew helps the entry.** Selling the higher put and buying the lower one means
selling the cheaper implied volatility and buying the more expensive — the
opposite of the bear put spread's skew capture. The credit received is
therefore smaller than a symmetric-volatility model would suggest. This is
mechanical, not a mispricing.

**Margin.** Recognised as hedged, so margin is far below the naked short put.
The 2% expiry-day extreme loss margin on short options still applies to the
short leg.

**Physical settlement.** On a stock spread settling between the strikes, the
short put is assigned and the long expires worthless — obliging the trader to
*take* delivery of the full contract value on E+2. The long leg caps the
economic loss but does not remove the settlement obligation. This is the
mechanism by which a defined-risk position produces an undefined cash
requirement, and it is specific to stock contracts. Index spreads settle in
cash.

**Expiry cadence.** NIFTY weeklies on Tuesday give the most frequent cycle;
BANKNIFTY is monthly-only since the November 2024 rationalisation, so a
BANKNIFTY credit spread carries a full month of gamma exposure rather than a
week.

## How it typically fails

Consistently, until it does not. A run of expiries in which the credit is kept
in full establishes a base rate that the payoff does not support, and size
grows to match the apparent reliability. The loss arrives compressed into one
or two sessions, at the full spread width, on a position sized for the win
rate rather than the loss.

## Related

- `strategies/directional/short-put.md` — the same short leg, unbounded
- `strategies/vertical-spreads/bull-call-spread.md` — same view, debit
- `strategies/volatility/iron-condor.md` — this spread plus its call-side mirror
