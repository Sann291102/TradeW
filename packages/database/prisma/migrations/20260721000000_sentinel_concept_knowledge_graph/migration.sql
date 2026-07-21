-- Sentinel Concept Knowledge Graph — the reasoning ontology's runtime projection.
-- Canonical source of truth is YAML under knowledge-base/; these tables are
-- rebuilt from it by scripts/seed-ontology.ts. Purely additive: no existing
-- table, column or index is altered or dropped.
-- Generated with: prisma migrate diff --from-url $DATABASE_URL --to-schema-datamodel ... --script

-- CreateTable
CREATE TABLE "ConceptNode" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'canonical',
    "maturity" TEXT NOT NULL DEFAULT 'established',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "summary" TEXT NOT NULL,
    "definition" TEXT NOT NULL,
    "explainer" TEXT NOT NULL,
    "observableWhen" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "examples" JSONB NOT NULL DEFAULT '[]',
    "sources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "supersededBy" TEXT,
    "supersedes" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'canonical',
    "sourcePath" TEXT,
    "checksum" TEXT,
    "observationCount" INTEGER NOT NULL DEFAULT 0,
    "lastObservedAt" TIMESTAMP(3),
    "embedding" vector,
    "embeddingModel" TEXT,
    "embeddingDim" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConceptNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConceptEdge" (
    "id" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "note" TEXT,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "learnedWeight" DOUBLE PRECISION,
    "supportCount" INTEGER NOT NULL DEFAULT 0,
    "refuteCount" INTEGER NOT NULL DEFAULT 0,
    "lastObservedAt" TIMESTAMP(3),
    "origin" TEXT NOT NULL DEFAULT 'canonical',
    "status" TEXT NOT NULL DEFAULT 'canonical',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConceptEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConceptObservation" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "edgeId" TEXT,
    "symbol" TEXT,
    "outcome" TEXT NOT NULL,
    "strength" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "context" JSONB NOT NULL DEFAULT '{}',
    "observationId" TEXT,
    "namespace" TEXT NOT NULL DEFAULT 'global',
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConceptObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConceptPromotion" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "conceptId" TEXT,
    "fromConcept" TEXT,
    "toConcept" TEXT,
    "relation" TEXT,
    "rationale" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "supportCount" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConceptPromotion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConceptNode_conceptId_key" ON "ConceptNode"("conceptId");

-- CreateIndex
CREATE INDEX "ConceptNode_domain_idx" ON "ConceptNode"("domain");

-- CreateIndex
CREATE INDEX "ConceptNode_status_confidence_idx" ON "ConceptNode"("status", "confidence");

-- CreateIndex
CREATE INDEX "ConceptNode_origin_idx" ON "ConceptNode"("origin");

-- CreateIndex
CREATE INDEX "ConceptEdge_fromId_relation_idx" ON "ConceptEdge"("fromId", "relation");

-- CreateIndex
CREATE INDEX "ConceptEdge_toId_relation_idx" ON "ConceptEdge"("toId", "relation");

-- CreateIndex
CREATE INDEX "ConceptEdge_origin_status_idx" ON "ConceptEdge"("origin", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ConceptEdge_fromId_toId_relation_key" ON "ConceptEdge"("fromId", "toId", "relation");

-- CreateIndex
CREATE INDEX "ConceptObservation_conceptId_observedAt_idx" ON "ConceptObservation"("conceptId", "observedAt");

-- CreateIndex
CREATE INDEX "ConceptObservation_edgeId_idx" ON "ConceptObservation"("edgeId");

-- CreateIndex
CREATE INDEX "ConceptObservation_symbol_observedAt_idx" ON "ConceptObservation"("symbol", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConceptPromotion_dedupeKey_key" ON "ConceptPromotion"("dedupeKey");

-- CreateIndex
CREATE INDEX "ConceptPromotion_status_confidence_idx" ON "ConceptPromotion"("status", "confidence");

-- AddForeignKey
ALTER TABLE "ConceptEdge" ADD CONSTRAINT "ConceptEdge_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "ConceptNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptEdge" ADD CONSTRAINT "ConceptEdge_toId_fkey" FOREIGN KEY ("toId") REFERENCES "ConceptNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptObservation" ADD CONSTRAINT "ConceptObservation_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "ConceptNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

