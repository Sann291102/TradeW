-- WatchSession: a watch now names an option PAIR, not one leg.
--
-- WHY
-- Sentinel observes three series together — the underlying, a CALL and a PUT —
-- and decides which leg is expressing the underlying's move. It could not do
-- that from `strike`/`optionType`, which named exactly one contract, so the
-- CE/PE toggle in the workspace silently decided which single leg the engine
-- ever saw.
--
-- A strike NUMBER is also not enough. Every consumer that needed the actual
-- contract re-derived it from (symbol, expiry, strike, side) on its own; the
-- `*SecurityId` columns record the Dhan token the live feed subscribes and the
-- historical API is addressed by, so the chart, the price poll and the engine
-- provably read the same contract instead of three lookups that agree today.
-- Kept as columns rather than a JSON blob so "which contracts are we
-- subscribed to" stays answerable in SQL.
--
-- `strike`/`optionType` are DELIBERATELY LEFT IN PLACE, not dropped. Rows
-- created before this migration carry only those, and dropping them would
-- destroy every pre-existing watch. New rows keep them mirrored from the
-- focused leg; readers go through `watchLegs()` (apps/web) / `_legs_of()`
-- (services/sentinel-py), which is the one place that knows about the shim.
--
-- Additive only, every column nullable or defaulted. Safe to apply to a
-- running deployment: existing rows keep working as underlying/legacy watches
-- and no backfill is required.

ALTER TABLE "WatchSession"
    ADD COLUMN "ceStrike"          DECIMAL(12,2),
    ADD COLUMN "ceSecurityId"      TEXT,
    ADD COLUMN "ceExchangeSegment" TEXT,
    ADD COLUMN "ceDhanInstrument"  TEXT,
    ADD COLUMN "ceTradingSymbol"   TEXT,
    ADD COLUMN "ceLotSize"         INTEGER,
    ADD COLUMN "ceTickSize"        DECIMAL(10,4),
    ADD COLUMN "peStrike"          DECIMAL(12,2),
    ADD COLUMN "peSecurityId"      TEXT,
    ADD COLUMN "peExchangeSegment" TEXT,
    ADD COLUMN "peDhanInstrument"  TEXT,
    ADD COLUMN "peTradingSymbol"   TEXT,
    ADD COLUMN "peLotSize"         INTEGER,
    ADD COLUMN "peTickSize"        DECIMAL(10,4),
    ADD COLUMN "focusedSide"       TEXT,
    ADD COLUMN "watchMode"         TEXT NOT NULL DEFAULT 'option',
    ADD COLUMN "timeframe"         TEXT;
