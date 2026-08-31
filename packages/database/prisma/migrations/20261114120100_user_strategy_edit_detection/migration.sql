-- Edit detection for armed user-strategy agents.
--
-- Nullable and with no backfill: an existing profile has no armed-at hash, and
-- the agent treats "no hash recorded" as "nothing to compare against" rather
-- than as a mismatch. A profile therefore cannot be disarmed by the mere
-- arrival of this column.
ALTER TABLE "ExecutionProfile" ADD COLUMN "strategyRulesHash" TEXT;
