-- Broker credentials obtained through a broker's OAuth/consent flow.
--
-- A token minted at runtime has nowhere else to live: Dhan's app-key flow
-- returns the access token after the user completes 2FA in a browser, and
-- environment variables are read once at process start and cannot be rewritten.
-- Persisting it here is what turns re-consent into a button instead of a manual
-- edit of services/market-data/.env plus a restart.
--
-- Dhan access tokens are valid for 24 hours (their documentation, verified
-- 2026-07-29), so this row is expected to be replaced daily.
--
-- No user FK: these are operator-level broker credentials, not per-user links.
-- If per-user broker linking is ever added, `accessToken` must be encrypted at
-- rest before that ships.

-- CreateTable
CREATE TABLE "BrokerCredential" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "brokerClientId" TEXT,
    "brokerClientName" TEXT,
    "accessToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'consent',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrokerCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrokerCredential_provider_key" ON "BrokerCredential"("provider");
