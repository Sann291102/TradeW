-- UserStrategy: Sentinel (Python)'s strategy store — see SENTINEL_MASTER_PLAN.md
-- and services/sentinel-py. Owned there, not by services/api's Prisma client;
-- this migration exists here only because Prisma is the monorepo's single
-- migration tool.
--
-- Additive only. Safe to apply to a running deployment.

CREATE TABLE "UserStrategy" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "rawInput" TEXT,
    "inputType" TEXT NOT NULL DEFAULT 'text',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserStrategy_pkey" PRIMARY KEY ("id")
);

-- Every list/CRUD call is scoped to the calling user.
CREATE INDEX "UserStrategy_userId_idx" ON "UserStrategy"("userId");
