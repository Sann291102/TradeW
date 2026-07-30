import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { DisciplineLimitType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isTradingDay, istDateKey } from './market-calendar';
import {
  Breach,
  DisciplineLimit,
  MIN_DWELL_MS,
  MIN_REASON_LENGTH,
  OrderIntent,
  SessionBudget,
  SessionLimits,
  computeBudget,
  evaluateBreach,
  issueOverrideToken,
  shouldSendTargetNotice,
  validateLimits,
  validateReason,
  verifyOverrideToken,
} from './discipline-limits';

type Tx = Prisma.TransactionClient;

export interface StartSessionInput {
  maxMinutes: number;
  maxTrades: number;
  maxLoss: number;
  targetProfit?: number | null;
}

export interface DisciplineSessionDto {
  id: string;
  tradingDate: string;
  maxMinutes: number;
  maxTrades: number;
  maxLoss: number;
  targetProfit: number | null;
  startedAt: string;
  budget: SessionBudget;
  overrides: DisciplineOverrideDto[];
}

export interface DisciplineOverrideDto {
  id: string;
  limitType: DisciplineLimit;
  reason: string;
  createdAt: string;
}

/** What `GET /discipline/today` answers. */
export interface DisciplineTodayDto {
  /** True when the blocking panel should be shown right now. */
  needsPanel: boolean;
  /** Why the panel is not being asked for, when it isn't. */
  reason: 'session_exists' | 'not_a_trading_day' | 'before_market_open' | 'needs_panel';
  tradingDate: string;
  session: DisciplineSessionDto | null;
}

/**
 * What `OrderService` must carry from the pre-transaction check into the
 * transaction. Phase 1 decides; phase 2 writes, atomically with the order.
 */
export interface DisciplinePlan {
  sessionId: string | null;
  /** Set only when this placement is being let through on a consumed override. */
  override: { limitType: DisciplineLimitType; reason: string; tokenNonce: string } | null;
  userId: string;
}

/** 09:15 IST — the panel is asked for from market open, not from midnight. */
const MARKET_OPEN_MINUTE = 9 * 60 + 15;

const IST_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function istMinutesOfDay(at: Date): number {
  const [h, m] = IST_TIME.format(at).split(':').map(Number);
  return h * 60 + m;
}

/**
 * Discipline sessions — the trader's self-imposed limits for one trading day.
 *
 * Two responsibilities, deliberately split by transaction phase because the
 * OMS needs them that way:
 *
 *   1. `evaluatePlacement` runs BEFORE the order transaction. It reads the
 *      session, decides whether this order breaches a limit, and either
 *      returns a plan or throws the 409 that drives the friction prompt.
 *   2. `recordPlacement` / `applyRealizedPnl` run INSIDE the order transaction,
 *      so counters and overrides commit atomically with the order and trade
 *      they describe. A counter that could drift from the order book would
 *      make every later limit decision wrong.
 *
 * Observation only. Nothing here reads market data, names an instrument, or
 * expresses a view on direction — it compares the trader's own counters to the
 * trader's own numbers.
 */
@Injectable()
export class DisciplineService {
  private readonly logger = new Logger(DisciplineService.name);
  private readonly overrideSecret: string;

  constructor(private readonly prisma: PrismaService) {
    const secret = process.env.DISCIPLINE_OVERRIDE_SECRET || process.env.JWT_SECRET;
    if (!secret) {
      // Unlike JwtModule's `|| 'dev-secret-change-me'`, this does not silently
      // fall back in production: an override token signed with a public
      // constant would let anyone mint a "reason already given" pass and skip
      // the friction prompt entirely.
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'DISCIPLINE_OVERRIDE_SECRET (or JWT_SECRET) must be set in production — ' +
            'override tokens cannot be signed with a default.',
        );
      }
      this.logger.warn('No DISCIPLINE_OVERRIDE_SECRET/JWT_SECRET set — using a development signing key.');
    }
    this.overrideSecret = secret || 'discipline-dev-signing-key';
  }

  // ------------------------------------------------------------------ reads

  async today(userId: string, at: Date = new Date()): Promise<DisciplineTodayDto> {
    const tradingDate = istDateKey(at);
    const session = await this.findSession(userId, tradingDate);

    if (session) {
      return { needsPanel: false, reason: 'session_exists', tradingDate, session: this.toDto(session, at) };
    }
    if (!isTradingDay(at)) {
      return { needsPanel: false, reason: 'not_a_trading_day', tradingDate, session: null };
    }
    if (istMinutesOfDay(at) < MARKET_OPEN_MINUTE) {
      return { needsPanel: false, reason: 'before_market_open', tradingDate, session: null };
    }
    return { needsPanel: true, reason: 'needs_panel', tradingDate, session: null };
  }

  /**
   * Overrides across dates — the behavioural record the panel exists to build.
   * This is the query the separate `DisciplineOverride` table exists for; it is
   * served by the `(userId, createdAt)` / `(userId, limitType, createdAt)`
   * indexes without touching the session table.
   */
  async overrideHistory(
    userId: string,
    opts: { limitType?: DisciplineLimit; from?: Date; to?: Date; limit?: number } = {},
  ) {
    const rows = await this.prisma.disciplineOverride.findMany({
      where: {
        userId,
        ...(opts.limitType ? { limitType: opts.limitType as DisciplineLimitType } : {}),
        ...(opts.from || opts.to
          ? { createdAt: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } }
          : {}),
      },
      include: { session: { select: { tradingDate: true } } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts.limit ?? 100, 500),
    });

    return rows.map((r) => ({
      id: r.id,
      tradingDate: r.session.tradingDate,
      limitType: r.limitType as DisciplineLimit,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ----------------------------------------------------------------- writes

  /**
   * Create today's session from the panel. Idempotent on `(userId,
   * tradingDate)`: a double-submit (slow phone, double tap) returns the
   * existing session rather than a 500 or a second row.
   */
  async startSession(userId: string, input: StartSessionInput, at: Date = new Date()): Promise<DisciplineSessionDto> {
    const rejection = validateLimits(input);
    if (rejection) throw new BadRequestException({ error: 'invalid_limits', reason: rejection });

    const tradingDate = istDateKey(at);
    const existing = await this.findSession(userId, tradingDate);
    if (existing) return this.toDto(existing, at);

    try {
      const created = await this.prisma.disciplineSession.create({
        data: {
          userId,
          tradingDate,
          maxMinutes: input.maxMinutes,
          maxTrades: input.maxTrades,
          maxLoss: new Prisma.Decimal(input.maxLoss),
          targetProfit: input.targetProfit != null ? new Prisma.Decimal(input.targetProfit) : null,
          startedAt: at,
        },
        include: { overrides: { orderBy: { createdAt: 'desc' } } },
      });
      return this.toDto(created, at);
    } catch (err) {
      // Lost the race against a concurrent submit — the other one won, and its
      // row is the session. Not an error from the trader's point of view.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const session = await this.findSession(userId, tradingDate);
        if (session) return this.toDto(session, at);
      }
      throw err;
    }
  }

  // ------------------------------------------------------------ enforcement

  /**
   * Phase 1 — called by `OrderService.placeOrder` before the order transaction.
   *
   * Returns a plan the transaction then commits. Throws 409 with a signed
   * override token when a limit is breached and no valid override accompanies
   * the order.
   *
   * Two deliberate non-blocks:
   *   - `intent === 'reduce'` skips every check. Closing exposure is never
   *     frictioned; the loss limit is breached exactly when the trader holds a
   *     loser, and making them write a paragraph to get out of it would be the
   *     opposite of the point.
   *   - No session row means no limits were declared, so there is nothing to
   *     breach. The panel is what creates the row; an order placed on a
   *     non-trading day, or by an API client that never saw the panel, is not
   *     retroactively in violation of limits the trader never set.
   */
  async evaluatePlacement(
    userId: string,
    intent: OrderIntent,
    override: { token?: string | null; reason?: string | null },
    at: Date = new Date(),
  ): Promise<DisciplinePlan> {
    const tradingDate = istDateKey(at);
    const session = await this.findSession(userId, tradingDate);

    if (!session) return { userId, sessionId: null, override: null };
    if (intent === 'reduce') return { userId, sessionId: session.id, override: null };

    const breach = evaluateBreach(this.toLimits(session), at);
    if (!breach) return { userId, sessionId: session.id, override: null };

    // Breached. Either the trader has already sat through the prompt and typed
    // a reason, or they are about to.
    const verified = verifyOverrideToken(
      override.token,
      { sessionId: session.id, limitType: breach.limitType },
      this.overrideSecret,
      at,
    );

    if (!verified.ok) {
      throw this.frictionResponse(session, breach, at, verified.reason === 'malformed' ? undefined : verified.reason);
    }

    const reasonRejection = validateReason(override.reason);
    if (reasonRejection) {
      throw this.frictionResponse(session, breach, at, reasonRejection);
    }

    return {
      userId,
      sessionId: session.id,
      override: {
        limitType: breach.limitType as DisciplineLimitType,
        reason: (override.reason ?? '').trim(),
        tokenNonce: verified.token.nonce,
      },
    };
  }

  /**
   * Phase 2 — called INSIDE the order transaction, immediately after the order
   * row is created.
   *
   * Increments the trade counter and, when the placement rode an override,
   * writes the override row. The unique index on `tokenNonce` is what makes one
   * typed reason authorise exactly one order: a replayed token raises P2002
   * here, which rolls back the order with it.
   */
  async recordPlacement(tx: Tx, plan: DisciplinePlan): Promise<void> {
    if (!plan.sessionId) return;

    await tx.disciplineSession.update({
      where: { id: plan.sessionId },
      data: { tradesTaken: { increment: 1 } },
    });

    if (plan.override) {
      try {
        await tx.disciplineOverride.create({
          data: {
            sessionId: plan.sessionId,
            userId: plan.userId,
            limitType: plan.override.limitType,
            reason: plan.override.reason,
            tokenNonce: plan.override.tokenNonce,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException({
            error: 'discipline_override_already_used',
            message: 'That override has already been used. Place the order again to confirm it.',
          });
        }
        throw err;
      }
    }
  }

  /**
   * Phase 2 — called INSIDE `OrderService.executeFill`'s transaction with the
   * realized P&L that fill locked in.
   *
   * Mirroring realized P&L onto the session (rather than aggregating trades on
   * every check) keeps `evaluatePlacement` a single point read, and keeps the
   * counter atomic with the fill that moved it.
   *
   * Returns the one-time profit-target notice when this fill crossed the
   * target, so the caller can see it happened; the notification row is written
   * here, in the same transaction, which is what makes it fire once.
   */
  async applyRealizedPnl(tx: Tx, userId: string, realizedPnlDelta: number, at: Date = new Date()): Promise<void> {
    if (realizedPnlDelta === 0) return;

    const tradingDate = istDateKey(at);
    const session = await tx.disciplineSession.findUnique({
      where: { userId_tradingDate: { userId, tradingDate } },
    });
    if (!session) return;

    const updated = await tx.disciplineSession.update({
      where: { id: session.id },
      data: { realizedPnl: { increment: new Prisma.Decimal(realizedPnlDelta.toFixed(2)) } },
    });

    const target = updated.targetProfit != null ? Number(updated.targetProfit) : null;
    const reached = shouldSendTargetNotice({
      targetProfit: target,
      realizedPnl: Number(updated.realizedPnl),
      targetNoticeSentAt: updated.targetNoticeSentAt,
    });
    if (!reached || target === null) return;

    // Stamp first, conditionally on the notice not already having gone out:
    // the stamp and the notification share this transaction, so a concurrent
    // fill that also crossed the target cannot produce a second notice.
    //
    // The try/catch is insurance, not the mechanism. The row lock taken by the
    // increment above should already serialise concurrent fills, so a losing
    // writer reads the stamped value and never reaches here — but a P2025 from
    // this conditional update would abort the enclosing transaction and take a
    // real fill down with it. A missed courtesy notification must never cost a
    // trader their trade.
    try {
      await tx.disciplineSession.update({
        where: { id: updated.id, targetNoticeSentAt: null },
        data: { targetNoticeSentAt: at },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') return;
      throw err;
    }

    // Written through the transaction client rather than NotificationService,
    // which owns its own Prisma client and would commit outside this
    // transaction — breaking the once-only guarantee the stamp provides.
    // Category 'portfolio' reuses an existing NotificationCategory value; a
    // dedicated 'discipline' value is not worth an enum migration for one row
    // type.
    await tx.notification.create({
      data: {
        userId,
        category: 'portfolio',
        title: 'You reached the profit target you set',
        body:
          `You set ${formatInr(target)} at the start of the session. ` +
          `Realised P&L is now ${formatInr(Number(updated.realizedPnl))}. ` +
          'This is a note, not an instruction — nothing about your positions or limits has changed.',
        metadata: { kind: 'discipline_target_reached', sessionId: updated.id, tradingDate },
      },
    });
  }

  // ---------------------------------------------------------------- helpers

  /**
   * The 409 that drives the friction prompt. Carries a freshly signed token
   * whose issue time starts the mandatory dwell — the client counts down
   * against `minDwellMs`, and `verifyOverrideToken` re-checks it server-side so
   * the wait cannot be skipped by calling the API directly.
   */
  private frictionResponse(
    session: SessionRow,
    breach: Breach,
    at: Date,
    priorAttempt?: string,
  ): ConflictException {
    return new ConflictException({
      error: 'discipline_limit',
      limitType: breach.limitType,
      detail: breach.detail,
      overrideToken: issueOverrideToken(session.id, breach.limitType, this.overrideSecret, at),
      minDwellMs: MIN_DWELL_MS,
      minReasonLength: MIN_REASON_LENGTH,
      /** Present when a retry was refused, so the client can say why. */
      priorAttempt: priorAttempt ?? null,
      budget: computeBudget(this.toLimits(session), at),
      tradingDate: session.tradingDate,
    });
  }

  private findSession(userId: string, tradingDate: string) {
    return this.prisma.disciplineSession.findUnique({
      where: { userId_tradingDate: { userId, tradingDate } },
      include: { overrides: { orderBy: { createdAt: 'desc' } } },
    });
  }

  private toLimits(session: SessionRow): SessionLimits {
    return {
      maxMinutes: session.maxMinutes,
      maxTrades: session.maxTrades,
      maxLoss: Number(session.maxLoss),
      targetProfit: session.targetProfit != null ? Number(session.targetProfit) : null,
      startedAt: session.startedAt,
      tradesTaken: session.tradesTaken,
      realizedPnl: Number(session.realizedPnl),
    };
  }

  private toDto(session: SessionRowWithOverrides, at: Date): DisciplineSessionDto {
    return {
      id: session.id,
      tradingDate: session.tradingDate,
      maxMinutes: session.maxMinutes,
      maxTrades: session.maxTrades,
      maxLoss: Number(session.maxLoss),
      targetProfit: session.targetProfit != null ? Number(session.targetProfit) : null,
      startedAt: session.startedAt.toISOString(),
      budget: computeBudget(this.toLimits(session), at),
      overrides: (session.overrides ?? []).map((o) => ({
        id: o.id,
        limitType: o.limitType as DisciplineLimit,
        reason: o.reason,
        createdAt: o.createdAt.toISOString(),
      })),
    };
  }
}

type SessionRow = Prisma.DisciplineSessionGetPayload<Record<string, never>>;
type SessionRowWithOverrides = Prisma.DisciplineSessionGetPayload<{ include: { overrides: true } }>;

function formatInr(amount: number): string {
  return '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(amount);
}
