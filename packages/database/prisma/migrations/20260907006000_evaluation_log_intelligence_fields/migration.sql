-- Record what the INTELLIGENCE layer said, not only what the EXECUTION layer did.
--
-- `outcome` already says the execution layer waited. These say why: Sentinel's
-- own executable flag, the session state machine's position (which is what
-- `blockedBy=state-permits-guidance` actually refers to), and the strategy it
-- validated. On a session that produces no trade, these are the only columns
-- worth reading.
ALTER TABLE "ExecutionEvaluationLog" ADD COLUMN "executable" BOOLEAN;
ALTER TABLE "ExecutionEvaluationLog" ADD COLUMN "marketState" TEXT;
ALTER TABLE "ExecutionEvaluationLog" ADD COLUMN "strategyId" TEXT;
ALTER TABLE "ExecutionEvaluationLog" ADD COLUMN "strategyName" TEXT;
CREATE INDEX "ExecutionEvaluationLog_marketState_at_idx" ON "ExecutionEvaluationLog"("marketState", "at");
