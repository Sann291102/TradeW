-- Notification model + NotificationCategory enum.
--
-- Written idempotently because an out-of-band `prisma db push` had already
-- created the "Notification" table on some dev databases with `category` as
-- TEXT. On a fresh database this creates everything from scratch; on a
-- db-push'd one it only adds the enum type and converts the column. No data is
-- dropped either way.

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('trade', 'sentinel', 'learning', 'research', 'portfolio', 'broker', 'announcement');

-- CreateTable (skipped when a prior db push already created it)
CREATE TABLE IF NOT EXISTS "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- Reconcile the column type when the table pre-existed with category as TEXT
ALTER TABLE "Notification" ALTER COLUMN "category" TYPE "NotificationCategory" USING "category"::"NotificationCategory";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "Notification_userId_read_idx" ON "Notification"("userId", "read");

-- AddForeignKey (Postgres has no IF NOT EXISTS for ADD CONSTRAINT)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Notification_userId_fkey') THEN
    ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
