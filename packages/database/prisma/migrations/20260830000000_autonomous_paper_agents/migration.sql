-- ============================================================================
-- AUTONOMOUS PAPER AGENTS
--
-- Everything the Sentinel paper-execution loop needed to become a complete
-- trade lifecycle rather than an entry: a risk plan written before the order,
-- a managed position holding the stop/target/trail, the trail's own history,
-- a journal per completed trade, and the one calibration value a completed
-- trade is allowed to move.
--
-- EVERY COLUMN IS ADDITIVE AND EVERY DEFAULT MATCHES THE PRE-EXISTING
-- BEHAVIOUR. An ExecutionProfile that existed before this migration keeps its
-- exact sizing and gating; the new percentages only take effect once the risk
-- planner runs, and the planner is reached only through the new entry path.
-- No backfill is required and none is performed.
--
-- `ExecutionEnvironment` is UNTOUCHED. It still has exactly one member, PAPER.
-- Nothing in this migration creates a representation of live money.
-- ============================================================================

-- CreateEnum
CREATE TYPE "ExecutionPositionState" AS ENUM ('OPEN', 'EXITING', 'CLOSED');

-- ---------------------------------------------------------------------------
-- ExecutionProfile: capital, risk, trailing, data-quality floors, roster.
-- ---------------------------------------------------------------------------
ALTER TABLE "ExecutionProfile"
  ADD COLUMN "capitalAllocationPct" DECIMAL(6,3) NOT NULL DEFAULT 20,
  ADD COLUMN "riskPerTradePct"      DECIMAL(6,3) NOT NULL DEFAULT 3,
  ADD COLUMN "rewardPerTradePct"    DECIMAL(6,3) NOT NULL DEFAULT 9,
  ADD COLUMN "trailStepPoints"      DECIMAL(10,2) NOT NULL DEFAULT 3,
  ADD COLUMN "maxQuoteAgeMs"        INTEGER NOT NULL DEFAULT 15000,
  ADD COLUMN "maxBarAgeMinutes"     INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "minCandles"           INTEGER NOT NULL DEFAULT 40,
  ADD COLUMN "strategyIds"          TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "manageIntervalMs"     INTEGER;

-- ---------------------------------------------------------------------------
-- ExecutionIntent: what the agent knew, and the plan it wrote before ordering.
-- ---------------------------------------------------------------------------
ALTER TABLE "ExecutionIntent"
  ADD COLUMN "strategyVersion"       TEXT,
  ADD COLUMN "regime"                TEXT,
  ADD COLUMN "indexDirection"        TEXT,
  ADD COLUMN "indexStrength"         DOUBLE PRECISION,
  ADD COLUMN "indexEvidence"         JSONB,
  ADD COLUMN "dataQuality"           JSONB,
  ADD COLUMN "evidence"              JSONB,
  ADD COLUMN "confirmations"         JSONB,
  ADD COLUMN "walletEquity"          DECIMAL(14,2),
  ADD COLUMN "allocatedCapital"      DECIMAL(14,2),
  ADD COLUMN "riskBudget"            DECIMAL(14,2),
  ADD COLUMN "rewardTarget"          DECIMAL(14,2),
  ADD COLUMN "plannedEntryPrice"     DECIMAL(12,2),
  ADD COLUMN "stopPrice"             DECIMAL(12,2),
  ADD COLUMN "targetPrice"           DECIMAL(12,2),
  ADD COLUMN "riskPlan"              JSONB,
  ADD COLUMN "fillModel"             JSONB,
  ADD COLUMN "calibrationVersion"    INTEGER,
  ADD COLUMN "calibrationAdjustment" INTEGER;

-- ---------------------------------------------------------------------------
-- ExecutionPosition — the position under active management.
-- ---------------------------------------------------------------------------
CREATE TABLE "ExecutionPosition" (
    "id"              TEXT NOT NULL,
    "intentId"        TEXT NOT NULL,
    "profileId"       TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "instrumentId"    TEXT NOT NULL,
    "contractSymbol"  TEXT NOT NULL,
    "productType"     "ProductType" NOT NULL,
    "symbol"          TEXT NOT NULL,
    "optionType"      TEXT NOT NULL,
    "state"           "ExecutionPositionState" NOT NULL DEFAULT 'OPEN',
    "quantity"        INTEGER NOT NULL,
    "entryPrice"      DECIMAL(12,2) NOT NULL,
    "entryAt"         TIMESTAMP(3) NOT NULL,
    "stopPrice"       DECIMAL(12,2) NOT NULL,
    "targetPrice"     DECIMAL(12,2) NOT NULL,
    "trailPrice"      DECIMAL(12,2),
    "trailSteps"      INTEGER NOT NULL DEFAULT 0,
    "highWaterPrice"  DECIMAL(12,2) NOT NULL,
    "lastPrice"       DECIMAL(12,2),
    "lastPriceAt"     TIMESTAMP(3),
    "lastEvaluatedAt" TIMESTAMP(3),
    "unrealizedPnl"   DECIMAL(14,2),
    "exitReason"      TEXT,
    "exitDetail"      TEXT,
    "exitDecidedAt"   TIMESTAMP(3),
    "version"         INTEGER NOT NULL DEFAULT 0,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionPosition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExecutionPosition_intentId_key" ON "ExecutionPosition"("intentId");
-- The manager's hot query is "every position not yet CLOSED", every couple of
-- seconds. Without this it is a sequential scan on that cadence, forever.
CREATE INDEX "ExecutionPosition_state_idx" ON "ExecutionPosition"("state");
CREATE INDEX "ExecutionPosition_profileId_state_idx" ON "ExecutionPosition"("profileId", "state");
CREATE INDEX "ExecutionPosition_userId_state_idx" ON "ExecutionPosition"("userId", "state");

ALTER TABLE "ExecutionPosition"
  ADD CONSTRAINT "ExecutionPosition_intentId_fkey"
  FOREIGN KEY ("intentId") REFERENCES "ExecutionIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExecutionPosition"
  ADD CONSTRAINT "ExecutionPosition_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "ExecutionProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- ExecutionTrailAdjustment — every ratchet, append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE "ExecutionTrailAdjustment" (
    "id"             TEXT NOT NULL,
    "positionId"     TEXT NOT NULL,
    "fromPrice"      DECIMAL(12,2),
    "toPrice"        DECIMAL(12,2) NOT NULL,
    "triggerPrice"   DECIMAL(12,2) NOT NULL,
    "highWaterPrice" DECIMAL(12,2) NOT NULL,
    "stepsAdvanced"  INTEGER NOT NULL,
    "totalSteps"     INTEGER NOT NULL,
    "reason"         TEXT NOT NULL,
    "at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionTrailAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExecutionTrailAdjustment_positionId_at_idx" ON "ExecutionTrailAdjustment"("positionId", "at");

ALTER TABLE "ExecutionTrailAdjustment"
  ADD CONSTRAINT "ExecutionTrailAdjustment_positionId_fkey"
  FOREIGN KEY ("positionId") REFERENCES "ExecutionPosition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- ExecutionJournal — one row per completed automated paper trade.
-- ---------------------------------------------------------------------------
CREATE TABLE "ExecutionJournal" (
    "id"                 TEXT NOT NULL,
    "intentId"           TEXT NOT NULL,
    "profileId"          TEXT NOT NULL,
    "userId"             TEXT NOT NULL,
    "agent"              TEXT NOT NULL,
    "symbol"             TEXT NOT NULL,
    "strategyId"         TEXT,
    "strategyName"       TEXT,
    "strategyVersion"    TEXT,
    "regime"             TEXT,
    "underlying"         TEXT NOT NULL,
    "expiry"             TIMESTAMP(3) NOT NULL,
    "strike"             DECIMAL(12,2) NOT NULL,
    "optionType"         TEXT NOT NULL,
    "contractSymbol"     TEXT NOT NULL,
    "securityId"         TEXT,
    "lots"               INTEGER NOT NULL,
    "quantity"           INTEGER NOT NULL,
    "indexDirection"     TEXT,
    "indexStrength"      DOUBLE PRECISION,
    "confidence"         INTEGER NOT NULL,
    "evidence"           JSONB,
    "confirmations"      JSONB,
    "dataQuality"        JSONB,
    "rationale"          TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "publication"        JSONB,
    "optionContext"      JSONB,
    "policyChecks"       JSONB,
    "walletEquity"       DECIMAL(14,2),
    "allocatedCapital"   DECIMAL(14,2),
    "riskBudget"         DECIMAL(14,2),
    "rewardTarget"       DECIMAL(14,2),
    "initialStop"        DECIMAL(12,2),
    "initialTarget"      DECIMAL(12,2),
    "riskPlan"           JSONB,
    "fillModel"          JSONB,
    "entryAt"            TIMESTAMP(3) NOT NULL,
    "exitAt"             TIMESTAMP(3),
    "entryPrice"         DECIMAL(12,2) NOT NULL,
    "exitPrice"          DECIMAL(12,2),
    "trailHistory"       JSONB,
    "finalTrail"         DECIMAL(12,2),
    "exitReason"         TEXT NOT NULL,
    "exitDetail"         TEXT,
    "invalidationReason" TEXT,
    "holdingSeconds"     INTEGER,
    "realizedPnl"        DECIMAL(14,2) NOT NULL,
    "charges"            DECIMAL(14,2) NOT NULL DEFAULT 0,
    "rMultiple"          DECIMAL(10,3),
    "result"             TEXT NOT NULL,
    "calibrationKey"     TEXT,
    "calibrationVersion" INTEGER,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionJournal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExecutionJournal_intentId_key" ON "ExecutionJournal"("intentId");
CREATE INDEX "ExecutionJournal_profileId_entryAt_idx" ON "ExecutionJournal"("profileId", "entryAt");
CREATE INDEX "ExecutionJournal_symbol_entryAt_idx" ON "ExecutionJournal"("symbol", "entryAt");
CREATE INDEX "ExecutionJournal_strategyId_result_idx" ON "ExecutionJournal"("strategyId", "result");
CREATE INDEX "ExecutionJournal_calibrationKey_idx" ON "ExecutionJournal"("calibrationKey");

ALTER TABLE "ExecutionJournal"
  ADD CONSTRAINT "ExecutionJournal_intentId_fkey"
  FOREIGN KEY ("intentId") REFERENCES "ExecutionIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExecutionJournal"
  ADD CONSTRAINT "ExecutionJournal_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "ExecutionProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- StrategyCalibration — the ONE value a completed trade may move.
--
-- `confidenceAdjustment` is added to a bucket's ENTRY FLOOR, never to a
-- confidence score, and `execution-policy.ts` clamps the effective floor at
-- the constant 70 regardless of what is stored here. A row in this table
-- therefore cannot make a trade easier than the platform's own bar, only
-- harder — which is the only direction a learned value is allowed to move a
-- safety threshold.
-- ---------------------------------------------------------------------------
CREATE TABLE "StrategyCalibration" (
    "id"                   TEXT NOT NULL,
    "key"                  TEXT NOT NULL,
    "agent"                TEXT NOT NULL,
    "symbol"               TEXT NOT NULL,
    "strategyId"           TEXT NOT NULL,
    "strategyVersion"      TEXT NOT NULL,
    "regime"               TEXT NOT NULL,
    "trades"               INTEGER NOT NULL DEFAULT 0,
    "wins"                 INTEGER NOT NULL DEFAULT 0,
    "losses"               INTEGER NOT NULL DEFAULT 0,
    "scratches"            INTEGER NOT NULL DEFAULT 0,
    "grossPnl"             DECIMAL(16,2) NOT NULL DEFAULT 0,
    "avgRMultiple"         DECIMAL(10,3),
    "winRate"              DOUBLE PRECISION,
    "confidenceAdjustment" INTEGER NOT NULL DEFAULT 0,
    "version"              INTEGER NOT NULL DEFAULT 0,
    "lastOutcomeIntentId"  TEXT,
    "lastUpdatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyCalibration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StrategyCalibration_key_key" ON "StrategyCalibration"("key");
CREATE INDEX "StrategyCalibration_agent_symbol_idx" ON "StrategyCalibration"("agent", "symbol");
CREATE INDEX "StrategyCalibration_strategyId_regime_idx" ON "StrategyCalibration"("strategyId", "regime");
