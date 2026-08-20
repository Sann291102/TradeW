/**
 * Backfill: seal any `BrokerCredential.accessToken` still stored in plaintext.
 *
 * ── WHY THIS IS A SCRIPT AND NOT A PRISMA MIGRATION ────────────────────────
 *
 * A migration would run automatically, unattended, inside a transaction that
 * cannot be inspected, against LIVE brokerage credentials. Getting the
 * transform wrong there disconnects every linked broker account with no
 * intermediate state to look at. This is the same reason `accessToken` did not
 * change type: no SQL means no migration that can destroy a credential.
 *
 * So the backfill is an explicit operator action, DRY RUN BY DEFAULT, that
 * reports before it writes and verifies before it commits.
 *
 * ── SAFETY PROPERTIES ──────────────────────────────────────────────────────
 *
 *  · Dry run unless `--apply` is passed. The default prints what would happen.
 *  · Idempotent. Rows already carrying `enc:v1:` are skipped, not re-sealed.
 *  · Round-trip verified per row. The plaintext is only overwritten by a
 *    ciphertext that has ALREADY been decrypted back to exactly it. A row whose
 *    verification fails is left untouched and reported.
 *  · Per-row, not one big transaction. A failure part-way leaves earlier rows
 *    correctly sealed and later rows plaintext — both of which the application
 *    reads correctly, because reads accept either.
 *  · Reversible. `--decrypt` restores plaintext for a documented rollback. It
 *    exists because an operator who cannot undo a bad key deployment is a worse
 *    risk than the mode itself, and it says so every time it runs.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *
 *   npm run credential:migrate -w @tradew/database              # dry run
 *   npm run credential:migrate -w @tradew/database -- --apply   # seal
 *   npm run credential:migrate -w @tradew/database -- --rekey --apply
 *   npm run credential:migrate -w @tradew/database -- --decrypt --apply
 *
 * Requires DATABASE_URL and BROKER_CREDENTIAL_ENC_KEYS.
 *
 * ── AFTERWARDS ─────────────────────────────────────────────────────────────
 *
 * Sealing the live rows does NOT undo the exposure. Any backup taken while the
 * column was plaintext still contains working tokens. Have users reconnect
 * their broker accounts — one click each, and Dhan tokens expire in 24 hours
 * anyway, so the cost is near zero and it closes the exposure completely.
 * See docs/security/BROKER_CREDENTIAL_SECURITY_DESIGN.md §7.
 */

import { PrismaClient } from '@prisma/client';
import {
  activeKeyId,
  credentialKeyId,
  decryptCredential,
  encryptCredential,
  isCredentialEncryptionConfigured,
  isEncryptedCredential,
  KEYRING_ENV,
} from '../src/credential-crypto';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const REKEY = argv.includes('--rekey');
const DECRYPT = argv.includes('--decrypt');

const prisma = new PrismaClient();

function line(s = ''): void {
  // eslint-disable-next-line no-console
  console.log(s);
}

async function main(): Promise<void> {
  if (DECRYPT && REKEY) {
    line('--decrypt and --rekey are mutually exclusive.');
    process.exitCode = 1;
    return;
  }

  if (!isCredentialEncryptionConfigured()) {
    line(`${KEYRING_ENV} is not set or is invalid. Nothing can be sealed or opened without it.`);
    line('Generate a key with:');
    line('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
    line(`and set ${KEYRING_ENV}="k1:<that value>".`);
    process.exitCode = 1;
    return;
  }

  const active = activeKeyId();
  const rows = await prisma.brokerCredential.findMany({
    select: { id: true, provider: true, userId: true, accessToken: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  });

  // The census the design document tells operators to take. Printed first, so a
  // dry run answers "how exposed am I?" before anything is written.
  const plaintext = rows.filter((r) => !isEncryptedCredential(r.accessToken));
  const sealed = rows.filter((r) => isEncryptedCredential(r.accessToken));
  const byKey = new Map<string, number>();
  for (const r of sealed) {
    const k = credentialKeyId(r.accessToken) ?? '?';
    byKey.set(k, (byKey.get(k) ?? 0) + 1);
  }

  line('');
  line('BrokerCredential census');
  line('───────────────────────');
  line(`  total rows           ${rows.length}`);
  line(`  PLAINTEXT at rest    ${plaintext.length}${plaintext.length ? '   ← exposed in every backup taken so far' : ''}`);
  line(`  encrypted            ${sealed.length}`);
  for (const [k, n] of byKey) line(`    key ${k.padEnd(16)} ${n}`);
  line(`  active key           ${active}`);
  line('');

  if (DECRYPT) {
    line('!! BREAK-GLASS: --decrypt writes PLAINTEXT credentials back to the database.');
    line('!! Use this only to roll back a bad key deployment, and re-seal immediately after.');
    line('');
  }

  const targets = DECRYPT
    ? sealed
    : REKEY
      ? rows.filter((r) => !isEncryptedCredential(r.accessToken) || credentialKeyId(r.accessToken) !== active)
      : plaintext;

  if (targets.length === 0) {
    line(DECRYPT ? 'Nothing encrypted to decrypt.' : 'Nothing to do — every credential is already sealed under the active key.');
    return;
  }

  line(`${APPLY ? 'Processing' : 'WOULD process'} ${targets.length} row(s).`);
  if (!APPLY) line('Dry run. Re-run with --apply to write.');
  line('');

  let ok = 0;
  let failed = 0;

  for (const row of targets) {
    const ctx = { provider: row.provider, userId: row.userId };
    // Row identity is printed as provider + a truncated user id: enough to
    // find the row, never the credential.
    const label = `${row.provider}/${row.userId.slice(0, 8)}…`;

    try {
      const opened = decryptCredential(row.accessToken, ctx);
      if (opened.kind === 'failed') {
        line(`  SKIP  ${label}  cannot open (${opened.code}) — left untouched`);
        failed += 1;
        continue;
      }

      const nextValue = DECRYPT
        ? opened.accessToken
        : encryptCredential(opened.accessToken, ctx).value;

      // Verify BEFORE writing. A ciphertext that does not round-trip back to the
      // exact plaintext never reaches the database — this is what makes the
      // backfill safe to run against live credentials.
      if (!DECRYPT) {
        const check = decryptCredential(nextValue, ctx);
        if (check.kind !== 'decrypted' || check.accessToken !== opened.accessToken) {
          line(`  FAIL  ${label}  round-trip verification failed — left untouched`);
          failed += 1;
          continue;
        }
      }

      if (APPLY) {
        await prisma.brokerCredential.update({
          where: { id: row.id },
          data: { accessToken: nextValue },
        });
      }

      const from = opened.kind === 'legacy-plaintext' ? 'plaintext' : (credentialKeyId(row.accessToken) ?? '?');
      const to = DECRYPT ? 'plaintext' : active;
      line(`  ${APPLY ? 'DONE' : 'WOULD'}  ${label}  ${from} → ${to}`);
      ok += 1;
    } catch (err) {
      line(`  FAIL  ${label}  ${err instanceof Error ? err.message : String(err)}`);
      failed += 1;
    }
  }

  line('');
  line(`${APPLY ? 'Written' : 'Would write'}: ${ok}    Failed/skipped: ${failed}`);

  if (failed > 0) process.exitCode = 1;

  if (APPLY && ok > 0 && !DECRYPT) {
    line('');
    line('Sealing the live rows does not undo the exposure. Any backup taken while');
    line('this column was plaintext still contains working brokerage tokens.');
    line('Have users reconnect their broker accounts — Dhan tokens expire in 24h,');
    line('so the cost is one click and the exposure closes completely.');
  }
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
