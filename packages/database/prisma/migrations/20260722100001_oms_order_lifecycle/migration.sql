-- DropIndex
DROP INDEX "Order_userId_createdAt_idx";

-- DropIndex
DROP INDEX "Position_userId_instrumentId_key";

-- DropIndex
DROP INDEX "Trade_orderId_key";

-- DropIndex
DROP INDEX "Trade_userId_createdAt_idx";

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "createdAt",
DROP COLUMN "fillPrice",
DROP COLUMN "requestedPrice",
ADD COLUMN     "avgFillPrice" DECIMAL(12,2),
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "filledQuantity" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "marginBlocked" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "parentOrderId" TEXT,
ADD COLUMN     "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "price" DECIMAL(12,2),
ADD COLUMN     "productType" "ProductType" NOT NULL DEFAULT 'MIS',
ADD COLUMN     "rejectReason" TEXT,
ADD COLUMN     "triggerPrice" DECIMAL(12,2),
ADD COLUMN     "type" "OrderType" NOT NULL DEFAULT 'MARKET',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "validity" "OrderValidity" NOT NULL DEFAULT 'DAY',
ALTER COLUMN "status" SET DEFAULT 'PENDING',
ALTER COLUMN "slippage" DROP NOT NULL,
ALTER COLUMN "charges" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "Position" ADD COLUMN     "marginUsed" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "productType" "ProductType" NOT NULL DEFAULT 'MIS',
ADD COLUMN     "sessionAnchorAt" TIMESTAMP(3),
ADD COLUMN     "sessionOpenAvgPrice" DECIMAL(12,2),
ADD COLUMN     "sessionOpenMarketPrice" DECIMAL(12,2),
ADD COLUMN     "sessionOpenQty" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Trade" DROP COLUMN "createdAt",
ADD COLUMN     "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "realizedPnl" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "PaperWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startingBalance" DECIMAL(14,2) NOT NULL DEFAULT 1000000,
    "cashBalance" DECIMAL(14,2) NOT NULL DEFAULT 1000000,
    "marginUsed" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "realizedPnl" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperWallet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaperWallet_userId_key" ON "PaperWallet"("userId");

-- CreateIndex
CREATE INDEX "Order_userId_placedAt_idx" ON "Order"("userId", "placedAt");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Order_userId_status_idx" ON "Order"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Position_userId_instrumentId_productType_key" ON "Position"("userId", "instrumentId", "productType");

-- CreateIndex
CREATE INDEX "Trade_userId_executedAt_idx" ON "Trade"("userId", "executedAt");

-- CreateIndex
CREATE INDEX "Trade_orderId_idx" ON "Trade"("orderId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_parentOrderId_fkey" FOREIGN KEY ("parentOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperWallet" ADD CONSTRAINT "PaperWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
