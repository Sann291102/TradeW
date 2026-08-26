import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ExecutionIntentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isTradingDay } from '../discipline/market-calendar';
import { MarketPriceService } from '../sim/market-price.service';
import { OrderService } from '../sim/order.service';
import { ExecutionAccountService } from './execution-account.service';
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
import { SentinelExecutionClient, type ExecutionEvaluationDto } from './sentinel-execution.client';
import { SystemExecutionControlService, type SystemControlGate } from './system-execution-control.service';

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
  | 'skipped-halted'
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
    private readonly systemControl: SystemExecutionControlService,
  ) {}

  /**
   * Run one profile once.
   *
   * `now` is injectable so the session-window and decision-bucket behaviour can
   * be asserted deterministically — a loop whose correctness depends on the
   * clock must not be testable only during market hours.
   */
  async runProfile(
    profileId: string,
    now: Date = new Date(),
    // The batch caller reads the global kill switch ONCE per tick and threads it
    // down, so N profiles do not each re-read the same singleton. A direct
    // caller (the console's "run once" route) passes nothing and this reads it
    // itself — a manual fire must honour the halt exactly as a scheduled one does.
    opts: { control?: SystemControlGate } = {},
  ): Promise<ExecutionRunResult> {
    const profile = await this.prisma.executionProfile.findUnique({
      where: { id: profileId },
      include: { account: { select: { id: true, email: true } } },
    });
    if (!profile) throw new NotFoundException(`No execution profile ${profileId}`);

    const base = { profileId: profile.id, profileName: profile.name, intentId: null, orderId: null, checks: [] };

    if (!profile.enabled) {
      return { ...base, outcome: 'skipped-disabled', verdict: null, reason: 'Profile is disabled.' };
    }
    // Belt and braces against a row that did not come from this application —
    // see the same check in `evaluatePolicy`.
    if (profile.environment !== 'PAPER') {
      return {
        ...base,
        outcome: 'rejected',
        verdict: null,
        reason: `Refused: profile environment is "${profile.environment}", not PAPER.`,
      };
    }

    // ---- 1a. THE GLOBAL KILL SWITCH ---------------------------------------
    //
    // Checked before the account read and before Sentinel, because "the whole
    // system is halted" is the most fundamental answer there is — more so than
    // "the market is shut" or "you may not trade this account". A halted loop
    // spends nothing: no account read, no Sentinel evaluation, no market data.
    //
    // Read once by the batch caller and threaded in; a direct call reads it here.
    // Either way it is read FRESH, never cached — a kill switch with a TTL is a
    // kill switch with a delay.
    const control = opts.control ?? (await this.systemControl.gate());
    if (!control.allowNewEntries) {
      return {
        ...base,
        outcome: 'skipped-halted',
        verdict: null,
        reason:
          control.mode === 'EMERGENCY_STOP'
            ? 'System paper execution is under EMERGENCY_STOP — no new entries; open positions are being squared off.'
            : 'System paper execution is OFF — no new entries are being opened.',
      };
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
      return {
        ...base,
        outcome: 'rejected',
        verdict: null,
        reason: accountAuth.reason ?? 'Account authorization failed.',
        checks: accountAuth.checks,
      };
    }

    const { minuteOfDay } = istParts(now);
    const sessionOpen =
      isTradingDay(now) && minuteOfDay >= SESSION_OPEN_MINUTE && minuteOfDay < SESSION_CLOSE_MINUTE;
    if (!sessionOpen) {
      return {
        ...base,
        outcome: 'skipped-market-closed',
        verdict: null,
        reason: isTradingDay(now)
          ? 'Outside the 09:15–15:30 IST session.'
          : 'Not an NSE trading day.',
      };
    }

    // ---- 2. Ask the one canonical Sentinel ---------------------------------
    const evaluation = await this.sentinel.evaluate({
      symbol: profile.symbol,
      userId: profile.accountUserId,
      strategyId: profile.strategyId,
      minConfidence: profile.minConfidence,
    });

    if (!evaluation.executable || !evaluation.strikes.selected || !evaluation.expiry) {
      // Nothing is written. Sentinel declining to publish is the designed
      // resting state, and a row per quiet minute would make the intent table
      // useless as a record of decisions.
      return {
        ...base,
        outcome: 'skipped-no-signal',
        verdict: evaluation.verdict,
        reason: evaluation.reason,
      };
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
      return {
        ...base,
        outcome: 'failed',
        verdict: evaluation.verdict,
        reason: `Selected contract ${symbol} could not be resolved or priced: ${message}`,
      };
    }

    const quantity = profile.lots * instrument.lotSize;
    // A long option costs its premium in full — the ask is what a BUY pays.
    const estimatedCost = price.ask * quantity;

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

    const facts = await this.gatherFacts(profile.accountUserId, profile.id, now);
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
    });

    if (created.duplicate) {
      return {
        ...base,
        outcome: 'duplicate',
        verdict: evaluation.verdict,
        intentId: created.intent.id,
        orderId: created.intent.orderId ?? null,
        reason: 'This decision was already recorded; no second order was created.',
        checks: policy.checks,
      };
    }

    if (!policy.allowed) {
      return {
        ...base,
        outcome: 'rejected',
        verdict: evaluation.verdict,
        intentId: created.intent.id,
        reason: policy.reason ?? 'Rejected by execution policy.',
        checks: policy.checks,
      };
    }

    // ---- 6. Submit through the EXISTING order service ----------------------
    try {
      const order = await this.orders.placeOrder(profile.accountUserId, {
        symbol,
        side,
        type: profile.orderType,
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
            ...(omsRejected
              ? {
                  rejectReason: `OMS rejected the order: ${order.rejectReason ?? 'no reason given'}`,
                  rejectCheckId: OMS_REJECTED,
                }
              : {}),
          },
        });
        if (filled && order.avgFillPrice) {
          await tx.executionOutcome.create({
            data: {
              intentId: created.intent.id,
              entryPrice: order.avgFillPrice,
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
        }
      });

      this.logger.log(
        `${profile.name}: ${order.status} ${side} ${quantity} ${symbol} @ ${order.avgFillPrice ?? 'resting'} (intent ${created.intent.id})`,
      );

      return {
        ...base,
        outcome: omsRejected ? 'failed' : 'executed',
        verdict: evaluation.verdict,
        intentId: created.intent.id,
        orderId: order.id,
        reason: omsRejected
          ? `OMS rejected the order: ${order.rejectReason ?? 'no reason given'}`
          : `${order.status} — ${side} ${quantity} ${symbol}.`,
        checks: policy.checks,
      };
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
      return {
        ...base,
        outcome: 'failed',
        verdict: evaluation.verdict,
        intentId: created.intent.id,
        reason: `Submission raised: ${message}`,
        checks: policy.checks,
      };
    }
  }

  /** Every enabled profile, one pass each. One profile's failure never stops the rest. */
  async runAllEnabled(now: Date = new Date()): Promise<ExecutionRunResult[]> {
    // Read the kill switch ONCE for the whole batch. When it forbids new entries
    // the pass is still walked so every profile reports `skipped-halted` (the
    // console must see WHY nothing traded), but not one account read or Sentinel
    // evaluation is spent — `runProfile` short-circuits on the threaded gate.
    const control = await this.systemControl.gate();
    const profiles = await this.prisma.executionProfile.findMany({
      where: { enabled: true, environment: 'PAPER' },
      select: { id: true, name: true },
    });
    const results: ExecutionRunResult[] = [];
    for (const profile of profiles) {
      try {
        results.push(await this.runProfile(profile.id, now, { control }));
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
      this.prisma.paperWallet.findUnique({ where: { userId }, select: { cashBalance: true } }),
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
  }): Promise<{ intent: { id: string; orderId?: string | null }; duplicate: boolean }> {
    const { profile, evaluation, selected, expiry, side, contract, quantity, idempotencyKey, now, policy } = args;

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
          } as unknown as Prisma.InputJsonValue,
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
