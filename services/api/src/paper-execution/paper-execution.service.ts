import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ExecutionIntentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isTradingDay } from '../discipline/market-calendar';
import { MarketPriceService, type LivePrice } from '../sim/market-price.service';
import { OrderService } from '../sim/order.service';
import { ExecutionAccountService } from './execution-account.service';
import { ExecutionCalibrationService } from './execution-calibration.service';
import { modelPaperFill, reconcileFill, type PaperFillModel } from './execution-fill';
import { assessFreshness } from './execution-freshness';
import { contractSymbol, deriveIdempotencyKey, istParts } from './execution-identity';
import { countProfileOpenPositions } from './execution-open-positions';
import {
  OMS_REJECTED,
  SESSION_OPEN_MINUTE,
  SUBMISSION_RAISED,
  type PolicyCheck,
  type PolicyDecision,
  evaluatePolicy,
} from './execution-policy';
import { planRisk, type RiskPlan } from './execution-risk';
import { PositionManagerService } from './position-manager.service';
import { SentinelExecutionClient, type ExecutionEvaluationDto } from './sentinel-execution.client';

/**
 * The Sentinel paper-execution loop.
 *
 * ## What this service is, in one line
 *
 * It turns a Sentinel observation that already cleared Sentinel's own gates
 * into an order placed through the EXISTING `OrderService`, and records why.
 *
 * ## What it deliberately is not
 *
 * It is not a matching engine — `MatchingEngineService` fills resting orders,
 * unchanged. It is not a P&L engine — `OrderService.executeFill` computes
 * realized P&L and `PositionService` marks positions to market, unchanged. It
 * is not a strategy engine, a market-data engine or a second Sentinel; every
 * judgement it acts on arrives from `POST /execution/evaluate`.
 *
 * The entire "execution" contribution of this file is: decide whether to act,
 * make the act idempotent, call `placeOrder`, and keep the provenance.
 *
 * ## Order of operations, and why it is that order
 *
 *   1. Cheap local preflight (enabled, PAPER, trading day, session window).
 *      Before the network call, so a closed market costs nothing.
 *   2. Ask Sentinel. If it publishes no side, stop — nothing is recorded,
 *      because "Sentinel stayed silent" is the normal resting state and
 *      writing a row for it every minute would bury the real decisions.
 *   3. Resolve the contract and read its live price. This is where the
 *      selected strike becomes a real, tradable `Instrument`.
 *   4. Claim the idempotency key by INSERTING the intent — before any order
 *      exists. A racing replica loses here, on a database constraint, not on
 *      a check-then-act window.
 *   5. Apply risk policy, recording the result on the intent either way.
 *   6. Submit through `OrderService`.
 *
 * Step 4 preceding step 6 is the load-bearing part: the intent is the thing
 * that is unique, so two concurrent decisions cannot both reach `placeOrder`.
 */

export type RunOutcome =
  | 'executed'
  | 'duplicate'
  | 'rejected'
  | 'failed'
  | 'skipped-disabled'
  | 'skipped-market-closed'
  | 'skipped-no-signal';

export interface ExecutionRunResult {
  outcome: RunOutcome;
  profileId: string;
  profileName: string;
  reason: string;
  intentId: string | null;
  orderId: string | null;
  /** Sentinel's verdict, when it was consulted. */
  verdict: ExecutionEvaluationDto['verdict'] | null;
  checks: PolicyCheck[];
}

/** IST minute-of-day the Indian equity session closes (15:30). */
const SESSION_CLOSE_MINUTE = 15 * 60 + 30;

@Injectable()
export class PaperExecutionService {
  private readonly logger = new Logger(PaperExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sentinel: SentinelExecutionClient,
    private readonly orders: OrderService,
    private readonly marketPrice: MarketPriceService,
    private readonly accounts: ExecutionAccountService,
    private readonly positions: PositionManagerService,
    private readonly calibration: ExecutionCalibrationService,
  ) {}

  /**
   * The last pass's outcome per profile, in memory.
   *
   * The intent table records DECISIONS, and most passes correctly produce none
   * — Sentinel staying silent is the designed resting state. So a console
   * reading only that table cannot tell an agent that is watching and finding
   * nothing from an agent that is not running, which is precisely the question
   * "is it cooking?" asks. This holds the answer.
   *
   * Not persisted, for the same reason `ExecutionLoopStatus` is not: it is
   * this process's own live state, and a row asserting "last evaluated 10:42"
   * would keep asserting it after the process that wrote it had gone.
   */
  private readonly lastDecision = new Map<string, { at: Date; result: ExecutionRunResult }>();

  /**
   * Run one profile once.
   *
   * `now` is injectable so the session-window and decision-bucket behaviour can
   * be asserted deterministically — a loop whose correctness depends on the
   * clock must not be testable only during market hours.
   */
  async runProfile(profileId: string, now: Date = new Date()): Promise<ExecutionRunResult> {
    const profile = await this.prisma.executionProfile.findUnique({
      where: { id: profileId },
      include: { account: { select: { id: true, email: true } } },
    });
    if (!profile) throw new NotFoundException(`No execution profile ${profileId}`);

    const base = { profileId: profile.id, profileName: profile.name, intentId: null, orderId: null, checks: [] };
    const record = (result: ExecutionRunResult): ExecutionRunResult => {
      // Every pass's outcome is kept in memory for the console, whether or not
      // it produced a row. Most passes correctly produce nothing — Sentinel
      // staying silent is the designed resting state — and a console that can
      // only read the intent table therefore cannot distinguish "the agent is
      // watching and finding nothing" from "the agent is dead". That gap is
      // what this closes; see `agentState()`.
      this.lastDecision.set(profile.id, { at: now, result });
      return result;
    };

    if (!profile.enabled) {
      return record({ ...base, outcome: 'skipped-disabled', verdict: null, reason: 'Profile is disabled.' });
    }
    // Belt and braces against a row that did not come from this application —
    // see the same check in `evaluatePolicy`.
    if (profile.environment !== 'PAPER') {
      return record({
        ...base,
        outcome: 'rejected',
        verdict: null,
        reason: `Refused: profile environment is "${profile.environment}", not PAPER.`,
      });
    }

    // ---- 1b. WHOSE account may this profile trade? -------------------------
    //
    // Before the session check and before Sentinel, because an unauthorized
    // profile must not spend a market evaluation to be told no — and because
    // "you may not trade this account" is a more fundamental answer than "the
    // market is shut".
    //
    // Re-read every pass. Consent is revocable, and caching it on the profile
    // would let a revoked grant keep trading until something invalidated a
    // cache. See ExecutionAccountService.
    const accountAuth = await this.accounts.authorize({
      environment: profile.environment,
      accountScope: profile.accountScope,
      accountUserId: profile.accountUserId,
      symbol: profile.symbol,
      agent: profile.agent,
    });
    if (!accountAuth.authorized) {
      return record({
        ...base,
        outcome: 'rejected',
        verdict: null,
        reason: accountAuth.reason ?? 'Account authorization failed.',
        checks: accountAuth.checks,
      });
    }

    const { minuteOfDay } = istParts(now);
    const sessionOpen =
      isTradingDay(now) && minuteOfDay >= SESSION_OPEN_MINUTE && minuteOfDay < SESSION_CLOSE_MINUTE;
    if (!sessionOpen) {
      return record({
        ...base,
        outcome: 'skipped-market-closed',
        verdict: null,
        reason: isTradingDay(now)
          ? 'Outside the 09:15–15:30 IST session.'
          : 'Not an NSE trading day.',
      });
    }

    // ---- 2. Ask the one canonical Sentinel ---------------------------------
    //
    // The request now carries this agent's OWN configuration — its strategy
    // roster, its data-quality floors, and the strategies behind whatever it
    // currently holds. That last one is what lets the two-second position
    // manager evaluate a thesis without a market read: the exit rules are
    // computed on the SAME snapshot as the entry search.
    const openBySymbol = await this.positions.openStrategyIdsBySymbol();
    const evaluation = await this.sentinel.evaluate({
      symbol: profile.symbol,
      userId: profile.accountUserId,
      strategyId: profile.strategyId,
      minConfidence: profile.minConfidence,
      strategyIds: profile.strategyIds,
      minCandles: profile.minCandles,
      maxBarAgeMinutes: profile.maxBarAgeMinutes,
      openStrategyIds: openBySymbol.get(profile.symbol.toUpperCase()) ?? [],
    });

    // Hand the thesis read to the fast loop BEFORE any early return. A pass
    // that finds no entry still refreshed what the open positions need.
    this.positions.recordThesis(profile.symbol, evaluation.exitRuleEvaluations ?? []);

    if (!evaluation.executable || !evaluation.strikes.selected || !evaluation.expiry) {
      // Nothing is written to the intent table. Sentinel declining to publish
      // is the designed resting state, and a row per quiet minute would make
      // that table useless as a record of decisions. The verdict and every gate
      // that produced it are kept in `lastDecision` for the console instead.
      return record({
        ...base,
        outcome: 'skipped-no-signal',
        verdict: evaluation.verdict,
        reason: evaluation.reason,
        checks: (evaluation.confirmations ?? []).map((c) => ({
          id: c.id,
          label: c.label,
          passed: c.passed,
          detail: c.detail,
        })),
      });
    }

    const selected = evaluation.strikes.selected;
    const expiry = new Date(evaluation.expiry);
    const side = 'BUY' as const;
    // Long options only, and structurally so. A long option's risk is capped at
    // the premium; a SHORT option's is on the underlying and is the one case
    // `computeMargin` exists to get right. A learning loop has no business
    // discovering that distinction with an unbounded position, so this side is
    // a constant rather than a profile column — widening it would be a
    // deliberate schema and review step.

    // ---- 3. Make the selected strike a real tradable contract --------------
    const symbol = contractSymbol({
      underlying: profile.symbol,
      expiry,
      strike: selected.strike,
      optionType: selected.optionType,
    });

    let instrument;
    let price;
    try {
      // Resolves through the broker scrip master and upserts the Instrument row
      // — the same path a human order ticket takes for an option contract.
      instrument = await this.marketPrice.resolveInstrument(symbol);
      price = await this.marketPrice.getPrice(instrument);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`${profile.name}: could not price ${symbol} — ${message}`);
      return record({
        ...base,
        outcome: 'failed',
        verdict: evaluation.verdict,
        reason: `Selected contract ${symbol} could not be resolved or priced: ${message}`,
      });
    }

    // ---- 3b. Is the FEED alive, not merely reachable? ----------------------
    const feed = await this.marketPrice.feedFreshness();
    const freshness = assessFreshness({
      now,
      quotedAt: feed.quotedAt,
      marketOpen: feed.marketOpen,
      maxQuoteAgeMs: profile.maxQuoteAgeMs,
    });

    // ---- 3c. The RISK PLAN, before any order exists ------------------------
    //
    // Position size, stop and target are computed here and written into the
    // intent in the same INSERT that claims the idempotency key. A stop
    // computed after the fill is a stop that does not exist during the window
    // in which it is most needed.
    const facts = await this.gatherFacts(profile.accountUserId, profile.id, now);
    const fillModel = modelPaperFill({
      side,
      ltp: price.ltp,
      bid: price.bid,
      ask: price.ask,
      // Provisional: the real quantity comes out of the plan below, and the
      // model is recomputed with it once it is known.
      quantity: instrument.lotSize,
      quoteAgeMs: freshness.ageMs,
      marketOpen: price.marketOpen,
      orderType: profile.orderType,
    });
    const plan = planRisk({
      // Cash plus margin already blocked — the whole paper capital, not just
      // the unencumbered part. Sizing against free cash alone would shrink an
      // agent's allocation every time the account holder opened a position of
      // their own, which is a different account's business.
      walletEquity: facts.walletEquity,
      // The price the entry would actually PAY, from the fill model, not the
      // LTP. Sizing on the LTP and filling on the ask overstates the position
      // by the spread on every trade.
      entryPrice: fillModel.fillPrice,
      lotSize: instrument.lotSize,
      maxLots: profile.lots,
      capitalAllocationPct: Number(profile.capitalAllocationPct),
      riskPerTradePct: Number(profile.riskPerTradePct),
      rewardPerTradePct: Number(profile.rewardPerTradePct),
    });

    const quantity = plan.ok ? plan.quantity : profile.lots * instrument.lotSize;
    const sizedFill = modelPaperFill({ ...fillModelInput(price, side, quantity, freshness.ageMs, profile.orderType) });
    const estimatedCost = sizedFill.fillPrice * quantity;

    // ---- 3d. What has this bucket learned? ---------------------------------
    const calibration = await this.calibration.adjustmentFor({
      agent: profile.agent,
      symbol: profile.symbol,
      strategyId: evaluation.agentStrategy?.strategyId ?? evaluation.strategyId ?? 'unknown',
      strategyVersion: evaluation.agentStrategy?.version ?? '0.0.0',
      regime: evaluation.agentStrategy?.regime ?? 'unknown',
    });

    // ---- 4. Claim the decision's identity ----------------------------------
    const idempotencyKey = deriveIdempotencyKey({
      profileId: profile.id,
      symbol: profile.symbol,
      optionType: selected.optionType,
      strike: selected.strike,
      expiry: evaluation.expiry.slice(0, 10),
      side,
      decidedAt: now,
    });

    const policy = evaluatePolicy({
      enabled: profile.enabled,
      environment: profile.environment,
      minConfidence: profile.minConfidence,
      maxOpenPositions: profile.maxOpenPositions,
      maxOrdersPerDay: profile.maxOrdersPerDay,
      maxLossPerDay: Number(profile.maxLossPerDay),
      squareOffMinute: profile.squareOffMinute,
      confidence: evaluation.confidence,
      openPositions: facts.openPositions,
      ordersToday: facts.ordersToday,
      realizedPnlToday: facts.realizedPnlToday,
      minuteOfDay,
      marketOpen: price.marketOpen,
      availableCash: facts.availableCash,
      estimatedCost,
      quoteFresh: freshness.checks.find((c) => c.id === 'quote-age')?.passed ?? false,
      quoteFreshnessDetail:
        freshness.checks.find((c) => c.id === 'quote-age')?.detail ?? 'Feed freshness could not be read.',
      indexDirection: evaluation.indexDirection?.direction ?? 'unclear',
      optionSide: selected.optionType,
      calibrationAdjustment: calibration.adjustment,
      riskPlanOk: plan.ok,
      riskPlanReason: plan.reason,
      riskPlanCheckId: plan.failedCheckId,
    });

    const created = await this.createIntent({
      profile,
      evaluation,
      selected,
      expiry,
      side,
      contract: symbol,
      quantity,
      idempotencyKey,
      now,
      policy,
      plan,
      fillModel: sizedFill,
      calibration,
    });

    if (created.duplicate) {
      return record({
        ...base,
        outcome: 'duplicate',
        verdict: evaluation.verdict,
        intentId: created.intent.id,
        orderId: created.intent.orderId ?? null,
        reason: 'This decision was already recorded; no second order was created.',
        checks: policy.checks,
      });
    }

    if (!policy.allowed) {
      return record({
        ...base,
        outcome: 'rejected',
        verdict: evaluation.verdict,
        intentId: created.intent.id,
        reason: policy.reason ?? 'Rejected by execution policy.',
        checks: policy.checks,
      });
    }

    // ---- 6. Submit through the EXISTING order service ----------------------
    try {
      const order = await this.orders.placeOrder(profile.accountUserId, {
        symbol,
        side,
        type: profile.orderType,
        // The RISK-PLANNED quantity, not `profile.lots × lotSize`. This is the
        // line that makes the capital model real rather than decorative: the
        // allocation ceiling and the risk budget decide the size, and the
        // profile's `lots` is only ever an upper bound on their answer.
        quantity,
        productType: profile.productType,
      });

      // The link is written in the same statement that advances the intent, so
      // a submitted intent always has its order and an order produced by this
      // loop always names its intent.
      const filled = order.status === 'FILLED';
      const omsRejected = order.status === 'REJECTED';
      await this.prisma.$transaction(async (tx) => {
        await tx.order.update({ where: { id: order.id }, data: { executionIntentId: created.intent.id } });
        await tx.executionIntent.update({
          where: { id: created.intent.id },
          data: {
            status: omsRejected ? ExecutionIntentStatus.FAILED : filled ? ExecutionIntentStatus.FILLED : ExecutionIntentStatus.SUBMITTED,
            submittedAt: new Date(),
            // The model against what the OMS actually did. A MARKET order that
            // filled somewhere other than the modelled price means the two have
            // drifted, and a journal is the right place to notice.
            fillModel: {
              ...sizedFill,
              reconciliation: reconcileFill(sizedFill, order.avgFillPrice ? Number(order.avgFillPrice) : null),
            } as unknown as Prisma.InputJsonValue,
            ...(omsRejected
              ? {
                  rejectReason: `OMS rejected the order: ${order.rejectReason ?? 'no reason given'}`,
                  rejectCheckId: OMS_REJECTED,
                }
              : {}),
          },
        });
        if (filled && order.avgFillPrice) {
          const entryPrice = Number(order.avgFillPrice);
          await tx.executionOutcome.create({
            data: {
              intentId: created.intent.id,
              entryPrice,
              quantity: order.filledQuantity,
              // Opened, not closed. `realizedPnl` stays 0 and `result` stays
              // OPEN until `reconcile` sees the position flatten — writing a
              // win/loss here would be a guess about a trade that has not
              // finished.
              realizedPnl: 0,
              charges: order.charges ?? 0,
              result: 'OPEN',
              exitReason: 'PENDING',
              entryAt: new Date(),
            },
          });

          // ---- THE MANAGED POSITION -------------------------------------
          //
          // Created in the SAME transaction as the fill. A position row that
          // could exist without its stop, or a fill that could exist without a
          // position row, is a position nothing manages — and the window in
          // which that is true is exactly the window right after entry.
          //
          // The levels are re-derived from the ACTUAL fill price, not the
          // planned one: the plan was made against the modelled ask, and the
          // OMS is the authority on what was paid. A stop measured from a
          // price the account did not pay is the wrong distance from the money
          // actually at risk.
          const filledPlan = planRisk({
            walletEquity: facts.walletEquity,
            entryPrice,
            lotSize: instrument.lotSize,
            maxLots: profile.lots,
            capitalAllocationPct: Number(profile.capitalAllocationPct),
            riskPerTradePct: Number(profile.riskPerTradePct),
            rewardPerTradePct: Number(profile.rewardPerTradePct),
          });
          // Fall back to the pre-fill plan's DISTANCES if the re-plan refuses
          // (a fill far worse than the quote could put one lot outside the
          // ceiling). A position must never exist without a stop, so the
          // distances are reapplied around the real entry rather than dropped.
          const stopDistance = filledPlan.ok ? filledPlan.stopDistance : plan.stopDistance;
          const targetDistance = filledPlan.ok ? filledPlan.targetDistance : plan.targetDistance;

          await tx.executionPosition.create({
            data: {
              intentId: created.intent.id,
              profileId: profile.id,
              userId: profile.accountUserId,
              instrumentId: instrument.id,
              contractSymbol: symbol,
              productType: profile.productType,
              symbol: profile.symbol,
              optionType: selected.optionType,
              state: 'OPEN',
              quantity: order.filledQuantity,
              entryPrice,
              entryAt: new Date(),
              stopPrice: Math.max(0.05, round2(entryPrice - stopDistance)),
              targetPrice: round2(entryPrice + targetDistance),
              highWaterPrice: entryPrice,
              lastPrice: entryPrice,
              lastPriceAt: new Date(),
              unrealizedPnl: 0,
            },
          });
        }
      });

      this.logger.log(
        `${profile.name}: ${order.status} ${side} ${quantity} ${symbol} @ ${order.avgFillPrice ?? 'resting'} ` +
          `(intent ${created.intent.id}; stop ${plan.stopPrice}, target ${plan.targetPrice}, risk ${plan.riskAtStop})`,
      );

      return record({
        ...base,
        outcome: omsRejected ? 'failed' : 'executed',
        verdict: evaluation.verdict,
        intentId: created.intent.id,
        orderId: order.id,
        reason: omsRejected
          ? `OMS rejected the order: ${order.rejectReason ?? 'no reason given'}`
          : `${order.status} — ${side} ${quantity} ${symbol}; stop ${plan.stopPrice}, target ${plan.targetPrice}.`,
        checks: policy.checks,
      });
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`${profile.name}: submission failed for ${symbol} — ${message}`);
      await this.prisma.executionIntent.update({
        where: { id: created.intent.id },
        data: {
          status: ExecutionIntentStatus.FAILED,
          rejectReason: `Submission raised: ${message}`,
          // Policy passed and the OMS still refused — the discipline limits
          // inside placeOrder are the usual reason, and an operator counting
          // today's refusals must see them alongside the policy ones.
          rejectCheckId: SUBMISSION_RAISED,
        },
      });
      return record({
        ...base,
        outcome: 'failed',
        verdict: evaluation.verdict,
        intentId: created.intent.id,
        reason: `Submission raised: ${message}`,
        checks: policy.checks,
      });
    }
  }


  /** Every enabled profile, one pass each. One profile's failure never stops the rest. */
  async runAllEnabled(now: Date = new Date()): Promise<ExecutionRunResult[]> {
    const profiles = await this.prisma.executionProfile.findMany({
      where: { enabled: true, environment: 'PAPER' },
      select: { id: true, name: true },
    });
    const results: ExecutionRunResult[] = [];
    for (const profile of profiles) {
      try {
        results.push(await this.runProfile(profile.id, now));
      } catch (err) {
        this.logger.error(`profile ${profile.name} raised during its pass`, err as Error);
        results.push({
          outcome: 'failed',
          profileId: profile.id,
          profileName: profile.name,
          reason: (err as Error).message,
          intentId: null,
          orderId: null,
          verdict: null,
          checks: [],
        });
      }
    }
    return results;
  }

  /**
   * The live facts risk policy is decided against.
   *
   * Every one is read from the EXISTING trading tables — this loop keeps no
   * shadow ledger of its own positions or P&L, because a second copy of the
   * number is a second thing that can be wrong.
   */
  private async gatherFacts(userId: string, profileId: string, now: Date) {
    const dayStart = istMidnightFor(now);
    const [profileOpenPositions, ordersToday, realized, wallet] = await Promise.all([
      // ---- POSITIONS THIS PROFILE OPENED, not every position on the account.
      //
      // This distinction did not matter while every profile traded a dedicated
      // machine account, because the only positions there were the profile's
      // own. It matters enormously on a USER_PAPER account, and binding one
      // exposed it immediately: a real trader holding a single position of
      // their own consumed the agent's entire `maxOpenPositions: 1` budget, and
      // the agent was refused with "1 open against a 1 limit" — a deadlock that
      // would persist for as long as the human held anything at all.
      //
      // `maxOpenPositions` is documented as what THIS PROFILE may hold, and
      // that is the only reading that is both useful and predictable: it is the
      // agent's own concurrency, the one quantity the agent controls. A human's
      // unrelated trading must not silently disarm their agent.
      //
      // Counted by walking this profile's FILLED intents and asking the
      // position table whether each is still open. Shared with the console's
      // profile list (`execution-open-positions.ts`) rather than reimplemented
      // there — the two DID disagree, and a limit that disagrees with its own
      // display is worse than either being wrong alone.
      countProfileOpenPositions(this.prisma, profileId, userId),
      // Counted per PROFILE, not per account, so two profiles sharing an
      // account (possible, though not the seeded shape) get independent limits.
      this.prisma.executionIntent.count({
        where: { profileId, decidedAt: { gte: dayStart }, status: { in: ['SUBMITTED', 'FILLED', 'CLOSED'] } },
      }),
      // ---- ACCOUNT-WIDE, and deliberately so, unlike the two above.
      //
      // The position limit governs the agent's concurrency; this governs the
      // account's CAPITAL, and the capital is shared with whatever the account
      // holder is doing themselves. An agent that keeps adding risk to an
      // account already down its daily limit is the exact behaviour this bound
      // exists to prevent — so here, a human's losses correctly stop the agent.
      this.prisma.trade.aggregate({
        where: { userId, executedAt: { gte: dayStart } },
        _sum: { realizedPnl: true },
      }),
      // `marginUsed` as well as cash: the risk model sizes against the
      // account's whole EQUITY, and cash alone shrinks every time a position
      // is open — which would make an agent's allocation depend on what the
      // account holder happens to be holding.
      this.prisma.paperWallet.findUnique({ where: { userId }, select: { cashBalance: true, marginUsed: true } }),
    ]);
    const positions = profileOpenPositions;

    return {
      openPositions: positions,
      ordersToday,
      realizedPnlToday: Number(realized._sum.realizedPnl ?? 0),
      // A wallet that does not exist yet is not zero capital — `ensureWallet`
      // creates it with the full starting balance on the first order. Reporting
      // 0 here would fail the affordability check on the very first trade.
      availableCash: wallet ? Number(wallet.cashBalance) : 1_000_000,
      // Cash plus blocked margin — the base every percentage in the risk model
      // is taken of. Same fallback, same reason.
      walletEquity: wallet ? Number(wallet.cashBalance) + Number(wallet.marginUsed) : 1_000_000,
    };
  }

  /**
   * Live state for every profile, for the console's "watch it cook" surface.
   *
   * Read-only. It reports what the LAST pass decided and every gate that
   * produced that decision, including the passes that correctly did nothing.
   */
  agentState(profileId: string): { at: string; outcome: string; verdict: string | null; reason: string; checks: PolicyCheck[] } | null {
    const held = this.lastDecision.get(profileId);
    if (!held) return null;
    return {
      at: held.at.toISOString(),
      outcome: held.result.outcome,
      verdict: held.result.verdict,
      reason: held.result.reason,
      checks: held.result.checks,
    };
  }

  /**
   * Insert the intent and its three candidates atomically, treating a unique
   * violation on `idempotencyKey` as success-by-someone-else.
   *
   * The `P2002` catch is the whole mechanism. Checking for an existing row and
   * then inserting would leave a window between the two statements in which a
   * second replica does the same — and the window is exactly where a duplicate
   * position comes from. Here the database decides, atomically, and the loser
   * reads back the winner's row.
   */
  private async createIntent(args: {
    profile: Prisma.ExecutionProfileGetPayload<{ include: { account: { select: { id: true; email: true } } } }>;
    evaluation: ExecutionEvaluationDto;
    selected: NonNullable<ExecutionEvaluationDto['strikes']['selected']>;
    expiry: Date;
    side: 'BUY';
    contract: string;
    quantity: number;
    idempotencyKey: string;
    now: Date;
    policy: PolicyDecision;
    plan: RiskPlan;
    fillModel: PaperFillModel;
    calibration: { key: string; version: number; adjustment: number; trades: number };
  }): Promise<{ intent: { id: string; orderId?: string | null }; duplicate: boolean }> {
    const { profile, evaluation, selected, expiry, side, contract, quantity, idempotencyKey, now, policy, plan, fillModel, calibration } = args;

    try {
      const intent = await this.prisma.executionIntent.create({
        data: {
          profileId: profile.id,
          idempotencyKey,
          status: policy.allowed ? ExecutionIntentStatus.PROPOSED : ExecutionIntentStatus.REJECTED,
          environment: 'PAPER',
          sentinelRunId: evaluation.runId,
          agent: profile.agent,
          strategyId: evaluation.strategyId ?? profile.strategyId,
          strategyName: evaluation.strategyName ?? profile.strategyName,
          symbol: profile.symbol,
          underlyingSpot: evaluation.spot ?? undefined,
          side,
          optionType: selected.optionType,
          bias: evaluation.sideInFocus?.bias ?? (selected.optionType === 'CE' ? 'bullish' : 'bearish'),
          strike: selected.strike,
          expiry,
          contractSymbol: contract,
          lots: profile.lots,
          quantity,
          productType: profile.productType,
          orderType: profile.orderType,
          confidence: Math.round(evaluation.confidence),
          rationale: evaluation.sideInFocus?.rationale ?? [],
          publication: (evaluation.publication ?? undefined) as Prisma.InputJsonValue | undefined,
          optionContext: (evaluation.sideInFocus?.optionContext ?? undefined) as Prisma.InputJsonValue | undefined,
          marketSnapshot: {
            ...evaluation.marketSnapshot,
            // The policy record belongs with the decision it governed, not in a
            // log line that ages out.
            policyChecks: policy.checks,
            atmStrike: evaluation.strikes.atmStrike,
            strikeStep: evaluation.strikes.strikeStep,
            effectiveConfidenceFloor: policy.effectiveConfidenceFloor,
          } as unknown as Prisma.InputJsonValue,

          // ---- What the agent knew --------------------------------------
          strategyVersion: evaluation.agentStrategy?.version ?? null,
          regime: evaluation.agentStrategy?.regime ?? null,
          indexDirection: evaluation.indexDirection?.direction ?? null,
          indexStrength: evaluation.indexDirection?.strength ?? null,
          indexEvidence: (evaluation.indexDirection ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
          dataQuality: (evaluation.dataQuality ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
          evidence: (evaluation.evidence ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
          confirmations: (evaluation.confirmations ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
          // Written in the SAME insert as the decision, because it cannot be
          // recovered afterwards: `previous_oi` is the previous session's
          // close and is overwritten every morning, so a decision's change in
          // open interest is either recorded now or gone by the time the daily
          // calibration loop asks for it.
          positioning: (evaluation.positioning ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
          positioningJudgement: (evaluation.positioningJudgement ?? undefined) as unknown as
            | Prisma.InputJsonValue
            | undefined,

          // ---- The plan, written BEFORE any order exists -----------------
          walletEquity: plan.walletEquity,
          allocatedCapital: plan.allocatedCapital,
          riskBudget: plan.riskAtStop,
          rewardTarget: plan.rewardAtTarget,
          plannedEntryPrice: plan.entryPrice,
          stopPrice: plan.ok ? plan.stopPrice : null,
          targetPrice: plan.ok ? plan.targetPrice : null,
          riskPlan: plan as unknown as Prisma.InputJsonValue,
          fillModel: fillModel as unknown as Prisma.InputJsonValue,

          // ---- What it had learned, by version ---------------------------
          // The version READ here, joined against the version a journal entry
          // PRODUCED, is what makes "trade #1 taught trade #2" a checkable
          // fact rather than a claim about a log line.
          calibrationVersion: calibration.version,
          calibrationAdjustment: calibration.adjustment,
          rejectReason: policy.allowed ? null : policy.reason,
          // The same refusal, grouped-able. See ExecutionIntent.rejectCheckId.
          rejectCheckId: policy.allowed ? null : policy.failedCheckId,
          decidedAt: now,
          candidates: {
            create: evaluation.strikes.candidates.map((c) => ({
              role: c.role,
              strike: c.strike,
              optionType: c.optionType,
              premium: c.premium ?? undefined,
              openInterest: c.openInterest != null ? BigInt(Math.round(c.openInterest)) : undefined,
              volume: c.volume != null ? BigInt(Math.round(c.volume)) : undefined,
              impliedVol: c.impliedVol ?? undefined,
              moneyness: c.moneyness ?? undefined,
              selected: c.selected,
              tradable: c.tradable,
              reason: c.reason,
              checks: c.checks as unknown as Prisma.InputJsonValue,
            })),
          },
        },
        select: { id: true },
      });
      return { intent, duplicate: false };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.executionIntent.findUnique({
          where: { idempotencyKey },
          select: { id: true, status: true, order: { select: { id: true } } },
        });
        if (existing) {
          // ---- A REJECTED decision does not own the window --------------
          //
          // Idempotency exists to stop one decision becoming two POSITIONS. An
          // intent that was refused by policy produced no order and no
          // position, and its refusal was conditional on state that moves —
          // "1 open against a 1 limit" stops being true the moment that
          // position closes. Treating it as a permanent duplicate let a single
          // transient rejection block that contract for the rest of the
          // 15-minute window, which is a real trading opportunity lost to
          // bookkeeping.
          //
          // So a REJECTED/FAILED intent with NO order is RE-CLAIMED rather than
          // reported as a duplicate. The claim is a conditional update, not a
          // read-then-write: `updateMany` with the status in the WHERE clause
          // is atomic, so if two replicas race, exactly one sees `count === 1`
          // and proceeds. The loser falls through to the duplicate path.
          //
          // An intent that HAS an order — or is PROPOSED/SUBMITTED/FILLED/
          // CLOSED — is a genuine duplicate and is never re-claimed. That is
          // the case idempotency is actually about.
          const retryable = !existing.order && (existing.status === 'REJECTED' || existing.status === 'FAILED');
          if (retryable) {
            const claimed = await this.prisma.executionIntent.updateMany({
              // `status` alone is a sufficient guard, and is a scalar so the
              // update stays a single atomic statement: an intent that owns an
              // order is SUBMITTED/FILLED/CLOSED by construction and can never
              // match REJECTED/FAILED here.
              where: { id: existing.id, status: existing.status },
              data: {
                status: policy.allowed ? ExecutionIntentStatus.PROPOSED : ExecutionIntentStatus.REJECTED,
                rejectReason: policy.allowed ? null : policy.reason,
                rejectCheckId: policy.allowed ? null : policy.failedCheckId,
                decidedAt: now,
                confidence: Math.round(evaluation.confidence),
                sentinelRunId: evaluation.runId,
                underlyingSpot: evaluation.spot ?? undefined,
                // The PLAN is re-claimed too. A stale stop from the pass that
                // was refused fifteen minutes ago would be a stop measured
                // against a premium the market has left behind — and this is
                // the row a position is created from.
                walletEquity: plan.walletEquity,
                allocatedCapital: plan.allocatedCapital,
                riskBudget: plan.riskAtStop,
                rewardTarget: plan.rewardAtTarget,
                plannedEntryPrice: plan.entryPrice,
                stopPrice: plan.ok ? plan.stopPrice : null,
                targetPrice: plan.ok ? plan.targetPrice : null,
                riskPlan: plan as unknown as Prisma.InputJsonValue,
                fillModel: fillModel as unknown as Prisma.InputJsonValue,
                calibrationVersion: calibration.version,
                calibrationAdjustment: calibration.adjustment,
                indexDirection: evaluation.indexDirection?.direction ?? null,
                indexStrength: evaluation.indexDirection?.strength ?? null,
                dataQuality: (evaluation.dataQuality ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
                evidence: (evaluation.evidence ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
                confirmations: (evaluation.confirmations ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
                positioning: (evaluation.positioning ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
                positioningJudgement: (evaluation.positioningJudgement ?? undefined) as unknown as
                  | Prisma.InputJsonValue
                  | undefined,
              },
            });
            if (claimed.count === 1) {
              this.logger.log(`${profile.name}: re-claimed previously ${existing.status.toLowerCase()} intent ${existing.id}.`);
              // The candidates belong to the decision, and the decision is the
              // same one — refresh them so the recorded chain matches the chain
              // this pass actually read.
              await this.prisma.executionStrikeCandidate.deleteMany({ where: { intentId: existing.id } });
              await this.prisma.executionStrikeCandidate.createMany({
                data: evaluation.strikes.candidates.map((c) => ({
                  intentId: existing.id,
                  role: c.role,
                  strike: c.strike,
                  optionType: c.optionType,
                  premium: c.premium ?? undefined,
                  openInterest: c.openInterest != null ? BigInt(Math.round(c.openInterest)) : undefined,
                  volume: c.volume != null ? BigInt(Math.round(c.volume)) : undefined,
                  impliedVol: c.impliedVol ?? undefined,
                  moneyness: c.moneyness ?? undefined,
                  selected: c.selected,
                  tradable: c.tradable,
                  reason: c.reason,
                  checks: c.checks as unknown as Prisma.InputJsonValue,
                })),
              });
              return { intent: { id: existing.id }, duplicate: false };
            }
          }
          this.logger.log(`${profile.name}: decision already recorded as intent ${existing.id}; no duplicate created.`);
          return { intent: { id: existing.id, orderId: existing.order?.id ?? null }, duplicate: true };
        }
      }
      throw err;
    }
  }
}

/** Midnight IST for the day containing `now`, as a UTC instant. */
function istMidnightFor(now: Date): Date {
  const { dayKey } = istParts(now);
  return new Date(`${dayKey}T00:00:00+05:30`);
}

/**
 * The fill-model inputs for a known quantity.
 *
 * Extracted because the model is built twice per pass — once with one lot to
 * get a price for the risk planner, and again with the quantity the planner
 * produced. Two inline copies of this argument list is how the two calls end
 * up disagreeing about which price field feeds which.
 */
function fillModelInput(
  price: LivePrice,
  side: 'BUY',
  quantity: number,
  quoteAgeMs: number | null,
  orderType: string,
) {
  return {
    side,
    ltp: price.ltp,
    bid: price.bid,
    ask: price.ask,
    quantity,
    quoteAgeMs,
    marketOpen: price.marketOpen,
    orderType,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
