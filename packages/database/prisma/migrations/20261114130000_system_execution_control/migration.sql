-- CreateEnum
CREATE TYPE "SystemExecutionMode" AS ENUM ('ON', 'OFF', 'EMERGENCY_STOP');

-- CreateTable
CREATE TABLE "SystemExecutionControl" (
    "key" TEXT NOT NULL DEFAULT 'GLOBAL',
    "mode" "SystemExecutionMode" NOT NULL DEFAULT 'ON',
    "reason" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemExecutionControl_pkey" PRIMARY KEY ("key")
);
