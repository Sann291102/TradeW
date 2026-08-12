-- Operator accounts: the standalone admin console's identity store.
--
-- Additive only. Nothing existing is altered or dropped, so this migration is
-- safe to apply to a running deployment and safe to leave applied on one that
-- never creates a single row — an empty OperatorAccount table means the
-- operator login path simply denies everyone, and the product-admin path
-- (User.isAdmin + ADMIN_API_TOKEN) continues to work exactly as before.

CREATE TABLE "OperatorAccount" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "disabledAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "lastLoginIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatorAccount_pkey" PRIMARY KEY ("id")
);

-- Email is the login identifier, so uniqueness is a correctness requirement,
-- not an optimisation: two rows with the same address would make "which
-- operator did this?" ambiguous at exactly the moment it matters.
CREATE UNIQUE INDEX "OperatorAccount_email_key" ON "OperatorAccount"("email");

-- Every request re-checks revocation, so this one is on the hot path.
CREATE INDEX "OperatorAccount_disabledAt_idx" ON "OperatorAccount"("disabledAt");
