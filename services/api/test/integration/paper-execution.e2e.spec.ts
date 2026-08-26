import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ExecutionAccountService } from '../../src/paper-execution/execution-account.service';
import { ExecutionLifecycleService } from '../../src/paper-execution/execution-lifecycle.service';
import { PaperExecutionService } from '../../src/paper-execution/paper-execution.service';
import type { SentinelExecutionClient, ExecutionEvaluationDto } from '../../src/paper-execution/sentinel-execution.client';
import { SystemExecutionControlService } from '../../src/paper-execution/system-execution-control.service';
import type { MarketPriceService } from '../../src/sim/market-price.service';
import type { OrderService } from '../../src/sim/order.service';

/**
 * End-to-end paper-execution harness against a REAL Postgres.
 *
 * What is real here: the execution loop, the 10-check policy, the idempotency
 * key and its unique-constraint enforcement, every ExecutionIntent /
 * ExecutionOutcome / Order / Trade / Position row, and the whole reconcile /
 * square-off lifecycle. What is faked — and only these — are the two things
 * genuinely external to this feature: Sentinel's decision and the Dhan market
 * feed. The fake OMS writes real Order/Trade/Position rows so the lifecycle
 * reconciles against real SQL, exactly as the production OMS would leave it.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const ist = (s: string) => new Date(`${s}+05:30`);
const ACTIVE = ist('2026-01-29T10:30:00'); // a plain trading Thursday, in session
const AFTER_SQUAREOFF = ist('2026-01-29T15:20:00'); // past the 15:10 default
const HOLIDAY = ist('2026-08-26T10:30:00'); // Ganesh Chaturthi — a real NSE holiday

const ACCOUNT_ID = 'e2e-account';
const PROFILE_NAME = 'e2e-sentinel-alpha-nifty';

let prisma: PrismaService;

/** A deterministic Sentinel verdict. `over` tweaks it per scenario. */
function evaluation(over: Partial<ExecutionEvaluationDto> = {}): ExecutionEvaluationDto {
  const selected = {
    role: 'ATM' as const,
    strike: 23800,
    optionType: 'CE' as const,
    premium: 150,
    openInterest: 1_000_000,
    volume: 50_000,
    impliedVol: 12,
    moneyness: 20,
    tradable: true,
    selected: true,
    reason: 'at-the-money',
    checks: [],
  };
  return {
    verdict: 'executable',
    executable: true,
    reason: 'CE side in focus; 23800 CE selected.',
    runId: 'run-e2e-1',
    symbol: 'NIFTY',
    observedAt: new Date().toISOString(),
    spot: 23820,
    sideInFocus: { side: 'CE', bias: 'bullish', strike: 23800, confidence: 84, rationale: ['ORB long'], optionContext: {} },
    confidence: 84,
    publication: { publish: true },
    strategyId: 'orb',
    strategyName: 'Opening Range Breakout',
    strikes: {
      candidates: [
        { ...selected, role: 'ITM', strike: 23750, selected: false, reason: 'itm' },
        selected,
        { ...selected, role: 'OTM', strike: 23850, selected: false, reason: 'otm' },
      ],
      selected,
      atmStrike: 23800,
      strikeStep: 50,
      unavailableReason: null,
    },
    expiry: '2026-01-29',
    marketSnapshot: {
      marketProfile: { type: 'trending', description: 'trend day' },
      marketState: 'TREND',
      strategyMatches: [],
      risk: { overallRisk: 30, level: 'moderate' },
    },
    ...over,
  };
}

function fakeSentinel(dto: ExecutionEvaluationDto): SentinelExecutionClient {
  return { evaluate: async () => dto } as unknown as SentinelExecutionClient;
}

function fakeMarketPrice(opts: { asOf?: number } = {}): MarketPriceService {
  return {
    async resolveInstrument(symbol: string) {
      return prisma.instrument.upsert({
        where: { symbol },
        create: {
          symbol,
          displayName: symbol,
          type: 'OPTION',
          exchange: 'NSE',
          lotSize: 75,
          tickSize: 0.05,
          underlying: 'NIFTY',
          optionType: symbol.endsWith('CE') ? 'CE' : 'PE',
          strikePrice: 23800,
          expiryDate: new Date('2026-01-29T00:00:00Z'),
        },
        update: {},
      });
    },
    async getPrice() {
      return { ltp: 150, bid: 149.5, ask: 150.5, marketOpen: true, underlyingSpot: 23820, asOf: opts.asOf ?? Date.now() };
    },
  } as unknown as MarketPriceService;
}

/** A minimal OMS that writes REAL Order/Trade/Position rows, so the lifecycle
 *  reconciles against real SQL just as the production OMS would leave it. */
function fakeOrders(opts: { exitPnl?: number } = {}): OrderService {
  return {
    async placeOrder(userId: string, input: Any) {
      const instrument = await prisma.instrument.findUniqueOrThrow({ where: { symbol: input.symbol } });
      const order = await prisma.order.create({
        data: {
          userId,
          instrumentId: instrument.id,
          side: input.side,
          type: input.type,
          productType: input.productType,
          status: 'FILLED',
          quantity: input.quantity,
          filledQuantity: input.quantity,
          avgFillPrice: 150,
          charges: 20,
        },
      });
      await prisma.position.upsert({
        where: { userId_instrumentId_productType: { userId, instrumentId: instrument.id, productType: input.productType } },
        create: { userId, instrumentId: instrument.id, productType: input.productType, quantity: input.quantity, avgPrice: 150 },
        update: { quantity: { increment: input.quantity } },
      });
      await prisma.trade.create({
        data: { orderId: order.id, userId, instrumentId: instrument.id, side: input.side, quantity: input.quantity, fillPrice: 150, charges: 20 },
      });
      return order as Any;
    },
    async exitPosition(userId: string, instrumentId: string, productType: Any) {
      const position = await prisma.position.findUnique({
        where: { userId_instrumentId_productType: { userId, instrumentId, productType } },
      });
      const qty = position?.quantity ?? 75;
      const exit = await prisma.order.create({
        data: { userId, instrumentId, side: 'SELL', type: 'MARKET', productType, status: 'FILLED', quantity: qty, filledQuantity: qty, avgFillPrice: 180, charges: 20 },
      });
      await prisma.trade.create({
        data: { orderId: exit.id, userId, instrumentId, side: 'SELL', quantity: qty, fillPrice: 180, charges: 20, realizedPnl: opts.exitPnl ?? 2230 },
      });
      await prisma.position.update({
        where: { userId_instrumentId_productType: { userId, instrumentId, productType } },
        data: { quantity: 0 },
      });
      return exit as Any;
    },
  } as unknown as OrderService;
}

function makeLoop(sentinelDto: ExecutionEvaluationDto, priceOpts: { asOf?: number } = {}, orderOpts: { exitPnl?: number } = {}) {
  const systemControl = new SystemExecutionControlService(prisma);
  const accounts = new ExecutionAccountService(prisma);
  const orders = fakeOrders(orderOpts);
  const exec = new PaperExecutionService(prisma, fakeSentinel(sentinelDto), orders, fakeMarketPrice(priceOpts), accounts, systemControl);
  const lifecycle = new ExecutionLifecycleService(prisma, orders);
  return { exec, lifecycle, systemControl };
}

async function resetDb() {
  // FK-safe order: rows that reference an intent/order first.
  await prisma.trade.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.executionStrikeCandidate.deleteMany({});
  await prisma.executionOutcome.deleteMany({});
  await prisma.executionIntent.deleteMany({});
  await prisma.position.deleteMany({});
  await prisma.executionProfile.deleteMany({});
  await prisma.paperWallet.deleteMany({});
  await prisma.systemExecutionControl.deleteMany({});
  await prisma.instrument.deleteMany({});
  await prisma.user.deleteMany({ where: { id: ACCOUNT_ID } });
}

async function seed(profileOver: Record<string, unknown> = {}) {
  await prisma.user.create({ data: { id: ACCOUNT_ID, email: 'e2e-machine@paper.local' } }); // no password → machine account
  await prisma.paperWallet.create({ data: { userId: ACCOUNT_ID } });
  const profile = await prisma.executionProfile.create({
    data: {
      name: PROFILE_NAME,
      agent: 'sentinel-alpha',
      symbol: 'NIFTY',
      accountUserId: ACCOUNT_ID,
      accountScope: 'SYSTEM_PAPER',
      environment: 'PAPER',
      enabled: true,
      lots: 1,
      productType: 'NRML',
      orderType: 'MARKET',
      minConfidence: 70,
      maxOpenPositions: 1,
      maxOrdersPerDay: 6,
      maxLossPerDay: 25000,
      squareOffMinute: 910,
      ...profileOver,
    },
  });
  return profile;
}

beforeAll(async () => {
  prisma = new PrismaService();
  await prisma.$connect();
});

afterAll(async () => {
  await resetDb().catch(() => undefined);
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
});

describe('paper-execution e2e — the full lifecycle', () => {
  it('executes a valid signal end to end: intent → order → fill → outcome, then square-off → CLOSED', async () => {
    const profile = await seed();
    const { exec, lifecycle } = makeLoop(evaluation());

    // ---- entry ----
    const run = await exec.runProfile(profile.id, ACTIVE);
    expect(run.outcome).toBe('executed');

    const intent = await prisma.executionIntent.findFirstOrThrow({ where: { profileId: profile.id } });
    expect(intent.status).toBe('FILLED');
    expect(intent.contractSymbol).toBe('NIFTY:20260129:23800:CE');
    expect(intent.confidence).toBe(84);
    expect(intent.sentinelRunId).toBe('run-e2e-1');

    // All three candidates persisted, the ATM one selected.
    const candidates = await prisma.executionStrikeCandidate.findMany({ where: { intentId: intent.id } });
    expect(candidates).toHaveLength(3);
    expect(candidates.filter((c) => c.selected)).toHaveLength(1);

    // Order linked, entry outcome opened.
    const order = await prisma.order.findFirstOrThrow({ where: { executionIntentId: intent.id } });
    expect(order.status).toBe('FILLED');
    const openOutcome = await prisma.executionOutcome.findUniqueOrThrow({ where: { intentId: intent.id } });
    expect(openOutcome.result).toBe('OPEN');

    // Position is open.
    const pos = await prisma.position.findFirstOrThrow({ where: { userId: ACCOUNT_ID } });
    expect(pos.quantity).toBe(75);

    // ---- square-off + reconcile ----
    const squared = await lifecycle.squareOff(AFTER_SQUAREOFF);
    expect(squared.exited).toBe(1);
    const recon = await lifecycle.reconcile();
    expect(recon.closed).toBe(1);

    const closed = await prisma.executionOutcome.findUniqueOrThrow({ where: { intentId: intent.id } });
    expect(closed.result).toBe('WIN'); // exit +2230
    expect(Number(closed.realizedPnl)).toBe(2230);
    expect(closed.exitReason).toBe('SQUARE_OFF');
    const closedIntent = await prisma.executionIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(closedIntent.status).toBe('CLOSED');
  });

  it('is idempotent: the same decision twice yields ONE intent and ONE order', async () => {
    const profile = await seed();
    const { exec } = makeLoop(evaluation());

    const first = await exec.runProfile(profile.id, ACTIVE);
    const second = await exec.runProfile(profile.id, ACTIVE); // same clock → same idempotency key

    expect(first.outcome).toBe('executed');
    expect(second.outcome).toBe('duplicate');
    expect(await prisma.executionIntent.count({ where: { profileId: profile.id } })).toBe(1);
    expect(await prisma.order.count({ where: { executionIntentId: { not: null } } })).toBe(1);
  });
});

describe('paper-execution e2e — the rejection matrix (NO TRADE, with a recorded reason)', () => {
  it('no signal → skipped, nothing recorded', async () => {
    const profile = await seed();
    const { exec } = makeLoop(evaluation({ executable: false, verdict: 'no-side-in-focus', reason: 'Sentinel stayed silent.', strikes: { candidates: [], selected: null, atmStrike: null, strikeStep: null, unavailableReason: null }, expiry: null, sideInFocus: null }));
    const run = await exec.runProfile(profile.id, ACTIVE);
    expect(run.outcome).toBe('skipped-no-signal');
    expect(await prisma.executionIntent.count({ where: { profileId: profile.id } })).toBe(0);
  });

  it('below the profile confidence floor → REJECTED intent, no order', async () => {
    const profile = await seed({ minConfidence: 95 });
    const { exec } = makeLoop(evaluation()); // confidence 84 < 95
    const run = await exec.runProfile(profile.id, ACTIVE);
    expect(run.outcome).toBe('rejected');
    const intent = await prisma.executionIntent.findFirstOrThrow({ where: { profileId: profile.id } });
    expect(intent.status).toBe('REJECTED');
    expect(intent.rejectCheckId).toBe('confidence-floor');
    expect(await prisma.order.count()).toBe(0);
  });

  it('stale market data → REJECTED intent under fresh-market-data, no order', async () => {
    const profile = await seed();
    // Price tick is 10 minutes old, well past the 20s freshness limit.
    const { exec } = makeLoop(evaluation(), { asOf: ACTIVE.getTime() - 10 * 60_000 });
    const run = await exec.runProfile(profile.id, ACTIVE);
    expect(run.outcome).toBe('rejected');
    const intent = await prisma.executionIntent.findFirstOrThrow({ where: { profileId: profile.id } });
    expect(intent.rejectCheckId).toBe('fresh-market-data');
    expect(await prisma.order.count()).toBe(0);
  });

  it('on an NSE holiday → skipped-market-closed, nothing recorded', async () => {
    const profile = await seed();
    const { exec } = makeLoop(evaluation());
    const run = await exec.runProfile(profile.id, HOLIDAY);
    expect(run.outcome).toBe('skipped-market-closed');
    expect(run.reason).toContain('holiday');
    expect(await prisma.executionIntent.count({ where: { profileId: profile.id } })).toBe(0);
  });

  it('global kill switch OFF → skipped-halted before any Sentinel/account read', async () => {
    const profile = await seed();
    const { exec, systemControl } = makeLoop(evaluation());
    await systemControl.setMode('OFF', 'e2e-operator', 'halt for the test');
    const run = await exec.runProfile(profile.id, ACTIVE);
    expect(run.outcome).toBe('skipped-halted');
    expect(await prisma.executionIntent.count({ where: { profileId: profile.id } })).toBe(0);
  });

  it('EMERGENCY_STOP flattens an open position immediately, ignoring the square-off minute', async () => {
    const profile = await seed();
    const { exec, lifecycle, systemControl } = makeLoop(evaluation());

    // Open a position while ON, mid-session (well before the 15:10 square-off).
    expect((await exec.runProfile(profile.id, ACTIVE)).outcome).toBe('executed');
    expect((await prisma.position.findFirstOrThrow({ where: { userId: ACCOUNT_ID } })).quantity).toBe(75);

    // Emergency stop: force square-off now, at the same mid-session minute.
    await systemControl.setMode('EMERGENCY_STOP', 'e2e-operator', 'flatten now');
    const squared = await lifecycle.squareOff(ACTIVE, { forceAll: true });
    expect(squared.exited).toBe(1);
    await lifecycle.reconcile();
    const closed = await prisma.executionOutcome.findFirstOrThrow({ where: {} });
    expect(closed.result).toBe('WIN');
  });
});

describe('paper-execution e2e — restart recovery', () => {
  it('fails out a PROPOSED intent orphaned by a crash mid-submit', async () => {
    const profile = await seed();
    const { lifecycle } = makeLoop(evaluation());

    // Simulate the crash window: an intent claimed (PROPOSED) but no order ever
    // placed, older than the staleness floor.
    await prisma.executionIntent.create({
      data: {
        profileId: profile.id,
        idempotencyKey: 'orphan-key-1',
        status: 'PROPOSED',
        environment: 'PAPER',
        agent: 'sentinel-alpha',
        symbol: 'NIFTY',
        side: 'BUY',
        optionType: 'CE',
        bias: 'bullish',
        strike: 23800,
        expiry: new Date('2026-01-29T00:00:00Z'),
        contractSymbol: 'NIFTY:20260129:23800:CE',
        lots: 1,
        quantity: 75,
        productType: 'NRML',
        orderType: 'MARKET',
        confidence: 84,
        decidedAt: new Date(Date.now() - 5 * 60_000), // 5 minutes ago
      },
    });

    const recovered = await lifecycle.recoverStuckIntents();
    expect(recovered).toBe(1);
    const intent = await prisma.executionIntent.findUniqueOrThrow({ where: { idempotencyKey: 'orphan-key-1' } });
    expect(intent.status).toBe('FAILED');
    expect(intent.rejectCheckId).toBe('recovery-orphaned');
  });
});
