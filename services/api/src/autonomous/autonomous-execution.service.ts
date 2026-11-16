/**
 * Turning an accepted candidate into a real position in the application's own
 * PAPER-MONEY engine.
 *
 * ## It builds no second broker
 *
 * Every order here goes through `OrderService.placeOrder` — the same call a
 * human order ticket makes — against the same `PaperWallet`, producing the same
 * `Order` and `Position` rows, with the same charges and the same fill model.
 * Nothing in this file simulates money. It decides, sizes, and asks the
 * existing OMS, which is the only thing that moves it.
 *
 * ## And it asks Sentinel nothing
 *
 * The contract comes from `ContractSelectorService` (the bridge's option
 * chain), the levels from the brain's own plan, the size from the account. The
 * pre-existing paper path reads its strike off a Sentinel response; this one
 * has no Sentinel client to read from.
 *
 * ## Idempotency is a database constraint, not a check
 *
 * `AutonomousTrade.candidateId` is UNIQUE. A repeated observer tick, a retry, a
 * duplicate delivery, or a process that died between placing the order and
 * recording it all converge on the same outcome: the second attempt loses the
 * insert. A check-then-place would race — two ticks can both read "no trade
 * yet" before either writes.
 *
 * The row is therefore claimed BEFORE the order is placed, and updated with
 * the fill afterwards. That ordering is deliberate: an unclaimed order is a
 * position nobody is managing, while a claimed row with no order is a visible,
 * repairable inconsistency.
 *
 * ## It fails closed
 *
 * No data, stale data, closed market, unreadable contract, unknown position
 * state, uncertain risk — every one of them produces a refusal, never a
 * best-effort trade.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TradeCandidate } from '@tradew/strategy-core';
import { PrismaService } from '../prisma/prisma.service';
import { OrderService } from '../sim/order.service';
import { MarketPriceService } from '../sim/market-price.service';
import { assessFreshness } from '../paper-execution/execution-freshness';
import { evaluatePolicy } from '../paper-execution/execution-policy';
import { computeDailyDrawdown, computeExposure } from '../paper-execution/execution-drawdown';
import { modelPaperFill } from '../paper-execution/execution-fill';
import { istParts } from '../paper-execution/execution-identity';
import { ContractSelectorService } from './contract-selector.service';
import { sizeFromRisk } from './autonomous-sizing';
import { BRAIN_VERSION } from './brain-version';
import { autonomousExecutionEnabled } from './setup-scanner.service';

/** The agent name autonomous execution profiles carry. */
export const AUTONOMOUS_AGENT = 'autonomous-brain';

/**
 * How far past the planned entry price the market may have moved and still be
 * entered, as a fraction of the planned risk.
 *
 * §8 — NO CHASING. The plan's edge is the distance between entry and stop; if
 * price has already travelled a quarter of that in the trade's favour before
 * the order goes in, the remaining reward:risk is no longer the one that was
 * validated, and entering anyway would be silently taking a worse trade than
 * the one the gate approved.
 *
 * The answer is never to move the entry, widen the stop or trim the target —
 * it is to let the setup go and wait for a new one.
 */
export const MAX_ENTRY_DRIFT_R = 0.25;

export type ExecutionRefusal =
  | 'execution-disabled'
  | 'no-plan'
  | 'already-executed'
  | 'no-profile'
  | 'contract-unavailable'
  | 'instrument-unresolvable'
  | 'stale-data'
  | 'market-closed'
  | 'entry-missed'
  | 'sizing-refused'
  | 'risk-gate-refused'
  | 'order-failed';

export interface ExecutionResult {
  executed: boolean;
  tradeId: string | null;
  orderId: string | null;
  refusal: ExecutionRefusal | null;
  detail: string | null;
  /** Every gate that ran, for the journal. */
  checks: { id: string; passed: boolean; detail: string }[];
}

@Injectable()
export class AutonomousExecutionService {
  private readonly logger = new Logger(AutonomousExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly marketPrice: MarketPriceService,
    private readonly contracts: ContractSelectorService,
  ) {}

  /**
   * Execute one accepted candidate, or say why not.
   *
   * `candidateId` is the persisted row; `candidate` is the in-memory decision.
   * Both are required — the row is what makes execution idempotent, the
   * decision is what carries the plan.
   */
  async execute(
    candidateId: string,
    candidate: TradeCandidate,
    now: Date = new Date(),
  ): Promise<ExecutionResult> {
    const checks: ExecutionResult['checks'] = [];
    const check = (id: string, passed: boolean, detail: string) => {
      checks.push({ id, passed, detail });
      return passed;
    };
    const refuse = (refusal: ExecutionRefusal, detail: string): ExecutionResult => ({
      executed: false,
      tradeId: null,
      orderId: null,
      refusal,
      detail,
      checks,
    });

    // ---- 0. May the brain trade at all? ------------------------------------
    if (!check('execution-enabled', autonomousExecutionEnabled(), 'AUTONOMOUS_ENGINE_ENABLED')) {
      return refuse('execution-disabled', 'AUTONOMOUS_ENGINE_ENABLED is not true — the brain may observe but not trade.');
    }
    if (!candidate.plan || !candidate.accepted) {
      return refuse('no-plan', 'Only an accepted candidate carrying a complete plan may be executed.');
    }

    // ---- 1. Has this candidate already been executed? ----------------------
    const existing = await this.prisma.autonomousTrade.findUnique({
      where: { candidateId },
      select: { id: true, entryOrderId: true },
    });
    if (existing) {
      check('idempotency', false, `Candidate already has trade ${existing.id}.`);
      return {
        executed: false,
        tradeId: existing.id,
        orderId: existing.entryOrderId,
        refusal: 'already-executed',
        detail: `This candidate already produced trade ${existing.id}. One candidate, one lifecycle.`,
        checks,
      };
    }
    check('idempotency', true, 'No trade exists for this candidate yet.');

    // ---- 2. The account and its limits -------------------------------------
    const profile = await this.prisma.executionProfile.findFirst({
      where: { agent: AUTONOMOUS_AGENT, symbol: candidate.symbol, enabled: true },
    });
    if (!profile) {
      return refuse(
        'no-profile',
        `No enabled ${AUTONOMOUS_AGENT} execution profile exists for ${candidate.symbol}. ` +
          `The brain may only trade an account that has been deliberately armed for it.`,
      );
    }
    check('profile-armed', true, `Trading account ${profile.accountUserId} via profile ${profile.name}.`);

    // ---- 3. The tradable contract, and the 1:3 floor in ITS price space -----
    const resolved = await this.contracts.resolve(candidate.symbol, candidate.plan, now);
    if (!resolved.ok) {
      check('contract', false, resolved.detail);
      return refuse('contract-unavailable', resolved.detail);
    }
    const contract = resolved.contract;
    check(
      'contract',
      true,
      `${contract.tradedSymbol} — tradable R:R ${contract.tradable.rr}:1` +
        (contract.premium ? ` (premium ${contract.tradable.entry} → ${contract.tradable.stop})` : ''),
    );

    // ---- 4. Make it a real instrument and price it -------------------------
    let instrument;
    let price;
    try {
      instrument = await this.marketPrice.resolveInstrument(contract.tradedSymbol);
      price = await this.marketPrice.getPrice(instrument);
    } catch (err) {
      const detail = `Could not resolve or price ${contract.tradedSymbol}: ${err instanceof Error ? err.message : String(err)}`;
      check('instrument', false, detail);
      return refuse('instrument-unresolvable', detail);
    }
    check('instrument', true, `${contract.tradedSymbol} lot ${instrument.lotSize}, ltp ${price.ltp}.`);

    // ---- 5. Is the feed ALIVE, and the venue open? -------------------------
    const feed = await this.marketPrice.feedFreshness();
    const freshness = assessFreshness({
      now,
      quotedAt: feed.quotedAt,
      marketOpen: feed.marketOpen,
      maxQuoteAgeMs: profile.maxQuoteAgeMs,
    });
    const freshDetail = freshness.reason ?? `Newest tick ${freshness.ageMs ?? '—'} ms ago.`;
    if (!check('feed-fresh', freshness.ok, freshDetail)) {
      return refuse('stale-data', `Refusing to trade on stale data: ${freshDetail}`);
    }
    if (!check('market-open', price.marketOpen, price.marketOpen ? 'Venue is open.' : 'Venue is closed.')) {
      return refuse('market-closed', 'The venue is closed; no entry may be taken.');
    }

    // ---- 6. NO CHASING ------------------------------------------------------
    //
    // The plan was validated against a specific entry. If price has already run
    // in the trade's favour, the remaining reward:risk is not the one the gate
    // approved — and the correct response is to let it go.
    const drift = Math.abs(price.ltp - contract.tradable.entry);
    const driftR = contract.tradable.risk > 0 ? drift / contract.tradable.risk : Infinity;
    const favourable =
      candidate.plan.direction === 'long'
        ? price.ltp > contract.tradable.entry
        : price.ltp < contract.tradable.entry;
    if (favourable && driftR > MAX_ENTRY_DRIFT_R) {
      const detail =
        `Entry has run away: planned ${contract.tradable.entry}, now ${price.ltp} — ${driftR.toFixed(2)}R ` +
        `of drift, past the ${MAX_ENTRY_DRIFT_R}R limit. NOT chasing; this candidate expires and the ` +
        `brain waits for a new setup.`;
      check('no-chasing', false, detail);
      return refuse('entry-missed', detail);
    }
    check('no-chasing', true, `Entry drift ${driftR.toFixed(2)}R, inside the ${MAX_ENTRY_DRIFT_R}R limit.`);

    // ---- 7. Size it from the account and the stop distance ------------------
    const facts = await this.gatherFacts(profile.accountUserId, profile.id, now);
    const provisionalFill = modelPaperFill({
      side: 'BUY',
      ltp: price.ltp,
      bid: price.bid,
      ask: price.ask,
      quantity: instrument.lotSize,
      quoteAgeMs: freshness.ageMs ?? 0,
      marketOpen: price.marketOpen,
      orderType: profile.orderType,
    });

    const sizing = sizeFromRisk({
      walletEquity: facts.walletEquity,
      riskPerTradePct: Number(profile.riskPerTradePct),
      capitalAllocationPct: Number(profile.capitalAllocationPct),
      // Size on the price the order will actually PAY, not the LTP — sizing on
      // the LTP and filling on the ask overstates the position by the spread.
      entryPrice: provisionalFill.fillPrice,
      stopPrice: contract.tradable.stop,
      lotSize: instrument.lotSize,
      maxLots: profile.lots,
    });
    if (!sizing.ok) {
      check('sizing', false, sizing.detail);
      return refuse('sizing-refused', sizing.detail);
    }
    check('sizing', true, `${sizing.quantity} units risking ${sizing.stopDistance} each.`);

    const sizedFill = modelPaperFill({
      side: 'BUY',
      ltp: price.ltp,
      bid: price.bid,
      ask: price.ask,
      quantity: sizing.quantity,
      quoteAgeMs: freshness.ageMs ?? 0,
      marketOpen: price.marketOpen,
      orderType: profile.orderType,
    });
    const estimatedCost = sizedFill.fillPrice * sizing.quantity;

    // ---- 8. THE RISK GATE — the same one the Sentinel path uses -------------
    const ist = istParts(now);
    const policy = evaluatePolicy({
      enabled: profile.enabled,
      environment: profile.environment,
      minConfidence: profile.minConfidence,
      maxOpenPositions: profile.maxOpenPositions,
      maxOrdersPerDay: profile.maxOrdersPerDay,
      maxLossPerDay: Number(profile.maxLossPerDay),
      squareOffMinute: profile.squareOffMinute,
      // The brain's own quality score stands in for Sentinel's confidence.
      // Both are 0-100 measures of how much of the setup confirmed.
      confidence: candidate.quality,
      openPositions: facts.openPositions,
      ordersToday: facts.ordersToday,
      realizedPnlToday: facts.realizedPnlToday,
      minuteOfDay: ist.minuteOfDay,
      marketOpen: price.marketOpen,
      availableCash: facts.availableCash,
      estimatedCost,
      quoteFresh: freshness.ok,
      quoteFreshnessDetail: freshDetail,
      // The direction check the gate makes is index-read vs option side; the
      // brain's own bias IS the index read, so they agree by construction and
      // this is the second, independent assertion of it.
      indexDirection: candidate.plan.direction === 'long' ? 'bullish' : 'bearish',
      optionSide: contract.optionType ?? (candidate.plan.direction === 'long' ? 'CE' : 'PE'),
      calibrationAdjustment: 0,
      riskPlanOk: true,
      riskPlanReason: null,
      riskPlanCheckId: null,
      drawdown: computeDailyDrawdown(facts.realizedSeries, facts.walletEquity),
      maxDrawdownPct: profile.maxDrawdownPct == null ? null : Number(profile.maxDrawdownPct),
      exposure: computeExposure({
        openPremiumAtRisk: facts.openPremiumAtRisk,
        proposedCost: estimatedCost,
        walletEquity: facts.walletEquity,
      }),
      maxPortfolioExposurePct:
        profile.maxPortfolioExposurePct == null ? null : Number(profile.maxPortfolioExposurePct),
    });
    for (const c of policy.checks) checks.push({ id: c.id, passed: c.passed, detail: c.detail });
    if (!policy.allowed) {
      return refuse('risk-gate-refused', policy.reason ?? 'The risk gate refused this order.');
    }

    // ---- 9. CLAIM the candidate, THEN place the order -----------------------
    let tradeId: string;
    try {
      const claimed = await this.prisma.autonomousTrade.create({
        data: {
          candidateId,
          market: candidate.market,
          symbol: candidate.symbol,
          venue: profile.environment,
          // The TRADABLE direction, not the index direction. A bearish index
          // read is expressed by BUYING a put, so the position is LONG in
          // premium space: the stop sits below the entry premium and the
          // target above it. Storing the index direction here made the manager
          // read a long put as a short, and it exited the position on the tick
          // it opened. The index view is not lost — `optionType` carries it
          // (CE = bullish, PE = bearish).
          direction: contract.optionType ? 'long' : candidate.plan.direction,
          brainVersion: BRAIN_VERSION,
          tradedSymbol: contract.tradedSymbol,
          instrumentId: instrument.id,
          optionType: contract.optionType,
          strike: contract.strike == null ? null : new Prisma.Decimal(contract.strike),
          expiry: contract.expiry,
          lotSize: instrument.lotSize,
          lots: sizing.lots,
          quantity: sizing.quantity,
          indexEntry: new Prisma.Decimal(candidate.plan.entry),
          indexStop: new Prisma.Decimal(candidate.plan.stop),
          indexTarget: new Prisma.Decimal(candidate.plan.target),
          indexFirstReward: new Prisma.Decimal(candidate.plan.firstRewardPrice),
          plannedEntry: new Prisma.Decimal(contract.tradable.entry),
          initialStop: new Prisma.Decimal(contract.tradable.stop),
          initialTarget: new Prisma.Decimal(contract.tradable.target),
          firstRewardPrice: new Prisma.Decimal(contract.tradable.firstReward),
          initialRisk: new Prisma.Decimal(contract.tradable.risk),
          initialReward: new Prisma.Decimal(contract.tradable.reward),
          plannedRR: new Prisma.Decimal(contract.tradable.rr),
          premiumTranslation: contract.premium as unknown as Prisma.InputJsonValue,
          walletEquity: new Prisma.Decimal(facts.walletEquity),
          riskBudget: new Prisma.Decimal(sizing.riskBudget),
          stopDistance: new Prisma.Decimal(sizing.stopDistance),
          calculatedQuantity: sizing.calculatedQuantity,
          approvedQuantity: sizing.quantity,
          sizingRationale: sizing.steps as unknown as Prisma.InputJsonValue,
          orderStatus: 'PENDING',
          positionStatus: 'PENDING',
          currentStop: new Prisma.Decimal(contract.tradable.stop),
          executionAssumptions: {
            fillModel: sizedFill,
            quoteAgeMs: freshness.ageMs,
            orderType: profile.orderType,
          } as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      tradeId = claimed.id;
    } catch (err) {
      // A unique violation here is another worker winning the race — the
      // correct, quiet outcome.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        check('idempotency', false, 'Another worker claimed this candidate first.');
        return refuse('already-executed', 'Another worker claimed this candidate first; no second order was placed.');
      }
      throw err;
    }

    // ---- 10. The paper order, through the application's own OMS ------------
    try {
      const order = await this.orders.placeOrder(profile.accountUserId, {
        symbol: contract.tradedSymbol,
        side: 'BUY',
        quantity: sizing.quantity,
        type: profile.orderType,
        productType: profile.productType,
      });

      const filled = order.status === 'FILLED';
      await this.prisma.autonomousTrade.update({
        where: { id: tradeId },
        data: {
          entryOrderId: order.id,
          orderStatus: order.status,
          actualFillPrice: order.avgFillPrice,
          filledQuantity: order.filledQuantity,
          entryAt: filled ? (order.placedAt ?? now) : null,
          positionStatus: filled ? 'OPEN' : 'PENDING',
          // The high-water mark starts at the fill, so the ratchet measures
          // from what was actually paid.
          highWaterPrice: filled ? order.avgFillPrice : null,
        },
      });

      this.logger.log(
        `PAPER ENTRY ${contract.tradedSymbol} qty ${sizing.quantity} @ ${order.avgFillPrice ?? '—'} ` +
          `(${order.status}) — stop ${contract.tradable.stop}, target ${contract.tradable.target}, ` +
          `${contract.tradable.rr}R. trade=${tradeId}`,
      );

      return { executed: filled, tradeId, orderId: order.id, refusal: null, detail: null, checks };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // The claim stays, marked failed. A claimed row with no order is a
      // visible inconsistency; an order with no claim is an unmanaged position.
      await this.prisma.autonomousTrade.update({
        where: { id: tradeId },
        data: { orderStatus: 'FAILED', positionStatus: 'FAILED', exitReason: `order rejected: ${detail}` },
      });
      check('order', false, detail);
      return { executed: false, tradeId, orderId: null, refusal: 'order-failed', detail, checks };
    }
  }

  /** Account facts the gate and the sizer both need. */
  private async gatherFacts(userId: string, profileId: string, now: Date) {
    const ist = istParts(now);
    const dayStart = new Date(`${ist.dayKey}T00:00:00.000+05:30`);

    const [wallet, openTrades, ordersToday, closedToday] = await Promise.all([
      this.prisma.paperWallet.findUnique({ where: { userId } }),
      this.prisma.autonomousTrade.findMany({
        where: { positionStatus: 'OPEN' },
        select: { plannedEntry: true, quantity: true },
      }),
      this.prisma.autonomousTrade.count({ where: { createdAt: { gte: dayStart } } }),
      this.prisma.autonomousTrade.findMany({
        where: { positionStatus: 'CLOSED', exitAt: { gte: dayStart } },
        select: { realizedPnl: true, exitAt: true },
        orderBy: { exitAt: 'asc' },
      }),
    ]);

    const cash = wallet ? Number(wallet.cashBalance) : 0;
    const blocked = wallet ? Number(wallet.marginUsed) : 0;
    const realizedSeries = closedToday.map((t) => ({
      executedAt: t.exitAt ?? now,
      realizedPnl: Number(t.realizedPnl ?? 0),
    }));

    return {
      walletEquity: cash + blocked,
      availableCash: cash,
      openPositions: openTrades.length,
      ordersToday,
      realizedPnlToday: realizedSeries.reduce((a, t) => a + t.realizedPnl, 0),
      realizedSeries,
      openPremiumAtRisk: openTrades.reduce((sum, t) => sum + Number(t.plannedEntry) * t.quantity, 0),
      profileId,
    };
  }
}
