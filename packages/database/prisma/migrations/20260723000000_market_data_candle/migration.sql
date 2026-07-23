-- Migration 2 (MARKET-DATA-ARCHITECTURE.md §5/§6): historical OHLCV Candle series.
-- Additive only — new table, indexes, and FK. Nothing existing is altered or dropped.
-- Unblocks Sentinel Trap Detection, Charts, and the TradingView datafeed, all of
-- which need OHLC+volume history at a timeframe rather than a single Quote snapshot.

-- CreateTable
CREATE TABLE "Candle" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(12,2) NOT NULL,
    "high" DECIMAL(12,2) NOT NULL,
    "low" DECIMAL(12,2) NOT NULL,
    "close" DECIMAL(12,2) NOT NULL,
    "volume" BIGINT NOT NULL DEFAULT 0,
    "openInterest" BIGINT,
    "source" TEXT NOT NULL DEFAULT 'simulated',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Candle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Candle_instrumentId_timeframe_bucketStart_idx" ON "Candle"("instrumentId", "timeframe", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "Candle_instrumentId_timeframe_bucketStart_key" ON "Candle"("instrumentId", "timeframe", "bucketStart");

-- AddForeignKey
ALTER TABLE "Candle" ADD CONSTRAINT "Candle_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
