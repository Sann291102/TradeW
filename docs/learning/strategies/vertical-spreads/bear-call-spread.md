---
id: bear-call-spread
name: Bear Call Spread
category: vertical-spread
tier: intermediate
concept: option-greeks
summary: A short call with a long call above it in the same expiry. Premium is received upfront and the long leg caps the loss at the spread width.
legs:
  - action: SELL
    kind: CE
    strike: ATM+1
    ratio: 1
    expiry: near
  - action: BUY
    kind: CE
    strike: ATM+3
    ratio: 1
    expiry: near
net: credit
outlook: neutral-to-bearish
maxProfit: Net credit received
maxLoss: Spread width minus net credit
breakeven: Lower strike plus net credit
greeks:
  delta: negative
  gamma: mixed
  theta: positive
  vega: negative
chartNote: >
  The credit is kept in full below the lower line; the upper line is where the
  loss stops growing, which is what the bought call is paying for.
---

# Bear Call Spread

Two legs in the same expiry: a sold call and a bought call at a higher strike.
Also called a call credit spread.

## The structure

The lower strike is the short leg, the higher strike the long leg. Net credit.

The bought call converts the naked short call's unbounded obligation into a
defined maximum loss, and reduces margin to a fraction of the naked
requirement. Given that a naked short call is the least bounded structure
available, this conversion is more consequential here than on the put side.

## What it is exposed to

**Delta** negative and modest.

**Theta** positive — the return source, driven mainly by the nearer-the-money
short leg.

**Gamma** negative near the short strike, rising in magnitude into expiry.

**Vega** negative.

Unlike the put-side spreads, the direction and volatility exposures here do not
usually reinforce each other. Rising markets are typically accompanied by
*falling* implied volatility, so a bear call spread losing on delta is often
simultaneously gaining on vega. This partial offset makes the call-side credit
spread's mark-to-market better behaved in an adverse move than the put side's —
the loss tends to accrue closer to what delta alone implies.

The exception is a volatility-expanding rally, which is rare in equity indices
but not unknown around short squeezes and policy surprises.

## Payoff

- At or below the lower strike at expiry: both expire worthless, full credit kept.
- Between the strikes: the short call is in the money, the long is not.
- At or above the higher strike: both in the money, loss fixed at spread width minus credit.

Maximum profit is the net credit. Maximum loss is spread width minus credit.
Breakeven is the lower strike plus the credit.

## Indian market specifics

**Skew works against the credit.** Call-side implied volatility sits below
put-side for the same distance from spot, so a bear call spread collects less
premium than a bull put spread with equivalent strike distance and width. The
smaller credit is the market pricing upside moves as less violent than downside
ones — not an inefficiency to be arbitraged.

**Margin.** Hedged treatment, far below the naked short call. The 2%
expiry-day extreme loss margin applies to the short leg.

**Physical settlement.** On a stock spread settling between the strikes, the
short call is assigned and the long expires worthless — obliging *delivery* of
shares on E+2. A trader without the stock must buy it in the cash market on a
compressed timeline. Delivery margins accrue from four trading days before
expiry. Index spreads are cash settled and carry no delivery leg.

**Corporate actions.** A bear call spread on a single stock spanning a
dividend, bonus or split date is subject to contract adjustment. Strikes and
lot sizes are revised by the exchange, which can change the spread's width and
economics mid-position. See `fundamentals/corporate-actions.md`.

## How it typically fails

The same shape as every credit structure: a high hit rate accumulated over
quiet expiries, size scaled to that hit rate, and the loss arriving at full
width. The call-side variant has one additional failure specific to it — the
short leg being assigned early is rare in the Indian market's European-style
index options, but stock options are American-style and can be assigned before
expiry when a dividend makes early exercise rational.

## Related

- `strategies/directional/short-call.md` — the same short leg, unbounded
- `strategies/vertical-spreads/bear-put-spread.md` — same view, debit
- `strategies/volatility/iron-condor.md` — this spread plus its put-side mirror
