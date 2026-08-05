-- Portfolio module rebuild: real T+1 settlement lifecycle (CNC Position ->
-- Holding), and a daily EOD read-model for Performance charts / the
-- Performance Diary.
--
-- Additive only: every new column on the existing Position table is
-- nullable, so this is safe against a populated table with no backfill.
--
-- WHY
--
-- Positions and Holdings previously had no distinction at all — every open
-- position (MIS/CNC/NRML) lived in one Position row forever. That's wrong for
-- CNC (cash & carry) equity: a real broker only calls delivered shares a
-- "holding" once T+1 settlement clears; until then it is still a Position.
-- MIS and F&O never settle to delivery and must never reach Holding.
--
-- Position.settlesAt / closeReason (see PositionCloseReason) drive that
-- lifecycle — SettlementService transfers a matured CNC position's quantity
-- into a Holding row and marks the source Position closeReason = 'SETTLED'
-- (never a Trade: no fill occurred). HoldingSettlement is the audit trail for
-- that transfer, kept even though nothing joins back to it via FK (it
-- references an already-flattened Position by id only — see the field's own
-- comment in schema.prisma for why that's a plain reference, not an FK).
--
-- PortfolioSnapshot is the second half of this migration: a once-daily EOD
-- capture Performance charts and the Performance Diary read from directly;
-- days before this feature existed are backfilled on read instead (see
-- PerformanceService), so no historical data needs to be invented here.

-- CreateEnum
CREATE TYPE "PositionCloseReason" AS ENUM ('FLATTENED', 'SETTLED');

-- AlterTable
ALTER TABLE "Position" ADD COLUMN     "closeReason" "PositionCloseReason",
ADD COLUMN     "settlesAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Holding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "avgCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "realizedPnl" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "firstAcquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Holding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HoldingSettlement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "costPrice" DECIMAL(12,2) NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HoldingSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "openingValue" DECIMAL(14,2) NOT NULL,
    "closingValue" DECIMAL(14,2) NOT NULL,
    "cashBalance" DECIMAL(14,2) NOT NULL,
    "holdingsValue" DECIMAL(14,2) NOT NULL,
    "positionsValue" DECIMAL(14,2) NOT NULL,
    "marginUsed" DECIMAL(14,2) NOT NULL,
    "realizedPnl" DECIMAL(14,2) NOT NULL,
    "unrealizedPnl" DECIMAL(14,2) NOT NULL,
    "charges" DECIMAL(14,2) NOT NULL,
    "tradesCount" INTEGER NOT NULL DEFAULT 0,
    "winCount" INTEGER NOT NULL DEFAULT 0,
    "lossCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Holding_userId_idx" ON "Holding"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Holding_userId_instrumentId_key" ON "Holding"("userId", "instrumentId");

-- CreateIndex
CREATE INDEX "HoldingSettlement_userId_instrumentId_idx" ON "HoldingSettlement"("userId", "instrumentId");

-- CreateIndex
CREATE INDEX "PortfolioSnapshot_userId_dateKey_idx" ON "PortfolioSnapshot"("userId", "dateKey");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioSnapshot_userId_dateKey_key" ON "PortfolioSnapshot"("userId", "dateKey");

-- AddForeignKey
ALTER TABLE "Holding" ADD CONSTRAINT "Holding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Holding" ADD CONSTRAINT "Holding_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HoldingSettlement" ADD CONSTRAINT "HoldingSettlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HoldingSettlement" ADD CONSTRAINT "HoldingSettlement_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioSnapshot" ADD CONSTRAINT "PortfolioSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
