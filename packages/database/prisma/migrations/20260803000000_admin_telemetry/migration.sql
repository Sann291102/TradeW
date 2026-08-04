-- Admin portal: privilege flag + telemetry tables.
--
-- Additive only. Every column added to an existing table has a default, so this
-- migration is safe to apply to a populated database without a backfill and
-- without taking a write lock long enough to matter.

-- AlterTable: admin privilege. Defaults false — no existing account gains
-- access by virtue of this migration running.
ALTER TABLE "User" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ApiCallLog" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "routeParams" JSONB,
    "statusCode" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "userId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCallLog" (
    "id" TEXT NOT NULL,
    "requestId" TEXT,
    "system" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tier" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentActivity" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "requestId" TEXT,
    "system" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "peer" TEXT,
    "detail" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "requestId" TEXT,
    "system" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "symbol" TEXT,
    "userId" TEXT,
    "agentsRan" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'running',
    "surfaced" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION,
    "error" TEXT,
    "durationMs" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiCallLog_createdAt_idx" ON "ApiCallLog"("createdAt");
CREATE INDEX "ApiCallLog_path_createdAt_idx" ON "ApiCallLog"("path", "createdAt");
CREATE INDEX "ApiCallLog_statusCode_createdAt_idx" ON "ApiCallLog"("statusCode", "createdAt");
CREATE INDEX "ApiCallLog_userId_createdAt_idx" ON "ApiCallLog"("userId", "createdAt");
CREATE INDEX "ApiCallLog_requestId_idx" ON "ApiCallLog"("requestId");

CREATE INDEX "AiCallLog_createdAt_idx" ON "AiCallLog"("createdAt");
CREATE INDEX "AiCallLog_system_createdAt_idx" ON "AiCallLog"("system", "createdAt");
CREATE INDEX "AiCallLog_agent_createdAt_idx" ON "AiCallLog"("agent", "createdAt");
CREATE INDEX "AiCallLog_status_createdAt_idx" ON "AiCallLog"("status", "createdAt");
CREATE INDEX "AiCallLog_requestId_idx" ON "AiCallLog"("requestId");

CREATE INDEX "AgentActivity_createdAt_idx" ON "AgentActivity"("createdAt");
CREATE INDEX "AgentActivity_runId_createdAt_idx" ON "AgentActivity"("runId", "createdAt");
CREATE INDEX "AgentActivity_agent_createdAt_idx" ON "AgentActivity"("agent", "createdAt");
CREATE INDEX "AgentActivity_system_createdAt_idx" ON "AgentActivity"("system", "createdAt");

CREATE UNIQUE INDEX "AgentRun_runId_key" ON "AgentRun"("runId");
CREATE INDEX "AgentRun_startedAt_idx" ON "AgentRun"("startedAt");
CREATE INDEX "AgentRun_system_startedAt_idx" ON "AgentRun"("system", "startedAt");
CREATE INDEX "AgentRun_status_startedAt_idx" ON "AgentRun"("status", "startedAt");
CREATE INDEX "AgentRun_userId_startedAt_idx" ON "AgentRun"("userId", "startedAt");

-- AddForeignKey
-- SET NULL, not CASCADE: deleting a user must not erase the operational record
-- of what the platform served. The rows stay, de-identified.
ALTER TABLE "ApiCallLog" ADD CONSTRAINT "ApiCallLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiCallLog" ADD CONSTRAINT "AiCallLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
