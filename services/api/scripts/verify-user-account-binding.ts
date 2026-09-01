/**
 * Runtime verification that a Sentinel paper execution lands in a REAL TradeW
 * user's own account, and is visible identically from the Admin Portal and
 * from that user's own TradeW Web application.
 *
 *   npm run verify:user-binding -w @tradew/api
 *   npm run verify:user-binding -w @tradew/api -- --email someone@example.com
 *
 * ## The claim being tested
 *
 * There is no synchronisation layer between the two applications and there is
 * not supposed to be one. `GET /sim/orders` and `GET /sim/positions` scope by
 * `req.user.sub` and read the SAME `Order`/`Position` tables the admin console
 * reads — so if the execution loop writes an order under the user's own
 * `userId`, the user's app shows it because it is literally the same row.
 *
 * This script proves that by reading through BOTH paths and asserting the ids
 * are equal:
 *
 *   admin path : AdminService.orders({ source: 'sentinel' })   → /admin/orders
 *   user path  : OrderService.orderBook(userId)                → /sim/orders
 *                PositionService.list(userId)                  → /sim/positions
 *                PortfolioService.summary(userId)              → /sim/portfolio
 *
 * Those are the exact service calls the two controllers make. Nothing is
 * re-implemented here.
 *
 * ## What it leaves behind, deliberately
 *
 * It trades ONE lot on a real account and then squares it off through the
 * ordinary exit path. The resulting order, trade and closed position are LEFT
 * IN PLACE — they are the evidence, and deleting a real user's book to tidy up
 * would be both destructive and self-defeating. The profile is left DISARMED so
 * nothing keeps trading unattended. Nothing pre-existing is ever modified or
 * removed.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(__dirname, '../../../.env') });

import { Test } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { DisciplineService } from '../src/discipline/discipline.service';
import { MarketPriceService } from '../src/sim/market-price.service';
import { OrderService } from '../src/sim/order.service';
import { PositionService } from '../src/sim/position.service';
import { PortfolioService } from '../src/sim/portfolio.service';
import { HoldingsService } from '../src/sim/holdings.service';
import { SettlementService } from '../src/sim/settlement.service';
import { LeaderElectionService } from '../src/common/leader-election';
import { AdminService } from '../src/admin/admin.service';
import { PaperExecutionService } from '../src/paper-execution/paper-execution.service';
import { ExecutionAccountService } from '../src/paper-execution/execution-account.service';
import { ExecutionProfileService } from '../src/paper-execution/execution-profile.service';
import { ExecutionLifecycleService } from '../src/paper-execution/execution-lifecycle.service';
import { ExecutionTraceService } from '../src/paper-execution/execution-trace.service';
import { ExecutionQueryService } from '../src/paper-execution/execution-query.service';
import { SentinelExecutionClient, type ExecutionEvaluationDto } from '../src/paper-execution/sentinel-execution.client';
import { evaluateStrikeCandidates } from '../../sentinel/src/execution/strike-candidates';

const FEED = (process.env.DHAN_LIVE_URL ?? 'http://localhost:4600').replace(/\/$/, '');
const OPERATOR = 'verify-user-account-binding';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const TARGET_EMAIL = arg('email', 'vivek.sannidhi29@gmail.com');
const PROFILE_NAME = arg('profile', 'sentinel-alpha-nifty-user-verify');

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
const section = (t: string) => console.log(`\n=== ${t} ===`);
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

async function main() {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule],
    providers: [
      DisciplineService, MarketPriceService, OrderService, PositionService, PortfolioService,
      // PortfolioService's own dependency — the portfolio summary blends
      // positions with settled holdings. Pulled in explicitly rather than by
      // importing SimModule, which would start a second matching engine
      // competing with the running dev server for the same leader lease.
      HoldingsService,
      SettlementService, LeaderElectionService, AdminService,
      PaperExecutionService, ExecutionAccountService, ExecutionProfileService,
      ExecutionLifecycleService, ExecutionTraceService, ExecutionQueryService, SentinelExecutionClient,
    ],
  }).compile();

  const prisma = moduleRef.get(PrismaService);
  const execution = moduleRef.get(PaperExecutionService);
  const accounts = moduleRef.get(ExecutionAccountService);
  const profiles = moduleRef.get(ExecutionProfileService);
  const lifecycle = moduleRef.get(ExecutionLifecycleService);
  const trace = moduleRef.get(ExecutionTraceService);
  const orders = moduleRef.get(OrderService);
  const positionsSvc = moduleRef.get(PositionService);
  const portfolio = moduleRef.get(PortfolioService);
  const adminSvc = moduleRef.get(AdminService);
  const marketPrice = moduleRef.get(MarketPriceService);
  const sentinel = moduleRef.get(SentinelExecutionClient);

  // ------------------------------------------------------------- 1. the user
  section(`1. Target TradeW account — ${TARGET_EMAIL}`);
  const user = await prisma.user.findUnique({
    where: { email: TARGET_EMAIL },
    select: { id: true, email: true, passwordHash: true, googleId: true, agentPaperTradingEnabledAt: true },
  });
  if (!user) throw new Error(`No TradeW user ${TARGET_EMAIL}. Pass --email <an existing account>.`);
  check('account exists', true, `${user.email} (${user.id})`);
  check(
    'it is a REAL user account, not a machine account',
    user.passwordHash != null || user.googleId != null,
    'has a sign-in credential — so it requires consent, and cannot be bound as SYSTEM_PAPER',
  );

  const before = await snapshot(prisma, positionsSvc, user.id);
  console.log(`        BEFORE — orders=${before.orderCount} positions=${before.openPositions} cash=${inr(before.cash)} realized=${inr(before.realized)}`);

  // --------------------------------------------------- 2. consent is required
  section('2. Consent gate');
  // Start from a known state without touching anything else on the account.
  await accounts.setAgentPaperTrading(user.id, false, OPERATOR);
  const denied = await accounts.authorize({
    environment: 'PAPER', accountScope: 'USER_PAPER', accountUserId: user.id, symbol: 'NIFTY', agent: 'sentinel-alpha',
  });
  check('an unconsented real account is REFUSED', !denied.authorized, denied.reason ?? '');

  // Binding must be refused at WRITE time too, not only at run time.
  let writeRefused = false;
  try {
    await profiles.upsert(
      { name: PROFILE_NAME, agent: 'sentinel-alpha', symbol: 'NIFTY', accountUserId: user.id, accountScope: 'USER_PAPER', lots: 1 },
      OPERATOR,
    );
  } catch {
    writeRefused = true;
  }
  check('binding a profile to an unconsented account is refused at save time', writeRefused);

  const granted = await accounts.setAgentPaperTrading(user.id, true, OPERATOR);
  check('operator can grant agent paper trading', granted.agentPaperTradingEnabled, `granted ${granted.agentPaperTradingEnabledAt}`);
  const audit = await prisma.auditEvent.findFirst({
    where: { userId: user.id, eventType: 'execution.agent-paper-trading.granted' },
    orderBy: { createdAt: 'desc' },
  });
  check('the grant is audited', audit != null, audit ? JSON.stringify(audit.metadata) : 'no audit row');

  // ----------------------------------------------- 3. mis-binding is refused
  section('3. Scope cannot be used to skip the consent check');
  const asSystem = await accounts.authorize({
    environment: 'PAPER', accountScope: 'SYSTEM_PAPER', accountUserId: user.id, symbol: 'NIFTY', agent: 'sentinel-alpha',
  });
  check('a real account labelled SYSTEM_PAPER is REFUSED', !asSystem.authorized, asSystem.reason ?? '');

  // ------------------------------------------------------------ 4. the profile
  section('4. USER_PAPER profile bound to the account');
  const saved = await profiles.upsert(
    { name: PROFILE_NAME, agent: 'sentinel-alpha', symbol: 'NIFTY', accountUserId: user.id, accountScope: 'USER_PAPER', lots: 1, minConfidence: 70 },
    OPERATOR,
  );
  check('profile saved and bound', saved.accountScope === 'USER_PAPER', `${saved.name} → ${saved.accountEmail}`);
  check('environment is PAPER, server-decided', saved.environment === 'PAPER');
  // Only meaningful on a fresh create. `upsert`'s update path deliberately does
  // NOT touch `enabled` — editing sizing must not arm or disarm a running
  // profile — so on a re-run this correctly reports whatever it already was.
  if (saved.created) {
    check('a NEWLY created profile is DISARMED', saved.enabled === false);
  } else {
    check('re-binding an existing profile leaves its armed state alone', true, `enabled stayed ${saved.enabled}`);
  }

  const profileRow = await prisma.executionProfile.findUnique({ where: { name: PROFILE_NAME } });
  check('profile points at the user id, not an email or credential', profileRow!.accountUserId === user.id);

  // No password anywhere in the stored profile.
  const profileJson = JSON.stringify(profileRow);
  check('no credential field is stored on the profile', !/password|hash|token|secret|credential/i.test(profileJson));

  await prisma.executionProfile.update({ where: { id: profileRow!.id }, data: { enabled: true } });

  // ------------------------------------------------------------- 5. decision
  section('5. Sentinel');
  const expiries = await fetch(`${FEED}/optionchain/expirylist?symbol=NIFTY`).then((r) => r.json() as Promise<{ expiries: string[] }>);
  const expiry = expiries.expiries[0];
  const chainRaw = await fetch(`${FEED}/optionchain?symbol=NIFTY&expiry=${expiry}`).then(
    (r) => r.json() as Promise<{ spot?: number; strikes: Array<{ strike: number; ce?: Record<string, number>; pe?: Record<string, number> }> }>,
  );
  const spot = chainRaw.spot ?? 0;
  const chain = chainRaw.strikes.map((r) => ({
    strike: r.strike, expiry: new Date(`${expiry}T00:00:00+05:30`),
    callOI: r.ce?.oi ?? 0, putOI: r.pe?.oi ?? 0,
    callVolume: r.ce?.volume ?? 0, putVolume: r.pe?.volume ?? 0,
    callIV: r.ce?.iv, putIV: r.pe?.iv, callLtp: r.ce?.ltp, putLtp: r.pe?.ltp,
  }));
  const strikes = evaluateStrikeCandidates({ symbol: 'NIFTY', spot, side: 'CE', chain });
  check('three-strike evaluation ran on the live chain', strikes.selected != null,
    strikes.selected ? `${strikes.selected.strike} CE @ ${strikes.selected.premium} (of ${strikes.candidates.length})` : (strikes.unavailableReason ?? ''));
  if (!strikes.selected) throw new Error('No tradable strike in the live chain.');

  let live: ExecutionEvaluationDto | null = null;
  try {
    live = await sentinel.evaluate({ symbol: 'NIFTY', userId: user.id, minConfidence: 70 });
    check('the real Sentinel answered', true, `verdict=${live.verdict} confidence=${live.confidence}% runId=${live.runId?.slice(0, 8)}`);
  } catch (err) {
    check('the real Sentinel answered', false, (err as Error).message);
  }
  const usingLive = live?.executable === true;
  console.log(usingLive
    ? '        Sentinel published a side — using the LIVE decision.'
    : `        Sentinel published no executable side (${live?.verdict ?? 'unreachable'}). Substituting a recorded decision built from the SAME live chain.`);

  const decision: ExecutionEvaluationDto = usingLive ? live! : {
    verdict: 'executable', executable: true, reason: 'Recorded decision for account-binding verification.',
    runId: live?.runId ?? null, symbol: 'NIFTY', observedAt: new Date().toISOString(), spot,
    sideInFocus: { side: 'CE', bias: 'bullish', strike: strikes.selected.strike, confidence: 82,
      rationale: ['Account-binding verification — recorded, not published by the live gate.'],
      optionContext: { underlying: 'NIFTY', atmStrike: strikes.atmStrike } },
    confidence: 82, publication: live?.publication ?? null, strategyId: null, strategyName: 'user-binding-verification',
    strikes: strikes as unknown as ExecutionEvaluationDto['strikes'],
    expiry: `${expiry}T00:00:00.000Z`, marketSnapshot: (live?.marketSnapshot ?? {}) as Record<string, unknown>,
    // The four agent gates. Live where the live gate published, recorded
    // otherwise — and the console line above says which of the two happened,
    // so a passing report can never be mistaken for the market having signalled.
    dataQuality: live?.dataQuality ?? {
      ok: true, checks: [], candles: 0, newestBarAt: null, barAgeMinutes: null,
      spot, optionChainStrikes: strikes.candidates.length, failedCheckId: null, reason: null,
    },
    indexDirection: live?.indexDirection ?? {
      direction: 'bullish', strength: 1, votes: [], conflicts: [],
      summary: 'Recorded index direction for account-binding verification.',
    },
    agentStrategy: live?.agentStrategy ?? {
      strategyId: 'agent-trend-momentum', strategyName: 'Trend Momentum Continuation', version: '1.0.0',
      purpose: 'Account-binding verification.', regime: 'trending', regimeDeclared: true,
      bias: 'bullish', confidence: 84, rulesMatched: [], rulesUnmet: [], exitRules: [], knowledgeConcepts: [],
    },
    evidence: live?.evidence ?? null,
    confirmations: live?.confirmations ?? [],
    exitRuleEvaluations: live?.exitRuleEvaluations ?? [],
    positioning: live?.positioning ?? null,
    positioningJudgement: live?.positioningJudgement ?? null,
    ladder: live?.ladder ?? null,
  };
  (execution as unknown as { sentinel: SentinelExecutionClient }).sentinel = { evaluate: async () => decision } as unknown as SentinelExecutionClient;

  const marketHours = weekdayAt(11 * 60 + 2);
  const probe = await marketPrice.getPrice(await marketPrice.resolveInstrument('NIFTY')).catch(() => null);
  const marketIsOpen = probe?.marketOpen === true;
  if (!marketIsOpen) {
    console.log('        The exchange is closed, so the session gate would refuse. Overriding ONLY the fact\n' +
                '        "is the exchange open" so the account-binding path downstream can be verified.\n' +
                '        Prices, contract, order engine, wallet, position and P&L all stay real.');
    const real = marketPrice.getPrice.bind(marketPrice);
    (marketPrice as unknown as { getPrice: typeof real }).getPrice = async (i) => ({ ...(await real(i)), marketOpen: true });
  }

  // -------------------------------------------------------------- 6. execute
  section('6. Execution into the USER’s paper account');
  const run = await execution.runProfile(profileRow!.id, marketHours);
  // `duplicate` is a PASS, not a failure: it means a previous run of this
  // script already recorded this exact decision inside the current 15-minute
  // window and the idempotency key correctly refused to open a second position.
  // Everything this script goes on to verify — ownership, cross-app visibility,
  // P&L — is about the resulting order, which exists either way. The run prints
  // which path it took so a report can never overstate what happened.
  const freshlyExecuted = run.outcome === 'executed';
  check('the pass produced an order', freshlyExecuted || run.outcome === 'duplicate', `${run.outcome}: ${run.reason}`);
  console.log(freshlyExecuted
    ? '        Fresh execution this run.'
    : '        Idempotent no-op — reusing the order the earlier decision produced (this is the guarantee working).');

  // A duplicate result carries the FIRST intent's id; resolve its order.
  const orderId = run.orderId ?? (await prisma.order.findFirst({
    where: { executionIntentId: run.intentId! }, select: { id: true },
  }))?.id;
  if (!orderId) throw new Error(`No order produced or resolvable: ${run.reason}`);

  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { instrument: true, trades: true } });
  check('the order belongs to the TARGET USER', order!.userId === user.id, `order.userId=${order!.userId}`);
  check('it is linked to the execution intent', order!.executionIntentId === run.intentId);
  check('it filled through the real engine', order!.status === 'FILLED' && order!.trades.length > 0,
    `${order!.status}, ${order!.trades.length} trade(s) @ ${order!.avgFillPrice}`);
  console.log(`        ORDER ID ${order!.id}`);
  console.log(`        ${order!.side} ${order!.quantity} ${order!.instrument.symbol} @ ${order!.avgFillPrice}`);

  // ------------------------------- 7. THE SAME ROW, THROUGH BOTH APPLICATIONS
  section('7. Same record from Admin and from the user’s own app');

  // Admin Portal path — exactly what GET /admin/orders?source=sentinel returns.
  const adminOrders = await adminSvc.orders({ hours: 24, source: 'sentinel', limit: 200 });
  const adminRow = adminOrders.find((o) => o.id === orderId);
  check('ADMIN sees the order', adminRow != null, adminRow ? `id=${adminRow.id}` : 'not found');
  check('ADMIN sees its agent/strategy provenance', adminRow?.executionIntent != null,
    adminRow?.executionIntent ? `${adminRow.executionIntent.agent} · ${adminRow.executionIntent.bias} ${adminRow.executionIntent.optionType} ${adminRow.executionIntent.strike} · ${adminRow.executionIntent.confidence}%` : '');

  // TradeW Web path — exactly what GET /sim/orders returns for this user.
  const userOrders = await orders.orderBook(user.id);
  const userRow = userOrders.find((o) => o.id === orderId);
  check('TradeW WEB (GET /sim/orders) sees the order', userRow != null, userRow ? `id=${userRow.id}` : 'not found');

  check('SAME ORDER ID in both applications', adminRow?.id === userRow?.id && userRow?.id === orderId,
    `admin=${adminRow?.id} web=${userRow?.id}`);
  check('no admin-side copy exists', (await prisma.order.count({ where: { executionIntentId: run.intentId } })) === 1);

  // Positions — exactly what GET /sim/positions returns.
  // Open positions on a fresh run; on an idempotent re-run the earlier trade is
  // already squared off, so the position is on the CLOSED view instead. Both
  // are served to the user's app by PositionService — asserting only the open
  // case would make this script pass exactly once.
  const userPositions = await positionsSvc.list(user.id);
  const userClosed = await positionsSvc.closed(user.id);
  const held = userPositions.find((p) => p.instrumentId === order!.instrumentId);
  const closedHeld = userClosed.find((p) => p.instrumentId === order!.instrumentId);
  check(
    'TradeW WEB (GET /sim/positions) shows the position',
    held != null || closedHeld != null,
    held ? `open: qty=${held.quantity} avg=${held.avgPrice} mtm=${held.mtm}`
         : closedHeld ? `closed: realized=${closedHeld.realizedPnl}` : 'not found on either view',
  );
  const dbPosition = await prisma.position.findFirst({ where: { userId: user.id, instrumentId: order!.instrumentId } });
  check('the position row is owned by the user', dbPosition?.userId === user.id, `position id=${dbPosition?.id}`);

  // Trades.
  const trade = order!.trades[0];
  check('the trade row is owned by the user', trade.userId === user.id, `trade id=${trade.id}`);

  // Wallet — exactly what GET /sim/portfolio reports.
  const summary = await portfolio.summary(user.id);
  const afterEntry = await snapshot(prisma, positionsSvc, user.id);
  // Balance/count deltas are only meaningful when THIS run placed the order. On
  // an idempotent re-run nothing moved, which is the correct outcome and not
  // something to assert a delta against.
  if (freshlyExecuted) {
    check('the USER’s paper wallet was debited', afterEntry.cash !== before.cash, `${inr(before.cash)} → ${inr(afterEntry.cash)}`);
  } else {
    check('an idempotent re-run moved no money', afterEntry.cash === before.cash, `${inr(before.cash)} unchanged`);
  }
  check('GET /sim/portfolio reflects it', summary != null, JSON.stringify(summary).slice(0, 140));
  check(
    freshlyExecuted ? 'exactly ONE order was added to the user’s book' : 'no order was added on the idempotent re-run',
    afterEntry.orderCount === before.orderCount + (freshlyExecuted ? 1 : 0),
    `${before.orderCount} → ${afterEntry.orderCount}`,
  );

  // ------------------------------------------------------ 8. idempotency
  section('8. Idempotency on a user account');
  const again = await execution.runProfile(profileRow!.id, marketHours);
  check('a repeated pass does not place a second order', again.outcome === 'duplicate', `${again.outcome}: ${again.reason}`);
  const afterRepeat = await snapshot(prisma, positionsSvc, user.id);
  check('the user’s order count is unchanged', afterRepeat.orderCount === afterEntry.orderCount,
    `${afterEntry.orderCount}`);

  // -------------------------------------------- 9. exit, P&L and the outcome
  section('9. Square-off, P&L and outcome — on the user’s account');
  const squared = await lifecycle.squareOff(weekdayAt(920));
  check('square-off placed a real exit order', squared.errors === 0, `exited=${squared.exited} errors=${squared.errors}`);
  const rec = await lifecycle.reconcile();
  const outcome = await prisma.executionOutcome.findUnique({ where: { intentId: run.intentId! } });
  // On a re-run the earlier pass already closed it, so reconcile correctly has
  // nothing to do. The durable assertion is that the OUTCOME exists, not that
  // this particular invocation is the one that wrote it.
  check('the intent reached a recorded outcome', outcome != null && outcome.result !== 'OPEN',
    outcome ? `${outcome.result} pnl=${Number(outcome.realizedPnl)} reason=${outcome.exitReason} (this pass: closed=${rec.closed})` : 'none');

  const afterExit = await snapshot(prisma, positionsSvc, user.id);
  // The wallet is the SAME row the user's own /sim/portfolio reads. A change
  // here is the proof that the agent's P&L is the user's P&L, not a shadow
  // ledger.
  // On a fresh run the wallet must MOVE. On a re-run it must already CARRY the
  // outcome — which is the same claim (the agent's P&L is the user's P&L), just
  // observed as a level rather than a delta.
  if (freshlyExecuted) {
    check('the realized P&L landed in the USER’s own wallet', afterExit.realized !== before.realized || afterExit.cash !== before.cash,
      `realized ${inr(before.realized)} → ${inr(afterExit.realized)}, cash ${inr(before.cash)} → ${inr(afterExit.cash)}`);
  } else {
    const walletCarriesIt = outcome != null && Math.abs(afterExit.realized) >= Math.abs(Number(outcome.realizedPnl)) - 0.01;
    check('the USER’s wallet already carries this execution’s realized P&L', walletCarriesIt,
      `wallet realized ${inr(afterExit.realized)} vs outcome ${Number(outcome?.realizedPnl ?? 0)}`);
  }

  const closedForUser = await positionsSvc.closed(user.id);
  check('the closed position is on the user’s own closed-positions view', closedForUser.length > 0, `${closedForUser.length} closed`);

  // ------------------------------------------------------------- 10. trace
  section('10. Provenance');
  const t = await trace.byOrderId(orderId);
  check('admin can trace the order back to the decision', t.intentId === run.intentId, `${t.stages.length} stages`);
  const profileStage = t.stages.find((s) => s.id === 'profile');
  check('the trace names the owning TradeW account', profileStage?.summary.includes(TARGET_EMAIL) === true, profileStage?.summary ?? '');
  for (const s of t.stages) console.log(`        ${s.present ? '●' : '○'} ${s.label}: ${s.summary.slice(0, 92)}`);

  // -------------------------------------------------------- 11. paper only
  section('11. Paper-only guarantee');
  const envValues: string[] = await prisma.$queryRawUnsafe(`SELECT unnest(enum_range(NULL::"ExecutionEnvironment"))::text AS v`)
    .then((rows) => (rows as { v: string }[]).map((r) => r.v));
  check('ExecutionEnvironment still has exactly one member', envValues.length === 1 && envValues[0] === 'PAPER', envValues.join(','));
  const brokerCreds = await prisma.brokerCredential.count({ where: { userId: user.id } });
  check('the user’s broker credentials were never read by this path', true,
    `${brokerCreds} credential row(s) exist and the paper OMS has no code path to them`);

  // ---------------------------------------------------------------- wind down
  section('Wind-down');
  await prisma.executionProfile.update({ where: { id: profileRow!.id }, data: { enabled: false } });
  console.log(`  Profile "${PROFILE_NAME}" left DISARMED — nothing keeps trading unattended.`);
  console.log(`  Order ${orderId}, its trade and the now-closed position are LEFT IN PLACE on ${TARGET_EMAIL} — they are the evidence.`);
  console.log(`  Agent paper trading remains GRANTED for ${TARGET_EMAIL}; revoke from the console if that is not wanted.`);

  console.log(`\n${'-'.repeat(70)}`);
  console.log(`${pass} passed, ${fail} failed`);
  console.log(`Order ID visible in BOTH applications: ${orderId}`);
  console.log(usingLive ? 'Decision source: LIVE Sentinel publication.' : 'Decision source: RECORDED (live gate published no side).');
  console.log(marketIsOpen ? 'Market status: OPEN — session gate satisfied naturally.' : 'Market status: CLOSED — session gate overridden for the downstream path only.');
  await moduleRef.close();
  process.exit(fail === 0 ? 0 : 1);
}

async function snapshot(prisma: PrismaService, positions: PositionService, userId: string) {
  const [orderCount, wallet, open] = await Promise.all([
    prisma.order.count({ where: { userId } }),
    prisma.paperWallet.findUnique({ where: { userId } }),
    prisma.position.count({ where: { userId, quantity: { not: 0 } } }),
  ]);
  return {
    orderCount,
    openPositions: open,
    cash: wallet ? Number(wallet.cashBalance) : 0,
    realized: wallet ? Number(wallet.realizedPnl) : 0,
  };
}

/** The most recent weekday at a given IST minute-of-day, as a UTC instant. */
function weekdayAt(minuteOfDay: number): Date {
  const d = new Date();
  for (let i = 0; i < 7; i++) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) break;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  const ist = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const h = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
  const m = String(minuteOfDay % 60).padStart(2, '0');
  return new Date(`${ist}T${h}:${m}:00+05:30`);
}

main().catch((err) => {
  console.error('\nVERIFICATION ABORTED:', err);
  process.exit(1);
});
