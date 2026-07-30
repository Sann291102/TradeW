---
id: physical-settlement
name: Physical Settlement of Stock F&O
category: india-market-structure
tier: intermediate
summary: Stock derivatives settle in shares, not cash. What that obliges, when delivery margins begin, and why it turns defined-risk positions into undefined cash requirements.
---

# Physical Settlement of Stock F&O

Index derivatives settle in cash. **Stock derivatives settle in shares.** This
distinction is the source of more unexpected obligations than any other feature
of the Indian market, because it converts a position sized against margin into
an obligation sized against full contract value.

Mandatory for all stock F&O since April 2018.

## What settles and what does not

At expiry:

| Position | Outcome |
|---|---|
| Stock future, long | Take delivery of shares |
| Stock future, short | Deliver shares |
| Stock option, ITM long call | Take delivery — pay full contract value |
| Stock option, ITM short call | Deliver shares — must own or buy them |
| Stock option, ITM long put | Deliver shares — must own or buy them |
| Stock option, ITM short put | Take delivery — pay full contract value |
| Any OTM option | Expires worthless, no obligation |
| Any index option | Cash settled, no obligation |

Settlement occurs on **expiry plus two trading days (E+2)**.

## Delivery margins

Exchanges do not wait until expiry to collect. Delivery margin begins accruing
**four trading days before expiry** and increases each day until settlement.

With NSE stock F&O expiring on the last Tuesday, that means margin starts
building from the preceding Wednesday. A position that was comfortable on
Tuesday of the prior week can face a materially higher margin requirement by
Friday, purely from the calendar, with no change in the underlying.

This is the mechanism that surfaces a settlement problem before settlement
rather than at it. It is also why positions in stock contracts are frequently
closed in the week before expiry regardless of view — the margin becomes
punitive relative to the remaining opportunity.

## Why defined risk does not mean defined cash

This is the part that matters most and is least obvious.

A bull put spread on a stock is a defined-risk position: maximum loss is the
spread width minus the credit. If the underlying settles **between** the
strikes, the short put is assigned and the long put expires worthless.

The economic loss is still bounded. The **cash requirement is not related to
it**. Assignment on the short put obliges taking delivery of the full contract
value in shares on E+2 — an amount that can be many times the position's
maximum loss and many times the margin that was blocked.

The same asymmetry applies to every defined-risk stock structure where one leg
finishes in the money and the other does not: vertical spreads, condors,
butterflies. The wings bound the loss; they do not bound the settlement.

An account can therefore hold a position that is correctly sized by every risk
measure and still be unable to settle it.

## The OTM exception

Out-of-the-money options expire worthless with no delivery obligation. This is
why the entire issue disappears for positions closed before expiry, and why
stock option positions are so often squared off rather than held to
settlement.

Closing the position in the market before expiry removes both the settlement
obligation and the exercised-option STT charge described in
`india-market-structure/transaction-costs.md`. These are two independent
reasons pointing the same way.

## Index contracts

NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYNXT50 and SENSEX are cash
settled. There is no delivery leg, no delivery margin, and no share
obligation. The difference in operational risk between an index condor and the
same structure on a single stock is large and is not visible in the payoff
diagram.

## Corporate actions

Stock contracts spanning a dividend, bonus, split or merger are adjusted by the
exchange — strike prices and market lots are revised so that position value is
preserved. A spread's width can change as a result, altering the structure's
economics mid-position. Stock options in India are American-style and can be
assigned early, which becomes rational for a counterparty ahead of a large
dividend.

Index options are European-style and cannot be assigned before expiry.

## Related

- `india-market-structure/transaction-costs.md` — exercised-option STT
- `india-market-structure/expiry-architecture.md` — when stock contracts expire
- `strategies/vertical-spreads/bull-put-spread.md` — the assignment asymmetry in context
- `fundamentals/corporate-actions.md` — contract adjustment
