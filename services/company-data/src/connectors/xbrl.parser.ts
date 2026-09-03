/**
 * Parser for NSE's Ind-AS results XBRL (`in-bse-fin` taxonomy).
 *
 * ── WHAT IT PRODUCES ───────────────────────────────────────────────────────
 * A filed document is not one statement. A quarterly filing carries a
 * three-month column AND a cumulative year-to-date column; an annual filing
 * carries P&L, balance sheet and cash flow together. So this returns a list of
 * `XbrlColumn`s — one per (period, basis) — each with its facts, and leaves it
 * to the caller to persist them as separate statements.
 *
 * ── THE TWO THINGS THAT MAKE THIS CORRECT ──────────────────────────────────
 *
 * 1. **The period comes from FACTS, not from the context.** Verified
 *    2026-08-19 on RELIANCE's Q3 FY25 filing:
 *
 *      context OneD  : <xbrli:period> 2024-10-01 → 2024-12-31
 *                      DateOfStartOfReportingPeriod = 2024-10-01   ✓ agrees
 *      context FourD : <xbrli:period> 2024-10-01 → 2024-12-31
 *                      DateOfStartOfReportingPeriod = 2024-04-01   ✗ DISAGREES
 *
 *    `FourD` is the nine-month cumulative column — its revenue is ₹3,96,645 cr
 *    against ₹1,28,260 cr for the quarter, which is 3.09×, nine months over
 *    three. Its declared context period is simply wrong. A parser that trusts
 *    the context (which is what the XBRL specification would have you do)
 *    stores nine months of revenue and profit as one quarter. Nothing throws.
 *    Every margin still computes. The number is just ~3× too large, on every
 *    cumulative column of every quarterly filing ever ingested.
 *
 *    So the reporting-period facts win, and a disagreement is REPORTED so the
 *    validators can see how often the source contradicts itself.
 *
 * 2. **Dimensioned contexts are excluded.** 46 contexts in that one file; only
 *    three are dimensionless. The rest carry `dimension=` and hold segment
 *    revenue, expense breakdowns and OCI categories — disaggregations of lines
 *    that are ALREADY in the statement. Summing them in double-counts, and
 *    reading one as a statement line silently reports a single segment's
 *    revenue as the company's.
 *
 * Pure: no network, no database, no clock.
 */

export interface XbrlFact {
  /** Tag without namespace prefix, e.g. `RevenueFromOperations`. */
  tag: string;
  value: number;
}

export interface XbrlColumn {
  contextId: string;
  /** Authoritative, from the reporting-period facts where present. */
  periodStart: Date;
  periodEnd: Date;
  /** True when `<xbrli:period>` disagreed with the facts — a quality signal. */
  contextPeriodDisagreed: boolean;
  /** 'STANDALONE' | 'CONSOLIDATED' | null when the filing did not say. */
  consolidation: 'STANDALONE' | 'CONSOLIDATED' | null;
  auditStatus: string | null;
  facts: XbrlFact[];
}

export interface XbrlDocument {
  symbol: string | null;
  isin: string | null;
  companyName: string | null;
  columns: XbrlColumn[];
  /** Instant contexts (balance-sheet dates) mapped to their facts. */
  instants: { contextId: string; instant: Date; facts: XbrlFact[] }[];
  /** Tags seen in dimensioned contexts, excluded from every column. */
  dimensionedTagCount: number;
}

export class XbrlShapeError extends Error {}

/** Facts that describe the filing rather than the business. */
const META_TAGS = new Set([
  'DateOfStartOfReportingPeriod',
  'DateOfEndOfReportingPeriod',
  'NatureOfReportStandaloneConsolidated',
  'WhetherResultsAreAuditedOrUnaudited',
  'ReportingQuarter',
  'NameOfTheCompany',
  'Symbol',
  'ISIN',
  'ScripCode',
  'MSEISymbol',
  'ClassOfSecurity',
  'DescriptionOfPresentationCurrency',
  'LevelOfRoundingUsedInFinancialStatements',
]);

export function parseXbrl(xml: string): XbrlDocument {
  if (!xml.includes('xbrli:context')) {
    throw new XbrlShapeError('not an XBRL instance document (no xbrli:context found)');
  }

  // ---- Contexts ----
  const durations = new Map<string, { start: Date; end: Date }>();
  const instants = new Map<string, Date>();
  const dimensioned = new Set<string>();

  for (const m of xml.matchAll(/<xbrli:context id="([^"]+)"[^>]*>([\s\S]*?)<\/xbrli:context>/g)) {
    const id = m[1];
    const body = m[2];

    // A context carrying an explicit dimension describes a SLICE (a segment, an
    // expense category), never the statement itself.
    if (/dimension=/.test(body)) {
      dimensioned.add(id);
      continue;
    }

    const instant = body.match(/<xbrli:instant>([^<]+)<\/xbrli:instant>/);
    if (instant) {
      const d = parseIsoDate(instant[1]);
      if (d) instants.set(id, d);
      continue;
    }

    const start = body.match(/<xbrli:startDate>([^<]+)<\/xbrli:startDate>/);
    const end = body.match(/<xbrli:endDate>([^<]+)<\/xbrli:endDate>/);
    if (start && end) {
      const s = parseIsoDate(start[1]);
      const e = parseIsoDate(end[1]);
      if (s && e) durations.set(id, { start: s, end: e });
    }
  }

  // ---- Facts, grouped by context ----
  const byContext = new Map<string, XbrlFact[]>();
  const meta = new Map<string, Map<string, string>>();
  let dimensionedTagCount = 0;

  for (const m of xml.matchAll(/<in-bse-fin:([A-Za-z0-9_]+)\s+contextRef="([^"]+)"[^>]*>([^<]*)<\/in-bse-fin:\1>/g)) {
    const [, tag, contextId, raw] = m;

    if (dimensioned.has(contextId)) {
      dimensionedTagCount += 1;
      continue;
    }

    if (META_TAGS.has(tag)) {
      const bucket = meta.get(contextId) ?? new Map<string, string>();
      bucket.set(tag, raw.trim());
      meta.set(contextId, bucket);
      continue;
    }

    const value = Number(raw.trim());
    // Non-numeric facts are descriptive text (a note, a description). They are
    // not statement lines and must not become 0 — `Number('')` is 0, which is
    // how an absent value becomes a confident zero.
    if (raw.trim() === '' || !Number.isFinite(value)) continue;

    const list = byContext.get(contextId) ?? [];
    list.push({ tag, value });
    byContext.set(contextId, list);
  }

  // ---- Identity, from whichever context carries it ----
  let symbol: string | null = null;
  let isin: string | null = null;
  let companyName: string | null = null;
  for (const bucket of meta.values()) {
    symbol ??= bucket.get('Symbol') ?? null;
    isin ??= bucket.get('ISIN') ?? null;
    companyName ??= bucket.get('NameOfTheCompany') ?? null;
  }

  // ---- Columns ----
  const columns: XbrlColumn[] = [];
  for (const [contextId, period] of durations) {
    const facts = byContext.get(contextId);
    if (!facts || facts.length === 0) continue; // a context nothing reports against

    const bucket = meta.get(contextId);

    // THE CORRECTION. Facts win over the declared context period.
    const factStart = parseIsoDate(bucket?.get('DateOfStartOfReportingPeriod') ?? '');
    const factEnd = parseIsoDate(bucket?.get('DateOfEndOfReportingPeriod') ?? '');

    const periodStart = factStart ?? period.start;
    const periodEnd = factEnd ?? period.end;
    const disagreed =
      (factStart != null && factStart.getTime() !== period.start.getTime()) ||
      (factEnd != null && factEnd.getTime() !== period.end.getTime());

    columns.push({
      contextId,
      periodStart,
      periodEnd,
      contextPeriodDisagreed: disagreed,
      consolidation: normaliseConsolidation(bucket?.get('NatureOfReportStandaloneConsolidated')),
      auditStatus: bucket?.get('WhetherResultsAreAuditedOrUnaudited') ?? null,
      facts,
    });
  }

  const instantColumns = [...instants]
    .map(([contextId, instant]) => ({ contextId, instant, facts: byContext.get(contextId) ?? [] }))
    .filter((c) => c.facts.length > 0);

  if (columns.length === 0 && instantColumns.length === 0) {
    throw new XbrlShapeError('no dimensionless contexts carried any numeric facts');
  }

  return { symbol, isin, companyName, columns, instants: instantColumns, dimensionedTagCount };
}

function normaliseConsolidation(value?: string): 'STANDALONE' | 'CONSOLIDATED' | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  // NSE writes "Standalone" / "Consolidated" in the document, while the listing
  // row spells the same thing "Non-Consolidated" / "Consolidated". Both are
  // accepted; neither is guessed.
  if (v === 'standalone' || v === 'non-consolidated') return 'STANDALONE';
  if (v === 'consolidated') return 'CONSOLIDATED';
  return null;
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  const d = new Date(`${value.trim()}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Reporting frequency from the period LENGTH, never from the document's label.
 *
 * The cumulative column of a Q3 filing still carries `ReportingQuarter = "Third
 * quarter"`, so believing the label would tag nine months as a quarter — the
 * same error the context period invites, arriving by a different door.
 *
 * Windows are generous because filers' period boundaries wobble by a few days
 * (a 92-day quarter, an 89-day quarter, a 366-day year).
 */
export function frequencyFromPeriod(start: Date, end: Date): 'Q' | 'H' | '9M' | 'A' | null {
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days >= 80 && days <= 100) return 'Q';
  if (days >= 170 && days <= 195) return 'H';
  if (days >= 260 && days <= 285) return '9M';
  if (days >= 350 && days <= 380) return 'A';
  return null;
}

/**
 * Indian fiscal year (Apr–Mar), labelled by the calendar year it ends in.
 * A period ending 31-Dec-2024 falls in FY2025; one ending 31-Mar-2025 is FY2025.
 */
export function fiscalYearOf(periodEnd: Date): number {
  const y = periodEnd.getUTCFullYear();
  const m = periodEnd.getUTCMonth(); // 0-based; March = 2
  return m >= 3 ? y + 1 : y;
}

/** Fiscal quarter 1-4 for a 3-month period, else null. */
export function fiscalQuarterOf(periodEnd: Date, frequency: string): number | null {
  if (frequency !== 'Q') return null;
  const m = periodEnd.getUTCMonth();
  // Apr-Jun = Q1, Jul-Sep = Q2, Oct-Dec = Q3, Jan-Mar = Q4
  if (m >= 3 && m <= 5) return 1;
  if (m >= 6 && m <= 8) return 2;
  if (m >= 9 && m <= 11) return 3;
  return 4;
}
