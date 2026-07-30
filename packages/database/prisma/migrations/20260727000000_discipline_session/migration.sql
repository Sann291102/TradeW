-- Discipline — self-imposed session limits (DisciplineSession + DisciplineOverride).
--
-- Two tables rather than one with a Json[] `overrides` column: the override
-- log exists to be read back ACROSS dates ("every loss-limit override this
-- quarter"), and a JSON array cannot be indexed for that. The child table is
-- append-only and carries a denormalised userId so those queries never need
-- the session join.
--
-- Both foreign keys are ON DELETE CASCADE. That is deliberate and differs from
-- every pre-existing FK in this schema (all of which default to RESTRICT):
-- discipline rows are the user's own behavioural record and must not be the
-- thing that makes an account deletion request impossible to fulfil.

-- CreateEnum
CREATE TYPE "DisciplineLimitType" AS ENUM ('MAX_TRADES', 'MAX_LOSS', 'MAX_MINUTES');

-- CreateTable
CREATE TABLE "DisciplineSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- IST calendar day as 'YYYY-MM-DD'; TEXT so the unique key below means
    -- exactly "one per IST trading day" regardless of the server's zone.
    "tradingDate" TEXT NOT NULL,
    "maxMinutes" INTEGER NOT NULL,
    "maxTrades" INTEGER NOT NULL,
    "maxLoss" DECIMAL(12,2) NOT NULL,
    "targetProfit" DECIMAL(12,2),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tradesTaken" INTEGER NOT NULL DEFAULT 0,
    "realizedPnl" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "targetNoticeSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DisciplineSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisciplineOverride" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "limitType" "DisciplineLimitType" NOT NULL,
    "reason" TEXT NOT NULL,
    -- Single-use guarantee for the override token. The unique index below is
    -- what enforces "one typed reason authorises one order" under concurrent
    -- placement; an application-level check would race.
    "tokenNonce" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisciplineOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DisciplineSession_userId_tradingDate_key" ON "DisciplineSession"("userId", "tradingDate");

-- CreateIndex
CREATE INDEX "DisciplineSession_userId_startedAt_idx" ON "DisciplineSession"("userId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DisciplineOverride_tokenNonce_key" ON "DisciplineOverride"("tokenNonce");

-- CreateIndex
CREATE INDEX "DisciplineOverride_userId_createdAt_idx" ON "DisciplineOverride"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "DisciplineOverride_userId_limitType_createdAt_idx" ON "DisciplineOverride"("userId", "limitType", "createdAt");

-- CreateIndex
CREATE INDEX "DisciplineOverride_sessionId_idx" ON "DisciplineOverride"("sessionId");

-- AddForeignKey
ALTER TABLE "DisciplineSession" ADD CONSTRAINT "DisciplineSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisciplineOverride" ADD CONSTRAINT "DisciplineOverride_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DisciplineSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisciplineOverride" ADD CONSTRAINT "DisciplineOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
