-- AI Foundation + Subscription & Entitlements (Phase 3, 2026-07-16)
-- Hand-authored offline; matches schema.prisma. Verify with
-- `prisma migrate diff` against a live database before production deploy.

-- pgvector for MemoryRecord.embedding (available on Neon: CREATE EXTENSION vector)
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'TRIALING', 'PAST_DUE', 'GRACE', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "QuotaPeriod" AS ENUM ('DAY', 'MONTH', 'BILLING_CYCLE');

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "graceDays" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanGrant" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "quotaMetric" TEXT,
    "quotaLimit" INTEGER,
    "quotaPeriod" "QuotaPeriod",

    CONSTRAINT "PlanGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "planId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "billingProvider" TEXT NOT NULL DEFAULT 'none',
    "billingReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntitlementOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntitlementOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryRecord" (
    "id" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceReference" TEXT,
    "sourceProvider" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "entities" JSONB NOT NULL DEFAULT '[]',
    "userId" TEXT,
    "namespace" TEXT NOT NULL DEFAULT 'global',
    "staleAfter" TIMESTAMP(3),
    "metadata" JSONB,
    "embedding" vector,
    "embeddingModel" TEXT,
    "embeddingDim" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryRelation" (
    "id" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "relation" TEXT NOT NULL DEFAULT 'related',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphNode" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "label" TEXT,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraphNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphEdge" (
    "id" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GraphEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SentinelObservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "agent" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "pattern" TEXT,
    "symbol" TEXT,
    "content" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "surfaced" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SentinelObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mood" TEXT,
    "content" TEXT NOT NULL,
    "flaggedByAi" BOOLEAN NOT NULL DEFAULT false,
    "aiAnnotation" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsEvent" (
    "id" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "url" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "symbols" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "eventType" TEXT NOT NULL,
    "classifiedBy" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NewsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");

-- CreateIndex
CREATE UNIQUE INDEX "PlanGrant_planId_capability_key" ON "PlanGrant"("planId", "capability");

-- CreateIndex
CREATE INDEX "Subscription_userId_status_idx" ON "Subscription"("userId", "status");

-- CreateIndex
CREATE INDEX "Subscription_status_expiresAt_idx" ON "Subscription"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "EntitlementOverride_userId_capability_idx" ON "EntitlementOverride"("userId", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "UsageCounter_userId_metric_periodKey_key" ON "UsageCounter"("userId", "metric", "periodKey");

-- CreateIndex
CREATE INDEX "MemoryRecord_namespace_userId_idx" ON "MemoryRecord"("namespace", "userId");

-- CreateIndex
CREATE INDEX "MemoryRecord_createdAt_idx" ON "MemoryRecord"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryRelation_fromId_toId_relation_key" ON "MemoryRelation"("fromId", "toId", "relation");

-- CreateIndex
CREATE INDEX "MemoryRelation_toId_idx" ON "MemoryRelation"("toId");

-- CreateIndex
CREATE UNIQUE INDEX "GraphNode_entityId_key" ON "GraphNode"("entityId");

-- CreateIndex
CREATE INDEX "GraphNode_entityType_idx" ON "GraphNode"("entityType");

-- CreateIndex
CREATE INDEX "GraphEdge_fromId_relation_idx" ON "GraphEdge"("fromId", "relation");

-- CreateIndex
CREATE INDEX "GraphEdge_toId_relation_idx" ON "GraphEdge"("toId", "relation");

-- CreateIndex
CREATE INDEX "SentinelObservation_userId_createdAt_idx" ON "SentinelObservation"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SentinelObservation_agent_createdAt_idx" ON "SentinelObservation"("agent", "createdAt");

-- CreateIndex
CREATE INDEX "SentinelObservation_symbol_createdAt_idx" ON "SentinelObservation"("symbol", "createdAt");

-- CreateIndex
CREATE INDEX "JournalEntry_userId_createdAt_idx" ON "JournalEntry"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "NewsEvent_eventType_publishedAt_idx" ON "NewsEvent"("eventType", "publishedAt");

-- CreateIndex
CREATE INDEX "NewsEvent_publishedAt_idx" ON "NewsEvent"("publishedAt");

-- AddForeignKey
ALTER TABLE "PlanGrant" ADD CONSTRAINT "PlanGrant_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntitlementOverride" ADD CONSTRAINT "EntitlementOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryRelation" ADD CONSTRAINT "MemoryRelation_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "MemoryRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryRelation" ADD CONSTRAINT "MemoryRelation_toId_fkey" FOREIGN KEY ("toId") REFERENCES "MemoryRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphEdge" ADD CONSTRAINT "GraphEdge_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "GraphNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphEdge" ADD CONSTRAINT "GraphEdge_toId_fkey" FOREIGN KEY ("toId") REFERENCES "GraphNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
