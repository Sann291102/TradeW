# `docs/learning/` — Learning Hub Content Source

Authored lesson content for the Learning Hub pillar
([`LEARNING-HUB.md`](../product-architecture/LEARNING-HUB.md)). India-first:
every example, cost figure and expiry reference is NSE/BSE, because that is the
only market TradeW connects to.

## How this relates to the other two knowledge directories

Three directories in this repo hold "knowledge" and they are not
interchangeable. `knowledge-base/README.md` already distinguishes the first
two; this is the third.

| | `knowledge/` | `knowledge-base/` | `docs/learning/` (this folder) |
|---|---|---|---|
| What it is | Obsidian vault, engineering memory | Sentinel's concept ontology | Learning Hub lesson source |
| Audience | Developers and Claude | Sentinel's reasoner | End users, through the Learning UI |
| Unit | A note about the codebase | A YAML concept about markets | A markdown lesson |
| Voice | Whatever is useful | Descriptive, non-directive | Descriptive, non-directive |

A lesson here **explains**; a concept in `knowledge-base/` is what Sentinel
**reasons over**. Most lessons name a `concept:` in their frontmatter, which is
the id of the backing `knowledge-base/` YAML. That link is what
[`LEARNING-HUB.md` §3](../product-architecture/LEARNING-HUB.md) means by
"every lesson traces back to a validated node in the Knowledge Graph".

## The non-directive rule applies here too

[`LEARNING-HUB.md` §6](../product-architecture/LEARNING-HUB.md) — no trade
recommendations, no "this pattern means buy now". These lessons describe what a
structure *is*, what it is exposed to, and how it has behaved. They never
instruct.

In practice that means writing "a bull call spread caps the gain at the short
strike" rather than "use a bull call spread when you are bullish". The first
describes a property; the second issues an instruction. This is the same rule
`knowledge-base/` Rule 2 lints for, applied to prose.

Nothing in this folder is investment advice, and no lesson should be written so
that it could be mistaken for it.

## Layout

```
docs/learning/
  README.md                  ← this file
  TAXONOMY.md                ← the full topic list and its status
  foundations/               ← what options and futures are, contract mechanics
  india-market-structure/    ← NSE/BSE expiry architecture, SEBI rules, costs
  greeks/                    ← first- and second-order sensitivities
  volatility/                ← IV, skew, term structure, IV rank
  strategies/                ← one file per strategy (the bulk of this folder)
    directional/
    vertical-spreads/
    volatility/
    ratio-and-backspread/
    time-spreads/
    synthetic-and-arbitrage/
  equity/                    ← price action, indicators, volume, market profile
  fundamentals/              ← valuation and financial-statement reading
  risk/                      ← sizing, drawdown, expectancy
  psychology/                ← documented behavioural biases
```

## Lesson frontmatter

Every lesson opens with YAML frontmatter. Strategy lessons carry extra fields
that the Learning UI's **Apply** button consumes directly — see below.

```yaml
---
id: bull-call-spread              # kebab-case, unique, matches filename
name: Bull Call Spread
category: vertical-spread
tier: intermediate                # beginner | intermediate | advanced
concept: bull-call-spread         # backing knowledge-base/ concept id, if any
summary: One line, <= 220 chars.
---
```

### Strategy-only fields

`legs` is the contract of record between this folder and the Apply feature.
Strikes are **relative**, never absolute, so one lesson resolves correctly
against NIFTY at 24,800 or a stock at ₹430:

```yaml
legs:
  - action: BUY                   # BUY | SELL
    kind: CE                      # CE | PE | FUT | EQ
    strike: ATM                   # ATM | ATM+n | ATM-n  (n = strike steps)
    ratio: 1                      # relative quantity, in lots
    expiry: near                  # near | next | far
net: debit                        # debit | credit | zero
outlook: moderately-bullish
maxProfit: spread width minus net debit
maxLoss: net debit paid
breakeven: lower strike plus net debit
greeks:
  delta: positive
  theta: mixed
  vega: negative
chartNote: >
  One sentence, shown under the chart after Apply.
```

Relative strikes are the reason the Apply flow can work on any underlying. An
absolute strike would bind a lesson to one instrument at one index level and
break on the next revision — the same rot that hardcoded lot sizes cause.

## Lot sizes, margins and costs are deliberately not hardcoded

No lesson states "one NIFTY lot is N". Lot sizes are revised whenever SEBI's
contract-value band and the index level drift apart — NIFTY has been revised
more than once, and any number written into prose here would be wrong within a
couple of quarters.

Lessons therefore teach the **mechanism** (SEBI targets a ₹15–20 lakh notional
contract value, so lot size falls as the index rises), and the UI substitutes
the live figure from the Dhan scrip master, which is already the app's
authoritative source
([`scrip-master.service.ts`](../../services/market-data/src/scrip-master/scrip-master.service.ts)).

The same rule applies to margins, which are SPAN+exposure and change daily, and
to statutory costs, which change by Finance Act.

## Facts with an expiry date

A few structural facts are stated across many lessons. They were verified
against primary and broker-billing sources on **24 July 2026**. When any of
them changes, they change here in one pass — that is why they are listed
together rather than scattered.

| Fact | Value as verified | Source of truth |
|---|---|---|
| NSE weekly expiry | NIFTY only, Tuesday | NSE circulars |
| BSE weekly expiry | SENSEX only, Thursday | BSE circulars |
| NSE monthly expiry | Last Tuesday | NSE circulars |
| BSE monthly expiry | Last Thursday | BSE circulars |
| Indices without weeklies | BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYNXT50 | SEBI, Nov 2024 |
| Min index contract value | ₹15–20 lakh | SEBI, Nov 2024 |
| Expiry-day short-option ELM | +2% | SEBI, Nov 2024 |
| Calendar-spread margin benefit on expiry day | Withdrawn | SEBI, Feb 2025 |
| Intraday position-limit monitoring | Multiple snapshots per day | SEBI, Apr 2025 |
| STT — futures | 0.05%, sell side | Finance Act, Apr 2026 |
| STT — options sold | 0.15% of premium | Finance Act, Apr 2026 |
| STT — options exercised | 0.15% of intrinsic value | Finance Act, Apr 2026 |
| Stock F&O settlement | Physical, E+2 | SEBI, Apr 2018 |

Holiday rule: when an expiry day is a trading holiday, expiry moves to the
previous trading day.
