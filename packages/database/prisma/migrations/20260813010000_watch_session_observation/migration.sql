-- WatchSession + SentinelObservation: Sentinel (Python)'s watch engine state
-- and audit trail. Owned by services/sentinel-py, migrated here because
-- Prisma is the monorepo's single migration tool. See the P2 section of
-- services/sentinel-py/README.md.
--
-- Additive only. Safe to apply to a running deployment.

CREATE TABLE "WatchSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "strike" TEXT,
    "optionType" TEXT,
    "expiry" TEXT,
    "state" TEXT NOT NULL DEFAULT 'IDLE',
    "entryPrice" DECIMAL(12,2),
    "stopPrice" DECIMAL(12,2),
    "targetPrice" DECIMAL(12,2),
    "direction" TEXT,
    "lastNotifiedAt" TIMESTAMP(3),
    "cooldownUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WatchSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WatchSession_userId_idx" ON "WatchSession"("userId");

-- The sweep loop selects by state on every tick, so this one is hot.
CREATE INDEX "WatchSession_state_idx" ON "WatchSession"("state");

CREATE TABLE "SentinelObservation" (
    "id" TEXT NOT NULL,
    "watchSessionId" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "candleTime" TIMESTAMP(3),
    "ruleEvaluations" JSONB NOT NULL,
    "state" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SentinelObservation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SentinelObservation_watchSessionId_idx" ON "SentinelObservation"("watchSessionId");

-- Retention sweeps and the admin viewer both order by time.
CREATE INDEX "SentinelObservation_createdAt_idx" ON "SentinelObservation"("createdAt");
