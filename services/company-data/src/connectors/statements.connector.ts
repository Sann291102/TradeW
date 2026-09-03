import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SourceFetcherService } from '../ingestion/source-fetcher.service';
import { FILING_DATASETS } from '../catalogue/filing-datasets';
import {
  CONCEPTS,
  EXCLUDED_TAGS,
  inferStatement,
  SOURCE_VOCABULARY,
  TAG_TO_CONCEPT,
  TAG_TO_STATEMENT,
} from './concept-seed';
import {
  fiscalQuarterOf,
  fiscalYearOf,
  frequencyFromPeriod,
  parseXbrl,
  XbrlColumn,
} from './xbrl.parser';

/**
 * Ingests filed financial statements from NSE's results XBRL.
 *
 * ── THE SHAPE OF THE WORK ──────────────────────────────────────────────────
 *   listing endpoint  → rows, each carrying an `xbrl` document URL
 *   document          → columns (quarter, cumulative) and instants (BS dates)
 *   column            → one FinancialStatement per statement type present
 *   facts             → FinancialLineItem, mapped or explicitly unmapped
 *   statement         → validated, then marked passed/failed
 *
 * Two steps rather than one because the listing is small and pollable while the
 * documents are large and immutable once published — so the listing is re-read
 * often and a document is fetched exactly once.
 *
 * ── WHAT IS NEVER GUESSED ──────────────────────────────────────────────────
 * Period comes from the reporting-period facts (see xbrl.parser for why the
 * context cannot be trusted). Consolidation comes from the filing. Frequency
 * comes from the period length. Audit status comes from the filing. If the
 * frequency cannot be classified, the column is SKIPPED and recorded rather
 * than filed under a guess — an unclassifiable period is nearly always a
 * filer's own irregularity, and inventing a label for it would put a 47-day
 * stub in a quarterly series.
 */

const TOLERANCE_RELATIVE = 0.005; // 0.5%
const TOLERANCE_ABSOLUTE = 10_000_000; // ₹1 crore

export interface StatementSyncResult {
  symbol: string;
  filingsSeen: number;
  filingsIngested: number;
  statementsWritten: number;
  lineItemsWritten: number;
  unmappedTags: number;
  reconciliationFailures: number;
  skippedColumns: number;
}

interface FilingRow {
  xbrl?: string;
  consolidated?: string;
  audited?: string;
  broadCastDate?: string;
  filingDate?: string;
  toDate?: string;
  fromDate?: string;
  period?: string;
  isin?: string;
}

@Injectable()
export class StatementsConnector {
  private readonly logger = new Logger(StatementsConnector.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fetcher: SourceFetcherService,
  ) {}

  /**
   * Ensure the chart of accounts and its mappings exist.
   *
   * Idempotent, and called before ingestion rather than in a migration: these
   * are reference data that evolve with the parser, and keeping them beside the
   * code that uses them means a new mapping ships as one change rather than two.
   */
  async ensureConcepts(): Promise<{ concepts: number; mappings: number }> {
    await this.prisma.financialConcept.createMany({
      data: CONCEPTS.map((c) => ({
        conceptKey: c.conceptKey,
        statement: c.statement,
        label: c.label,
        parentKey: c.parentKey ?? null,
        sign: c.sign ?? 1,
        isSubtotal: c.isSubtotal ?? false,
        ordinal: c.ordinal,
      })),
      skipDuplicates: true,
    });

    const existing = await this.prisma.conceptMapping.findMany({
      where: { sourceVocabulary: SOURCE_VOCABULARY },
      select: { rawTag: true },
    });
    const have = new Set(existing.map((m) => m.rawTag));

    const rows = CONCEPTS.flatMap((c) =>
      c.tags.filter((t) => !have.has(t)).map((t) => ({
        sourceVocabulary: SOURCE_VOCABULARY,
        rawTag: t,
        conceptKey: c.conceptKey,
        scale: 0, // NSE Ind-AS XBRL publishes absolute rupees
      })),
    );
    if (rows.length > 0) await this.prisma.conceptMapping.createMany({ data: rows, skipDuplicates: true });

    return { concepts: CONCEPTS.length, mappings: rows.length };
  }

  /** Ingest one company's filings for one period type. */
  async syncCompany(symbol: string, period: 'Quarterly' | 'Annual', limit = 8): Promise<StatementSyncResult> {
    const result: StatementSyncResult = {
      symbol,
      filingsSeen: 0,
      filingsIngested: 0,
      statementsWritten: 0,
      lineItemsWritten: 0,
      unmappedTags: 0,
      reconciliationFailures: 0,
      skippedColumns: 0,
    };

    // Two catalogue entries rather than a period argument: the caller names a
    // dataset and never composes a URL, which is the guarantee the whole
    // catalogue exists to provide.
    const listing = await this.fetcher.fetchDataset({
      dataset: FILING_DATASETS[period === 'Annual' ? 'nse.financial-results-annual' : 'nse.financial-results'],
      scope: symbol,
    });

    if (listing.status !== 'ok' || !listing.body) return result;

    let rows: FilingRow[];
    try {
      rows = JSON.parse(listing.body) as FilingRow[];
    } catch {
      this.logger.warn(`${symbol}: results listing was not JSON`);
      return result;
    }

    const company = await this.resolveCompany(symbol);
    if (!company) {
      this.logger.warn(`${symbol}: no company record — run the equity-list job first`);
      return result;
    }

    const withDocs = rows.filter((r) => r.xbrl).slice(0, limit);
    result.filingsSeen = withDocs.length;

    for (const row of withDocs) {
      try {
        const ingested = await this.ingestFiling(company.id, symbol, row);
        result.filingsIngested += ingested.statements > 0 ? 1 : 0;
        result.statementsWritten += ingested.statements;
        result.lineItemsWritten += ingested.lineItems;
        result.unmappedTags += ingested.unmapped;
        result.reconciliationFailures += ingested.failures;
        result.skippedColumns += ingested.skipped;
      } catch (err) {
        this.logger.warn(`${symbol} ${row.toDate}: ${(err as Error).message}`);
      }
    }

    return result;
  }

  private async resolveCompany(symbol: string) {
    const alias = await this.prisma.companyAlias.findUnique({
      where: { kind_normalized: { kind: 'symbol', normalized: symbol.toUpperCase() } },
      select: { companyId: true },
    });
    return alias ? { id: alias.companyId } : null;
  }

  private async ingestFiling(companyId: string, symbol: string, row: FilingRow) {
    const out = { statements: 0, lineItems: 0, unmapped: 0, failures: 0, skipped: 0 };

    const doc = await this.fetcher.fetchDocument({
      url: row.xbrl!,
      datasetKey: 'nse.financial-results.xbrl',
      subjectSymbol: symbol,
      subjectIsin: row.isin,
    });
    if (doc.status !== 'ok' || !doc.body) return out;

    const parsed = parseXbrl(doc.body);

    // Identity cross-check. The document names its own symbol, so a mismatch
    // means the listing pointed at another company's filing — rare, but the
    // consequence (one company's revenue filed under another's name) is bad
    // enough that it is worth one string comparison.
    if (parsed.symbol && parsed.symbol.toUpperCase() !== symbol.toUpperCase()) {
      await this.recordQuality(companyId, 'FinancialStatement', 'filing.symbol-mismatch', 'error', {
        expected: symbol,
        documentSays: parsed.symbol,
        url: row.xbrl,
      }, doc.sourceRecordId);
      return out;
    }

    const announcedAt = parseNseTimestamp(row.broadCastDate ?? row.filingDate);

    // Duration columns carry flows — the P&L and the cash-flow statement.
    for (const column of parsed.columns) {
      const written = await this.ingestColumn(companyId, column, announcedAt, doc.sourceRecordId, row);
      out.statements += written.statements;
      out.lineItems += written.lineItems;
      out.unmapped += written.unmapped;
      out.failures += written.failures;
      out.skipped += written.skipped;
    }

    // A BALANCE SHEET IS A POINT IN TIME, NOT A PERIOD, and it gets its own
    // path for exactly that reason.
    //
    // The first version attached instant facts to whichever duration column
    // ended on the same day. In a half-yearly filing the instant 2024-09-30
    // ends BOTH the quarter (Jul-Sep) and the half (Apr-Sep), so one balance
    // sheet was written twice — once as `BS Q`, once as `BS H` — two identical
    // snapshots differing only in a frequency label that means nothing for a
    // balance sheet. Any later "assets by quarter" series would have counted
    // the same snapshot twice and shown a step change that never happened.
    //
    // Consolidation comes from the document's own columns: a filing is one
    // basis throughout, and NSE serves the two bases as separate documents.
    const documentBasis =
      parsed.columns.find((c) => c.consolidation)?.consolidation ??
      (row.consolidated === 'Consolidated' ? 'CONSOLIDATED' : 'STANDALONE');

    for (const instant of parsed.instants) {
      const written = await this.ingestInstant(
        companyId,
        instant,
        documentBasis,
        parsed.columns[0]?.auditStatus ?? row.audited ?? null,
        announcedAt,
        doc.sourceRecordId,
      );
      out.statements += written.statements;
      out.lineItems += written.lineItems;
      out.unmapped += written.unmapped;
      out.failures += written.failures;
    }

    return out;
  }

  private async ingestColumn(
    companyId: string,
    column: XbrlColumn,
    announcedAt: Date | null,
    sourceRecordId: string,
    row: FilingRow,
  ) {
    const out: { statements: number; lineItems: number; unmapped: number; failures: number; skipped: number; excludedTags?: number } =
      { statements: 0, lineItems: 0, unmapped: 0, failures: 0, skipped: 0 };

    const frequency = frequencyFromPeriod(column.periodStart, column.periodEnd);
    if (!frequency) {
      // Filed under a guess, a 47-day stub would sit in a quarterly series and
      // be charted as a quarter. Recorded and skipped instead.
      out.skipped += 1;
      await this.recordQuality(companyId, 'FinancialStatement', 'filing.unclassifiable-period', 'warn', {
        periodStart: column.periodStart.toISOString(),
        periodEnd: column.periodEnd.toISOString(),
      }, sourceRecordId);
      return out;
    }

    if (column.contextPeriodDisagreed) {
      // Not a failure — the facts are authoritative and were used. Recorded so
      // the frequency of the source contradicting itself is measurable.
      await this.recordQuality(companyId, 'FinancialStatement', 'xbrl.context-period-disagrees', 'info', {
        contextId: column.contextId,
        usedPeriod: `${column.periodStart.toISOString().slice(0, 10)}..${column.periodEnd.toISOString().slice(0, 10)}`,
      }, sourceRecordId);
    }

    const consolidation =
      column.consolidation ?? (row.consolidated === 'Consolidated' ? 'CONSOLIDATED' : 'STANDALONE');

    // Facts fall into statements by concept. Anything unmapped defaults to the
    // P&L bucket, where it is stored with a null concept and counted — never
    // silently dropped, and never allowed to affect a subtotal.
    const buckets = new Map<'PL' | 'BS' | 'CF', { tag: string; value: number }[]>();
    let excluded = 0;
    for (const fact of column.facts) {
      // Disaggregations of lines already present. In an annual filing several
      // segment tags appear in a plain context with no dimension, so nothing
      // structural separates SegmentRevenue from RevenueFromOperations.
      if (EXCLUDED_TAGS.has(fact.tag)) {
        excluded += 1;
        continue;
      }
      // An unmapped tag is routed by pattern, not defaulted to the P&L. The
      // default put ~40 cash-flow lines per annual filing inside the profit and
      // loss statement.
      const statement = TAG_TO_STATEMENT.get(fact.tag) ?? inferStatement(fact.tag);
      const list = buckets.get(statement) ?? [];
      list.push(fact);
      buckets.set(statement, list);
    }
    if (excluded > 0) out.excludedTags = (out.excludedTags ?? 0) + excluded;

    for (const [statementType, facts] of buckets) {
      if (facts.length === 0) continue;
      // A duration context cannot describe a balance sheet. If a filer tags a
      // BS concept against a period, that is their error and it is dropped
      // rather than filed as a snapshot that never existed.
      if (statementType === 'BS') continue;

      const statement = await this.prisma.financialStatement.upsert({
        where: {
          companyId_statementType_consolidation_frequency_periodEnd_restated: {
            companyId,
            statementType,
            consolidation,
            frequency,
            periodEnd: column.periodEnd,
            restated: false,
          },
        },
        update: { announcedAt, auditStatus: column.auditStatus ?? row.audited ?? null, sourceRecordId },
        create: {
          companyId,
          statementType,
          consolidation,
          frequency,
          periodStart: column.periodStart,
          periodEnd: column.periodEnd,
          fiscalYear: fiscalYearOf(column.periodEnd),
          fiscalQuarter: fiscalQuarterOf(column.periodEnd, frequency),
          announcedAt,
          auditStatus: column.auditStatus ?? row.audited ?? null,
          sourceRecordId,
        },
      });
      out.statements += 1;

      const items = facts.map((f) => {
        const conceptKey = TAG_TO_CONCEPT.get(f.tag) ?? null;
        if (!conceptKey) out.unmapped += 1;
        return { statementId: statement.id, conceptKey, rawTag: f.tag, value: f.value, confidence: 1 };
      });

      const { count } = await this.prisma.financialLineItem.createMany({ data: items, skipDuplicates: true });
      out.lineItems += count;

      const verdict = await this.validate(statement.id, statementType, companyId, sourceRecordId);
      if (verdict === 'failed') out.failures += 1;
    }

    return out;
  }

  /**
   * One balance sheet, at one instant, on one basis.
   *
   * `frequency` is 'PIT' — point in time — and periodStart equals periodEnd.
   * That keeps the unique key meaningful (one snapshot per company, basis and
   * date) without pretending a balance sheet covers a span.
   */
  private async ingestInstant(
    companyId: string,
    instant: { instant: Date; facts: { tag: string; value: number }[] },
    consolidation: string,
    auditStatus: string | null,
    announcedAt: Date | null,
    sourceRecordId: string,
  ) {
    const out = { statements: 0, lineItems: 0, unmapped: 0, failures: 0 };

    // Only genuine balance-sheet concepts. An instant context can also carry
    // stray facts; anything not mapped to a BS concept is left out rather than
    // padding a balance sheet with unrelated numbers.
    const facts = instant.facts.filter(
      (f) => !EXCLUDED_TAGS.has(f.tag) && (TAG_TO_STATEMENT.get(f.tag) ?? inferStatement(f.tag)) === 'BS',
    );
    if (facts.length === 0) return out;

    const statement = await this.prisma.financialStatement.upsert({
      where: {
        companyId_statementType_consolidation_frequency_periodEnd_restated: {
          companyId,
          statementType: 'BS',
          consolidation,
          frequency: 'PIT',
          periodEnd: instant.instant,
          restated: false,
        },
      },
      update: { announcedAt, auditStatus, sourceRecordId },
      create: {
        companyId,
        statementType: 'BS',
        consolidation,
        frequency: 'PIT',
        periodStart: instant.instant,
        periodEnd: instant.instant,
        fiscalYear: fiscalYearOf(instant.instant),
        fiscalQuarter: null,
        announcedAt,
        auditStatus,
        sourceRecordId,
      },
    });
    out.statements += 1;

    const items = facts.map((f) => {
      const conceptKey = TAG_TO_CONCEPT.get(f.tag) ?? null;
      if (!conceptKey) out.unmapped += 1;
      return { statementId: statement.id, conceptKey, rawTag: f.tag, value: f.value, confidence: 1 };
    });
    const { count } = await this.prisma.financialLineItem.createMany({ data: items, skipDuplicates: true });
    out.lineItems += count;

    if ((await this.validate(statement.id, 'BS', companyId, sourceRecordId)) === 'failed') out.failures += 1;

    return out;
  }

  /**
   * Validate a statement and record the verdict on it.
   *
   * The balance-sheet identity is the one check that matters most and is also
   * the one a filer can genuinely fail, so a failure marks the statement rather
   * than discarding it: a balance sheet that does not balance is a FINDING, and
   * deleting it would destroy the evidence for the finding.
   */
  private async validate(
    statementId: string,
    statementType: string,
    companyId: string,
    sourceRecordId: string,
  ): Promise<'passed' | 'failed' | 'not-applicable'> {
    const items = await this.prisma.financialLineItem.findMany({
      where: { statementId, conceptKey: { not: null } },
      select: { conceptKey: true, value: true },
    });
    // Two line items resolving to ONE concept inside a single statement would
    // make this lookup keep whichever it read last, and every check below would
    // then be run against an arbitrary choice. Recorded rather than resolved by
    // accident — the same rule the ingest applies to identifier conflicts.
    const byKey = new Map<string, number>();
    const duplicates: string[] = [];
    for (const i of items) {
      const key = i.conceptKey as string;
      if (byKey.has(key)) duplicates.push(key);
      else byKey.set(key, Number(i.value));
    }
    if (duplicates.length > 0) {
      await this.prisma.dataQualityResult.create({
        data: {
          entity: 'FinancialStatement',
          entityId: statementId,
          check: 'concept.duplicate-in-statement',
          severity: 'warn',
          passed: false,
          detail: { conceptKeys: [...new Set(duplicates)] } as unknown as Prisma.InputJsonObject,
          sourceRecordId,
        },
      });
    }

    const checks: { check: string; expected: number; observed: number }[] = [];

    if (statementType === 'BS') {
      const assets = byKey.get('bs.assets.total');
      const equity = byKey.get('bs.equity.total');
      const liabilities = byKey.get('bs.liabilities.total');
      const equityAndLiabilities = byKey.get('bs.equity-and-liabilities.total');

      if (assets != null && equityAndLiabilities != null) {
        checks.push({ check: 'balance-sheet.identity', expected: assets, observed: equityAndLiabilities });
      } else if (assets != null && equity != null && liabilities != null) {
        checks.push({ check: 'balance-sheet.identity', expected: assets, observed: equity + liabilities });
      }
    }

    if (statementType === 'PL') {
      const pbt = byKey.get('pl.pbt');
      const tax = byKey.get('pl.tax.total');
      const pat = byKey.get('pl.pat');
      // PBT - tax = PAT, before associates and discontinued operations. Those
      // are added back so the check does not fail on a company that has them.
      if (pbt != null && tax != null && pat != null) {
        const associates = byKey.get('pl.associates') ?? 0;
        const discontinued = byKey.get('pl.pat.discontinued') ?? 0;
        checks.push({ check: 'profit-and-loss.tax-bridge', expected: pat, observed: pbt - tax + associates + discontinued });
      }

      // Banking bridge: operating profit before provisions, less provisions,
      // is profit before tax. Gives banks a reconciliation to pass instead of
      // the 'not-applicable' they got when none of their lines were mapped.
      const bankOperating = byKey.get('pl.bank.operating-profit');
      const bankProvisions = byKey.get('pl.bank.provisions');
      if (bankOperating != null && bankProvisions != null && pbt != null) {
        // ADDED, not subtracted. `pl.exceptional` is already signed as filed —
        // HDFCBANK reports -802 cr for a charge — so subtracting it moves the
        // bridge the wrong way by twice the item. RELIANCE never exposed this
        // because its exceptional items are zero; the first bank with a real
        // one failed reconciliation by exactly 2x, which is what the check is
        // for.
        const exceptional = byKey.get('pl.exceptional') ?? 0;
        checks.push({
          check: 'banking.provision-bridge',
          expected: pbt,
          observed: bankOperating - bankProvisions + exceptional,
        });
      }

      const income = byKey.get('pl.revenue.total');
      const revenue = byKey.get('pl.revenue.operating');
      const other = byKey.get('pl.revenue.other');
      if (income != null && revenue != null && other != null) {
        checks.push({ check: 'profit-and-loss.income-sum', expected: income, observed: revenue + other });
      }
    }

    if (statementType === 'CF') {
      const operating = byKey.get('cf.operating');
      const investing = byKey.get('cf.investing');
      const financing = byKey.get('cf.financing');
      const beforeFx = byKey.get('cf.net-change-before-fx');
      const netChange = byKey.get('cf.net-change');
      const fx = byKey.get('cf.fx-effect');

      // CFO + CFI + CFF must equal the change in cash BEFORE exchange
      // differences. Checking it against the post-FX figure instead would fail
      // for every company with foreign operations — the FX effect is applied
      // after the three activity totals, not inside them.
      if (operating != null && investing != null && financing != null && beforeFx != null) {
        checks.push({
          check: 'cash-flow.activities-sum',
          expected: beforeFx,
          observed: operating + investing + financing,
        });
      }

      // …and that figure plus the exchange effect must equal the reported net
      // change. Two checks rather than one so a failure says WHICH half broke.
      if (beforeFx != null && netChange != null) {
        checks.push({ check: 'cash-flow.fx-bridge', expected: netChange, observed: beforeFx + (fx ?? 0) });
      }
    }

    if (checks.length === 0) {
      await this.prisma.financialStatement.update({
        where: { id: statementId },
        data: { reconciliationStatus: 'not-applicable' },
      });
      return 'not-applicable';
    }

    let failed = false;
    for (const c of checks) {
      const delta = Math.abs(c.expected - c.observed);
      const tolerance = Math.max(Math.abs(c.expected) * TOLERANCE_RELATIVE, TOLERANCE_ABSOLUTE);
      const passed = delta <= tolerance;
      if (!passed) failed = true;

      await this.prisma.dataQualityResult.create({
        data: {
          entity: 'FinancialStatement',
          entityId: statementId,
          check: c.check,
          severity: passed ? 'info' : 'error',
          passed,
          detail: { expected: c.expected, observed: c.observed, delta, tolerance } as unknown as Prisma.InputJsonObject,
          sourceRecordId,
        },
      });
    }

    const status = failed ? 'failed' : 'passed';
    await this.prisma.financialStatement.update({
      where: { id: statementId },
      data: { reconciliationStatus: status },
    });
    return status;
  }

  private async recordQuality(
    companyId: string,
    entity: string,
    check: string,
    severity: string,
    detail: Record<string, unknown>,
    sourceRecordId: string,
  ) {
    await this.prisma.dataQualityResult.create({
      data: {
        entity,
        entityId: companyId,
        check,
        severity,
        passed: severity === 'info',
        detail: detail as unknown as Prisma.InputJsonObject,
        sourceRecordId,
      },
    });
  }
}

/** `16-Jan-2025 20:20:21` → Date. Null rather than Invalid Date. */
function parseNseTimestamp(value?: string): Date | null {
  if (!value) return null;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!m) return null;
  const months: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const month = months[m[2].toLowerCase()];
  if (month === undefined) return null;
  // IST is UTC+5:30; the exchange publishes local time.
  const utc = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  return new Date(utc - 5.5 * 3_600_000);
}
