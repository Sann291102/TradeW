-- CreateEnum
CREATE TYPE "LabEventKind" AS ENUM ('LAB_STARTED', 'LAB_STOPPED', 'HEALTH_DEGRADED', 'HEALTH_RECOVERED', 'SESSION_OPENED', 'SESSION_CLOSED', 'OBSERVING', 'OBSERVATION_SKIPPED', 'SETUP_CANDIDATE', 'SETUP_REJECTED', 'STRATEGY_SELECTED', 'TRADE_PROPOSAL', 'RISK_ASSESSMENT', 'EXECUTION_RESULT', 'SETUP_WEAKENING', 'SETUP_INVALIDATED', 'TRADE_OUTCOME', 'POST_TRADE_ANALYSIS', 'LEARNING_CANDIDATE', 'KILL_SWITCH', 'COMMAND_ACCEPTED', 'COMMAND_REJECTED');

-- CreateEnum
CREATE TYPE "LabEventSeverity" AS ENUM ('INFO', 'WARN', 'ERROR');

-- AlterTable
ALTER TABLE "ExecutionProfile" ADD COLUMN     "labEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "labTimeframe" TEXT;

-- CreateTable
CREATE TABLE "ExperimentEvent" (
    "id" TEXT NOT NULL,
    "profileId" TEXT,
    "experimentId" TEXT,
    "kind" "LabEventKind" NOT NULL,
    "severity" "LabEventSeverity" NOT NULL DEFAULT 'INFO',
    "at" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbol" TEXT,
    "timeframe" TEXT,
    "actor" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "detail" JSONB,
    "dataAvailability" JSONB,
    "dedupeKey" TEXT NOT NULL,

    CONSTRAINT "ExperimentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExperimentEvent_dedupeKey_key" ON "ExperimentEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "ExperimentEvent_profileId_at_idx" ON "ExperimentEvent"("profileId", "at");

-- CreateIndex
CREATE INDEX "ExperimentEvent_kind_at_idx" ON "ExperimentEvent"("kind", "at");

-- CreateIndex
CREATE INDEX "ExperimentEvent_at_idx" ON "ExperimentEvent"("at");

-- CreateIndex
CREATE INDEX "ExperimentEvent_experimentId_idx" ON "ExperimentEvent"("experimentId");

-- AddForeignKey
ALTER TABLE "ExperimentEvent" ADD CONSTRAINT "ExperimentEvent_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ExecutionProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
