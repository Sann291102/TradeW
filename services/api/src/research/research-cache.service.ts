import { Injectable, Logger } from '@nestjs/common';
import type {
  CompanyProfile,
  FinancialFact,
  FinancialStatement,
  PeriodType,
  StatementPeriod,
  StatementType,
} from '@tradew/market-data';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The `fiscalQuarter` value that means "annual period, no quarter".
 *
 * Zero rather than NULL because the column participates in a unique key and
 * Postgres treats NULLs as distinct — see the schema comment. Confined to this
 * file: nothing above the cache knows the sentinel exists.
 */
const ANNUAL_QUARTER = 0;

/**
 * The durable cache in front of the fundamentals vendor.
 *
 * ── WHAT IT IS FOR ─────────────────────────────────────────────────────────
 *
 * Vendor fundamentals are credit-metered at single-digit requests per minute on
 * the entry tier, and statements change once a quarter. Without this, upstream
 * cost would be a function of how many people opened the page. With it, it is a
 * function of how many reporting periods exist.
 *
 * ── WHAT IT IS NOT ─────────────────────────────────────────────────────────
 *
 * It is NOT a fallback. A cache miss on an unreachable vendor produces "data
 * unavailable", never a synthesised row. And a cache HIT is served with the
 * vendor's original provenance intact — `fetchedAt` is the moment the vendor
 * answered, not the moment we replayed it — so the UI's "as of" is always the
 * truth about the data's age even when the read never left this process.
 *
 * Staleness is a READ-TIME decision, not a TTL sweep: `maxAgeMs` is passed in by
 * the service, so the same rows can back a "fresh enough for a page load" read
 * and a "must be current" read without duplicating storage.
 */
@Injectable()
export class ResearchCacheService {
  private readonly logger = new Logger(ResearchCacheService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────────── company profile ─────────────────────────────

  async readProfile(symbol: string, maxAgeMs: number): Promise<CompanyProfile | null> {
    const row = await this.prisma.researchCompany.findFirst({
      where: { symbol: symbol.toUpperCase() },
      orderBy: { fetchedAt: 'desc' },
    });
    if (!row) return null;
    if (Date.now() - row.fetchedAt.getTime() > maxAgeMs) return null;

    return {
      symbol: row.symbol,
      exchange: row.exchange,
      name: row.name,
      currency: row.currency,
      ...(row.sector ? { sector: row.sector } : {}),
      ...(row.industry ? { industry: row.industry } : {}),
      ...(row.country ? { country: row.country } : {}),
      ...(row.isin ? { isin: row.isin } : {}),
      ...(row.website ? { website: row.website } : {}),
      ...(row.employees != null ? { employees: row.employees } : {}),
      ...(row.description ? { description: row.description } : {}),
      provenance: {
        source: row.source,
        sourceTimestamp: row.sourceTimestamp ? row.sourceTimestamp.toISOString() : null,
        // The ORIGINAL fetch time, not now(). See the class docstring.
        fetchedAt: row.fetchedAt.toISOString(),
      },
    };
  }

  async writeProfile(profile: CompanyProfile): Promise<void> {
    const data = {
      name: profile.name,
      currency: profile.currency,
      sector: profile.sector ?? null,
      industry: profile.industry ?? null,
      country: profile.country ?? null,
      isin: profile.isin ?? null,
      website: profile.website ?? null,
      employees: profile.employees ?? null,
      description: profile.description ?? null,
      source: profile.provenance.source,
      sourceTimestamp: profile.provenance.sourceTimestamp ? new Date(profile.provenance.sourceTimestamp) : null,
      fetchedAt: new Date(profile.provenance.fetchedAt),
    };
    await this.prisma.researchCompany.upsert({
      where: { symbol_exchange: { symbol: profile.symbol.toUpperCase(), exchange: profile.exchange } },
      create: { symbol: profile.symbol.toUpperCase(), exchange: profile.exchange, ...data },
      update: data,
    });
  }

  // ──────────────────────────── statement facts ──────────────────────────────

  async readStatement(
    symbol: string,
    statementType: StatementType,
    periodType: PeriodType,
    maxAgeMs: number,
  ): Promise<FinancialStatement | null> {
    const rows = await this.prisma.researchStatementFact.findMany({
      where: {
        symbol: symbol.toUpperCase(),
        statementType: statementType as never,
        periodType: periodType as never,
      },
      orderBy: [{ periodEnd: 'desc' }],
    });
    if (rows.length === 0) return null;

    // One stale fact makes the whole statement stale. Mixing a refreshed
    // revenue line with a months-old net income would produce a period that
    // never existed in any filing.
    const newest = Math.max(...rows.map((r: { fetchedAt: Date }) => r.fetchedAt.getTime()));
    if (Date.now() - newest > maxAgeMs) return null;

    const byPeriod = new Map<string, StatementPeriod>();
    for (const row of rows) {
      // 0 is the annual sentinel (see the schema comment on the column);
      // it never reaches the domain type, which uses an absent key instead.
      const quarter = row.fiscalQuarter > 0 ? row.fiscalQuarter : undefined;
      const key = `${row.fiscalYear}:${quarter ?? 'A'}`;
      let period = byPeriod.get(key);
      if (!period) {
        period = {
          fiscalYear: row.fiscalYear,
          ...(quarter !== undefined ? { fiscalQuarter: quarter } : {}),
          periodEnd: row.periodEnd.toISOString().slice(0, 10),
          periodType,
          currency: row.currency,
          facts: {},
        };
        byPeriod.set(key, period);
      }
      const fact: FinancialFact = {
        metric: row.metric,
        value: Number(row.value),
        currency: row.currency,
        basis: row.basis === 'derived' ? 'derived' : 'reported',
        provenance: {
          source: row.source,
          sourceTimestamp: row.sourceTimestamp ? row.sourceTimestamp.toISOString() : null,
          fetchedAt: row.fetchedAt.toISOString(),
        },
      };
      period.facts[row.metric] = fact;
    }

    const periods = [...byPeriod.values()].sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1));
    return { statementType, periodType, symbol: symbol.toUpperCase(), periods };
  }

  /**
   * Persist a statement.
   *
   * Upsert per fact rather than delete-then-insert: a restatement that drops a
   * line should not take the rest of the period with it, and a failed write
   * halfway through a delete-insert would leave the statement missing periods
   * entirely — worse than slightly stale.
   */
  async writeStatement(statement: FinancialStatement): Promise<void> {
    const symbol = statement.symbol.toUpperCase();
    const writes = [];
    for (const period of statement.periods) {
      for (const fact of Object.values(period.facts)) {
        const data = {
          periodEnd: new Date(`${period.periodEnd}T00:00:00.000Z`),
          value: fact.value.toFixed(4),
          currency: fact.currency,
          basis: fact.basis,
          source: fact.provenance.source,
          sourceTimestamp: fact.provenance.sourceTimestamp ? new Date(fact.provenance.sourceTimestamp) : null,
          fetchedAt: new Date(fact.provenance.fetchedAt),
        };
        writes.push(
          this.prisma.researchStatementFact.upsert({
            where: {
              symbol_statementType_periodType_fiscalYear_fiscalQuarter_metric: {
                symbol,
                statementType: statement.statementType as never,
                periodType: statement.periodType as never,
                fiscalYear: period.fiscalYear,
                fiscalQuarter: period.fiscalQuarter ?? ANNUAL_QUARTER,
                metric: fact.metric,
              },
            },
            create: {
              symbol,
              statementType: statement.statementType as never,
              periodType: statement.periodType as never,
              fiscalYear: period.fiscalYear,
              fiscalQuarter: period.fiscalQuarter ?? ANNUAL_QUARTER,
              metric: fact.metric,
              ...data,
            },
            update: data,
          }),
        );
      }
    }
    if (writes.length === 0) return;
    try {
      await this.prisma.$transaction(writes);
    } catch (err) {
      // A cache write failing must never fail the request that produced the
      // data — the caller already holds a good answer from the vendor.
      this.logger.warn(
        `could not cache ${statement.statementType}/${statement.periodType} for ${symbol}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
