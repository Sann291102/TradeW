import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { derived, eod, Sourced, unavailable } from './sourced';

/**
 * Price history and derived market figures for a company.
 *
 * ── WHAT IT READS ──────────────────────────────────────────────────────────
 * Daily `Candle` rows, sourced from NSE bhavcopy by `services/company-data`.
 * Nothing here fetches: the API layer reads what ingestion has already written
 * and validated, which is what keeps a page render off the critical path of an
 * unofficial third-party endpoint.
 *
 * ── WHY 52 WEEKS IS COMPUTED, NOT STORED ───────────────────────────────────
 * A stored 52-week high would need recomputing for every company on every
 * session — 2,355 rows rewritten daily to answer a question Postgres answers in
 * a millisecond from an index that already exists. It becomes worth storing
 * when the screener needs to filter on it across the whole market at once
 * (plan §K, `DerivedMetric`), and not before.
 *
 * ── MARKET CAP, AND WHY IT TOOK A STATEMENT PIPELINE ───────────────────────
 * Market cap is shares × price, and the share count is the hard half. It is not
 * in the equity list (face value and paid-up value are both PER SHARE), and the
 * NSE quote endpoint that would carry it answers 403. It comes from the filings:
 *
 *   shares = PaidUpValueOfEquityShareCapital / FaceValueOfEquityShareCapital
 *
 * both in rupees, so the quotient is a count.
 *
 * THE COUNT MUST COME FROM THE LATEST FILING. RELIANCE's paid-up capital reads
 * ₹6,766 cr in the FY2024 filing and ₹13,532 cr in the most recent one — the
 * 1:1 bonus issue doubled the share count from 676.6 cr to 1,353.2 cr. Taking
 * "a" filing rather than the newest would halve or double the market cap of
 * every company that has issued bonus shares, and the number would look
 * perfectly plausible.
 */

const DAY_MS = 86_400_000;

export interface CompanyMarketSnapshot {
  companyId: string;
  symbol: string | null;
  tradable: boolean;
  lastClose: Sourced<number>;
  previousClose: Sourced<number>;
  dayChange: Sourced<{ absolute: number; percent: number }>;
  fiftyTwoWeekHigh: Sourced<number>;
  fiftyTwoWeekLow: Sourced<number>;
  /** Where the last close sits between the 52w low and high, 0..100. */
  fiftyTwoWeekPosition: Sourced<number>;
  averageVolume20d: Sourced<number>;
  lastVolume: Sourced<number>;
  /** Shares × last close. Null until the company's filings have been ingested. */
  marketCap: Sourced<number>;
  sharesOutstanding: Sourced<number>;
  /** Sessions held in the last 52 weeks — how much history the figures rest on. */
  sessionsAvailable: number;
}

export interface ChartPoint {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Ranges the chart offers. `max` is bounded by what has been ingested. */
export const CHART_RANGES = {
  '1m': 31,
  '3m': 92,
  '6m': 183,
  '1y': 365,
  '3y': 1095,
  '5y': 1826,
  max: 36_500,
} as const;

export type ChartRange = keyof typeof CHART_RANGES;

@Injectable()
export class CompanyMarketService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The primary listing's instrument, or null when the company has no tradable
   * listing. 198 of 2,553 NSE companies are in that state — researchable but
   * not priceable — and it is a normal answer, not a 404.
   */
  private async primaryInstrument(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        listings: {
          orderBy: { isPrimary: 'desc' },
          select: { symbol: true, instrumentId: true, isPrimary: true },
        },
      },
    });
    if (!company) throw new NotFoundException(`No company with id ${companyId}`);
    const listing = company.listings[0] ?? null;
    return { listing, instrumentId: listing?.instrumentId ?? null };
  }

  async snapshot(companyId: string): Promise<CompanyMarketSnapshot> {
    const { listing, instrumentId } = await this.primaryInstrument(companyId);

    const base = {
      companyId,
      symbol: listing?.symbol ?? null,
      tradable: instrumentId !== null,
      sessionsAvailable: 0,
    };

    if (!instrumentId) {
      const none = unavailable<number>('company has no tradable listing');
      return {
        ...base,
        lastClose: none,
        previousClose: none,
        dayChange: unavailable('company has no tradable listing'),
        fiftyTwoWeekHigh: none,
        fiftyTwoWeekLow: none,
        fiftyTwoWeekPosition: none,
        averageVolume20d: none,
        lastVolume: none,
        marketCap: none,
        sharesOutstanding: await this.sharesOutstanding(companyId),
      };
    }

    const since = new Date(Date.now() - 365 * DAY_MS);

    // One pass, newest first. 52 weeks of daily bars is ~250 rows per company —
    // small enough that fetching them and reducing in memory is cheaper than
    // three separate aggregate round trips.
    const candles = await this.prisma.candle.findMany({
      where: { instrumentId, timeframe: '1d', bucketStart: { gte: since } },
      orderBy: { bucketStart: 'desc' },
      select: { bucketStart: true, open: true, high: true, low: true, close: true, volume: true },
    });

    if (candles.length === 0) {
      const none = unavailable<number>('no daily price history ingested for this instrument');
      return {
        ...base,
        lastClose: none,
        previousClose: none,
        dayChange: unavailable('no daily price history ingested for this instrument'),
        fiftyTwoWeekHigh: none,
        fiftyTwoWeekLow: none,
        fiftyTwoWeekPosition: none,
        averageVolume20d: none,
        lastVolume: none,
        marketCap: none,
        sharesOutstanding: await this.sharesOutstanding(companyId),
      };
    }

    const latest = candles[0];
    const prior = candles[1];
    const session = latest.bucketStart;

    let high = Number(latest.high);
    let low = Number(latest.low);
    for (const c of candles) {
      const h = Number(c.high);
      const l = Number(c.low);
      if (h > high) high = h;
      if (l < low) low = l;
    }

    const lastClose = Number(latest.close);
    const prevClose = prior ? Number(prior.close) : null;

    // 20 sessions, or as many as exist. Reporting an average over 4 days as a
    // "20-day average" would be a quiet lie, so the shortfall is flagged.
    const volumeWindow = candles.slice(0, 20);
    const avgVolume =
      volumeWindow.reduce((sum, c) => sum + Number(c.volume), 0) / (volumeWindow.length || 1);

    const span = high - low;
    const shares = await this.sharesOutstanding(companyId);

    return {
      ...base,
      sessionsAvailable: candles.length,
      lastClose: eod(lastClose, session),
      previousClose: prevClose === null ? unavailable('only one session held') : eod(prevClose, prior!.bucketStart),
      dayChange:
        prevClose === null || prevClose === 0
          ? unavailable('no previous close to compare against')
          : derived(
              {
                absolute: round(lastClose - prevClose, 2),
                percent: round(((lastClose - prevClose) / prevClose) * 100, 2),
              },
              { periodStart: prior!.bucketStart, periodEnd: session },
            ),
      fiftyTwoWeekHigh: derived(high, {
        periodStart: candles[candles.length - 1].bucketStart,
        periodEnd: session,
        flags: shortHistoryFlag(candles.length),
      }),
      fiftyTwoWeekLow: derived(low, {
        periodStart: candles[candles.length - 1].bucketStart,
        periodEnd: session,
        flags: shortHistoryFlag(candles.length),
      }),
      // Guarded against a flat series: a company that traded at one price all
      // year would divide by zero, and "NaN%" on a research page is worse than
      // saying the range is degenerate.
      fiftyTwoWeekPosition:
        span > 0
          ? derived(round(((lastClose - low) / span) * 100, 1), { periodEnd: session })
          : unavailable('52-week high and low are identical'),
      averageVolume20d: derived(Math.round(avgVolume), {
        periodEnd: session,
        flags: volumeWindow.length < 20 ? [`only ${volumeWindow.length} sessions available`] : undefined,
      }),
      lastVolume: eod(Number(latest.volume), session),
      sharesOutstanding: shares,
      marketCap:
        shares.value == null
          ? unavailable('share count needs the company\'s filings to be ingested')
          : derived(Math.round(shares.value * lastClose), {
              periodEnd: session,
              // Both inputs are named, because a market cap is only as current
              // as its share count and the count is as old as the last filing.
              flags: [
                `${shares.value.toLocaleString('en-IN')} shares from the filing dated ` +
                  `${shares.effectiveAt?.slice(0, 10) ?? 'unknown'}, at the ${session.toISOString().slice(0, 10)} close`,
                ...(shares.flags ?? []),
              ],
            }),
    };
  }

  /**
   * Shares outstanding, from the most recent filing that reports both halves.
   *
   * Ordered by period end descending and taking the FIRST usable pair — see the
   * class comment for why "most recent" is load-bearing rather than tidy.
   */
  private async sharesOutstanding(companyId: string): Promise<Sourced<number>> {
    const statements = await this.prisma.financialStatement.findMany({
      where: { companyId, lineItems: { some: { conceptKey: 'equity.paid-up-capital' } } },
      orderBy: { periodEnd: 'desc' },
      take: 6,
      select: {
        periodEnd: true,
        announcedAt: true,
        lineItems: {
          where: { conceptKey: { in: ['equity.paid-up-capital', 'equity.face-value'] } },
          select: { conceptKey: true, value: true },
        },
      },
    });

    for (const statement of statements) {
      const paidUp = statement.lineItems.find((l) => l.conceptKey === 'equity.paid-up-capital');
      const faceValue = statement.lineItems.find((l) => l.conceptKey === 'equity.face-value');
      if (!paidUp || !faceValue) continue;

      const face = Number(faceValue.value);
      // A zero or absent face value would divide to Infinity and render as a
      // market cap of ₹Infinity crore rather than as the missing datum it is.
      if (!Number.isFinite(face) || face <= 0) continue;

      const shares = Number(paidUp.value) / face;
      if (!Number.isFinite(shares) || shares <= 0) continue;

      const ageDays = (Date.now() - statement.periodEnd.getTime()) / DAY_MS;
      return {
        value: Math.round(shares),
        status: 'filing',
        source: { provider: 'NSE results XBRL', tier: 1 },
        effectiveAt: statement.periodEnd.toISOString(),
        frequency: 'quarterly',
        // A share count older than about two quarters may predate a bonus,
        // split or buyback, and the market cap derived from it would be wrong
        // by exactly that factor.
        ...(ageDays > 200 ? { flags: [`share count is ${Math.floor(ageDays)} days old`] } : {}),
      };
    }

    return unavailable('no filing reports paid-up capital and face value');
  }

  /** Daily OHLCV for a range, oldest first — the shape a chart consumes. */
  async chart(companyId: string, range: ChartRange = '1y'): Promise<{
    symbol: string | null;
    range: ChartRange;
    points: ChartPoint[];
    source: string;
    flags?: string[];
  }> {
    const { listing, instrumentId } = await this.primaryInstrument(companyId);
    if (!instrumentId) {
      return { symbol: listing?.symbol ?? null, range, points: [], source: 'none', flags: ['company has no tradable listing'] };
    }

    const since = new Date(Date.now() - CHART_RANGES[range] * DAY_MS);
    const candles = await this.prisma.candle.findMany({
      where: { instrumentId, timeframe: '1d', bucketStart: { gte: since } },
      orderBy: { bucketStart: 'asc' },
      select: { bucketStart: true, open: true, high: true, low: true, close: true, volume: true },
    });

    return {
      symbol: listing?.symbol ?? null,
      range,
      source: 'nse-bhavcopy',
      points: candles.map((c) => ({
        t: c.bucketStart.toISOString().slice(0, 10),
        o: Number(c.open),
        h: Number(c.high),
        l: Number(c.low),
        c: Number(c.close),
        v: Number(c.volume),
      })),
      // A caller asking for 5 years and receiving 250 points must be able to
      // tell that from a company that only listed last year.
      ...(candles.length === 0 ? { flags: ['no daily history ingested for this instrument'] } : {}),
    };
  }
}

/**
 * A "52-week" figure computed over materially less than 52 weeks is not wrong,
 * but it is not what the label says either. ~250 sessions is a full year; below
 * ~200 the shortfall is worth surfacing.
 */
function shortHistoryFlag(sessions: number): string[] | undefined {
  return sessions < 200 ? [`computed over ${sessions} sessions, fewer than a full year`] : undefined;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
