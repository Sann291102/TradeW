import { Injectable, Logger } from '@nestjs/common';
import { ExecutionIntentStatus, ExecutionPositionState, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MarketPriceService } from '../sim/market-price.service';
import { OrderService } from '../sim/order.service';
import { DEFAULT_MAX_QUOTE_AGE_MS, assessFreshness } from './execution-freshness';
import { istParts } from './execution-identity';
import { decidePosition, type ExitReason, type PositionAction } from './position-decision';

/**
 * The fast loop. Every open paper position, every couple of seconds.
 *
 * ## Why a separate loop at all
 *
 * The evaluation tick is slow by design: one pass reads candles, an option
 * chain and the whole strategy engine, and none of that changes between two
 * ticks of a 15-minute bar. Managing a POSITION is the opposite problem — the
 * premium moves continuously, and a stop that is only checked once a minute is
 * a stop that can be sixty seconds late. The previous implementation had no
 * position loop at all: the only thing that ever touched an open position was
 * a 15-second reconcile whose entire job was square-off.
 *
 * So the work is split by what it actually needs:
 *
 *   EVALUATE  (30 s)  candles + chain + strategy engine + Sentinel   — ENTRY
 *   MANAGE    (2 s)   one option premium + feed liveness            — EXIT
 *   RECONCILE (15 s)  local rows only                               — OUTCOMES
 *
 * ## Why two seconds, and not one, and not ten
 *
 * It is the cadence the existing feed actually supports, read off the bridge
 * rather than chosen:
 *
 *   · `GET /quotes` is served from the bridge's in-memory tick map with NO
 *     upstream call and no rate limit, and it coalesces ticks at
 *     `BROADCAST_MS = 300`. Polling it costs essentially nothing.
 *   · `GET /optionchain` caches for `OPTION_CHAIN_TTL_MS = 2000` and overlays
 *     live WebSocket prices onto the cached body on the way out. So at a
 *     2-second cadence every read is either a cache hit with live prices
 *     overlaid, or exactly one upstream refresh — and Dhan's own chain limit
 *     is roughly one call per three seconds per underlying.
 *
 * Faster than 2 s would spend upstream budget to re-read a cache; slower would
 * discard price updates the socket has already delivered. Configurable through
 * `PAPER_EXECUTION_MANAGE_MS` for a deployment whose bridge differs.
 *
 * ## One decision, one action
 *
 * Every question about an open position is answered by `decidePosition`, once,
 * from facts gathered here. This service performs at most ONE action per
 * position per tick and moves the row to `EXITING` before placing the exit
 * order, so a stop-hit on one tick and a target-hit on the next cannot both
 * place an order for the same position.
 *
 * ## A DISARMED profile is still managed
 *
 * The query below filters on `ExecutionPosition.state`, never on
 * `ExecutionProfile.enabled`. Disarming stops ENTRIES. It has never meant
 * "abandon whatever is open", and the previous square-off filtered on
 * `enabled: true`, so disarming an agent that held a position stranded that
 * position with no stop, no target and no square-off. That is the most
 * dangerous thing the old console could do, and it looked like the safe
 * button.
 */
@Injectable()
export class PositionManagerService {
  private readonly logger = new Logger(PositionManagerService.name);

  /**
   * Exit-rule state per symbol, refreshed by the evaluation tick.
   *
   * IN MEMORY, and deliberately so: it is a cache of a derived read, not
   * state. A restart loses it, and losing it degrades the position to
   * stop/target/trail/square-off — a strictly safe subset — until the next
   * evaluation tick refills it, which is at most 30 seconds away.
   */
  private readonly thesisCache = new Map<string, { at: number; byStrategy: Map<string, { id: string; note: string }[]> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly marketPrice: MarketPriceService,
  ) {}

  /**
   * How long a cached thesis read stays usable.
   *
   * Three evaluation intervals. Long enough that one failed Sentinel call does
   * not blind the manager; short enough that an invalidation can never fire on
   * a reading from a different market. Past this the manager simply stops
   * considering thesis exits, which is the safe direction — it does not keep
   * acting on a stale "the thesis is gone".
   */
  private get thesisTtlMs(): number {
    return Number(process.env.PAPER_EXECUTION_INTERVAL_MS ?? 30_000) * 3;
  }

  /**
   * Record what the strategy engine said about open positions on this symbol.
   *
   * Called by `PaperExecutionService` after every evaluation, whatever the
   * verdict — including the ones where no entry was available, which is
   * exactly when a held position most needs its thesis checked.
   */
  recordThesis(symbol: string, evaluations: { strategyId: string; fired: { id: string; note: string }[] }[]): void {
    const byStrategy = new Map<string, { id: string; note: string }[]>();
    for (const evaluation of evaluations) byStrategy.set(evaluation.strategyId, evaluation.fired);
    this.thesisCache.set(symbol.toUpperCase(), { at: Date.now(), byStrategy });
  }

  /** The strategy ids of every position currently open, grouped by symbol. */
  async openStrategyIdsBySymbol(): Promise<Map<string, string[]>> {
    const rows = await this.prisma.executionPosition.findMany({
      where: { state: { in: [ExecutionPositionState.OPEN, ExecutionPositionState.EXITING] } },
      select: { symbol: true, intent: { select: { strategyId: true } } },
    });
    const out = new Map<string, string[]>();
    for (const row of rows) {
      const id = row.intent.strategyId;
      if (!id) continue;
      const key = row.symbol.toUpperCase();
      const existing = out.get(key) ?? [];
      if (!existing.includes(id)) existing.push(id);
      out.set(key, existing);
    }
    return out;
  }

  /**
   * One management pass over every open position.
   *
   * One position's failure never stops the rest — the same rule
   * `OrderService.exitAll` follows, and for the same reason: an unpriceable
   * contract in one profile must not leave another profile's stop unchecked.
   */
  async manageAll(now: Date = new Date()): Promise<ManageSummary> {
    const positions = await this.prisma.executionPosition.findMany({
      // OPEN only. An EXITING position has already had its order placed and is
      // waiting for the fill; deciding again would place a second one.
      where: { state: ExecutionPositionState.OPEN },
      include: {
        profile: { select: { squareOffMinute: true, name: true, trailStepPoints: true } },
        intent: { select: { strategyId: true } },
      },
      orderBy: { entryAt: 'asc' },
    });

    const summary: ManageSummary = { evaluated: 0, held: 0, trailed: 0, exited: 0, errors: 0, exits: [] };
    if (positions.length === 0) return summary;

    // ONE feed read for the whole pass, not one per position. The bridge's
    // 2-second quote cache would collapse them anyway, but reading once also
    // means every position on this tick is judged against the same liveness
    // fact rather than against a feed that changed mid-loop.
    const feed = await this.marketPrice.feedFreshness();
    const freshness = assessFreshness({
      now,
      quotedAt: feed.quotedAt,
      marketOpen: feed.marketOpen,
      maxQuoteAgeMs: Number(process.env.PAPER_EXECUTION_MAX_QUOTE_AGE_MS ?? DEFAULT_MAX_QUOTE_AGE_MS),
    });
    const { minuteOfDay } = istParts(now);

    for (const position of positions) {
      summary.evaluated++;
      try {
        const lastPrice = await this.readPremium(position.instrumentId);
        const action = decidePosition({
          entryPrice: Number(position.entryPrice),
          stopPrice: Number(position.stopPrice),
          targetPrice: Number(position.targetPrice),
          quantity: position.quantity,
          trailStepPoints: Number(position.profile.trailStepPoints),
          trailPrice: position.trailPrice == null ? null : Number(position.trailPrice),
          trailSteps: position.trailSteps,
          highWaterPrice: Number(position.highWaterPrice),
          lastPrice,
          // `assessFreshness` already folded the session flag in; the decision
          // module takes both separately so it can distinguish "the feed died"
          // from "the market closed" in the reason it records.
          feedFresh: freshness.checks.find((c) => c.id === 'quote-age')?.passed ?? false,
          marketOpen: feed.marketOpen,
          minuteOfDay,
          squareOffMinute: position.profile.squareOffMinute,
          firedExitRules: this.thesisFor(position.symbol, position.intent.strategyId),
        });

        await this.apply(position, action, lastPrice, now, summary);
      } catch (err) {
        summary.errors++;
        this.logger.error(
          `${position.profile.name}: management pass failed for ${position.contractSymbol}`,
          err as Error,
        );
      }
    }

    return summary;
  }

  /**
   * The live premium for one contract.
   *
   * Returns null rather than throwing on an unpriceable contract, because
   * "there is no price" is a DECISION INPUT (`decidePosition` treats it as an
   * emergency and flattens) rather than a fault to abort the pass on. Throwing
   * here would leave every position after this one in the loop unmanaged for
   * the tick.
   */
  private async readPremium(instrumentId: string): Promise<number | null> {
    try {
      const instrument = await this.prisma.instrument.findUnique({ where: { id: instrumentId } });
      if (!instrument) return null;
      const price = await this.marketPrice.getPrice(instrument);
      // The BID, not the LTP: a long option is exited by SELLING, and the bid
      // is what that sale receives. Managing a stop against the LTP would
      // consistently trigger late by half the spread on the way out — which is
      // the direction that costs money.
      const exitable = price.bid > 0 ? price.bid : price.ltp;
      return exitable > 0 ? exitable : null;
    } catch {
      return null;
    }
  }

  /** Exit rules that fired for this position's strategy, if the cache is warm. */
  private thesisFor(symbol: string, strategyId: string | null): { id: string; note: string }[] {
    if (!strategyId) return [];
    const cached = this.thesisCache.get(symbol.toUpperCase());
    if (!cached) return [];
    if (Date.now() - cached.at > this.thesisTtlMs) return [];
    return cached.byStrategy.get(strategyId) ?? [];
  }

  /**
   * Perform the single action the decision produced.
   *
   * The trail write and the exit are separate statements on purpose: a trail
   * advance that happens on the same tick as the exit it triggers must be
   * recorded even though the position is closing, or the journal will report a
   * trailing exit at a level that never appears in its own trail history.
   */
  private async apply(
    position: PositionRow,
    action: PositionAction,
    lastPrice: number | null,
    now: Date,
    summary: ManageSummary,
  ): Promise<void> {
    const highWaterPrice = lastPrice != null ? Math.max(Number(position.highWaterPrice), lastPrice) : Number(position.highWaterPrice);
    const unrealizedPnl =
      lastPrice != null ? (lastPrice - Number(position.entryPrice)) * position.quantity : null;

    if (action.trail) {
      // Conditional on `version`, so two managers that somehow both reached
      // this row cannot both ratchet. Leader election makes that improbable;
      // this makes a double-write impossible rather than improbable.
      const claimed = await this.prisma.executionPosition.updateMany({
        where: { id: position.id, version: position.version },
        data: {
          trailPrice: action.trail.toPrice,
          trailSteps: action.trail.totalSteps,
          highWaterPrice,
          version: { increment: 1 },
        },
      });
      if (claimed.count === 1) {
        await this.prisma.executionTrailAdjustment.create({
          data: {
            positionId: position.id,
            fromPrice: action.trail.fromPrice,
            toPrice: action.trail.toPrice,
            triggerPrice: action.trail.triggerPrice,
            highWaterPrice: action.trail.highWaterPrice,
            stepsAdvanced: action.trail.stepsAdvanced,
            totalSteps: action.trail.totalSteps,
            reason: action.trail.reason,
          },
        });
        position.version += 1;
        summary.trailed++;
        this.logger.log(`${position.profile.name}: ${position.contractSymbol} trail → ${action.trail.toPrice} (${action.trail.reason})`);
      }
    }

    if (action.kind === 'hold') {
      await this.prisma.executionPosition.updateMany({
        where: { id: position.id, state: ExecutionPositionState.OPEN },
        data: {
          lastPrice: lastPrice ?? undefined,
          lastPriceAt: lastPrice != null ? now : undefined,
          lastEvaluatedAt: now,
          highWaterPrice,
          unrealizedPnl: unrealizedPnl ?? undefined,
        },
      });
      summary.held++;
      return;
    }

    await this.exit(position, action.reason, action.detail, lastPrice, highWaterPrice, unrealizedPnl, now, summary);
  }

  /**
   * Claim the position, then place the exit order.
   *
   * ## The claim comes FIRST, and that ordering is the whole guarantee
   *
   * `updateMany` with `state: OPEN` in the WHERE clause is atomic: exactly one
   * caller sees `count === 1`. Placing the order first and marking the row
   * afterwards would leave a window in which a second pass reads the position
   * as still OPEN and places a second exit — the same check-then-act window
   * `createIntent` avoids for entries, in the one place where the consequence
   * is a short position on a paper account rather than a duplicate long.
   */
  private async exit(
    position: PositionRow,
    reason: ExitReason,
    detail: string,
    lastPrice: number | null,
    highWaterPrice: number,
    unrealizedPnl: number | null,
    now: Date,
    summary: ManageSummary,
  ): Promise<void> {
    const claimed = await this.prisma.executionPosition.updateMany({
      where: { id: position.id, state: ExecutionPositionState.OPEN },
      data: {
        state: ExecutionPositionState.EXITING,
        exitReason: reason,
        exitDetail: detail,
        exitDecidedAt: now,
        lastPrice: lastPrice ?? undefined,
        lastPriceAt: lastPrice != null ? now : undefined,
        lastEvaluatedAt: now,
        highWaterPrice,
        unrealizedPnl: unrealizedPnl ?? undefined,
        version: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      // Someone else took it. Not an error — this is the mechanism working.
      return;
    }

    // The outcome's `exitReason` is stamped BEFORE the order exists, so a
    // position flattened by this loop is attributable even if the exit order
    // then fails. `ExecutionLifecycleService` reads PENDING as "somebody else
    // closed this", so leaving it PENDING here would misattribute the agent's
    // own exit to a human.
    await this.prisma.executionOutcome.updateMany({
      where: { intentId: position.intentId, exitReason: 'PENDING' },
      data: { exitReason: reason },
    });

    try {
      const order = await this.orders.exitPosition(position.userId, position.instrumentId, position.productType);
      await this.prisma.order.update({ where: { id: order.id }, data: { exitOfIntentId: position.intentId } });
      summary.exited++;
      summary.exits.push({ positionId: position.id, contract: position.contractSymbol, reason, detail });
      this.logger.log(`${position.profile.name}: ${position.contractSymbol} EXIT ${reason} — ${detail}`);
    } catch (err) {
      const message = (err as Error).message;
      // The position is left EXITING with its reason recorded. `reconcile`
      // will see the position is still open and the next pass retries — which
      // is why `Order.exitOfIntentId` is deliberately NOT unique.
      summary.errors++;
      this.logger.error(`${position.profile.name}: exit order failed for ${position.contractSymbol} — ${message}`);
      await this.prisma.executionPosition.updateMany({
        where: { id: position.id, state: ExecutionPositionState.EXITING },
        data: { state: ExecutionPositionState.OPEN, exitDetail: `${detail} (exit order failed: ${message}; will retry)` },
      });
    }
  }

  /**
   * Live state for the console, for every position not yet closed.
   *
   * Read-only and side-effect free — nothing here decides, exits or ratchets.
   * It is the "watch the agent cooking" surface, and it must never be able to
   * change what it is watching.
   */
  async liveState() {
    const positions = await this.prisma.executionPosition.findMany({
      where: { state: { in: [ExecutionPositionState.OPEN, ExecutionPositionState.EXITING] } },
      include: {
        profile: { select: { name: true, agent: true, symbol: true, enabled: true, squareOffMinute: true, trailStepPoints: true } },
        intent: {
          select: {
            id: true,
            strategyId: true,
            strategyName: true,
            strategyVersion: true,
            confidence: true,
            indexDirection: true,
            regime: true,
            optionType: true,
            strike: true,
          },
        },
        trailAdjustments: { orderBy: { at: 'asc' }, select: { fromPrice: true, toPrice: true, at: true, reason: true } },
      },
      orderBy: { entryAt: 'desc' },
    });

    return positions.map((p) => {
      const last = p.lastPrice == null ? null : Number(p.lastPrice);
      const entry = Number(p.entryPrice);
      const trail = p.trailPrice == null ? null : Number(p.trailPrice);
      const stop = Number(p.stopPrice);
      return {
        positionId: p.id,
        intentId: p.intentId,
        profileName: p.profile.name,
        agent: p.profile.agent,
        // Reported so the console can show that a DISARMED profile is still
        // managing an open position — the state the disarm fix creates and the
        // one an operator most needs to be able to see.
        profileEnabled: p.profile.enabled,
        symbol: p.symbol,
        contractSymbol: p.contractSymbol,
        optionType: p.optionType,
        strike: Number(p.intent.strike),
        state: p.state,
        strategyId: p.intent.strategyId,
        strategyName: p.intent.strategyName,
        strategyVersion: p.intent.strategyVersion,
        regime: p.intent.regime,
        indexDirection: p.intent.indexDirection,
        confidence: p.intent.confidence,
        quantity: p.quantity,
        entryPrice: entry,
        entryAt: p.entryAt.toISOString(),
        lastPrice: last,
        lastPriceAt: p.lastPriceAt?.toISOString() ?? null,
        lastEvaluatedAt: p.lastEvaluatedAt?.toISOString() ?? null,
        stopPrice: stop,
        targetPrice: Number(p.targetPrice),
        trailPrice: trail,
        trailSteps: p.trailSteps,
        // The level an exit actually triggers on right now — the wider of the
        // two, computed once here so the console cannot show a different
        // number from the one the manager will act on.
        effectiveStop: trail == null ? stop : Math.max(stop, trail),
        highWaterPrice: Number(p.highWaterPrice),
        unrealizedPnl: p.unrealizedPnl == null ? null : Number(p.unrealizedPnl),
        exitReason: p.exitReason,
        exitDetail: p.exitDetail,
        squareOffMinute: p.profile.squareOffMinute,
        trailStepPoints: Number(p.profile.trailStepPoints),
        trailHistory: p.trailAdjustments.map((t) => ({
          from: t.fromPrice == null ? null : Number(t.fromPrice),
          to: Number(t.toPrice),
          at: t.at.toISOString(),
          reason: t.reason,
        })),
      };
    });
  }
}

export interface ManageSummary {
  evaluated: number;
  held: number;
  trailed: number;
  exited: number;
  errors: number;
  exits: { positionId: string; contract: string; reason: ExitReason; detail: string }[];
}

type PositionRow = Prisma.ExecutionPositionGetPayload<{
  include: {
    profile: { select: { squareOffMinute: true; name: true; trailStepPoints: true } };
    intent: { select: { strategyId: true } };
  };
}>;

/** Re-exported so the scheduler need not import the enum from Prisma directly. */
export { ExecutionIntentStatus };
