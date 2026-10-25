/**
 * Which brain decided.
 *
 * Every scan and every candidate carries this. It exists so that a season of
 * results is never averaged across two different decision systems — the same
 * argument `StrategyCalibration` already makes for keying on a strategy's rule
 * set version, applied one level up.
 *
 * ## When to bump it
 *
 * Whenever the DECISION would change for the same market state: a rule added
 * or removed from a setup, a level archetype changed, a threshold in
 * `levels.ts` moved. Not for a logging change, a schema addition, or a fix to
 * something that could not affect an outcome.
 *
 * Getting this wrong is quiet and expensive. A threshold moved without a bump
 * makes the learning dataset a mixture of two populations that look identical
 * in every column, and every aggregate computed over the boundary is a claim
 * about a brain that never existed.
 *
 * ## Why a constant and not a hash
 *
 * A content hash of the rule set would bump itself, which sounds better and is
 * worse: it would also change on a comment edit, fragmenting the dataset into
 * unusable slivers. The judgement of "did this change the decision?" is the
 * author's, and recording it deliberately is the point.
 */
export const BRAIN_VERSION = '1.0.0';
