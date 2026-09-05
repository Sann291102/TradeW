-- ============================================================================
-- TRADABLE UNIVERSE — the full multi-market instrument catalogue.
--
-- Additive only. Nothing here touches `Instrument`, which remains the OMS's
-- foreign-key target with its globally-unique `symbol`. See the schema header
-- above `UniverseInstrument` for why the universe cannot live in that table.
--
-- pg_trgm is required, not optional: the universe browser searches a catalogue
-- of ~200k rows on every keystroke, and an unindexed ILIKE '%q%' is a sequential
-- scan of the whole table per request. The GIN trigram index below turns that
-- into an index scan. CREATE EXTENSION IF NOT EXISTS is idempotent and needs
-- superuser only the first time; managed Postgres (RDS, Supabase, Neon) all
-- ship pg_trgm in their allowed-extension list.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE TYPE "UniverseMarket" AS ENUM ('INDIA', 'USA', 'UK', 'FOREX', 'CRYPTO');

CREATE TYPE "UniverseAssetClass" AS ENUM (
  'EQUITY', 'ETF', 'INDEX', 'FUND', 'TRUST', 'REIT', 'DEPOSITARY_RECEIPT',
  'WARRANT', 'BOND', 'FUTURE', 'OPTION', 'CURRENCY_PAIR', 'CRYPTO_PAIR',
  'COMMODITY', 'OTHER'
);

CREATE TYPE "UniverseStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED', 'DELISTED', 'UNKNOWN');

CREATE TABLE "UniverseInstrument" (
  "id"                   TEXT NOT NULL,
  "market"               "UniverseMarket" NOT NULL,
  "exchange"             TEXT NOT NULL,
  "mic"                  TEXT,
  "symbol"               TEXT NOT NULL,
  "ref"                  TEXT NOT NULL,
  "displayName"          TEXT NOT NULL,
  "assetClass"           "UniverseAssetClass" NOT NULL,
  "status"               "UniverseStatus" NOT NULL DEFAULT 'ACTIVE',
  "country"              TEXT,
  "sector"               TEXT,
  "industry"             TEXT,
  "quoteCurrency"        TEXT NOT NULL,
  "accountCurrency"      TEXT NOT NULL,
  "requiresFxConversion" BOOLEAN NOT NULL DEFAULT false,
  "isin"                 TEXT,
  "figi"                 TEXT,
  "cusip"                TEXT,
  "sedol"                TEXT,
  "provider"             TEXT NOT NULL,
  "providerSymbol"       TEXT NOT NULL,
  "securityId"           TEXT,
  "exchangeSegment"      TEXT,
  "series"               TEXT,
  "baseAsset"            TEXT,
  "quoteAsset"           TEXT,
  "lotSize"              INTEGER,
  "tickSize"             DECIMAL(20,10),
  "minQty"               DECIMAL(28,10),
  "stepSize"             DECIMAL(28,10),
  "searchText"           TEXT NOT NULL,
  "raw"                  JSONB,
  "firstSeenAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "delistedAt"           TIMESTAMP(3),
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "UniverseInstrument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UniverseInstrument_ref_key" ON "UniverseInstrument"("ref");
CREATE UNIQUE INDEX "UniverseInstrument_market_exchange_symbol_key"
  ON "UniverseInstrument"("market", "exchange", "symbol");

-- The index the browser's keyset cursor walks: filter by (market, status),
-- order by symbol, seek past the last symbol of the previous page. Index-ordered
-- so no OFFSET is ever needed — OFFSET degrades linearly and this table is large
-- by design.
CREATE INDEX "UniverseInstrument_market_status_symbol_idx"
  ON "UniverseInstrument"("market", "status", "symbol");
CREATE INDEX "UniverseInstrument_market_assetClass_status_idx"
  ON "UniverseInstrument"("market", "assetClass", "status");
CREATE INDEX "UniverseInstrument_exchange_status_idx" ON "UniverseInstrument"("exchange", "status");
CREATE INDEX "UniverseInstrument_provider_lastSeenAt_idx" ON "UniverseInstrument"("provider", "lastSeenAt");
CREATE INDEX "UniverseInstrument_isin_idx" ON "UniverseInstrument"("isin");
CREATE INDEX "UniverseInstrument_status_idx" ON "UniverseInstrument"("status");

-- Substring search over the whole catalogue. GIN + gin_trgm_ops is what makes
-- `searchText LIKE '%rel%'` an index scan instead of a full-table scan; a
-- B-tree cannot serve a leading wildcard at all. Both raw-ops indexes below are
-- also declared in schema.prisma (`ops: raw(...)`) and carry the names Prisma
-- generates for them, so `migrate dev` does not read them as drift.
CREATE INDEX "UniverseInstrument_searchText_idx"
  ON "UniverseInstrument" USING GIN ("searchText" gin_trgm_ops);

-- Prefix matches are ranked first by the API (a user typing "AAP" wants AAPL,
-- not a company with "aap" mid-name). text_pattern_ops serves that LIKE 'q%'
-- probe from an index under any collation.
CREATE INDEX "UniverseInstrument_symbol_idx"
  ON "UniverseInstrument"("symbol" text_pattern_ops);

CREATE TABLE "UniverseSyncRun" (
  "id"         TEXT NOT NULL,
  "source"     TEXT NOT NULL,
  "market"     "UniverseMarket",
  "status"     TEXT NOT NULL DEFAULT 'RUNNING',
  "startedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "durationMs" INTEGER,
  "discovered" INTEGER NOT NULL DEFAULT 0,
  "pages"      INTEGER NOT NULL DEFAULT 0,
  "created"    INTEGER NOT NULL DEFAULT 0,
  "updated"    INTEGER NOT NULL DEFAULT 0,
  "unchanged"  INTEGER NOT NULL DEFAULT 0,
  "delisted"   INTEGER NOT NULL DEFAULT 0,
  "duplicates" INTEGER NOT NULL DEFAULT 0,
  "rejected"   INTEGER NOT NULL DEFAULT 0,
  "truncated"  BOOLEAN NOT NULL DEFAULT false,
  "errors"     JSONB,

  CONSTRAINT "UniverseSyncRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UniverseSyncRun_source_startedAt_idx" ON "UniverseSyncRun"("source", "startedAt");
CREATE INDEX "UniverseSyncRun_market_startedAt_idx" ON "UniverseSyncRun"("market", "startedAt");
