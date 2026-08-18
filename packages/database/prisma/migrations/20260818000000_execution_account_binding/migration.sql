-- CreateEnum
CREATE TYPE "ExecutionAccountScope" AS ENUM ('SYSTEM_PAPER', 'USER_PAPER');

-- AlterTable
ALTER TABLE "ExecutionProfile" ADD COLUMN     "accountScope" "ExecutionAccountScope" NOT NULL DEFAULT 'SYSTEM_PAPER';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "agentPaperTradingEnabledAt" TIMESTAMP(3),
ADD COLUMN     "agentPaperTradingGrantedBy" TEXT;

