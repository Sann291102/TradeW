import { Injectable } from '@nestjs/common';
import { ExecutionIntentStatus, ExecutionPositionState } from '@prisma/client';
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
 * timestamp is the bridge's freshest index tick (the same `feedFreshness()`
 * read the entry and exit gates use); open positions are the
 * `ExecutionPosition` rows in OPEN/EXITING — the same test wallet reset uses
 * to refuse — and the day's counts, the latest execution and the latest
 * refusal are rows the loop and the OMS wrote. A green
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
    const now = new Date();
    const dayStart = istMidnight(now);
    const [
      loop,
      control,
      feed,
      armedProfiles,
      openPositions,
      byStatus,
      todayOutcomes,
      latestExecution,
      latestRejection,
      latestFailure,
    ] =
      await Promise.all([
        // Process facts — timers, leader leases, heartbeats, live session.
        Promise.resolve(this.scheduler.status()),
        this.control.current(),
        // The same feed read the entry gate and the position manager use:
        // the newest index tick the bridge reported, null when unreachable.
        this.marketPrice.feedFreshness(),
        this.prisma.executionProfile.count({ where: { enabled: true, environment: 'PAPER' } }),
        // Live agent positions, whatever day they were opened on.
        this.prisma.executionPosition.count({
          where: { state: { in: [ExecutionPositionState.OPEN, ExecutionPositionState.EXITING] } },
        }),
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
      generatedAt: now.toISOString(),
      // The single headline the console's status dot reads. RUNNING only when the
      // env flag is on, this process holds the evaluate lease, and the kill
      // switch permits entries — anything else is an honest, named non-running
      // state rather than a dot that lies.
      status: this.headline(loop, control.mode),
      loop,
      control,
      marketData: {
        quotedAt: feed.quotedAt?.toISOString() ?? null,
        ageMs: feed.quotedAt ? Math.max(0, now.getTime() - feed.quotedAt.getTime()) : null,
        marketOpen: feed.marketOpen,
        // Index quotes in the snapshot. 0 with no `quotedAt` is what an
        // unreachable bridge looks like through `feedFreshness()`.
        instruments: feed.instruments,
      },
      openPositions,
      today: {
        armedProfiles,
        intentsByStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
        orders: countFor([ExecutionIntentStatus.SUBMITTED, ExecutionIntentStatus.FILLED, ExecutionIntentStatus.CLOSED]),
        fills: countFor([ExecutionIntentStatus.FILLED, ExecutionIntentStatus.CLOSED]),
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
