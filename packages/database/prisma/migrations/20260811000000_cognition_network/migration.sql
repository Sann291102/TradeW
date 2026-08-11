-- The four-layer perceptor network. See the Cognition block in schema.prisma
-- for why there are five tables and why their retention policies differ.
--
-- Additive only: five new tables, no column added to or removed from any
-- existing one. Safe to apply ahead of the code that reads it, and safe to
-- leave in place if that code is rolled back.
--
-- Authored by hand from the schema rather than via `prisma migrate dev`, which
-- refuses to run in a non-interactive shell (see knowledge/_INDEX.md, Gotchas).

-- CreateTable
CREATE TABLE "Percept" (
    "id" TEXT NOT NULL,
    "perceptorId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "salience" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "features" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB,
    "tags" TEXT[],
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "episodeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Percept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerceptorState" (
    "perceptorId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'healthy',
    "lastSensedAt" TIMESTAMP(3),
    "lastPerceptAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "totalPercepts" INTEGER NOT NULL DEFAULT 0,
    "meanSalience" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PerceptorState_pkey" PRIMARY KEY ("perceptorId")
);

-- CreateTable
CREATE TABLE "CognitiveEpisode" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "domain" TEXT,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "perceptCount" INTEGER NOT NULL DEFAULT 0,
    "gatedCount" INTEGER NOT NULL DEFAULT 0,
    "collapsedCount" INTEGER NOT NULL DEFAULT 0,
    "hypothesisCount" INTEGER NOT NULL DEFAULT 0,
    "promotedCount" INTEGER NOT NULL DEFAULT 0,
    "proposalCount" INTEGER NOT NULL DEFAULT 0,
    "layerTimings" JSONB,
    "error" TEXT,
    "reward" DOUBLE PRECISION,
    "rewardReason" TEXT,
    "scoredAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CognitiveEpisode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CognitiveProposal" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "perceptIds" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolvedBy" TEXT,
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CognitiveProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- The only irreplaceable table here. A weight represents weeks of accumulated
-- outcomes and cannot be recomputed from any other table — anything that
-- truncates this is data loss, not a cache eviction.
CREATE TABLE "NeuralSynapse" (
    "id" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 0.35,
    "activations" INTEGER NOT NULL DEFAULT 0,
    "reinforcements" INTEGER NOT NULL DEFAULT 0,
    "meanReward" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "lastActivatedAt" TIMESTAMP(3),
    "lastReinforcedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NeuralSynapse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Percept_createdAt_idx" ON "Percept"("createdAt");
CREATE INDEX "Percept_episodeId_idx" ON "Percept"("episodeId");
CREATE INDEX "Percept_domain_createdAt_idx" ON "Percept"("domain", "createdAt");
CREATE INDEX "Percept_perceptorId_createdAt_idx" ON "Percept"("perceptorId", "createdAt");
-- Answers "what has the network noticed about this route / this symbol", which
-- is the question an operator arrives with during an incident.
CREATE INDEX "Percept_subjectType_subjectId_createdAt_idx" ON "Percept"("subjectType", "subjectId", "createdAt");

-- CreateIndex
CREATE INDEX "PerceptorState_domain_idx" ON "PerceptorState"("domain");
CREATE INDEX "PerceptorState_status_idx" ON "PerceptorState"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CognitiveEpisode_episodeId_key" ON "CognitiveEpisode"("episodeId");
CREATE INDEX "CognitiveEpisode_startedAt_idx" ON "CognitiveEpisode"("startedAt");
CREATE INDEX "CognitiveEpisode_domain_startedAt_idx" ON "CognitiveEpisode"("domain", "startedAt");
CREATE INDEX "CognitiveEpisode_status_startedAt_idx" ON "CognitiveEpisode"("status", "startedAt");
-- Supports "which episodes are still unscored" — a stalled feedback loop stops
-- all learning, and does it silently.
CREATE INDEX "CognitiveEpisode_scoredAt_idx" ON "CognitiveEpisode"("scoredAt");

-- CreateIndex
CREATE INDEX "CognitiveProposal_status_createdAt_idx" ON "CognitiveProposal"("status", "createdAt");
CREATE INDEX "CognitiveProposal_domain_createdAt_idx" ON "CognitiveProposal"("domain", "createdAt");
CREATE INDEX "CognitiveProposal_episodeId_idx" ON "CognitiveProposal"("episodeId");

-- CreateIndex
-- The natural key. Weight flushes upsert through it on every tick, so it is a
-- unique constraint rather than a plain index.
CREATE UNIQUE INDEX "NeuralSynapse_layer_source_target_key" ON "NeuralSynapse"("layer", "source", "target");
CREATE INDEX "NeuralSynapse_layer_weight_idx" ON "NeuralSynapse"("layer", "weight");
CREATE INDEX "NeuralSynapse_source_idx" ON "NeuralSynapse"("source");
CREATE INDEX "NeuralSynapse_target_idx" ON "NeuralSynapse"("target");
