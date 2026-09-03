---
type: plan
date: 2026-08-19
tags: [plan, market-data, fundamentals, research, screener, sentinel, provenance]
status: proposed — nothing implemented
---

# Company Intelligence Platform — architecture & research plan

Turns `/research` (today: one page, live LTP + a 1d candle chart, everything else
hard-coded) into a real company research terminal covering market data,
fundamentals, statements, shareholding, corporate actions, documents, news,
technicals and a screener — for every listed security, not a popular-nine list.

**Nothing here is implemented.** This is the plan the implementation phases will
execute against.

Related: [[Decisions/2026-07-18 - Market Data domain architecture review]] (the
`Candle` / `CorporateAction` / `OptionMetrics` schema work this builds on),
`docs/product-architecture/MARKET-DATA-ARCHITECTURE.md`,
`docs/product-architecture/DHAN-MARKET-DATA-INTEGRATION.md`, `ARCHITECTURE.md`.

---

## A. Current-state audit

### A.1 What the research page actually is today
`apps/web/src/app/(workspace)/research/page.tsx` (339 lines, one client
component). Real: `useDhanLiveFeed()` LTP/changePct and `useCandles(symbol,'1d',365)`.
Everything else is literal:

- `POPULAR_STOCKS` — nine hard-coded symbols (violates the "every company" goal).
- `price = liveStock?.ltp ?? (symbol === 'RELIANCE' ? 2945.20 : 1500.00)` — a
  fabricated fallback price, and a symbol-specific branch of exactly the shape
  §26 of the brief forbids.
- Market cap = `price * 670` — invented.
- "TradeW AI Summary" (Bullish / 87% confidence / Business Quality 9.2 / Fair
  value ₹2,820) — entirely static JSX. Sector, cap tier, "High Quality",
  fundamentals, peers, shareholding: static.
- Tabs (Overview…Risk Factors) exist as `useState` labels; most render placeholders.

**Consequence for the plan:** the page is not a data-wiring job. It is a rewrite
onto a data layer that does not exist yet. But the *page* is the last phase, not
the first.

### A.2 What exists and is genuinely reusable

| Area | Where | Verdict |
|---|---|---|
| Instrument master (symbol, ISIN, securityId, exchangeSegment, series, `metadataSource`, soft-delete) | `Instrument` model + `services/market-data/src/scrip-master/`, `packages/market-data/src/providers/dhan/dhan-scrip-master.ts` | **Reuse as the company identity spine.** Already ISIN-indexed and provenance-stamped. |
| Latest quote snapshot | `Quote` (1:1 instrument, `source` column) | Reuse for live price / day change. |
| OHLCV history | `Candle` (`@@unique([instrumentId,timeframe,bucketStart])`, `source`) | **Reuse for chart + technicals.** Backfill exists: `services/market-data/scripts/backfill-candles.ts` via Dhan `/charts/historical` + `/charts/intraday`. |
| Pull-provider contract | `MarketDataProvider` in `packages/types/src/market-data.ts`; push contract `MarketFeed`; selection in `packages/market-data/src/registry.ts`; `TokenBucket` rate limiter; `nse-calendar` | **Reuse and extend.** The provider seam already exists — do not build a parallel one. |
| Keyless official-source connector | `services/api/src/nse/nse-datasets.ts` (closed dataset allowlist, no caller-supplied URLs) + `nse.service.ts` (cookie priming, browser-shaped headers, TTL-by-source-change, serve-last-good-on-failure) | **The single most important reusable asset.** Filings/fundamentals ingestion becomes "more entries in this catalogue + parsers", not a new subsystem. |
| Outbound-URL allowlisting | `services/api/src/news/feed-url.ts` | Reuse for document/IR links. |
| News | `services/api/src/news/news.service.ts` — 4 RSS wires, hand-rolled parser, deliberately unclassified; `NewsEvent` model unused; `packages/ai-core/src/news/news-event-classifier.ts` (13-category LLM classifier) written but unwired | Reuse feeds; wire storage + per-company mapping. Classification is a compliance decision, see M. |
| Indicators | `services/sentinel/src/intelligence/indicators.ts` — `ema/rsi/vwap/macd/cpr/averageVolume/swingLevels/realizedVolatilityPct/oiTrend` over `Candle` | **Reuse for the Technicals tab.** Add SMA/ATR/Bollinger here, not in a new module. |
| Background jobs | `services/api/src/common/leader-election.ts` + `JobLease` model + plain `setInterval` under Nest lifecycle hooks (settled repo pattern — `@nestjs/schedule` deliberately not used) | **Reuse verbatim for the ingestion scheduler.** No cron/n8n dependency needed. |
| Observability | `ApiCallLog`, `AiCallLog`, `AgentActivity`, `AgentRun`, `telemetry.service.ts` | Reuse for ingestion metering and quota accounting. |
| LLM providers | `packages/ai-core/src/providers/*` (Anthropic, OpenAI-compatible, Voyage embeddings, tiered fast/balanced/deep, `provider-manager`) | Reuse for the insight layer. |
| Live bridge | `services/market-data/scripts/live-feed-server.ts` — `/quotes /instrument /candles /optionchain*` `/stream` | Reuse; do not extend it with fundamentals (wrong process, see E). |

### A.3 What does not exist at all
No company entity distinct from tradable instrument; no sector/industry
taxonomy; no market cap or shares-outstanding; no financial statements of any
kind; no shareholding; no corporate actions (designed in the 2026-07-18 review,
never migrated); no documents/filings; no per-company news mapping; no
provenance envelope; no data-quality engine; no screener; no ingestion
scheduler; no `/api` route handlers in `apps/web` at all (the web app calls
`services/api` and the feed bridge directly).

---

## B. Gap analysis

| Target capability | Gap | Size |
|---|---|---|
| Company identity (name, sector, industry, ISIN aliases, BSE code) | `Instrument` has ISIN + symbol only; no sector/industry, no company↔listings split | M |
| Market cap / 52w / avg volume | No shares-outstanding; 52w & avg volume derivable from `Candle` | S |
| Chart 1D→max, adjusted | `Candle` exists; multi-timeframe backfill + CA adjustment missing | M |
| P&L / BS / CF / quarters | Nothing | **XL** |
| Ratios | Nothing | L (derived once statements land) |
| Shareholding | Nothing | L |
| Corporate actions | Designed, not built | M |
| Documents | Nothing | M |
| News per company | Market-wide RSS only, no symbol mapping, no storage | M |
| Technicals | Indicator functions exist; no snapshot/persistence/API | S |
| Peers | Nothing (needs sector + ratios) | M |
| Provenance | Nothing (only per-row `source` strings) | L — cross-cutting |
| Validation / quality | Nothing | L |
| Scheduler / incremental ingestion | Leader election exists; no jobs | L |
| Screener | Nothing | L |
| Sentinel snapshots | Sentinel invents its own context | M |

---

## C. Data-source matrix

**Verification status: compiled from the repo's own verified notes
(`nse-datasets.ts` header — NSE endpoints verified live 2026-08-16;
`news.service.ts` — Twelve Data `/news` 404 verified 2026-07-28) plus general
knowledge. Every ⚠️ row must be re-verified by a spike before it is depended on,
and the licensing column needs human review before production.**

| Dataset | Source | Free? | Delay | API? | History | Reliability | License / risk |
|---|---|---|---|---|---|---|---|
| Live quotes, depth | **Dhan WS** (integrated) | With broker acct | Real-time | Yes | n/a | High | Broker ToU; 24h token cap (SEBI) |
| Intraday + daily OHLCV | **Dhan REST** `/charts/*` | Same | EOD/RT | Yes | ~1y daily measured; intraday limited | High | Broker ToU; hard rate caps |
| EOD OHLCV, market-wide | **NSE/BSE bhavcopy archives** (CSV) | Yes, keyless | EOD | File | Deep (years of daily files) | High (static files) | Exchange ToU: informational use; redistribution restricted ⚠️ |
| Security master, ISIN, series | Dhan scrip master (in use) + NSE `EQUITY_L.csv` | Yes | Daily | File | n/a | High | As above |
| FII/DII cash, participant OI, indices, market status, holidays, event calendar | **NSE JSON** (already catalogued & working) | Yes, keyless | EOD/live | Unofficial JSON | Some | Medium — unofficial, unversioned, IP-blockable | No SLA; accepted precedent in this repo |
| Corporate **announcements** | NSE `/api/corporate-announcements`, BSE ⚠️ | Yes, keyless | Near-real-time | Unofficial JSON | Rolling + archives | Medium | Same |
| Corporate **actions** (div/split/bonus/rights) | NSE corporate-actions ⚠️, BSE ⚠️ | Yes | Daily | Unofficial JSON | Yes | Medium | Same |
| **Board meetings** | NSE board-meetings ⚠️ | Yes | Daily | Unofficial JSON | Yes | Medium | Same |
| **Financial results (XBRL)** | NSE/BSE results filings; SEBI LODR mandates XBRL for results & shareholding ⚠️ | Yes | On filing | File (XML) | Since XBRL mandate | Medium-high (structured, filer-authored) | **Backbone of statements. Taxonomy drift across filers is the main engineering risk.** |
| **Shareholding pattern (XBRL)** | NSE/BSE shareholding filings ⚠️ | Yes | Quarterly | File (XML) | Yes | Medium-high | Same |
| **Annual reports / IR decks / transcripts** | Company IR pages + exchange archives | Yes | On publish | No — PDFs | Yes | Low-medium (heterogeneous) | Per-company; store links + hashes, mirror only where clearly permitted ⚠️ |
| Standardised statements + ratios, ready-made | EODHD / FMP / Finnhub / AlphaVantage (India coverage varies) ⚠️ | Free tiers too thin for prod | Varies | Yes | Varies | Medium | **Paid for commercial use** |
| Same, Indian-specialist | Tickertape / Trendlyne / StockEdge / Refinitiv / Bloomberg ⚠️ | No | — | Some | Deep | High | Paid, often expensive |
| Fundamentals via unofficial Yahoo `*.NS` | Unofficial | "Free" | Delayed | Unofficial | Yes | Low-medium | **ToU forbids commercial redistribution — treat as prohibited** |
| **Screener.in** | — | — | — | — | — | — | **Benchmark only. Do not scrape. Not a backend.** |
| News | ET / Moneycontrol RSS (in use) | Yes | Minutes | RSS | No archive | Medium | Headline + link + attribution only; never mirror article bodies |
| Twelve Data | Key present in env | Limited | — | Yes | — | — | `/news` **not on this plan (404, verified 2026-07-28)**; assume fundamentals likewise until proven |

**Bottom line on cost:** a genuinely free v1 is possible for price, corporate
actions, announcements, board meetings, results, shareholding, documents-as-links,
news headlines, technicals, ratios and the screener — because SEBI-mandated XBRL
filings are public and structured. What free sources do *not* give cheaply: deep
pre-XBRL history, cross-company standardisation, and consensus/estimates. Budget
a paid vendor only as a **reconciliation second opinion** and pre-XBRL backfill.

---

## D. Canonical data model

**Reuse/extend:** `Instrument` (add `sectorCode`, `industryCode`, `bseCode`,
`companyId` FK), `Quote`, `Candle`, `NewsEvent`, `JobLease`, `ApiCallLog`.

**New — identity & provenance (Phase 1–2)**
- `Company` — canonical issuer: `id`, `name`, `legalName`, `cin`, `sector`,
  `industry`, `description`, `website`, `irUrl`, `incorporatedOn`, `active`.
- `SecurityListing` — `companyId` → `instrumentId`, `exchange`, `bseCode`,
  `series`, `listedOn`, `isPrimary`. ISIN is the join key across sources.
- `CompanyAlias` — `companyId`, `kind` (name|symbol|isin|bse|former-name), `value`,
  unique on `(kind,value)`. Powers §25 search resolution.
- `DataSource` — `name`, `tier` (1 official / 2 free-provider / 3 secondary),
  `baseUrl`, `licenseNote`, `rateLimitPerMin`, `enabled`.
- `SourceRecord` — **the provenance envelope, one row per fetched artefact**:
  `dataSourceId`, `companyId?`, `kind`, `sourceUrl`, `retrievedAt`, `effectiveAt`,
  `etag`, `lastModified`, `contentHash`, `rawPath?`, `status`. Everything derived
  carries `sourceRecordId`. This is how §19/§33 are answered without bolting
  provenance on later.
- `IngestionJob` / `IngestionCheckpoint` — `jobKey`, `scope`, `cursor`,
  `lastSeenId`, `lastRunAt`, `nextRunAt`, `state`, `error`. Incrementality lives here.

**New — financial core (Phase 3)**
- `FinancialStatement` — period header: `companyId`, `statementType` (PL|BS|CF),
  `consolidation` (STANDALONE|CONSOLIDATED), `frequency` (Q|H|A), `periodStart`,
  `periodEnd`, `fiscalYear`, `fiscalQuarter`, `announcedAt`, `currency`,
  `unitScale`, `restated`, `sourceRecordId`, `reconciliationStatus`. Unique on
  `(companyId, statementType, consolidation, frequency, periodEnd, restated)`.
- `FinancialLineItem` — `statementId`, `conceptKey` (e.g. `revenue.operating`,
  `assets.total`), `value` Decimal(20,4), `rawTag`, `confidence`.
  **Key/value, not 200 columns** — filer taxonomies vary; a wide table would need
  a migration per surprise.
- `FinancialConcept` — canonical chart of accounts: `conceptKey`, `statement`,
  `label`, `parentKey`, `sign`, `isSubtotal`. Drives rendering *and* validation.
- `ConceptMapping` — `dataSourceId`, `rawTag`, `conceptKey`, `scale`, `validFrom`.
  Every normalisation rule is a data row: reviewable and testable.

**New — the rest**
- `Shareholding` (period header) + `ShareholdingEntry` (`category`, `subCategory`,
  `percent`, `shares`, `pledgedPercent`) — Phase 4.
- `CorporateAction` — as specified in the 2026-07-18 review, plus `announcedAt`,
  `recordDate`, `sourceRecordId`, `documentId`.
- `Announcement`, `BoardMeeting`, `Document` (`type`, `period`, `url`, `checksum`,
  `sourceRecordId`, `mirrored`) — Phase 4–5.
- `NewsArticle` (supersedes/absorbs `NewsEvent`): `+ companyIds[]`, `publisher`,
  `dedupeHash`, `category`, `sentiment`, `sentimentModel`, `credibilityTier`.
- `DerivedMetric` — computed values with lineage: `companyId`, `metricKey`
  (`roce`, `pe_ttm`, `debt_equity`, `revenue_cagr_5y`…), `asOf`, `periodRef`,
  `value`, `inputsHash`, `computedAt`, `engineVersion`. **The screener indexes
  this table**; nothing is recomputed at query time.
- `PeerGroup` / `PeerLink` — `basis` (industry|size|manual), `score`.
- `TechnicalSnapshot` — per instrument/timeframe daily indicator set + `candleHash`.
- `DataQualityResult` — `entity`, `entityId`, `check`, `severity`, `passed`,
  `detail`, `observedAt`.
- `SourceConflict` — `conceptKey`, `periodRef`, `valueA/sourceA`, `valueB/sourceB`,
  `resolution`, `resolvedBy`. §21's "never silently pick one".
- `AIInsight` — `companyId`, `section`, `text`, `model`, `promptVersion`,
  `evidenceMetricIds[]`, `generatedAt`. Ungrounded insight is not storable.

**Not new:** market breadth, regime and sector rotation stay derived aggregates
(2026-07-18 decision); depth stays realtime-only.

---

## E. Ingestion architecture

New Nest service **`services/company-data`** (peer of `market-data`), not a module
inside `services/api`. Ingestion is long-running, bursty and failure-prone;
`services/api` is the user-facing latency path; and the repo already separates
ingestion from serving.

```
Tier-1 connectors (NSE/BSE catalogue, XBRL, bhavcopy, IR pages)
Tier-2 connectors (Dhan REST, optional paid vendor)
        ↓ each returns { payload, SourceRecord }
Raw store (SourceRecord + optional content-hashed blob)
        ↓
Normalizer (ConceptMapping → canonical line items / entries)
        ↓
Validator (F/G) → DataQualityResult, SourceConflict
        ↓
Canonical tables (PUBLISHED only when validation passes)
        ↓
Analytics engine → DerivedMetric
        ↓
Company Intelligence API (services/api) → UI / Sentinel / AI
```

**Rules, non-negotiable**
1. Every connector is a **named dataset in an allowlist catalogue**, extending
   `nse-datasets.ts`'s pattern. No caller-supplied URLs anywhere — the SSRF and
   prose-as-instruction arguments in that file's header apply unchanged.
2. Fetched HTML/PDF/announcement prose is **data, never instruction**. It reaches
   a model only through the sandboxed summarisation path (M).
3. Every write is `INSERT … ON CONFLICT` on the natural key; re-running a job is a
   no-op. Idempotent by construction, because it will be re-run.
4. A connector that cannot parse **records the failure and leaves the previous
   value in place**. It never writes a guess (same discipline as `nse.service.ts`).
5. One `TokenBucket` per `DataSource`, enforced centrally, shared across workers.

**Connector inventory (v1):** `dhan-candles`, `nse-bhavcopy`, `nse-equity-list`,
`nse-corporate-announcements`, `nse-corporate-actions`, `nse-board-meetings`,
`nse-financial-results-xbrl`, `nse-shareholding-xbrl`, `bse-mirror` (failover),
`ir-documents`, `rss-news`.

---

## F. Normalization pipeline

1. **Identity resolution** — every artefact resolves to a `Company` via ISIN →
   symbol+exchange → alias. Unresolved artefacts go to a review queue; they are
   never attached to a best-guess company.
2. **Tag mapping** — XBRL tag → `conceptKey` via `ConceptMapping`, versioned by
   `validFrom`. Unmapped tags persist with `conceptKey = null` and raise a quality
   finding, so coverage is measurable instead of silently lossy.
3. **Unit & scale** — everything to ₹ absolute (crore/lakh/million read from the
   filing's own scale attribute, never guessed from magnitude).
4. **Sign convention** — expenses positive-as-cost, outflows negative, per
   `FinancialConcept.sign`. Applied once, at normalisation.
5. **Period canonicalisation** — Indian FY (Apr–Mar) plus filer exceptions;
   `fiscalYear`/`fiscalQuarter` derived from `periodEnd`, never from the label.
6. **Consolidation** — `STANDALONE` and `CONSOLIDATED` are separate rows, always.
   A series never mixes them; the UI picks one and says which (§7).
7. **Restatements** — new rows with `restated=true`; the original is retained
   (Rule 1 — nothing is deleted).
8. **Subtotal derivation** — only when absent from the filing, flagged
   `confidence < 1`, so a derived EBITDA is never shown as a filed figure.

---

## G. Validation system

Runs after normalisation, before publish. Writes `DataQualityResult`; severity
`error` blocks publish, `warn` publishes with a UI flag.

- Balance sheet: `assets.total == liabilities.total + equity.total` within
  tolerance (0.5% or ₹1 cr) → **flag the dataset, never render false confidence** (§9).
- P&L internal consistency: revenue − expenses ≈ operating profit; PBT − tax ≈ PAT.
- Cash flow: `CFO + CFI + CFF ≈ Δcash`.
- Cross-statement: PAT in P&L == PAT opening line of CF.
- Continuity: no missing quarter inside a covered range; no duplicate `periodEnd`.
- Magnitude: >10× QoQ jump in a stable line → warn (usually a scale error).
- Shareholding: category percentages sum to 100 ± 0.1.
- Corporate-action adjustment: post-split candle series has no unexplained gap.
- Staleness: every entity has a max age; exceeded → status `Stale`, never `Live`.
- Cross-source divergence: >1% on the same concept/period → `SourceConflict`, both
  values retained, precedence applied and **recorded**:
  **exchange XBRL > company IR PDF > paid vendor > derived**.

---

## H. Scheduler

`services/company-data` reuses `LeaderElectionService` + `JobLease` + plain
`setInterval` under Nest lifecycle hooks (repo precedent — `@nestjs/schedule`
deliberately unused). A 60s tick dispatches jobs whose `nextRunAt` has passed,
respecting per-source token buckets.

| Job | Cadence | Incremental mechanism |
|---|---|---|
| Live quotes | continuous WS | existing feed |
| Intraday candles | per bar | existing pipeline |
| EOD bhavcopy | 18:30 IST on trading days (`nse-calendar`) | one file per session; skip if `contentHash` seen |
| Announcements | 15 min, market days 08:00–20:00 | `lastSeenId` + `dedupeHash` |
| Corporate actions / board meetings | daily 19:00 | ex-date cursor |
| Results filings | 30 min in results season, daily otherwise | announcement-driven trigger |
| Shareholding | daily, effectively 4×/yr | filing-driven |
| Annual reports / IR | weekly | ETag / Last-Modified / checksum |
| News RSS | 10 min | GUID + `dedupeHash` |
| Derived metrics | event-driven on dependency change (`inputsHash` differs) | never a blanket recompute |
| Technical snapshots | after EOD close | `candleHash` |

**Quota discipline:** nothing recomputes a company whose `inputsHash` is
unchanged; conditional requests everywhere the source supports them; the
whole-market sweep is bhavcopy (one file), never N per-symbol calls.

---

## I. Company Intelligence API (`services/api`, new `company` module)

```
GET  /company/search?q=            → resolved canonical companies (§25)
GET  /company/:id                  → identity + listings + aliases
GET  /company/:id/snapshot         → overview card (price, cap, 52w, health)
GET  /company/:id/chart?tf=&range=&adjusted=
GET  /company/:id/financials?statement=&consolidation=&frequency=&limit=
GET  /company/:id/quarters
GET  /company/:id/ratios?trend=
GET  /company/:id/shareholding
GET  /company/:id/corporate-actions
GET  /company/:id/announcements
GET  /company/:id/documents
GET  /company/:id/news
GET  /company/:id/technicals?tf=
GET  /company/:id/peers
GET  /company/:id/analysis         → AIInsight + the evidence that produced it
GET  /company/:id/quality          → DataQualityResult (admin/debug)
POST /screener/run                 → compound filters over DerivedMetric
```

Every response body is uniformly enveloped:

```ts
type Sourced<T> = {
  value: T | null;
  status: 'live'|'delayed'|'eod'|'filing'|'derived'|'stale'|'unavailable';
  source: { provider: string; url?: string; tier: 1|2|3 };
  retrievedAt: string; effectiveAt?: string;
  periodStart?: string; periodEnd?: string;
  frequency?: 'realtime'|'intraday'|'eod'|'quarterly'|'annual';
  consolidation?: 'standalone'|'consolidated';
  confidence?: number; flags?: string[];
};
```

`value: null` + `status: 'unavailable'` is a first-class answer (§34, §35). No
code path substitutes a number.

## J. Frontend information architecture

Route: `/research/[symbol]` — server-component shell plus per-tab route segments,
so a tab is a real URL with its own fetch. The current single client component
cannot scale to sixteen tabs.

- Shell: identity header, `Sourced` price block, status chip, tab nav.
- Tabs: Overview · Chart · Analysis · Peers · Quarters · P&L · Balance Sheet ·
  Cash Flow · Ratios · Investors · Corporate Actions · News · Technicals ·
  Risk Factors · Documents.
- Shared primitives (new, in `packages/ui`): `<SourcedValue>` (value + freshness
  chip; popover shows source/URL/period/retrievedAt — §33), `<StatementTable>`
  (period columns, consolidation toggle, subtotal styling, derived-value marker),
  `<UnavailablePanel>` ("Data unavailable from configured sources" — never an
  empty-looking zero), `<QualityFlag>`.
- Loading: existing `CandleLoader`. Errors: per-panel, never whole-page.
- Design language unchanged — TradeW-native, not a Screener clone.

## K. Screener

Executes against `DerivedMetric` only. Request is a typed AST
(`{op:'and', clauses:[{metric:'roe', cmp:'>', value:15}, …]}`) compiled to
parameterised SQL — **never** string-concatenated user input. Backed by a
materialised `screener_facts` view (one row per company × latest metric set),
refreshed when `DerivedMetric` changes. Results carry `asOf` per metric, so a
screen states the vintage of what it filtered on.

## L. Sentinel integration

Sentinel stops deriving company context of its own. `services/api` exposes
read-only snapshot contracts consumed via the existing service-token boundary
(ARCHITECTURE.md §9 — Sentinel is never called directly by the browser, and
TradeW AI never calls Sentinel directly):

`CompanySnapshot`, `MarketSnapshot`, `FundamentalSnapshot`, `QuarterlyTrend`,
`BalanceSheetSnapshot`, `CashFlowSnapshot`, `RatioSnapshot`,
`ShareholdingSnapshot`, `NewsSnapshot`, `TechnicalSnapshot`,
`CorporateActionSnapshot`, `RiskSnapshot` — each a `Sourced<>` payload.

`TechnicalSnapshot` is built from `services/sentinel/src/intelligence/indicators.ts`,
shared rather than duplicated. **Unchanged constraint:** Sentinel remains
observation/education only — no Buy/Sell/Entry/Target, never a gate in the order
flow (CLAUDE.md Rule 2). Richer fundamental context does not relax that.

## M. AI insight architecture

The model receives **only** a structured evidence bundle — `DerivedMetric` rows
with their periods and provenance — never raw filings, never scraped HTML, never
announcement prose. Prompt contract:

- Input: metric key, value, period, unit, YoY/CAGR, peer median, `sourceRecordId`.
- Output: JSON `{ claims: [{ text, metricRefs[] }] }`. A claim citing no metric is
  **rejected in code**, not merely discouraged.
- Rendered text links each claim to its numbers; `AIInsight.evidenceMetricIds`
  makes it auditable afterwards.
- Prohibited by construction: inventing results, shareholding, announcements or
  actions; inferring missing accounting values; describing stale data as live.
- News summarisation is the one place model-facing third-party prose exists: an
  isolated call whose output is treated as untrusted text and stored alongside —
  never replacing — the original headline, publisher and URL.
- `news-event-classifier.ts` may be wired here, but classification asserting what
  a headline *means for an instrument* keeps its compliance gate (the stated
  reason it is currently unwired).

## N. Caching

| Layer | TTL | Note |
|---|---|---|
| Company identity | 24h | rarely changes |
| Snapshot / quote | 5s live, 60s delayed | never cached past its freshness label |
| Statements, shareholding, corporate actions | **immutable once published** — key on `(entityId, updatedAt)` | never re-fetched |
| Ratios / derived | invalidate on `inputsHash` change | |
| News | 5 min | |
| Document metadata | 1h | |
| Screener results | 15 min per query hash | |

In-process first (matching `nse.service.ts`), Redis when multi-instance —
`QuoteCache` in `packages/market-data/src/contracts/cache.ts` was written to make
that swap a configuration change.

## O. Provider failover

Ordered provider chain per dataset; each attempt records its own `SourceRecord`.
On A's failure, B's value is used **only if** its `effectiveAt` is inside the
dataset's freshness window; otherwise the response is `status:'stale'` with the
last-good value and its real timestamp. Serving stale data labelled live is the
failure mode this design most explicitly forbids. Repeated failures open a
per-source circuit breaker and raise an ops notification.

## P. Cost projection

- Live/intraday/EOD prices, corporate actions, announcements, board meetings,
  results, shareholding, documents-as-links, news headlines, technicals, ratios,
  screener → **₹0 incremental** (existing Dhan relationship + free exchange
  publications). Cost is compute and storage, not data.
- Volume: ~2,000 actively-covered NSE companies. Bhavcopy = 1 file/day.
  Announcements ≈ 44 polls/day. Results ≈ 50/day off-season, ~500/day in season.
  Shareholding ≈ 2,000 filings × 4/yr. All well inside polite unofficial-endpoint use.
- Storage: statements ≈ 2,000 × 40 periods × ~120 line items ≈ 10M rows — trivial.
  Candles dominate (already understood in the 2026-07-18 review).
- LLM: insights cached per `inputsHash`; regeneration only on new filings —
  ~2,000 × ~6/yr ≈ 12k deep calls/yr. Small.
- **Paid, optional, later:** a fundamentals vendor as reconciliation second opinion
  and pre-XBRL backfill. Scope after v1 shows where free data is thin.

## Q. Security

- Credentials only in env, guarded at boot (existing `JWT_SECRET` guard precedent;
  **no `|| 'dev-secret'` fallbacks, ever**).
- `services/company-data` binds localhost by default like the other internal
  services; ingestion trigger endpoints are service-token-guarded and admin-only.
- No caller-supplied URLs (the SSRF argument from `nse-datasets.ts`).
- Documents: store links + checksums; mirror bytes only where licensing clearly
  permits; PDFs are never parsed into a model context unsandboxed.
- Screener AST → parameterised SQL only.
- Third-party text (announcements, news, filings) is quarantined as data; the
  instruction-source boundary is enforced at the ingestion edge, not in prompts.
- Rate limits + `ApiCallLog` on every outbound source call — politeness and abuse
  detection both.

## R. Data provenance

`SourceRecord` is written **before** any derived row exists; every canonical row
carries `sourceRecordId`; every `DerivedMetric` carries `inputsHash` over its
inputs. Any number on screen therefore traces:
`SourcedValue → DerivedMetric → FinancialLineItem → FinancialStatement →
SourceRecord → sourceUrl + retrievedAt + contentHash`. That chain is what makes
"Source: NSE filing · Retrieved 2 hours ago" true rather than decorative.

## S. Testing strategy

- **Unit:** concept mapping, unit/scale, FY derivation, sign conventions,
  indicator math against known series, screener AST → SQL.
- **Fixture-driven ingestion:** committed real XBRL/bhavcopy/RSS samples (marked
  fixtures, per §34) — parsers tested offline, never against the live source in CI.
- **Reconciliation:** golden datasets for companies whose filed statements are
  hand-verified; BS identity and cross-statement checks assert.
- **Provider failure:** timeouts, 403 (NSE's known behaviour), malformed XBRL,
  partial pages, unexpected schema → assert *no write* and a recorded fault.
- **Contract:** `Sourced<>` envelope across every endpoint; Sentinel snapshot
  contracts (extend the existing `contract-alignment.spec.ts` pattern).
- **Frontend:** unavailable/stale/conflict states render as such; no component may
  display a bare number without freshness metadata (lint rule + test).
- **E2E:** one company with complete data, one partial, one with none.

---

## T. Implementation phases

Each phase ends with: what changed, why, files touched, remaining work, risks
(Rule 3). Nothing is deleted; superseded code goes to `archive/` (Rule 1).

**Phase 1 — Data foundation.** `DataSource`, `SourceRecord`, `IngestionJob`,
`IngestionCheckpoint`, `DataQualityResult`; `services/company-data` skeleton with
leader election + token buckets; connector-catalogue module generalised from
`nse-datasets.ts`. No user-visible change. *Done when* a no-op job runs on a lease,
writes a `SourceRecord`, and is idempotent across restarts.

**Phase 2 — Market & company identity.** `Company`, `SecurityListing`,
`CompanyAlias`; sector/industry taxonomy; shares-outstanding; bhavcopy +
equity-list connectors; multi-timeframe candle backfill; `/company/search`,
`/company/:id`, `/snapshot`. *Done when* any listed NSE symbol resolves to one
canonical company with a real market cap and 52w range, and the nine hard-coded
symbols are gone.

**Phase 3 — Financial statements.** `FinancialStatement`, `FinancialLineItem`,
`FinancialConcept`, `ConceptMapping`; XBRL results connector; normalizer;
BS/P&L/CF validators. **Highest-risk phase** (taxonomy drift). *Done when* ≥20
hand-verified companies reconcile and non-reconciling datasets are flagged rather
than shown.

**Phase 4 — Shareholding & corporate actions.** `Shareholding*`,
`CorporateAction`, `Announcement`, `BoardMeeting`; CA-adjusted candle series.
*Done when* categories sum to 100% and a known split shows no unexplained gap.

**Phase 5 — News & documents.** `NewsArticle` (absorbing `NewsEvent`), per-company
mapping, dedupe; `Document` repository with checksums. *Done when* a company's news
is genuinely its own and every document opens at its real source.

**Phase 6 — Analytics, ratios, technicals, peers.** `DerivedMetric`,
`TechnicalSnapshot`, `PeerGroup`; indicator functions shared out of Sentinel.
*Done when* every ratio is reproducible from stored inputs and no threshold label
is undocumented.

**Phase 7 — Company research UI.** `/research/[symbol]` rewrite, all tabs,
`<SourcedValue>` / `<StatementTable>` / `<UnavailablePanel>`. Old page → `archive/`.
*Done when* no rendered number lacks provenance and no fabricated fallback exists.

**Phase 8 — Screener.** AST, compiler, `screener_facts`, UI.
**Phase 9 — Sentinel integration.** The twelve snapshot contracts; Sentinel's ad-hoc
company context removed; Rule 2 boundary re-asserted in tests.
**Phase 10 — Daily autonomous ingestion.** Full schedule from H; season-aware
results polling; quota accounting.
**Phase 11 — Data quality & observability.** Quality dashboard, `SourceConflict`
review queue, coverage metrics, freshness SLOs, alerting.
**Phase 12 — Production hardening.** Partitioning, Redis, circuit breakers,
licensing sign-off, load testing, runbook.

---

## Final answers

1. **Obtainable today:** live + historical OHLCV (Dhan, integrated), market-wide
   EOD bhavcopy, security master/ISIN, FII/DII + participant OI + indices +
   holidays (already working), corporate announcements/actions/board meetings,
   SEBI-mandated XBRL results and shareholding filings, IR documents as links,
   news headlines via RSS, and everything derivable from those (ratios, technicals,
   peers, screener).
2. **Genuinely free:** NSE/BSE public publications and archives, XBRL filings, IR
   pages, RSS feeds. Free-with-broker-account: Dhan quotes/candles/chain.
3. **Delayed or limited:** FII/DII and participant OI are EOD-only and describe the
   *previous* session (no intraday figure exists anywhere); bhavcopy is EOD; Dhan
   REST has hard rate caps and ~1y of daily history measured; unofficial NSE JSON
   has no SLA and can block an IP without notice.
4. **Needs paid licensing for production:** standardised cross-company fundamentals
   with deep pre-XBRL history, consensus/estimates, and any redistribution of
   exchange data beyond informational display. Yahoo-style unofficial fundamentals
   are treated as **prohibited** for commercial use. Screener.in is a benchmark,
   never a backend.
5. **Buildable with no paid data:** the entire product described in the brief, with
   two honest caveats — statement history limited to the XBRL era, and no analyst
   estimates.
6. **Reuse:** `Instrument`/`Quote`/`Candle`; `nse-datasets.ts` + `nse.service.ts`
   (catalogue + cookie priming + TTL-by-source + serve-last-good); `feed-url.ts`;
   `packages/market-data` provider/feed contracts, registry, token bucket,
   nse-calendar; Sentinel `indicators.ts`; `LeaderElectionService` + `JobLease`;
   `ai-core` providers; `CandleLoader`; `ApiCallLog`/telemetry.
7. **Redesign:** the research page (single client component → route segments);
   `NewsEvent` (absorbed into `NewsArticle` with company mapping); the implicit
   "source is a string column" model (→ `SourceRecord`); Sentinel's self-derived
   company context (→ snapshot contracts).
8. **Daily updates:** leader-elected job dispatcher in `services/company-data`,
   per-dataset cadence, incrementality via ETag / Last-Modified / content hash /
   `lastSeenId` / period cursors, and event-driven recompute keyed on `inputsHash`
   — a company whose inputs did not change is never reprocessed.
9. **Preventing fake or stale data:** no fabricated fallbacks anywhere (the
   `RELIANCE ? 2945.20 : 1500.00` pattern is deleted, not moved); every value
   carries status + timestamp; unavailable is a rendered state; validation gates
   publish; conflicts store both values under a documented precedence rule; the AI
   receives only verified metrics and any uncited claim is rejected in code.
10. **Sentinel:** consumes the twelve `Sourced<>` snapshot contracts through
    `services/api`'s existing service-token boundary, sharing the indicator engine
    rather than duplicating it — and remains observation/education only.
