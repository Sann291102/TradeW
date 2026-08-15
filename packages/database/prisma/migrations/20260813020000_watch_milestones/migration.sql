-- In-trade milestone tracking for sentinel-py's WatchSession (P4).
--
-- Which R-multiples ("1R", "2R", "3R") have already been announced for the
-- CURRENT position. Without this, every sweep after price crosses 1R would
-- re-announce 1R — the milestone is a level, not an event, so the fact that
-- it has been reported has to be remembered somewhere durable rather than in
-- the sweep process's memory.
--
-- Reset to '[]' when a position is opened, so a second position on the same
-- watch starts its own milestone history.
--
-- Additive only. Safe to apply to a running deployment.

ALTER TABLE "WatchSession"
  ADD COLUMN "reachedMilestones" JSONB NOT NULL DEFAULT '[]';
