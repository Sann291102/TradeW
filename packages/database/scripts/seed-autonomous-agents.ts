/**
 * Create the two autonomous paper agents — NIFTY and SENSEX — DISARMED.
 *
 *   npm run agents:seed -w @tradew/database
 *   npm run agents:seed -w @tradew/database -- --list
 *   npm run agents:seed -w @tradew/database -- --user someone@example.com
 *
 * ## What this creates, and what it deliberately does not
 *
 * Two `ExecutionProfile` rows and, by default, the two non-loginable machine
 * accounts they trade. It does NOT arm them, does not grant any consent, and
 * does not touch `PAPER_EXECUTION_ENABLED`. Arming stays what it has always
 * been: a separate, separately-audited operator act in the console
 * (`POST /admin/execution/profiles/:id/enabled`), on top of a process-level env
 * flag. Two switches, two places, two mechanisms — and this script flips
 * neither of them.
 *
 * ## Why the two agents differ
 *
 * They are not one agent run twice. Each names its own strategy roster, so the
 * same market read reaches different conclusions for each:
 *
 *   NIFTY  → structure-shift + trend-momentum. NIFTY is the deepest,
 *            most continuously-traded index chain in the market, which is what
 *            a continuation thesis needs: it depends on being able to size
 *            into a move without the spread eating the edge.
 *   SENSEX → opening-range expansion + exhaustion reversal. A thinner BSE
 *            chain with 100-point strikes, so its edges are the ones that live
 *            at levels rather than in the middle of a trend — a range break,
 *            or a stretched move that fails.
 *
 * That split is a starting configuration, not a discovery. It is recorded here
 * so it is visible and changeable rather than implicit, and the per-(agent,
 * symbol, strategy, regime) calibration is what will eventually say whether it
 * was right.
 *
 * ## The account
 *
 * `passwordHash` is left NULL and no `googleId` is set, so no person can sign
 * in — `authorizeAccount` requires exactly that of a SYSTEM_PAPER binding. With
 * `--user <email>` the profiles are instead bound to a real account as
 * USER_PAPER, which additionally requires that person's recorded consent
 * (`User.agentPaperTradingEnabledAt`) that this script does NOT grant. Run the
 * console's agent-trading toggle for that; it is audited with the operator who
 * did it.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * The two agents.
 *
 * Every number here is a DEFAULT an operator may change in the console. They
 * are written out rather than left to the schema defaults so this file reads
 * as the specification of the two agents rather than as a create call.
 */
const AGENTS = [
  {
    name: 'sentinel-alpha-nifty',
    agent: 'sentinel-alpha',
    symbol: 'NIFTY',
    accountEmail: 'sentinel-alpha@agents.tradew.local',
    strategyIds: ['agent-smc-structure-shift', 'agent-trend-momentum'],
    lots: 1,
    minConfidence: 70,
    maxOpenPositions: 1,
    maxOrdersPerDay: 6,
    maxLossPerDay: 25_000,
    squareOffMinute: 910, // 15:10 IST
    capitalAllocationPct: 20,
    riskPerTradePct: 3,
    rewardPerTradePct: 9,
    trailStepPoints: 3,
  },
  {
    name: 'sentinel-beta-sensex',
    agent: 'sentinel-beta',
    symbol: 'SENSEX',
    accountEmail: 'sentinel-beta@agents.tradew.local',
    strategyIds: ['agent-opening-range-expansion', 'agent-exhaustion-reversal'],
    lots: 1,
    minConfidence: 70,
    maxOpenPositions: 1,
    maxOrdersPerDay: 6,
    maxLossPerDay: 25_000,
    squareOffMinute: 910,
    capitalAllocationPct: 20,
    riskPerTradePct: 3,
    rewardPerTradePct: 9,
    trailStepPoints: 3,
  },
] as const;

async function main() {
  if (flag('list')) {
    const profiles = await prisma.executionProfile.findMany({
      where: { name: { in: AGENTS.map((a) => a.name) } },
      include: { account: { select: { email: true, paperWallet: true, agentPaperTradingEnabledAt: true } } },
      orderBy: { createdAt: 'asc' },
    });
    if (!profiles.length) {
      console.log('Neither autonomous agent exists yet. Run without --list to create them.');
      return;
    }
    for (const p of profiles) {
      const wallet = p.account.paperWallet;
      console.log(
        `${p.enabled ? '● ARMED  ' : '○ disarmed'} ${p.name}\n` +
          `    agent=${p.agent} symbol=${p.symbol} scope=${p.accountScope} env=${p.environment}\n` +
          `    strategies=[${p.strategyIds.join(', ') || 'any agent strategy'}]\n` +
          `    lots=${p.lots} alloc=${p.capitalAllocationPct}% risk=${p.riskPerTradePct}% reward=${p.rewardPerTradePct}% trail=${p.trailStepPoints}pt\n` +
          `    account=${p.account.email} consent=${p.account.agentPaperTradingEnabledAt ? p.account.agentPaperTradingEnabledAt.toISOString() : 'not granted'}\n` +
          `    wallet=${wallet ? `₹${Number(wallet.cashBalance).toLocaleString('en-IN')}` : 'not yet created'}`,
      );
    }
    return;
  }

  const userEmail = arg('user');
  let sharedUserId: string | null = null;
  if (userEmail) {
    const user = await prisma.user.findUnique({ where: { email: userEmail }, select: { id: true, passwordHash: true, googleId: true } });
    if (!user) {
      console.error(`No user ${userEmail}. Bind to an existing TradeW account, or omit --user for machine accounts.`);
      process.exit(1);
    }
    if (!user.passwordHash && !user.googleId) {
      console.error(
        `${userEmail} has no sign-in credential, so it is not a real person's account and cannot be a USER_PAPER target.`,
      );
      process.exit(1);
    }
    sharedUserId = user.id;
    console.log(`Binding both agents to ${userEmail} as USER_PAPER.`);
    console.log('NOTE: consent is NOT granted by this script. Until an operator grants agent paper trading');
    console.log('      for that account in the console, every pass will be refused — by design.');
  }

  for (const spec of AGENTS) {
    let accountUserId = sharedUserId;
    if (!accountUserId) {
      // A machine account: no password, no Google identity, so `AuthService
      // .login` rejects it before bcrypt and no OAuth identity can match. That
      // is what `authorizeAccount` requires of a SYSTEM_PAPER binding.
      const account = await prisma.user.upsert({
        where: { email: spec.accountEmail },
        create: { email: spec.accountEmail, country: 'IN' },
        update: {},
        select: { id: true },
      });
      accountUserId = account.id;
    }

    const data = {
      agent: spec.agent,
      symbol: spec.symbol,
      accountUserId,
      accountScope: sharedUserId ? ('USER_PAPER' as const) : ('SYSTEM_PAPER' as const),
      environment: 'PAPER' as const,
      strategyIds: [...spec.strategyIds],
      lots: spec.lots,
      minConfidence: spec.minConfidence,
      maxOpenPositions: spec.maxOpenPositions,
      maxOrdersPerDay: spec.maxOrdersPerDay,
      maxLossPerDay: spec.maxLossPerDay,
      squareOffMinute: spec.squareOffMinute,
      capitalAllocationPct: spec.capitalAllocationPct,
      riskPerTradePct: spec.riskPerTradePct,
      rewardPerTradePct: spec.rewardPerTradePct,
      trailStepPoints: spec.trailStepPoints,
    };

    const profile = await prisma.executionProfile.upsert({
      where: { name: spec.name },
      // NEVER armed on creation, and an update deliberately does not touch
      // `enabled` either: re-running this script to adjust sizing must not
      // silently arm or disarm a running agent.
      create: { name: spec.name, enabled: false, ...data },
      update: data,
    });

    await prisma.auditEvent.create({
      data: {
        eventType: 'execution.profile.seeded',
        metadata: {
          profileId: profile.id,
          profileName: profile.name,
          agent: profile.agent,
          symbol: profile.symbol,
          accountScope: profile.accountScope,
          strategyIds: [...spec.strategyIds],
          operator: 'seed-autonomous-agents',
        },
      },
    });

    console.log(`${profile.enabled ? '● ARMED' : '○ disarmed'} ${profile.name} — ${profile.agent} on ${profile.symbol}`);
    console.log(`    strategies : ${spec.strategyIds.join(', ')}`);
    console.log(`    capital    : ${spec.capitalAllocationPct}% of equity per position`);
    console.log(`    risk       : ${spec.riskPerTradePct}% of equity, reward ${spec.rewardPerTradePct}% (${(spec.rewardPerTradePct / spec.riskPerTradePct).toFixed(1)}R)`);
    console.log(`    trail      : every ${spec.trailStepPoints} premium points`);
  }

  console.log('');
  console.log('Both agents exist and are DISARMED. To let them trade, BOTH of these must be true:');
  console.log('  1. PAPER_EXECUTION_ENABLED=true in the API process environment');
  console.log('  2. each profile armed in the admin console (POST /admin/execution/profiles/:id/enabled)');
  console.log('');
  console.log('They place PAPER orders only. `ExecutionEnvironment` has exactly one member and there is no');
  console.log('broker order path anywhere in this application.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
