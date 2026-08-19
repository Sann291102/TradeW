-- Company Intelligence — Phase 3: financial statements.
--
-- WHY KEY/VALUE AND NOT TWO HUNDRED COLUMNS
-- A wide ProfitAndLoss table with a column per line reads better in a query and
-- is the wrong shape here. Filers share the in-bse-fin Ind-AS taxonomy but use
-- DIFFERENT SUBSETS of it: a bank files lines a manufacturer never touches, and
-- a company with discontinued operations files tags most companies omit. A wide
-- table needs a migration every time a filer uses a tag we had not seen, and
-- 2,550 companies will keep finding them. Key/value absorbs that as data.
--
-- The cost is that a line item means only as much as its conceptKey, which is
-- why FinancialConcept is a real table rather than a naming convention.
--
-- Design: knowledge/Plans/2026-08-19 - Company Intelligence Platform §D/§F/§G.
-- Source verified 2026-08-19: knowledge/API/2026-08-19 - NSE corporate filings
-- and XBRL fundamentals.

-- ── FinancialStatement ──────────────────────────────────────────────────────
-- One statement, one company, one period, one basis.
--
-- A single filed document produces SEVERAL rows. A quarterly results XBRL
-- carries both the three-month column and the cumulative year-to-date column —
-- different periods, therefore different statements. An annual filing carries
-- P&L, balance sheet and cash flow for one period — different types, therefore
-- also different rows.
CREATE TABLE "FinancialStatement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    -- 'PL' | 'BS' | 'CF'
    "statementType" TEXT NOT NULL,
    -- 'STANDALONE' | 'CONSOLIDATED'. Never inferred: the filing asserts it in
    -- NatureOfReportStandaloneConsolidated, and NSE serves the two bases as
    -- separate documents. A series that silently mixed them would show a
    -- parent-only revenue beside a group revenue and call the difference growth.
    "consolidation" TEXT NOT NULL,
    -- 'Q' | 'H' | '9M' | 'A', derived from the period LENGTH, not from the
    -- document's label: the label on the cumulative column of a Q3 filing still
    -- reads "Third quarter".
    "frequency" TEXT NOT NULL,
    -- THE AUTHORITATIVE PERIOD, from the DateOfStartOfReportingPeriod /
    -- DateOfEndOfReportingPeriod FACTS -- never from the xbrli:context.
    --
    -- Verified 2026-08-19: RELIANCE's Q3 FY25 filing declares context FourD as
    -- 2024-10-01 -> 2024-12-31 while its reporting-period facts say 2024-04-01
    -- -> 2024-12-31, and the values confirm the facts (Rs 3,96,645 cr revenue
    -- against Rs 1,28,260 cr for the quarter -- nine months over three).
    -- Trusting the context stores nine months of profit as one quarter, and
    -- nothing errors.
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    -- Indian fiscal year (Apr-Mar), labelled by the calendar year it ends in.
    "fiscalYear" INTEGER NOT NULL,
    -- 1-4 for quarterly periods; NULL for cumulative and annual ones.
    "fiscalQuarter" INTEGER,
    -- When the exchange disseminated it. Distinct from the period covered:
    -- results arrive weeks after the quarter ends, and "most recent results"
    -- means this column.
    "announcedAt" TIMESTAMP(3),
    -- 'Audited' | 'Unaudited'. A page showing an unaudited figure beside an
    -- audited one without saying so is withholding the more important half.
    "auditStatus" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    -- Power of ten the source used. NSE Ind-AS XBRL publishes absolute rupees
    -- (0), which removes the commonest silent 100x error. Recorded anyway so a
    -- future source with another convention cannot be mistaken for this one.
    "unitScale" INTEGER NOT NULL DEFAULT 0,
    -- A restatement is a NEW row, never an overwrite; the original is retained
    -- (CLAUDE.md Rule 1). The filing flags it, so this is read, not guessed.
    "restated" BOOLEAN NOT NULL DEFAULT false,
    -- 'passed' | 'failed' | 'not-applicable' | 'pending'. A balance sheet that
    -- does not balance is stored as 'failed' and rendered AS FLAGGED -- never
    -- silently shown as though it reconciled, and never dropped, because a
    -- filing that does not reconcile is itself a finding.
    "reconciliationStatus" TEXT NOT NULL DEFAULT 'pending',
    "sourceRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialStatement_pkey" PRIMARY KEY ("id")
);

-- One statement per (company, type, basis, frequency, period, revision).
-- Re-ingesting a filing is therefore a no-op, and a genuine restatement is a
-- different row rather than a conflict.
CREATE UNIQUE INDEX "FinancialStatement_unique_period"
    ON "FinancialStatement"("companyId", "statementType", "consolidation", "frequency", "periodEnd", "restated");
CREATE INDEX "FinancialStatement_companyId_statementType_periodEnd_idx"
    ON "FinancialStatement"("companyId", "statementType", "periodEnd");
CREATE INDEX "FinancialStatement_companyId_fiscalYear_idx" ON "FinancialStatement"("companyId", "fiscalYear");
CREATE INDEX "FinancialStatement_reconciliationStatus_idx" ON "FinancialStatement"("reconciliationStatus");

-- ── FinancialLineItem ───────────────────────────────────────────────────────
CREATE TABLE "FinancialLineItem" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    -- Canonical key. NULL when the source tag has no mapping yet: the value is
    -- kept with its raw tag and raised as a coverage finding, so unmapped tags
    -- are measurable rather than silently lost.
    "conceptKey" TEXT,
    -- Exactly as the filer tagged it, always retained. When a mapping turns out
    -- to be wrong, re-deriving from this beats re-fetching a document the
    -- exchange may have moved.
    "rawTag" TEXT NOT NULL,
    "value" DECIMAL(24,4) NOT NULL,
    -- 1 for a filed figure; below 1 for anything we computed because the filing
    -- omitted it. A derived EBITDA must never be presentable as a filed one.
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,

    CONSTRAINT "FinancialLineItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinancialLineItem_statementId_rawTag_key" ON "FinancialLineItem"("statementId", "rawTag");
CREATE INDEX "FinancialLineItem_statementId_conceptKey_idx" ON "FinancialLineItem"("statementId", "conceptKey");
CREATE INDEX "FinancialLineItem_conceptKey_idx" ON "FinancialLineItem"("conceptKey");

-- ── FinancialConcept ────────────────────────────────────────────────────────
-- The canonical chart of accounts. A real table rather than an enum because it
-- drives three things at once: what the UI renders and in what order, what the
-- validators check, and what ConceptMapping may point at. A concept that is not
-- here cannot be mapped to, which is what stops the vocabulary drifting.
CREATE TABLE "FinancialConcept" (
    "conceptKey" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    -- Parent in the presentation tree: indented rendering, and checking that
    -- children sum to their subtotal.
    "parentKey" TEXT,
    -- +1 when a positive value increases the subtotal, -1 when it reduces it
    -- (expenses, tax, outflows). Applied ONCE at normalisation so every
    -- consumer can add without knowing the accounting convention.
    "sign" INTEGER NOT NULL DEFAULT 1,
    -- True for totals the filing itself reports. Validators check these against
    -- the sum of their children.
    "isSubtotal" BOOLEAN NOT NULL DEFAULT false,
    "ordinal" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "FinancialConcept_pkey" PRIMARY KEY ("conceptKey")
);

CREATE INDEX "FinancialConcept_statement_ordinal_idx" ON "FinancialConcept"("statement", "ordinal");

-- ── ConceptMapping ──────────────────────────────────────────────────────────
-- Every normalisation rule is a ROW, not a branch in a parser: reviewable,
-- diffable, testable without running an ingest. validFrom means a taxonomy
-- revision ADDS a mapping rather than rewriting history -- the old rule stays
-- true for the documents it was applied to.
CREATE TABLE "ConceptMapping" (
    "id" TEXT NOT NULL,
    -- Which source's vocabulary this belongs to. Two sources can spell the same
    -- concept differently and must not collide.
    "sourceVocabulary" TEXT NOT NULL,
    "rawTag" TEXT NOT NULL,
    "conceptKey" TEXT NOT NULL,
    -- Power-of-ten adjustment to absolute currency units. 0 for NSE Ind-AS XBRL.
    "scale" INTEGER NOT NULL DEFAULT 0,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConceptMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConceptMapping_sourceVocabulary_rawTag_validFrom_key"
    ON "ConceptMapping"("sourceVocabulary", "rawTag", "validFrom");
CREATE INDEX "ConceptMapping_sourceVocabulary_rawTag_idx" ON "ConceptMapping"("sourceVocabulary", "rawTag");
CREATE INDEX "ConceptMapping_conceptKey_idx" ON "ConceptMapping"("conceptKey");

-- ── Foreign keys ────────────────────────────────────────────────────────────
-- CASCADE from company to statement and from statement to line item: those rows
-- describe their parent and are meaningless without it. Provenance links are
-- SET NULL -- losing the trail must never take the data with it.
ALTER TABLE "FinancialStatement" ADD CONSTRAINT "FinancialStatement_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FinancialStatement" ADD CONSTRAINT "FinancialStatement_sourceRecordId_fkey"
    FOREIGN KEY ("sourceRecordId") REFERENCES "SourceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FinancialLineItem" ADD CONSTRAINT "FinancialLineItem_statementId_fkey"
    FOREIGN KEY ("statementId") REFERENCES "FinancialStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConceptMapping" ADD CONSTRAINT "ConceptMapping_conceptKey_fkey"
    FOREIGN KEY ("conceptKey") REFERENCES "FinancialConcept"("conceptKey") ON DELETE RESTRICT ON UPDATE CASCADE;
