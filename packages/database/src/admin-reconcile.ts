/**
 * Deciding WHICH admin grants to withdraw — the pure half of `admin:reconcile`.
 *
 * ── WHY A CLEANUP TOOL EXISTS AT ALL ──────────────────────────────────────
 *
 * `scripts/create-admin.ts` (removed 2026-09-03) ended with:
 *
 *     await prisma.user.updateMany({ data: { isAdmin: true } });
 *
 * — no `where`. Every row in `User`, present and past, became an application
 * administrator. Not an administrator OF THEIR OWN ACCOUNT, which every user
 * already is; an administrator of TradeW, the flag `AdminGuard` reads to decide
 * who may see every user's orders, trades and audit trail.
 *
 * Deleting the script stops it happening again. It does not un-grant anything:
 * the flag is a column, and it is still `true` on every row the script touched.
 * That is what this reconciles.
 *
 * ── WHY REVOKE-ONLY ───────────────────────────────────────────────────────
 *
 * This plans revocations and nothing else. A bulk tool that can also GRANT
 * admin is a strange thing to keep next to production credentials, and the
 * repo already has the narrow, one-email-at-a-time granter (`admin:grant`,
 * which is also the only way the first admin is ever made). Splitting them
 * means the dangerous direction stays deliberate and singular, while the safe
 * direction is the one that can act on many rows at once.
 *
 * The comparison is pure so the decision can be tested exhaustively without a
 * database — the script around it does the reading and writing.
 */

/** The fields the planner needs. Deliberately not the whole `User`. */
export interface AdminRow {
  id: string;
  email: string;
}

export interface ReconcilePlan {
  /** Currently admins, not on the keep list — `isAdmin` will be cleared. */
  revoke: AdminRow[];
  /** Currently admins and on the keep list — left exactly as they are. */
  keep: AdminRow[];
  /**
   * Keep-list entries matching no current admin. Reported rather than acted
   * on: a typo in `--keep` would otherwise silently revoke the person it was
   * meant to protect, and this tool never grants, so it cannot "fix" them
   * either. Both facts are worth saying out loud before anything is written.
   */
  unmatched: string[];
}

/**
 * Accounts are stored lower-cased by signup, but the bulk grant upserted the
 * raw strings it was given, so a database written by it can hold mixed case.
 * Both sides are normalised before comparison for that reason.
 */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Split the `--keep` value(s) into normalised addresses.
 *
 * Accepts repeated flags and comma-separated lists interchangeably, because
 * both are what people actually type. Empty entries are dropped rather than
 * kept as a `''` that matches nothing.
 */
export function parseKeepList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    for (const part of value.split(',')) {
      const email = normaliseEmail(part);
      if (email) seen.add(email);
    }
  }
  return [...seen];
}

/**
 * Partition today's admins into keep and revoke.
 *
 * `admins` is what the database says right now — the caller passes only rows
 * with `isAdmin = true`, so an account that was never an admin can never
 * appear in `revoke` and cannot be "revoked" into a no-op audit row.
 */
export function planReconcile(admins: readonly AdminRow[], keepEmails: readonly string[]): ReconcilePlan {
  const keepSet = new Set(keepEmails.map(normaliseEmail));

  const keep: AdminRow[] = [];
  const revoke: AdminRow[] = [];
  const matched = new Set<string>();

  for (const admin of admins) {
    const email = normaliseEmail(admin.email);
    if (keepSet.has(email)) {
      keep.push(admin);
      matched.add(email);
    } else {
      revoke.push(admin);
    }
  }

  return {
    revoke,
    keep,
    unmatched: [...keepSet].filter((email) => !matched.has(email)).sort(),
  };
}

/**
 * Would applying this plan leave the deployment with no application admin?
 *
 * Not fatal, and deliberately not framed as such: operator-console access is a
 * SEPARATE identity space (`OperatorAccount` + `ADMIN_API_TOKEN`, see
 * `AdminAccessGuard`), so zero `User.isAdmin` rows does not mean nobody can
 * administer anything. It is still worth an explicit confirmation, because the
 * one thing worse than too many admins is discovering you meant to keep one.
 */
export function leavesNoAdmins(plan: ReconcilePlan): boolean {
  return plan.keep.length === 0 && plan.revoke.length > 0;
}
