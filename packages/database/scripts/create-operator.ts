/**
 * Create, disable, re-enable or list standalone-console operators.
 *
 *   npm run operator:create  -w @tradew/database -- ops@tradew.io "correct horse battery staple"
 *   npm run operator:create  -w @tradew/database -- ops@tradew.io --disable
 *   npm run operator:create  -w @tradew/database -- ops@tradew.io --enable
 *   npm run operator:create  -w @tradew/database -- --list
 *
 * WHY THIS IS A SEPARATE SCRIPT FROM `grant-admin`
 *
 * `grant-admin` flips `User.isAdmin` — it makes an existing TradeW *trader* an
 * admin of the in-product `apps/web` console. An `OperatorAccount` is a
 * different identity entirely: it is how the STANDALONE `apps/admin` control
 * plane knows *which person* is driving it, and it deliberately has no path
 * through the product (no signup, no OAuth, no self-service password reset).
 * The two admin identities are not interchangeable, so neither are the scripts.
 *
 * Like `grant-admin`, this requires database credentials to run, which is the
 * intended bar: an operator can only be minted by someone who already has
 * production access. There is no bootstrap-first-operator shortcut.
 *
 * The password is taken as an argument rather than prompted so this runs in
 * non-interactive shells and CI. In a shared terminal, prefer piping it via an
 * env var (OPERATOR_PASSWORD) so it does not land in shell history.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/** The same floor `class-validator` enforces on the login DTO. A control-plane
 *  credential should not be shorter than a product one. */
const MIN_PASSWORD_LENGTH = 12;

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    const operators = await prisma.operatorAccount.findMany({
      select: { email: true, name: true, disabledAt: true, lastSeenAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!operators.length) {
      console.log('No operators yet. The standalone console will deny everyone until one exists.');
      return;
    }
    console.log(`${operators.length} operator(s):`);
    for (const op of operators) {
      const state = op.disabledAt ? 'DISABLED' : 'active';
      const seen = op.lastSeenAt ? op.lastSeenAt.toISOString() : 'never';
      console.log(`  · ${op.email}  [${state}]  last seen ${seen}`);
    }
    return;
  }

  const email = args.find((a) => !a.startsWith('--'))?.toLowerCase().trim();
  if (!email) {
    console.error('Usage: create-operator <email> <password> | <email> --disable | <email> --enable | --list');
    process.exitCode = 1;
    return;
  }

  if (args.includes('--disable')) {
    const updated = await prisma.operatorAccount.updateMany({ where: { email }, data: { disabledAt: new Date() } });
    console.log(updated.count ? `Disabled ${email}. They are denied on their next request.` : `No operator ${email}.`);
    return;
  }

  if (args.includes('--enable')) {
    const updated = await prisma.operatorAccount.updateMany({
      where: { email },
      data: { disabledAt: null, failedAttempts: 0, lockedUntil: null },
    });
    console.log(updated.count ? `Re-enabled ${email}.` : `No operator ${email}.`);
    return;
  }

  // Create / reset-password path. The password is the second positional arg, or
  // OPERATOR_PASSWORD in the environment.
  const password = args.filter((a) => !a.startsWith('--') && a.toLowerCase().trim() !== email)[0] ?? process.env.OPERATOR_PASSWORD;
  if (!password) {
    console.error('A password is required: pass it as the second argument or set OPERATOR_PASSWORD.');
    process.exitCode = 1;
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exitCode = 1;
    return;
  }

  // bcryptjs exposes its functions under `.default` when this script is parsed
  // as ESM by ts-node (same interop quirk create-admin.ts handles). Fall back to
  // it so `hash` resolves in every runner.
  const bcryptHash = (bcrypt as unknown as {
    hash?: (s: string, r: number) => Promise<string>;
    default?: { hash: (s: string, r: number) => Promise<string> };
  });
  const hash = bcryptHash.hash ?? bcryptHash.default?.hash;
  if (!hash) throw new Error('bcryptjs hash function unavailable');
  const passwordHash = await hash(password, 10);
  const existing = await prisma.operatorAccount.findUnique({ where: { email }, select: { id: true } });

  await prisma.operatorAccount.upsert({
    where: { email },
    // A re-run resets the password and clears any lockout — this doubles as the
    // out-of-band password reset the product path deliberately does not offer.
    update: { passwordHash, failedAttempts: 0, lockedUntil: null, disabledAt: null },
    create: { email, passwordHash },
  });

  console.log(`${existing ? 'Updated' : 'Created'} operator ${email}.`);
  console.log('They still need ADMIN_API_TOKEN configured on the apps/admin server — both factors are required.');
  if (!process.env.OPERATOR_JWT_SECRET) {
    console.log('WARNING: OPERATOR_JWT_SECRET is not set on this shell. services/api will refuse operator logins until it is configured there.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
