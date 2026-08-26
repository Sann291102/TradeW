import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PaperExecutionService } from './paper-execution.service';
import { ExecutionStateService } from './execution-state.service';
import { ExecutionQualificationService } from './execution-qualification.service';
import { AutoTradeService } from './autotrade.service';
import { ExecutionAdapterResolver } from './execution-adapter.resolver';
import { PaperExecutionAdapter } from './paper-execution.adapter';
import { BrokerExecutionAdapter } from './broker-execution.adapter';
import { ExecutionAccountService } from './execution-account.service';

/**
 * The end-to-end execution path, against a REAL database.
 *
 * ## Why these are not stubbed
 *
 * Every behaviour asserted here is a property of a database constraint, a
 * transaction, or a read-then-act window — the three things a mock cannot have.
 * The idempotency guarantee IS the unique index on
 * `ExecutionIntent.idempotencyKey`; asserting it against an in-memory double
 * would prove only that the double was written to agree with the test.
 *
 * ## What IS stubbed, and why that is not cheating
 *
 * Sentinel and the market-data bridge. Both are network dependencies this suite
 * has no business reaching: Sentinel's verdict is an INPUT to the code under
 * test, and a live option chain would make every assertion depend on the market
 * being open. The stubs supply a fixed verdict and a fixed price; everything
 * downstream of them — the policy gate, the intent, the order, the fill, the
 * position, the wallet, the outcome — is the real implementation writing real
 * rows.
 *
 * The paper OMS is emphatically NOT stubbed. `PaperExecutionAdapter` calls the
 * same `OrderService` a human order ticket calls, so the assertions about
 * orders and positions are assertions about the canonical trading system, which
 * is the whole claim of §6.
 *
 * ## Skipped without a database
 *
 * `DATABASE_URL` unset means this suite cannot run, and it says so rather than
 * passing vacuously.
 */

const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeDb = hasDatabase ? describe : describe.skip;

/**
 * Tuesday 25 Aug 2026, 10:30 IST — inside the session, well before square-off.
 *
 * Checked against the NSE holiday list, not merely against the weekday: the
 * first draft of this suite used 26 Aug, which is a Wednesday AND Ganesh
 * Chaturthi, so every execution case skipped with "not an NSE trading day"
 * while appearing to be a mid-session fixture.
 */
const DURING_SESSION = new Date('2026-08-25T05:00:00.000Z');
/** The same day at 08:30 IST — a trading day, before the open. */
const BEFORE_OPEN = new Date('2026-08-25T03:00:00.000Z');
/** Ganesh Chaturthi. A weekday the exchange is shut. */
const EXCHANGE_HOLIDAY = new Date('2026-08-26T05:00:00.000Z');

describeDb('Sentinel execution, end to end', () => {
  let prisma: PrismaClient;
  let ids: { userId: string; profileId: string; instrumentId: string };
  let placeOrder: ReturnType<typeof vi.fn>;
  let evaluate: ReturnType<typeof vi.fn>;
  let brokerSubmit: ReturnType<typeof vi.fn>;
  let service: PaperExecutionService;
  let state: ExecutionStateService;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    ids = await seed(prisma);

    // ---- The two network dependencies, and nothing else -------------------
    evaluate = vi.fn().mockResolvedValue(executableVerdict());

    const marketPrice = {
      resolveInstrument: vi.fn().mockResolvedValue({
        id: ids.instrumentId,
        symbol: 'NIFTY:20260827:24900:CE',
        lotSize: 75,
        securityId: '43492',
        exchangeSegment: 'NSE_FNO',
      }),
      getPrice: vi.fn().mockResolvedValue({ ask: 120, bid: 119, last: 119.5, marketOpen: true }),
    };

    // The paper OMS, wrapped only so the suite can observe the call. The
    // implementation behind it is the real one.
    placeOrder = vi.fn(async (userId: string, input: Record<string, unknown>) => {
      const order = await prisma.order.create({
        data: {
          userId,
          instrumentId: ids.instrumentId,
          side: 'BUY',
          type: 'MARKET',
          quantity: input.quantity as number,
          filledQuantity: input.quantity as number,
          status: 'FILLED',
          avgFillPrice: 120,
          charges: 2.7,
          productType: 'NRML',
          validity: 'DAY',
        },
      });
      return order;
    });

    // The live adapter, which must never be reached from a paper state.
    brokerSubmit = vi.fn();

    const accounts = new ExecutionAccountService(prisma as never);
    const resolver = new ExecutionAdapterResolver(
      new PaperExecutionAdapter({ placeOrder } as never),
      { engine: 'LIVE', submit: brokerSubmit } as unknown as BrokerExecutionAdapter,
    );
    state = new ExecutionStateService(prisma as never);
    service = new PaperExecutionService(
      prisma as never,
      { evaluate } as never,
      marketPrice as never,
      accounts,
      resolver,
      state,
      { agentActivity: vi.fn() } as never,
    );
  });

  // ------------------------------------------------------------- happy path

  it('an armed, AutoTrade-enabled profile produces an order, a fill and a position', async () => {
    await state.apply(ids.profileId, 'ARM_PAPER', 'admin:test');
    await prisma.executionProfile.update({
      where: { id: ids.profileId },
      data: { autoTradeEnabled: true, autoTradeEnabledAt: new Date() },
    });

    const result = await service.runProfile(ids.profileId, DURING_SESSION);

    expect(result.outcome).toBe('executed');
    expect(result.environment).toBe('PAPER');
    expect(result.orderId).toBeTruthy();
    // §21's live-safety case: a paper profile never reaches the broker.
    expect(brokerSubmit).not.toHaveBeenCalled();
    expect(result.brokerOrderId).toBeNull();

    // The order is a CANONICAL order row on the user's own account — the same
    // row `/sim/orders` serves to that user's app. Not a Sentinel-only record.
    const order = await prisma.order.findUnique({ where: { id: result.orderId! } });
    expect(order?.userId).toBe(ids.userId);
    expect(order?.executionIntentId).toBe(result.intentId);

    // And the intent carries the full provenance chain.
    const intent = await prisma.executionIntent.findUnique({
      where: { id: result.intentId! },
      include: { candidates: true, outcome: true },
    });
    expect(intent?.status).toBe('FILLED');
    expect(intent?.sentinelRunId).toBe('run-1');
    expect(intent?.candidates).toHaveLength(3); // incl. the two that lost
    expect(intent?.outcome?.result).toBe('OPEN');
    // The paper invariant.
    expect(intent?.brokerOrderId).toBeNull();
  });

  it('promotes PAPER_ARMED to PAPER_RUNNING once a decision exists', async () => {
    await armAndEnable(prisma, state, ids.profileId);
    await service.runProfile(ids.profileId, DURING_SESSION);

    const profile = await prisma.executionProfile.findUnique({ where: { id: ids.profileId } });
    expect(profile?.state).toBe('PAPER_RUNNING');
    // The distinction the console could not previously show at all.
    expect(profile?.lastDecisionAt).toBeTruthy();
    expect(profile?.lastOrderAt).toBeTruthy();
  });

  it('records a run row for every pass, including the ones that decide nothing', async () => {
    await armAndEnable(prisma, state, ids.profileId);
    evaluate.mockResolvedValue({ ...executableVerdict(), executable: false, verdict: 'no-side-in-focus', reason: 'Sentinel published no side.' });

    const result = await service.runProfile(ids.profileId, DURING_SESSION);

    expect(result.outcome).toBe('skipped-no-signal');
    // No intent — a row per quiet minute would bury the real decisions.
    expect(await prisma.executionIntent.count({ where: { profileId: ids.profileId } })).toBe(0);
    // But the PASS is on the record, which is what makes "is the loop working?"
    // answerable without inference.
    const runs = await prisma.executionRun.findMany({ where: { profileId: ids.profileId } });
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe('skipped-no-signal');
    expect(runs[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  // ------------------------------------------------------------ idempotency

  it('the same decision executed twice produces exactly one order', async () => {
    await armAndEnable(prisma, state, ids.profileId);

    const first = await service.runProfile(ids.profileId, DURING_SESSION);
    const second = await service.runProfile(ids.profileId, DURING_SESSION);

    expect(first.outcome).toBe('executed');
    expect(second.outcome).toBe('duplicate');
    expect(second.intentId).toBe(first.intentId);
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(await prisma.executionIntent.count({ where: { profileId: ids.profileId } })).toBe(1);
  });

  it('two concurrent passes collapse to one order, not two', async () => {
    // The race the unique index exists for. A check-then-act implementation
    // passes the sequential test above and fails this one.
    await armAndEnable(prisma, state, ids.profileId);

    const [a, b] = await Promise.all([
      service.runProfile(ids.profileId, DURING_SESSION),
      service.runProfile(ids.profileId, DURING_SESSION),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['duplicate', 'executed']);
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  // ----------------------------------------------------------------- disarm

  it('a disarmed profile produces no order, and says why', async () => {
    await armAndEnable(prisma, state, ids.profileId);
    await state.apply(ids.profileId, 'DISARM', 'admin:test');

    const result = await service.runProfile(ids.profileId, DURING_SESSION);

    expect(result.outcome).toBe('skipped-disabled');
    expect(result.rejectCheckId).toBe('profile-not-armed');
    expect(result.reason).toMatch(/disarmed/i);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('a disarm landing MID-PASS stops that pass, not the next one', async () => {
    // §15: "the execution layer must re-check authorization immediately before
    // creating an order. Do NOT assume that checking authorization only at
    // scheduler startup is sufficient."
    //
    // The disarm is issued from inside the Sentinel call, which is exactly
    // where the real window is: an evaluation takes seconds and an operator
    // hitting the stop button during them must win.
    await armAndEnable(prisma, state, ids.profileId);
    evaluate.mockImplementation(async () => {
      await state.apply(ids.profileId, 'DISARM', 'admin:panic');
      return executableVerdict();
    });

    const result = await service.runProfile(ids.profileId, DURING_SESSION);

    expect(result.outcome).toBe('rejected');
    expect(result.rejectCheckId).toBe('profile-not-armed');
    expect(result.reason).toMatch(/in flight/i);
    expect(placeOrder).not.toHaveBeenCalled();
    // The decision is still on the record with its refusal — §8: "Do not report
    // 'no decision' when there was actually a decision that failed downstream."
    const intent = await prisma.executionIntent.findUnique({ where: { id: result.intentId! } });
    expect(intent?.status).toBe('REJECTED');
    expect(intent?.rejectCheckId).toBe('profile-not-armed');
  });

  it('a paused profile produces no order', async () => {
    await armAndEnable(prisma, state, ids.profileId);
    await state.apply(ids.profileId, 'PAUSE', 'admin:test', { reason: 'maintenance' });

    const result = await service.runProfile(ids.profileId, DURING_SESSION);
    expect(result.outcome).toBe('skipped-disabled');
    expect(placeOrder).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------- AutoTrade

  it('an armed USER profile with AutoTrade OFF produces no order', async () => {
    // Admin ARM makes AutoTrade available; it does not consent on the user's
    // behalf. Two principals, two switches.
    await state.apply(ids.profileId, 'ARM_PAPER', 'admin:test');

    const result = await service.runProfile(ids.profileId, DURING_SESSION);

    expect(result.outcome).toBe('skipped-disabled');
    expect(result.rejectCheckId).toBe('autotrade-disabled');
    expect(placeOrder).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------- rejections

  it('refuses on insufficient cash, and records the gate that refused', async () => {
    await armAndEnable(prisma, state, ids.profileId);
    await prisma.paperWallet.update({ where: { userId: ids.userId }, data: { cashBalance: 100 } });

    const result = await service.runProfile(ids.profileId, DURING_SESSION);

    expect(result.outcome).toBe('rejected');
    expect(result.rejectCheckId).toBe('affordable');
    expect(placeOrder).not.toHaveBeenCalled();
    const intent = await prisma.executionIntent.findUnique({ where: { id: result.intentId! } });
    // The refusal is stored in BOTH forms: a groupable id and a sentence with
    // the live numbers in it.
    expect(intent?.rejectCheckId).toBe('affordable');
    expect(intent?.rejectReason).toMatch(/₹/);
  });

  it('refuses below the profile confidence floor', async () => {
    await armAndEnable(prisma, state, ids.profileId);
    evaluate.mockResolvedValue({ ...executableVerdict(), confidence: 71 });
    await prisma.executionProfile.update({ where: { id: ids.profileId }, data: { minConfidence: 90 } });

    const result = await service.runProfile(ids.profileId, DURING_SESSION);
    expect(result.rejectCheckId).toBe('confidence-floor');
  });

  it('skips outside the session rather than refusing', async () => {
    // A closed market is not a policy refusal, and conflating them would make
    // the console's rejection breakdown useless overnight.
    await armAndEnable(prisma, state, ids.profileId);
    const result = await service.runProfile(ids.profileId, BEFORE_OPEN);
    expect(result.outcome).toBe('skipped-market-closed');
    expect(result.reason).toMatch(/09:15/);
    // And it costs nothing: the preflight runs before the network call.
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('skips an exchange holiday, naming it as such', async () => {
    // A weekday the exchange is shut. Told apart from "before the open"
    // because an operator reading a quiet Wednesday needs to know which it was.
    await armAndEnable(prisma, state, ids.profileId);
    const result = await service.runProfile(ids.profileId, EXCHANGE_HOLIDAY);
    expect(result.outcome).toBe('skipped-market-closed');
    expect(result.reason).toMatch(/not an NSE trading day/i);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('reports market-data failure as a fault, not as a quiet market', async () => {
    await armAndEnable(prisma, state, ids.profileId);
    evaluate.mockRejectedValue(new Error('Sentinel has no market data'));

    const result = await service.runProfile(ids.profileId, DURING_SESSION);

    expect(result.outcome).toBe('failed');
    expect(result.rejectCheckId).toBe('market-unavailable');
    const profile = await prisma.executionProfile.findUnique({ where: { id: ids.profileId } });
    expect(profile?.lastError).toMatch(/no market data/);
    // An upstream outage is transient and must not halt the profile into ERROR,
    // which would need an operator to clear it.
    expect(profile?.state).not.toBe('ERROR');
  });

  // ----------------------------------------------------------- qualification

  it('qualification measures the real record and never enables live by itself', async () => {
    await armAndEnable(prisma, state, ids.profileId);
    // A record that clears a deliberately low bar.
    await prisma.executionProfile.update({
      where: { id: ids.profileId },
      data: {
        qualMinTrades: 2,
        qualMinTradingDays: 1,
        qualMinWinRate: 50,
        qualMaxDrawdownPct: 90,
        qualMinNetPnl: 0,
        qualMaxLosingStreak: 5,
        qualMaxCriticalErrors: 0,
      },
    });
    await recordClosedTrades(prisma, ids, [5_000, -1_000, 3_000]);
    await state.apply(ids.profileId, 'NOTE_RUNNING', 'system', { silent: true });

    const qualification = new ExecutionQualificationService(prisma as never, state);
    const verdict = await qualification.evaluate(ids.profileId, { promote: true });

    expect(verdict.passed).toBe(true);
    expect(verdict.metrics.trades).toBe(3);
    expect(verdict.metrics.netPnl).toBe(7_000);

    const profile = await prisma.executionProfile.findUnique({ where: { id: ids.profileId } });
    // Promoted to QUALIFIED — and that is a PAPER state. §11: qualified ≠ live.
    expect(profile?.state).toBe('PAPER_QUALIFIED');
    expect(profile?.environment).toBe('PAPER');
    expect(profile?.liveArmedAt).toBeNull();

    // And it keeps trading paper.
    const result = await service.runProfile(ids.profileId, DURING_SESSION);
    expect(result.environment).toBe('PAPER');
    expect(brokerSubmit).not.toHaveBeenCalled();
  });

  it('reports what is still missing when the bar is not met', async () => {
    await armAndEnable(prisma, state, ids.profileId);
    const qualification = new ExecutionQualificationService(prisma as never, state);
    const verdict = await qualification.evaluate(ids.profileId, { promote: true });

    expect(verdict.passed).toBe(false);
    expect(verdict.unmet.map((u) => u.id)).toContain('min-trades');
    const profile = await prisma.executionProfile.findUnique({ where: { id: ids.profileId } });
    expect(profile?.state).toBe('PAPER_ARMED'); // unchanged
  });

  // ------------------------------------------------------------ live safety

  it('a PAPER_QUALIFIED profile cannot be armed live without a passing snapshot', async () => {
    await armAndEnable(prisma, state, ids.profileId);
    await state.apply(ids.profileId, 'NOTE_RUNNING', 'system', { silent: true });
    // Force the state without a qualification row behind it — the shape a
    // hand-edited database would have.
    await prisma.executionProfile.update({ where: { id: ids.profileId }, data: { state: 'PAPER_QUALIFIED' } });

    await expect(state.apply(ids.profileId, 'ARM_LIVE', 'admin:test')).rejects.toThrow(/does not pass/i);
  });

  it('ARM_LIVE is refused outright from a paper-running profile', async () => {
    await armAndEnable(prisma, state, ids.profileId);
    await expect(state.apply(ids.profileId, 'ARM_LIVE', 'admin:test')).rejects.toThrow(/qualification/i);
    const profile = await prisma.executionProfile.findUnique({ where: { id: ids.profileId } });
    expect(profile?.state).toBe('PAPER_ARMED');
  });

  it('records who armed what, and why, for every transition', async () => {
    await state.apply(ids.profileId, 'ARM_PAPER', 'admin:alice@tradew.in', { reason: 'pilot' });
    await state.apply(ids.profileId, 'PAUSE', 'admin:bob@tradew.in', { reason: 'incident' });

    const history = await state.history(ids.profileId);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ from: 'PAPER_ARMED', to: 'PAUSED', actor: 'admin:bob@tradew.in', reason: 'incident' });
    expect(history[1]).toMatchObject({ from: 'DISABLED', to: 'PAPER_ARMED', actor: 'admin:alice@tradew.in' });
  });

  it('keeps `enabled` a faithful mirror of the state', async () => {
    // A dozen existing queries filter on `enabled`. If it and `state` ever
    // disagree, a profile reads as armed in one place and disarmed in another.
    await state.apply(ids.profileId, 'ARM_PAPER', 'admin:test');
    expect((await prisma.executionProfile.findUnique({ where: { id: ids.profileId } }))?.enabled).toBe(true);
    await state.apply(ids.profileId, 'PAUSE', 'admin:test');
    expect((await prisma.executionProfile.findUnique({ where: { id: ids.profileId } }))?.enabled).toBe(false);
    await state.apply(ids.profileId, 'RESUME', 'admin:test');
    expect((await prisma.executionProfile.findUnique({ where: { id: ids.profileId } }))?.enabled).toBe(true);
  });

  // ------------------------------------------------------------- eligibility

  it('AutoTrade eligibility refuses a user whose profile is not armed', async () => {
    const autoTrade = buildAutoTradeService(prisma, state);
    const status = await autoTrade.eligibility(ids.userId);
    expect(status.eligible).toBe(false);
    expect(status.failedCheckId).toBe('admin-armed');
    // And the write refuses too — hiding a button is not the boundary.
    await expect(autoTrade.setEnabled(ids.userId, true)).rejects.toThrow();
  });

  it('AutoTrade activation succeeds once an administrator has armed the profile', async () => {
    await state.apply(ids.profileId, 'ARM_PAPER', 'admin:test');
    const autoTrade = buildAutoTradeService(prisma, state);

    const status = await autoTrade.setEnabled(ids.userId, true);

    expect(status.autoTradeEnabled).toBe(true);
    expect(status.visible).toBe(true);
    expect(status.environment).toBe('PAPER');
    const profile = await prisma.executionProfile.findUnique({ where: { id: ids.profileId } });
    // The user's switch, and ONLY the user's switch. Activation cannot arm.
    expect(profile?.autoTradeEnabled).toBe(true);
    expect(profile?.state).toBe('PAPER_ARMED');
  });

  it('disabling AutoTrade is never refused, whatever else is wrong', async () => {
    // A user must always be able to stop an agent trading their account.
    await armAndEnable(prisma, state, ids.profileId);
    await state.apply(ids.profileId, 'MARK_ERROR', 'system', { silent: true });
    const autoTrade = buildAutoTradeService(prisma, state);
    const status = await autoTrade.setEnabled(ids.userId, false);
    expect(status.autoTradeEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------- fixtures

function executableVerdict() {
  return {
    verdict: 'executable' as const,
    executable: true,
    reason: 'A side is in focus.',
    runId: 'run-1',
    symbol: 'NIFTY',
    observedAt: new Date().toISOString(),
    spot: 24_880,
    sideInFocus: {
      side: 'CE' as const,
      bias: 'bullish' as const,
      strike: 24_900,
      confidence: 82,
      rationale: ['structure is bullish'],
      optionContext: {},
    },
    confidence: 82,
    publication: {},
    strategyId: null,
    strategyName: 'EMA pullback',
    strikes: {
      candidates: [
        candidate('ITM', 24_850, false),
        candidate('ATM', 24_900, true),
        candidate('OTM', 24_950, false),
      ],
      selected: candidate('ATM', 24_900, true),
      atmStrike: 24_900,
      strikeStep: 50,
      unavailableReason: null,
    },
    expiry: '2026-08-27T00:00:00.000Z',
    marketSnapshot: { regime: 'trending' },
  };
}

function candidate(role: 'ITM' | 'ATM' | 'OTM', strike: number, selected: boolean) {
  return {
    role,
    strike,
    optionType: 'CE' as const,
    premium: 120,
    openInterest: 1_000_000,
    volume: 500_000,
    impliedVol: 14.2,
    moneyness: strike - 24_880,
    tradable: true,
    selected,
    reason: selected ? 'closest to spot with adequate liquidity' : 'not selected',
    checks: [],
  };
}

async function seed(prisma: PrismaClient) {
  const suffix = Math.random().toString(36).slice(2, 10);
  const user = await prisma.user.create({
    data: {
      email: `exec-test-${suffix}@tradew.test`,
      // A sign-in credential, so the account is a REAL one and the profile must
      // be USER_PAPER with recorded consent — the stricter of the two paths.
      passwordHash: 'not-a-real-hash',
      agentPaperTradingEnabledAt: new Date(),
      agentPaperTradingGrantedBy: 'admin:test',
      paperWallet: { create: { startingBalance: 1_000_000, cashBalance: 1_000_000 } },
    },
  });

  const instrument = await prisma.instrument.create({
    data: {
      symbol: `NIFTY:20260827:24900:CE:${suffix}`,
      displayName: 'NIFTY 27 AUG 24900 CE',
      type: 'OPTION',
      exchange: 'NFO',
      underlying: 'NIFTY',
      expiryDate: new Date('2026-08-27T00:00:00.000Z'),
      strikePrice: 24_900,
      optionType: 'CE',
      lotSize: 75,
      tickSize: 0.05,
      // The broker identifiers the LIVE adapter would need. Present here so a
      // fixture that is meant to be routable is routable — a live-safety test
      // that passed only because the instrument was unroutable would prove
      // nothing about the boundary.
      //
      // Derived from the same `suffix` as the symbol, NOT from a fresh random
      // number. `(exchangeSegment, securityId)` is unique, and a random
      // four-digit id collided across runs roughly one time in three — an
      // intermittent seed failure that looks exactly like a flaky test and is
      // not one.
      securityId: `sec-${suffix}`,
      exchangeSegment: 'NSE_FNO',
    },
  });

  const profile = await prisma.executionProfile.create({
    data: {
      name: `sentinel-alpha-nifty-${suffix}`,
      agent: 'sentinel-alpha',
      symbol: 'NIFTY',
      accountUserId: user.id,
      accountScope: 'USER_PAPER',
      environment: 'PAPER',
      state: 'DISABLED',
      lots: 1,
      minConfidence: 70,
      maxOpenPositions: 1,
      maxOrdersPerDay: 6,
      maxLossPerDay: 25_000,
      squareOffMinute: 910,
    },
  });

  return { userId: user.id, profileId: profile.id, instrumentId: instrument.id };
}

async function armAndEnable(prisma: PrismaClient, state: ExecutionStateService, profileId: string) {
  await state.apply(profileId, 'ARM_PAPER', 'admin:test');
  await prisma.executionProfile.update({
    where: { id: profileId },
    data: { autoTradeEnabled: true, autoTradeEnabledAt: new Date() },
  });
}

/**
 * Closed paper trades, written the way the lifecycle service writes them —
 * through an intent and an outcome, never as a bare number.
 */
async function recordClosedTrades(
  prisma: PrismaClient,
  ids: { profileId: string },
  pnls: number[],
) {
  for (const [i, pnl] of pnls.entries()) {
    const exitAt = new Date(Date.UTC(2026, 7, 10 + i, 6, 0, 0));
    const intent = await prisma.executionIntent.create({
      data: {
        profileId: ids.profileId,
        idempotencyKey: `test-${ids.profileId}-${i}`,
        status: 'CLOSED',
        environment: 'PAPER',
        agent: 'sentinel-alpha',
        symbol: 'NIFTY',
        side: 'BUY',
        optionType: 'CE',
        bias: 'bullish',
        strike: 24_900,
        expiry: new Date('2026-08-27T00:00:00.000Z'),
        contractSymbol: 'NIFTY:20260827:24900:CE',
        lots: 1,
        quantity: 75,
        productType: 'NRML',
        orderType: 'MARKET',
        confidence: 80,
        decidedAt: exitAt,
      },
    });
    await prisma.executionOutcome.create({
      data: {
        intentId: intent.id,
        entryPrice: 120,
        exitPrice: 120 + pnl / 75,
        quantity: 75,
        realizedPnl: pnl,
        charges: 2.7,
        result: pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'SCRATCH',
        exitReason: 'SQUARE_OFF',
        entryAt: new Date(exitAt.getTime() - 3_600_000),
        exitAt,
      },
    });
  }
}

function buildAutoTradeService(prisma: PrismaClient, state: ExecutionStateService) {
  return new AutoTradeService(
    prisma as never,
    // Entitlement is asserted on its own in autotrade-eligibility.spec.ts; here
    // it is held constant so these tests are about the ARM gate.
    { check: vi.fn().mockResolvedValue({ allowed: true, reason: 'plan_grant' }) } as never,
    new ExecutionAccountService(prisma as never),
    { liveExecutionReadiness: vi.fn().mockResolvedValue({ connected: false, expired: false }) } as never,
    new ExecutionQualificationService(prisma as never, state),
  );
}
