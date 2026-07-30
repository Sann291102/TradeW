---
id: expiry-architecture
name: NSE and BSE Expiry Architecture
category: india-market-structure
tier: beginner
summary: Which contracts expire on which day, why only two indices still carry weekly expiries, and how the holiday rule shifts settlement.
---

# NSE and BSE Expiry Architecture

The expiry calendar is the single most consequential piece of Indian market
structure for anyone holding options, and it changed substantially between
November 2024 and September 2025. Material written before that period describes
a market that no longer exists.

*Verified 24 July 2026. See `docs/learning/README.md` for the full table of
facts with an expiry date.*

## The current schedule

| | NSE | BSE |
|---|---|---|
| Weekly expiry index | NIFTY only | SENSEX only |
| Weekly expiry day | Tuesday | Thursday |
| Monthly expiry day | Last Tuesday | Last Thursday |
| Stock F&O | Monthly, last Tuesday | — |

Every NSE derivative contract — index and stock — settles on Tuesday. Every BSE
derivative contract settles on Thursday. The two exchanges were deliberately
separated onto different days by SEBI so that expiry-day activity is not
concentrated in a single session across the whole market.

## Why only two indices have weeklies

Until November 2024, NSE offered weekly expiries on NIFTY, BANKNIFTY, FINNIFTY,
MIDCPNIFTY and NIFTYNXT50 — an expiry almost every trading day of the week.
BSE offered them on SENSEX, BANKEX and SENSEX 50.

SEBI's November 2024 measures limited each exchange to weekly contracts on
**one** benchmark index. NSE retained NIFTY; BSE retained SENSEX. Everything
else became monthly-only.

The rationale was that a near-daily cycle of expiring short-dated options
concentrated retail activity into the highest-gamma, shortest-dated contracts
available, where outcomes are most path-dependent and least forgiving.

The practical consequence for anyone holding positions: **BANKNIFTY,
FINNIFTY, MIDCPNIFTY and NIFTYNXT50 no longer have weekly options at all.** A
position in those indices is held for weeks, not days, with a correspondingly
different theta and gamma profile. A strategy designed around BANKNIFTY
weeklies does not have an instrument to run on.

## Why the day changed

NSE's expiry sat on Thursday for years. It moved to Tuesday effective September
2025, with BSE simultaneously settling on Thursday. Both exchanges filed their
choices under a SEBI framework requiring fixed, non-overlapping expiry days.

This matters for anything written from memory or from older material: "Thursday
expiry" is a widely repeated fact about the Indian market that is now wrong for
NSE.

## The holiday rule

When an expiry day falls on a trading holiday, expiry moves to the **previous**
trading day — not the next one.

This is easy to get backwards, and getting it backwards means holding a
position that has already settled. A Tuesday holiday moves NSE expiry to
Monday; a Thursday holiday moves BSE expiry to Wednesday.

Long weekends compress the effect further: a Monday-Tuesday holiday pair moves
expiry back to the preceding Friday, shortening the contract by three calendar
days without changing its label.

## What this changes about holding positions

**Theta is not uniform across the week.** A weekly contract loses extrinsic
value fastest in its final sessions. With NIFTY expiring Tuesday, the sharpest
decay now falls on Monday and Tuesday rather than Wednesday and Thursday.

**Gamma concentrates on expiry day**, which is why SEBI attached an additional
2% extreme loss margin to short option positions on that day and withdrew
calendar-spread margin benefit for it. See
`india-market-structure/sebi-derivatives-framework.md`.

**Stock and index expiries coincide on NSE.** Both settle on the last Tuesday,
so the monthly session carries index cash settlement and stock physical
settlement simultaneously. Delivery margins on stock positions begin accruing
four trading days before that date — see
`india-market-structure/physical-settlement.md`.

**Cross-exchange positions settle on different days.** A book holding both
NIFTY and SENSEX exposure has two expiry events per week, on Tuesday and
Thursday.

## Related

- `india-market-structure/sebi-derivatives-framework.md` — the rules that produced this schedule
- `india-market-structure/weekly-vs-monthly.md` — how contract behaviour differs
- `india-market-structure/physical-settlement.md` — what happens to stock contracts at expiry
