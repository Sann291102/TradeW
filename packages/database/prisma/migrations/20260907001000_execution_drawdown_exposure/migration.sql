-- Give-back and concentration bounds for autonomous paper agents.
--
-- maxDrawdownPct: stops entries once the account has surrendered this % of its
--   intraday PEAK realized equity. Distinct from maxLossPerDay, which is an
--   absolute floor and never fires on a day that runs +50,000 then gives back
--   45,000. Computed from today's Trade rows; no stored high-water mark.
-- maxPortfolioExposurePct: bounds the COMBINED premium at risk across all of a
--   profile's open positions. capitalAllocationPct bounds only ONE position.
--
-- Both nullable = disabled, so every existing profile keeps its behaviour with
-- no backfill.
ALTER TABLE "ExecutionProfile" ADD COLUMN "maxDrawdownPct" DECIMAL(6,3);
ALTER TABLE "ExecutionProfile" ADD COLUMN "maxPortfolioExposurePct" DECIMAL(6,3);
