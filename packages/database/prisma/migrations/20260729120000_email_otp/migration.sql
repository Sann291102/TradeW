-- Email one-time codes (OTP login + password reset).
--
-- Written by hand rather than taken from `prisma migrate diff`, because the
-- diff at authoring time also contained unrelated pending BrokerCredential /
-- BrokerOAuthState changes from another workstream. This migration touches
-- ONLY the OTP objects.
--
-- Idempotent throughout: the repo has a history of tables being `db push`'d
-- ahead of a migration (see 20260724000000_notification_category_enum), so
-- re-running must never fail.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OtpPurpose') THEN
    CREATE TYPE "OtpPurpose" AS ENUM ('login', 'password_reset', 'email_verify');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "EmailOtp" (
  "id"         TEXT NOT NULL,
  "email"      TEXT NOT NULL,
  "purpose"    "OtpPurpose" NOT NULL,
  "codeHash"   TEXT NOT NULL,
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "attempts"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EmailOtp_pkey" PRIMARY KEY ("id")
);

-- Lookup path for "the newest live code for this address and purpose".
CREATE INDEX IF NOT EXISTS "EmailOtp_email_purpose_consumedAt_idx"
  ON "EmailOtp"("email", "purpose", "consumedAt");

-- Supports sweeping expired rows.
CREATE INDEX IF NOT EXISTS "EmailOtp_expiresAt_idx"
  ON "EmailOtp"("expiresAt");
