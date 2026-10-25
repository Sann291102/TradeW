-- Post-trade analytics: excursions, slippage, and the structured review.
--
-- ExecutionPosition.lowWaterPrice is the mirror of the existing highWaterPrice
-- and the only possible source of Maximum Adverse Excursion — no intraday price
-- series is stored per position, so MAE is either sampled while the position
-- lives or lost. It drives no decision; nothing reads it for an exit or a trail.
--
-- Added nullable, backfilled from entryPrice (the correct seed: before any tick
-- the worst price seen IS the entry), then made NOT NULL. A default of 0 would
-- have reported a 100% adverse excursion on every existing position.
ALTER TABLE "ExecutionPosition" ADD COLUMN "lowWaterPrice" DECIMAL(12,2);
UPDATE "ExecutionPosition" SET "lowWaterPrice" = "entryPrice" WHERE "lowWaterPrice" IS NULL;
ALTER TABLE "ExecutionPosition" ALTER COLUMN "lowWaterPrice" SET NOT NULL;

-- Journal columns are all nullable: a trade closed before this migration has no
-- excursion history to recover, and NULL says that honestly where a 0 would
-- claim the position never moved.
ALTER TABLE "ExecutionJournal" ADD COLUMN "mfePrice" DECIMAL(12,2);
ALTER TABLE "ExecutionJournal" ADD COLUMN "maePrice" DECIMAL(12,2);
ALTER TABLE "ExecutionJournal" ADD COLUMN "mfeAmount" DECIMAL(14,2);
ALTER TABLE "ExecutionJournal" ADD COLUMN "maeAmount" DECIMAL(14,2);
ALTER TABLE "ExecutionJournal" ADD COLUMN "mfeR" DECIMAL(10,3);
ALTER TABLE "ExecutionJournal" ADD COLUMN "maeR" DECIMAL(10,3);
ALTER TABLE "ExecutionJournal" ADD COLUMN "entrySlippage" DECIMAL(12,2);
ALTER TABLE "ExecutionJournal" ADD COLUMN "exitSlippage" DECIMAL(12,2);
ALTER TABLE "ExecutionJournal" ADD COLUMN "postTradeAnalysis" JSONB;
ALTER TABLE "ExecutionJournal" ADD COLUMN "thesisCorrect" BOOLEAN;
ALTER TABLE "ExecutionJournal" ADD COLUMN "confidenceError" DECIMAL(10,3);
