---
id: long-call
name: Long Call
category: directional
tier: beginner
concept: option-greeks
summary: A single bought call. Loss is capped at the premium paid; gain is uncapped above the strike, but time decay works against the position every day it is held.
legs:
  - action: BUY
    kind: CE
    strike: ATM
    ratio: 1
    expiry: near
net: debit
outlook: bullish
maxProfit: Unlimited above the strike
maxLoss: The premium paid
breakeven: Strike plus premium paid
greeks:
  delta: positive
  gamma: positive
  theta: negative
  vega: positive
chartNote: >
  The line marks the strike; the position only starts making money above the
  strike plus the premium paid, and everything below that line is the loss of
  premium.
---

# Long Call

A long call is one bought call option. It is the simplest bullish option
structure and the one most new participants meet first, which is also why its
failure modes are the most commonly misunderstood.

## The structure

One leg: a long call, usually at or near the money, in the near expiry.

The premium is paid in full at entry. Since October 2024 SEBI requires upfront
collection of option premium, so the debit leaves the account immediately —
there is no intraday leverage on the purchase itself.

## What it is exposed to

The position has four distinct exposures, and confusion about long call
outcomes almost always resolves once they are separated.

**Direction (delta).** An at-the-money call has a delta near 0.5, so it gains
roughly ₹0.50 per ₹1 of underlying move at the outset. Delta rises toward 1.00
as the option moves in the money and falls toward 0 as it moves out.

**Acceleration (gamma).** Delta itself is not fixed. Gamma is highest at the
money and rises sharply as expiry approaches, which is why a near-expiry
at-the-money call behaves so violently — small underlying moves produce large
percentage swings in the premium.

**Time (theta).** Every day that passes removes extrinsic value. Theta is
negative for a long call and accelerates into expiry. This is the exposure that
surprises people: the underlying can move up and the call can still lose money,
because the directional gain was smaller than the time decay over the same
period.

**Volatility (vega).** A long call is long vega. If implied volatility falls
while the position is held, the premium falls with it independently of
direction. Around scheduled events this is the dominant term — see
`volatility/volatility-crush.md`.

## Payoff

Below the strike at expiry, the call expires worthless and the entire premium
is lost. Above the strike, intrinsic value accrues one-for-one with the
underlying. Breakeven at expiry sits at strike plus premium paid, so the
underlying must clear the strike *and* the premium before the position is
positive.

Maximum loss is the premium and nothing more. This defined-risk property is
the structural distinction from a long future, where an adverse move is not
capped.

## Indian market specifics

**Expiry cadence.** On NSE only NIFTY carries a weekly contract, expiring
Tuesday. BANKNIFTY, FINNIFTY, MIDCPNIFTY and NIFTYNXT50 lost their weeklies
under SEBI's November 2024 rationalisation and now trade monthly, expiring the
last Tuesday. BSE's SENSEX weekly expires Thursday. A long call held in a
monthly-only index therefore carries a much longer decay horizon than the
weekly NIFTY contract most retail flow concentrates in.

**Cost.** Buying a call attracts no STT on purchase. STT applies at 0.15% of
intrinsic value if the option is exercised, which is the trap in holding a
deep-in-the-money call to expiry rather than squaring off — an in-the-money
option left to exercise pays STT on the whole intrinsic value, not on the
premium.

**Stock options.** A long call on a single stock that finishes in the money
goes to physical settlement, obliging delivery of the full contract value of
shares on E+2. Delivery margins begin accruing four trading days before expiry.
An index call has no such obligation; it is cash settled.

## How it typically fails

The most frequent losing pattern is not being wrong on direction. It is being
right on direction, too late, in a contract with too little time — the
underlying rises, but not before theta has consumed more than the move was
worth. The second most frequent is buying into an event at elevated implied
volatility and holding through the announcement, where the volatility collapse
outweighs the directional gain.

## Related

- `strategies/vertical-spreads/bull-call-spread.md` — same directional view,
  premium reduced by selling a higher strike, gain capped in exchange
- `greeks/theta.md` — the decay term in detail
- `foundations/intrinsic-and-extrinsic-value.md` — what is actually being paid for
