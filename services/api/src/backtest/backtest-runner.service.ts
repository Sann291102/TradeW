import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BacktestStatus, Prisma } from '@prisma/client';
import { LeaderElectionService } from '../common/leader-election';
import { PrismaService } from '../prisma/prisma.service';
import { ENGINE_VERSION, configurationHash, type BacktestConfig } from './backtest-config';
import { computeMetrics, sampleEquity } from './backtest-metrics';
import { simulate, type SimBar, type SimSignal } from './execution-simulator';
import { BacktestScanRejected, SentinelBacktestClient } from './sentinel-backtest.client';

/**
 * The run queue: QUEUED → RUNNING → COMPLETED | FAILED | CANCELLED.
 *
 * ## Why a queue and not a synchronous request
 *
 * A replay over four months of 5m bars walks ~4,700 bars through the full
 * strategy engine. Holding an HTTP request open for that would tie a worker to
 * a browser tab that may already be closed, and there would be no way to show
 * progress, cancel, or survive a deploy. The user gets a row back immediately
 * and watches its status.
 *
 * ## Leader election is a correctness requirement, not a nicety
 *
 * Exactly the argument `ExecutionSchedulerService` and `MatchingEngineService`
 * record. Two replicas polling the same QUEUED row would both run it, both
 * write trades, and the second would violate the immutability rule by
 * overwriting a completed result. The claim below is additionally atomic
 * (`updateMany` guarded on `status: QUEUED`), so the lease is defence in depth
 * rather than the only guard — a losing replica loses on a row count of zero,
 * not on a check-then-act window.
 *
 * ## Restart recovery
 *
 * A process that dies mid-run leaves a RUNNING row nobody owns. On boot the
 * leader requeues any RUNNING row older than `STALE_RUN_MS` — safe precisely
 * because a run writes nothing until it succeeds, so there is no partial result
 * to clean up and re-running is a pure retry. That property is worth preserving
 * in any future change here.
 */

const RUN_JOB = 'backtest-run-queue';
const POLL_MS = Number(process.env.BACKTEST_POLL_MS ?? 3_000);
/** A RUNNING row untouched for this long is assumed orphaned by a dead worker. */
const STALE_RUN_MS = Number(process.env.BACKTEST_STALE_RUN_MS ?? 15 * 60_000);

@Injectable()
export class BacktestRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BacktestRunnerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  /** Backtest ids this process is actively running, so a cancel can be seen. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sentinel: SentinelBacktestClient,
    private readonly leader: LeaderElectionService,
  ) {}

  onModuleInit(): void {
    this.leader.register(RUN_JOB);
    this.timer = setInterval(() => void this.tick(), POLL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (!this.leader.isLeader(RUN_JOB)) return;
    if (this.busy) return;
    this.busy = true;
    try {
      await this.requeueStale();
      const next = await this.claimNext();
      if (next) await this.execute(next.id);
    } catch (err) {
      this.logger.error('backtest queue tick failed', err as Error);
    } finally {
      this.busy = false;
    }
  }

  /** Hand a dead worker's run back to the queue. */
  private async requeueStale(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_RUN_MS);
    const stale = await this.prisma.backtest.updateMany({
      where: { status: BacktestStatus.RUNNING, startedAt: { lt: cutoff } },
      data: { status: BacktestStatus.QUEUED, startedAt: null },
    });
    if (stale.count) this.logger.warn(`requeued ${stale.count} stale backtest run(s)`);
  }

  /**
   * Atomically take the oldest queued run.
   *
   * The `updateMany` is guarded on `status: QUEUED`, so two racing workers
   * cannot both claim it: the loser updates zero rows and moves on.
   */
  private async claimNext(): Promise<{ id: string } | null> {
    const candidate = await this.prisma.backtest.findFirst({
      where: { status: BacktestStatus.QUEUED },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!candidate) return null;

    const claimed = await this.prisma.backtest.updateMany({
      where: { id: candidate.id, status: BacktestStatus.QUEUED },
      data: { status: BacktestStatus.RUNNING, startedAt: new Date() },
    });
    return claimed.count === 1 ? candidate : null;
  }

  /** Run one backtest to a terminal state. Never throws to the caller. */
  async execute(backtestId: string): Promise<void> {
    this.inFlight.add(backtestId);
    const started = Date.now();
    try {
      const row = await this.prisma.backtest.findUnique({ where: { id: backtestId } });
      if (!row || row.status !== BacktestStatus.RUNNING) return;
      const cfg = row.configuration as unknown as BacktestConfig;

      const scan = await this.sentinel.scan({
        symbol: cfg.symbol,
        timeframe: cfg.timeframe,
        startAt: cfg.startAt,
        endAt: cfg.endAt,
        strategyId: cfg.strategyId,
        minConfidence: cfg.minConfidence,
        includeUnvalidated: cfg.includeUnvalidated,
      });

      if (await this.cancelled(backtestId)) return;

      // ── The one refusal that is a normal outcome, not a fault ────────────
      // No bars means no backtest. Saying so plainly is the whole of this
      // codebase's data-honesty rule: nothing is substituted, nothing is
      // synthesised, and the row records exactly why.
      if (scan.coverage.empty || scan.bars.length === 0) {
        await this.fail(
          backtestId,
          `Historical data unavailable for the selected period. No ${cfg.timeframe} bars are stored for ` +
            `${cfg.symbol} between ${cfg.startAt.slice(0, 10)} and ${cfg.endAt.slice(0, 10)}.`,
          { coverage: scan.coverage },
        );
        return;
      }

      const instrument = scan.instrumentId
        ? await this.prisma.instrument.findUnique({ where: { id: scan.instrumentId } })
        : null;
      if (!instrument) {
        await this.fail(backtestId, `The instrument for ${cfg.symbol} could not be resolved.`, null);
        return;
      }

      const bars: SimBar[] = scan.bars.map((b) => ({
        t: new Date(b.t).getTime(),
        o: b.o,
        h: b.h,
        l: b.l,
        c: b.c,
        v: b.v,
      }));
      const signals: SimSignal[] = scan.signals.map((s) => ({
        barIndex: s.barIndex,
        nextBarIndex: s.nextBarIndex,
        strategyId: s.strategyId,
        strategyName: s.strategyName,
        confidence: s.confidence,
        bias: s.bias,
        rulesMatched: s.rulesMatched,
        context: s.context ?? null,
      }));

      const sim = simulate(bars, signals, cfg, instrument);
      const firstBarAt = new Date(bars[0].t);
      const lastBarAt = new Date(bars[bars.length - 1].t);
      const metrics = computeMetrics({
        sim,
        initialCapital: cfg.initialCapital,
        timeframe: cfg.timeframe,
        firstBarAt,
        lastBarAt,
      });

      if (await this.cancelled(backtestId)) return;

      // Every bar a trade touched is pinned into the stored curve, so the chart
      // and the trade table can never disagree about when something happened.
      const pinned = new Set<number>();
      for (const t of sim.trades) {
        pinned.add(t.entryBarIndex);
        pinned.add(t.exitBarIndex);
      }
      const curve = sampleEquity(sim.equity, pinned);

      const hash = configurationHash(cfg, scan.strategyVersion, scan.coverage.dataVersion);
      const strategy = resolveStrategyIdentity(cfg, scan);

      await this.prisma.$transaction(
        async (tx) => {
          // Guarded on RUNNING: a cancel that landed between the last check and
          // here wins, and the completed result is never written over it.
          const claimed = await tx.backtest.updateMany({
            where: { id: backtestId, status: BacktestStatus.RUNNING },
            data: {
              status: BacktestStatus.COMPLETED,
              completedAt: new Date(),
              strategyId: strategy.id,
              strategyName: strategy.name,
              strategyVersion: scan.strategyVersion,
              instrumentId: instrument.id,
              exchange: instrument.exchange,
              configurationHash: hash,
              engineVersion: ENGINE_VERSION,
              firstBarAt,
              lastBarAt,
              barCount: bars.length,
              dataSource: scan.coverage.source,
              dataVersion: scan.coverage.dataVersion,
              dataGaps: {
                missingSessions: scan.coverage.missingSessions,
                intraSessionGaps: scan.coverage.intraSessionGaps,
                sessionCount: scan.coverage.sessionCount,
                warmupBars: scan.warmupBars,
              } as Prisma.InputJsonValue,

              finalCapital: metrics.finalCapital,
              totalPnl: metrics.totalPnl,
              totalReturnPct: metrics.totalReturnPct,
              cagrPct: metrics.cagrPct,
              totalTrades: metrics.totalTrades,
              winningTrades: metrics.winningTrades,
              losingTrades: metrics.losingTrades,
              winRatePct: metrics.winRatePct,
              profitFactor: metrics.profitFactor,
              expectancy: metrics.expectancy,
              maxDrawdownPct: metrics.maxDrawdownPct,
              maxDrawdownAmount: metrics.maxDrawdownAmount,
              maxDrawdownDays: metrics.maxDrawdownDays,
              sharpe: metrics.sharpe,
              sortino: metrics.sortino,
              volatilityPct: metrics.volatilityPct,
              totalFees: metrics.totalFees,
              totalSlippage: metrics.totalSlippage,
              rejectedSignals: metrics.rejectedSignals,
              skippedSignals: metrics.skippedSignals,
              exposurePct: metrics.exposurePct,
              metrics: metrics as unknown as Prisma.InputJsonValue,
            },
          });
          if (claimed.count !== 1) return;

          if (sim.trades.length) {
            await tx.backtestTrade.createMany({
              data: sim.trades.map((t) => ({
                backtestId,
                sequence: t.sequence,
                instrumentSymbol: instrument.symbol,
                instrumentType: instrument.type,
                side: t.side,
                underlying: instrument.underlying,
                strike: instrument.strikePrice,
                expiry: instrument.expiryDate,
                optionType: instrument.optionType,
                entryTime: t.entryTime,
                entryPrice: t.entryPrice,
                entryQuantity: t.entryQuantity,
                lots: instrument.lotSize > 1 ? Math.round(t.entryQuantity / instrument.lotSize) : null,
                exitTime: t.exitTime,
                exitPrice: t.exitPrice,
                exitReason: t.exitReason,
                grossPnl: t.grossPnl,
                fees: t.fees,
                slippageCost: t.slippageCost,
                netPnl: t.netPnl,
                holdingSeconds: t.holdingSeconds,
                barsHeld: t.barsHeld,
                cashAfter: t.cashAfter,
                strategyReason: t.strategyReason,
                marketContext: (t.marketContext ?? undefined) as Prisma.InputJsonValue | undefined,
                stopPrice: t.stopPrice,
                targetPrice: t.targetPrice,
              })),
            });
          }

          if (curve.length) {
            await tx.backtestEquityPoint.createMany({
              data: curve.map((p) => ({
                backtestId,
                at: p.at,
                sequence: p.sequence,
                cash: p.cash,
                portfolioValue: p.portfolioValue,
                realizedPnl: p.realizedPnl,
                unrealizedPnl: p.unrealizedPnl,
                drawdownPct: p.drawdownPct,
                openPositions: p.openPositions,
              })),
            });
          }
        },
        { timeout: 120_000 },
      );

      this.logger.log(
        `backtest ${backtestId} completed in ${Date.now() - started}ms — ` +
          `${metrics.totalTrades} trades, ${metrics.totalReturnPct}% return`,
      );
    } catch (err) {
      const message =
        err instanceof BacktestScanRejected
          ? extractMessage(err.message)
          : `The backtest engine failed: ${(err as Error).message}`;
      this.logger.error(`backtest ${backtestId} failed: ${message}`);
      await this.fail(backtestId, message, null).catch(() => undefined);
    } finally {
      this.inFlight.delete(backtestId);
    }
  }

  /** Did someone cancel this run while it was in flight? */
  private async cancelled(backtestId: string): Promise<boolean> {
    const row = await this.prisma.backtest.findUnique({ where: { id: backtestId }, select: { status: true } });
    return row?.status !== BacktestStatus.RUNNING;
  }

  /**
   * Terminal failure. Guarded on RUNNING so a cancelled run is not relabelled
   * as failed, and so a terminal row is never rewritten.
   */
  private async fail(backtestId: string, reason: string, gaps: object | null): Promise<void> {
    await this.prisma.backtest.updateMany({
      where: { id: backtestId, status: BacktestStatus.RUNNING },
      data: {
        status: BacktestStatus.FAILED,
        failureReason: reason,
        completedAt: new Date(),
        ...(gaps ? { dataGaps: gaps as Prisma.InputJsonValue } : {}),
      },
    });
  }
}

/**
 * Which strategy the result is attributed to.
 *
 * In 'auto' mode the request named none, so the row would otherwise say
 * "auto" forever — useless for filtering and for comparison. When every trade
 * came from one strategy, that strategy is named; when several fired, the row
 * keeps 'auto' and the per-trade attribution carries the detail.
 */
function resolveStrategyIdentity(
  cfg: BacktestConfig,
  scan: { strategiesConsidered: { id: string; name: string }[]; signals: { strategyId: string }[] },
): { id: string; name: string } {
  if (cfg.strategyId) {
    const named = scan.strategiesConsidered.find((s) => s.id === cfg.strategyId);
    return { id: cfg.strategyId, name: named?.name ?? cfg.strategyId };
  }
  const distinct = Array.from(new Set(scan.signals.map((s) => s.strategyId)));
  if (distinct.length === 1) {
    const only = scan.strategiesConsidered.find((s) => s.id === distinct[0]);
    return { id: distinct[0], name: only?.name ?? distinct[0] };
  }
  return { id: 'auto', name: `Auto (${distinct.length || scan.strategiesConsidered.length} strategies)` };
}

/** Nest serialises an exception body as JSON; show the human sentence. */
function extractMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { message?: string | string[] };
    if (Array.isArray(parsed.message)) return parsed.message.join('; ');
    if (parsed.message) return parsed.message;
  } catch {
    /* not JSON — use it as-is */
  }
  return raw;
}
