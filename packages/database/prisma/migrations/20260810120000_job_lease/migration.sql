-- Singleton-job leases. See the JobLease model in schema.prisma for why this is
-- a row with an expiry rather than a Postgres advisory lock.
--
-- Additive only: one new table, no changes to any existing one, so this is safe
-- to apply ahead of the code that reads it and safe to leave in place if that
-- code is rolled back.
--
-- Authored by hand from `prisma migrate diff --from-url <live db> --script`
-- rather than `prisma migrate dev`, which refuses to run in a non-interactive
-- shell (see knowledge/_INDEX.md, Gotchas).

-- CreateTable
CREATE TABLE "JobLease" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "renewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobLease_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
-- Supports the "is any lease stale?" scan an operator runs during an incident;
-- acquisition itself goes through the primary key.
CREATE INDEX "JobLease_expiresAt_idx" ON "JobLease"("expiresAt");
