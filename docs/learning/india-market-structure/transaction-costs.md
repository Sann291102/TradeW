---
id: transaction-costs
name: Transaction Costs in Indian F&O
category: india-market-structure
tier: beginner
summary: STT, exchange charges, stamp duty, GST and brokerage — what each is levied on, which side pays, and why exercised options are the expensive case.
---

# Transaction Costs in Indian F&O

Costs are not a rounding error in Indian derivatives. On short-dated,
multi-leg, narrow-width structures they can exceed the theoretical edge
entirely. This lesson covers what is charged and on what base — the base
matters more than the rate.

*STT rates verified 24 July 2026 against broker billing schedules. They changed
on 1 April 2026 and will change again by Finance Act.*

## Securities Transaction Tax

STT is the largest statutory component and the one with the most
counter-intuitive structure.

| Segment | Rate | Levied on | Side |
|---|---|---|---|
| Equity delivery | 0.1% | Turnover | Both buy and sell |
| Equity intraday | 0.025% | Turnover | Sell only |
| Futures | 0.05% | Traded price | Sell only |
| Options — sold | 0.15% | **Premium** | Sell only |
| Options — exercised | 0.15% | **Intrinsic value** | Buyer, on exercise |

Rates on futures and options were raised effective 1 April 2026 — futures from
0.02%, options sold from 0.1%, options exercised from 0.125%. Equity delivery
and intraday were left unchanged.

### The exercised-option trap

The two option rows have the same rate and completely different bases, and this
is the single most expensive avoidable cost in Indian options.

An option that is **sold** pays 0.15% of the *premium*. An option that is
**exercised** pays 0.15% of the *intrinsic value* — the full in-the-money
amount, which for a deep in-the-money option is many multiples of the premium
originally paid.

Consider a call bought for a small premium that finishes deep in the money.
Squaring off in the market pays STT on the sale premium. Allowing it to be
exercised at expiry pays STT on the entire intrinsic value. The difference can
be larger than the profit on the position.

The general shape: an in-the-money option left to expire is charged on a much
larger base than the same option closed in the market. This applies to index
options at cash settlement as well as to stock options.

## Everything else

**Exchange transaction charges** — a small percentage of premium turnover for
options, of contract turnover for futures. Rates differ between NSE and BSE and
between segments.

**Stamp duty** — levied on the buy side only, at rates set per segment.

**SEBI turnover fees** — a very small levy on turnover.

**GST** — 18%, charged on brokerage plus exchange transaction charges (not on
STT, and not on turnover directly).

**Brokerage** — the only negotiable component. Typically a flat per-order
amount for derivatives rather than a percentage, which is what makes leg count
matter.

## Why leg count dominates

For flat-fee brokerage, cost scales with the number of orders, not the size of
the position.

| Structure | Legs | Orders round-trip |
|---|---|---|
| Long call | 1 | 2 |
| Vertical spread | 2 | 4 |
| Straddle / strangle | 2 | 4 |
| Iron condor / butterfly | 4 | 8 |

An iron condor pays four times the brokerage of a long call for the same
notional. On a wide condor in a liquid contract that is immaterial. On a narrow
one it can be a substantial fraction of the maximum profit — and narrow
structures are exactly the ones with small maximum profits.

The ratio worth computing before entry is **total round-trip cost divided by
maximum profit**. For narrow defined-risk structures this ratio is often
double-digit percentage, and it is fixed at entry regardless of how the
position performs.

## Bid-ask spread is a cost too

Not a charge, but a real one. Crossing the spread on entry and exit is paid on
every leg. In liquid NIFTY weekly strikes near the money the spread is narrow.
In monthly-only indices, in far strikes, and in single-stock options it can be
wide enough to dominate every statutory charge combined.

Since the November 2024 rationalisation removed weekly contracts from
BANKNIFTY, FINNIFTY, MIDCPNIFTY and NIFTYNXT50, liquidity in those chains
concentrated into monthly expiries — so far-strike liquidity in them is thinner
than pre-2024 material suggests.

## Related

- `india-market-structure/physical-settlement.md` — the other expiry-day cost
- `risk/expectancy.md` — where costs enter the arithmetic
- `strategies/volatility/iron-condor.md` — the most cost-sensitive structure here
