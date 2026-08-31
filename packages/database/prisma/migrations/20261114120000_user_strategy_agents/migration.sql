-- CreateEnum
CREATE TYPE "ExecutionAgentMode" AS ENUM ('SHADOW', 'LIVE');

-- AlterTable
ALTER TABLE "ExecutionProfile" ADD COLUMN     "agentMode" "ExecutionAgentMode" NOT NULL DEFAULT 'SHADOW',
ADD COLUMN     "certificationStatus" TEXT,
ADD COLUMN     "certifiedAt" TIMESTAMP(3),
ADD COLUMN     "strategyTimeframe" TEXT,
ADD COLUMN     "userStrategyId" TEXT;

-- CreateTable
CREATE TABLE "StrategyAgentDecision" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "userStrategyId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "barTime" TIMESTAMP(3) NOT NULL,
    "verdict" TEXT NOT NULL,
    "refusal" TEXT,
    "reason" TEXT NOT NULL,
    "mode" "ExecutionAgentMode" NOT NULL,
    "conditions" JSONB,
    "intentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyAgentDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StrategyAgentDecision_intentId_key" ON "StrategyAgentDecision"("intentId");

-- CreateIndex
CREATE INDEX "StrategyAgentDecision_profileId_createdAt_idx" ON "StrategyAgentDecision"("profileId", "createdAt");

-- CreateIndex
CREATE INDEX "StrategyAgentDecision_verdict_createdAt_idx" ON "StrategyAgentDecision"("verdict", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StrategyAgentDecision_profileId_barTime_key" ON "StrategyAgentDecision"("profileId", "barTime");

-- AddForeignKey
ALTER TABLE "StrategyAgentDecision" ADD CONSTRAINT "StrategyAgentDecision_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ExecutionProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyAgentDecision" ADD CONSTRAINT "StrategyAgentDecision_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "ExecutionIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

