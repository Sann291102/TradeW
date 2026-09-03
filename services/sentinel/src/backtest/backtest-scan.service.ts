import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Candle, CandleInterval } from '@tradew/types';
import { PrismaService } from '../prisma.service';
import { TIMEFRAME_MINUTES, type StoredBar, analyseCoverage } from './historical-bars';
import type { BacktestScanRequest, BacktestScanResponse, ReplayBar } from './replay-contract';
import { StrategyReplayService } from './strategy-replay.service';

/**
 * Loads the stored bars for a window and hands them to the replay.
 *
 * ## Canonical data only
 *
 * The only source is the `Candle` table — the same rows the live provider falls
 * back to and the same rows `backfill-candles.ts` writes. There is deliberately
 * no live-feed tier here and no simulator tier: a backtest that quietly mixed
 * today's live prices into a historical window, or filled a hole with generated
 * bars, would produce a number nobody could trust and nobody could detect.
 * Missing data comes back as missing data.
 *
 * That is the same decision the market-data provider already made when its
 * simulated fallback was removed on 2026-07-26, for the same reason.
 */

/** Bounds on a request, so a typo cannot ask for a decade of 1m bars. */
const MAX_BARS = 200_000;
const MAX_WINDOW_DAYS = 3_650;

/** Bumped when a change here could move which bars a replay sees. */
export const SCAN_VERSION = '1.0.0';

@Injectable()
export class BacktestScanService {
  private readonly logger = new Logger(BacktestScanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly replay: StrategyReplayService,
  ) {}

  async scan(req: BacktestScanRequest): Promise<BacktestScanResponse> {
    const from = parseInstant(req.startAt, 'startAt');
    const to = parseInstant(req.endAt, 'endAt');
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('startAt must be before endAt.');
    }
    if (!TIMEFRAME_MINUTES[req.timeframe]) {
      throw new BadRequestException(`Unsupported timeframe "${req.timeframe}".`);
    }
    const windowDays = (to.getTime() - from.getTime()) / 86_400_000;
    if (windowDays > MAX_WINDOW_DAYS) {
      throw new BadRequestException(`Window is ${Math.round(windowDays)} days; the maximum is ${MAX_WINDOW_DAYS}.`);
    }

    const instrument = await this.prisma.instrument.findUnique({
      where: { symbol: req.symbol },
      select: { id: true, symbol: true, exchange: true, type: true, lotSize: true },
    });
    if (!instrument) {
      throw new BadRequestException(`No instrument is known by the symbol "${req.symbol}".`);
    }

    const rows = await this.prisma.candle.findMany({
      where: { instrumentId: instrument.id, timeframe: req.timeframe, bucketStart: { gte: from, lte: to } },
      orderBy: { bucketStart: 'asc' },
      take: MAX_BARS + 1,
    });
    if (rows.length > MAX_BARS) {
      throw new BadRequestException(
        `That window contains more than ${MAX_BARS} ${req.timeframe} bars. Narrow the period or use a larger timeframe.`,
      );
    }

    const stored: StoredBar[] = rows.map((r) => ({
      bucketStart: r.bucketStart,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      openInterest: r.openInterest == null ? null : Number(r.openInterest),
      source: r.source,
      createdAt: r.createdAt,
    }));

    const coverage = analyseCoverage(stored, req.timeframe, from, to);
    const bars: Candle[] = stored.map(toCandle);

    // Daily bars for the prior-day pivot. Reaches back beyond the window's own
    // start on purpose: the very first replayed session needs the day BEFORE
    // it, which by definition is outside the requested range.
    const dailyRows = bars.length
      ? await this.prisma.candle.findMany({
          where: {
            instrumentId: instrument.id,
            timeframe: '1d',
            bucketStart: { gte: new Date(from.getTime() - 20 * 86_400_000), lte: to },
          },
          orderBy: { bucketStart: 'asc' },
        })
      : [];
    const dailyBars: Candle[] = dailyRows.map((r) =>
      toCandle({
        bucketStart: r.bucketStart,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
        openInterest: r.openInterest == null ? null : Number(r.openInterest),
        source: r.source,
        createdAt: r.createdAt,
      }),
    );

    const result = bars.length
      ? this.replay.replay({
          symbol: instrument.symbol,
          bars,
          dailyBars,
          strategyId: req.strategyId,
          minConfidence: req.minConfidence,
          includeUnvalidated: req.includeUnvalidated ?? false,
        })
      : { signals: [], warmupBars: 0, considered: [], strategyVersion: 'no-data' };

    return {
      symbol: instrument.symbol,
      exchange: instrument.exchange,
      instrumentId: instrument.id,
      instrumentType: instrument.type,
      lotSize: instrument.lotSize,
      timeframe: req.timeframe as CandleInterval,
      coverage,
      bars: stored.map(toWireBar),
      signals: result.signals,
      strategyVersion: result.strategyVersion,
      strategiesConsidered: result.considered,
      warmupBars: result.warmupBars,
      scanVersion: SCAN_VERSION,
    };
  }
}

function parseInstant(value: string, field: string): Date {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new BadRequestException(`${field} is not a valid instant.`);
  return at;
}

function toCandle(b: StoredBar): Candle {
  return {
    timestamp: b.bucketStart,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    ...(b.openInterest == null ? {} : { openInterest: b.openInterest }),
  };
}

function toWireBar(b: StoredBar): ReplayBar {
  return {
    t: b.bucketStart.toISOString(),
    o: b.open,
    h: b.high,
    l: b.low,
    c: b.close,
    v: b.volume,
    ...(b.openInterest == null ? {} : { oi: b.openInterest }),
  };
}
