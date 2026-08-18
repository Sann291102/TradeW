/**
 * Create (or update) a Sentinel paper-execution profile and its paper account.
 *
 *   npm run execution:profile -w @tradew/database -- --name sentinel-alpha-nifty --symbol NIFTY
 *   npm run execution:profile -w @tradew/database -- --list
 *   npm run execution:profile -w @tradew/database -- --name sentinel-alpha-nifty --enable
 *   npm run execution:profile -w @tradew/database -- --name sentinel-alpha-nifty --disable
 *
 * ## The account is a real User, deliberately
 *
 * The paper engine is user-scoped end to end — `PaperWallet.userId` is unique,
 * `Order`/`Trade`/`Position` all carry `userId`, and `OrderService.placeOrder`
 * takes one. So a Sentinel paper account is a `User` row with a `PaperWallet`,
 * created through that same model rather than through a parallel account system
 * invented for agents. Using the existing model is what lets an agent order
 * traverse exactly the same code path as a human one.
 *
 * ## The account cannot log in
 *
 * `passwordHash` is left NULL and no `googleId` is set. `AuthService.login`
 * rejects a null hash before it reaches bcrypt (see the column's own comment in
 * schema.prisma), and there is no OAuth identity to match — so this account is
 * addressable by the OMS and unreachable by a person. It is also never granted
 * `isAdmin`.
 *
 * ## Profiles are created DISABLED
 *
 * Creating a profile never arms it. Arming is a separate, audited act — either
 * `--enable` here or the console's `POST /admin/execution/profiles/:id/enabled`
 * — and even an armed profile does nothing unless `PAPER_EXECUTION_ENABLED` is
 * `true` in the API's environment. Two switches, two places, on purpose.
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

async function main() {
  if (flag('list')) {
    const profiles = await prisma.executionProfile.findMany({
      include: { account: { select: { email: true, paperWallet: true } }, _count: { select: { intents: true } } },
      orderBy: { createdAt: 'asc' },
    });
    if (!profiles.length) {
      console.log('No execution profiles yet.');
      return;
    }
    for (const p of profiles) {
      const w = p.account.paperWallet;
      console.log(
        `${p.enabled ? '●' : '○'} ${p.name}  [${p.environment}]  agent=${p.agent}  symbol=${p.symbol}  ` +
          `lots=${p.lots}  minConf=${p.minConfidence}%  account=${p.account.email}  ` +
          `cash=${w ? Number(w.cashBalance).toFixed(0) : 'wallet not yet created'}  intents=${p._count.intents}`,
      );
    }
    return;
  }

  const name = arg('name');
  if (!name) {
    console.error('Usage: --name <profile-name> [--symbol NIFTY] [--agent sentinel-alpha] [--lots 1] [--enable|--disable] [--list]');
    process.exit(1);
  }

  // --enable / --disable on an existing profile, without touching anything else.
  if (flag('enable') || flag('disable')) {
    const enabled = flag('enable');
    const updated = await prisma.executionProfile.update({
      where: { name },
      data: { enabled },
      select: { name: true, enabled: true, environment: true, symbol: true },
    });
    console.log(`${updated.enabled ? 'ENABLED' : 'DISABLED'} ${updated.name} (${updated.environment}, ${updated.symbol})`);
    if (updated.enabled) {
      console.log('Note: the loop also requires PAPER_EXECUTION_ENABLED=true in the API environment.');
    }
    return;
  }

  const symbol = (arg('symbol') ?? 'NIFTY').toUpperCase();
  const agent = arg('agent') ?? 'sentinel-alpha';
  const lots = Number(arg('lots') ?? 1);
  const email = arg('email') ?? `${name}@paper.sentinel.tradew.internal`;

  const account = await prisma.user.upsert({
    where: { email },
    // No passwordHash and no googleId — see the header. `country` matches the
    // platform default so nothing downstream has to special-case this row.
    create: { email, country: 'IN', isAdmin: false },
    update: {},
    select: { id: true, email: true },
  });

  // Created eagerly here rather than lazily on first order, only so `--list`
  // and the console can show the account's capital before it has ever traded.
  // The defaults are the schema's own, so this wallet is identical to one
  // `OrderService.ensureWallet` would have made.
  await prisma.paperWallet.upsert({
    where: { userId: account.id },
    create: { userId: account.id },
    update: {},
  });

  const profile = await prisma.executionProfile.upsert({
    where: { name },
    create: {
      name,
      agent,
      symbol,
      accountUserId: account.id,
      environment: 'PAPER',
      enabled: false, // never armed on creation
      lots,
      productType: 'NRML',
      orderType: 'MARKET',
    },
    // An existing profile keeps its `enabled` state: re-running this script to
    // adjust sizing must not silently arm or disarm a live loop.
    update: { agent, symbol, lots, accountUserId: account.id },
    include: { account: { select: { email: true } } },
  });

  console.log(`Profile "${profile.name}" ready.`);
  console.log(`  environment : ${profile.environment}`);
  console.log(`  agent       : ${profile.agent}`);
  console.log(`  symbol      : ${profile.symbol}`);
  console.log(`  lots        : ${profile.lots} (× the contract's own lot size at submission)`);
  console.log(`  account     : ${profile.account.email}`);
  console.log(`  enabled     : ${profile.enabled}`);
  console.log('');
  console.log('To arm it:');
  console.log(`  npm run execution:profile -w @tradew/database -- --name ${profile.name} --enable`);
  console.log('  and set PAPER_EXECUTION_ENABLED=true for services/api.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
