import { Injectable } from '@nestjs/common';
import { ExecutionIntentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MarketPriceService } from '../sim/market-price.service';
import { istParts } from './execution-identity';
import { ExecutionSchedulerService } from './execution-scheduler.service';
import { SystemExecutionControlService } from './system-execution-control.service';

/**
 * "Is Sentinel paper trading actually alive right now?" — as ONE payload the
 * console renders, every field derived from real state.
 *
 * Nothing here is a hard-coded label. The loop's liveness is this process's own
 * timers and leader leases; the session is the shared NSE calendar; the feed
 * timestamp is the bridge's freshest tick; the day's counts, the latest
 * execution and the latest refusal are rows the loop and the OMS wrote. A green
 * status on this endpoint means the machinery genuinely did the thing, not that
 * a UI decided to show a dot.
 */
@Injectable()
export class ExecutionHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: ExecutionSchedulerService,
    private readonly control: SystemExecutionControlService,
    private readonly marketPrice: MarketPriceService,
  ) {}

  async health() {
    const dayStart = istMidnight(new Date());
    const [loop, control, marketData, armedProfiles, byStatus, todayOutcomes, latestExecution, latestRejection, latestFailure] =
      await Promise.all([
        // Process facts — timers, leader leases, heartbeats, live session.
        Promise.resolve(this.scheduler.status()),
        this.control.current(),
        // A real probe of the feed: reachable? market open? how old is its tick?
        this.marketPrice.feedHealth(),
        this.prisma.executionProfile.count({ where: { enabled: true, environment: 'PAPER' } }),
        this.prisma.executionIntent.groupBy({
          by: ['status'],
          where: { decidedAt: { gte: dayStart } },
          _count: { _all: true },
        }),
        this.prisma.executionOutcome.findMany({
          where: { exitAt: { gte: dayStart }, result: { in: ['WIN', 'LOSS', 'SCRATCH'] } },
          select: { realizedPnl: true },
        }),
        // The most recent decision that actually reached the OMS.
        this.latestIntent([ExecutionIntentStatus.SUBMITTED, ExecutionIntentStatus.FILLED, ExecutionIntentStatus.CLOSED]),
        // The most recent policy refusal (nothing was placed).
        this.latestIntent([ExecutionIntentStatus.REJECTED]),
        // The most recent failure (submission raised, OMS rejection, orphan recovery).
        this.latestIntent([ExecutionIntentStatus.FAILED]),
      ]);

    const countFor = (statuses: ExecutionIntentStatus[]) =>
      byStatus.filter((s) => statuses.includes(s.status)).reduce((n, s) => n + s._count._all, 0);

    return {
      generatedAt: new Date().toISOString(),
      // The single headline the console's status dot reads. RUNNING only when the
      // env flag is on, this process holds the evaluate lease, and the kill
      // switch permits entries — anything else is an honest, named non-running
      // state rather than a dot that lies.
      status: this.headline(loop, control.mode),
      loop,
      control,
      marketData,
      today: {
        armedProfiles,
        intentsByStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
        orders: countFor([ExecutionIntentStatus.SUBMITTED, ExecutionIntentStatus.FILLED, ExecutionIntentStatus.CLOSED]),
        fills: countFor([ExecutionIntentStatus.FILLED, ExecutionIntentStatus.CLOSED]),
        openPositions: countFor([ExecutionIntentStatus.FILLED]),
        rejections: countFor([ExecutionIntentStatus.REJECTED, ExecutionIntentStatus.FAILED]),
        realizedPnl: round2(todayOutcomes.reduce((n, o) => n + Number(o.realizedPnl), 0)),
        closedOutcomes: todayOutcomes.length,
      },
      latest: {
        execution: latestExecution,
        rejection: latestRejection,
        failure: latestFailure,
      },
    };
  }

  /** One-word headline for the status dot, derived — never asserted. */
  private headline(
    loop: ReturnType<ExecutionSchedulerService['status']>,
    mode: string,
  ): 'RUNNING' | 'HALTED' | 'PAUSED' | 'IDLE' | 'DISABLED' {
    if (!loop.enabled) return 'DISABLED'; // env flag off — no timers exist
    if (mode === 'EMERGENCY_STOP') return 'HALTED';
    if (mode === 'OFF') return 'PAUSED';
    // Timers exist and entries are permitted. RUNNING only when this process is
    // the one actually evaluating; a replica that holds no lease is IDLE, not a
    // second "running" claim.
    return loop.isEvaluateLeader ? 'RUNNING' : 'IDLE';
  }

  private async latestIntent(statuses: ExecutionIntentStatus[]) {
    const intent = await this.prisma.executionIntent.findFirst({
      where: { status: { in: statuses } },
      orderBy: { decidedAt: 'desc' },
      select: {
        id: true,
        decidedAt: true,
        status: true,
        symbol: true,
        contractSymbol: true,
        confidence: true,
        rejectReason: true,
        rejectCheckId: true,
        profile: { select: { name: true } },
      },
    });
    if (!intent) return null;
    return {
      id: intent.id,
      decidedAt: intent.decidedAt.toISOString(),
      status: intent.status,
      symbol: intent.symbol,
      contractSymbol: intent.contractSymbol,
      confidence: intent.confidence,
      profileName: intent.profile.name,
      rejectReason: intent.rejectReason,
      rejectCheckId: intent.rejectCheckId,
    };
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function istMidnight(now: Date): Date {
  return new Date(`${istParts(now).dayKey}T00:00:00+05:30`);
}
