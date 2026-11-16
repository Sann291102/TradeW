-- The autonomous brain's learning dataset.
--
-- Three tables: what the brain SAW (AutonomousScan), what it DECIDED
-- (AutonomousCandidate, never updated after insert) and what actually HAPPENED
-- (AutonomousOutcome, written later by the resolver).
--
-- The brain executes nothing. These tables exist so it can be wrong at no cost
-- while the dataset that would let it stop being wrong accumulates.
--
-- NOTE: `prisma migrate diff` also proposed dropping
-- `ExecutionEvaluationLog_marketState_at_idx` and `UniverseInstrument_symbol_idx`.
-- Those are PRE-EXISTING drift between the live database and schema.prisma, with
-- nothing to do with this change, so they are deliberately NOT included here.

-- CreateEnum
CREATE TYPE "AutonomousScanStatus" AS ENUM ('SCANNED', 'SKIPPED_CLOSED', 'SKIPPED_DISABLED', 'DATA_UNAVAILABLE', 'NOT_TRADABLE');

-- CreateEnum
CREATE TYPE "AutonomousOutcomeStatus" AS ENUM ('TARGET_HIT', 'STOP_HIT', 'EXPIRED', 'UNRESOLVED', 'UNEVALUABLE');

-- CreateTable
CREATE TABLE "AutonomousScan" (
    "id" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signalBarAt" TIMESTAMP(3),
    "status" "AutonomousScanStatus" NOT NULL,
    "detail" TEXT,
    "dataSource" TEXT,
    "dataAgeSeconds" INTEGER,
    "lastPrice" DECIMAL(18,8),
    "regime" TEXT,
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "brainVersion" TEXT NOT NULL,
    "sentinelVerdict" TEXT,
    "sentinelExecutable" BOOLEAN,
    "sentinelConfidence" DECIMAL(6,2),
    "sentinelStrategyId" TEXT,
    "sentinelMarketState" TEXT,
    "agreement" TEXT,

    CONSTRAINT "AutonomousScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutonomousCandidate" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signalBarAt" TIMESTAMP(3),
    "setupId" TEXT NOT NULL,
    "setupName" TEXT NOT NULL,
    "setupVersion" TEXT NOT NULL,
    "archetype" TEXT NOT NULL,
    "brainVersion" TEXT NOT NULL,
    "bias" TEXT NOT NULL,
    "direction" TEXT,
    "quality" INTEGER NOT NULL,
    "accepted" BOOLEAN NOT NULL,
    "rejectionReason" TEXT,
    "rejectionDetail" TEXT,
    "entry" DECIMAL(18,8),
    "stop" DECIMAL(18,8),
    "target" DECIMAL(18,8),
    "riskPerUnit" DECIMAL(18,8),
    "rewardPerUnit" DECIMAL(18,8),
    "plannedRR" DECIMAL(6,2),
    "riskAtr" DECIMAL(8,3),
    "targetAtr" DECIMAL(8,3),
    "anchorArchetype" TEXT,
    "anchorLevel" DECIMAL(18,8),
    "anchorNote" TEXT,
    "regime" TEXT,
    "features" JSONB NOT NULL,
    "confirmed" JSONB NOT NULL,
    "unmet" JSONB NOT NULL,
    "invalidated" JSONB NOT NULL,
    "explanation" TEXT NOT NULL,

    CONSTRAINT "AutonomousCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutonomousOutcome" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "status" "AutonomousOutcomeStatus" NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evaluatedThroughAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "barsToOutcome" INTEGER,
    "secondsToOutcome" INTEGER,
    "exitPrice" DECIMAL(18,8),
    "actualR" DECIMAL(10,3),
    "mfePrice" DECIMAL(18,8),
    "maePrice" DECIMAL(18,8),
    "mfeR" DECIMAL(10,3),
    "maeR" DECIMAL(10,3),
    "postExitHigh" DECIMAL(18,8),
    "postExitLow" DECIMAL(18,8),
    "wouldHaveHitTarget" BOOLEAN,
    "unevaluableReason" TEXT,

    CONSTRAINT "AutonomousOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutonomousScan_market_scannedAt_idx" ON "AutonomousScan"("market", "scannedAt");

-- CreateIndex
CREATE INDEX "AutonomousScan_status_scannedAt_idx" ON "AutonomousScan"("status", "scannedAt");

-- CreateIndex
CREATE INDEX "AutonomousScan_brainVersion_scannedAt_idx" ON "AutonomousScan"("brainVersion", "scannedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutonomousScan_symbol_timeframe_signalBarAt_key" ON "AutonomousScan"("symbol", "timeframe", "signalBarAt");

-- CreateIndex
CREATE INDEX "AutonomousCandidate_market_decidedAt_idx" ON "AutonomousCandidate"("market", "decidedAt");

-- CreateIndex
CREATE INDEX "AutonomousCandidate_setupId_accepted_decidedAt_idx" ON "AutonomousCandidate"("setupId", "accepted", "decidedAt");

-- CreateIndex
CREATE INDEX "AutonomousCandidate_accepted_rejectionReason_idx" ON "AutonomousCandidate"("accepted", "rejectionReason");

-- CreateIndex
CREATE INDEX "AutonomousCandidate_brainVersion_decidedAt_idx" ON "AutonomousCandidate"("brainVersion", "decidedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutonomousCandidate_symbol_setupId_timeframe_signalBarAt_key" ON "AutonomousCandidate"("symbol", "setupId", "timeframe", "signalBarAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutonomousOutcome_candidateId_key" ON "AutonomousOutcome"("candidateId");

-- CreateIndex
CREATE INDEX "AutonomousOutcome_status_evaluatedAt_idx" ON "AutonomousOutcome"("status", "evaluatedAt");

-- CreateIndex
CREATE INDEX "AutonomousOutcome_resolvedAt_idx" ON "AutonomousOutcome"("resolvedAt");

-- AddForeignKey
ALTER TABLE "AutonomousCandidate" ADD CONSTRAINT "AutonomousCandidate_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "AutonomousScan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutonomousOutcome" ADD CONSTRAINT "AutonomousOutcome_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "AutonomousCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

