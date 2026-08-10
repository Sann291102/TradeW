import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LeaderElectionService } from '../common/leader-election';
import { PrismaService } from '../prisma/prisma.service';
import { PortfolioService } from './portfolio.service';
import { isTradingDay, istDateKey, istMidnightUtc } from '../discipline/market-calendar';

const SWEEP_MS = 10 * 60_000; // EOD capture, not price-driven — coarse cadence is enough
/** Lease name — see common/leader-election.ts. */
const PERFORMANCE_SWEEP_JOB = 'performance-snapshot-sweep';
/** How far back "ALL" ever looks — a bound, not a silent one: past this,
 *  Performance simply doesn't have data for an account this old yet in the
 *  paper platform's lifetime. */
const ALL_RANGE_DAYS = 730;

export type PortfolioValueRange = '1W' | '1M' | '3M' | '1Y' | 'ALL';
export type MonthlyReturnsRange = '3M' | '6M' | '1Y';

export interface PortfolioValuePoint {
  dateKey: string;
  value: number;
}
export interface DailyPnlBar {
  dateKey: string;
  realizedPnl: number;
  unrealizedPnl: number;
  netPnl: number;
}
export interface MonthlyReturnBar {
  month: string; // 'YYYY-MM'
  returnPct: number;
  pnl: number;
}
export interface PerformanceOverview {
  portfolioValue: number;
  prevClose: number;
  changeAmount: number;
  changePct: number;
  todaysPnl: number;
  overallPnl: number;
  /** Lifetime return: overallPnl as a percent of the wallet's starting
   *  capital — the spec's "Overall Return %". */
  overallReturnPct: number;
  investedAmount: number;
  availableBalance: number;
  unrealizedPnl: number;
  marginUsed: number;
  availableMargin: number;
  /** Lifetime count of completed round-trip trades (closing trades — same
   *  definition Trade History uses), and how many were wins vs losses. */
  totalTrades: number;
  winCount: number;
  lossCount: number;
}
export interface TodayPerformance {
  todaysPnl: number;
  todaysReturnPct: number;
  todaysTrades: number;
  todaysRealizedPnl: number;
  todaysUnrealizedPnl: number;
  todaysCharges: number;
  topGainer: { symbol: string; pnl: number } | null;
  topLoser: { symbol: string; pnl: number } | null;
}
export interface DiaryEntry {
  dateKey: string;
  openingValue: number;
  closingValue: number;
  dailyReturnPct: number;
  realizedPnl: number;
  unrealizedPnl: number;
  /** Always 0 — this paper wallet has no deposit/withdraw feature (see
   *  PerformanceService docstring). Surfaced rather than omitted so the UI's
   *  column has a real, honest value instead of a gap. */
  fundsInOut: number;
  tradesCount: number;
  winCount: number;
  lossCount: number;
  charges: number;
  bestPerformer: { symbol: string; pnl: number } | null;
  worstPerformer: { symbol: string; pnl: number } | null;
  /** Real snapshot for a captured EOD day; a derived best-effort read for
   *  any day before this feature existed (see the class docstring) — the
   *  UI should be able to tell the two apart. */
  source: 'snapshot' | 'derived';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Percent return of `to` over `from`, 0 when `from` is 0 (nothing to divide
 *  by rather than a fabricated Infinity/NaN). Exported for
 *  performance.spec.ts — pure, no database. */
export function pctReturn(from: number, to: number): number {
  if (from === 0) return 0;
  return round2(((to - from) / from) * 100);
}

/**
 * Performance charts and the Performance Diary — a hybrid of a real EOD
 * snapshot table (`PortfolioSnapshot`, captured once daily after session
 * close by the sweep below) and on-read derivation for any day that predates
 * this feature or fell in a gap. Two things this hybrid can and can't do,
 * stated plainly rather than glossed over:
 *
 *  - A CAPTURED day's `unrealizedPnl`/`closingValue` are live numbers frozen
 *    at (or shortly after) that day's real close — `PortfolioService.summary()`
 *    read right when the sweep fires.
 *  - A DERIVED day (no snapshot row) can only reconstruct the REALIZED side
 *    from the Trade log — there is no historical price data anywhere in this
 *    platform to know what an open position was worth at a past day's close,
 *    so a derived day's `unrealizedPnl` is always 0. `DiaryEntry.source`
 *    tells the UI which kind of day it's looking at rather than silently
 *    blending an approximation into a real number.
 *
 * "Today" is a special case handled entirely separately (`today()` below) —
 * always live from `PortfolioService.summary()`, never from a snapshot, so
 * the current trading day is never a day behind.
 */
@Injectable()
export class PerformanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PerformanceService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly portfolio: PortfolioService,
    private readonly leader: LeaderElectionService,
  ) {}

  onModuleInit(): void {
    this.leader.register(PERFORMANCE_SWEEP_JOB);
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Captures today's snapshot, once, for every user with a paper wallet —
   *  a no-op for a user whose today's row already exists (upsert), and a
   *  no-op entirely on a non-trading day (nothing closed to capture). */
  private async sweep(): Promise<void> {
    // Snapshot capture is an upsert, so a duplicate run is not corrupting — but
    // it is a full scan over every user with a wallet, and N replicas doing it
    // simultaneously is N× that load on the database for zero extra output.
    if (!this.leader.isLeader(PERFORMANCE_SWEEP_JOB)) return;
    if (!isTradingDay()) return;
    let userIds: string[];
    try {
      userIds = (await this.prisma.paperWallet.findMany({ select: { userId: true } })).map((w) => w.userId);
    } catch (err) {
      this.logger.error('sweep: failed to load wallets', err as Error);
      return;
    }
    for (const userId of userIds) {
      try {
        await this.captureSnapshot(userId);
      } catch (err) {
        this.logger.error(`sweep: failed to capture snapshot for ${userId}`, err as Error);
      }
    }
  }

  /** Captures `dateKey` (default today) from LIVE current state — correct
   *  precisely because this only ever runs for the current or just-closed
   *  session, never backdated (see the class docstring on why a past day
   *  can't be captured this way). Upsert, so re-running mid-day just
   *  refreshes today's row rather than erroring or duplicating. */
  async captureSnapshot(userId: string, dateKey: string = istDateKey()): Promise<void> {
    const [summary, dayAgg] = await Promise.all([this.portfolio.summary(userId), this.dayTradeAggregate(userId, dateKey)]);
    const openingValue = await this.openingValueFor(userId, dateKey, summary.netWorth - summary.dailyPnl);

    await this.prisma.portfolioSnapshot.upsert({
      where: { userId_dateKey: { userId, dateKey } },
      create: {
        userId,
        dateKey,
        openingValue,
        closingValue: summary.netWorth,
        cashBalance: summary.availableBalance,
        holdingsValue: summary.holdingsValue,
        positionsValue: summary.positionValue,
        marginUsed: summary.marginUsed,
        realizedPnl: dayAgg.realizedPnl,
        unrealizedPnl: summary.unrealizedPnl,
        charges: dayAgg.charges,
        tradesCount: dayAgg.tradesCount,
        winCount: dayAgg.winCount,
        lossCount: dayAgg.lossCount,
      },
      update: {
        closingValue: summary.netWorth,
        cashBalance: summary.availableBalance,
        holdingsValue: summary.holdingsValue,
        positionsValue: summary.positionValue,
        marginUsed: summary.marginUsed,
        realizedPnl: dayAgg.realizedPnl,
        unrealizedPnl: summary.unrealizedPnl,
        charges: dayAgg.charges,
        tradesCount: dayAgg.tradesCount,
        winCount: dayAgg.winCount,
        lossCount: dayAgg.lossCount,
      },
    });
  }

  /** The previous trading day's captured closingValue, or — if none exists
   *  yet (first-ever snapshot) — netWorth minus today's own dailyPnl, i.e.
   *  today's opening mark. Best-effort by construction: there is nothing
   *  more authoritative to open a brand-new account's history from. */
  private async openingValueFor(userId: string, dateKey: string, fallback: number): Promise<number> {
    const prior = await this.prisma.portfolioSnapshot.findFirst({
      where: { userId, dateKey: { lt: dateKey } },
      orderBy: { dateKey: 'desc' },
    });
    return prior ? Number(prior.closingValue) : round2(fallback);
  }

  private async dayTradeAggregate(
    userId: string,
    dateKey: string,
  ): Promise<{ realizedPnl: number; charges: number; tradesCount: number; winCount: number; lossCount: number }> {
    const { start, end } = dayBoundsUtc(dateKey);
    const trades = await this.prisma.trade.findMany({ where: { userId, executedAt: { gte: start, lt: end } } });
    const closing = trades.filter((t) => t.realizedPnl != null);
    return {
      realizedPnl: round2(closing.reduce((a, t) => a + Number(t.realizedPnl), 0)),
      charges: round2(trades.reduce((a, t) => a + Number(t.charges), 0)),
      tradesCount: trades.length,
      winCount: closing.filter((t) => Number(t.realizedPnl) > 0).length,
      lossCount: closing.filter((t) => Number(t.realizedPnl) < 0).length,
    };
  }

  /** Cumulative realized P&L + charges from every trade up to and including
   *  `dateKey`, and today's netWorth minus everything realized/charged since
   *  then — the derived best-effort reconstruction for a day with no
   *  snapshot (see class docstring: no historical price data exists, so
   *  this is realized-P&L-only, unrealizedPnl always 0). */
  private async derivedDay(userId: string, dateKey: string, startingBalance: number): Promise<DiaryEntry> {
    const { end } = dayBoundsUtc(dateKey);
    const upToTrades = await this.prisma.trade.findMany({ where: { userId, executedAt: { lt: end } } });
    const upToClosing = upToTrades.filter((t) => t.realizedPnl != null);
    const cumulativeRealized = round2(upToClosing.reduce((a, t) => a + Number(t.realizedPnl), 0));
    const cumulativeCharges = round2(upToTrades.reduce((a, t) => a + Number(t.charges), 0));
    const closingValue = round2(startingBalance + cumulativeRealized - cumulativeCharges);

    const dayAgg = await this.dayTradeAggregate(userId, dateKey);
    const openingValue = round2(closingValue - dayAgg.realizedPnl + dayAgg.charges);
    const movers = await this.dayMovers(userId, dateKey);

    return {
      dateKey,
      openingValue,
      closingValue,
      dailyReturnPct: pctReturn(openingValue, closingValue),
      realizedPnl: dayAgg.realizedPnl,
      unrealizedPnl: 0,
      fundsInOut: 0,
      tradesCount: dayAgg.tradesCount,
      winCount: dayAgg.winCount,
      lossCount: dayAgg.lossCount,
      charges: dayAgg.charges,
      bestPerformer: movers.best,
      worstPerformer: movers.worst,
      source: 'derived',
    };
  }

  private async dayMovers(
    userId: string,
    dateKey: string,
  ): Promise<{ best: DiaryEntry['bestPerformer']; worst: DiaryEntry['worstPerformer'] }> {
    const { start, end } = dayBoundsUtc(dateKey);
    const closing = await this.prisma.trade.findMany({
      where: { userId, executedAt: { gte: start, lt: end }, realizedPnl: { not: null } },
      include: { instrument: true },
    });
    if (closing.length === 0) return { best: null, worst: null };

    const byInstrument = new Map<string, number>();
    for (const t of closing) {
      byInstrument.set(t.instrument.symbol, (byInstrument.get(t.instrument.symbol) ?? 0) + Number(t.realizedPnl));
    }
    const entries = [...byInstrument.entries()].map(([symbol, pnl]) => ({ symbol, pnl: round2(pnl) }));
    entries.sort((a, b) => b.pnl - a.pnl);
    return { best: entries[0], worst: entries[entries.length - 1] };
  }

  async overview(userId: string): Promise<PerformanceOverview> {
    const [summary, prevSnapshot, lifetime] = await Promise.all([
      this.portfolio.summary(userId),
      this.prisma.portfolioSnapshot.findFirst({ where: { userId, dateKey: { lt: istDateKey() } }, orderBy: { dateKey: 'desc' } }),
      this.lifetimeTradeStats(userId),
    ]);
    const prevClose = prevSnapshot ? Number(prevSnapshot.closingValue) : summary.startingBalance;
    const changeAmount = round2(summary.netWorth - prevClose);

    return {
      portfolioValue: summary.netWorth,
      prevClose,
      changeAmount,
      changePct: pctReturn(prevClose, summary.netWorth),
      todaysPnl: summary.dailyPnl,
      overallPnl: summary.overallPnl,
      overallReturnPct: pctReturn(summary.startingBalance, summary.netWorth),
      investedAmount: summary.investedAmount,
      availableBalance: summary.availableBalance,
      unrealizedPnl: summary.unrealizedPnl,
      marginUsed: summary.marginUsed,
      availableMargin: summary.availableMargin,
      ...lifetime,
    };
  }

  /** Lifetime count of completed round-trip trades (Trade rows with
   *  realizedPnl set — same "closing trade" convention TradeHistoryService
   *  uses) and the win/loss split among them. */
  private async lifetimeTradeStats(userId: string): Promise<{ totalTrades: number; winCount: number; lossCount: number }> {
    const [totalTrades, winCount, lossCount] = await Promise.all([
      this.prisma.trade.count({ where: { userId, realizedPnl: { not: null } } }),
      this.prisma.trade.count({ where: { userId, realizedPnl: { gt: 0 } } }),
      this.prisma.trade.count({ where: { userId, realizedPnl: { lt: 0 } } }),
    ]);
    return { totalTrades, winCount, lossCount };
  }

  /** Always live — see class docstring. Never reads PortfolioSnapshot. */
  async today(userId: string): Promise<TodayPerformance> {
    const summary = await this.portfolio.summary(userId);
    const dateKey = istDateKey();
    const dayAgg = await this.dayTradeAggregate(userId, dateKey);
    const movers = await this.dayMovers(userId, dateKey);
    const openingValue = round2(summary.netWorth - summary.dailyPnl);

    return {
      todaysPnl: summary.dailyPnl,
      todaysReturnPct: pctReturn(openingValue, summary.netWorth),
      todaysTrades: dayAgg.tradesCount,
      todaysRealizedPnl: dayAgg.realizedPnl,
      todaysUnrealizedPnl: round2(summary.unrealizedPnl),
      todaysCharges: dayAgg.charges,
      topGainer: movers.best && movers.best.pnl > 0 ? movers.best : null,
      topLoser: movers.worst && movers.worst.pnl < 0 ? movers.worst : null,
    };
  }

  /**
   * Trading-day keys covering `range`, newest first, bounded by
   * `earliestDateKey` (the account's first trade, or today if there is
   * none) and by `ALL_RANGE_DAYS` — a stated bound, not a silent one.
   */
  private tradingDayKeys(range: PortfolioValueRange | MonthlyReturnsRange, earliestDateKey: string): string[] {
    const spanDays = { '1W': 7, '1M': 31, '3M': 93, '6M': 186, '1Y': 366, ALL: ALL_RANGE_DAYS }[range];
    const keys: string[] = [];
    const cursor = new Date();
    for (let i = 0; i < spanDays; i++) {
      const key = istDateKey(cursor);
      if (key < earliestDateKey) break;
      if (isTradingDay(cursor)) keys.push(key);
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return keys.reverse();
  }

  private async earliestDateKey(userId: string): Promise<string> {
    const firstTrade = await this.prisma.trade.findFirst({ where: { userId }, orderBy: { executedAt: 'asc' } });
    return firstTrade ? istDateKey(firstTrade.executedAt) : istDateKey();
  }

  private async dayEntry(userId: string, dateKey: string, startingBalance: number): Promise<DiaryEntry> {
    const snapshot = await this.prisma.portfolioSnapshot.findUnique({ where: { userId_dateKey: { userId, dateKey } } });
    if (!snapshot) return this.derivedDay(userId, dateKey, startingBalance);

    const movers = await this.dayMovers(userId, dateKey);
    return {
      dateKey,
      openingValue: Number(snapshot.openingValue),
      closingValue: Number(snapshot.closingValue),
      dailyReturnPct: pctReturn(Number(snapshot.openingValue), Number(snapshot.closingValue)),
      realizedPnl: Number(snapshot.realizedPnl),
      unrealizedPnl: Number(snapshot.unrealizedPnl),
      fundsInOut: 0,
      tradesCount: snapshot.tradesCount,
      winCount: snapshot.winCount,
      lossCount: snapshot.lossCount,
      charges: Number(snapshot.charges),
      bestPerformer: movers.best,
      worstPerformer: movers.worst,
      source: 'snapshot',
    };
  }

  async portfolioValueSeries(userId: string, range: PortfolioValueRange): Promise<PortfolioValuePoint[]> {
    const wallet = await this.prisma.paperWallet.findUnique({ where: { userId } });
    const startingBalance = wallet ? Number(wallet.startingBalance) : 0;
    const earliest = await this.earliestDateKey(userId);
    const keys = this.tradingDayKeys(range, earliest);
    const entries = await Promise.all(keys.map((k) => this.dayEntry(userId, k, startingBalance)));
    return entries.map((e) => ({ dateKey: e.dateKey, value: e.closingValue }));
  }

  async dailyPnl(userId: string, range: PortfolioValueRange): Promise<DailyPnlBar[]> {
    const wallet = await this.prisma.paperWallet.findUnique({ where: { userId } });
    const startingBalance = wallet ? Number(wallet.startingBalance) : 0;
    const earliest = await this.earliestDateKey(userId);
    const keys = this.tradingDayKeys(range, earliest);
    const entries = await Promise.all(keys.map((k) => this.dayEntry(userId, k, startingBalance)));
    return entries.map((e) => ({
      dateKey: e.dateKey,
      realizedPnl: e.realizedPnl,
      unrealizedPnl: e.unrealizedPnl,
      netPnl: round2(e.realizedPnl + e.unrealizedPnl),
    }));
  }

  async monthlyReturns(userId: string, range: MonthlyReturnsRange): Promise<MonthlyReturnBar[]> {
    const wallet = await this.prisma.paperWallet.findUnique({ where: { userId } });
    const startingBalance = wallet ? Number(wallet.startingBalance) : 0;
    const earliest = await this.earliestDateKey(userId);
    const keys = this.tradingDayKeys(range, earliest);
    const entries = await Promise.all(keys.map((k) => this.dayEntry(userId, k, startingBalance)));

    const byMonth = new Map<string, DiaryEntry[]>();
    for (const e of entries) {
      const month = e.dateKey.slice(0, 7);
      byMonth.set(month, [...(byMonth.get(month) ?? []), e]);
    }
    return [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, days]) => {
        const open = days[0].openingValue;
        const close = days[days.length - 1].closingValue;
        return { month, returnPct: pctReturn(open, close), pnl: round2(close - open) };
      });
  }

  async diary(userId: string, page: number, pageSize: number): Promise<{ rows: DiaryEntry[]; total: number }> {
    const wallet = await this.prisma.paperWallet.findUnique({ where: { userId } });
    const startingBalance = wallet ? Number(wallet.startingBalance) : 0;
    const earliest = await this.earliestDateKey(userId);
    const allKeys = this.tradingDayKeys('ALL', earliest).reverse(); // newest first
    const total = allKeys.length;
    const page_ = page > 0 ? Math.floor(page) : 1;
    const size = pageSize > 0 ? Math.min(Math.floor(pageSize), 200) : 30;
    const pageKeys = allKeys.slice((page_ - 1) * size, (page_ - 1) * size + size);
    const rows = await Promise.all(pageKeys.map((k) => this.dayEntry(userId, k, startingBalance)));
    return { rows, total };
  }
}

/** [start, end) UTC instants bracketing the IST calendar day `dateKey`. */
function dayBoundsUtc(dateKey: string): { start: Date; end: Date } {
  const start = istMidnightUtc(dateKey);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}
