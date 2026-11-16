/**
 * Re-export shim. The implementation moved to `@tradew/strategy-core`.
 *
 * `STRATEGY_RULES` is the rule vocabulary every setup is composed from, and it
 * is the single most important thing to share: a backtest that evaluated a
 * different copy of these predicates than the live engine would be measuring a
 * strategy nobody runs.
 *
 * The path and the exported surface are both preserved EXACTLY, so every
 * existing import site stays correct and this extraction changes no behaviour.
 * Named rather than `export *` deliberately: a star re-export would widen this
 * module to the whole package, and a shim that exports more than the file it
 * replaces is not a shim. New code should import from `@tradew/strategy-core`.
 */

export {
  STRATEGY_RULES,
  isKnownRule,
} from '@tradew/strategy-core';

export type {
  RuleOutcome,
  StrategyRule,
} from '@tradew/strategy-core';
