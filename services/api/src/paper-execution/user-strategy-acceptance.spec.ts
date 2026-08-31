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
import { SentinelExecutionClient, type UserStrategyEvaluationDto } from './sentinel-execution.client';
import { UserStrategyAgentService, hashStrategyRules } from './user-strategy-agent.service';

/**
 * PHASE 6/7 ACCEPTANCE — an armed user strategy paper-trades itself.
 *
 * The feature's definition of success is one sentence: after a single arming
 * act, the agent creates and manages paper trades with no human triggering
 * individual entries. This file is where that is demonstrated rather than
 * asserted, against a real Postgres and the real order path.
 *
 * ## What is real, and what is stubbed
 *
 * REAL: the schema, `UserStrategyAgentService`, `PaperExecutionService`,
 * `OrderService` (margin, charges, fills, P&L), the risk planner, the policy
 * gates, `PositionManagerService`, the decision table and its unique
 * constraint — every production class, against a real database.
 *
 * STUBBED: two network boundaries.
 *   · `SentinelExecutionClient.evaluateUserStrategy` — the api→sentinel hop.
 *     What Sentinel ANSWERS is proven in
 *     `services/sentinel/src/user-strategy/replay-parity.spec.ts`, where the
 *     TypeScript conditions are checked bar-for-bar against the real Python
 *     engine over 1,865 verdicts. Re-deriving that here would test the same
 *     thing twice and this file's subject not at all.
 *   · `MarketPriceService` — the Dhan bridge, so prices are deterministic.
 *
 * The division is deliberate: the parity suite proves the agent decides the
 * SAME THING a person's watcher would; this suite proves it then ACTS on that
 * decision autonomously, exactly once, and stops when told to.
 *
 *     TEST_DATABASE_URL=postgresql://… npx vitest run src/paper-execution/user-strategy-acceptance.spec.ts
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const hasDatabase = DATABASE_URL.length > 0;

const LOT_SIZE = 75;
const PROFILE_NAME = 'acceptance-user-strategy';
const ENTRY_PREMIUM = 120.0;

let priceScript: number[] = [ENTRY_PREMIUM];
let priceCursor = 0;
let marketOpenFlag = true;
/** The clock the stubs answer against, moved by each scenario. */
let simulatedNow = new Date();
function nextPrice(): number {
  const p = priceScript[Math.min(priceCursor, priceScript.length - 1)];
  priceCursor += 1;
  return p;
}

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
    // The real shape: `quotedAt`, not an age. A stub returning the wrong keys
    // makes the freshness gate refuse every entry with "no tick timestamp",
    // which is the gate working correctly on a malformed feed.
    return { quotedAt: new Date(simulatedNow.getTime() - 800), marketOpen: marketOpenFlag, instruments: 4 };
  }
}

/** The strategy in the user's own workspace: ema7_bullish_reclaim, 5m, long. */
const EMA7_RULES = {
  timeframe: '5m',
  levels: ['ema7'],
  rules: [
    { id: 'rule_trend', name: 'price_above_ema7', condition: 'price_above_ema7', mandatory: true },
    { id: 'rule_ema_slope', name: 'ema7_rising', condition: 'ema7_rising', mandatory: true },
    { id: 'rule_reclaim', name: 'ema7_body_reclaim', condition: 'ema7_body_reclaim', mandatory: true },
    { id: 'rule_follow', name: 'reclaim_follow_through', condition: 'reclaim_retest_or_consolidation', mandatory: true },
    { id: 'rule_vol', name: 'volume_confirm', condition: 'volume_above_20_period_avg', mandatory: false },
  ],
  entry: { long: 'after_reclaim_follow_through', short: null },
  riskManagement: { stopLoss: 'below the reclaim candle low', targets: [] },
};

const CONDITIONS_MET = EMA7_RULES.rules.map((r) => ({
  ruleId: r.id,
  label: r.name,
  condition: r.condition,
  mandatory: r.mandatory,
  met: true,
  indeterminate: false,
  detail: `${r.condition} satisfied`,
}));

const CERT_TRADABLE = {
  status: 'TRADABLE' as const,
  summary: 'All 5 conditions are supported on 5m. Eligible for autonomous paper trading.',
  interval: '5m',
  direction: 'long' as const,
  minBars: 21,
  blockers: [],
  declaredConditions: EMA7_RULES.rules.map((r) => r.condition),
};

function entryDto(barTime: Date, expiry: string): UserStrategyEvaluationDto {
  return {
    certification: CERT_TRADABLE,
    contract: { strike: 24_500, optionType: 'CE', expiry, premium: ENTRY_PREMIUM, role: 'ATM' },
    strikes: {
      candidates: [],
      selected: { role: 'ATM', strike: 24_500, optionType: 'CE', premium: ENTRY_PREMIUM, selected: true } as never,
      atmStrike: 24_500,
      strikeStep: 50,
      unavailableReason: null,
    },
    evaluation: {
      verdict: 'entry',
      refusal: null,
      reason: `Every required condition is met on the 5m bar closing ${barTime.toISOString()}.`,
      barTime: barTime.toISOString(),
      interval: '5m',
      direction: 'long',
      conditions: CONDITIONS_MET,
      waitingOn: [],
    },
    barsRead: 60,
  };
}

function waitingDto(barTime: Date): UserStrategyEvaluationDto {
  return {
    certification: CERT_TRADABLE,
    contract: null,
    strikes: null,
    evaluation: {
      verdict: 'waiting',
      refusal: null,
      reason: '1 of 4 required conditions not met — ema7_body_reclaim: no candle body has reached EMA-7.',
      barTime: barTime.toISOString(),
      interval: '5m',
      direction: 'long',
      conditions: CONDITIONS_MET.map((c) =>
        c.condition === 'ema7_body_reclaim' ? { ...c, met: false, detail: 'no reclaim' } : c,
      ),
      waitingOn: ['ema7_body_reclaim'],
    },
    barsRead: 60,
  };
}

describe.skipIf(!hasDatabase)('ACCEPTANCE — an armed user strategy paper-trades itself', () => {
  let prisma: PrismaService;
  let agent: UserStrategyAgentService;
  let execution: PaperExecutionService;
  let manager: PositionManagerService;
  let orders: OrderService;
  let stubResponse: UserStrategyEvaluationDto;
  let sentinelStub: { evaluateUserStrategy: () => Promise<UserStrategyEvaluationDto> };

  let profileId = '';
  let strategyId = '';
  let accountId = '';
  let expiryStr = '';

  function marketHours(minute = 11 * 60 + 2): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7)); // next Monday
    const utcMinutes = minute - 330;
    d.setUTCHours(Math.floor(utcMinutes / 60), utcMinutes % 60, 0, 0);
    return d;
  }
  /** A distinct 5m bar timestamp per scenario, so none shares an idempotency key. */
  const barAt = (minute: number) => new Date(marketHours(minute).getTime());
  /** `now` for a pass, keeping the stubbed feed clock in step with it. */
  function at(minute: number): Date {
    simulatedNow = marketHours(minute);
    return simulatedNow;
  }

  async function cleanup() {
    const profiles = await prisma.executionProfile.findMany({
      where: { name: PROFILE_NAME },
      select: { id: true, accountUserId: true },
    });
    const ids = profiles.map((p) => p.id);
    const users = [...new Set(profiles.map((p) => p.accountUserId))];
    if (ids.length) {
      await prisma.strategyAgentDecision.deleteMany({ where: { profileId: { in: ids } } });
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
      await prisma.userStrategy.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }

  /** Re-arm the profile to a clean, LIVE, enabled state between scenarios. */
  async function arm(mode: 'SHADOW' | 'LIVE') {
    await prisma.executionProfile.update({
      where: { id: profileId },
      data: {
        enabled: true,
        agentMode: mode,
        certificationStatus: 'TRADABLE',
        certifiedAt: new Date(),
        strategyTimeframe: '5m',
        strategyRulesHash: hashStrategyRules(EMA7_RULES),
      },
    });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.DISCIPLINE_OVERRIDE_SECRET ??= 'acceptance-spec-secret-not-a-real-one';

    prisma = new PrismaService();
    await prisma.$connect();

    const marketPrice = new StubMarketPrice() as unknown as MarketPriceService;
    const discipline = new DisciplineService(prisma);
    orders = new OrderService(prisma, marketPrice, discipline);
    const accounts = new ExecutionAccountService(prisma);
    const calibration = new ExecutionCalibrationService(prisma);
    const journal = new ExecutionJournalService(prisma, calibration);
    // Constructed even though this suite drives entries: the position manager
    // is what proves a disarmed agent's open position is still managed.
    manager = new PositionManagerService(prisma, orders, marketPrice);
    void new ExecutionLifecycleService(prisma, orders, journal);

    sentinelStub = { evaluateUserStrategy: async () => stubResponse };
    execution = new PaperExecutionService(
      prisma,
      sentinelStub as unknown as SentinelExecutionClient,
      orders,
      marketPrice,
      accounts,
      manager,
      calibration,
    );
    agent = new UserStrategyAgentService(
      prisma,
      sentinelStub as unknown as SentinelExecutionClient,
      execution,
    );

    await cleanup();

    const account = await prisma.user.create({
      data: { email: `acceptance-${Date.now()}@agents.tradew.local`, country: 'IN' },
    });
    accountId = account.id;

    const strategy = await prisma.userStrategy.create({
      data: { userId: accountId, name: 'EMA-7 Bullish Reclaim', rules: EMA7_RULES, inputType: 'text', status: 'active' },
    });
    strategyId = strategy.id;

    const expiry = new Date(marketHours());
    expiry.setUTCDate(expiry.getUTCDate() + 3);
    expiryStr = expiry.toISOString();

    const profile = await prisma.executionProfile.create({
      data: {
        name: PROFILE_NAME,
        agent: 'user-strategy-agent',
        symbol: 'NIFTY',
        accountUserId: accountId,
        accountScope: 'SYSTEM_PAPER',
        enabled: true,
        userStrategyId: strategyId,
        agentMode: 'SHADOW',
        lots: 1,
        minConfidence: 70,
        maxOpenPositions: 2,
        maxOrdersPerDay: 60,
        maxLossPerDay: 10_000_000,
        capitalAllocationPct: 20,
        riskPerTradePct: 3,
        rewardPerTradePct: 9,
        trailStepPoints: 3,
      },
    });
    profileId = profile.id;
    await arm('SHADOW');
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma?.$disconnect();
  });

  // ── 2, 3, 16: an unsupported strategy is WATCH-ONLY ────────────────────
  it('refuses to trade an uncertified strategy, and records nothing', async () => {
    stubResponse = {
      certification: {
        status: 'WATCH_ONLY',
        summary: 'Watch-only: 1 blocker — zone_present.',
        interval: '5m',
        direction: 'long',
        minBars: 21,
        blockers: [{ code: 'deferred-condition', condition: 'zone_present', detail: 'The zone model is not implemented.' }],
        declaredConditions: ['zone_present'],
      },
      contract: null,
      strikes: null,
      evaluation: {
        verdict: 'refused',
        refusal: 'not-certified',
        reason: 'Watch-only: 1 blocker — zone_present.',
        barTime: null,
        interval: '5m',
        direction: 'long',
        conditions: [],
        waitingOn: [],
      },
      barsRead: 0,
    };
    await arm('LIVE');

    const result = await agent.runProfile(profileId, at(11 * 60 + 2));
    expect(result.outcome).toBe('not-certified');

    // No decision row, and no order: an uncertified strategy is not "watched",
    // it is refused before anything happens.
    expect(await prisma.strategyAgentDecision.count({ where: { profileId } })).toBe(0);
    expect(await prisma.executionIntent.count({ where: { profileId } })).toBe(0);
  });

  // ── 5, 19: SHADOW records what it WOULD have done ──────────────────────
  it('SHADOW mode records a would-have-traded entry and creates no position', async () => {
    await arm('SHADOW');
    const bar = barAt(11 * 60 + 5);
    stubResponse = entryDto(bar, expiryStr);

    const result = await agent.runProfile(profileId, at(11 * 60 + 7));
    expect(result.outcome).toBe('shadow-entry');

    const decision = await prisma.strategyAgentDecision.findFirst({ where: { profileId, barTime: bar } });
    expect(decision).not.toBeNull();
    expect(decision!.verdict).toBe('entry');
    expect(decision!.mode).toBe('SHADOW');
    // The signature of a shadow entry: an entry verdict with NO intent.
    expect(decision!.intentId).toBeNull();
    expect(await prisma.executionIntent.count({ where: { profileId } })).toBe(0);
    expect(await prisma.order.count({ where: { userId: accountId } })).toBe(0);
  });

  // ── 4, 8, 9, 10, 12: LIVE trades with no human trigger ─────────────────
  it('LIVE mode creates a PAPER order automatically, with platform sizing and levels', async () => {
    await arm('LIVE');
    priceScript = [ENTRY_PREMIUM];
    priceCursor = 0;
    const bar = barAt(11 * 60 + 15);
    stubResponse = entryDto(bar, expiryStr);

    // The ONLY call. No confirmation step, no approval, no second act.
    const result = await agent.runProfile(profileId, at(11 * 60 + 17));
    expect(result.outcome, result.reason).toBe('entered');
    expect(result.intentId).toBeTruthy();

    const intent = await prisma.executionIntent.findUnique({ where: { id: result.intentId! } });
    expect(intent).not.toBeNull();
    expect(intent!.status).toBe('FILLED');

    // The platform decided size, stop and target — not the user's free text.
    expect(Number(intent!.stopPrice)).toBeGreaterThan(0);
    expect(Number(intent!.targetPrice)).toBeGreaterThan(Number(intent!.plannedEntryPrice));
    expect(intent!.quantity % LOT_SIZE).toBe(0);

    // A real order, through the same OMS a human uses.
    const order = await prisma.order.findFirst({ where: { executionIntentId: intent!.id } });
    expect(order).not.toBeNull();
    expect(order!.side).toBe('BUY');

    // And a monitored position.
    const position = await prisma.executionPosition.findUnique({ where: { intentId: intent!.id } });
    expect(position).not.toBeNull();
    expect(position!.state).toBe('OPEN');

    // The decision is linked to the intent it produced.
    const decision = await prisma.strategyAgentDecision.findFirst({ where: { profileId, barTime: bar } });
    expect(decision!.intentId).toBe(intent!.id);
    expect(decision!.mode).toBe('LIVE');
  });

  // ── 13: one entry per bar, however often it is polled ──────────────────
  it('cannot enter twice for the same bar', async () => {
    const before = await prisma.executionIntent.count({ where: { profileId } });
    const bar = barAt(11 * 60 + 15); // the SAME bar as the previous scenario
    stubResponse = entryDto(bar, expiryStr);

    for (let i = 0; i < 4; i++) {
      const again = await agent.runProfile(profileId, marketHours(11 * 60 + 18 + i));
      expect(again.outcome).toBe('duplicate');
    }

    expect(await prisma.executionIntent.count({ where: { profileId } })).toBe(before);
    expect(await prisma.strategyAgentDecision.count({ where: { profileId, barTime: bar } })).toBe(1);
  });

  // ── 17: a restart does not duplicate or skip ───────────────────────────
  it('recovers deterministically after a restart', async () => {
    const before = await prisma.executionIntent.count({ where: { profileId } });

    // A brand-new service instance: nothing in memory survives. The resume
    // point comes from the decision table alone.
    const fresh = new UserStrategyAgentService(
      prisma,
      sentinelStub as unknown as SentinelExecutionClient,
      execution,
    );
    stubResponse = entryDto(barAt(11 * 60 + 15), expiryStr);
    const result = await fresh.runProfile(profileId, at(11 * 60 + 25));

    expect(result.outcome).toBe('duplicate');
    expect(await prisma.executionIntent.count({ where: { profileId } })).toBe(before);
  });

  // ── 8 (negative): waiting is recorded, and trades nothing ──────────────
  it('records a waiting pass without trading', async () => {
    const before = await prisma.executionIntent.count({ where: { profileId } });
    const bar = barAt(11 * 60 + 30);
    stubResponse = waitingDto(bar);

    const result = await agent.runProfile(profileId, at(11 * 60 + 32));
    expect(result.outcome).toBe('waiting');

    const decision = await prisma.strategyAgentDecision.findFirst({ where: { profileId, barTime: bar } });
    expect(decision!.verdict).toBe('waiting');
    expect(decision!.intentId).toBeNull();
    expect(await prisma.executionIntent.count({ where: { profileId } })).toBe(before);

    // ── 18: the decision is auditable — every condition, met or not.
    const conditions = decision!.conditions as unknown as { condition: string; met: boolean }[];
    expect(conditions).toHaveLength(5);
    expect(conditions.find((c) => c.condition === 'ema7_body_reclaim')!.met).toBe(false);
    expect(decision!.reason).toContain('ema7_body_reclaim');
  });

  // ── 14: disarm stops NEW entries and does NOT orphan the open position ──
  it('disarming stops new entries while the open position stays managed', async () => {
    const openBefore = await prisma.executionPosition.count({ where: { state: 'OPEN', profileId } });
    expect(openBefore).toBeGreaterThan(0);

    await prisma.executionProfile.update({ where: { id: profileId }, data: { enabled: false } });

    stubResponse = entryDto(barAt(11 * 60 + 40), expiryStr);
    const results = await agent.runAll(at(11 * 60 + 42));
    // `runAll` selects on `enabled`, so a disarmed profile is not evaluated.
    expect(results.find((r) => r.profileId === profileId)).toBeUndefined();
    expect(await prisma.strategyAgentDecision.count({ where: { profileId, barTime: barAt(11 * 60 + 40) } })).toBe(0);

    // But the position manager still holds it: it selects on position state,
    // never on profile.enabled.
    priceScript = [ENTRY_PREMIUM * 1.02];
    priceCursor = 0;
    const summary = await manager.manageAll(at(11 * 60 + 43));
    expect(summary.evaluated).toBeGreaterThan(0);
    expect(await prisma.executionPosition.count({ where: { state: 'OPEN', profileId } })).toBe(openBefore);
  });

  // ── 15: editing an armed strategy disarms it ───────────────────────────
  it('editing the bound strategy auto-disarms the agent and preserves the position', async () => {
    await arm('LIVE');
    const openBefore = await prisma.executionPosition.count({ where: { state: 'OPEN', profileId } });

    // The user edits their strategy — as sentinel-py would, straight into the
    // row, with nothing telling services/api about it.
    await prisma.userStrategy.update({
      where: { id: strategyId },
      data: { rules: { ...EMA7_RULES, timeframe: '15m' } },
    });

    stubResponse = entryDto(barAt(11 * 60 + 50), expiryStr);
    const result = await agent.runProfile(profileId, at(11 * 60 + 52));

    expect(result.outcome).toBe('disarmed-edited');
    const profile = await prisma.executionProfile.findUnique({ where: { id: profileId } });
    expect(profile!.enabled).toBe(false);
    expect(profile!.certificationStatus).toBe('EDITED');

    // No entry from the edited version...
    expect(await prisma.strategyAgentDecision.count({ where: { profileId, barTime: barAt(11 * 60 + 50) } })).toBe(0);
    // ...and the position it already holds is untouched.
    expect(await prisma.executionPosition.count({ where: { state: 'OPEN', profileId } })).toBe(openBefore);

    // The disarm is audited, not silent.
    const audit = await prisma.auditEvent.findFirst({
      where: { eventType: 'execution.profile.disarmed.strategy-edited' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
  });

  // ── 11: no Python-originated signal places a trade ─────────────────────
  it('places nothing on its own when Sentinel is unreachable', async () => {
    await prisma.userStrategy.update({ where: { id: strategyId }, data: { rules: EMA7_RULES } });
    await arm('LIVE');
    const before = await prisma.executionIntent.count({ where: { profileId } });

    const failing = new UserStrategyAgentService(
      { ...prisma, } as unknown as PrismaService,
      { evaluateUserStrategy: async () => { throw new Error('sentinel down'); } } as unknown as SentinelExecutionClient,
      execution,
    );
    const result = await failing.runProfile(profileId, marketHours(12 * 60));

    // An outage is a SKIP, never "no setup" and never a trade.
    expect(result.outcome).toBe('error');
    expect(result.reason).toContain('Sentinel unavailable');
    expect(await prisma.executionIntent.count({ where: { profileId } })).toBe(before);
  });
});

describe.skipIf(hasDatabase)('ACCEPTANCE — an armed user strategy paper-trades itself', () => {
  it('is SKIPPED — set TEST_DATABASE_URL to a real Postgres to run it', () => {
    expect(hasDatabase).toBe(false);
  });
});
