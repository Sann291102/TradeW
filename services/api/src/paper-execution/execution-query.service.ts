import { Injectable } from '@nestjs/common';
import { ExecutionIntentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { istParts } from './execution-identity';
import { countProfileOpenPositions } from './execution-open-positions';
import { rejectCheckLabel } from './execution-policy';
import {
  STATE_DESCRIPTIONS,
  STATE_LABELS,
  environmentFor,
  isExecutingState,
  type ExecutionProfileState,
} from './execution-state';

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
        // The stored qualification verdict. Included rather than recomputed
        // per row: the console lists every profile on every poll, and
        // re-measuring an equity curve N times a minute to render a badge is
        // the kind of read that makes a page time out on the day it matters.
        qualification: true,
        _count: { select: { intents: true } },
      },
    });

    return Promise.all(
      rows.map(async (p) => {
        const [openPositions, todaysIntents] = await Promise.all([
          // THE PROFILE'S positions, not the account's. This used to count
          // every non-zero position on the account, which is a different
          // number the moment a profile is bound to a real person's account —
          // and it was rendered against the profile's own `maxOpenPositions`,
          // so a trader holding two of their own made their agent read `2/1`
          // while the gate that decides was looking at 0. One function now
          // answers for both; see execution-open-positions.ts.
          countProfileOpenPositions(this.prisma, p.id, p.accountUserId),
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
          // ---- The state machine, as the console renders it -----------------
          state: p.state,
          stateLabel: STATE_LABELS[p.state as ExecutionProfileState],
          stateDescription: STATE_DESCRIPTIONS[p.state as ExecutionProfileState],
          // Derived from the STATE, never from the `environment` column — see
          // execution-state.ts. So a row whose environment says LIVE while its
          // state does not authorize live renders as "not executing", which is
          // what would actually happen.
          executingEnvironment: environmentFor(p.state as ExecutionProfileState),
          mayExecute: isExecutingState(p.state as ExecutionProfileState),
          autoTradeEnabled: p.accountScope === 'SYSTEM_PAPER' ? true : p.autoTradeEnabled,
          autoTradeEnabledAt: p.autoTradeEnabledAt?.toISOString() ?? null,
          paperArmedAt: p.paperArmedAt?.toISOString() ?? null,
          paperArmedBy: p.paperArmedBy,
          liveArmedAt: p.liveArmedAt?.toISOString() ?? null,
          liveArmedBy: p.liveArmedBy,
          disarmedAt: p.disarmedAt?.toISOString() ?? null,
          pausedAt: p.pausedAt?.toISOString() ?? null,
          pausedReason: p.pausedReason,
          resumeState: p.resumeState,
          // Denormalised execution telemetry — the five clocks §7 asks the
          // console to answer.
          lastRunAt: p.lastRunAt?.toISOString() ?? null,
          lastDecisionAt: p.lastDecisionAt?.toISOString() ?? null,
          lastOrderAt: p.lastOrderAt?.toISOString() ?? null,
          lastFillAt: p.lastFillAt?.toISOString() ?? null,
          lastErrorAt: p.lastErrorAt?.toISOString() ?? null,
          lastError: p.lastError,
          qualification: p.qualification
            ? {
                passed: p.qualification.passed,
                evaluatedAt: p.qualification.evaluatedAt.toISOString(),
                trades: p.qualification.trades,
                wins: p.qualification.wins,
                losses: p.qualification.losses,
                winRate: p.qualification.winRate,
                netPnl: Number(p.qualification.netPnl),
                maxDrawdownPct: p.qualification.maxDrawdownPct,
                maxLosingStreak: p.qualification.maxLosingStreak,
                tradingDays: p.qualification.tradingDays,
                criticalErrors: p.qualification.criticalErrors,
                unmet: (p.qualification.results as unknown as { id: string; label: string; met: boolean; detail: string }[])
                  .filter((r) => !r.met)
                  .map((r) => ({ id: r.id, label: r.label, detail: r.detail })),
              }
            : null,
          // Live eligibility is a CONJUNCTION the console must not have to
          // re-derive: qualified AND not already live. Stated once, here.
          liveEligible: (p.qualification?.passed ?? false) && p.state === 'PAPER_QUALIFIED',
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
   * "Why did nothing trade today?" — as one answer instead of N.
   *
   * ## The question this exists to make cheap
   *
   * On 2026-08-18 the loop produced intents all day and not one order. The
   * reason was already recorded on every single one of those intents, and it
   * still took an end-to-end audit of the read path to find, because the only
   * way to see it was to open rejections one at a time. Grouped, it is a glance:
   * "42 daily-loss-limit, 3 submission-raised".
   *
   * ## Grouped by the check id, never by the sentence
   *
   * `rejectReason` interpolates live numbers, so two refusals for the SAME
   * reason are different strings and grouping by it yields one row per intent —
   * the same list, sorted differently. `rejectCheckId` is the stable form.
   *
   * A null `rejectCheckId` on a refused intent means the row predates that
   * column (the loop has been running since 2026-08-18). It is reported as its
   * own bucket rather than dropped: an operator counting today's refusals must
   * be able to see that the count is short, not silently get a smaller number.
   */
  async rejections(hours = 24) {
    const since = new Date(Date.now() - hours * 3_600_000);
    const where = {
      decidedAt: { gte: since },
      status: { in: [ExecutionIntentStatus.REJECTED, ExecutionIntentStatus.FAILED] },
    };

    const [grouped, total, samples] = await Promise.all([
      this.prisma.executionIntent.groupBy({
        by: ['rejectCheckId'],
        where,
        _count: { _all: true },
        _max: { decidedAt: true },
      }),
      this.prisma.executionIntent.count({ where }),
      // One real sentence per bucket, so the breakdown carries the numbers the
      // id cannot ("Realized -₹110,987.50 today, at or past the -₹25,000
      // floor"). The most RECENT one, because a limit's detail changes through
      // the day and the current state is what an operator is asking about.
      this.prisma.executionIntent.findMany({
        where,
        orderBy: { decidedAt: 'desc' },
        select: { rejectCheckId: true, rejectReason: true, decidedAt: true, profile: { select: { name: true } } },
        // Bounded: enough to cover every bucket several times over without
        // reading a whole day of intents to show nine strings.
        take: 200,
      }),
    ]);

    const latestReason = new Map<string, { reason: string | null; profileName: string }>();
    for (const s of samples) {
      const key = s.rejectCheckId ?? '';
      if (!latestReason.has(key)) latestReason.set(key, { reason: s.rejectReason, profileName: s.profile.name });
    }

    return {
      hours,
      total,
      buckets: grouped
        .map((g) => {
          const key = g.rejectCheckId ?? '';
          const sample = latestReason.get(key);
          return {
            checkId: g.rejectCheckId,
            label: rejectCheckLabel(g.rejectCheckId),
            count: g._count._all,
            lastAt: g._max.decidedAt?.toISOString() ?? null,
            // The most recent full sentence behind this bucket.
            lastReason: sample?.reason ?? null,
            lastProfileName: sample?.profileName ?? null,
          };
        })
        .sort((a, b) => b.count - a.count),
    };
  }

  /**
   * Recent execution PASSES, including the ones that produced nothing.
   *
   * ## The gap this closes
   *
   * `intents()` above lists DECISIONS, and a decision only exists when Sentinel
   * published a side. Most passes do not produce one — the market is shut, the
   * read is neutral, the profile was disarmed a second ago — and those passes
   * were previously invisible in every table. So a console could show "0
   * intents today" for a loop that had run 400 times and for one that had never
   * started, with nothing to tell them apart.
   *
   * This is the other half. §24's telemetry list is answered per row: profile,
   * user, environment, symbol, outcome, reason, the ids it produced, the gate
   * that stopped it, and the latency.
   */
  async runs(params: { profileId?: string; limit?: number; hours?: number; outcome?: string }) {
    const hours = params.hours ?? 24;
    const rows = await this.prisma.executionRun.findMany({
      where: {
        startedAt: { gte: new Date(Date.now() - hours * 3_600_000) },
        ...(params.profileId ? { profileId: params.profileId } : {}),
        ...(params.outcome ? { outcome: params.outcome } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(params.limit ?? 100, 1), 500),
      include: { profile: { select: { name: true, agent: true } } },
    });

    return rows.map((r) => ({
      id: r.id,
      profileId: r.profileId,
      profileName: r.profile.name,
      agent: r.profile.agent,
      environment: r.environment,
      symbol: r.symbol,
      trigger: r.trigger,
      outcome: r.outcome,
      reason: r.reason,
      intentId: r.intentId,
      orderId: r.orderId,
      rejectCheckId: r.rejectCheckId,
      rejectLabel: r.rejectCheckId ? rejectCheckLabel(r.rejectCheckId) : null,
      error: r.error,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      latencyMs: r.latencyMs,
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
    const [byStatus, byVerdict, outcomes, profiles, byState, runsInWindow, liveArmed, qualified] =
      await Promise.all([
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
        // "Armed" now means "in an executing state", counted from the authority
        // rather than from its `enabled` mirror.
        this.prisma.executionProfile.count({
          where: { state: { in: ['PAPER_ARMED', 'PAPER_RUNNING', 'PAPER_QUALIFIED', 'LIVE_ARMED', 'LIVE_RUNNING'] } },
        }),
        this.prisma.executionProfile.groupBy({ by: ['state'], _count: { _all: true } }),
        // Passes, not decisions — the number that distinguishes a dead loop
        // from a quiet market.
        this.prisma.executionRun.groupBy({
          by: ['outcome'],
          where: { startedAt: { gte: since } },
          _count: { _all: true },
        }),
        this.prisma.executionProfile.count({ where: { state: { in: ['LIVE_ARMED', 'LIVE_RUNNING'] } } }),
        this.prisma.executionProfile.count({ where: { state: 'PAPER_QUALIFIED' } }),
      ]);

    const wins = outcomes.filter((o) => o.result === 'WIN').length;
    const losses = outcomes.filter((o) => o.result === 'LOSS').length;
    const decided = wins + losses;

    return {
      enabledProfiles: profiles,
      liveArmedProfiles: liveArmed,
      qualifiedProfiles: qualified,
      byState: byState.map((s) => ({
        state: s.state,
        label: STATE_LABELS[s.state as ExecutionProfileState],
        count: s._count._all,
      })),
      byRunOutcome: runsInWindow.map((r) => ({ outcome: r.outcome, count: r._count._all })),
      passes: runsInWindow.reduce((n, r) => n + r._count._all, 0),
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
