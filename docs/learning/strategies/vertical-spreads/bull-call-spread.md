---
id: bull-call-spread
name: Bull Call Spread
category: vertical-spread
tier: intermediate
concept: option-greeks
summary: A long call with a short call above it in the same expiry. The sale funds part of the purchase, which lowers breakeven and caps the gain at the short strike.
legs:
  - action: BUY
    kind: CE
    strike: ATM
    ratio: 1
    expiry: near
  - action: SELL
    kind: CE
    strike: ATM+2
    ratio: 1
    expiry: near
net: debit
outlook: moderately-bullish
maxProfit: Spread width minus net debit
maxLoss: Net debit paid
breakeven: Lower strike plus net debit
greeks:
  delta: positive
  gamma: mixed
  theta: mixed
  vega: negative
chartNote: >
  The two lines are the strikes; profit builds between them and stops growing
  at the upper line, which is the price of having paid less to enter.
---

# Bull Call Spread

Two legs in the same expiry: a bought call and a sold call at a higher strike.
Also called a call debit spread.

## The structure

The lower strike is the long leg, the higher strike the short leg, same expiry. The net cost is the
difference between the two premiums — always a debit, since the lower strike is
always worth more.

The trade being made is explicit: give up everything above the short strike, in
exchange for paying materially less at entry. A long call breaks even only
after covering the full premium; a bull call spread breaks even after covering
a reduced one.

## What it is exposed to

**Delta** is positive but smaller than a long call's, because the short leg's
negative delta partially offsets the long leg's.

**Gamma** is mixed and changes sign depending on where the underlying sits. Near
the long strike the position is gamma-positive; near the short strike it is
gamma-negative. Between them the two roughly offset.

**Theta** is mixed for the same reason, and this is the property that makes the
spread behave differently from a long call in a flat market. A long call bleeds
every day. A bull call spread with the underlying between the strikes bleeds far
less, because the short leg is decaying in the position's favour at the same
time the long leg decays against it. If the underlying sits above the short
strike, time decay actually works *for* the position, since it is the short leg
that has extrinsic value left to lose.

**Vega** is net negative when the spread is established with the underlying
below the long strike, and the magnitude is small. The spread is substantially
less volatility-sensitive than a long call — a volatility crush that would
destroy a naked long call leaves a spread comparatively intact, because both
legs reprice together.

That volatility insensitivity is the main structural argument for the spread
over the outright call around scheduled events.

## Payoff

- Below the lower strike at expiry: both legs expire worthless, the net debit is lost.
- Between the strikes: the long call has intrinsic value, the short does not.
- At or above the upper strike: both are in the money, the difference is fixed at the spread width.

Maximum profit is spread width minus net debit. Maximum loss is the net debit.
Breakeven is the lower strike plus the net debit.

The ratio of these two numbers is fixed by the strikes chosen and is worth
computing before entry rather than after. A spread paid for at 40% of its width
risks 40 to make 60.

## Indian market specifics

**Strike step matters.** NIFTY strikes are 50 apart, BANKNIFTY 100. The
`ATM+2` in this lesson's frontmatter means two strike steps, which resolves to a
different width per instrument — the Apply feature substitutes the correct step
from the live scrip master rather than assuming one.

**Margin benefit.** A vertical spread is recognised as a hedged position and
attracts far less margin than the short leg alone. This is the practical reason
spreads dominate retail option selling in India. Note the withdrawal of
calendar-spread benefit on expiry day from February 2025 applies to spreads
across *different* expiries, not to a same-expiry vertical like this one.

**Costs bite twice.** Two legs in, two legs out: four brokerage charges and STT
on both sold legs. On a narrow spread in a liquid weekly contract, costs can be
a meaningful fraction of maximum profit. The narrower the spread, the worse
this ratio.

**Expiry-day assignment.** If the underlying settles between the strikes on a
*stock* spread, the long leg is exercised and the short is not, producing a
physical delivery obligation on one leg only. Index spreads settle in cash and
carry no such asymmetry.

## How it typically fails

The spread rarely produces a catastrophic loss, which is its purpose. It fails
by being chosen for the wrong reason: when a large directional move is what was
expected, the capped payoff forfeits most of the gain, and the position would
have been better expressed as an outright call. It also fails quietly on cost —
a spread entered too narrow, in an illiquid stock contract with a wide bid-ask,
can have negative expectancy before the underlying does anything at all.

## Related

- `strategies/directional/long-call.md` — uncapped version, higher cost, more vega
- `strategies/vertical-spreads/bull-put-spread.md` — same directional view expressed for a credit
- `foundations/payoff-diagrams.md` — reading the kinked line
