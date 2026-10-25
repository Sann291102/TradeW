-- Every evaluation pass, including the ones that decided nothing.
--
-- On 2026-09-07 the loop evaluated the live market 1,616 times and left no
-- queryable trace: the only evidence it had run was a text log in another
-- service, so "the agent is waiting" and "the agent is dead" were
-- indistinguishable to anyone reading the database. This is the attendance
-- record. ExecutionIntent remains the record of DECISIONS and is deliberately
-- still not written on a quiet pass.
CREATE TYPE "ExecutionEvaluationOutcome" AS ENUM (
  'WAIT', 'REJECTED', 'PLANNED', 'SUBMITTED', 'FILLED',
  'DUPLICATE', 'FAILED', 'HALTED', 'MARKET_CLOSED', 'DISABLED', 'UNAUTHORIZED'
);

CREATE TABLE "ExecutionEvaluationLog" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" "ExecutionEvaluationOutcome" NOT NULL,
    "verdict" TEXT,
    "reason" TEXT NOT NULL,
    "checkId" TEXT,
    "confidence" DECIMAL(6,2),
    "spot" DECIMAL(12,2),
    "regime" TEXT,
    "indexDirection" TEXT,
    "gates" JSONB,
    "intentId" TEXT,

    CONSTRAINT "ExecutionEvaluationLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExecutionEvaluationLog_profileId_at_idx" ON "ExecutionEvaluationLog"("profileId", "at");
CREATE INDEX "ExecutionEvaluationLog_outcome_at_idx" ON "ExecutionEvaluationLog"("outcome", "at");
CREATE INDEX "ExecutionEvaluationLog_checkId_at_idx" ON "ExecutionEvaluationLog"("checkId", "at");
CREATE INDEX "ExecutionEvaluationLog_at_idx" ON "ExecutionEvaluationLog"("at");

ALTER TABLE "ExecutionEvaluationLog" ADD CONSTRAINT "ExecutionEvaluationLog_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ExecutionProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
