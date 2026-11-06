import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LeaderElectionService } from '../common/leader-election';
import { PrismaService } from '../prisma/prisma.service';
import { isTradingDay } from '../discipline/market-calendar';
import { istDayKey } from './ist-time.util';
import { MarketPriceService, parseOptionSymbol } from './market-price.service';
import { OrderService } from './order.service';
import { decideSweep, intrinsicValue, type SweepClock } from './square-off-policy';

const SWEEP_JOB = 'square-off-sweep';
const DEFAULT_SWEEP_MS = 30_000;
/** Exchanges whose session this sweep's clock describes. */
const SWEPT_EXCHANGES = ['NSE', 'BSE'] as const;

export interface SquareOffSummary {
  examined: number;
  squaredOff: number;
  settled: number;
  skipped: number;
  errors: number;
}

/** IST minute-of-day. Local on purpose: importing the paper-execution module's
 *  helper would point this module's dependency arrow at execution, and it must
 *  only ever point the other way. */
function istMinuteOfDay(d: Date): number {
  const [h, m] = d
    .toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' })
    .split(':')
    .map(Number);
  return (h % 24) * 60 + m;
}

/**
 * The platform's own end-of-session and end-of-contract sweep for paper
 * positions — the half of position management that does not depend on a person
 * or an agent remembering to act.
 *
 * ## Why it exists (defects D-21 and D-22)
 *
 * Trades filled, but nothing closed them on time:
 *
 *  - a person's MIS position was never squared off, so it survived the close;
 *  - an option held to expiry was never closed, and once expired it could not
 *    be priced, so every later exit attempt failed — for a person, and for the
 *    agent's own two-second manager, which retries forever. The position, and
 *    the margin it blocks, stayed on the book indefinitely, and because the
 *    agent's outcome only closes when the position goes flat, the agent never
 *    got the closed trade its calibration learns from.
 *
 * ## What it does
 *
 * Every 30 seconds, `decideSweep` (pure, tested) says for each position
 * whether to leave it, square it off with a MARKET exit, or cash-settle it.
 * Square-off goes through `OrderService.exitPosition` — the same path a person's
 * Exit button takes. Settlement goes through `OrderService.settleExpiredPosition`
 * at intrinsic value against a REAL underlying price: if none can be found the
 * position is left alone and the failure is logged, never settled at a guess.
 *
 * An agent's own position is left to the agent until 15:25 IST, so the two do
 * not race at 15:10–15:15; after that this is the backstop, and it labels the
 * exit as the agent's so the order book and the learning journal stay correct.
 *
 * Leader-gated for the same reason as `MatchingEngineService`: two replicas
 * must not both exit the same position.
 */
@Injectable()
export class SquareOffService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SquareOffService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly marketPrice: MarketPriceService,
    private readonly leader: LeaderElectionService,
  ) {}

  onModuleInit(): void {
    if ((process.env.SQUARE_OFF_SWEEP_ENABLED ?? 'true').toLowerCase() === 'false') {
      this.logger.warn('square-off sweep is disabled (SQUARE_OFF_SWEEP_ENABLED=false) — MIS and expiring options will NOT be closed automatically.');
      return;
    }
    this.leader.register(SWEEP_JOB);
    const ms = Number(process.env.SQUARE_OFF_SWEEP_MS ?? DEFAULT_SWEEP_MS);
    this.timer = setInterval(() => void this.tick(), ms);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (!this.leader.isLeader(SWEEP_JOB)) return;
    if (this.running) return;
    this.running = true;
    try {
      const s = await this.sweep();
      if (s.squaredOff || s.settled || s.errors) {
        this.logger.log(`square-off sweep: ${s.squaredOff} squared off, ${s.settled} settled, ${s.errors} errors (of ${s.examined}).`);
      }
    } catch (err) {
      this.logger.error('square-off sweep failed', err as Error);
    } finally {
      this.running = false;
    }
  }

  /** One pass. Public so the admin console / a script can run it on demand. */
  async sweep(now: Date = new Date()): Promise<SquareOffSummary> {
    const clock: SweepClock = { dayKey: istDayKey(now), minuteOfDay: istMinuteOfDay(now), tradingDay: isTradingDay(now) };
    const summary: SquareOffSummary = { examined: 0, squaredOff: 0, settled: 0, skipped: 0, errors: 0 };

    // Only what could ever be due: intraday positions, and any option (which can
    // expire whatever its product type). CNC equity is settled by SettlementService.
    const positions = await this.prisma.position.findMany({
      where: {
        quantity: { not: 0 },
        // NSE/BSE only. The 15:15 IST rule and the NSE holiday calendar describe
        // THOSE sessions. MCX trades to ~23:30 and US/UK/forex hours run across
        // the Indian evening, so applying 15:15 IST to them would market-exit a
        // position while its own market is closed.
        instrument: { exchange: { in: [...SWEPT_EXCHANGES] } },
        OR: [{ productType: 'MIS' }, { instrument: { type: 'OPTION' } }],
      },
      include: { instrument: true },
    });
    if (positions.length === 0) return summary;

    const agentOwned = await this.prisma.executionPosition.findMany({
      where: { state: { in: ['OPEN', 'EXITING'] } },
      select: { userId: true, instrumentId: true, intentId: true, state: true },
    });
    const intentFor = new Map(agentOwned.map((a) => [`${a.userId}:${a.instrumentId}`, a]));

    for (const position of positions) {
      summary.examined++;
      const agent = intentFor.get(`${position.userId}:${position.instrumentId}`) ?? null;
      const intentId = agent?.intentId ?? null;
      // The contract's own symbol (UNDERLYING:YYYYMMDD:STRIKE:CE|PE) is its
      // identity and states the expiry unambiguously; the stored `expiryDate`
      // is a timestamp whose timezone depends on which writer set it, so it is
      // only the fallback. Reading it wrongly by a day would settle a live
      // contract on the morning of its real expiry.
      const contract = parseOptionSymbol(position.instrument.symbol);
      const expiryDayKey =
        contract?.expiryIso ?? (position.instrument.expiryDate ? position.instrument.expiryDate.toISOString().slice(0, 10) : null);
      const action = decideSweep(
        {
          productType: position.productType,
          quantity: position.quantity,
          instrumentType: position.instrument.type,
          expiryDayKey,
          lastActivityDayKey: istDayKey(position.updatedAt),
          managedByAgent: intentId != null,
        },
        clock,
      );
      if (action.kind === 'none') {
        summary.skipped++;
        continue;
      }

      // An agent-owned position is CLAIMED (OPEN -> EXITING) before anything is
      // sold, exactly as the position manager does. Without it, this sweep and
      // the agent's own retry could both read a quantity of 50 and both sell,
      // flipping the account short. Not claimed => someone else is already
      // closing it, so leave it.
      let claimed = false;
      if (intentId) {
        const c = await this.prisma.executionPosition.updateMany({
          where: { intentId, state: 'OPEN' },
          data: { state: 'EXITING', exitReason: action.kind === 'settle' || action.reason === 'expiry-day' ? 'EXPIRY' : 'SQUARE_OFF', exitDecidedAt: now },
        });
        if (c.count !== 1) {
          summary.skipped++;
          continue;
        }
        claimed = true;
      }

      try {
        if (action.kind === 'square-off') {
          const exit = await this.orders.exitPosition(position.userId, position.instrumentId, position.productType);
          await this.labelAgentExit(exit.id, intentId, action.reason === 'expiry-day' ? 'EXPIRY' : 'SQUARE_OFF');
          summary.squaredOff++;
          this.logger.log(`squared off ${position.instrument.symbol} for ${position.userId} (${action.reason}).`);
        } else {
          const settled = await this.settle(position, contract, now);
          if (!settled) {
            summary.errors++;
            await this.release(claimed ? intentId : null);
            continue;
          }
          await this.labelAgentExit(settled, intentId, 'EXPIRY');
          summary.settled++;
        }
      } catch (err) {
        await this.release(claimed ? intentId : null);
        summary.errors++;
        this.logger.error(
          `square-off sweep: ${action.kind} failed for ${position.instrument.symbol} (user ${position.userId}) — ${(err as Error).message}`,
        );
      }
    }
    return summary;
  }

  /** Cash-settles one expired option. Returns the settlement order id, or null
   *  when no real underlying price exists (the position is then left open). */
  private async settle(
    position: {
      userId: string;
      instrumentId: string;
      productType: 'MIS' | 'CNC' | 'NRML';
      instrument: { symbol: string; underlying: string | null; strikePrice: unknown; optionType: string | null; expiryDate: Date | null };
    },
    contract: ReturnType<typeof parseOptionSymbol>,
    now: Date,
  ): Promise<string | null> {
    const { instrument } = position;
    // Contract terms from the canonical symbol where it parses, else the row.
    const underlying = contract?.underlying ?? instrument.underlying;
    const expiryIso = contract?.expiryIso ?? instrument.expiryDate?.toISOString().slice(0, 10) ?? null;
    const strike = contract?.strike ?? (instrument.strikePrice == null ? null : Number(instrument.strikePrice));
    const optionType = contract?.optionType ?? instrument.optionType;

    const spot = await this.settlementSpot(underlying, expiryIso, now);
    const value = intrinsicValue(optionType, strike, spot ?? 0);
    if (value == null) {
      this.logger.error(
        `cannot settle ${instrument.symbol}: no real underlying settlement price for ${underlying ?? '?'} on ${expiryIso ?? '?'}. ` +
          'Left open rather than settled at a guess.',
      );
      return null;
    }
    const order = await this.orders.settleExpiredPosition(position.userId, position.instrumentId, position.productType, value);
    this.logger.log(`settled ${instrument.symbol} for ${position.userId} at intrinsic ${value.toFixed(2)} (underlying ${spot}).`);
    return order.id;
  }

  /**
   * The underlying's price on the expiry day, from real data only.
   *
   * Stored candles first: the last bar of the expiry session is the close the
   * exchange settles against. If the contract expires today and no bar is
   * stored yet, the live quote — after 15:30 that is the final tick.
   */
  private async settlementSpot(underlying: string | null, expiryIso: string | null, now: Date): Promise<number | null> {
    if (!underlying || !expiryIso) return null;
    const underlyingInstrument = await this.prisma.instrument.findUnique({ where: { symbol: underlying.toUpperCase() } });
    if (!underlyingInstrument) return null;

    const dayStart = new Date(`${expiryIso}T00:00:00+05:30`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    // Finest bar first: the last 1-minute bar of the session is the closest thing to the settlement print.
    for (const timeframe of ['1m', '5m', '15m', '1h', '1d']) {
      const bar = await this.prisma.candle.findFirst({
        // Real broker bars only. `Candle` mixes `simulated` rows in beside `dhan`
        // ones (defects D-08/D-09), and cash-settling a position at an invented
        // price is the one outcome this service must not produce.
        where: {
          instrumentId: underlyingInstrument.id,
          timeframe,
          bucketStart: { gte: dayStart, lt: dayEnd },
          source: { notIn: ['simulated'] },
        },
        orderBy: { bucketStart: 'desc' },
        select: { close: true },
      });
      if (bar && Number(bar.close) > 0) return Number(bar.close);
    }

    if (istDayKey(now) === expiryIso) {
      try {
        const quote = await this.marketPrice.getPrice(underlyingInstrument);
        if (quote.ltp > 0) return quote.ltp;
      } catch {
        /* fall through to null — never settle on a guess */
      }
    }
    return null;
  }

  /** Hand an agent position back to its manager after a failed attempt, so the
   *  agent's own retry (or the next sweep) can try again. */
  private async release(intentId: string | null): Promise<void> {
    if (!intentId) return;
    await this.prisma.executionPosition.updateMany({
      where: { intentId, state: 'EXITING' },
      data: { state: 'OPEN' },
    });
  }

  /**
   * When the position belonged to an agent, name the exit as the agent's.
   *
   * `OrderService` knows nothing about intents and must not start to, so the
   * link is written here, after the order exists — the same shape
   * `ExecutionLifecycleService.squareOff` uses. The outcome's reason is stamped
   * only while it still reads PENDING, so an exit the agent already recorded
   * (a stop, a target) is never overwritten, and a position flattened here
   * is journalled as a square-off/expiry rather than as a human's exit.
   */
  private async labelAgentExit(orderId: string, intentId: string | null, reason: 'SQUARE_OFF' | 'EXPIRY'): Promise<void> {
    if (!intentId) return;
    await this.prisma.order.update({ where: { id: orderId }, data: { exitOfIntentId: intentId } });
    await this.prisma.executionOutcome.updateMany({
      where: { intentId, exitReason: 'PENDING' },
      data: { exitReason: reason },
    });
  }
}
