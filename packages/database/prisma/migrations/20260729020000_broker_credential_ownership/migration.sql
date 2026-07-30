-- Broker credential ownership + OAuth state (CSRF/replay protection).
--
-- WHY THIS MIGRATION EXISTS
--
-- 20260729010000_broker_credential created BrokerCredential with a single
-- `provider` unique index and no user FK, on the stated assumption that there is
-- "exactly one operator account behind the feed". That assumption is not
-- enforced anywhere in the API, and the consequence is a concrete authorization
-- defect: every credential write targets the same global row, so any account
-- that completes the broker consent flow overwrites the credential the platform
-- runs on, and any account can read the operator's broker client identity.
--
-- This migration replaces the assumption with an enforced ownership model:
--
--   1. BrokerCredential.userId — every credential belongs to one user, and
--      every read/write is authorized against that column. Uniqueness moves
--      from (provider) to (provider, userId).
--   2. BrokerCredential.isFeedDefault — the shared live-feed bridge needs ONE
--      designated credential. That designation is now explicit and
--      operator-gated instead of being "the only row in the table".
--   3. BrokerOAuthState — a server-side record of which authenticated user
--      started a consent flow, so the public broker callback can no longer be
--      driven by an unsolicited or replayed request.
--
-- BACKWARD COMPATIBILITY
--
-- An existing credential row has no owner and cannot be given one safely — we
-- cannot know which user it belonged to, and guessing would hand one user's
-- broker session to another. Existing rows are therefore deleted rather than
-- backfilled. The operational cost is one re-run of the consent flow (a button
-- in the UI); the alternative is a migration that invents an ownership claim.
-- The live-feed bridge keeps working throughout: it falls back to
-- DHAN_ACCESS_TOKEN exactly as it did before any credential row existed.

-- ---------------------------------------------------------------- credentials

-- Drop unowned rows before adding the NOT NULL owner column. See the note above
-- on why these are not backfilled.
DELETE FROM "BrokerCredential";

-- The global single-slot constraint is what made cross-user overwrite possible.
DROP INDEX IF EXISTS "BrokerCredential_provider_key";

ALTER TABLE "BrokerCredential" ADD COLUMN "userId" TEXT NOT NULL;
ALTER TABLE "BrokerCredential" ADD COLUMN "isFeedDefault" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "BrokerCredential"
    ADD CONSTRAINT "BrokerCredential_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One credential per (broker, user).
CREATE UNIQUE INDEX "BrokerCredential_provider_userId_key"
    ON "BrokerCredential"("provider", "userId");

CREATE INDEX "BrokerCredential_provider_isFeedDefault_idx"
    ON "BrokerCredential"("provider", "isFeedDefault");

-- At most one feed-default credential per provider, enforced in the database
-- rather than in application code. Prisma's schema language cannot express a
-- partial unique index, so this constraint exists only here — it is referenced
-- from the `isFeedDefault` doc comment in schema.prisma so it is not lost.
CREATE UNIQUE INDEX "BrokerCredential_provider_feedDefault_key"
    ON "BrokerCredential"("provider")
    WHERE "isFeedDefault" = true;

-- --------------------------------------------------------------- oauth state

CREATE TABLE "BrokerOAuthState" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- SHA-256 of the state value. The value itself is never stored, so a read
    -- of this table yields nothing an attacker can present to the callback.
    "stateHash" TEXT NOT NULL,
    "consentAppId" TEXT,
    -- Non-null means already used. This column is what makes replay an
    -- observable, rejectable event instead of a silent second success.
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrokerOAuthState_pkey" PRIMARY KEY ("id")
);

-- Unique so a replayed state value collides on insert rather than producing a
-- second independently-usable row.
CREATE UNIQUE INDEX "BrokerOAuthState_stateHash_key" ON "BrokerOAuthState"("stateHash");

CREATE INDEX "BrokerOAuthState_provider_userId_consumedAt_idx"
    ON "BrokerOAuthState"("provider", "userId", "consumedAt");

-- Supports the sweep that deletes expired states.
CREATE INDEX "BrokerOAuthState_expiresAt_idx" ON "BrokerOAuthState"("expiresAt");

ALTER TABLE "BrokerOAuthState"
    ADD CONSTRAINT "BrokerOAuthState_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
