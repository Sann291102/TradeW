CREATE TYPE "InstrumentType" AS ENUM ('INDEX', 'OPTION', 'EQUITY');
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');
CREATE TYPE "OrderStatus" AS ENUM ('FILLED', 'REJECTED');

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

CREATE TABLE "Instrument" (
  "id" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "type" "InstrumentType" NOT NULL,
  "exchange" TEXT NOT NULL,
  "underlying" TEXT,
  "expiryDate" TIMESTAMP(3),
  "strikePrice" DECIMAL(12,2),
  "optionType" TEXT,
  "lotSize" INTEGER NOT NULL DEFAULT 1,
  "tickSize" DECIMAL(10,2) NOT NULL DEFAULT 0.05,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Instrument_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Instrument_symbol_key" ON "Instrument"("symbol");

CREATE TABLE "Quote" (
  "id" TEXT NOT NULL,
  "instrumentId" TEXT NOT NULL,
  "ltp" DECIMAL(12,2) NOT NULL,
  "previousClose" DECIMAL(12,2),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Quote_instrumentId_idx" ON "Quote"("instrumentId");

CREATE TABLE "Order" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "instrumentId" TEXT NOT NULL,
  "side" "OrderSide" NOT NULL,
  "quantity" INTEGER NOT NULL,
  "status" "OrderStatus" NOT NULL DEFAULT 'FILLED',
  "requestedPrice" DECIMAL(12,2),
  "fillPrice" DECIMAL(12,2) NOT NULL,
  "slippage" DECIMAL(12,2) NOT NULL,
  "charges" DECIMAL(12,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");

CREATE TABLE "Trade" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "instrumentId" TEXT NOT NULL,
  "side" "OrderSide" NOT NULL,
  "quantity" INTEGER NOT NULL,
  "fillPrice" DECIMAL(12,2) NOT NULL,
  "charges" DECIMAL(12,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Trade_orderId_key" ON "Trade"("orderId");
CREATE INDEX "Trade_userId_createdAt_idx" ON "Trade"("userId", "createdAt");

CREATE TABLE "Position" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "instrumentId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "avgPrice" DECIMAL(12,2) NOT NULL,
  "realizedPnl" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Position_userId_instrumentId_key" ON "Position"("userId", "instrumentId");
CREATE INDEX "Position_userId_idx" ON "Position"("userId");

ALTER TABLE "Quote" ADD CONSTRAINT "Quote_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Position" ADD CONSTRAINT "Position_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Position" ADD CONSTRAINT "Position_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
