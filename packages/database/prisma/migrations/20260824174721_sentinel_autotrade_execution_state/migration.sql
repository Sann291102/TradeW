-- Sentinel Premium AutoTrade — the execution state machine, the paper→live
-- qualification record, and the per-pass observability log.
--
-- ADDITIVE ONLY. Every new column is nullable or carries a default, every new
-- table is new, and nothing is dropped or retyped — so this migration cannot
-- lose an existing profile, intent, order or outcome. The one data statement is
-- the BACKFILL at the bottom, which exists precisely so that applying this does
-- not change what any already-armed profile does.

-- CreateEnum
CREATE TYPE "ExecutionProfileState" AS ENUM ('DISABLED', 'PAPER_ARMED', 'PAPER_RUNNING', 'PAPER_QUALIFIED', 'LIVE_ARMED', 'LIVE_RUNNING', 'PAUSED', 'DISARMED', 'ERROR');

-- AlterEnum
ALTER TYPE "ExecutionEnvironment" ADD VALUE 'LIVE';

-- AlterTable
ALTER TABLE "ExecutionIntent" ADD COLUMN     "brokerOrderId" TEXT,
ADD COLUMN     "brokerOrderStatus" TEXT,
ADD COLUMN     "brokerSubmittedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ExecutionProfile" ADD COLUMN     "autoTradeEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoTradeEnabledAt" TIMESTAMP(3),
ADD COLUMN     "disarmedAt" TIMESTAMP(3),
ADD COLUMN     "disarmedBy" TEXT,
ADD COLUMN     "lastDecisionAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastErrorAt" TIMESTAMP(3),
ADD COLUMN     "lastFillAt" TIMESTAMP(3),
ADD COLUMN     "lastOrderAt" TIMESTAMP(3),
ADD COLUMN     "lastRunAt" TIMESTAMP(3),
ADD COLUMN     "liveArmedAt" TIMESTAMP(3),
ADD COLUMN     "liveArmedBy" TEXT,
ADD COLUMN     "paperArmedAt" TIMESTAMP(3),
ADD COLUMN     "paperArmedBy" TEXT,
ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "pausedReason" TEXT,
ADD COLUMN     "qualMaxCriticalErrors" INTEGER,
ADD COLUMN     "qualMaxDrawdownPct" DOUBLE PRECISION,
ADD COLUMN     "qualMaxLosingStreak" INTEGER,
ADD COLUMN     "qualMinNetPnl" DECIMAL(14,2),
ADD COLUMN     "qualMinTrades" INTEGER,
ADD COLUMN     "qualMinTradingDays" INTEGER,
ADD COLUMN     "qualMinWinRate" DOUBLE PRECISION,
ADD COLUMN     "resumeState" "ExecutionProfileState",
ADD COLUMN     "state" "ExecutionProfileState" NOT NULL DEFAULT 'DISABLED';

-- CreateTable
CREATE TABLE "ExecutionStateTransition" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "fromState" "ExecutionProfileState" NOT NULL,
    "toState" "ExecutionProfileState" NOT NULL,
    "environment" "ExecutionEnvironment" NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT,
    "qualificationSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionStateTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionRun" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "environment" "ExecutionEnvironment" NOT NULL,
    "symbol" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'scheduler',
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "intentId" TEXT,
    "orderId" TEXT,
    "sentinelRunId" TEXT,
    "rejectCheckId" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "latencyMs" INTEGER,

    CONSTRAINT "ExecutionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionQualification" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "trades" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "scratches" INTEGER NOT NULL DEFAULT 0,
    "winRate" DOUBLE PRECISION,
    "netPnl" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "grossProfit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "grossLoss" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "maxDrawdownPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "maxLosingStreak" INTEGER NOT NULL DEFAULT 0,
    "tradingDays" INTEGER NOT NULL DEFAULT 0,
    "criticalErrors" INTEGER NOT NULL DEFAULT 0,
    "firstTradeAt" TIMESTAMP(3),
    "lastTradeAt" TIMESTAMP(3),
    "criteria" JSONB NOT NULL,
    "results" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionQualification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExecutionStateTransition_profileId_createdAt_idx" ON "ExecutionStateTransition"("profileId", "createdAt");

-- CreateIndex
CREATE INDEX "ExecutionStateTransition_toState_createdAt_idx" ON "ExecutionStateTransition"("toState", "createdAt");

-- CreateIndex
CREATE INDEX "ExecutionRun_profileId_startedAt_idx" ON "ExecutionRun"("profileId", "startedAt");

-- CreateIndex
CREATE INDEX "ExecutionRun_outcome_startedAt_idx" ON "ExecutionRun"("outcome", "startedAt");

-- CreateIndex
CREATE INDEX "ExecutionRun_userId_startedAt_idx" ON "ExecutionRun"("userId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionQualification_profileId_key" ON "ExecutionQualification"("profileId");

-- CreateIndex
CREATE INDEX "ExecutionQualification_passed_idx" ON "ExecutionQualification"("passed");

-- CreateIndex
CREATE INDEX "ExecutionProfile_state_idx" ON "ExecutionProfile"("state");

-- CreateIndex
CREATE INDEX "ExecutionProfile_accountUserId_idx" ON "ExecutionProfile"("accountUserId");

-- AddForeignKey
ALTER TABLE "ExecutionStateTransition" ADD CONSTRAINT "ExecutionStateTransition_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ExecutionProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionRun" ADD CONSTRAINT "ExecutionRun_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ExecutionProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionQualification" ADD CONSTRAINT "ExecutionQualification_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ExecutionProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- BACKFILL: preserve the behaviour of every profile that already existed.
--
-- `state` defaults to DISABLED, and `ExecutionProfile.enabled` was the ONLY
-- authorization before this migration. Applying the default to a live
-- deployment would therefore silently disarm every profile an operator had
-- already armed — a change of behaviour smuggled in through a schema change,
-- and one that would look like the agent simply going quiet.
--
-- So an already-enabled profile becomes PAPER_ARMED (its environment can only
-- be PAPER: LIVE did not exist until this migration), and a disabled one stays
-- DISABLED. `paperArmedAt` is set to the profile's own updatedAt rather than
-- now(), because the arming happened then and inventing a fresh timestamp would
-- put a false entry in the audit story this feature exists to tell.
-- ---------------------------------------------------------------------------
UPDATE "ExecutionProfile"
SET "state" = 'PAPER_ARMED',
    "paperArmedAt" = "updatedAt",
    "paperArmedBy" = 'migration:pre-state-machine'
WHERE "enabled" = true;

-- The mirror runs the other way too: a profile that was never enabled must read
-- as DISABLED, which the column default already gives it. Stated as a no-op
-- assertion rather than left implicit, so the invariant `enabled =
-- isExecutingState(state)` is true for every row the moment this commits.
UPDATE "ExecutionProfile"
SET "state" = 'DISABLED'
WHERE "enabled" = false AND "state" <> 'DISABLED';
