-- CreateEnum
CREATE TYPE "ResearchStatementType" AS ENUM ('income', 'balance', 'cash_flow');

-- CreateEnum
CREATE TYPE "ResearchPeriodType" AS ENUM ('annual', 'quarterly');

-- NOTE: `prisma migrate dev` also wanted to emit
--   ALTER TABLE "Order" ALTER COLUMN "updatedAt" DROP DEFAULT;
-- here. That is PRE-EXISTING DRIFT, not part of this change: migration
-- 20260722100001_oms_order_lifecycle added Order.updatedAt with
-- DEFAULT CURRENT_TIMESTAMP to backfill existing rows, while the schema
-- declares only @updatedAt. It has been outstanding since then and merely
-- surfaced in the next migration generated after it. It is deliberately NOT
-- included: this migration adds the research cache and nothing else, and
-- dropping a column default is a behavioural change for any writer that omits
-- the column, which belongs in its own reviewed migration.

-- CreateTable
CREATE TABLE "ResearchCompany" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "sector" TEXT,
    "industry" TEXT,
    "country" TEXT,
    "isin" TEXT,
    "website" TEXT,
    "employees" INTEGER,
    "description" TEXT,
    "source" TEXT NOT NULL,
    "sourceTimestamp" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchStatementFact" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "statementType" "ResearchStatementType" NOT NULL,
    "periodType" "ResearchPeriodType" NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "fiscalQuarter" INTEGER NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DECIMAL(30,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "basis" TEXT NOT NULL DEFAULT 'reported',
    "source" TEXT NOT NULL,
    "sourceTimestamp" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchStatementFact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResearchCompany_symbol_idx" ON "ResearchCompany"("symbol");

-- CreateIndex
CREATE INDEX "ResearchCompany_fetchedAt_idx" ON "ResearchCompany"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchCompany_symbol_exchange_key" ON "ResearchCompany"("symbol", "exchange");

-- CreateIndex
CREATE INDEX "ResearchStatementFact_symbol_statementType_periodType_perio_idx" ON "ResearchStatementFact"("symbol", "statementType", "periodType", "periodEnd");

-- CreateIndex
CREATE INDEX "ResearchStatementFact_fetchedAt_idx" ON "ResearchStatementFact"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchStatementFact_symbol_statementType_periodType_fisca_key" ON "ResearchStatementFact"("symbol", "statementType", "periodType", "fiscalYear", "fiscalQuarter", "metric");
