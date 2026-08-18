/**
 * Grant or revoke admin-portal access.
 *
 *   npm run admin:grant -w @tradew/database -- someone@example.com
 *   npm run admin:grant -w @tradew/database -- someone@example.com --revoke
 *   npm run admin:grant -w @tradew/database -- --list
 *
 * There is deliberately NO way to become an admin through the product: no
 * signup flag, no self-service, no first-user-wins bootstrap. Access requires
 * database credentials, which means it requires someone who already has
 * production access. That is the intended bar.
 *
 * The portal itself can also grant access (`POST /admin/users/set-admin`), but
 * only to an existing admin — so this script is how the first one is created.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    const admins = await prisma.user.findMany({
      where: { isAdmin: true },
      select: { email: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!admins.length) {
      console.log('No admins yet.');
      return;
    }
    console.log(`${admins.length} admin(s):`);
    for (const admin of admins) console.log(`  · ${admin.email}`);
    return;
  }

  const revoke = args.includes('--revoke');
  const email = args.find((a) => !a.startsWith('--'));

  if (!email) {
    console.error('Usage: grant-admin <email> [--revoke] | --list');
    process.exitCode = 1;
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, isAdmin: true } });
  if (!existing) {
    // Explicit rather than creating the account: an admin account should be a
    // real, already-registered user with a password they set themselves, not
    // one conjured by an ops script.
    console.error(`No user with email ${email}. Have them sign up first, then run this again.`);
    process.exitCode = 1;
    return;
  }

  if (existing.isAdmin === !revoke) {
    console.log(`${email} is already ${revoke ? 'not an admin' : 'an admin'}. Nothing to do.`);
    return;
  }

  await prisma.user.update({ where: { email }, data: { isAdmin: !revoke } });
  await prisma.auditEvent.create({
    data: {
      userId: existing.id,
      eventType: revoke ? 'admin.revoked' : 'admin.granted',
      metadata: { via: 'grant-admin script', targetEmail: email },
    },
  });

  console.log(`${revoke ? 'Revoked' : 'Granted'} admin for ${email}.`);
  if (!revoke) {
    console.log('They also need ADMIN_API_TOKEN to unlock the console — both factors are required.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
