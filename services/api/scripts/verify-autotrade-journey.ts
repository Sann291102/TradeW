/**
 * The Sentinel AutoTrade user journey, driven over REAL HTTP.
 *
 *   npx ts-node --transpile-only -P tsconfig.json scripts/verify-autotrade-journey.ts
 *   … --keep    (leave the scratch account and profile in place)
 *
 * ## What this proves that the unit and integration suites do not
 *
 * `execution-integration.spec.ts` constructs the services directly. That is the
 * right shape for asserting a database constraint, and it skips four things
 * that have historically been where this feature broke:
 *
 *   · Nest DI. A provider missing from a module's `exports` compiles, passes
 *     every unit test, and takes the whole API down at boot — it happened on
 *     2026-08-18 with `ExecutionProfileService`, and only starting the process
 *     catches it.
 *   · The GUARDS. §14 is a claim about what an unauthenticated or unentitled
 *     HTTP request receives, and a service call cannot make that claim.
 *   · Route wiring. §18: "Do not leave UI buttons calling nonexistent/mock
 *     endpoints."
 *   · The admin/user surface split — that a user cannot reach an arming route
 *     and an operator cannot flip a user's own AutoTrade switch.
 *
 * So this boots the real `AppModule`, listens on a real port, and sends real
 * requests with real bearer tokens through the real guards.
 *
 * ## The two substitutions, and why they are not the interesting part
 *
 * `SentinelExecutionClient` and `MarketPriceService` are overridden, because
 * both are outbound network calls to services that are not running here: the
 * Sentinel container and the Dhan live-feed bridge (which additionally needs a
 * real brokerage credential). Sentinel's verdict is an INPUT to the code under
 * test, and a live option chain would make every assertion below depend on the
 * market being open.
 *
 * Everything else is production code writing production rows: the entitlement
 * gate, the state machine, the risk policy, the paper OMS, the wallet, the
 * position, the trace, and every read model the two consoles render.
 *
 * `scripts/verify-paper-execution.ts` is the complement to this one — it keeps
 * the live market-data path and substitutes only Sentinel. Run that one against
 * a deployment with the feed bridge up.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(__dirname, '../../../.env') });

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { MarketPriceService } from '../src/sim/market-price.service';
import { SentinelExecutionClient, type ExecutionEvaluationDto } from '../src/paper-execution/sentinel-execution.client';
import { isTradingDay } from '../src/discipline/market-calendar';
import { PrismaClient } from '@prisma/client';

const SCRATCH = 'autotrade-journey';
const KEEP = process.argv.includes('--keep');

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? `  ${detail}` : ''}`);
  }
}

function section(title: string) {
  console.log(`\n\x1b[1m=== ${title} ===\x1b[0m`);
}

async function main() {
  // ------------------------------------------------------------ 0. Boot
  section('0. Boot the real application');

  // The loop's timers are the one thing that must NOT start: this script drives
  // passes explicitly, and a background tick racing them would make the
  // idempotency assertions non-deterministic. Set before the module loads,
  // because `ExecutionSchedulerService` reads it in `onModuleInit`.
  process.env.PAPER_EXECUTION_ENABLED = 'false';
  // Live stays off, which is also the default. Stated so the live refusal below
  // is a refusal by the STATE, not merely by a missing deployment flag.
  process.env.LIVE_EXECUTION_ENABLED = 'false';

  const CONTRACT = `NIFTY:20260827:24900:CE:journey-${Math.random().toString(36).slice(2, 8)}`;
  // A client of its own for the stub, so the override can be constructed before
  // the container that provides `PrismaService` exists.
  const stubPrisma = new PrismaClient();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SentinelExecutionClient)
    .useValue({ evaluate: async () => decision })
    .overrideProvider(MarketPriceService)
    .useValue(stubMarketPrice(stubPrisma as unknown as PrismaService, CONTRACT))
    .compile();

  const app: INestApplication = moduleRef.createNestApplication();
  // The same pipe `main.ts` installs, so DTO validation behaves as in production.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  await app.listen(0);
  const base = await app.getUrl().then((u) => u.replace('[::1]', '127.0.0.1'));
  check('the whole application boots with the execution module wired', true, base);

  const prisma = moduleRef.get(PrismaService);
  const jwt = moduleRef.get(JwtService);

  // ------------------------------------------------------- 1. The accounts
  section('1. A Sentinel Premium account, and an administrator');
  const suffix = Math.random().toString(36).slice(2, 8);

  const trader = await prisma.user.create({
    data: {
      email: `${SCRATCH}-trader-${suffix}@tradew.test`,
      // A real sign-in credential, so this is a genuine user account and the
      // profile must take the STRICTER USER_PAPER path — consent and all.
      passwordHash: 'scrypt$verification-only$not-a-real-hash',
      country: 'IN',
      paperWallet: { create: { startingBalance: 1_000_000, cashBalance: 1_000_000 } },
    },
  });
  const operator = await prisma.user.create({
    data: { email: `${SCRATCH}-admin-${suffix}@tradew.test`, passwordHash: 'x', isAdmin: true, country: 'IN' },
  });

  // Sentinel Premium, granted the ordinary way — a real subscription to a real
  // plan. Not an override and not a short-circuit: §20 forbids faking the
  // entitlement that gates the whole feature.
  const plan = await prisma.plan.findFirst({ where: { grants: { some: { capability: 'sentinel' } } } });
  if (!plan) throw new Error('No plan grants `sentinel`. Run the database seed first.');
  await prisma.subscription.create({
    data: { userId: trader.id, planId: plan.id, status: 'ACTIVE', expiresAt: new Date(Date.now() + 30 * 864e5) },
  });
  check('the trader holds Sentinel Premium through a real subscription', true, plan.code);

  const traderToken = jwt.sign({ sub: trader.id, email: trader.email });
  const adminToken = jwt.sign({ sub: operator.id, email: operator.email });
  const operatorSecret = process.env.ADMIN_API_TOKEN ?? '';
  if (!operatorSecret) throw new Error('ADMIN_API_TOKEN is not set; the admin surface cannot be exercised.');

  const asTrader = (path: string, init: RequestInit = {}) =>
    request(`${base}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${traderToken}` } });
  const asAdmin = (path: string, init: RequestInit = {}) =>
    request(`${base}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${adminToken}`,
        'x-admin-token': operatorSecret,
      },
    });

  // -------------------------------------------- 2. Before anyone is armed
  section('2. Before an administrator arms anything');

  const anonymous = await request(`${base}/autotrade/status`);
  check('an unauthenticated caller is refused outright', anonymous.status === 401, `HTTP ${anonymous.status}`);

  let status = (await asTrader('/autotrade/status')).body as AutoTradeStatusBody;
  check('a Premium user with no profile sees nothing', status.visible === false, `visible=${status.visible}`);
  check('and is told which condition failed', status.failedCheckId === 'profile-exists', String(status.failedCheckId));

  // The profile, created through the ADMIN endpoint — the workflow §14
  // describes, not a direct row write.
  await asAdmin(`/admin/execution/accounts/${trader.id}/agent-trading`, {
    method: 'POST',
    body: JSON.stringify({ enabled: true }),
  });
  const created = await asAdmin('/admin/execution/profiles', {
    method: 'POST',
    body: JSON.stringify({
      name: `${SCRATCH}-${suffix}`,
      agent: 'sentinel-alpha',
      symbol: 'NIFTY',
      accountUserId: trader.id,
      accountScope: 'USER_PAPER',
      lots: 1,
    }),
  });
  check('an operator can create and bind a profile', created.status === 201 || created.status === 200, `HTTP ${created.status}`);
  const profileId = (created.body as { id: string }).id;

  status = (await asTrader('/autotrade/status')).body as AutoTradeStatusBody;
  check('an UNARMED profile still shows the user nothing', status.visible === false, `state=${status.state}`);
  check('the refusal names the administrator, not the user', status.failedCheckId === 'admin-armed', String(status.reason));

  // §14's central claim: hiding the control is not the boundary.
  const forbidden = await asTrader('/autotrade/enabled', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  check(
    'activating AutoTrade over the API is REJECTED while unarmed',
    forbidden.status === 403,
    `HTTP ${forbidden.status} — ${(forbidden.body as { message?: string }).message ?? ''}`,
  );

  // A pass on an unarmed profile must produce nothing.
  const beforeArm = await withMarketHours(() =>
    asAdmin(`/admin/execution/profiles/${profileId}/run`, { method: 'POST', body: '{}' }),
  );
  check(
    'a manual pass on an unarmed profile creates no order',
    (beforeArm.body as RunBody).outcome === 'skipped-disabled' && (beforeArm.body as RunBody).orderId === null,
    (beforeArm.body as RunBody).reason,
  );

  // ------------------------------------------------------------- 3. ARM
  section('3. Admin ARM');
  const armed = await asAdmin(`/admin/execution/profiles/${profileId}/state`, {
    method: 'POST',
    body: JSON.stringify({ action: 'ARM_PAPER', reason: 'journey verification' }),
  });
  check('the arm transition is accepted', armed.status === 201 || armed.status === 200, `HTTP ${armed.status}`);
  check('and it is DISABLED → PAPER_ARMED', (armed.body as StateBody).to === 'PAPER_ARMED', `${(armed.body as StateBody).from} → ${(armed.body as StateBody).to}`);

  status = (await asTrader('/autotrade/status')).body as AutoTradeStatusBody;
  check('AutoTrade now APPEARS in the application', status.visible === true, `visible=${status.visible}`);
  check('it is offered as PAPER', status.environment === 'PAPER', String(status.environment));
  check('but it is not yet switched on', status.autoTradeEnabled === false);

  // Armed but not activated by the user → still no orders.
  const armedNotActivated = await withMarketHours(() =>
    asAdmin(`/admin/execution/profiles/${profileId}/run`, { method: 'POST', body: '{}' }),
  );
  check(
    'an armed profile whose holder has not activated AutoTrade still trades nothing',
    (armedNotActivated.body as RunBody).rejectCheckId === 'autotrade-disabled',
    (armedNotActivated.body as RunBody).reason,
  );

  // --------------------------------------------------- 4. User activation
  section('4. The user activates AutoTrade');
  const activated = await asTrader('/autotrade/enabled', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  check('activation now succeeds', activated.status === 201 || activated.status === 200, `HTTP ${activated.status}`);
  check('and reports itself active in PAPER', (activated.body as AutoTradeStatusBody).autoTradeEnabled === true);

  // An operator must not be able to activate on the user's behalf. There is no
  // such route; asserted so adding one is a deliberate, visible act.
  const adminActivate = await asAdmin(`/admin/execution/autotrade/${trader.id}`, {
    method: 'POST',
    body: JSON.stringify({ enabled: true }),
  });
  check(
    'there is no admin route that switches on a user’s AutoTrade',
    adminActivate.status === 404 || adminActivate.status === 405,
    `HTTP ${adminActivate.status}`,
  );

  // ---------------------------------------------------- 5. Sentinel trades
  section('5. Sentinel executes automatically');
  const run = await withMarketHours(() =>
    asAdmin(`/admin/execution/profiles/${profileId}/run`, { method: 'POST', body: '{}' }),
  );
  const result = run.body as RunBody;
  check('the pass executes', result.outcome === 'executed', `${result.outcome}: ${result.reason}`);
  check('against the PAPER engine', result.environment === 'PAPER', String(result.environment));
  check('and NEVER reaches a broker', result.brokerOrderId === null);
  check('an order id came back', !!result.orderId, String(result.orderId));

  const profileAfterRun = await prisma.executionProfile.findUniqueOrThrow({ where: { id: profileId } });
  check('the profile is promoted ARMED → RUNNING', profileAfterRun.state === 'PAPER_RUNNING', profileAfterRun.state);

  // -------------------------- 6. The trade is a CANONICAL trading record
  section('6. The trade appears everywhere a normal trade does');

  const orders = (await asTrader('/sim/orders')).body as { id: string; status: string }[];
  check(
    'the agent order is in the USER’s own Orders',
    Array.isArray(orders) && orders.some((o) => o.id === result.orderId),
    `${Array.isArray(orders) ? orders.length : 0} orders on the account`,
  );

  const positions = (await asTrader('/sim/positions')).body as { quantity: number }[];
  check('a position exists on the user’s account', Array.isArray(positions) && positions.length > 0, `${positions.length} positions`);

  const portfolio = (await asTrader('/sim/portfolio')).body as Record<string, unknown>;
  check('the portfolio reads back', portfolio != null && typeof portfolio === 'object');

  const wallet = await prisma.paperWallet.findUniqueOrThrow({ where: { userId: trader.id } });
  check(
    'the paper wallet moved — cash blocked by a real order',
    Number(wallet.cashBalance) < 1_000_000 || Number(wallet.marginUsed) > 0,
    `cash ₹${Math.round(Number(wallet.cashBalance)).toLocaleString('en-IN')}, margin ₹${Math.round(Number(wallet.marginUsed)).toLocaleString('en-IN')}`,
  );

  const adminOrders = (await asAdmin('/admin/orders?source=sentinel&limit=50')).body as { id: string }[];
  check('the same order is in ADMIN Orders under the Sentinel source', adminOrders.some((o) => o.id === result.orderId));

  const trace = (await asAdmin(`/admin/execution/trace-by-order/${result.orderId}`)).body as { intentId: string; stages: unknown[] };
  check('the order traces back to the decision that produced it', trace.intentId === result.intentId, `${trace.stages.length} stages`);

  const autoStatus = (await asTrader('/autotrade/status')).body as AutoTradeStatusBody;
  check("the user's own panel counts the trade", (autoStatus.today?.orders ?? 0) > 0, `${autoStatus.today?.orders} orders today`);

  // ------------------------------------------------------ 7. Idempotency
  section('7. Idempotency');
  const again = await withMarketHours(() =>
    asAdmin(`/admin/execution/profiles/${profileId}/run`, { method: 'POST', body: '{}' }),
  );
  check('a repeated pass is a DUPLICATE, not a second order', (again.body as RunBody).outcome === 'duplicate', (again.body as RunBody).reason);
  const orderCount = await prisma.order.count({ where: { userId: trader.id } });
  check('exactly one order exists on the account', orderCount === 1, `${orderCount} orders`);

  // ------------------------------------------- 8. Qualification, and LIVE
  section('8. Qualification does not unlock live');
  const qual = (await asAdmin(`/admin/execution/profiles/${profileId}/qualification`)).body as QualBody;
  check('qualification is measurable and configurable', Array.isArray(qual.results) && qual.results.length > 0, `${qual.results.length} criteria`);
  check('a fresh profile is NOT yet qualified', qual.passed === false, `${qual.unmet.length} criteria short`);
  for (const u of qual.unmet.slice(0, 3)) console.log(`        · ${u.detail}`);

  const armLive = await asAdmin(`/admin/execution/profiles/${profileId}/state`, {
    method: 'POST',
    body: JSON.stringify({ action: 'ARM_LIVE' }),
  });
  check(
    'ARM_LIVE is REFUSED for an unqualified profile',
    armLive.status === 409,
    `HTTP ${armLive.status} — ${(armLive.body as { message?: string }).message ?? ''}`,
  );
  const stillPaper = await prisma.executionProfile.findUniqueOrThrow({ where: { id: profileId } });
  check('the profile is still PAPER', stillPaper.environment === 'PAPER' && stillPaper.liveArmedAt === null, stillPaper.state);

  // ------------------------------------- 8b. Qualify, then arm live for real
  section('8b. PAPER_QUALIFIED → LIVE_ARMED, the second explicit act');
  //
  // The half of §11 a fresh profile cannot reach. The thresholds are lowered on
  // THIS profile — which is itself the demonstration that §10's "make the
  // qualification criteria configurable rather than hardcoding arbitrary
  // values" is real — and a short run of closed paper trades is recorded the
  // way the lifecycle service records them: through intents and outcomes, never
  // as a bare number on a dashboard.
  await prisma.executionProfile.update({
    where: { id: profileId },
    data: {
      qualMinTrades: 3,
      qualMinTradingDays: 2,
      qualMinWinRate: 50,
      qualMaxDrawdownPct: 50,
      qualMinNetPnl: 0,
      qualMaxLosingStreak: 3,
      qualMaxCriticalErrors: 0,
      // Headroom for the live attempt below. The paper position opened in
      // section 5 is still open, and against the default `maxOpenPositions: 1`
      // the live pass is refused by the CONCURRENCY gate before it can reach
      // the adapter — which is the gate working, and which would leave the
      // live-boundary assertion passing for the wrong reason.
      //
      // Each successive refusal this harness had to clear on the way to the
      // adapter (the account gate, the risk policy, idempotency, and now this
      // one) is a layer that would independently have stopped a live order.
      // That is the defence in depth §9 and §12 ask for, observed rather than
      // asserted.
      maxOpenPositions: 5,
    },
  });
  await seedClosedPaperTrades(prisma, profileId, [4_000, -1_500, 2_500]);

  const requalified = (await asAdmin(`/admin/execution/profiles/${profileId}/qualification/evaluate`, {
    method: 'POST',
    body: '{}',
  })).body as QualBody & { metrics: { trades: number; winRate: number | null; netPnl: number } };
  check(
    'a real paper record now clears the configured bar',
    requalified.passed === true,
    `${requalified.metrics.trades} trades, ${Math.round(requalified.metrics.winRate ?? 0)}% win rate, ${requalified.metrics.netPnl} net`,
  );

  const qualifiedRow = await prisma.executionProfile.findUniqueOrThrow({ where: { id: profileId } });
  check('the profile is promoted to PAPER_QUALIFIED', qualifiedRow.state === 'PAPER_QUALIFIED', qualifiedRow.state);
  // THE ACCEPTANCE CRITERION: QUALIFIED != LIVE.
  check(
    'qualifying did NOT authorize live execution',
    qualifiedRow.environment === 'PAPER' && qualifiedRow.liveArmedAt === null,
    `environment=${qualifiedRow.environment}, liveArmedAt=${qualifiedRow.liveArmedAt}`,
  );
  // And it is still trading paper — passing must not silently stop the agent.
  const qualifiedPass = await withMarketHours(() =>
    asAdmin(`/admin/execution/profiles/${profileId}/run`, { method: 'POST', body: '{}' }),
  );
  check(
    'a qualified profile keeps trading PAPER',
    (qualifiedPass.body as RunBody).environment === 'PAPER' && (qualifiedPass.body as RunBody).brokerOrderId === null,
    (qualifiedPass.body as RunBody).outcome,
  );

  // NOW the second explicit administrative act is permitted.
  const liveArmed = await asAdmin(`/admin/execution/profiles/${profileId}/state`, {
    method: 'POST',
    body: JSON.stringify({ action: 'ARM_LIVE', reason: 'journey verification' }),
  });
  check(
    'ARM_LIVE is accepted once, and only once, the profile is qualified',
    (liveArmed.body as StateBody).to === 'LIVE_ARMED',
    `${(liveArmed.body as StateBody).from} -> ${(liveArmed.body as StateBody).to}`,
  );

  const liveRow = await prisma.executionProfile.findUniqueOrThrow({ where: { id: profileId } });
  check('the live arm is attributed to the operator who made it', liveRow.liveArmedBy?.startsWith('admin:') === true, String(liveRow.liveArmedBy));
  const liveTransition = await prisma.executionStateTransition.findFirst({
    where: { profileId, toState: 'LIVE_ARMED' },
    orderBy: { createdAt: 'desc' },
  });
  check(
    'and the qualification it was justified by is frozen onto the audit row',
    liveTransition?.qualificationSnapshot != null,
    'snapshot attached',
  );

  // The deployment gate is the LAST thing between a live-armed profile and a
  // real order, and it is off here. The pass therefore refuses — with a reason
  // that names the flag rather than pretending nothing happened.
  //
  // Sentinel is retargeted to a different strike first. Without that, this pass
  // presents the SAME decision as the paper one above, the idempotency key
  // collapses it to a duplicate, and it never reaches the adapter — so the
  // assertion would pass while proving nothing about the live boundary.
  retargetDecision(25_000);
  const liveAttempt = await withMarketHours(() =>
    asAdmin(`/admin/execution/profiles/${profileId}/run`, { method: 'POST', body: '{}' }),
  );
  const liveResult = liveAttempt.body as RunBody;
  check(
    'a LIVE_ARMED profile on a deployment with live disabled places NO broker order',
    liveResult.brokerOrderId === null && liveResult.rejectCheckId === 'live-not-authorized',
    `${liveResult.outcome}: ${liveResult.reason}`,
  );
  const brokerIntents = await prisma.executionIntent.count({ where: { profileId, brokerOrderId: { not: null } } });
  check('no intent on this profile ever acquired a broker order id', brokerIntents === 0, `${brokerIntents} found`);

  // Standing live down returns the profile to PAPER_QUALIFIED — the earned
  // qualification survives, so re-arming later is one act rather than 50 trades.
  const liveDown = await asAdmin(`/admin/execution/profiles/${profileId}/state`, {
    method: 'POST',
    body: JSON.stringify({ action: 'DISARM_LIVE' }),
  });
  check(
    'DISARM_LIVE returns the profile to PAPER_QUALIFIED, keeping its record',
    (liveDown.body as StateBody).to === 'PAPER_QUALIFIED',
    `${(liveDown.body as StateBody).from} -> ${(liveDown.body as StateBody).to}`,
  );

  // ----------------------------------------------------------- 9. DISARM
  section('9. Disarm stops execution immediately');
  const disarm = await asAdmin(`/admin/execution/profiles/${profileId}/state`, {
    method: 'POST',
    body: JSON.stringify({ action: 'DISARM', reason: 'end of journey' }),
  });
  check('the disarm transition is accepted', (disarm.body as StateBody).to === 'DISARMED', `${(disarm.body as StateBody).from} → ${(disarm.body as StateBody).to}`);

  const afterDisarm = await withMarketHours(() =>
    asAdmin(`/admin/execution/profiles/${profileId}/run`, { method: 'POST', body: '{}' }),
  );
  check(
    'a disarmed profile creates no further order',
    (afterDisarm.body as RunBody).outcome === 'skipped-disabled',
    (afterDisarm.body as RunBody).reason,
  );
  check('and the order count is unchanged', (await prisma.order.count({ where: { userId: trader.id } })) === 1);

  status = (await asTrader('/autotrade/status')).body as AutoTradeStatusBody;
  check('the user sees the capability withdrawn', status.visible === false, `state=${status.state}`);

  // ----------------------------------------------------- 10. Observability
  section('10. Observability');
  const runs = (await asAdmin(`/admin/execution/profiles/${profileId}/runs`)).body as { outcome: string; latencyMs: number | null }[];
  check('every pass is on the record, including the ones that traded nothing', runs.length >= 5, `${runs.length} passes`);
  for (const r of runs.slice(0, 6)) console.log(`        ${r.outcome.padEnd(22)} ${String(r.latencyMs ?? '—').padStart(5)}ms`);

  const history = (await asAdmin(`/admin/execution/profiles/${profileId}/state-history`)).body as { from: string; to: string; actor: string }[];
  check('every state change names its actor', history.length >= 2 && history.every((h) => !!h.actor), `${history.length} transitions`);
  for (const h of history) console.log(`        ${h.from} → ${h.to} by ${h.actor}`);

  const rejections = (await asAdmin('/admin/execution/rejections')).body as { buckets: { label: string; count: number }[] };
  check('refusals are grouped by the gate that produced them', Array.isArray(rejections.buckets));
  for (const b of rejections.buckets) console.log(`        ${String(b.count).padStart(3)}  ${b.label}`);

  const profiles = (await asAdmin('/admin/execution/profiles')).body as ConsoleProfile[];
  const row = profiles.find((p) => p.id === profileId)!;
  check('the console renders a real state, not a boolean', row.state === 'DISARMED' && row.stateLabel.length > 0, `${row.state} — ${row.stateLabel}`);
  check('and `enabled` mirrors it faithfully', row.enabled === false);

  // ------------------------------------------------------------- cleanup
  if (!KEEP) {
    section('Cleanup');
    await prisma.executionRun.deleteMany({ where: { profileId } });
    await prisma.executionStateTransition.deleteMany({ where: { profileId } });
    await prisma.executionQualification.deleteMany({ where: { profileId } });
    await prisma.executionOutcome.deleteMany({ where: { intent: { profileId } } });
    await prisma.executionStrikeCandidate.deleteMany({ where: { intent: { profileId } } });
    await prisma.order.updateMany({ where: { userId: trader.id }, data: { executionIntentId: null, exitOfIntentId: null } });
    await prisma.executionIntent.deleteMany({ where: { profileId } });
    await prisma.executionProfile.delete({ where: { id: profileId } });
    await prisma.trade.deleteMany({ where: { userId: trader.id } });
    await prisma.order.deleteMany({ where: { userId: trader.id } });
    await prisma.position.deleteMany({ where: { userId: trader.id } });
    await prisma.paperWallet.deleteMany({ where: { userId: trader.id } });
    await prisma.subscription.deleteMany({ where: { userId: trader.id } });
    await prisma.auditEvent.deleteMany({ where: { userId: { in: [trader.id, operator.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [trader.id, operator.id] } } });
    await prisma.instrument.deleteMany({ where: { symbol: CONTRACT } });
    console.log('  scratch accounts, profile, instrument and rows removed.');
  } else {
    console.log(`\n(--keep) profile ${profileId} and accounts ${trader.email} / ${operator.email} left in place.`);
  }

  console.log(`\n${'-'.repeat(64)}`);
  console.log(`${pass} passed, ${fail} failed`);
  await stubPrisma.$disconnect();
  await app.close();
  process.exit(fail === 0 ? 0 : 1);
}

// ------------------------------------------------------------------ helpers

interface AutoTradeStatusBody {
  visible: boolean;
  eligible: boolean;
  autoTradeEnabled: boolean;
  environment: string | null;
  state: string | null;
  reason: string | null;
  failedCheckId: string | null;
  today: { orders: number; trades: number } | null;
}
interface RunBody {
  outcome: string;
  reason: string;
  orderId: string | null;
  intentId: string | null;
  brokerOrderId: string | null;
  environment: string | null;
  rejectCheckId: string | null;
}
interface StateBody { from: string; to: string; changed: boolean }
interface QualBody { passed: boolean; results: unknown[]; unmet: { detail: string }[] }
interface ConsoleProfile { id: string; state: string; stateLabel: string; enabled: boolean }

/**
 * A short run of CLOSED paper trades, written the way the lifecycle service
 * writes them: an intent and an outcome per trade.
 *
 * Not a P&L number poked into a dashboard — §20 forbids that, and it would also
 * prove nothing, since the qualification engine reads `ExecutionOutcome` rows
 * and would not see it. Each trade gets its own IST calendar day so the
 * trading-period criterion is exercised rather than trivially satisfied.
 */
async function seedClosedPaperTrades(prisma: PrismaService, profileId: string, pnls: number[]) {
  for (const [i, pnl] of pnls.entries()) {
    const exitAt = new Date(Date.UTC(2026, 7, 10 + i, 6, 0, 0));
    const intent = await prisma.executionIntent.create({
      data: {
        profileId,
        idempotencyKey: `journey-${profileId}-${i}`,
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

/** Point the stubbed Sentinel at a different strike — a new decision, new key. */
function retargetDecision(strike: number) {
  const selected = { ...decision.strikes.selected!, strike, moneyness: strike - 24_880 };
  decision = {
    ...decision,
    sideInFocus: { ...decision.sideInFocus!, strike },
    strikes: {
      ...decision.strikes,
      atmStrike: strike,
      selected,
      candidates: decision.strikes.candidates.map((c) =>
        c.role === 'ATM' ? selected : { ...c, strike: strike + (c.role === 'ITM' ? -50 : 50) },
      ),
    },
  };
}

async function request(url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* a non-JSON body is itself the answer — a 401 HTML page, say */
  }
  return { status: res.status, body };
}

/**
 * The live-feed bridge, stubbed at its service boundary.
 *
 * It UPSERTS a real `Instrument` row, exactly as the production
 * `MarketPriceService.resolveInstrument` does after a scrip-master lookup —
 * so `OrderService` downstream receives a genuine instrument with a genuine id
 * and writes genuine foreign keys. Returning a detached object literal would
 * make every order in this journey reference an instrument that does not exist.
 *
 * A fixed ask of ₹120 on a 75-lot contract: ₹9,000 against a ₹10,00,000 wallet,
 * so the affordability gate passes on merit and the wallet movement is visible.
 */
function stubMarketPrice(prisma: PrismaService, symbol: string) {
  return {
    resolveInstrument: async () =>
      prisma.instrument.upsert({
        where: { symbol },
        create: {
          symbol,
          displayName: 'NIFTY 27 AUG 24900 CE',
          type: 'OPTION',
          exchange: 'NFO',
          underlying: 'NIFTY',
          expiryDate: new Date('2026-08-27T00:00:00.000Z'),
          strikePrice: 24_900,
          optionType: 'CE',
          lotSize: 75,
          tickSize: 0.05,
        },
        update: {},
      }),
    getPrice: async () => ({ ask: 120, bid: 119, last: 119.5, marketOpen: true }),
  };
}

/**
 * Run one section with the clock moved to a mid-session instant.
 *
 * ## Why the clock is moved rather than the check relaxed
 *
 * `runProfile` reads `new Date()` when the ADMIN endpoint invokes it, and the
 * session gate refuses anything outside 09:15–15:30 IST on an NSE trading day.
 * That gate is correct and this harness must not weaken it — adding a
 * test-only `now` parameter to a production HTTP route would put a way to
 * bypass a trading gate in the shipped API, which is exactly what §20 forbids.
 *
 * So the gate runs unmodified and the CLOCK is what moves, for the duration of
 * one section and no longer. The alternative — asserting conditionally on
 * whether the market happens to be open — makes the central assertions of this
 * script skip themselves on a weekend, a holiday, or any evening, which is when
 * verification is usually run.
 *
 * The instant is chosen against the real NSE calendar, not merely a weekday:
 * `nextTradingDayAt1102` skips holidays, because 26 Aug 2026 is a Wednesday AND
 * Ganesh Chaturthi.
 */
async function withMarketHours<T>(fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const target = nextTradingDayAt1102().getTime();
  const offset = target - RealDate.now();

  class ShiftedDate extends RealDate {
    // `unknown[]` rather than `ConstructorParameters<typeof Date>`: that type
    // resolves to the LAST overload (the single-argument form), so `tsc`
    // narrows `args.length` to 1 and calls the zero-argument branch below
    // unreachable. The shim genuinely has to accept every Date overload.
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as [number]));
    }
    static now() {
      return RealDate.now() + offset;
    }
  }

  (globalThis as { Date: DateConstructor }).Date = ShiftedDate as unknown as DateConstructor;
  try {
    return await fn();
  } finally {
    // Restored even when the section throws — a leaked clock would corrupt
    // every timestamp written after it, including the cleanup's.
    (globalThis as { Date: DateConstructor }).Date = RealDate;
  }
}

/** The next NSE TRADING day at 11:02 IST, as a UTC instant. Skips holidays. */
function nextTradingDayAt1102(): Date {
  const day = new Date();
  for (let i = 0; i < 30; i++) {
    const candidate = new Date(day.getTime() + i * 86_400_000);
    const key = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(candidate);
    const at1102 = new Date(`${key}T11:02:00+05:30`);
    if (isTradingDay(at1102)) return at1102;
  }
  throw new Error('No NSE trading day found in the next 30 days — check the calendar.');
}

/**
 * The Sentinel verdict this journey runs on.
 *
 * A `let`, because the live section needs Sentinel to reach a genuinely
 * DIFFERENT conclusion. The idempotency key is the decision's content — profile,
 * contract, side, decision window — so re-running the same verdict correctly
 * collapses to a duplicate and never reaches an adapter at all. That is the
 * mechanism working; it also means a live-boundary assertion written against a
 * repeated verdict tests nothing. `retargetDecision` moves the strike, which is
 * what a fresh read would do.
 */
let decision: ExecutionEvaluationDto = {
  verdict: 'executable',
  executable: true,
  reason: 'A side is in focus.',
  runId: 'verify-journey-run',
  symbol: 'NIFTY',
  observedAt: new Date().toISOString(),
  spot: 24_880,
  sideInFocus: {
    side: 'CE',
    bias: 'bullish',
    strike: 24_900,
    confidence: 82,
    rationale: ['verification harness: a fixed bullish read'],
    optionContext: {},
  },
  confidence: 82,
  publication: {},
  strategyId: null,
  strategyName: 'journey-verification',
  strikes: {
    candidates: (['ITM', 'ATM', 'OTM'] as const).map((role, i) => ({
      role,
      strike: 24_850 + i * 50,
      optionType: 'CE' as const,
      premium: 120,
      openInterest: 1_000_000,
      volume: 500_000,
      impliedVol: 14.2,
      moneyness: 24_850 + i * 50 - 24_880,
      tradable: true,
      selected: role === 'ATM',
      reason: role === 'ATM' ? 'closest to spot' : 'not selected',
      checks: [],
    })),
    selected: {
      role: 'ATM',
      strike: 24_900,
      optionType: 'CE',
      premium: 120,
      openInterest: 1_000_000,
      volume: 500_000,
      impliedVol: 14.2,
      moneyness: 20,
      tradable: true,
      selected: true,
      reason: 'closest to spot',
      checks: [],
    },
    atmStrike: 24_900,
    strikeStep: 50,
    unavailableReason: null,
  },
  expiry: '2026-08-27T00:00:00.000Z',
  marketSnapshot: { source: 'verification harness' },
};

main().catch((err) => {
  console.error('\nJOURNEY ABORTED:', err);
  process.exit(1);
});
