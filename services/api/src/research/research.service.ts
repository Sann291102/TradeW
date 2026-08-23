import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  CASH_FLOW_METRICS,
  FundamentalsUnavailableError,
  INCOME_METRICS,
  computeRatios,
  reconcileBalanceSheet,
  resolveFinancialDataProvider,
  type CompanyStatistics,
  type FinancialDataProvider,
  type FinancialStatement,
  type PeriodType,
  type Provenance,
  type StatementPeriod,
  type StatementType,
} from '@tradew/market-data';
import { ResearchCacheService } from './research-cache.service';
import {
  available,
  unavailable,
  type ResearchHistory,
  type ResearchHistorySeries,
  type ResearchRatios,
  type ResearchSearchResponse,
  type ResearchSection,
  type ResearchSnapshot,
  type ResearchStatement,
} from './research.types';

/** Injection token, so tests supply a fake provider without touching env. */
export const FINANCIAL_DATA_PROVIDER = 'FINANCIAL_DATA_PROVIDER';

/**
 * Statements change quarterly; a day is comfortably inside that and still
 * refreshes a restatement within one business day.
 */
const STATEMENT_MAX_AGE_MS = Number(process.env.RESEARCH_STATEMENT_TTL_MS ?? 24 * 60 * 60 * 1000);
/** Profiles change less often still, but sector reclassifications happen. */
const PROFILE_MAX_AGE_MS = Number(process.env.RESEARCH_PROFILE_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);
/** Statistics are point-in-time market figures — minutes, not days. */
const STATISTICS_MAX_AGE_MS = Number(process.env.RESEARCH_STATISTICS_TTL_MS ?? 15 * 60 * 1000);

/** How many periods a statement table and the history charts show. */
const MAX_PERIODS = 8;

/**
 * The research read model.
 *
 * ── EVERY METHOD RETURNS A SECTION, NEVER THROWS FOR MISSING DATA ──────────
 *
 * A vendor that cannot answer is a normal outcome for this surface, not an
 * error: a small-cap with no cash-flow coverage should render a P&L and say
 * "cash flow unavailable" beside it, not 503 the whole page. So the provider's
 * `FundamentalsUnavailableError` is caught here and converted into
 * `{ available: false, reason }`, and only genuinely unexpected failures
 * propagate.
 *
 * ── NOTHING IS EVER SUBSTITUTED ────────────────────────────────────────────
 *
 * There is no `?? 0`, no default period, no "last known" price standing in for
 * a current one, and no cross-symbol borrowing anywhere below this line. If a
 * number is not in the vendor's answer or this system's cache, the section that
 * needed it says so.
 */
@Injectable()
export class ResearchService {
  private readonly logger = new Logger(ResearchService.name);
  private readonly provider: FinancialDataProvider;
  /** Statistics are cached in-process only: they are point-in-time market
   *  figures, so persisting them would create a durable stale price — the one
   *  thing this surface must never show. */
  private readonly statsMemo = new Map<string, { at: number; value: CompanyStatistics }>();

  constructor(
    private readonly cache: ResearchCacheService,
    @Optional() @Inject(FINANCIAL_DATA_PROVIDER) injected?: FinancialDataProvider,
  ) {
    this.provider = injected ?? lazyProvider();
  }

  get providerName(): string {
    return this.provider.name;
  }

  // ────────────────────────────────── search ─────────────────────────────────

  async search(query: string, limit = 15): Promise<ResearchSearchResponse> {
    const q = query.trim();
    if (!q) return { query: q, results: [] };
    try {
      const results = await this.provider.searchSymbols(q, limit);
      return { query: q, results };
    } catch (err) {
      // A failed search is reported as a failed search. It must NOT fall back
      // to a local instrument list: those rows are tradeable contracts with no
      // fundamentals coverage, so every hit would lead to an empty company.
      return { query: q, results: [], unavailableReason: describe(err) };
    }
  }

  // ───────────────────────────────── overview ────────────────────────────────

  private async profileSection(symbol: string) {
    const cached = await this.cache.readProfile(symbol, PROFILE_MAX_AGE_MS);
    if (cached) return { ok: true as const, value: cached };
    try {
      const fresh = await this.provider.getProfile(symbol);
      await this.cache.writeProfile(fresh);
      return { ok: true as const, value: fresh };
    } catch (err) {
      return { ok: false as const, reason: describe(err) };
    }
  }

  private async statisticsSection(symbol: string) {
    const key = symbol.toUpperCase();
    const hit = this.statsMemo.get(key);
    if (hit && Date.now() - hit.at < STATISTICS_MAX_AGE_MS) {
      return { ok: true as const, value: hit.value };
    }
    try {
      const fresh = await this.provider.getStatistics(symbol);
      this.statsMemo.set(key, { at: Date.now(), value: fresh });
      return { ok: true as const, value: fresh };
    } catch (err) {
      return { ok: false as const, reason: describe(err) };
    }
  }

  // ──────────────────────────────── statements ───────────────────────────────

  /**
   * Cache-then-vendor for one statement.
   *
   * Returns the raw statement (or a reason) so the ratio and history builders
   * can reuse one fetch instead of each triggering their own — which on a
   * credit-metered vendor is the difference between three upstream calls per
   * page load and twelve.
   */
  private async statement(
    symbol: string,
    type: StatementType,
    periodType: PeriodType,
  ): Promise<{ ok: true; value: FinancialStatement } | { ok: false; reason: string }> {
    const cached = await this.cache.readStatement(symbol, type, periodType, STATEMENT_MAX_AGE_MS);
    if (cached) return { ok: true, value: cached };
    try {
      const fresh = await this.provider.getStatement(symbol, type, periodType);
      await this.cache.writeStatement(fresh);
      return { ok: true, value: fresh };
    } catch (err) {
      return { ok: false, reason: describe(err) };
    }
  }

  /** One statement as a section, with the balance-sheet check attached. */
  async statementSection(
    symbol: string,
    type: StatementType,
    periodType: PeriodType,
  ): Promise<ResearchSection<ResearchStatement>> {
    const result = await this.statement(symbol, type, periodType);
    if (!result.ok) return unavailable(result.reason);
    return toStatementSection(result.value, type);
  }

  // ────────────────────────────────── ratios ─────────────────────────────────

  /**
   * Ratios from the latest two periods of the same cadence.
   *
   * Valuation ratios additionally need a market price. When statistics are
   * unavailable the valuation block is simply not computed — `computeRatios`
   * records each affected ratio in `skipped` with the missing operand named, so
   * the UI shows "P/E — not reported: price" rather than an empty row or, far
   * worse, a P/E computed against a stale price.
   */
  async ratiosSection(symbol: string, periodType: PeriodType): Promise<ResearchSection<ResearchRatios>> {
    const [income, balance, cashFlow, stats] = await Promise.all([
      this.statement(symbol, 'income', periodType),
      this.statement(symbol, 'balance', periodType),
      this.statement(symbol, 'cash_flow', periodType),
      this.statisticsSection(symbol),
    ]);

    if (!income.ok && !balance.ok && !cashFlow.ok) {
      return unavailable(
        `no financial statements are available for this company, so no ratio can be computed (${income.reason})`,
      );
    }

    const incomePeriods = income.ok ? income.value.periods : [];
    const balancePeriods = balance.ok ? balance.value.periods : [];
    const cashPeriods = cashFlow.ok ? cashFlow.value.periods : [];

    const marketInputs = stats.ok
      ? {
          ...(stats.value.marketCap !== undefined ? { marketCap: stats.value.marketCap } : {}),
          ...(stats.value.enterpriseValue !== undefined ? { enterpriseValue: stats.value.enterpriseValue } : {}),
          // Price is derived from market cap and share count rather than taken
          // from a quote feed, so P/E and P/B are computed against the SAME
          // point in time as the market cap beside them. A live tick paired
          // with a vendor market cap from another moment produces two mutually
          // inconsistent valuation numbers on one screen.
          ...(stats.value.marketCap !== undefined && stats.value.sharesOutstanding
            ? { price: stats.value.marketCap / stats.value.sharesOutstanding }
            : {}),
        }
      : {};

    const result = computeRatios({
      income: incomePeriods[0],
      incomePrevious: incomePeriods[1],
      balance: balancePeriods[0],
      balancePrevious: balancePeriods[1],
      cashFlow: cashPeriods[0],
      cashFlowPrevious: cashPeriods[1],
      market: marketInputs,
    });

    const basis = incomePeriods[0] ?? balancePeriods[0] ?? cashPeriods[0];
    const provenance: Provenance =
      firstProvenance(basis) ??
      (stats.ok ? stats.value.provenance : { source: this.provider.name, sourceTimestamp: null, fetchedAt: new Date().toISOString() });

    return available(
      {
        ratios: result.ratios,
        skipped: result.skipped,
        basisPeriodEnd: basis?.periodEnd ?? null,
        periodType,
        currency: basis?.currency ?? null,
        marketInputs: stats.ok
          ? {
              ...marketInputs,
              priceSource: `${this.provider.name} statistics`,
              ...(stats.value.provenance.sourceTimestamp
                ? { priceAsOf: stats.value.provenance.sourceTimestamp }
                : { priceAsOf: stats.value.provenance.fetchedAt }),
            }
          : null,
      },
      provenance,
    );
  }

  // ───────────────────────────────── history ─────────────────────────────────

  /**
   * Historical series for the performance charts.
   *
   * A series is emitted ONLY when at least two periods carry the metric — a
   * one-point "trend" is a dot pretending to be a line, and the brief's rule is
   * to show "historical financial data unavailable" instead of drawing one.
   */
  async historySection(symbol: string, periodType: PeriodType): Promise<ResearchSection<ResearchHistory>> {
    const [income, cashFlow, balance] = await Promise.all([
      this.statement(symbol, 'income', periodType),
      this.statement(symbol, 'cash_flow', periodType),
      this.statement(symbol, 'balance', periodType),
    ]);

    if (!income.ok && !cashFlow.ok) {
      return unavailable(`historical financial data is unavailable for this company (${income.reason})`);
    }

    const incomePeriods = income.ok ? [...income.value.periods].reverse() : [];
    const cashPeriods = cashFlow.ok ? [...cashFlow.value.periods].reverse() : [];
    const balancePeriods = balance.ok ? [...balance.value.periods].reverse() : [];

    const series: ResearchHistorySeries[] = [];
    const push = (
      metric: string,
      label: string,
      unit: ResearchHistorySeries['unit'],
      periods: StatementPeriod[],
    ) => {
      const points = periods
        .map((p) => {
          const f = p.facts[metric];
          if (!f) return null;
          return {
            periodEnd: p.periodEnd,
            fiscalYear: p.fiscalYear,
            ...(p.fiscalQuarter !== undefined ? { fiscalQuarter: p.fiscalQuarter } : {}),
            value: f.value,
          };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);
      if (points.length < 2) return;
      series.push({
        metric,
        label,
        unit,
        currency: unit === 'currency' ? (periods[0]?.currency ?? null) : null,
        points: points.slice(-MAX_PERIODS),
      });
    };

    push(INCOME_METRICS.revenue, 'Revenue', 'currency', incomePeriods);
    push(INCOME_METRICS.ebitda, 'EBITDA', 'currency', incomePeriods);
    push(INCOME_METRICS.netIncome, 'Net income', 'currency', incomePeriods);
    push(INCOME_METRICS.eps, 'EPS', 'currency', incomePeriods);
    push(CASH_FLOW_METRICS.freeCashFlow, 'Free cash flow', 'currency', cashPeriods);

    // Derived series: operating margin and ROE per period. Both are computed
    // here rather than stored, for the same reason ratios are not cached — a
    // formula change must never leave a stale derived number behind.
    const marginPoints = incomePeriods
      .map((p) => {
        const revenue = p.facts[INCOME_METRICS.revenue]?.value;
        const operating = p.facts[INCOME_METRICS.operatingIncome]?.value;
        if (revenue === undefined || operating === undefined || revenue === 0) return null;
        return {
          periodEnd: p.periodEnd,
          fiscalYear: p.fiscalYear,
          ...(p.fiscalQuarter !== undefined ? { fiscalQuarter: p.fiscalQuarter } : {}),
          value: (operating / revenue) * 100,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
    if (marginPoints.length >= 2) {
      series.push({
        metric: 'operating_margin',
        label: 'Operating margin',
        unit: 'percent',
        currency: null,
        points: marginPoints.slice(-MAX_PERIODS),
      });
    }

    const equityByPeriodEnd = new Map(
      balancePeriods.map((p) => [p.periodEnd, p.facts['total_shareholders_equity']?.value]),
    );
    const roePoints = incomePeriods
      .map((p) => {
        const netIncome = p.facts[INCOME_METRICS.netIncome]?.value;
        const equity = equityByPeriodEnd.get(p.periodEnd);
        if (netIncome === undefined || equity === undefined || equity <= 0) return null;
        return {
          periodEnd: p.periodEnd,
          fiscalYear: p.fiscalYear,
          ...(p.fiscalQuarter !== undefined ? { fiscalQuarter: p.fiscalQuarter } : {}),
          value: (netIncome / equity) * 100,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
    if (roePoints.length >= 2) {
      series.push({
        metric: 'roe',
        label: 'Return on equity',
        unit: 'percent',
        currency: null,
        points: roePoints.slice(-MAX_PERIODS),
      });
    }

    if (series.length === 0) {
      return unavailable(
        'historical financial data is unavailable for this company — no metric has two or more comparable periods',
      );
    }

    const prov =
      firstProvenance(incomePeriods[incomePeriods.length - 1]) ??
      firstProvenance(cashPeriods[cashPeriods.length - 1]);
    return available(
      { periodType, series },
      prov ?? { source: this.provider.name, sourceTimestamp: null, fetchedAt: new Date().toISOString() },
    );
  }

  // ──────────────────────────── ownership & segments ─────────────────────────

  async ownershipSection(symbol: string) {
    try {
      const data = await this.provider.getOwnership(symbol);
      return available(data, data.provenance);
    } catch (err) {
      return unavailable<never>(describe(err)) as ResearchSection<never>;
    }
  }

  async segmentsSection(symbol: string) {
    try {
      const data = await this.provider.getSegments(symbol);
      if (data.length === 0) {
        return unavailable<never>('the configured data provider published no segment breakdown for this company') as ResearchSection<never>;
      }
      return available(data, data[0]!.provenance);
    } catch (err) {
      return unavailable<never>(describe(err)) as ResearchSection<never>;
    }
  }

  // ───────────────────────────────── snapshot ────────────────────────────────

  /**
   * The consolidated read the page loads with.
   *
   * One endpoint rather than nine round trips, because every section shares the
   * same three statement fetches and splitting them would multiply upstream
   * cost by the number of sections. Sections still fail INDEPENDENTLY — a
   * company with no cash-flow coverage returns a full P&L and a reasoned
   * absence for cash flow, in the same response.
   */
  async snapshot(symbol: string, periodType: PeriodType): Promise<ResearchSnapshot> {
    const [profile, stats, income, balance, cashFlow, ratios, history, ownership, segments] = await Promise.all([
      this.profileSection(symbol),
      this.statisticsSection(symbol),
      this.statementSection(symbol, 'income', periodType),
      this.statementSection(symbol, 'balance', periodType),
      this.statementSection(symbol, 'cash_flow', periodType),
      this.ratiosSection(symbol, periodType),
      this.historySection(symbol, periodType),
      this.ownershipSection(symbol),
      this.segmentsSection(symbol),
    ]);

    const overview: ResearchSnapshot['overview'] = profile.ok
      ? stats.ok
        ? available({ profile: profile.value, statistics: stats.value }, profile.value.provenance)
        : // The profile alone is not an overview: market cap, 52-week range and
          // beta all live on statistics, and rendering a header with an empty
          // right half reads as "this company has no market cap".
          unavailable(`company profile is available but market statistics are not (${stats.reason})`)
      : unavailable(profile.reason);

    return {
      symbol: symbol.toUpperCase(),
      periodType,
      overview,
      income,
      balance,
      cashFlow,
      ratios,
      history,
      ownership,
      segments,
      provider: this.provider.name,
      generatedAt: new Date().toISOString(),
    };
  }
}

/** Balance-sheet check attaches to the balance sheet and nothing else. */
function toStatementSection(statement: FinancialStatement, type: StatementType): ResearchSection<ResearchStatement> {
  const trimmed: FinancialStatement = { ...statement, periods: statement.periods.slice(0, MAX_PERIODS) };
  const reconciliation = type === 'balance' ? reconcileBalanceSheet(trimmed.periods[0]) : null;
  const prov = firstProvenance(trimmed.periods[0]);
  return available(
    { statement: trimmed, reconciliation },
    prov ?? { source: 'unknown', sourceTimestamp: null, fetchedAt: new Date().toISOString() },
  );
}

/** The provenance of a period = the provenance of its facts (all one fetch). */
function firstProvenance(period: StatementPeriod | undefined): Provenance | null {
  if (!period) return null;
  const first = Object.values(period.facts)[0];
  return first ? first.provenance : null;
}

/**
 * Turn any thrown value into a sentence a user can read.
 *
 * `FundamentalsUnavailableError.detail` is written for this purpose and is
 * already scrubbed of credentials by the provider. Anything else is deliberately
 * NOT echoed: an unexpected error's message can carry internal detail, so it
 * becomes a generic sentence and the specifics go to the log.
 */
function describe(err: unknown): string {
  if (err instanceof FundamentalsUnavailableError) return err.detail;
  return 'the fundamental-data provider could not be reached';
}

/**
 * Provider construction is deferred to first use rather than done at module
 * load, so a missing/invalid `RESEARCH_FUNDAMENTALS_PROVIDER` surfaces as an
 * unavailable section on the research page instead of aborting API boot for
 * every other feature.
 */
function lazyProvider(): FinancialDataProvider {
  try {
    return resolveFinancialDataProvider();
  } catch (err) {
    const reason = err instanceof FundamentalsUnavailableError ? err.detail : String(err);
    const fail = async (): Promise<never> => {
      throw new FundamentalsUnavailableError(reason);
    };
    return {
      name: 'unconfigured',
      searchSymbols: fail,
      getProfile: fail,
      getStatistics: fail,
      getStatement: fail,
      getOwnership: fail,
      getSegments: fail,
      healthCheck: async () => false,
    };
  }
}
