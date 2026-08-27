---
type: api
date: 2026-08-19
tags: [api, nse, xbrl, fundamentals, filings, corporate-actions, shareholding]
verified: 2026-08-19 (live probe, RELIANCE)
---

# NSE corporate filings + XBRL fundamentals — verified endpoint catalogue

**Read before building any fundamentals, statements, shareholding, corporate-action
or documents feature.** This is the Phase-1 spike for
[[Plans/2026-08-19 - Company Intelligence Platform (architecture plan)]], and it
settles the question the plan flagged as its biggest unknown: **a complete free
fundamentals path exists.** No key, no account, no vendor.

Extends [[API/2026-08-16 - NSE public data (FII-DII, participant OI, breadth) — what Dhan cannot give you]] —
same host, same three techniques (cookie priming, browser-shaped request with a
matching Referer, `getSetCookie()`), same operational caveats. Read that note
first; only what is *new* is recorded here.

## The headline

Quarterly and annual results, and quarterly shareholding patterns, are published
as **direct XBRL XML URLs** on `nsearchives.nseindia.com`, in the standard
`in-bse-fin` Ind-AS taxonomy, with **absolute rupee values** and periods carried
in `xbrli:context`. That means canonical P&L / Balance Sheet / Cash Flow /
shareholding come from a structured, machine-readable, filer-authored source —
not from scraping a rendered table, and not from a paid vendor.

## Verified endpoints (probed live 2026-08-19, symbol=RELIANCE)

| Probe | Status | What came back |
|---|---|---|
| `/api/corporate-announcements?index=equities&symbol=` | **200** | 3,341 items. `attchmntFile` (PDF), `attchmntText`, `hasXbrl`, `sm_isin`, `smIndustry`, `seq_id`, `sort_date` |
| `/api/corporates-corporateActions?index=equities&symbol=` | **200** | 20 items. `subject` ("Dividend - Rs 6 Per Share"), `exDate`, `recDate`, `bcStartDate`/`bcEndDate`, `faceVal`, `isin`, `series` |
| `/api/corporate-board-meetings?index=equities&symbol=` | **200** | 20 items. `bm_date`, `bm_purpose`, `bm_desc`, `sm_isin`, `sm_indusrty`, `attachment`, `ixbrl` |
| `/api/corporates-financial-results?index=equities&symbol=&period=Quarterly\|Annual` | **200** | 130 quarterly / 39 annual rows. **`xbrl` = direct XML URL.** Plus `consolidated`, `audited`, `fromDate`, `toDate`, `financialYear`, `relatingTo`, `indAs`, `format`, `seqNumber` |
| `/api/corporate-share-holdings-master?index=equities&symbol=` | **200** | 22 quarters. **`xbrl` = direct XML URL.** Plus `date` (quarter end), `pr_and_prgrp`, `public_val`, `employeeTrusts`, `revisedData`, `recordId` |
| `/api/annual-reports?index=equities&symbol=` | **200** | `{data:[…]}` — `fromYr`, `toYr`, `fileName`, `broadcast_dttm` |
| `archives.nseindia.com/content/equities/EQUITY_L.csv` | **200** | **2,554 companies** — SYMBOL, NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, **ISIN NUMBER**, FACE VALUE |
| `/api/quote-equity?symbol=` | **403** | **Access Denied.** More aggressively protected than the filing endpoints |
| `/api/equity-meta-info?symbol=` | **404** | Wrong path — do not retry this spelling |

`EQUITY_L.csv` is the **company universe**: 2,554 rows with ISIN, which is the
join key to `Instrument.isin` and therefore the whole identity spine. One file,
one request, entire market — this is what makes "every company, not just popular
companies" cheap.

## The XBRL, in detail

Results XBRL sample:
`https://nsearchives.nseindia.com/corporate/xbrl/INDAS_117298_1348254_16012025082021.xml`

- Namespace `in-bse-fin:` — a **shared NSE/BSE Ind-AS taxonomy**, not a per-filer
  invention. Tag names are stable and self-describing: `RevenueFromOperations`,
  `ProfitBeforeTax`, `TaxExpense`, `ProfitLossForPeriod`, `FinanceCosts`,
  `DepreciationDepletionAndAmortisationExpense`,
  `BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations`.
  **This makes `ConceptMapping` far more tractable than the plan feared** —
  taxonomy drift is a per-filer *coverage* problem, not a per-filer *dialect* problem.
- **Values are absolute rupees.** `ProfitBeforeTax = 115970000000.00` is ₹11,597 cr.
  There is no crore/lakh/million ambiguity to detect, which removes the single
  most common source of silent 100× errors. Normalisation still records the
  scale, but it is reading a fact rather than inferring one.
- Facts carry a `contextRef`; contexts carry an entity and a period:
  ```xml
  <xbrli:context id="OneD"><xbrli:entity>
    <xbrli:identifier scheme="http://www.nseindia.com/NSESymbol">RELIANCE</xbrli:identifier>
  </xbrli:entity><xbrli:period>
    <xbrli:startDate>2024-10-01</xbrli:startDate><xbrli:endDate>2024-12-31</xbrli:endDate>
  </xbrli:period></xbrli:context>
  ```
  The identifier scheme confirms the NSE symbol inside the document itself — a
  free identity cross-check. **But see the next section before trusting that
  period.**

### ⚠ THE CONTEXT PERIOD IS NOT ALWAYS THE FACT'S PERIOD

The most dangerous thing on this feed, and it is silent.

A quarterly filing carries two dimensionless statement columns. Verified on
RELIANCE's Q3 FY25 filing (`INDAS_117298_1348254_16012025082021.xml`):

| Context | `<xbrli:period>` says | `DateOfStartOfReportingPeriod` fact says | RevenueFromOperations |
|---|---|---|---|
| `OneD` | 2024-10-01 → 2024-12-31 | 2024-10-01 | ₹1,28,260 cr |
| `FourD` | **2024-10-01 → 2024-12-31** | **2024-04-01** | ₹3,96,645 cr |

`FourD`'s declared context period is **wrong**. The column is the nine-month
year-to-date figure — 3,96,645 / 1,28,260 = 3.09, which is nine months over
three — while its `<xbrli:period>` claims the same three months as `OneD`.

**So the authoritative period is the `DateOfStartOfReportingPeriod` /
`DateOfEndOfReportingPeriod` FACTS resolved within each context, not the
context's own `<xbrli:period>`.** A parser that trusts the context — which is
what the XBRL specification would lead you to do, and what an earlier draft of
this note wrongly recommended — stores nine months of revenue and profit as one
quarter. Nothing errors. Every margin still computes. The number is simply ~3×
too big, on every cumulative column of every quarterly filing.

Treat a disagreement between the two as a data-quality finding, prefer the
facts, and never silently accept the context.

Other context notes:
- `ReportingQuarter` ("Third quarter") appears only on the quarter column, which
  is a second way to tell the two apart.
- `NatureOfReportStandaloneConsolidated` is carried per context ("Standalone"),
  so consolidation is asserted inside the document and never has to be inferred
  from the listing row.
- 46 contexts in that one file; only **three are dimensionless** (`OneD`,
  `FourD`, `OneI` for the instant). The rest carry a `dimension=` — segments,
  expense breakdowns, OCI categories. **Facts in dimensioned contexts are
  disaggregations and must not be read as statement lines**; summing them into
  the P&L double-counts.

### The constraint that shapes the UI

| Filing | Tags | Contains |
|---|---|---|
| **Quarterly** results XBRL | 86 distinct | P&L, **segment** revenue/results/assets, EPS, `DebtEquityRatio`. **No balance sheet. No cash flow.** |
| **Annual** results XBRL | 235 distinct | P&L **+ full Balance Sheet** (85 tags: `Assets`, `CurrentAssets`, `NoncurrentAssets`, `Inventories`, `TradeReceivablesCurrent`, `Equity`, `EquityShareCapital`, `OtherEquity`, `DeferredTaxAssetsNet`, …) **+ full Cash Flow** (49 tags: `CashFlowsFromUsedInOperatingActivities`, `PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities`, …) |

**So Balance Sheet and Cash Flow are ANNUAL-only from this source.** The Quarters
tab is rich (P&L + segments, 130 periods deep); the Balance Sheet and Cash Flow
tabs are annual series. Any UI that implies quarterly BS/CF from NSE filings is
claiming a precision the source does not have — show the annual series and say so.
Segment data being present quarterly is a genuine bonus the plan did not assume.

Consolidated and standalone arrive as **separate filings** (`consolidated:
"Consolidated" | "Non-Consolidated"`) — which is exactly the shape the plan's
"never mix them silently" rule wants, and it comes for free rather than needing
inference.

## Gotchas

- **`quote-equity` is 403.** Market cap and shares-outstanding do **not** come from
  this route. `FaceValueOfEquityShareCapital` + `PaidUpValueOfEquityShareCapital`
  in the XBRL give a share count, and `EQUITY_L.csv` carries face value + paid-up
  value; that is the free path to market cap. Verify the derivation against a
  known company before trusting it — do not ship an invented multiplier
  (the current research page's `price * 670` is exactly that mistake).
- **Dates are inconsistent across endpoints, deliberately-looking.** Announcements
  use `18-Aug-2026 20:04:32`; shareholding uses `16-JUL-2026 19:24:44` (**uppercase
  month**); results use `16-Jan-2025 20:20`. Parse per-endpoint; never share one
  date parser across them without a test per format.
- **`industry` is often `"-"`**, not null, on results and shareholding rows.
  `smIndustry` on announcements ("Refineries") and `sm_indusrty` on board meetings
  are populated and are the better sector source. Never coerce `"-"` to a value.
- **`revisedData` / `revisedStatus` on shareholding, `oldNewFlag` on results.**
  Filings get revised. These flags are how you detect a restatement — the plan's
  `restated` column has a real source, so honour it rather than overwriting.
- Announcement `attchmntText` is **company-authored prose**, and
  `bm_desc` on board meetings likewise. Same rule as the 2026-08-16 note: it is
  data, never instruction, and it must not reach a model context unsandboxed.
- The announcements array is **3,341 items for one company with no pagination
  parameter used** — 2.8 MB. Always request with a date window in production, and
  never fan this out across 2,554 companies without a cursor.
- `hasXbrl` on announcements is a **boolean `true`**, while several sibling fields
  are the *strings* `"N"`/`"Y"`. Do not write one truthiness helper for both.

## Operational standing

Same as the 2026-08-16 note and it has not improved: unofficial, undocumented,
unversioned, no SLA, ToS restricts automated access. Mitigations are unchanged —
server-side only, one shared cache, TTL set by how often the source publishes, a
closed named-dataset catalogue rather than caller-supplied URLs, and degrade to
"unavailable" rather than to a substituted number. A data agreement remains the
durable answer. **The 403 on `quote-equity` is the standing reminder that any of
these can be withdrawn without notice** — which is why the ingestion design
persists what it fetches instead of proxying live.

Spike scripts are not committed (throwaway probes); this note is the record.
