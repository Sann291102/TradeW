-- CreateEnum
CREATE TYPE "AiConversationStatus" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "AiMessageRole" AS ENUM ('user', 'assistant');

-- CreateEnum
CREATE TYPE "AiInputMode" AS ENUM ('text', 'voice');

-- NOTE: `prisma migrate dev` also emitted `ALTER TABLE "Order" ALTER COLUMN
-- "updatedAt" DROP DEFAULT;` here. That is PRE-EXISTING drift between
-- schema.prisma and the applied migration history, unrelated to this change,
-- and it has been removed deliberately — a migration named for AI persona and
-- conversations must not quietly alter the orders table. The drift is still
-- there and will reappear in the next generated migration; it wants its own
-- commit.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "aiPersonaName" TEXT,
ADD COLUMN     "aiPersonaNamedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AiConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tradingDay" DATE NOT NULL,
    "status" "AiConversationStatus" NOT NULL DEFAULT 'active',
    "personaName" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "AiConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "AiMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "inputMode" "AiInputMode" NOT NULL DEFAULT 'text',
    "intent" TEXT,
    "actions" JSONB,
    "complianceVerdict" JSONB,
    "provenance" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiConversation_userId_status_idx" ON "AiConversation"("userId", "status");

-- CreateIndex
CREATE INDEX "AiConversation_userId_tradingDay_idx" ON "AiConversation"("userId", "tradingDay");

-- CreateIndex
CREATE UNIQUE INDEX "AiConversation_userId_tradingDay_key" ON "AiConversation"("userId", "tradingDay");

-- CreateIndex
CREATE INDEX "AiMessage_conversationId_createdAt_idx" ON "AiMessage"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMessage" ADD CONSTRAINT "AiMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
