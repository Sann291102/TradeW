-- The agent's EXIT, linked back to the decision it closes. Nullable and
-- additive: every existing order predates this column, and one intent's exit
-- may be retried, so this is deliberately NOT unique (unlike the entry link).
-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "exitOfIntentId" TEXT;

-- The groupable form of "why did this decision never become an order". The
-- sentence stays on rejectReason; this is the check id behind it.
-- AlterTable
ALTER TABLE "ExecutionIntent" ADD COLUMN     "rejectCheckId" TEXT;

-- CreateIndex
CREATE INDEX "Order_exitOfIntentId_idx" ON "Order"("exitOfIntentId");

-- CreateIndex
CREATE INDEX "ExecutionIntent_rejectCheckId_decidedAt_idx" ON "ExecutionIntent"("rejectCheckId", "decidedAt");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_exitOfIntentId_fkey" FOREIGN KEY ("exitOfIntentId") REFERENCES "ExecutionIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Pre-existing drift, corrected here because this migration is the first to
-- touch "Order" since it appeared.
--
-- 20260722100001_oms_order_lifecycle added "updatedAt" with
-- DEFAULT CURRENT_TIMESTAMP, but schema.prisma declares it as `@updatedAt`
-- with no `@default` — as every other model in this schema does. So the
-- migrated database has never matched the schema file, and CI's drift job
-- ("Altered column `updatedAt` (default changed from Some(Now) to None)")
-- reports it on every run, on main as much as on any branch. Verified by
-- applying main's migrations to an empty Postgres and diffing: identical
-- output with none of this migration's changes present.
--
-- Dropping the default is the direction that matches both the schema and the
-- convention. It is safe because nothing inserts an Order without it: Prisma
-- always writes `updatedAt` on create, and this repository contains no raw
-- INSERT against this table.
-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "updatedAt" DROP DEFAULT;
