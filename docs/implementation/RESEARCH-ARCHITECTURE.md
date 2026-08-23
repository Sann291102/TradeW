# Research workspace — architecture

How `/research` produces a number, and why it cannot produce one it was not given.

Companion to `RESEARCH-IMPLEMENTATION-NOTE.md` (the pre-build recon) and
`docs/audits/SIDEBAR-FEATURE-REALITY-AUDIT.md` §4.8 (what this replaced).

---

## 1. The rule everything is shaped around

> Never fabricate financial data. If verified data is unavailable, show that it is unavailable.

This is enforced by types, not by discipline. Three mechanisms:

**Absence is an absent key, not a zero.** `StatementPeriod.facts` is a
`Record<string, FinancialFact>`. A line the vendor did not publish has no entry. There is no
"0 means missing" convention anywhere in the subsystem, and the vendor adapter's `num()` helper
maps `null`, `""`, `"-"` and `"None"` to `undefined` — because `Number(null)` is `0`, and that
coercion is precisely how a page ends up reporting that a company earned nothing.

**A section is a discriminated union.**

```ts
type ResearchSection<T> =
  | { available: true;  data: T; provenance: Provenance }
  | { available: false; reason: string };
```

When a section is unavailable there is **no data field**. A component cannot render a value it
was not given, because there is nowhere for one to live.

**Every value carries provenance.** `{ source, sourceTimestamp, fetchedAt }` travels with each
fact, through the cache, to the screen. `sourceTimestamp` is `null` when the vendor publishes
none — stated as "no timestamp published by the source" rather than backfilled with the fetch
time.

---

## 2. Layers

```
Twelve Data  (/profile /statistics /income_statement /balance_sheet /cash_flow /symbol_search)
     │
     ▼  TwelveDataFundamentalsProvider              packages/market-data/…/fundamentals/
FinancialDataProvider  ── the port; resolves-or-throws, never "empty but successful"
     │
     ▼  normalize into one metric vocabulary (INCOME_METRICS / BALANCE_METRICS / CASH_FLOW_METRICS)
ResearchCacheService  (Prisma: ResearchCompany, ResearchStatementFact)
     │
     ▼
ResearchService ──► ratios.ts        (pure — 21 ratios, each with formula + operands)
                └─► reconciliation.ts (pure — Assets = Liabilities + Equity, reported not fixed)
     │
     ▼
ResearchController   AuthGuard on everything; CapabilityGuard('ai_research') on /analysis only
     │
     ▼
apps/web   lib/research/{types,api,format}  →  components/research/*
```

### Why the provider is behind a port
`resolveFinancialDataProvider()` is a **named lookup, not a fallback chain**. If the configured
vendor is unreachable the answer is "fundamental data is unavailable" — not a silent downgrade
to another source. Provenance is a per-value field, so a silent swap would mislabel every figure
on screen. Adding a second vendor costs one file and one `case`.

There is deliberately **no stub or sample provider registered**. Tests inject a fake through the
`FINANCIAL_DATA_PROVIDER` token; no environment variable can put synthetic financials in front
of a user.

---

## 3. Normalization

Vendor field names never escape the adapter. Everything downstream speaks one vocabulary
(`fundamentals.contract.ts`), which is also what makes the cache, the ratio engine, the
reconciliation check and the UI agree on what a line is called.

**Reported vs derived is tracked per fact.** Two derivations exist today:

| Derived value | Formula | Why |
|---|---|---|
| `operating_expenses` | SG&A + R&D | when the vendor publishes only components |
| `free_cash_flow` | `OCF − \|CapEx\|` | when the vendor publishes no FCF line |
| `total_liabilities_and_equity` | liabilities + equity | the identity's right-hand side |

`|CapEx|` and not `+ capex`: issuers file capital expenditure as a negative outflow *or* a
positive cost depending on the filing, and adding a negative would report FCF **above**
operating cash flow — arithmetically tidy, financially impossible. The UI marks derived cells
with a `d` superscript and says so in the table footer.

---

## 4. Ratios

`packages/market-data/src/providers/fundamentals/ratios.ts` — pure, no I/O, fully unit-tested.

Every computed ratio carries `formula`, `inputs` (the exact operands) and `periodEnd`, all
rendered in the UI. A ratio that cannot be computed is **not omitted** — it is returned in
`skipped` with a reason (`"not reported: price, eps"`), because silently dropping it looks
identical to that ratio not existing.

Guards that skip rather than emit:
- any operand missing or non-finite
- a zero denominator
- a sign that makes the result meaningless — negative EPS (P/E), negative equity (P/B, D/E),
  negative EBITDA (EV/EBITDA, net debt/EBITDA)

**No forward-looking ratio is computed.** This system holds no earnings estimates; a "forward"
number derived from trailing data would be a fabrication wearing a forward label. Where the
vendor publishes its own trailing/forward P/E it travels separately on `CompanyStatistics` and
is displayed attributed to the vendor, never merged with ours.

Valuation ratios use a price derived as `marketCap ÷ sharesOutstanding` from the same
statistics payload, so price and market cap describe the same instant. Pairing a live tick with
a vendor market cap would put two mutually inconsistent valuations on one screen.

---

## 5. Reconciliation

`reconcileBalanceSheet()` reports three states and never a fourth:

- **balanced** — within a 50bp tolerance on the comparison (vendors round to thousands/lakhs;
  a rounding residue is not a data-quality problem)
- **not balanced** — the difference in currency and in basis points, with all three reported
  figures returned untouched
- **not checkable** — which side the provider did not publish

The tolerance is on the comparison, never an adjustment to a value. A page that always balances
is either always right or hiding something, and from the outside those look the same.

---

## 6. The cache

Two models, `ResearchCompany` and `ResearchStatementFact`.

**Why durable.** Vendor fundamentals are credit-metered at single-digit requests per minute on
the entry tier; statements change quarterly. A process-local cache would be lost on every deploy
and multiplied by every replica, making upstream cost a function of traffic rather than of
reporting periods.

**Why fully normalized** (one row per metric, not a wide table or a JSON blob): vendors differ in
which lines they publish, so a wide table would be mostly `NULL` and every `NULL` ambiguous
between "not filed" and "zero"; a new line item becomes data rather than a migration; and
`basis` can be per-metric, which is what lets FCF render as derived while revenue beside it is
reported.

**`fiscalQuarter` is `NOT NULL`, with `0` meaning annual.** Postgres treats `NULL`s as *distinct*
in a unique index, so a nullable column here would have permitted unlimited duplicate annual
rows and the cache would have grown a new copy on every refresh. The sentinel is confined to
`ResearchCacheService`; the domain type keeps `fiscalQuarter?: number`.

**A cache hit keeps the original provenance.** `fetchedAt` is when the vendor answered, not when
we replayed it, so the UI's "as of" is the truth about the data's age even when the read never
left the process.

**It is not a fallback.** A miss on an unreachable vendor produces "data unavailable".

Staleness is a read-time decision (`maxAgeMs` passed in), not a TTL sweep. One stale fact makes
the whole statement stale — mixing a refreshed revenue with a months-old net income would
produce a period that never existed in any filing.

---

## 7. Free vs premium

| | Requires |
|---|---|
| Search, overview, income statement, balance sheet, cash flow, ratios, history, ownership, segments | `AuthGuard` only — **every plan, including free** |
| `GET /research/:symbol/analysis` | `AuthGuard` + `CapabilityGuard` + `@RequiresCapability('ai_research')` |

`ai_research` already existed in `packages/types` and is already granted by `tradew_pro`,
`tradew_ultimate` and `enterprise`, so no entitlement plumbing changed. The boundary is enforced
server-side: a 403 from a direct API call, and a "premium feature" card in the UI beside
statements that stay fully readable.

A trader who cannot read a balance sheet cannot do fundamental research at all, which is why the
statements are free.

---

## 8. AI grounding

Three rules, each with a mechanism:

1. **No synthesis without evidence.** `buildEvidence()` runs first. If it produces nothing, the
   endpoint returns `available: false` and says so. A model is never asked to fill a gap.
2. **The prompt contains only retrieved facts.** The evidence block is assembled from cached
   statement values with their periods; the system prompt forbids introducing any figure not in
   it. Absences are included too ("ratios that could NOT be computed"), so the model does not
   reason about missing data as though it were unremarkable.
3. **No scores.** No confidence percentage, no X/10, no outlook verdict, no price target, no
   recommendation. `ResearchAnalysis` has no field for one, and `parseSections()` drops any
   heading outside the seven requested — verified against a model that deliberately returns a
   `Recommendation: BUY with 87% confidence` section.

The evidence list is returned with the prose and rendered beneath it, so a reader can see
exactly what the model was and was not given. Analysis is generated **on request**, not on load:
a summary that appears automatically reads as a property of the company; one produced on demand
reads as what it is.

With no AI key configured the section reports that, and the statements are unaffected.

---

## 9. Unavailable-data behaviour

| Situation | What the user sees |
|---|---|
| No vendor key | "TWELVEDATA_API_KEY is not configured" on each affected section |
| Unknown symbol | `symbol "X" not found` — the page does not load a different company |
| Vendor down | the vendor's own error, per section |
| Line not filed | `not reported` in the cell (words, not a dash — a dash is ambiguous between zero, N/A and unknown) |
| Metric absent from every period | the row is omitted entirely (an empty row across eight columns reads as eight zeros) |
| Ratio inputs missing | the ratio is listed with the missing operand named |
| Fewer than two comparable periods | "Historical financial data unavailable" — no one-point "trend" |
| Ownership / segments | the configured provider is named, with what it does not publish |
| No `ai_research` | upgrade prompt on that card only |

Display scale is chosen from the data's own magnitude: defaulting INR to crore unconditionally
would render a small issuer's ₹1,000 revenue as `0.00` — a real value displayed as nothing,
which is the same defect arriving through formatting instead of through data. Per-share figures
and share counts are never scaled.

---

## 10. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TWELVEDATA_API_KEY` | — | vendor credential; server-side only, never reaches the browser |
| `TWELVEDATA_API_URL` | `https://api.twelvedata.com` | host override (read at call time, not module load) |
| `RESEARCH_FUNDAMENTALS_PROVIDER` | `twelvedata` | provider selection |
| `RESEARCH_STATEMENT_TTL_MS` | 24h | statement cache freshness |
| `RESEARCH_PROFILE_TTL_MS` | 7d | profile cache freshness |
| `RESEARCH_STATISTICS_TTL_MS` | 15m | in-process only; market figures are never persisted, so there is no durable stale price |
| `ANTHROPIC_API_KEY` (or another ai-core provider key) | — | AI synthesis; absent ⇒ that section reports unavailable |

---

## 11. Testing

| Suite | Count | Covers |
|---|---|---|
| `services/api/src/research/research-pipeline.spec.ts` | 29 | vendor normalization through the real provider against a wire-format fixture; ratio arithmetic; skip/guard behaviour; reconciliation; AI response parsing |
| `services/api/src/research/no-fabricated-values.spec.ts` | 18 | the regression gate — the old page's literals, currency literals and numeric fallbacks cannot reappear in the render path |
| `apps/web/src/components/research/research-rendering.test.tsx` | 20 | what reaches the screen: absences, derived markers, accounting negatives, unavailable sections, scale selection |

The fixture (`__fixtures__/twelvedata-fixture.ts`) is a **test double for the vendor**, reachable
only by pointing `TWELVEDATA_API_URL` at it. It describes a fictional issuer and is shaped to
exercise the interesting paths: a balance sheet that reconciles exactly, omitted lines that must
not become zeros, and a vendor-omitted FCF that must be derived and labelled.

The regression gate scans source with comments stripped — the rule is about values the code
*renders*, not values it *discusses*, and several files deliberately quote the old figures so a
reader knows what was removed.
