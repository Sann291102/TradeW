import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { BacktestStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CHARGES_RATE } from '../sim/order.service';
import {
  BacktestConfigError,
  DEFAULT_CONFIG,
  ENGINE_VERSION,
  configurationHash,
  resolveConfig,
  type BacktestConfig,
} from './backtest-config';

/**
 * The user-facing backtest surface: create, list, read, cancel.
 *
 * ## Ownership is enforced on every read, and absence is the answer
 *
 * Every query is scoped by `userId`, and a row belonging to someone else
 * produces `404 Not Found` rather than `403 Forbidden`. That is deliberate: a
 * 403 confirms the id exists, which turns the detail endpoint into an oracle
 * for enumerating other people's backtests. The scoping is in the `where`
 * clause rather than a post-fetch check, so there is no path that loads a row
 * first and decides afterwards.
 *
 * ## Immutability is enforced by absence of a write path
 *
 * There is no update method here. A completed backtest can be read and
 * cancelled-if-still-running, and nothing else. Re-running the same
 * configuration creates a NEW row, which is what makes an old result keep
 * reporting the strategy version it actually tested.
 */

/** How many runs one user may have in flight. A backtest is minutes of CPU on a
 *  shared service; without a cap one user's tab can starve everyone else's. */
const MAX_ACTIVE_PER_USER = 3;

export interface CreateBacktestInput extends Partial<BacktestConfig> {
  label?: string;
  /** Copy risk policy from an execution profile the caller owns. */
  sourceProfileId?: string;
}

@Injectable()
export class BacktestService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Queue a run.
   *
   * The configuration is resolved and validated HERE, synchronously, so a bad
   * request fails as a 400 the user can fix rather than as a FAILED row they
   * have to open to understand.
   */
  async create(userId: string, input: CreateBacktestInput) {
    // The fee default must stay tied to the paper engine's own rate. Asserted
    // rather than commented: if `CHARGES_RATE` moves and this does not, a
    // backtest and a paper trade of the same size would be charged differently
    // and nothing would say so.
    if (DEFAULT_CONFIG.feeRate !== CHARGES_RATE) {
      throw new Error(
        `Backtest fee default (${DEFAULT_CONFIG.feeRate}) has drifted from the OMS CHARGES_RATE (${CHARGES_RATE}).`,
      );
    }

    const active = await this.prisma.backtest.count({
      where: { userId, status: { in: [BacktestStatus.QUEUED, BacktestStatus.RUNNING] } },
    });
    if (active >= MAX_ACTIVE_PER_USER) {
      throw new ConflictException(
        `You already have ${active} backtests queued or running. Wait for one to finish, or cancel it.`,
      );
    }

    let cfg: BacktestConfig;
    try {
      cfg = resolveConfig(await this.withProfileDefaults(userId, input));
    } catch (err) {
      if (err instanceof BacktestConfigError) throw new BadRequestException(err.message);
      throw err;
    }

    // The hash is provisional at creation: the strategy and data versions are
    // only known once the run reads them, and the runner rewrites it then. It
    // is stored now anyway so a QUEUED row is never missing a column that the
    // list page renders.
    const provisionalHash = configurationHash(cfg, 'pending', null);

    return this.prisma.backtest.create({
      data: {
        userId,
        label: input.label?.trim() || null,
        status: BacktestStatus.QUEUED,
        strategyId: cfg.strategyId ?? 'auto',
        strategyName: cfg.strategyId ?? 'Auto (any enabled strategy)',
        strategyVersion: 'pending',
        symbol: cfg.symbol,
        exchange: cfg.exchange,
        timeframe: cfg.timeframe,
        startAt: new Date(cfg.startAt),
        endAt: new Date(cfg.endAt),
        initialCapital: cfg.initialCapital,
        configuration: cfg as unknown as Prisma.InputJsonValue,
        configurationHash: provisionalHash,
        sourceProfileId: input.sourceProfileId ?? null,
        engineVersion: ENGINE_VERSION,
      },
    });
  }

  /**
   * Risk knobs borrowed from an execution profile.
   *
   * Read-only, and only from a profile bound to the CALLER'S OWN account — a
   * profile id is not a capability, and letting one user read another's risk
   * policy through this door would be a quiet information leak. Explicit fields
   * in the request still win, so "start from my profile, but with more capital"
   * works.
   */
  private async withProfileDefaults(userId: string, input: CreateBacktestInput): Promise<CreateBacktestInput> {
    if (!input.sourceProfileId) return input;
    const profile = await this.prisma.executionProfile.findFirst({
      where: { id: input.sourceProfileId, accountUserId: userId },
      select: {
        symbol: true,
        strategyId: true,
        minConfidence: true,
        maxOpenPositions: true,
        maxOrdersPerDay: true,
        maxLossPerDay: true,
        squareOffMinute: true,
        lots: true,
        productType: true,
        orderType: true,
      },
    });
    if (!profile) {
      throw new BadRequestException('That execution profile does not exist, or is not bound to your account.');
    }
    return {
      symbol: profile.symbol,
      strategyId: profile.strategyId,
      minConfidence: profile.minConfidence,
      maxOpenPositions: profile.maxOpenPositions,
      maxOrdersPerDay: profile.maxOrdersPerDay,
      maxLossPerDay: Number(profile.maxLossPerDay),
      squareOffMinute: profile.squareOffMinute,
      sizingMode: 'FIXED_LOTS',
      sizingValue: profile.lots,
      productType: profile.productType,
      orderType: profile.orderType,
      ...stripUndefined(input),
    };
  }

  async list(
    userId: string,
    filter: {
      status?: BacktestStatus;
      strategyId?: string;
      symbol?: string;
      timeframe?: string;
      profitable?: boolean;
      from?: Date;
      to?: Date;
      limit?: number;
      offset?: number;
    },
  ) {
    const where: Prisma.BacktestWhereInput = {
      userId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.strategyId ? { strategyId: filter.strategyId } : {}),
      ...(filter.symbol ? { symbol: filter.symbol.toUpperCase() } : {}),
      ...(filter.timeframe ? { timeframe: filter.timeframe } : {}),
      ...(filter.from || filter.to
        ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
        : {}),
      // Profitability is only meaningful for a run that finished. Filtering on
      // it must therefore also exclude the ones that have no P&L yet, or a
      // QUEUED row would silently satisfy "unprofitable".
      ...(filter.profitable === undefined
        ? {}
        : {
            status: BacktestStatus.COMPLETED,
            totalPnl: filter.profitable ? { gt: 0 } : { lte: 0 },
          }),
    };

    const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
    const [rows, total] = await Promise.all([
      this.prisma.backtest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: Math.max(filter.offset ?? 0, 0),
        select: LIST_FIELDS,
      }),
      this.prisma.backtest.count({ where }),
    ]);
    return { total, limit, offset: Math.max(filter.offset ?? 0, 0), rows };
  }

  async get(userId: string, id: string) {
    const row = await this.prisma.backtest.findFirst({
      where: { id, userId },
      include: { analysis: true },
    });
    if (!row) throw new NotFoundException('Backtest not found.');
    return row;
  }

  async trades(userId: string, id: string, opts: { limit?: number; offset?: number } = {}) {
    await this.assertOwned(userId, id);
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2_000);
    const [rows, total] = await Promise.all([
      this.prisma.backtestTrade.findMany({
        where: { backtestId: id },
        orderBy: { sequence: 'asc' },
        take: limit,
        skip: Math.max(opts.offset ?? 0, 0),
      }),
      this.prisma.backtestTrade.count({ where: { backtestId: id } }),
    ]);
    return { total, rows };
  }

  async equity(userId: string, id: string) {
    await this.assertOwned(userId, id);
    const rows = await this.prisma.backtestEquityPoint.findMany({
      where: { backtestId: id },
      orderBy: { sequence: 'asc' },
    });
    return { total: rows.length, rows };
  }

  /**
   * Cancel a run that has not finished.
   *
   * A terminal row is left exactly as it is — cancelling a completed backtest
   * is a no-op with a clear message, not a rewrite. The `updateMany` guard is
   * what makes this race-safe against the runner finishing at the same instant:
   * whichever transaction commits first wins, and neither corrupts the other.
   */
  async cancel(userId: string, id: string) {
    await this.assertOwned(userId, id);
    const updated = await this.prisma.backtest.updateMany({
      where: { id, userId, status: { in: [BacktestStatus.QUEUED, BacktestStatus.RUNNING] } },
      data: {
        status: BacktestStatus.CANCELLED,
        failureReason: 'Cancelled by the user.',
        completedAt: new Date(),
      },
    });
    if (updated.count === 0) {
      const current = await this.prisma.backtest.findFirst({ where: { id, userId }, select: { status: true } });
      throw new ConflictException(`This backtest is already ${current?.status?.toLowerCase() ?? 'finished'}.`);
    }
    return this.get(userId, id);
  }

  /**
   * Two or more of the caller's own results, side by side.
   *
   * Comparability is reported, never enforced: two runs on different capital or
   * different periods are still worth putting next to each other, as long as
   * the reader is told which axis is not like-for-like.
   */
  async compare(userId: string, ids: string[]) {
    const unique = Array.from(new Set(ids)).slice(0, 6);
    if (unique.length < 2) throw new BadRequestException('Comparing needs at least two backtests.');

    const rows = await this.prisma.backtest.findMany({
      where: { id: { in: unique }, userId },
      select: { ...LIST_FIELDS, configuration: true, metrics: true, engineVersion: true, dataVersion: true },
    });
    if (rows.length !== unique.length) throw new NotFoundException('One or more of those backtests was not found.');

    const differing = (key: (r: (typeof rows)[number]) => unknown) =>
      new Set(rows.map((r) => JSON.stringify(key(r)))).size > 1;

    return {
      rows,
      /** Axes on which these runs are NOT like-for-like. Rendered as a warning
       *  next to the comparison rather than blocking it. */
      incompatibilities: [
        differing((r) => String(r.initialCapital)) ? 'initialCapital' : null,
        differing((r) => r.timeframe) ? 'timeframe' : null,
        differing((r) => [r.startAt.toISOString(), r.endAt.toISOString()]) ? 'period' : null,
        differing((r) => r.symbol) ? 'symbol' : null,
        differing((r) => r.engineVersion) ? 'engineVersion' : null,
        differing((r) => r.dataVersion) ? 'dataVersion' : null,
      ].filter((x): x is string => x !== null),
    };
  }

  private async assertOwned(userId: string, id: string): Promise<void> {
    const found = await this.prisma.backtest.findFirst({ where: { id, userId }, select: { id: true } });
    if (!found) throw new NotFoundException('Backtest not found.');
  }
}

/** What the list page needs — deliberately not the whole row. */
const LIST_FIELDS = {
  id: true,
  label: true,
  status: true,
  failureReason: true,
  strategyId: true,
  strategyName: true,
  strategyVersion: true,
  symbol: true,
  exchange: true,
  timeframe: true,
  startAt: true,
  endAt: true,
  firstBarAt: true,
  lastBarAt: true,
  barCount: true,
  initialCapital: true,
  finalCapital: true,
  totalPnl: true,
  totalReturnPct: true,
  maxDrawdownPct: true,
  winRatePct: true,
  profitFactor: true,
  totalTrades: true,
  createdAt: true,
  completedAt: true,
} satisfies Prisma.BacktestSelect;

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
