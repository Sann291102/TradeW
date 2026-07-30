-- Crypto — a separate USD-denominated trading space.
--
-- Separate tables rather than widening Order/Trade/Position, for three reasons
-- recorded in schema.prisma: precision (Int quantity and Decimal(12,2) prices
-- cannot express 0.00042 BTC or a $0.00002 asset), currency (the rupee OMS has
-- no FX conversion anywhere in it), and blast radius (that order path has a
-- known concurrency defect and no test coverage).
--
-- SPOT ONLY. No margin, no leverage, no shorts — a buy costs its full USD
-- notional and a sell requires holding the asset. There is no margin model
-- here at all.
--
-- All three FKs are ON DELETE CASCADE: this is the user's own paper activity
-- and must not be what blocks an account deletion request.

-- CreateEnum
CREATE TYPE "CryptoOrderStatus" AS ENUM ('FILLED', 'REJECTED');

-- CreateTable
CREATE TABLE "CryptoWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- USD, not rupees. Decimal(20,2) — cash is whole cents.
    "startingBalance" DECIMAL(20,2) NOT NULL DEFAULT 10000,
    "cashBalance" DECIMAL(20,2) NOT NULL DEFAULT 10000,
    "realizedPnl" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CryptoWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CryptoOrder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "status" "CryptoOrderStatus" NOT NULL DEFAULT 'FILLED',
    -- 8dp: Binance's own quote precision. This is the whole reason these
    -- tables exist separately from Order/Trade/Position.
    "quantity" DECIMAL(28,8) NOT NULL,
    "fillPrice" DECIMAL(20,8),
    "notional" DECIMAL(20,2),
    "fee" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "rejectReason" TEXT,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CryptoOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CryptoPosition" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    -- Always >= 0; spot only, so there is no short side to represent.
    "quantity" DECIMAL(28,8) NOT NULL,
    "avgPrice" DECIMAL(20,8) NOT NULL,
    "realizedPnl" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CryptoPosition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CryptoWallet_userId_key" ON "CryptoWallet"("userId");

-- CreateIndex
CREATE INDEX "CryptoOrder_userId_placedAt_idx" ON "CryptoOrder"("userId", "placedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CryptoPosition_userId_symbol_key" ON "CryptoPosition"("userId", "symbol");

-- CreateIndex
CREATE INDEX "CryptoPosition_userId_idx" ON "CryptoPosition"("userId");

-- AddForeignKey
ALTER TABLE "CryptoWallet" ADD CONSTRAINT "CryptoWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CryptoOrder" ADD CONSTRAINT "CryptoOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CryptoPosition" ADD CONSTRAINT "CryptoPosition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
