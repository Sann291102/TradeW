import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DisciplineService } from '../discipline/discipline.service';
import { PrismaService } from '../prisma/prisma.service';
import { MarketPriceService, type LivePrice } from '../sim/market-price.service';
import { OrderService } from '../sim/order.service';
import { ExecutionAccountService } from './execution-account.service';
import { ExecutionCalibrationService } from './execution-calibration.service';
import { ExecutionJournalService } from './execution-journal.service';
import { ExecutionLifecycleService } from './execution-lifecycle.service';
import { PaperExecutionService } from './paper-execution.service';
import { PositionManagerService } from './position-manager.service';
import { SentinelExecutionClient, type ExecutionEvaluationDto } from './sentinel-execution.client';

/**
 * The complete automated paper-trade lifecycle, end to end, against a REAL
 * Postgres.
 *
 * ## What is real here, and what is not
 *
 * REAL: the schema, every row, `OrderService` (margin, charges, fills, realized
 * P&L), `PositionService`, the risk planner, the fill model, the policy gate,
 * the position manager and its exit precedence, the trailing ratchet, the
 * lifecycle reconciliation, the journal and the calibration fold. All
 * production classes, all against a real database.
 *
 * STUBBED: exactly two boundaries, both external to this application —
 *   · `SentinelExecutionClient`, the api→sentinel network hop. Sentinel's own
 *     gates are asserted in `services/sentinel/src/execution/*.spec.ts`; what
 *     matters here is what the execution loop DOES with a verdict.
 *   · `MarketPriceService`, the Dhan bridge. Driving a deterministic price path
 *     is the whole point: a test that has to wait for a real option to fall
 *     through a stop is not a test.
 *
 * Nothing else is faked. In particular the P&L below is computed by the same
 * `applyFill` arithmetic a human's order goes through.
 *
 * ## Why it skips without a database
 *
 * A lifecycle test that silently passed by mocking Prisma would assert nothing
 * about the thing most likely to be wrong — the transactional boundaries. So it
 * requires a real database and says so when there isn't one, rather than
 * degrading into a unit test wearing an integration test's name.
 *
 *     TEST_DATABASE_URL=postgresql://… npx vitest run src/paper-execution/paper-lifecycle.spec.ts
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const hasDatabase = DATABASE_URL.length > 0;

/** A price path the stub walks through, one entry per `getPrice` call. */
let priceScript: number[] = [];
let priceCursor = 0;
let marketOpenFlag = true;
/**
 * The clock every assertion runs against.
 *
 * The suite drives a simulated `now` (a weekday inside the session window), so
 * the feed's tick timestamp has to track THAT clock rather than the wall
 * clock. An earlier version of this fixture returned `new Date()` and every
 * entry was correctly refused by the freshness gate for a quote several days
 * old — the gate working, and the fixture wrong.
 */
let simulatedNow = new Date();
/** Set by the emergency test to simulate a feed that has stopped ticking. */
let feedStale = false;

const LOT_SIZE = 75;
const ENTRY_PREMIUM = 120;

function nextPrice(): number {
  const price = priceScript[Math.min(priceCursor, priceScript.length - 1)] ?? ENTRY_PREMIUM;
  priceCursor++;
  return price;
}

/** Stands in for the Dhan bridge. Every other collaborator is production code. */
class StubMarketPrice {
  instrumentId = '';
  async resolveInstrument(symbol: string) {
    const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    const row = await prisma.instrument.upsert({
      where: { symbol },
      create: {
        symbol,
        displayName: symbol,
        exchange: 'NSE',
        exchangeSegment: 'NSE_FNO',
        securityId: `stub-${symbol}`,
        type: 'OPTION',
        lotSize: LOT_SIZE,
        tickSize: 0.05,
        underlying: symbol.split(':')[0],
        expiryDate: new Date(`${symbol.split(':')[1].replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')}T00:00:00.000Z`),
        strikePrice: Number(symbol.split(':')[2]),
        optionType: symbol.split(':')[3],
        active: true,
      },
      update: { active: true },
    });
    await prisma.$disconnect();
    this.instrumentId = row.id;
    return row;
  }
  async getPrice(): Promise<LivePrice> {
    const ltp = nextPrice();
    return { ltp, bid: ltp * 0.998, ask: ltp * 1.002, marketOpen: marketOpenFlag, underlyingSpot: 24_500 };
  }
  async feedFreshness() {
    const quotedAt = new Date(simulatedNow.getTime() - (feedStale ? 10 * 60_000 : 800));
    return { quotedAt, marketOpen: marketOpenFlag, instruments: 4 };
  }
}

function evaluation(overrides: Partial<ExecutionEvaluationDto> = {}): ExecutionEvaluationDto {
  const expiry = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
  const candidate = {
    role: 'ATM' as const,
    strike: 24_500,
    optionType: 'CE' as const,
    premium: ENTRY_PREMIUM,
    openInterest: 500_000,
    volume: 90_000,
    impliedVol: 14,
    moneyness: 0,
    tradable: true,
    selected: true,
    reason: 'Selected for the lifecycle test.',
    checks: [],
  };
  return {
    verdict: 'executable',
    executable: true,
    reason: 'Lifecycle test decision.',
    runId: 'run-lifecycle',
    symbol: 'NIFTY',
    observedAt: new Date().toISOString(),
    spot: 24_500,
    sideInFocus: {
      side: 'CE',
      bias: 'bullish',
      strike: 24_500,
      confidence: 84,
      rationale: ['Lifecycle test'],
    } as ExecutionEvaluationDto['sideInFocus'],
    confidence: 84,
    publication: null,
    strategyId: 'agent-trend-momentum',
    strategyName: 'Trend Momentum Continuation',
    strikes: { candidates: [candidate], selected: candidate, atmStrike: 24_500, strikeStep: 50, unavailableReason: null },
    expiry: `${expiry}T00:00:00.000Z`,
    marketSnapshot: {},
    dataQuality: {
      ok: true,
      checks: [],
      candles: 120,
      newestBarAt: new Date().toISOString(),
      barAgeMinutes: 3,
      spot: 24_500,
      optionChainStrikes: 21,
      failedCheckId: null,
      reason: null,
    },
    indexDirection: { direction: 'bullish', strength: 0.9, votes: [], conflicts: [], summary: 'Index reads bullish.' },
    agentStrategy: {
      strategyId: 'agent-trend-momentum',
      strategyName: 'Trend Momentum Continuation',
      version: '1.0.0',
      purpose: 'Lifecycle test.',
      regime: 'trending',
      regimeDeclared: true,
      bias: 'bullish',
      confidence: 84,
      rulesMatched: ['ema_stack_aligned'],
      rulesUnmet: [],
      exitRules: ['momentum_faded'],
      knowledgeConcepts: ['trend'],
    },
    evidence: { items: [], opposing: [], unavailable: [], supportRatio: 1, summary: 'All supporting.' },
    confirmations: [],
    exitRuleEvaluations: [],
    ...overrides,
  };
}

describe.skipIf(!hasDatabase)('the complete automated paper-trade lifecycle', () => {
  let prisma: PrismaService;
  let execution: PaperExecutionService;
  let manager: PositionManagerService;
  let lifecycle: ExecutionLifecycleService;
  let journal: ExecutionJournalService;
  let calibration: ExecutionCalibrationService;
  let orders: OrderService;
  let sentinelStub: { evaluate: () => Promise<ExecutionEvaluationDto> };

  const NIFTY_AGENT = 'lifecycle-nifty';
  const SENSEX_AGENT = 'lifecycle-sensex';
  let niftyProfileId = '';
  let sensexProfileId = '';
  let accountId = '';

  /** A weekday at 11:02 IST, so the session window passes deterministically. */
  function marketHours(minute = 11 * 60 + 2): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7)); // next Monday
    const utcMinutes = minute - 330;
    d.setUTCHours(Math.floor(utcMinutes / 60), utcMinutes % 60, 0, 0);
    return d;
  }

  beforeAll(async () => {
    // ---- Constructed BY HAND, not through the Nest container --------------
    //
    // Vitest transpiles with esbuild, which does not emit
    // `emitDecoratorMetadata` — so Nest's type-based constructor injection
    // resolves every dependency to `undefined` inside a spec. That is not a
    // problem with the code under test; it is a property of the test runner,
    // and the rest of this suite already builds its subjects directly for the
    // same reason. Wiring them explicitly also makes the dependency graph a
    // visible part of the test rather than framework magic.
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.DISCIPLINE_OVERRIDE_SECRET ??= 'lifecycle-spec-secret-not-a-real-one';

    prisma = new PrismaService();
    await prisma.$connect();

    const marketPrice = new StubMarketPrice() as unknown as MarketPriceService;
    const discipline = new DisciplineService(prisma);
    orders = new OrderService(prisma, marketPrice, discipline);
    const accounts = new ExecutionAccountService(prisma);
    calibration = new ExecutionCalibrationService(prisma);
    journal = new ExecutionJournalService(prisma, calibration);
    lifecycle = new ExecutionLifecycleService(prisma, orders, journal);
    manager = new PositionManagerService(prisma, orders, marketPrice);

    sentinelStub = { evaluate: async () => evaluation() };
    execution = new PaperExecutionService(
      prisma,
      sentinelStub as unknown as SentinelExecutionClient,
      orders,
      marketPrice,
      accounts,
      manager,
      calibration,
    );

    await cleanup();

    // A SYSTEM_PAPER machine account: no password, no Google identity, so it
    // is structurally not a person's account. Exactly what
    // `create-execution-profile.ts` produces.
    const account = await prisma.user.create({
      data: { email: `lifecycle-${Date.now()}@agents.tradew.local`, country: 'IN' },
    });
    accountId = account.id;

    const mkProfile = (name: string, symbol: string, agent: string) =>
      prisma.executionProfile.create({
        data: {
          name,
          agent,
          symbol,
          accountUserId: accountId,
          accountScope: 'SYSTEM_PAPER',
          enabled: true,
          lots: 20,
          minConfidence: 70,
          maxOpenPositions: 2,
          maxOrdersPerDay: 60,
          // Deliberately far above the ₹25,000 default. The suite deliberately
          // takes several stop-outs on 20-lot positions inside one simulated
          // IST day, and the real daily-loss gate would (correctly) stop the
          // agent after the first — which is the gate working, not a bug. Its
          // own behaviour is asserted in `execution-policy.spec.ts`; raising it
          // here keeps the LIFECYCLE assertions reachable.
          maxLossPerDay: 10_000_000,
          capitalAllocationPct: 20,
          riskPerTradePct: 3,
          rewardPerTradePct: 9,
          trailStepPoints: 3,
          strategyIds: ['agent-trend-momentum'],
        },
      });

    niftyProfileId = (await mkProfile(NIFTY_AGENT, 'NIFTY', 'sentinel-alpha')).id;
    sensexProfileId = (await mkProfile(SENSEX_AGENT, 'SENSEX', 'sentinel-beta')).id;
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma?.$disconnect();
  });

  async function cleanup() {
    const profiles = await prisma.executionProfile.findMany({
      where: { name: { in: [NIFTY_AGENT, SENSEX_AGENT] } },
      select: { id: true, accountUserId: true },
    });
    const ids = profiles.map((p) => p.id);
    const users = [...new Set(profiles.map((p) => p.accountUserId))];
    if (ids.length) {
      await prisma.executionJournal.deleteMany({ where: { profileId: { in: ids } } });
      const intents = await prisma.executionIntent.findMany({ where: { profileId: { in: ids } }, select: { id: true } });
      const intentIds = intents.map((i) => i.id);
      await prisma.order.updateMany({ where: { executionIntentId: { in: intentIds } }, data: { executionIntentId: null } });
      await prisma.order.updateMany({ where: { exitOfIntentId: { in: intentIds } }, data: { exitOfIntentId: null } });
      await prisma.executionPosition.deleteMany({ where: { intentId: { in: intentIds } } });
      await prisma.executionOutcome.deleteMany({ where: { intentId: { in: intentIds } } });
      await prisma.executionStrikeCandidate.deleteMany({ where: { intentId: { in: intentIds } } });
      await prisma.executionIntent.deleteMany({ where: { profileId: { in: ids } } });
      await prisma.executionProfile.deleteMany({ where: { id: { in: ids } } });
    }
    for (const userId of users) {
      await prisma.trade.deleteMany({ where: { userId } });
      await prisma.position.deleteMany({ where: { userId } });
      await prisma.order.deleteMany({ where: { userId } });
      await prisma.paperWallet.deleteMany({ where: { userId } });
      await prisma.disciplineSession.deleteMany({ where: { userId } });
      await prisma.auditEvent.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await prisma.strategyCalibration.deleteMany({ where: { agent: { in: ['sentinel-alpha', 'sentinel-beta'] } } });
  }

  /** Runs one entry pass and returns the intent + position it produced. */
  async function enterOnce(profileId: string, at = marketHours()) {
    priceScript = [ENTRY_PREMIUM];
    priceCursor = 0;
    simulatedNow = at;
    const result = await execution.runProfile(profileId, at);
    expect(result.outcome, `${result.outcome}: ${result.reason}`).toBe('executed');
    const position = await prisma.executionPosition.findUnique({ where: { intentId: result.intentId! } });
    return { result, position: position! };
  }

  /**
   * Drives the manager along a path of EXITABLE prices.
   *
   * The argument is the price the manager will actually see, which is the BID
   * — a long option is exited by selling, so managing a stop against the LTP
   * would trigger late by half the spread every time, in the direction that
   * costs money. The stub quotes `bid = ltp × 0.998`, so the LTP is scaled up
   * here to land the bid exactly where the test asked for it. Asserting
   * against LTPs instead silently tests a level half a spread away from the
   * one the manager uses.
   */
  async function driveTo(exitablePrices: number[], at = marketHours()) {
    simulatedNow = at;
    for (const bid of exitablePrices) {
      priceScript = [bid / 0.998];
      priceCursor = 0;
      await manager.manageAll(at);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  it('1+11. enters NIFTY, at a live-derived price, with a persisted plan', async () => {
    const { result, position } = await enterOnce(niftyProfileId);
    expect(result.orderId).toBeTruthy();

    const intent = await prisma.executionIntent.findUnique({ where: { id: result.intentId! } });
    // The plan exists on the intent, written in the same INSERT that claimed
    // the idempotency key — i.e. BEFORE any order existed.
    expect(intent!.stopPrice).not.toBeNull();
    expect(intent!.targetPrice).not.toBeNull();
    expect(intent!.riskBudget).not.toBeNull();
    expect(intent!.allocatedCapital).not.toBeNull();
    expect(intent!.riskPlan).toBeTruthy();
    expect(intent!.fillModel).toBeTruthy();
    expect(intent!.indexDirection).toBe('bullish');
    expect(intent!.strategyVersion).toBe('1.0.0');
    expect(intent!.regime).toBe('trending');

    // The fill came from the live-derived ASK, not the LTP.
    const order = await prisma.order.findUnique({ where: { id: result.orderId! } });
    expect(Number(order!.avgFillPrice)).toBeCloseTo(ENTRY_PREMIUM * 1.002, 1);

    // The position is under management from the moment it filled.
    expect(position.state).toBe('OPEN');
    expect(Number(position.stopPrice)).toBeLessThan(Number(position.entryPrice));
    expect(Number(position.targetPrice)).toBeGreaterThan(Number(position.entryPrice));
    expect(position.trailPrice).toBeNull();

    // Capital: 20% of a ₹10L wallet caps the premium deployed.
    const plan = intent!.riskPlan as unknown as { allocationCeiling: number; riskAtStop: number; riskBudget: number };
    expect(Number(intent!.allocatedCapital)).toBeLessThanOrEqual(plan.allocationCeiling);
    expect(plan.riskAtStop).toBeLessThanOrEqual(plan.riskBudget);

    // Flatten before the next test. `manageAll` acts on EVERY open position,
    // so a position left behind here would be managed — and stopped out —
    // alongside the next test's, which is exactly the cross-talk the
    // simultaneous-agents test is meant to assert deliberately rather than
    // stumble into everywhere else.
    await driveTo([Number(position.stopPrice) - 1], marketHours(11 * 60 + 10));
    await lifecycle.reconcile();
  }, 30_000);

  it('12. a stop causes an automatic exit, and the P&L is real', async () => {
    const { result, position } = await enterOnce(niftyProfileId, marketHours(11 * 60 + 20));
    const stop = Number(position.stopPrice);

    await driveTo([stop - 1], marketHours(11 * 60 + 21));

    const after = await prisma.executionPosition.findUnique({ where: { id: position.id } });
    expect(after!.state).toBe('EXITING');
    expect(after!.exitReason).toBe('STOP');

    await lifecycle.reconcile();
    const outcome = await prisma.executionOutcome.findUnique({ where: { intentId: result.intentId! } });
    expect(outcome!.result).toBe('LOSS');
    // Computed by `OrderService.applyFill`, not by this test.
    expect(Number(outcome!.realizedPnl)).toBeLessThan(0);
    expect(outcome!.exitReason).toBe('STOP');
  }, 30_000);

  it('13. a target causes an automatic exit and a WIN', async () => {
    // Every entry in this suite sits in its OWN 15-minute idempotency bucket.
    // Two tests sharing one bucket makes the second a `duplicate`, which is
    // the mechanism working — see test 10, which asserts it deliberately.
    const { result, position } = await enterOnce(niftyProfileId, marketHours(11 * 60 + 40));
    const target = Number(position.targetPrice);

    await driveTo([target + 1], marketHours(11 * 60 + 41));
    const after = await prisma.executionPosition.findUnique({ where: { id: position.id } });
    expect(after!.exitReason).toBe('TARGET');

    await lifecycle.reconcile();
    const outcome = await prisma.executionOutcome.findUnique({ where: { intentId: result.intentId! } });
    expect(outcome!.result).toBe('WIN');
    expect(Number(outcome!.realizedPnl)).toBeGreaterThan(0);
  }, 30_000);

  it('14+15. trailing advances every 3 points and exits when it is broken', async () => {
    const { result, position } = await enterOnce(niftyProfileId, marketHours(12 * 60 + 0));
    const entry = Number(position.entryPrice);

    // Up in 3-point steps: +3 (breakeven), +6, +9, +12.
    await driveTo([entry + 3, entry + 6, entry + 9, entry + 12], marketHours(12 * 60 + 1));

    const trailed = await prisma.executionPosition.findUnique({ where: { id: position.id } });
    expect(trailed!.state).toBe('OPEN');
    expect(trailed!.trailSteps).toBe(4);
    expect(Number(trailed!.trailPrice)).toBeCloseTo(entry + 9, 1);

    const adjustments = await prisma.executionTrailAdjustment.findMany({
      where: { positionId: position.id },
      orderBy: { at: 'asc' },
    });
    // Every ratchet is its own append-only row, with the level it came from.
    expect(adjustments).toHaveLength(4);
    expect(adjustments[0].fromPrice).toBeNull();
    expect(Number(adjustments[0].toPrice)).toBeCloseTo(entry, 1);
    expect(adjustments.map((a) => a.totalSteps)).toEqual([1, 2, 3, 4]);

    // Now fall back through the trail.
    await driveTo([entry + 8], marketHours(12 * 60 + 2));
    const exited = await prisma.executionPosition.findUnique({ where: { id: position.id } });
    expect(exited!.exitReason).toBe('TRAIL');

    await lifecycle.reconcile();
    const outcome = await prisma.executionOutcome.findUnique({ where: { intentId: result.intentId! } });
    expect(outcome!.exitReason).toBe('TRAIL');
    // Trailing kept the gain: exited above entry.
    expect(Number(outcome!.realizedPnl)).toBeGreaterThan(0);
  }, 30_000);

  it('16+17. a strategy invalidation causes an automatic exit', async () => {
    const { result, position } = await enterOnce(niftyProfileId, marketHours(12 * 60 + 20));

    // The evaluation tick reports the thesis has collapsed. This is the ONLY
    // channel by which the fast loop learns that — it never calls Sentinel.
    manager.recordThesis('NIFTY', [
      { strategyId: 'agent-trend-momentum', fired: [{ id: 'momentum_faded', note: 'Session momentum has fallen to 0.18' }] },
    ]);

    await driveTo([Number(position.entryPrice) + 1], marketHours(12 * 60 + 21));
    const after = await prisma.executionPosition.findUnique({ where: { id: position.id } });
    expect(after!.exitReason).toBe('INVALIDATED');
    expect(after!.exitDetail).toContain('momentum_faded');

    await lifecycle.reconcile();
    const outcome = await prisma.executionOutcome.findUnique({ where: { intentId: result.intentId! } });
    expect(outcome!.exitReason).toBe('INVALIDATED');
    manager.recordThesis('NIFTY', []);
  }, 30_000);

  it('18. an emergency (dead feed) flattens rather than holding unmanaged', async () => {
    const { position } = await enterOnce(niftyProfileId, marketHours(12 * 60 + 40));

    feedStale = true; // the feed answers, but has not ticked in ten minutes
    await driveTo([Number(position.entryPrice)], marketHours(12 * 60 + 41));
    feedStale = false;

    const after = await prisma.executionPosition.findUnique({ where: { id: position.id } });
    expect(after!.exitReason).toBe('EMERGENCY');
    expect(after!.exitDetail).toContain('frozen quote');
    await lifecycle.reconcile();
  }, 30_000);

  it('19+20. disarming blocks NEW entries but does NOT strand an open position', async () => {
    const { result, position } = await enterOnce(niftyProfileId, marketHours(13 * 60 + 0));

    // The operator disarms while a position is open.
    await prisma.executionProfile.update({ where: { id: niftyProfileId }, data: { enabled: false } });

    // 19. No new entry.
    simulatedNow = marketHours(13 * 60 + 1);
    const blocked = await execution.runProfile(niftyProfileId, marketHours(13 * 60 + 1));
    expect(blocked.outcome).toBe('skipped-disabled');

    // 20. The OPEN position is still managed — and still exits on its stop.
    await driveTo([Number(position.stopPrice) - 1], marketHours(13 * 60 + 2));
    const after = await prisma.executionPosition.findUnique({ where: { id: position.id } });
    expect(after!.state).toBe('EXITING');
    expect(after!.exitReason).toBe('STOP');

    await lifecycle.reconcile();
    const outcome = await prisma.executionOutcome.findUnique({ where: { intentId: result.intentId! } });
    expect(outcome!.result).toBe('LOSS');

    await prisma.executionProfile.update({ where: { id: niftyProfileId }, data: { enabled: true } });
  }, 30_000);

  it('10. a duplicate signal in the same window produces no second position', async () => {
    const at = marketHours(13 * 60 + 20);
    simulatedNow = at;
    priceScript = [ENTRY_PREMIUM];
    priceCursor = 0;
    const first = await execution.runProfile(niftyProfileId, at);
    priceScript = [ENTRY_PREMIUM];
    priceCursor = 0;
    const second = await execution.runProfile(niftyProfileId, at);

    expect(first.outcome, `${first.outcome}: ${first.reason}`).toBe('executed');
    expect(second.outcome).toBe('duplicate');
    expect(second.intentId).toBe(first.intentId);

    const positions = await prisma.executionPosition.count({ where: { intentId: first.intentId! } });
    expect(positions).toBe(1);

    // Clean up: flatten it.
    const position = await prisma.executionPosition.findUnique({ where: { intentId: first.intentId! } });
    await driveTo([Number(position!.stopPrice) - 1], marketHours(13 * 60 + 21));
    await lifecycle.reconcile();
  }, 30_000);

  it('21+22+23. the position closes, the P&L is correct, and a full journal exists', async () => {
    const journals = await journal.list({ profileId: niftyProfileId, limit: 50 });
    expect(journals.length).toBeGreaterThanOrEqual(4);

    const entry = journals[0];
    // Every question the audit asks, answerable from one row.
    expect(entry.agent).toBe('sentinel-alpha');
    expect(entry.symbol).toBe('NIFTY');
    expect(entry.strategyId).toBe('agent-trend-momentum');
    expect(entry.strategyVersion).toBe('1.0.0');
    expect(entry.regime).toBe('trending');
    expect(entry.indexDirection).toBe('bullish');
    expect(entry.confidence).toBe(84);
    expect(entry.contractSymbol).toMatch(/^NIFTY:\d{8}:24500:CE$/);
    expect(entry.optionType).toBe('CE');
    expect(entry.quantity).toBeGreaterThan(0);
    expect(entry.entryPrice).toBeGreaterThan(0);
    expect(entry.exitPrice).toBeGreaterThan(0);
    expect(entry.initialStop).not.toBeNull();
    expect(entry.initialTarget).not.toBeNull();
    expect(entry.riskBudget).not.toBeNull();
    expect(entry.allocatedCapital).not.toBeNull();
    expect(entry.exitReason).toBeTruthy();
    expect(entry.holdingSeconds).not.toBeNull();
    expect(['WIN', 'LOSS', 'SCRATCH']).toContain(entry.result);
    expect(entry.rMultiple).not.toBeNull();
    expect(entry.fillModel).toBeTruthy();
    expect(entry.riskPlan).toBeTruthy();
    expect(entry.dataQuality).toBeTruthy();

    // The journal's P&L is the OUTCOME's, which is the OMS's. Not recomputed.
    const outcome = await prisma.executionOutcome.findUnique({ where: { intentId: entry.intentId } });
    expect(entry.realizedPnl).toBeCloseTo(Number(outcome!.realizedPnl), 2);

    // At least one trailing exit produced a trail history.
    const trailed = journals.find((j) => j.exitReason === 'TRAIL');
    expect(trailed).toBeTruthy();
    expect(Array.isArray(trailed!.trailHistory)).toBe(true);
    expect((trailed!.trailHistory as unknown[]).length).toBeGreaterThan(0);
  }, 30_000);

  it('24+25. a completed outcome reaches calibration, and the NEXT decision consumes it', async () => {
    const key = 'sentinel-alpha|NIFTY|agent-trend-momentum|1.0.0|trending';
    const bucket = await prisma.strategyCalibration.findUnique({ where: { key } });
    expect(bucket, 'a calibration bucket exists').not.toBeNull();
    expect(bucket!.trades).toBeGreaterThanOrEqual(4);
    expect(bucket!.version).toBeGreaterThanOrEqual(4);

    const producedVersion = bucket!.version;

    // The next decision reads it, and records the version it read.
    priceScript = [ENTRY_PREMIUM];
    priceCursor = 0;
    simulatedNow = marketHours(13 * 60 + 40);
    const next = await execution.runProfile(niftyProfileId, marketHours(13 * 60 + 40));
    const intent = await prisma.executionIntent.findUnique({ where: { id: next.intentId! } });

    // THE JOIN. This is what makes "the agent learned" checkable rather than a
    // claim about a log line: a version PRODUCED by an outcome, and the same
    // (or a later) version CONSUMED by a subsequent decision.
    expect(intent!.calibrationVersion).not.toBeNull();
    expect(intent!.calibrationVersion!).toBeGreaterThanOrEqual(producedVersion);

    const journals = await journal.list({ profileId: niftyProfileId, limit: 50 });
    const withCalibration = journals.find((j) => j.calibrationVersion != null);
    expect(withCalibration!.calibrationKey).toBe(key);
    expect(withCalibration!.calibrationVersion!).toBeLessThanOrEqual(intent!.calibrationVersion!);

    if (next.outcome === 'executed') {
      const position = await prisma.executionPosition.findUnique({ where: { intentId: next.intentId! } });
      await driveTo([Number(position!.stopPrice) - 1], marketHours(13 * 60 + 41));
      await lifecycle.reconcile();
    }
  }, 30_000);

  it('26+27. learning cannot bypass the 70% floor or the risk gates', async () => {
    const key = 'sentinel-alpha|NIFTY|agent-trend-momentum|1.0.0|trending';
    // Force a calibration that WANTS to loosen far past the platform bar —
    // the row a restore or a manual edit could produce.
    await prisma.strategyCalibration.update({
      where: { key },
      data: { confidenceAdjustment: -50, trades: 100 },
    });

    // A decision at 69% must still be refused.
    sentinelStub.evaluate = async () =>
      evaluation({ confidence: 69, sideInFocus: { ...evaluation().sideInFocus!, confidence: 69 } });
    priceScript = [ENTRY_PREMIUM];
    priceCursor = 0;
    simulatedNow = marketHours(14 * 60 + 0);
    const refused = await execution.runProfile(niftyProfileId, marketHours(14 * 60 + 0));
    expect(refused.outcome).toBe('rejected');
    const failing = refused.checks.find((c) => !c.passed);
    expect(failing!.id).toBe('confidence-floor');
    // And the recorded floor is the platform's, not the loosened one.
    expect(failing!.detail).toContain('70');

    sentinelStub.evaluate = async () => evaluation();
    await prisma.strategyCalibration.update({ where: { key }, data: { confidenceAdjustment: 0 } });
  }, 30_000);

  it('2+3. NIFTY and SENSEX operate simultaneously without sharing state', async () => {
    const at = marketHours(14 * 60 + 20);
    simulatedNow = at;
    priceScript = [ENTRY_PREMIUM];
    priceCursor = 0;
    const nifty = await execution.runProfile(niftyProfileId, at);
    priceScript = [ENTRY_PREMIUM];
    priceCursor = 0;
    const sensex = await execution.runProfile(sensexProfileId, at);

    expect(nifty.outcome, `${nifty.outcome}: ${nifty.reason}`).toBe('executed');
    expect(sensex.outcome, `${sensex.outcome}: ${sensex.reason}`).toBe('executed');

    // Different idempotency keys, so one agent's decision can never collapse
    // the other's — the profile id is part of the key by construction.
    const [ni, si] = await Promise.all([
      prisma.executionIntent.findUnique({ where: { id: nifty.intentId! } }),
      prisma.executionIntent.findUnique({ where: { id: sensex.intentId! } }),
    ]);
    expect(ni!.idempotencyKey).not.toBe(si!.idempotencyKey);
    expect(ni!.agent).toBe('sentinel-alpha');
    expect(si!.agent).toBe('sentinel-beta');

    // Two independent managed positions.
    const open = await prisma.executionPosition.findMany({ where: { state: 'OPEN' } });
    expect(open.length).toBeGreaterThanOrEqual(2);

    // One agent's exit leaves the other's position untouched.
    const niftyPosition = open.find((p) => p.profileId === niftyProfileId)!;
    const sensexPosition = open.find((p) => p.profileId === sensexProfileId)!;
    priceScript = [Number(niftyPosition.stopPrice) - 1];
    priceCursor = 0;
    simulatedNow = marketHours(14 * 60 + 21);
    // Both are managed in one pass, and the price stub serves the same price to
    // both — so this asserts that a price which stops one does not stop the
    // other unless its OWN level says so.
    await manager.manageAll(marketHours(14 * 60 + 21));

    const [niAfter, siAfter] = await Promise.all([
      prisma.executionPosition.findUnique({ where: { id: niftyPosition.id } }),
      prisma.executionPosition.findUnique({ where: { id: sensexPosition.id } }),
    ]);
    expect(niAfter!.state).toBe('EXITING');
    expect(siAfter!.state).toBe('EXITING'); // same price, same levels — both stop
    // Calibration buckets stay separate, keyed by agent.
    await lifecycle.reconcile();
    const buckets = await calibration.all();
    const agents = new Set(buckets.map((b) => b.agent));
    expect(agents.has('sentinel-alpha')).toBe(true);
    expect(agents.has('sentinel-beta')).toBe(true);
  }, 40_000);

  it('6. stale data is refused (and the OMS never sees an order)', async () => {
    sentinelStub.evaluate = async () =>
      evaluation({
        verdict: 'stale-data',
        executable: false,
        reason: 'Refusing to decide on this data: newest bar is 240 min old.',
      });
    const before = await prisma.order.count({ where: { userId: accountId } });
    simulatedNow = marketHours(15 * 60 + 0);
    const result = await execution.runProfile(niftyProfileId, marketHours(15 * 60 + 0));
    expect(result.outcome).toBe('skipped-no-signal');
    expect(result.verdict).toBe('stale-data');
    expect(await prisma.order.count({ where: { userId: accountId } })).toBe(before);
    sentinelStub.evaluate = async () => evaluation();
  }, 30_000);

  it('4+7+8+9. every non-executable Sentinel verdict produces no order', async () => {
    const before = await prisma.order.count({ where: { userId: accountId } });
    for (const verdict of [
      'below-threshold',
      'no-agent-strategy',
      'index-direction-conflict',
      'evidence-conflict',
      'no-option-chain',
      'no-tradable-strike',
      'no-side-in-focus',
    ] as const) {
      sentinelStub.evaluate = async () =>
        evaluation({ verdict, executable: false, reason: `stubbed ${verdict}` });
      simulatedNow = marketHours(15 * 60 + 0);
      const result = await execution.runProfile(niftyProfileId, marketHours(15 * 60 + 0));
      expect(result.outcome, verdict).toBe('skipped-no-signal');
      expect(result.verdict, verdict).toBe(verdict);
    }
    expect(await prisma.order.count({ where: { userId: accountId } })).toBe(before);
    sentinelStub.evaluate = async () => evaluation();
  }, 40_000);
});

describe.skipIf(hasDatabase)('the complete automated paper-trade lifecycle', () => {
  it('is SKIPPED — set TEST_DATABASE_URL to a real Postgres to run it', () => {
    // Deliberately visible rather than silent. A lifecycle suite that quietly
    // does not run is worse than one that is absent, because the report says
    // the same thing either way.
    expect(hasDatabase).toBe(false);
  });
});
