-- Company Intelligence — Phase 2: company identity.
--
-- WHY A COMPANY ENTITY SEPARATE FROM Instrument
-- `Instrument` is a TRADABLE THING — a symbol the broker can be told to buy —
-- and it is the right model for that. A research page asks a different
-- question: "what is this company". The two are genuinely different objects.
-- One company can list on NSE and BSE under different symbols; a symbol can be
-- reassigned after a delisting; and many Instrument rows (indices, ETFs) have
-- no company behind them at all.
--
-- Conflating them is what produces `if (symbol === 'RELIANCE')` code. With no
-- company entity, per-company facts have nowhere to live except a branch inside
-- a React component — which is exactly where they live today. This migration
-- gives identity its own spine, joined to the tradable world by ISIN, the only
-- identifier both sides actually agree on.
--
-- Additive only. `Instrument` gains no column: the link lives on
-- SecurityListing.instrumentId, so the scrip-master sync and company identity
-- can each change without touching the other's table.
--
-- Design: knowledge/Plans/2026-08-19 - Company Intelligence Platform §D.
-- Source shape verified live 2026-08-19: EQUITY_L.csv, 2,553 rows, every ISIN
-- INE (2,551) or IN9 (2) — no INF fund ISINs, so this file is genuinely the
-- company list rather than the tradable-equity list.

-- ── Company ─────────────────────────────────────────────────────────────────
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    -- The exchange's spelling, not a prettified one. It is what a user typing
    -- into search will have seen, and a nicer name we invent is a name no
    -- source can corroborate.
    "name" TEXT NOT NULL,
    -- Derived from the ISIN prefix, the only classification available without
    -- an extra source: INE = ordinary company equity, IN9 = partly-paid or
    -- depository receipt, INF = fund units (NOT a company).
    --
    -- Exists to stop a fund being rendered with a P&L. EQUITY_L.csv contains no
    -- INF rows today, so none SHOULD arrive; stored anyway because "should" is
    -- not an invariant and the failure mode is silent -- an ETF with an
    -- invented balance sheet looks just like a company with a real one.
    "kind" TEXT NOT NULL DEFAULT 'EQUITY',
    -- Null until a source provides them. EQUITY_L.csv carries no sector; the
    -- announcements/board-meeting feeds do (`smIndustry`), which is the Phase 4
    -- source. Left null rather than guessed: an unclassified company is a fact,
    -- a wrongly classified one propagates into peer comparison.
    "sector" TEXT,
    "industry" TEXT,
    "description" TEXT,
    "website" TEXT,
    "irUrl" TEXT,
    -- Soft delete, never a row removal: a delisted company keeps its filings.
    -- Same reasoning as Instrument.active, and CLAUDE.md Rule 1.
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sourceRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Company_active_idx" ON "Company"("active");
CREATE INDEX "Company_name_idx" ON "Company"("name");
CREATE INDEX "Company_sector_industry_idx" ON "Company"("sector", "industry");

-- ── SecurityListing ─────────────────────────────────────────────────────────
-- The join between identity and tradability, and the reason neither has to know
-- about the other's lifecycle.
CREATE TABLE "SecurityListing" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    -- NOT globally unique: the same ticker can exist on both exchanges for
    -- different companies. Hence the (exchange, symbol) key below.
    "symbol" TEXT NOT NULL,
    -- The identifier that IS global, and the join key to Instrument.isin and to
    -- every filing feed.
    "isin" TEXT NOT NULL,
    -- EQ (2,297) | BE (228) | BZ (28). BZ means trade-to-trade/surveillance --
    -- a research page rendering it identically to an EQ name is withholding
    -- something the reader would want.
    "series" TEXT,
    "listedOn" TIMESTAMP(3),
    -- Per SHARE, both of them. NEITHER IS A SHARE COUNT, and market cap needs a
    -- share count. The free route to that is the XBRL pair
    -- PaidUpValueOfEquityShareCapital / FaceValueOfEquityShareCapital, which
    -- arrives with the statement pipeline. Stated explicitly because filling
    -- this gap with a guess is precisely the `price * 670` currently on the
    -- research page.
    "faceValue" DECIMAL(12,2),
    "paidUpValue" DECIMAL(12,2),
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    -- Nullable and expected to be null often: NSE lists ~2,553 companies while
    -- the broker scrip master carries only enabled segments. A listing with no
    -- instrument is a company we can research but not price -- a real,
    -- displayable state, not an error.
    "instrumentId" TEXT,
    "sourceRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityListing_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SecurityListing_exchange_symbol_key" ON "SecurityListing"("exchange", "symbol");
CREATE INDEX "SecurityListing_isin_idx" ON "SecurityListing"("isin");
CREATE INDEX "SecurityListing_companyId_idx" ON "SecurityListing"("companyId");
CREATE INDEX "SecurityListing_instrumentId_idx" ON "SecurityListing"("instrumentId");

-- ── CompanyAlias ────────────────────────────────────────────────────────────
-- Search must resolve a name, an NSE symbol, a BSE code, an ISIN or a FORMER
-- name onto one canonical record. A table makes that a single indexed lookup,
-- and makes a former name permanently resolvable: when a company renames, the
-- old name becomes an alias rather than vanishing, so an old filing or a stale
-- bookmark still finds it.
CREATE TABLE "CompanyAlias" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    -- 'name' | 'symbol' | 'isin' | 'bse-code' | 'former-name'
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    -- Upper-cased, whitespace-collapsed. Stored rather than computed per query
    -- so the unique constraint can ENFORCE "one company per identifier" instead
    -- of merely hoping for it.
    "normalized" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyAlias_pkey" PRIMARY KEY ("id")
);

-- The invariant that makes resolution deterministic: an identifier cannot point
-- at two companies. A source that would violate it is a conflict to surface,
-- not a row to overwrite silently.
CREATE UNIQUE INDEX "CompanyAlias_kind_normalized_key" ON "CompanyAlias"("kind", "normalized");
CREATE INDEX "CompanyAlias_normalized_idx" ON "CompanyAlias"("normalized");
CREATE INDEX "CompanyAlias_companyId_idx" ON "CompanyAlias"("companyId");

-- ── SourceRecord gains a resolved subject ───────────────────────────────────
-- Phase 1 stored `subjectSymbol`/`subjectIsin` as raw claims because Company
-- did not exist yet. This is the resolved conclusion. It stays NULLABLE
-- permanently, not transitionally: a whole-market file is about every company
-- and therefore about none in particular, and an artefact whose subject could
-- not be resolved must remain storable rather than be dropped.
ALTER TABLE "SourceRecord" ADD COLUMN "companyId" TEXT;
CREATE INDEX "SourceRecord_companyId_idx" ON "SourceRecord"("companyId");

-- ── Foreign keys ────────────────────────────────────────────────────────────
-- CASCADE from Company to its listings and aliases: those rows describe the
-- company and have no meaning without it. Everything pointing at provenance is
-- SET NULL -- losing the trail must never take the data with it.
ALTER TABLE "Company" ADD CONSTRAINT "Company_sourceRecordId_fkey"
    FOREIGN KEY ("sourceRecordId") REFERENCES "SourceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SecurityListing" ADD CONSTRAINT "SecurityListing_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SecurityListing" ADD CONSTRAINT "SecurityListing_instrumentId_fkey"
    FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SecurityListing" ADD CONSTRAINT "SecurityListing_sourceRecordId_fkey"
    FOREIGN KEY ("sourceRecordId") REFERENCES "SourceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CompanyAlias" ADD CONSTRAINT "CompanyAlias_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SourceRecord" ADD CONSTRAINT "SourceRecord_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
