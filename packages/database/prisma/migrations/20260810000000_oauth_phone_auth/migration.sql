-- Google sign-in and phone OTP sign-in.
--
-- Written by hand rather than generated so the EmailOtp -> Otp change is a
-- RENAME, not a drop-and-recreate. A generated migration would have discarded
-- every live password-reset code in flight at deploy time, silently breaking
-- resets for anyone mid-flow.

-- ---------------------------------------------------------------- User
-- passwordHash becomes nullable: a Google-only account has no password.
-- Existing rows are unaffected (all currently hold a hash).
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

ALTER TABLE "User" ADD COLUMN "googleId" TEXT;
ALTER TABLE "User" ADD COLUMN "phone" TEXT;
ALTER TABLE "User" ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3);

-- Unique but nullable: Postgres treats NULLs as distinct, so many accounts may
-- have no Google link / no phone while no two can share one.
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- ------------------------------------------------------------ OtpPurpose
ALTER TYPE "OtpPurpose" ADD VALUE IF NOT EXISTS 'phone_verify';

-- -------------------------------------------------------- EmailOtp -> Otp
ALTER TABLE "EmailOtp" RENAME TO "Otp";
ALTER TABLE "Otp" RENAME COLUMN "email" TO "destination";

ALTER INDEX "EmailOtp_pkey" RENAME TO "Otp_pkey";
ALTER INDEX "EmailOtp_email_purpose_consumedAt_idx" RENAME TO "Otp_destination_purpose_consumedAt_idx";
ALTER INDEX "EmailOtp_expiresAt_idx" RENAME TO "Otp_expiresAt_idx";
