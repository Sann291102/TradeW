import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { istParts } from './execution-identity';

/**
 * Read models for the admin console's execution views.
 *
 * Kept apart from `PaperExecutionService` so the thing that PLACES orders and
 * the thing that LISTS them are different objects: a read path should never be
 * one refactor away from being able to submit, and a console query should never
 * be able to take a lock the execution loop needs.
 *
 * Everything is a projection of rows the loop and the OMS already wrote — no
 * derived state is cached here, so a number on the console cannot drift from
 * the number in the ledger.
 */
@Injectable()
export class ExecutionQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async profiles() {
    const rows = await this.prisma.executionProfile.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        // Explicit select — `passwordHash` lives on this model and a spread
        // would ship it to a browser. `agentPaperTradingEnabledAt` is a consent
        // record, not a credential, and the console needs it to show why a
        // USER_PAPER profile is or is not executable.
        account: {
          select: {
            id: true,
            email: true,
            agentPaperTradingEnabledAt: true,
            agentPaperTradingGrantedBy: true,
            paperWallet: true,
          },
        },
        _count: { select: { intents: true } },
      },
    });

    return Promise.all(
      rows.map(async (p) => {
        const [openPositions, todaysIntents] = await Promise.all([
          this.prisma.position.count({ where: { userId: p.accountUserId, quantity: { not: 0 } } }),
          this.prisma.executionIntent.count({
            where: { profileId: p.id, decidedAt: { gte: istMidnight(new Date()) } },
          }),
        ]);
        const wallet = p.account.paperWallet;
        return {
          id: p.id,
          name: p.name,
          agent: p.agent,
          symbol: p.symbol,
          strategyId: p.strategyId,
          strategyName: p.strategyName,
          environment: p.environment,
          accountScope: p.accountScope,
          enabled: p.enabled,
          account: {
            id: p.account.id,
            email: p.account.email,
            // Only meaningful for USER_PAPER; a system account has no holder to
            // consent. The console renders it as "n/a" in that case rather than
            // as a missing grant.
            agentPaperTradingEnabled: p.account.agentPaperTradingEnabledAt != null,
            agentPaperTradingEnabledAt: p.account.agentPaperTradingEnabledAt?.toISOString() ?? null,
            agentPaperTradingGrantedBy: p.account.agentPaperTradingGrantedBy,
          },
          wallet: wallet
            ? {
                startingBalance: Number(wallet.startingBalance),
                cashBalance: Number(wallet.cashBalance),
                marginUsed: Number(wallet.marginUsed),
                realizedPnl: Number(wallet.realizedPnl),
              }
            : null,
          policy: {
            lots: p.lots,
            productType: p.productType,
            orderType: p.orderType,
            minConfidence: p.minConfidence,
            maxOpenPositions: p.maxOpenPositions,
            maxOrdersPerDay: p.maxOrdersPerDay,
            maxLossPerDay: Number(p.maxLossPerDay),
            squareOffMinute: p.squareOffMinute,
          },
          openPositions,
          intentsToday: todaysIntents,
          intentsTotal: p._count.intents,
        };
      }),
    );
  }

  async intents(params: { limit?: number; status?: string; profileId?: string; hours?: number }) {
    const hours = params.hours ?? 24;
    const rows = await this.prisma.executionIntent.findMany({
      where: {
        decidedAt: { gte: new Date(Date.now() - hours * 3_600_000) },
        ...(params.status ? { status: params.status as never } : {}),
        ...(params.profileId ? { profileId: params.profileId } : {}),
      },
      orderBy: { decidedAt: 'desc' },
      take: Math.min(Math.max(params.limit ?? 100, 1), 500),
      include: {
        profile: { select: { name: true, agent: true, environment: true } },
        order: { select: { id: true, status: true, filledQuantity: true, avgFillPrice: true, rejectReason: true } },
        outcome: { select: { result: true, realizedPnl: true, exitReason: true, holdingSeconds: true } },
        candidates: { select: { role: true, strike: true, tradable: true, selected: true }, orderBy: { strike: 'asc' } },
      },
    });

    return rows.map((i) => ({
      id: i.id,
      decidedAt: i.decidedAt.toISOString(),
      status: i.status,
      environment: i.environment,
      profileName: i.profile.name,
      agent: i.profile.agent,
      symbol: i.symbol,
      contractSymbol: i.contractSymbol,
      optionType: i.optionType,
      bias: i.bias,
      strike: Number(i.strike),
      side: i.side,
      quantity: i.quantity,
      confidence: i.confidence,
      strategyName: i.strategyName,
      sentinelRunId: i.sentinelRunId,
      rejectReason: i.rejectReason,
      order: i.order
        ? {
            id: i.order.id,
            status: i.order.status,
            filledQuantity: i.order.filledQuantity,
            avgFillPrice: i.order.avgFillPrice != null ? Number(i.order.avgFillPrice) : null,
            rejectReason: i.order.rejectReason,
          }
        : null,
      outcome: i.outcome
        ? {
            result: i.outcome.result,
            realizedPnl: Number(i.outcome.realizedPnl),
            exitReason: i.outcome.exitReason,
            holdingSeconds: i.outcome.holdingSeconds,
          }
        : null,
      candidates: i.candidates.map((c) => ({
        role: c.role,
        strike: Number(c.strike),
        tradable: c.tradable,
        selected: c.selected,
      })),
    }));
  }

  /**
   * Headline numbers for the console.
   *
   * `pnl` sums CLOSED outcomes only. Including open positions' mark-to-market
   * would make the number move on every tick for reasons that have nothing to
   * do with decisions the loop made, and "realized" would stop meaning realized.
   */
  async stats(hours = 24) {
    const since = new Date(Date.now() - hours * 3_600_000);
    const [byStatus, byVerdict, outcomes, profiles] = await Promise.all([
      this.prisma.executionIntent.groupBy({
        by: ['status'],
        where: { decidedAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.executionIntent.groupBy({
        by: ['symbol'],
        where: { decidedAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.executionOutcome.findMany({
        where: { createdAt: { gte: since }, result: { not: 'OPEN' } },
        select: { result: true, realizedPnl: true, holdingSeconds: true },
      }),
      this.prisma.executionProfile.count({ where: { enabled: true } }),
    ]);

    const wins = outcomes.filter((o) => o.result === 'WIN').length;
    const losses = outcomes.filter((o) => o.result === 'LOSS').length;
    const decided = wins + losses;

    return {
      enabledProfiles: profiles,
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
      bySymbol: byVerdict.map((s) => ({ symbol: s.symbol, count: s._count._all })),
      closed: outcomes.length,
      wins,
      losses,
      scratches: outcomes.filter((o) => o.result === 'SCRATCH').length,
      // Null rather than 0 when nothing has closed — a 0% win rate and "no
      // trades yet" are different facts and the console must not show the
      // second as the first.
      winRate: decided > 0 ? Math.round((wins / decided) * 100) : null,
      realizedPnl: outcomes.reduce((sum, o) => sum + Number(o.realizedPnl), 0),
      avgHoldingSeconds: outcomes.length
        ? Math.round(outcomes.reduce((sum, o) => sum + (o.holdingSeconds ?? 0), 0) / outcomes.length)
        : null,
    };
  }
}

function istMidnight(now: Date): Date {
  return new Date(`${istParts(now).dayKey}T00:00:00+05:30`);
}
