---
id: contract-value-and-lot-size
name: Contract Value and Why Lot Sizes Change
category: india-market-structure
tier: beginner
summary: SEBI fixes a notional contract-value band, not a lot size. Lot size is the dependent variable, recalculated as index levels drift — which is why every hardcoded lot size eventually goes stale.
---

# Contract Value and Why Lot Sizes Change

A recurring confusion in Indian derivatives is that lot sizes are a fixed
property of an instrument. They are not. They are a **derived** number,
recalculated by the exchange whenever the underlying's level moves far enough
that the contract's notional value leaves SEBI's prescribed band.

Understanding which variable is fixed and which is derived explains every lot
size revision that has happened and every one that will.

## The relationship

```
contract value  =  lot size  ×  underlying level
```

SEBI fixes **contract value**. The market determines the **underlying level**.
The exchange solves for **lot size**.

Since November 2024, the minimum contract value for index derivatives is
**₹15–20 lakh**, raised from the previous ₹5–10 lakh band.

So when an index rises substantially, its lot size is cut to bring the notional
back within the band. When SEBI revises the band itself, every instrument's lot
size is recalculated at once. Both have happened.

## Why this lesson states no numbers

No lesson in this folder states "one NIFTY lot is N contracts".

Lot sizes have been revised more than once in recent years — first by the
November 2024 band increase, and again as index levels moved. Any figure
written into prose here would be correct for a quarter or two and wrong
thereafter, and wrong in a way that is invisible to a reader who has no reason
to doubt it.

The application handles this correctly already: live lot sizes are read from
the Dhan scrip master, which is the authoritative per-instrument source
([`scrip-master.service.ts`](../../../services/market-data/src/scrip-master/scrip-master.service.ts)).
The Learning UI substitutes the live figure wherever a lesson needs one.

The general principle applies beyond lot sizes: **teach the mechanism, resolve
the number at runtime.** Margins are recomputed daily, statutory rates change
by Finance Act, and expiry dates shift for holidays. Anything that a circular
can change does not belong in prose.

## What changes when a lot size changes

**Notional exposure per lot changes**, which is the point of the exercise. A
position sized in lots carries different exposure before and after a revision.

**Strike steps do not change.** NIFTY strikes remain 50 apart, BANKNIFTY 100.
Spread widths measured in strike steps are unaffected — which is why every
strategy lesson in this folder expresses strikes relatively (`ATM+2`) rather
than as absolute point distances.

**Existing contracts are handled by the circular.** Revisions typically apply
to new contracts from a stated date, with existing far-dated contracts adjusted
on a published schedule. Quarterly and half-yearly contracts have been revised
on different dates from monthlies.

**Margin per lot changes**, since margin scales with notional.

## The practical consequence for sizing

Because lot size falls as the index rises, the notional exposure of one lot is
roughly stable *by design*, within the band. This means:

- Position size in **lots** is not a stable measure of risk across time or
  across instruments.
- Position size in **notional rupees** is.

A book holding "two lots" of two different indices holds two quite different
exposures. A book sized against contract value holds what it intends to. This
is the same argument that `risk/position-sizing.md` makes from the risk side.

## Related

- `india-market-structure/sebi-derivatives-framework.md` — where the band comes from
- `risk/position-sizing.md` — sizing against notional rather than lots or margin
- `india-market-structure/margins.md` — what scales with notional
