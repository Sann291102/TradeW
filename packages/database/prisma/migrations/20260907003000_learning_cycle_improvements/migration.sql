-- Staged learning: experience -> learning -> candidate -> validation -> promotion.
--
-- The safety property these tables encode is that a candidate improvement is an
-- INERT ROW. It records what it would change and why; it changes nothing. Only
-- an operator can move it to PROMOTED, and `kind` is a closed set in which
-- every member is risk-neutral or risk-reducing — there is no representable
-- proposal that widens a stop, raises size/exposure, lifts a loss limit, or
-- lowers the platform confidence floor.
CREATE TYPE "ExecutionImprovementStatus" AS ENUM ('PROPOSED', 'VALIDATING', 'VALIDATED', 'REJECTED', 'PROMOTED');

CREATE TABLE "ExecutionLearningCycle" (
    "id" TEXT NOT NULL,
    "sessionDate" TEXT NOT NULL,
    "profileId" TEXT,
    "agent" TEXT NOT NULL,
    "tradesAnalysed" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "rejectedSetups" INTEGER NOT NULL DEFAULT 0,
    "metrics" JSONB NOT NULL,
    "observations" JSONB NOT NULL,
    "report" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionLearningCycle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExecutionLearningCycle_sessionDate_profileId_key" ON "ExecutionLearningCycle"("sessionDate", "profileId");
CREATE INDEX "ExecutionLearningCycle_agent_sessionDate_idx" ON "ExecutionLearningCycle"("agent", "sessionDate");

CREATE TABLE "ExecutionImprovement" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT,
    "profileId" TEXT,
    "agent" TEXT NOT NULL,
    "bucketKey" TEXT,
    "kind" TEXT NOT NULL,
    "currentValue" JSONB NOT NULL,
    "proposedValue" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" "ExecutionImprovementStatus" NOT NULL DEFAULT 'PROPOSED',
    "validation" JSONB,
    "validatedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "promotedAt" TIMESTAMP(3),
    "promotedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionImprovement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExecutionImprovement_status_createdAt_idx" ON "ExecutionImprovement"("status", "createdAt");
CREATE INDEX "ExecutionImprovement_agent_kind_idx" ON "ExecutionImprovement"("agent", "kind");
CREATE INDEX "ExecutionImprovement_profileId_status_idx" ON "ExecutionImprovement"("profileId", "status");

ALTER TABLE "ExecutionLearningCycle" ADD CONSTRAINT "ExecutionLearningCycle_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ExecutionProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExecutionImprovement" ADD CONSTRAINT "ExecutionImprovement_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "ExecutionLearningCycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
