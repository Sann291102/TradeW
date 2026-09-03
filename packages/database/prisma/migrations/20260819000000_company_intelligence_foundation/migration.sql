-- Company Intelligence — Phase 1: provenance and ingestion foundation.
--
-- WHY THESE FOUR TABLES, AND WHY BEFORE ANY COMPANY DATA
-- The platform is about to start ingesting financial statements, shareholding
-- patterns, corporate actions and filings from sources that are free, official
-- and — critically — unofficial in their access surface. The failure mode that
-- matters is not "the pipeline broke"; a broken pipeline is loud. It is a page
-- confidently rendering a number nobody can trace, or rendering yesterday's
-- number as though it were live.
--
-- So provenance goes in FIRST. Every company row added from Phase 2 onward
-- points back at a SourceRecord, which means the question "where did this come
-- from, when, and was it checked" has an answer for the rows that arrive
-- earliest — the ones that would otherwise be the hardest to audit later.
--
-- None of these tables holds company data. Nothing user-visible changes.
--
-- Design: knowledge/Plans/2026-08-19 - Company Intelligence Platform
--         (architecture plan) §D, §E, §R.
-- Sources verified live 2026-08-19:
--         knowledge/API/2026-08-19 - NSE corporate filings and XBRL fundamentals.

-- ── DataSource ──────────────────────────────────────────────────────────────
-- Operational control over an upstream: is it on, how fast may we call it, what
-- do its terms say. Deliberately NOT a catalogue of fetchable URLs — that stays
-- a closed allowlist in code (see services/api/src/nse/nse-datasets.ts for the
-- SSRF argument). Code decides what is reachable; this table decides whether.
CREATE TABLE "DataSource" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- 1 = official/exchange/regulator, 2 = free or licensed provider,
    -- 3 = secondary. This is the first key of the conflict-precedence rule when
    -- two sources disagree, so it is a correctness field, not a label.
    "tier" INTEGER NOT NULL,
    "baseUrl" TEXT,
    -- What the terms actually permit, in plain words. Present because months
    -- later someone who was not in the room has to answer "is this legal in
    -- production" without reconstructing it from a chat log.
    "licenseNote" TEXT,
    -- NULL means "no explicit limit known", which the limiter treats as a
    -- conservative default — not as unlimited.
    "rateLimitPerMin" INTEGER,
    -- Kill switch. NSE has form here: quote-equity answered 403 to this client
    -- on 2026-08-19 while its sibling filing endpoints answered 200. An upstream
    -- that starts refusing us gets disabled operationally, not by a deploy.
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataSource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DataSource_key_key" ON "DataSource"("key");
CREATE INDEX "DataSource_enabled_idx" ON "DataSource"("enabled");

-- ── SourceRecord ────────────────────────────────────────────────────────────
-- One fetch of one artefact. Written BEFORE anything is derived from it and
-- never updated in place, so the chain
--   rendered value -> derived metric -> line item -> statement -> SourceRecord
-- always terminates in a URL, an instant, and a hash of the exact bytes.
--
-- Doubles as the incrementality substrate: a fetch whose contentHash we already
-- hold is recorded 'unchanged' and parsed no further.
CREATE TABLE "SourceRecord" (
    "id" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    -- Which catalogue entry produced this: 'nse.financial-results',
    -- 'nse.shareholding', 'nse.equity-list'.
    "datasetKey" TEXT NOT NULL,
    -- What it is about. Loose strings deliberately: "Company" does not exist
    -- until Phase 2, and a nullable FK to an absent table would be a lie.
    -- Phase 2 adds companyId and backfills from subjectIsin — ISIN makes that
    -- backfill deterministic instead of a name-matching guess.
    "subjectSymbol" TEXT,
    "subjectIsin" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "httpStatus" INTEGER,
    -- When WE read it.
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- When the SOURCE says the content is from. Distinct on purpose: reading
    -- yesterday's end-of-day file at 11am today does not make it 11am-fresh,
    -- and the freshness label shown in the UI is computed from THIS column.
    "effectiveAt" TIMESTAMP(3),
    -- Conditional-request bookkeeping, so a weekly document sweep costs a 304
    -- rather than a re-download.
    "etag" TEXT,
    "lastModified" TEXT,
    -- SHA-256 of the raw bytes: the change detector and the dedupe key.
    "contentHash" TEXT NOT NULL,
    "contentType" TEXT,
    "contentSize" INTEGER,
    -- Where raw bytes were kept, when kept. Matters for filings: when a parser
    -- turns out to be wrong, reprocessing must not depend on NSE still serving
    -- a document it may have moved.
    "rawPath" TEXT,
    -- 'ok' | 'unchanged' | 'failed'. A failed fetch is RECORDED, not discarded:
    -- "we tried and could not read it" and "we never looked" are different
    -- facts, and only one of them justifies continuing to show stale data.
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceRecord_pkey" PRIMARY KEY ("id")
);

-- Re-fetching identical bytes must not create a second row.
CREATE UNIQUE INDEX "SourceRecord_dataSourceId_sourceUrl_contentHash_key"
    ON "SourceRecord"("dataSourceId", "sourceUrl", "contentHash");
CREATE INDEX "SourceRecord_datasetKey_retrievedAt_idx" ON "SourceRecord"("datasetKey", "retrievedAt");
CREATE INDEX "SourceRecord_subjectIsin_idx" ON "SourceRecord"("subjectIsin");
CREATE INDEX "SourceRecord_subjectSymbol_idx" ON "SourceRecord"("subjectSymbol");
CREATE INDEX "SourceRecord_status_retrievedAt_idx" ON "SourceRecord"("status", "retrievedAt");

-- ── IngestionJob ────────────────────────────────────────────────────────────
-- A unit of recurring work AND its checkpoint, one row per (jobKey, scope).
-- The plan sketched a separate IngestionCheckpoint table; merged here because
-- it would have been strictly 1:1 and every read would have joined it. The
-- scope-keyed job IS the checkpoint.
--
-- Scheduling is claim-based: a worker atomically takes rows whose nextRunAt has
-- passed. It deliberately does NOT sit on the service-wide JobLease used by the
-- other background loops in this repo. The correctness property JobLease exists
-- to protect is the one from the production-readiness audit -- two replicas
-- meant two matching engines double-filling one order -- and that property is
-- preserved here. What changes is its granularity: ingestion jobs are mutually
-- independent, so serialising the whole SERVICE would idle every replica but
-- one, when the useful behaviour is several replicas each working different
-- symbols. Serialising each ROW gives the same guarantee without the idling.
CREATE TABLE "IngestionJob" (
    "id" TEXT NOT NULL,
    "jobKey" TEXT NOT NULL,
    -- A symbol, or 'market' for whole-market datasets.
    "scope" TEXT NOT NULL,
    "dataSourceId" TEXT,
    -- Opaque per-connector position: a date window, a page token.
    "cursor" TEXT,
    -- Highest upstream id already ingested. This is how the announcements feed
    -- is polled: measured 2026-08-19, one company's feed is 3,341 rows / 2.8 MB,
    -- so re-reading it whole every fifteen minutes is not an option.
    "lastSeenId" TEXT,
    -- Hash of the last payload, so an unchanged whole-market file is a no-op.
    "lastContentHash" TEXT,
    "intervalMs" INTEGER NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRunAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    -- 'idle' | 'running' | 'failed' | 'disabled'
    "state" TEXT NOT NULL DEFAULT 'idle',
    -- Per-JOB claim rather than the service-wide JobLease used elsewhere here.
    -- Ingestion jobs are mutually independent, so a leader lease would idle
    -- every replica but one when what we want is many replicas each working on
    -- different symbols. The property JobLease protects -- never two writers on
    -- the same work -- is kept, enforced per row by an atomic conditional
    -- UPDATE instead of per service.
    "claimedBy" TEXT,
    -- Hard deadline on the claim. Past this instant the row is claimable again
    -- even if state still reads 'running'. That IS the crash case: a worker
    -- that dies mid-run cannot reset its own row, so a claim that were merely a
    -- boolean would strand the job forever.
    "claimExpiresAt" TIMESTAMP(3),
    -- Drives backoff and the per-source circuit breaker. Reset on success.
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestionJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IngestionJob_jobKey_scope_key" ON "IngestionJob"("jobKey", "scope");
CREATE INDEX "IngestionJob_state_nextRunAt_idx" ON "IngestionJob"("state", "nextRunAt");
CREATE INDEX "IngestionJob_claimExpiresAt_idx" ON "IngestionJob"("claimExpiresAt");
CREATE INDEX "IngestionJob_jobKey_idx" ON "IngestionJob"("jobKey");

-- ── DataQualityResult ───────────────────────────────────────────────────────
-- One validation check against one entity. Lands in Phase 1 rather than with
-- the validators in Phase 3 so that a check can never be written without an
-- honest place to record its failure.
--
-- The rule this table exists to enforce: a balance sheet that does not
-- reconcile is shown AS FLAGGED, never silently rendered as though it did.
CREATE TABLE "DataQualityResult" (
    "id" TEXT NOT NULL,
    -- What was checked: 'FinancialStatement', 'Shareholding'.
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    -- Check identifier: 'balance-sheet.identity', 'shareholding.sums-to-100'.
    "check" TEXT NOT NULL,
    -- 'error' blocks publish | 'warn' publishes with a UI flag | 'info'
    "severity" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    -- Expected, observed, tolerance, delta. Present so a failure can be argued
    -- with rather than merely believed.
    "detail" JSONB,
    "sourceRecordId" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataQualityResult_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DataQualityResult_entity_entityId_idx" ON "DataQualityResult"("entity", "entityId");
CREATE INDEX "DataQualityResult_severity_passed_observedAt_idx"
    ON "DataQualityResult"("severity", "passed", "observedAt");
CREATE INDEX "DataQualityResult_check_observedAt_idx" ON "DataQualityResult"("check", "observedAt");

-- ── Foreign keys ────────────────────────────────────────────────────────────
-- RESTRICT on delete throughout: a DataSource with fetch history must not be
-- removable, because deleting it would orphan the provenance of every number
-- derived from it. Sources are disabled (see DataSource.enabled), never dropped
-- — the same reasoning as Instrument's soft delete, and CLAUDE.md Rule 1.
ALTER TABLE "SourceRecord" ADD CONSTRAINT "SourceRecord_dataSourceId_fkey"
    FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "IngestionJob" ADD CONSTRAINT "IngestionJob_dataSourceId_fkey"
    FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DataQualityResult" ADD CONSTRAINT "DataQualityResult_sourceRecordId_fkey"
    FOREIGN KEY ("sourceRecordId") REFERENCES "SourceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
