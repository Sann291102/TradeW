-- Partial profit taking.
--
-- Off by default: taking half off at +1R raises the hit rate and caps the right
-- tail, which makes an agent whose edge IS the tail strictly worse. It is a
-- per-profile strategy choice, not a universal improvement.
--
-- Risk-reducing by construction — it can only ever SELL part of a long
-- position, never add to one.
ALTER TABLE "ExecutionProfile" ADD COLUMN "partialExitEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ExecutionProfile" ADD COLUMN "partialExitRMultiple" DECIMAL(6,3);
ALTER TABLE "ExecutionProfile" ADD COLUMN "partialExitPct" INTEGER;

-- `initialQuantity` is nullable so pre-existing positions need no backfill; the
-- journal treats null as "never reduced", which is true of every row that
-- predates this.
ALTER TABLE "ExecutionPosition" ADD COLUMN "initialQuantity" INTEGER;
ALTER TABLE "ExecutionPosition" ADD COLUMN "partialExitCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ExecutionPosition" ADD COLUMN "realizedPartialPnl" DECIMAL(14,2) NOT NULL DEFAULT 0;

CREATE TABLE "ExecutionPartialExit" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "triggerPrice" DECIMAL(12,2) NOT NULL,
    "rMultiple" DECIMAL(10,3),
    "remaining" INTEGER NOT NULL,
    "orderId" TEXT,
    "reason" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionPartialExit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExecutionPartialExit_positionId_at_idx" ON "ExecutionPartialExit"("positionId", "at");

ALTER TABLE "ExecutionPartialExit" ADD CONSTRAINT "ExecutionPartialExit_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "ExecutionPosition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
