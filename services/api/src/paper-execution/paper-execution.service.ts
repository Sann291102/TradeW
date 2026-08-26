import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ExecutionEnvironment, ExecutionIntentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isTradingDay } from '../discipline/market-calendar';
import { MarketPriceService } from '../sim/market-price.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { ExecutionAccountService } from './execution-account.service';
import { ExecutionAdapterResolver } from './execution-adapter.resolver';
import { LiveExecutionNotAuthorizedError, type AdapterResult } from './execution-adapter';
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
import {
  AUTOTRADE_DISABLED,
  LIVE_NOT_AUTHORIZED,
  PROFILE_NOT_ARMED,
  type ExecutionProfileState,
  isExecutingState,
  stateRefusal,
} from './execution-state';
import { ExecutionStateService } from './execution-state.service';
import { SentinelExecutionClient, type ExecutionEvaluationDto } from './sentinel-execution.client';

/**
 * The Sentinel execution loop.
 *
 * ## What this service is, in one line
 *
 * It turns a Sentinel observation that already cleared Sentinel's own gates
 * into an order placed through whichever ENGINE the profile's state authorizes,
 * and records why.
 *
 * ## What it deliberately is not
 *
 * It is not a matching engine — `MatchingEngineService` fills resting orders,
 * unchanged. It is not a P&L engine — `OrderService.executeFill` computes
 * realized P&L and `PositionService` marks positions to market, unchanged. It
 * is not a strategy engine, a market-data engine or a second Sentinel; every
 * judgement it acts on arrives from `POST /execution/evaluate`.
 *
 * It is also NOT the thing that decides paper-versus-live. It holds no adapter
 * and imports neither; it asks `ExecutionAdapterResolver` for one, and the
 * resolver decides from the profile's STATE. That is the §12 boundary — see
 * `execution-adapter.ts` for why it is a separate object rather than an `if`.
 *
 * The entire "execution" contribution of this file is: decide whether to act,
 * make the act idempotent, ask for an adapter, submit, and keep the provenance.
 *
 * ## Order of operations, and why it is that order
 *
 *   1. Cheap local preflight: the STATE MACHINE first (armed? paused? which
 *      engine?), then AutoTrade, then the trading day and session window.
 *      Before the network call, so a disarmed profile or a closed market costs
 *      nothing.
 *   2. Ask Sentinel. If it publishes no side, stop — no intent is written,
 *      because "Sentinel stayed silent" is the normal resting state and a row
 *      per quiet minute would bury the real decisions. A RUN row is still
 *      written; that is what `ExecutionRun` is for.
 *   3. Resolve the contract and read its live price. This is where the selected
 *      strike becomes a real, tradable `Instrument` at a real, current price.
 *   4. Claim the idempotency key by INSERTING the intent — before any order
 *      exists. A racing replica loses here, on a database constraint, not on a
 *      check-then-act window.
 *   5. Apply risk policy, recording the result on the intent either way.
 *   6. RE-READ THE AUTHORIZATION. Everything above took seconds; an
 *      administrator may have disarmed the profile during them, and §15
 *      requires that to stop THIS pass.
 *   7. Resolve the adapter for the state we just re-read, and submit.
 *
 * Step 4 preceding step 7 is the load-bearing part for idempotency: the intent
 * is the thing that is unique, so two concurrent decisions cannot both reach an
 * adapter. Step 6 preceding step 7 is the load-bearing part for control.
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
  /** The broker's own order handle. Null for every paper pass, always. */
  brokerOrderId: string | null;
  /** The engine this pass would have used, per the profile's state. */
  environment: 'PAPER' | 'LIVE' | null;
  state: ExecutionProfileState;
  /** Sentinel's verdict, when it was consulted. */
  verdict: ExecutionEvaluationDto['verdict'] | null;
  checks: PolicyCheck[];
  /** The groupable form of the refusal, matching ExecutionIntent.rejectCheckId. */
  rejectCheckId: string | null;
  latencyMs: number;
}

/** IST minute-of-day the Indian equity session closes (15:30). */
const SESSION_CLOSE_MINUTE = 15 * 60 + 30;

@Injectable()
export class PaperExecutionService {
  private readonly logger = new Logger(PaperExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sentinel: SentinelExecutionClient,
    private readonly marketPrice: MarketPriceService,
    private readonly accounts: ExecutionAccountService,
    private readonly adapters: ExecutionAdapterResolver,
    private readonly state: ExecutionStateService,
    private readonly telemetry: TelemetryService,
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
    trigger: 'scheduler' | 'manual' = 'scheduler',
  ): Promise<ExecutionRunResult> {
    const startedAt = Date.now();
    const profile = await this.prisma.executionProfile.findUnique({
      where: { id: profileId },
      include: { account: { select: { id: true, email: true } } },
    });
    if (!profile) throw new NotFoundException(`No execution profile ${profileId}`);

    const profileState = profile.state as ExecutionProfileState;
    const engine = this.adapters.engineFor(profileState);

    const base = {
      profileId: profile.id,
      profileName: profile.name,
      intentId: null,
      orderId: null,
      brokerOrderId: null,
      environment: engine,
      state: profileState,
      checks: [] as PolicyCheck[],
      rejectCheckId: null,
    };

    // Every return below goes through here, so a pass can never finish without
    // leaving a record of itself — the gap that made "is the loop doing
    // anything?" unanswerable before `ExecutionRun` existed.
    const finish = async (result: Omit<ExecutionRunResult, 'latencyMs'>): Promise<ExecutionRunResult> => {
      const full: ExecutionRunResult = { ...result, latencyMs: Date.now() - startedAt };
      await this.recordRun(profile, full, trigger, startedAt).catch((err) =>
        // Telemetry must never be the reason a trade did not happen, nor the
        // reason a caller sees an error for a pass that succeeded.
        this.logger.error(`could not record the execution run for ${profile.name}`, err as Error),
      );
      return full;
    };

    // ---- 1. THE STATE MACHINE ---------------------------------------------
    //
    // First, and from the row just read — not from a value the scheduler
    // cached when it selected this profile. §2: "Never rely only on a frontend
    // button being visible or hidden", and the server-side corollary is never
    // to rely on a selection made a tick ago.
    if (!isExecutingState(profileState)) {
      return finish({
        ...base,
        outcome: 'skipped-disabled',
        verdict: null,
        reason: stateRefusal(profileState),
        rejectCheckId: PROFILE_NOT_ARMED,
      });
    }

    // ---- 1a. The account holder's own switch -------------------------------
    //
    // A SYSTEM_PAPER account has no holder, so arming is the activation for it.
    // A USER_PAPER profile needs the person whose money it is to have said yes,
    // and to still be saying yes — read every pass, never cached.
    if (profile.accountScope === 'USER_PAPER' && !profile.autoTradeEnabled) {
      return finish({
        ...base,
        outcome: 'skipped-disabled',
        verdict: null,
        reason:
          'AutoTrade is switched off by the account holder. The profile is armed, but no order will be produced ' +
          'until they enable it.',
        rejectCheckId: AUTOTRADE_DISABLED,
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
      // From the state, not the row — see `authorizeAccount`.
      authorizedEnvironment: engine ?? 'PAPER',
      accountScope: profile.accountScope,
      accountUserId: profile.accountUserId,
      symbol: profile.symbol,
      agent: profile.agent,
    });
    if (!accountAuth.authorized) {
      return finish({
        ...base,
        outcome: 'rejected',
        verdict: null,
        reason: accountAuth.reason ?? 'Account authorization failed.',
        checks: accountAuth.checks,
        rejectCheckId: accountAuth.checks.find((c) => !c.passed)?.id ?? 'account-authorization',
      });
    }

    const { minuteOfDay } = istParts(now);
    const sessionOpen =
      isTradingDay(now) && minuteOfDay >= SESSION_OPEN_MINUTE && minuteOfDay < SESSION_CLOSE_MINUTE;
    if (!sessionOpen) {
      return finish({
        ...base,
        outcome: 'skipped-market-closed',
        verdict: null,
        reason: isTradingDay(now)
          ? 'Outside the 09:15–15:30 IST session.'
          : 'Not an NSE trading day.',
        rejectCheckId: 'market-open',
      });
    }

    // ---- 2. Ask the one canonical Sentinel ---------------------------------
    let evaluation: ExecutionEvaluationDto;
    try {
      evaluation = await this.sentinel.evaluate({
        symbol: profile.symbol,
        userId: profile.accountUserId,
        strategyId: profile.strategyId,
        minConfidence: profile.minConfidence,
      });
    } catch (err) {
      // Sentinel being unreachable is a FAULT, not a quiet market, and the two
      // must never read the same in the console. It is recorded as a failure
      // against the profile without moving it to ERROR: an upstream outage is
      // transient and does not deserve an operator-cleared halt.
      const message = (err as Error).message;
      this.logger.warn(`${profile.name}: Sentinel evaluation failed — ${message}`);
      await this.noteError(profile.id, `Sentinel evaluation failed: ${message}`);
      return finish({
        ...base,
        outcome: 'failed',
        verdict: null,
        reason: `Sentinel evaluation failed: ${message}`,
        rejectCheckId: 'market-unavailable',
      });
    }

    if (!evaluation.executable || !evaluation.strikes.selected || !evaluation.expiry) {
      // No intent is written. Sentinel declining to publish is the designed
      // resting state, and a row per quiet minute would make the intent table
      // useless as a record of decisions. The RUN row above still records it,
      // which is the distinction §8 asks for: "Do not report 'no decision' when
      // there was actually a decision that failed downstream."
      return finish({
        ...base,
        outcome: 'skipped-no-signal',
        verdict: evaluation.verdict,
        reason: evaluation.reason,
        rejectCheckId: null,
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
      // — the same path a human order ticket takes for an option contract. The
      // price is the CURRENT one from the live bridge; §5 forbids a hardcoded
      // number and this is where that is honoured.
      instrument = await this.marketPrice.resolveInstrument(symbol);
      price = await this.marketPrice.getPrice(instrument);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`${profile.name}: could not price ${symbol} — ${message}`);
      return finish({
        ...base,
        outcome: 'failed',
        verdict: evaluation.verdict,
        reason: `Selected contract ${symbol} could not be resolved or priced: ${message}`,
        rejectCheckId: 'market-unavailable',
      });
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
      enabled: isExecutingState(profileState),
      environment: profile.environment,
      // From the STATE, never from the row — see the `environment-authorized`
      // check. `engine` is non-null here: a non-executing state returned at
      // step 1.
      authorizedEnvironment: engine ?? 'PAPER',
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
      environment: (engine ?? 'PAPER') as ExecutionEnvironment,
    });

    // A decision was reached, whatever happens to it downstream. Promote the
    // profile from armed to running, and stamp the decision clock.
    await this.markDecision(profile.id, now);

    if (created.duplicate) {
      return finish({
        ...base,
        outcome: 'duplicate',
        verdict: evaluation.verdict,
        intentId: created.intent.id,
        orderId: created.intent.orderId ?? null,
        reason: 'This decision was already recorded; no second order was created.',
        checks: policy.checks,
        rejectCheckId: null,
      });
    }

    if (!policy.allowed) {
      return finish({
        ...base,
        outcome: 'rejected',
        verdict: evaluation.verdict,
        intentId: created.intent.id,
        reason: policy.reason ?? 'Rejected by execution policy.',
        checks: policy.checks,
        rejectCheckId: policy.failedCheckId,
      });
    }

    // ---- 6. RE-READ THE AUTHORIZATION, immediately before submitting -------
    //
    // §15: "If a Sentinel worker is currently running, the execution layer must
    // re-check authorization immediately before creating an order. Do NOT
    // assume that checking authorization only at scheduler startup is
    // sufficient."
    //
    // Everything between step 1 and here involved a network call to Sentinel
    // and two to the market-data bridge — seconds, during which an operator may
    // have hit Disarm or Pause, or the account holder may have switched
    // AutoTrade off. Their decision must win over a pass that started before it.
    const live = await this.state.currentAuthorization(profile.id);
    if (!live.mayExecute) {
      await this.refuseIntent(created.intent.id, stateRefusal(live.state), PROFILE_NOT_ARMED);
      return finish({
        ...base,
        outcome: 'rejected',
        state: live.state,
        environment: live.environment,
        verdict: evaluation.verdict,
        intentId: created.intent.id,
        reason: `${stateRefusal(live.state)} (changed while this pass was in flight)`,
        checks: policy.checks,
        rejectCheckId: PROFILE_NOT_ARMED,
      });
    }
    if (live.accountScope === 'USER_PAPER' && !live.autoTradeEnabled) {
      const reason = 'AutoTrade was switched off by the account holder while this pass was in flight.';
      await this.refuseIntent(created.intent.id, reason, AUTOTRADE_DISABLED);
      return finish({
        ...base,
        outcome: 'rejected',
        state: live.state,
        environment: live.environment,
        verdict: evaluation.verdict,
        intentId: created.intent.id,
        reason,
        checks: policy.checks,
        rejectCheckId: AUTOTRADE_DISABLED,
      });
    }

    // ---- 7. Submit through the adapter the STATE authorizes ----------------
    let adapter;
    try {
      adapter = this.adapters.resolve(live.state, profile.name);
    } catch (err) {
      // The resolver refusing is a hard stop, and the most likely cause is a
      // live-armed profile on a deployment where live is switched off. Recorded
      // as a refusal with its own check id rather than as a crash.
      const message = (err as Error).message;
      await this.refuseIntent(created.intent.id, message, LIVE_NOT_AUTHORIZED);
      return finish({
        ...base,
        outcome: 'rejected',
        state: live.state,
        environment: live.environment,
        verdict: evaluation.verdict,
        intentId: created.intent.id,
        reason: message,
        checks: policy.checks,
        rejectCheckId: LIVE_NOT_AUTHORIZED,
      });
    }

    let result: AdapterResult;
    try {
      result = await adapter.submit({
        userId: profile.accountUserId,
        symbol,
        side,
        type: profile.orderType,
        quantity,
        productType: profile.productType,
        intentId: created.intent.id,
        profileId: profile.id,
      });
    } catch (err) {
      const message = (err as Error).message;
      const isAuthz = err instanceof LiveExecutionNotAuthorizedError;
      this.logger.error(`${profile.name}: submission failed for ${symbol} — ${message}`);
      await this.refuseIntent(
        created.intent.id,
        isAuthz ? message : `Submission raised: ${message}`,
        isAuthz ? LIVE_NOT_AUTHORIZED : SUBMISSION_RAISED,
      );
      await this.noteError(profile.id, message);
      return finish({
        ...base,
        outcome: 'failed',
        state: live.state,
        environment: live.environment,
        verdict: evaluation.verdict,
        intentId: created.intent.id,
        reason: isAuthz ? message : `Submission raised: ${message}`,
        checks: policy.checks,
        rejectCheckId: isAuthz ? LIVE_NOT_AUTHORIZED : SUBMISSION_RAISED,
      });
    }

    const venueRejected = result.status === 'REJECTED';
    const filled = result.status === 'FILLED';

    // The link is written in the same statement that advances the intent, so a
    // submitted intent always has its order and an order produced by this loop
    // always names its intent.
    await this.prisma.$transaction(async (tx) => {
      if (result.orderId) {
        await tx.order.update({ where: { id: result.orderId }, data: { executionIntentId: created.intent.id } });
      }
      await tx.executionIntent.update({
        where: { id: created.intent.id },
        data: {
          status: venueRejected
            ? ExecutionIntentStatus.FAILED
            : filled
              ? ExecutionIntentStatus.FILLED
              : ExecutionIntentStatus.SUBMITTED,
          submittedAt: new Date(),
          // Null on every paper pass — asserted, not assumed.
          brokerOrderId: result.brokerOrderId,
          brokerOrderStatus: result.brokerOrderId ? result.status : null,
          brokerSubmittedAt: result.brokerOrderId ? new Date() : null,
          ...(venueRejected
            ? {
                rejectReason: `${result.engine === 'LIVE' ? 'The broker' : 'The OMS'} rejected the order: ${result.rejectReason ?? 'no reason given'}`,
                rejectCheckId: OMS_REJECTED,
              }
            : {}),
        },
      });
      if (filled && result.avgFillPrice != null) {
        await tx.executionOutcome.create({
          data: {
            intentId: created.intent.id,
            entryPrice: result.avgFillPrice,
            quantity: result.filledQuantity,
            // Opened, not closed. `realizedPnl` stays 0 and `result` stays OPEN
            // until `reconcile` sees the position flatten — writing a win/loss
            // here would be a guess about a trade that has not finished.
            realizedPnl: 0,
            charges: result.charges ?? 0,
            result: 'OPEN',
            exitReason: 'PENDING',
            entryAt: new Date(),
          },
        });
      }
      await tx.executionProfile.update({
        where: { id: profile.id },
        data: {
          lastOrderAt: new Date(),
          ...(filled ? { lastFillAt: new Date() } : {}),
        },
      });
    });

    this.logger.log(
      `${profile.name}: ${result.engine} ${result.status} ${side} ${quantity} ${symbol} @ ${result.avgFillPrice ?? 'resting'} (intent ${created.intent.id})`,
    );

    return finish({
      ...base,
      outcome: venueRejected ? 'failed' : 'executed',
      state: live.state,
      environment: live.environment,
      verdict: evaluation.verdict,
      intentId: created.intent.id,
      orderId: result.orderId,
      brokerOrderId: result.brokerOrderId,
      reason: venueRejected
        ? `${result.engine === 'LIVE' ? 'The broker' : 'The OMS'} rejected the order: ${result.rejectReason ?? 'no reason given'}`
        : `${result.status} — ${side} ${quantity} ${symbol}.`,
      checks: policy.checks,
      rejectCheckId: venueRejected ? OMS_REJECTED : null,
    });
  }

  /**
   * Every profile the state machine currently authorizes, one pass each.
   *
   * Selected by STATE, not by `enabled`. The two are kept in sync by
   * `ExecutionStateService`, but the executor asks the authority rather than
   * its mirror — so a hand-edited `enabled=true` on a DISARMED row selects
   * nothing.
   *
   * One profile's failure never stops the rest (§19).
   */
  async runAllEnabled(now: Date = new Date()): Promise<ExecutionRunResult[]> {
    const profiles = await this.prisma.executionProfile.findMany({
      where: { state: { in: ['PAPER_ARMED', 'PAPER_RUNNING', 'PAPER_QUALIFIED', 'LIVE_ARMED', 'LIVE_RUNNING'] } },
      select: { id: true, name: true, state: true },
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
          brokerOrderId: null,
          environment: this.adapters.engineFor(profile.state as ExecutionProfileState),
          state: profile.state as ExecutionProfileState,
          verdict: null,
          checks: [],
          rejectCheckId: SUBMISSION_RAISED,
          latencyMs: 0,
        });
      }
    }
    return results;
  }

  // ------------------------------------------------------------------ private

  /**
   * The per-pass observability record (§24), plus the live telemetry event the
   * admin console's SSE stream renders.
   *
   * Written for EVERY pass including the quiet ones — that is the whole point.
   * Failures here are logged and swallowed by the caller: telemetry must never
   * be the reason an execution result is lost.
   */
  private async recordRun(
    profile: { id: string; accountUserId: string; symbol: string },
    result: ExecutionRunResult,
    trigger: 'scheduler' | 'manual',
    startedAtMs: number,
  ): Promise<void> {
    const startedAt = new Date(startedAtMs);
    await this.prisma.$transaction([
      this.prisma.executionRun.create({
        data: {
          profileId: profile.id,
          userId: profile.accountUserId,
          environment: (result.environment ?? 'PAPER') as ExecutionEnvironment,
          symbol: profile.symbol,
          trigger,
          outcome: result.outcome,
          reason: result.reason.slice(0, 1000),
          intentId: result.intentId,
          orderId: result.orderId,
          rejectCheckId: result.rejectCheckId,
          error: result.outcome === 'failed' ? result.reason.slice(0, 1000) : null,
          startedAt,
          finishedAt: new Date(),
          latencyMs: result.latencyMs,
        },
      }),
      this.prisma.executionProfile.update({
        where: { id: profile.id },
        data: { lastRunAt: new Date() },
      }),
    ]);

    // The console's live stream. Emitted through the EXISTING telemetry bus,
    // which `GET /admin/stream` already fans out over SSE — §16: "Do not
    // introduce unnecessary infrastructure if the repository already has a
    // realtime/event mechanism."
    //
    // `detail` is deliberately one short line. The bus feeds a browser, and the
    // rule on this channel is that nothing rendered from it may carry more than
    // a person can read at a glance; the full record is the ExecutionRun row
    // written immediately above.
    this.telemetry.agentActivity({
      runId: result.intentId ?? `run:${profile.id}:${startedAtMs}`,
      system: 'sentinel-execution',
      agent: result.profileName,
      state: result.outcome === 'executed' ? 'done' : result.outcome === 'failed' ? 'error' : 'idle',
      detail: `${result.environment ?? 'PAPER'} ${result.outcome}: ${result.reason}`.slice(0, 200),
      durationMs: result.latencyMs,
      at: Date.now(),
    });
  }

  /** A decision was reached: stamp the clock and promote armed → running. */
  private async markDecision(profileId: string, now: Date): Promise<void> {
    await this.prisma.executionProfile
      .update({ where: { id: profileId }, data: { lastDecisionAt: now } })
      .catch(() => undefined);
    // Silent: on every pass after the first, there is nothing to promote.
    await this.state.noteRunning(profileId).catch(() => undefined);
  }

  /** Record a fault on the profile WITHOUT halting it — see `markError` for the halt. */
  private async noteError(profileId: string, message: string): Promise<void> {
    await this.prisma.executionProfile
      .update({
        where: { id: profileId },
        data: { lastError: message.slice(0, 500), lastErrorAt: new Date() },
      })
      .catch(() => undefined);
  }

  /** Turn an already-created intent into a refusal, with a groupable reason. */
  private async refuseIntent(intentId: string, reason: string, checkId: string): Promise<void> {
    await this.prisma.executionIntent.update({
      where: { id: intentId },
      data: { status: ExecutionIntentStatus.REJECTED, rejectReason: reason, rejectCheckId: checkId },
    });
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

    return {
      openPositions: profileOpenPositions,
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
    environment: ExecutionEnvironment;
  }): Promise<{ intent: { id: string; orderId?: string | null }; duplicate: boolean }> {
    const { profile, evaluation, selected, expiry, side, contract, quantity, idempotencyKey, now, policy, environment } =
      args;

    try {
      const intent = await this.prisma.executionIntent.create({
        data: {
          profileId: profile.id,
          idempotencyKey,
          status: policy.allowed ? ExecutionIntentStatus.PROPOSED : ExecutionIntentStatus.REJECTED,
          environment,
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
                environment,
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
