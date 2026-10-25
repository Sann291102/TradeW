-- The autonomous brain's PAPER execution lifecycle.
--
-- `AutonomousTrade` sits between the immutable decision and the resolved
-- outcome: contract chosen, order placed, fill landed, stop ratcheted, exit
-- taken. `candidateId` is UNIQUE — one accepted candidate may produce at most
-- one execution lifecycle, which is what makes execution idempotent under a
-- repeated tick, a retry, or a crash between placing and recording.
--
-- Also completes the realised-entry fix on `AutonomousOutcome`: the shadow
-- walk previously measured R from the PLANNED entry while starting on the next
-- bar, leaving any gap between them unmodelled. Both are now recorded.
--
-- The two DropIndex statements `prisma migrate diff` proposes
-- (ExecutionEvaluationLog_marketState_at_idx, UniverseInstrument_symbol_idx)
-- are PRE-EXISTING drift unrelated to this change and are deliberately omitted.

-- AlterTable
ALTER TABLE "AutonomousOutcome" ADD COLUMN     "entryPrice" DECIMAL(18,8),
ADD COLUMN     "plannedEntryPrice" DECIMAL(18,8);

-- CreateTable
CREATE TABLE "AutonomousTrade" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "brainVersion" TEXT NOT NULL,
    "tradedSymbol" TEXT NOT NULL,
    "instrumentId" TEXT,
    "optionType" TEXT,
    "strike" DECIMAL(18,4),
    "expiry" TIMESTAMP(3),
    "lotSize" INTEGER NOT NULL,
    "lots" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "indexEntry" DECIMAL(18,8),
    "indexStop" DECIMAL(18,8),
    "indexTarget" DECIMAL(18,8),
    "indexFirstReward" DECIMAL(18,8),
    "plannedEntry" DECIMAL(18,8) NOT NULL,
    "initialStop" DECIMAL(18,8) NOT NULL,
    "initialTarget" DECIMAL(18,8) NOT NULL,
    "firstRewardPrice" DECIMAL(18,8) NOT NULL,
    "initialRisk" DECIMAL(18,8) NOT NULL,
    "initialReward" DECIMAL(18,8) NOT NULL,
    "plannedRR" DECIMAL(8,3) NOT NULL,
    "premiumTranslation" JSONB,
    "walletEquity" DECIMAL(18,2) NOT NULL,
    "riskBudget" DECIMAL(18,2) NOT NULL,
    "stopDistance" DECIMAL(18,8) NOT NULL,
    "calculatedQuantity" INTEGER NOT NULL,
    "approvedQuantity" INTEGER NOT NULL,
    "sizingRationale" JSONB NOT NULL,
    "entryOrderId" TEXT,
    "orderStatus" TEXT NOT NULL,
    "actualFillPrice" DECIMAL(18,8),
    "filledQuantity" INTEGER,
    "entryAt" TIMESTAMP(3),
    "positionStatus" TEXT NOT NULL,
    "currentStop" DECIMAL(18,8) NOT NULL,
    "highWaterPrice" DECIMAL(18,8),
    "trailSteps" INTEGER NOT NULL DEFAULT 0,
    "trailActivated" BOOLEAN NOT NULL DEFAULT false,
    "lastManagedAt" TIMESTAMP(3),
    "exitOrderId" TEXT,
    "exitPrice" DECIMAL(18,8),
    "exitAt" TIMESTAMP(3),
    "exitReason" TEXT,
    "realizedPnl" DECIMAL(18,2),
    "charges" DECIMAL(18,2),
    "realizedR" DECIMAL(10,3),
    "mfePrice" DECIMAL(18,8),
    "maePrice" DECIMAL(18,8),
    "mfeR" DECIMAL(10,3),
    "maeR" DECIMAL(10,3),
    "holdingSeconds" INTEGER,
    "executionAssumptions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutonomousTrade_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AutonomousTrade_candidateId_key" ON "AutonomousTrade"("candidateId");

-- CreateIndex
CREATE INDEX "AutonomousTrade_positionStatus_createdAt_idx" ON "AutonomousTrade"("positionStatus", "createdAt");

-- CreateIndex
CREATE INDEX "AutonomousTrade_market_createdAt_idx" ON "AutonomousTrade"("market", "createdAt");

-- CreateIndex
CREATE INDEX "AutonomousTrade_symbol_createdAt_idx" ON "AutonomousTrade"("symbol", "createdAt");

-- CreateIndex
CREATE INDEX "AutonomousTrade_brainVersion_createdAt_idx" ON "AutonomousTrade"("brainVersion", "createdAt");

-- AddForeignKey
ALTER TABLE "AutonomousTrade" ADD CONSTRAINT "AutonomousTrade_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "AutonomousCandidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "AutonomousCandidate_symbol_setupId_timeframe_signalBarAt_acce_k" RENAME TO "AutonomousCandidate_symbol_setupId_timeframe_signalBarAt_ac_key";

