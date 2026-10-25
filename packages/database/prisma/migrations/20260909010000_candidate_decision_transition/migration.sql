-- Allow one REFUSAL and one ACCEPTANCE per setup per bar.
--
-- The original key was (symbol, setupId, timeframe, signalBarAt), which looked
-- right and lost information. The snapshot's `lastPrice` is the venue's live
-- ticker, so a rule reading it can genuinely flip inside a single bar: a first
-- poll that refused kept its row, and the later poll that ACCEPTED was dropped
-- as a duplicate. Observed live on 2026-09-09 — BTCUSDT/agent-ema-cross was
-- accepted at 20:07 while the table still held its 19:45 refusal.
--
-- Adding `accepted` caps each setup-bar at two immutable rows and captures the
-- transition, without reopening the thirtyfold duplication that per-poll
-- writing would cause.
DROP INDEX "AutonomousCandidate_symbol_setupId_timeframe_signalBarAt_key";

CREATE UNIQUE INDEX "AutonomousCandidate_symbol_setupId_timeframe_signalBarAt_acce_key"
  ON "AutonomousCandidate"("symbol", "setupId", "timeframe", "signalBarAt", "accepted");
