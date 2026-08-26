import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  BALANCE_METRICS,
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
import { PrismaService } from '../prisma/prisma.service';
import { NseService } from '../nse/nse.service';
import { ResearchCacheService } from './research-cache.service';
import {
  available,
  unavailable,
  type AnalystRating,
  type AnalystResearch,
  type AnalystResearchItem,
  type EarningsHistoryRow,
  type EarningsIntelligence,
  type KnowledgeGraphRelation,
  type PeerComparisonRow,
  type PeerResearch,
  type ResearchKnowledgeGraph,
  type ResearchNews,
  type ResearchNewsItem,
  type ResearchValuation,
  type ValuationMetric,
  type ValuationScenario,
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
    private readonly prisma: PrismaService,
    private readonly nse: NseService,
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

    const equityByPeriodEnd = new Map(balancePeriods.map((p) => [p.periodEnd, p.facts[BALANCE_METRICS.totalEquity]?.value]));
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

  async companyNewsSection(symbol: string): Promise<ResearchSection<ResearchNews>> {
    const profile = await this.profileSection(symbol);
    const companyName = profile.ok ? profile.value.name : null;
    const query = buildNewsQuery(symbol, companyName);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(
        `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`,
        {
          signal: controller.signal,
          headers: { 'user-agent': 'TradeW/1.0 (+company research news reader)' },
        },
      );
      if (!res.ok) {
        return unavailable(`company news is unavailable because the news feed returned HTTP ${res.status}`);
      }
      const xml = await res.text();
      const items = parseCompanyNews(xml)
        .filter((item) => isRelevantCompanyArticle(item, symbol, companyName))
        .slice(0, 12);
      if (items.length === 0) {
        return unavailable(
          `No recent company-specific news articles were found for ${companyName ?? symbol}. TradeW does not substitute generic market headlines here.`,
        );
      }
      return available(
        { symbol, companyName, items },
        {
          source: 'google-news-rss',
          sourceTimestamp: items[0]?.publishedAt ?? null,
          fetchedAt: new Date().toISOString(),
        },
      );
    } catch (err) {
      return unavailable(
        `company news is unavailable because the news feed could not be reached (${err instanceof Error ? err.message : String(err)})`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async analystResearchSection(symbol: string): Promise<ResearchSection<AnalystResearch>> {
    const news = await this.companyNewsSection(symbol);
    if (!news.available) {
      return unavailable(`Analyst research is unavailable because company news is unavailable (${news.reason})`);
    }

    const items = news.data.items
      .filter((item) => item.eventClassification === 'analyst')
      .map((item) => toAnalystResearchItem(item))
      .filter(
        (item): item is AnalystResearchItem =>
          item !== null &&
          (item.rating !== undefined ||
            item.previousRating !== undefined ||
            item.priceTarget !== undefined ||
            item.brokerName !== undefined ||
            item.analystName !== undefined),
      );

    if (items.length === 0) {
      return unavailable(
        'No structured analyst-rating or price-target items could be parsed from the current company news feed. This server has no dedicated analyst-data provider configured.',
      );
    }

    const distribution = { buy: 0, hold: 0, sell: 0 };
    for (const item of items) {
      if (item.rating) distribution[item.rating] += 1;
    }
    const targets = items.filter(
      (item): item is AnalystResearchItem & { priceTarget: number; currency: string } =>
        item.priceTarget !== undefined && item.currency !== undefined,
    );
    const groupedTargets = new Map<string, number[]>();
    for (const target of targets) {
      const list = groupedTargets.get(target.currency) ?? [];
      list.push(target.priceTarget);
      groupedTargets.set(target.currency, list);
    }
    const dominantCurrency = [...groupedTargets.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    const targetRange = dominantCurrency
      ? {
          low: Math.min(...dominantCurrency[1]),
          high: Math.max(...dominantCurrency[1]),
          average: dominantCurrency[1].reduce((sum, value) => sum + value, 0) / dominantCurrency[1].length,
          currency: dominantCurrency[0],
        }
      : null;

    return available(
      {
        symbol,
        coverageNote:
          'These items are parsed from current company news articles that explicitly mention analyst actions. TradeW does not invent broker names, ratings or targets when the article does not state them.',
        distribution,
        targetRange,
        items,
      },
      news.provenance,
    );
  }

  async earningsSection(symbol: string, periodType: PeriodType): Promise<ResearchSection<EarningsIntelligence>> {
    const [income, news, profile] = await Promise.all([
      this.statement(symbol, 'income', periodType),
      this.companyNewsSection(symbol),
      this.profileSection(symbol),
    ]);

    const history: EarningsHistoryRow[] = income.ok
      ? income.value.periods.slice(0, MAX_PERIODS).map((period, index, periods) => {
          const previous = periods[index + 1];
          return {
            periodEnd: period.periodEnd,
            fiscalYear: period.fiscalYear,
            ...(period.fiscalQuarter !== undefined ? { fiscalQuarter: period.fiscalQuarter } : {}),
            periodType,
            currency: period.currency,
            revenue: period.facts[INCOME_METRICS.revenue]?.value,
            eps: period.facts[INCOME_METRICS.eps]?.value,
            netIncome: period.facts[INCOME_METRICS.netIncome]?.value,
            revenueGrowthPct: growthPct(period.facts[INCOME_METRICS.revenue]?.value, previous?.facts[INCOME_METRICS.revenue]?.value),
            epsGrowthPct: growthPct(period.facts[INCOME_METRICS.eps]?.value, previous?.facts[INCOME_METRICS.eps]?.value),
          };
        })
      : [];

    let upcoming: EarningsIntelligence['upcoming'] = [];
    const unavailableDetails: string[] = [
      'Consensus estimates vs actuals are unavailable because this server has no earnings-estimates provider configured.',
      'Conference-call transcripts are unavailable because no transcript source is configured.',
      'Management commentary is unavailable because no transcript or filing-text source is configured for Research.',
    ];

    try {
      const calendar = await this.nse.eventCalendar(50);
      const companyName = profile.ok ? profile.value.name : null;
      upcoming = (calendar.events as EarningsIntelligence['upcoming']).filter((event) =>
        event.symbol === symbol ||
        fuzzyCompanyMatch(event.company, companyName) ||
        fuzzyCompanyMatch(event.company, symbol),
      );
    } catch (err) {
      unavailableDetails.push(
        `Upcoming corporate-event data could not be read from NSE (${err instanceof Error ? err.message : String(err)}).`,
      );
    }

    const recentEarningsNews = news.available
      ? news.data.items.filter((item) => item.eventClassification === 'earnings').slice(0, 6)
      : [];

    if (history.length === 0 && upcoming.length === 0 && recentEarningsNews.length === 0) {
      return unavailable(
        income.ok
          ? `No earnings intelligence could be assembled for ${symbol} from the currently configured market data sources.`
          : `Earnings intelligence is unavailable because the income statement could not be retrieved (${income.reason}).`,
      );
    }

    return available(
      { symbol, history, upcoming, recentEarningsNews, unavailableDetails },
      income.ok
        ? firstProvenance(income.value.periods[0]) ?? {
            source: this.provider.name,
            sourceTimestamp: null,
            fetchedAt: new Date().toISOString(),
          }
        : {
            source: 'nse-event-calendar',
            sourceTimestamp: upcoming[0]?.date ?? null,
            fetchedAt: new Date().toISOString(),
          },
    );
  }

  async valuationSection(symbol: string, periodType: PeriodType): Promise<ResearchSection<ResearchValuation>> {
    const [ratios, stats, income, cashFlow] = await Promise.all([
      this.ratiosSection(symbol, periodType),
      this.statisticsSection(symbol),
      this.statement(symbol, 'income', periodType),
      this.statement(symbol, 'cash_flow', periodType),
    ]);

    const metrics: ValuationMetric[] = [];
    const unavailableDetails: string[] = [];

    if (stats.ok) {
      pushValuationMetric(metrics, 'vendor_trailing_pe', 'Vendor trailing P/E', stats.value.vendorTrailingPe, 'x', 'provider', 'Published directly by the statistics provider.');
      pushValuationMetric(metrics, 'vendor_forward_pe', 'Vendor forward P/E', stats.value.vendorForwardPe, 'x', 'provider', 'Published directly by the statistics provider.');
      pushValuationMetric(metrics, 'vendor_peg', 'Vendor PEG', stats.value.vendorPegRatio, 'x', 'provider', 'Published directly by the statistics provider.');
    } else {
      unavailableDetails.push(`Provider statistics were unavailable (${stats.reason}).`);
    }

    if (ratios.available) {
      const lookup = new Map(ratios.data.ratios.map((ratio) => [ratio.key, ratio]));
      for (const key of ['pe', 'ps', 'pb', 'ev_ebitda'] as const) {
        const found = lookup.get(key);
        if (found) {
          metrics.push({
            key: found.key,
            label: found.label,
            value: found.value,
            unit: found.unit,
            source: 'calculated',
            detail: `${found.formula}. Inputs: ${found.inputs.map((input) => `${input.label} ${input.value}`).join(', ')}.`,
          });
        }
      }
    } else {
      unavailableDetails.push(`Calculated valuation ratios were unavailable (${ratios.reason}).`);
    }

    const latestFcf = cashFlow.ok ? cashFlow.value.periods[0]?.facts[CASH_FLOW_METRICS.freeCashFlow]?.value : undefined;
    if (stats.ok && stats.value.marketCap !== undefined && latestFcf !== undefined && stats.value.marketCap !== 0) {
      metrics.push({
        key: 'fcf_yield',
        label: 'FCF yield',
        value: (latestFcf / stats.value.marketCap) * 100,
        unit: 'percent',
        source: 'calculated',
        detail: 'Free cash flow divided by market capitalization.',
      });
    } else {
      unavailableDetails.push('FCF yield could not be calculated because free cash flow or market capitalization was not available.');
    }

    const scenarios = buildValuationScenarios(stats.ok ? stats.value : null, income.ok ? income.value : null, ratios);
    unavailableDetails.push(
      'Historical valuation ranges are unavailable because this Research implementation does not yet persist a price-and-multiple time series.',
    );

    if (metrics.length === 0 && scenarios.every((scenario) => scenario.impliedPrice === undefined)) {
      return unavailable(
        `Valuation is unavailable because neither provider-published nor calculated valuation inputs were available for ${symbol}.`,
      );
    }

    return available(
      {
        symbol,
        currency: income.ok ? income.value.periods[0]?.currency ?? null : stats.ok ? stats.value.currency : null,
        metrics,
        scenarios,
        unavailableDetails,
      },
      stats.ok
        ? stats.value.provenance
        : ratios.available
          ? ratios.provenance
          : { source: this.provider.name, sourceTimestamp: null, fetchedAt: new Date().toISOString() },
    );
  }

  async peerSection(symbol: string, periodType: PeriodType): Promise<ResearchSection<PeerResearch>> {
    const profile = await this.profileSection(symbol);
    if (!profile.ok || (!profile.value.sector && !profile.value.industry)) {
      return unavailable(
        profile.ok
          ? 'Peer comparison is unavailable because this company has no sector or industry classification in the cached research profile.'
          : `Peer comparison is unavailable because the company profile could not be loaded (${profile.reason}).`,
      );
    }

    const peers = await this.prisma.researchCompany.findMany({
      where: {
        symbol: { not: symbol },
        OR: [
          ...(profile.value.sector ? [{ sector: profile.value.sector }] : []),
          ...(profile.value.industry ? [{ industry: profile.value.industry }] : []),
        ],
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: 4,
    });

    if (peers.length === 0) {
      return unavailable(
        'Peer comparison is unavailable because no comparable companies are cached locally yet. Research only compares against companies this deployment has already researched.',
      );
    }

    const rows: PeerComparisonRow[] = await Promise.all(
      peers.map(async (peer: (typeof peers)[number]) => {
        const ratios = await this.ratiosSection(peer.symbol, periodType);
        const metricLookup = ratios.available ? new Map(ratios.data.ratios.map((ratio) => [ratio.key, ratio.value])) : new Map<string, number>();
        return {
          symbol: peer.symbol,
          name: peer.name,
          exchange: peer.exchange,
          ...(peer.sector ? { sector: peer.sector } : {}),
          ...(peer.industry ? { industry: peer.industry } : {}),
          metrics: {
            ...(metricLookup.has('pe') ? { pe: metricLookup.get('pe') } : {}),
            ...(metricLookup.has('pb') ? { pb: metricLookup.get('pb') } : {}),
            ...(metricLookup.has('ps') ? { ps: metricLookup.get('ps') } : {}),
            ...(metricLookup.has('ev_ebitda') ? { ev_ebitda: metricLookup.get('ev_ebitda') } : {}),
            ...(metricLookup.has('revenue_growth') ? { revenue_growth: metricLookup.get('revenue_growth') } : {}),
            ...(metricLookup.has('net_margin') ? { net_margin: metricLookup.get('net_margin') } : {}),
            ...(metricLookup.has('roe') ? { roe: metricLookup.get('roe') } : {}),
          },
          source: 'cached-research-company',
        };
      }),
    );

    return available(
      {
        symbol,
        subject: { ...(profile.value.sector ? { sector: profile.value.sector } : {}), ...(profile.value.industry ? { industry: profile.value.industry } : {}) },
        peers: rows,
        unavailableDetails: [
          'Peers come from locally cached ResearchCompany rows and may be incomplete until more companies have been researched on this deployment.',
        ],
      },
      profile.value.provenance,
    );
  }

  async knowledgeGraphSection(symbol: string): Promise<ResearchSection<ResearchKnowledgeGraph>> {
    const profile = await this.profileSection(symbol);
    const candidates = [symbol, `NSE:${symbol}`, `BSE:${symbol}`, `NYSE:${symbol}`, `NASDAQ:${symbol}`];
    const node = await this.prisma.graphNode.findFirst({
      where: {
        OR: [
          { entityId: { in: candidates } },
          { label: symbol },
          ...(profile.ok ? [{ label: profile.value.name }] : []),
        ],
      },
    });

    if (!node) {
      return unavailable(
        'Knowledge-graph relationships are unavailable because this company is not present in the current entity graph for this deployment.',
      );
    }

    const edges = await this.prisma.graphEdge.findMany({
      where: { OR: [{ fromId: node.id }, { toId: node.id }] },
      include: { from: true, to: true },
      orderBy: [{ weight: 'desc' }, { createdAt: 'desc' }],
      take: 24,
    });

    const relationships: KnowledgeGraphRelation[] = edges.map((edge: (typeof edges)[number]) => {
      const target = edge.fromId === node.id ? edge.to : edge.from;
      return {
        relation: edge.relation,
        targetId: target.entityId,
        targetLabel: target.label ?? target.entityId,
        targetType: target.entityType,
        weight: edge.weight,
      };
    });

    if (relationships.length === 0) {
      return unavailable(
        'Knowledge-graph relationships are unavailable because the entity graph has no recorded edges for this company yet.',
      );
    }

    return available(
      { symbol, nodeId: node.entityId, relationships },
      { source: 'entity-graph', sourceTimestamp: null, fetchedAt: new Date().toISOString() },
    );
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

function buildNewsQuery(symbol: string, companyName: string | null): string {
  return companyName ? `"${companyName}" OR ${symbol}` : symbol;
}

export function parseCompanyNews(xml: string): ResearchNewsItem[] {
  const blocks = xml.split('<item>').slice(1);
  return blocks
    .map((raw, index) => {
      const block = raw.split('</item>')[0];
      const title = decodeEntities(readTag(block, 'title') ?? '');
      const link = readTag(block, 'link');
      if (!title || !link || !isHttpUrl(link)) return null;
      const summary = decodeEntities(stripHtml(readTag(block, 'description') ?? '')).slice(0, 500);
      const publishedAt = toIso(readTag(block, 'pubDate')) ?? new Date().toISOString();
      const source = decodeEntities(readTag(block, 'source') ?? 'Google News');
      const evidence = `${title} ${summary}`;
      return {
        id: readTag(block, 'guid') ?? `${link}#${index}`,
        title,
        source,
        publishedAt,
        url: link,
        summary,
        categories: deriveNewsCategories(evidence),
        sentiment: classifySentiment(evidence),
        eventClassification: classifyNewsEvent(evidence),
        eventImpact: classifyEventImpact(evidence),
      } satisfies ResearchNewsItem;
    })
    .filter((item): item is ResearchNewsItem => item !== null);
}

function isRelevantCompanyArticle(item: ResearchNewsItem, symbol: string, companyName: string | null): boolean {
  const haystack = `${item.title} ${item.summary}`.toUpperCase();
  if (haystack.includes(symbol.toUpperCase())) return true;
  if (!companyName) return false;
  const normalizedName = compactName(companyName);
  return normalizedName.length >= 4 && compactName(haystack).includes(normalizedName);
}

function deriveNewsCategories(text: string): string[] {
  const normalized = text.toLowerCase();
  const out = new Set<string>();
  if (/(earnings|results|revenue|eps|quarter)/.test(normalized)) out.add('Earnings');
  if (/(upgrade|downgrade|initiat|outperform|underperform|overweight|underweight|price target|broker)/.test(normalized)) {
    out.add('Analyst');
  }
  if (/(ceo|cfo|chairman|board|management|resign|appoint)/.test(normalized)) out.add('Management');
  if (/(dividend|buyback|split|merger|acquisition|stake sale|fund raising)/.test(normalized)) out.add('Corporate Action');
  if (/(launch|contract|order win|partnership|guidance|approval|regulatory)/.test(normalized)) out.add('Announcement');
  return out.size > 0 ? [...out] : ['General'];
}

export function classifySentiment(text: string): ResearchNewsItem['sentiment'] {
  const normalized = text.toLowerCase();
  const positive = countMatches(normalized, [
    'beats',
    'surge',
    'gain',
    'growth',
    'record',
    'upgrade',
    'buy',
    'outperform',
    'strong',
    'profit rises',
  ]);
  const negative = countMatches(normalized, [
    'misses',
    'fall',
    'drop',
    'downgrade',
    'sell',
    'underperform',
    'weak',
    'probe',
    'lawsuit',
    'loss widens',
  ]);
  if (positive === negative) return 'neutral';
  return positive > negative ? 'positive' : 'negative';
}

export function classifyNewsEvent(text: string): ResearchNewsItem['eventClassification'] {
  const normalized = text.toLowerCase();
  if (/(upgrade|downgrade|outperform|underperform|overweight|underweight|price target|broker)/.test(normalized)) {
    return 'analyst';
  }
  if (/(earnings|results|revenue|eps|quarter|profit)/.test(normalized)) return 'earnings';
  if (/(ceo|cfo|chairman|board|appoint|resign|management)/.test(normalized)) return 'management';
  if (/(dividend|buyback|split|merger|acquisition|stake sale|fund raising)/.test(normalized)) return 'corporate_action';
  if (/(launch|contract|partnership|guidance|approval|regulatory|order win)/.test(normalized)) return 'major_announcement';
  return 'other';
}

function classifyEventImpact(text: string): ResearchNewsItem['eventImpact'] {
  const normalized = text.toLowerCase();
  if (/(merger|acquisition|results|earnings|guidance|dividend|buyback|regulatory|downgrade|upgrade)/.test(normalized)) {
    return 'high';
  }
  if (/(contract|launch|appoint|resign|approval|stake)/.test(normalized)) return 'medium';
  if (normalized.length > 0) return 'low';
  return 'unknown';
}

function toAnalystResearchItem(item: ResearchNewsItem): AnalystResearchItem | null {
  const text = `${item.title}. ${item.summary}`;
  const rating = parseRating(text);
  const previousRating = parsePreviousRating(text);
  const priceTarget = parsePriceTarget(text);
  const currency = parseCurrency(text);
  const brokerName = parseBrokerName(text);
  const analystName = parseAnalystName(text);
  return {
    articleId: item.id,
    title: item.title,
    source: item.source,
    publishedAt: item.publishedAt,
    url: item.url,
    ...(brokerName ? { brokerName } : {}),
    ...(analystName ? { analystName } : {}),
    ...(rating ? { rating } : {}),
    ...(previousRating ? { previousRating } : {}),
    ...(priceTarget !== undefined ? { priceTarget } : {}),
    ...(currency ? { currency } : {}),
    ...(item.summary ? { commentary: item.summary } : {}),
  };
}

function parseRating(text: string): AnalystRating | undefined {
  const normalized = text.toLowerCase();
  if (/(buy|outperform|overweight|accumulate|add)\b/.test(normalized)) return 'buy';
  if (/(hold|neutral|equal[- ]weight)\b/.test(normalized)) return 'hold';
  if (/(sell|underperform|underweight|reduce)\b/.test(normalized)) return 'sell';
  return undefined;
}

function parsePreviousRating(text: string): AnalystRating | undefined {
  const match = /from\s+(buy|hold|sell|neutral|outperform|underperform|overweight|underweight)/i.exec(text);
  return match ? parseRating(match[1]) : undefined;
}

export function parsePriceTarget(text: string): number | undefined {
  const match = /(price target|target price|pt)\D{0,12}(?:rs\.?|₹|\$|usd|inr)?\s?([0-9][0-9,]*(?:\.\d+)?)/i.exec(text);
  if (!match) return undefined;
  const parsed = Number(match[2].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCurrency(text: string): string | undefined {
  if (/(₹|rs\.?|inr)/i.test(text)) return 'INR';
  if (/(?:^|[^A-Z])usd(?:[^A-Z]|$)|\$/i.test(text)) return 'USD';
  return undefined;
}

function parseBrokerName(text: string): string | undefined {
  const match =
    /(?:brokerage|broker|analyst|research)\s+(?:firm\s+)?([A-Z][A-Za-z&.\- ]{2,40})/i.exec(text) ??
    /([A-Z][A-Za-z&.\- ]{2,40})\s+(?:upgraded|downgraded|initiated|raised|cut|maintained)/.exec(text);
  return match ? match[1].trim() : undefined;
}

function parseAnalystName(text: string): string | undefined {
  const match = /analyst\s+([A-Z][A-Za-z.\- ]{2,40})/i.exec(text);
  return match ? match[1].trim() : undefined;
}

function growthPct(current: number | undefined, previous: number | undefined): number | undefined {
  if (current === undefined || previous === undefined || previous === 0) return undefined;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function pushValuationMetric(
  out: ValuationMetric[],
  key: string,
  label: string,
  value: number | undefined,
  unit: ValuationMetric['unit'],
  source: ValuationMetric['source'],
  detail: string,
): void {
  if (value === undefined || !Number.isFinite(value)) return;
  out.push({ key, label, value, unit, source, detail });
}

export function buildValuationScenarios(
  stats: CompanyStatistics | null,
  income: FinancialStatement | null,
  ratios: ResearchSection<ResearchRatios>,
): ValuationScenario[] {
  const out: ValuationScenario[] = [];
  const latestIncome = income?.periods[0];
  const eps = latestIncome?.facts[INCOME_METRICS.eps]?.value;
  const revenue = latestIncome?.facts[INCOME_METRICS.revenue]?.value;
  const shares = stats?.sharesOutstanding;
  const ratioLookup =
    ratios.available ? new Map(ratios.data.ratios.map((ratio) => [ratio.key, ratio.value])) : new Map<string, number>();

  const pe = ratioLookup.get('pe');
  if (eps !== undefined && pe !== undefined) {
    for (const [label, multiple] of [
      ['Bear case', pe * 0.85],
      ['Base case', pe],
      ['Bull case', pe * 1.15],
    ] as const) {
      out.push({
        label,
        basis: `EPS × ${multiple.toFixed(2)}x trailing P/E`,
        impliedPrice: eps * multiple,
      });
    }
  } else {
    out.push({
      label: 'P/E cases',
      basis: 'Trailing EPS × multiple',
      reason: 'EPS or trailing P/E was not available.',
    });
  }

  const ps = ratioLookup.get('ps');
  if (revenue !== undefined && shares !== undefined && shares > 0 && ps !== undefined) {
    const revenuePerShare = revenue / shares;
    out.push({
      label: 'Sales multiple cross-check',
      basis: `Revenue per share × ${ps.toFixed(2)}x P/S`,
      impliedPrice: revenuePerShare * ps,
    });
  } else {
    out.push({
      label: 'Sales multiple cross-check',
      basis: 'Revenue per share × P/S',
      reason: 'Revenue, shares outstanding or P/S was not available.',
    });
  }
  return out;
}

function fuzzyCompanyMatch(value: string | null | undefined, target: string | null | undefined): boolean {
  if (!value || !target) return false;
  const a = compactName(value);
  const b = compactName(target);
  return a.includes(b) || b.includes(a);
}

function compactName(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function readTag(block: string, name: string): string | null {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  if (!match) return null;
  const value = match[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
  return value.length > 0 ? value : null;
}

function stripHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function toIso(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function countMatches(text: string, terms: string[]): number {
  return terms.reduce((count, term) => count + (text.includes(term) ? 1 : 0), 0);
}
