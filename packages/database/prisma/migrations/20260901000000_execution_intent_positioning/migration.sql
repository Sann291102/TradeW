-- ============================================================================
-- OPTION POSITIONING ON THE EXECUTION INTENT
--
-- Two additive, nullable JSONB columns recording what the option BOOK looked
-- like at the moment a decision was made — the defended levels, the previous
-- close's open interest beside today's, the four-quadrant action per strike,
-- and whether that book agreed with the side in focus.
--
-- Nullable with no default and no backfill. An intent written before this
-- migration was decided without the positioning gate; giving those rows an
-- empty object would assert that the gate ran and found nothing, which is a
-- different and false statement.
--
-- WHY A COLUMN AND NOT A LATER RE-READ
--
-- `previous_oi` is the previous SESSION's close. It is overwritten every
-- session, so a decision's change-in-open-interest cannot be reconstructed
-- after the fact from any source — not from the broker, not from the chain,
-- not from a cache. Either it is recorded in the same INSERT as the decision
-- it explains, or the most useful half of the option read is gone by the next
-- morning, which is exactly when the daily calibration loop asks for it.
--
-- `ExecutionEnvironment` is UNTOUCHED. Nothing here creates a representation
-- of live money.
-- ============================================================================

ALTER TABLE "ExecutionIntent"
  ADD COLUMN "positioning"          JSONB,
  ADD COLUMN "positioningJudgement" JSONB;

-- The journal keeps its own copy for the same reason it keeps a copy of
-- everything else: it must state what the agent knew AT THE TIME, and a view
-- back onto the intent would start answering a different question as soon as
-- anything upstream was retuned. This copy is what lets the daily loop ask
-- whether the positioning gate's judgement actually correlated with outcomes.
ALTER TABLE "ExecutionJournal"
  ADD COLUMN "positioning"          JSONB,
  ADD COLUMN "positioningJudgement" JSONB;
