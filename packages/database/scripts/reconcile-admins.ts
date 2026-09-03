/**
 * Withdraw application-admin access from everyone who should not have it.
 *
 *   npm run admin:reconcile -w @tradew/database
 *       Audit only. Lists every account with `isAdmin = true`. Writes nothing.
 *
 *   npm run admin:reconcile -w @tradew/database -- --keep you@example.com
 *       Dry run of the plan: who would be revoked, who would be kept.
 *
 *   npm run admin:reconcile -w @tradew/database -- --keep you@example.com --apply
 *       Actually clears the flag, one audit row per revocation.
 *
 * `--keep` may be repeated and/or comma-separated. `--apply` is required to
 * write anything: the default is always a dry run, because the interesting
 * mistake here is revoking one address too many, and that is only visible
 * BEFORE it happens.
 *
 * ── WHAT THIS IS FOR ──────────────────────────────────────────────────────
 *
 * The removed `create-admin.ts` ended in an unfiltered
 * `prisma.user.updateMany({ data: { isAdmin: true } })`, making every account
 * in the database an administrator of the APPLICATION — not of their own
 * account, which needs no flag. Removing that script stops it recurring;
 * this un-does what it already wrote.
 *
 * ── WHAT IT DOES NOT DO ───────────────────────────────────────────────────
 *
 * It never grants. Adding an admin stays `admin:grant`, one address at a time,
 * on purpose — see `src/admin-reconcile.ts`. A `--keep` address that is not
 * currently an admin is reported, not created.
 */
import { PrismaClient } from '@prisma/client';
import { leavesNoAdmins, parseKeepList, planReconcile } from '../src/admin-reconcile';

const prisma = new PrismaClient();

/** Collect every `--keep a@b.com` / `--keep=a@b.com` value in the argv. */
function readKeepFlags(argv: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--keep') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        values.push(next);
        i += 1;
      }
    } else if (arg.startsWith('--keep=')) {
      values.push(arg.slice('--keep='.length));
    }
  }
  return values;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const allowEmpty = argv.includes('--allow-empty');
  const keepEmails = parseKeepList(readKeepFlags(argv));

  const admins = await prisma.user.findMany({
    where: { isAdmin: true },
    select: { id: true, email: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const totalUsers = await prisma.user.count();

  console.log(`${admins.length} of ${totalUsers} account(s) currently have application-admin access.\n`);

  if (admins.length === 0) {
    console.log('Nothing to reconcile.');
    return;
  }

  // No --keep at all is the audit mode: show the list, explain the next step,
  // and touch nothing. Revoking every admin because the operator forgot an
  // argument is exactly the failure this tool exists to clean up after.
  if (keepEmails.length === 0 && !allowEmpty) {
    for (const admin of admins) console.log(`  · ${admin.email}`);
    console.log(
      '\nNo --keep list given, so nothing was planned. Re-run naming the accounts that should' +
        '\nSTAY admins, e.g.  -- --keep you@example.com,ops@example.com' +
        '\nTo revoke every one of them instead, pass --allow-empty.',
    );
    return;
  }

  const plan = planReconcile(admins, keepEmails);

  if (plan.keep.length > 0) {
    console.log('KEEP (still an admin):');
    for (const admin of plan.keep) console.log(`  · ${admin.email}`);
    console.log('');
  }

  if (plan.unmatched.length > 0) {
    // Loud, because the likeliest cause is a typo in the one argument whose
    // whole job is to protect an account from what happens next.
    console.log('NOT CURRENTLY ADMINS (nothing to keep — check for a typo):');
    for (const email of plan.unmatched) console.log(`  · ${email}`);
    console.log('  Use `npm run admin:grant -w @tradew/database -- <email>` to add an admin.\n');
  }

  if (plan.revoke.length === 0) {
    console.log('No revocations needed — every current admin is on the keep list.');
    return;
  }

  console.log(`REVOKE (${plan.revoke.length}):`);
  for (const admin of plan.revoke) console.log(`  · ${admin.email}`);
  console.log('');

  if (leavesNoAdmins(plan) && !allowEmpty) {
    console.error(
      'Refusing: this would leave NO application admins and no --keep address matched.\n' +
        'Re-run with --allow-empty if that is genuinely what you want. (Operator-console\n' +
        'access is a separate identity — OperatorAccount + ADMIN_API_TOKEN — and is unaffected.)',
    );
    process.exitCode = 1;
    return;
  }

  if (!apply) {
    console.log('DRY RUN — nothing was written. Re-run with --apply to revoke the accounts above.');
    return;
  }

  const ids = plan.revoke.map((admin) => admin.id);
  // One transaction: a half-applied cleanup would leave an admin list that
  // matches neither the old state nor the intended one, and the audit rows
  // must not survive a failed update that never happened.
  const [updated] = await prisma.$transaction([
    prisma.user.updateMany({ where: { id: { in: ids } }, data: { isAdmin: false } }),
    prisma.auditEvent.createMany({
      data: plan.revoke.map((admin) => ({
        userId: admin.id,
        // Same event type the portal and `admin:grant` write, so a revocation
        // from here is indistinguishable in the audit trail from any other —
        // which is correct: it IS the same act.
        eventType: 'admin.revoked',
        metadata: {
          via: 'reconcile-admins script',
          targetEmail: admin.email,
          reason: 'bulk cleanup of the unfiltered create-admin grant',
        },
      })),
    }),
  ]);

  console.log(`Revoked application-admin access for ${updated.count} account(s).`);
  console.log(`${plan.keep.length} admin(s) remain.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
