-- Instrument broker identity — Phase 1 of DHAN-MARKET-DATA-INTEGRATION.md.
-- Adds the (exchangeSegment, securityId) addressing every Dhan API call needs,
-- plus scrip-master metadata and a soft-delete flag for delisted instruments.
-- Purely additive: all columns nullable or defaulted, so existing rows and the
-- global uniqueness of Instrument.symbol are untouched.

-- AlterTable
ALTER TABLE "Instrument" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "dhanInstrument" TEXT,
ADD COLUMN     "exchangeSegment" TEXT,
ADD COLUMN     "expiryFlag" TEXT,
ADD COLUMN     "isin" TEXT,
ADD COLUMN     "metadataSource" TEXT,
ADD COLUMN     "metadataSyncedAt" TIMESTAMP(3),
ADD COLUMN     "securityId" TEXT,
ADD COLUMN     "series" TEXT,
ADD COLUMN     "tradingSymbol" TEXT,
ADD COLUMN     "underlyingSecurityId" TEXT;

-- CreateIndex
CREATE INDEX "Instrument_exchangeSegment_idx" ON "Instrument"("exchangeSegment");

-- CreateIndex
CREATE INDEX "Instrument_active_idx" ON "Instrument"("active");

-- CreateIndex
CREATE INDEX "Instrument_isin_idx" ON "Instrument"("isin");

-- CreateIndex
CREATE UNIQUE INDEX "Instrument_exchangeSegment_securityId_key" ON "Instrument"("exchangeSegment", "securityId");

