-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'simulated';

-- CreateIndex
CREATE UNIQUE INDEX "Quote_instrumentId_key" ON "Quote"("instrumentId");
