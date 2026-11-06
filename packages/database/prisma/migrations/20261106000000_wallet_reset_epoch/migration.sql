-- ============================================================================
-- WALLET RESET EPOCH
--
-- One additive, nullable column: when the paper account was last reset to its
-- starting balance. Performance figures (portfolio value, daily P&L, returns,
-- win/loss counts) count only from this instant, because a reset keeps every
-- Order and Trade row but restores the capital.
--
-- Nullable with no default and no backfill: an account that has never been
-- reset has no epoch, which is exactly what NULL says.
-- ============================================================================

ALTER TABLE "PaperWallet" ADD COLUMN "resetAt" TIMESTAMP(3);
