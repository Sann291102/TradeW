-- CreateEnum
CREATE TYPE "ExecutionEnvironment" AS ENUM ('PAPER');

-- CreateEnum
CREATE TYPE "ExecutionIntentStatus" AS ENUM ('PROPOSED', 'REJECTED', 'SUBMITTED', 'FILLED', 'CLOSED', 'FAILED');

-- CreateEnum
CREATE TYPE "StrikeCandidateRole" AS ENUM ('ITM', 'ATM', 'OTM');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "executionIntentId" TEXT;

-- CreateTable
CREATE TABLE "ExecutionProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "strategyId" TEXT,
    "strategyName" TEXT,
    "symbol" TEXT NOT NULL,
    "accountUserId" TEXT NOT NULL,
    "environment" "ExecutionEnvironment" NOT NULL DEFAULT 'PAPER',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lots" INTEGER NOT NULL DEFAULT 1,
    "productType" "ProductType" NOT NULL DEFAULT 'NRML',
    "orderType" "OrderType" NOT NULL DEFAULT 'MARKET',
    "minConfidence" INTEGER NOT NULL DEFAULT 70,
    "maxOpenPositions" INTEGER NOT NULL DEFAULT 1,
    "maxOrdersPerDay" INTEGER NOT NULL DEFAULT 6,
    "maxLossPerDay" DECIMAL(14,2) NOT NULL DEFAULT 25000,
    "squareOffMinute" INTEGER NOT NULL DEFAULT 910,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionIntent" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "ExecutionIntentStatus" NOT NULL DEFAULT 'PROPOSED',
    "environment" "ExecutionEnvironment" NOT NULL DEFAULT 'PAPER',
    "sentinelRunId" TEXT,
    "agent" TEXT NOT NULL,
    "strategyId" TEXT,
    "strategyName" TEXT,
    "symbol" TEXT NOT NULL,
    "underlyingSpot" DECIMAL(12,2),
    "side" "OrderSide" NOT NULL,
    "optionType" TEXT NOT NULL,
    "bias" TEXT NOT NULL,
    "strike" DECIMAL(12,2) NOT NULL,
    "expiry" TIMESTAMP(3) NOT NULL,
    "contractSymbol" TEXT NOT NULL,
    "lots" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "productType" "ProductType" NOT NULL,
    "orderType" "OrderType" NOT NULL,
    "confidence" INTEGER NOT NULL,
    "rationale" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "publication" JSONB,
    "optionContext" JSONB,
    "marketSnapshot" JSONB,
    "rejectReason" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionStrikeCandidate" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "role" "StrikeCandidateRole" NOT NULL,
    "strike" DECIMAL(12,2) NOT NULL,
    "optionType" TEXT NOT NULL,
    "premium" DECIMAL(12,2),
    "openInterest" BIGINT,
    "volume" BIGINT,
    "impliedVol" DOUBLE PRECISION,
    "moneyness" DECIMAL(12,2),
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "tradable" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "checks" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionStrikeCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionOutcome" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "entryPrice" DECIMAL(12,2) NOT NULL,
    "exitPrice" DECIMAL(12,2),
    "quantity" INTEGER NOT NULL,
    "realizedPnl" DECIMAL(14,2) NOT NULL,
    "charges" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "result" TEXT NOT NULL,
    "exitReason" TEXT NOT NULL,
    "invalidationReason" TEXT,
    "holdingSeconds" INTEGER,
    "entryAt" TIMESTAMP(3) NOT NULL,
    "exitAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionProfile_name_key" ON "ExecutionProfile"("name");

-- CreateIndex
CREATE INDEX "ExecutionProfile_enabled_idx" ON "ExecutionProfile"("enabled");

-- CreateIndex
CREATE INDEX "ExecutionProfile_symbol_idx" ON "ExecutionProfile"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionIntent_idempotencyKey_key" ON "ExecutionIntent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ExecutionIntent_profileId_decidedAt_idx" ON "ExecutionIntent"("profileId", "decidedAt");

-- CreateIndex
CREATE INDEX "ExecutionIntent_status_idx" ON "ExecutionIntent"("status");

-- CreateIndex
CREATE INDEX "ExecutionIntent_symbol_decidedAt_idx" ON "ExecutionIntent"("symbol", "decidedAt");

-- CreateIndex
CREATE INDEX "ExecutionIntent_sentinelRunId_idx" ON "ExecutionIntent"("sentinelRunId");

-- CreateIndex
CREATE INDEX "ExecutionStrikeCandidate_intentId_idx" ON "ExecutionStrikeCandidate"("intentId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionStrikeCandidate_intentId_role_key" ON "ExecutionStrikeCandidate"("intentId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionOutcome_intentId_key" ON "ExecutionOutcome"("intentId");

-- CreateIndex
CREATE INDEX "ExecutionOutcome_result_idx" ON "ExecutionOutcome"("result");

-- CreateIndex
CREATE UNIQUE INDEX "Order_executionIntentId_key" ON "Order"("executionIntentId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_executionIntentId_fkey" FOREIGN KEY ("executionIntentId") REFERENCES "ExecutionIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionProfile" ADD CONSTRAINT "ExecutionProfile_accountUserId_fkey" FOREIGN KEY ("accountUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionIntent" ADD CONSTRAINT "ExecutionIntent_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ExecutionProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionStrikeCandidate" ADD CONSTRAINT "ExecutionStrikeCandidate_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "ExecutionIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionOutcome" ADD CONSTRAINT "ExecutionOutcome_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "ExecutionIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

