/**
 * Re-export shim. The implementation moved to `@tradew/strategy-core`.
 *
 * Swing structure, sweeps and displacement are what a structural stop is
 * derived FROM, so this module had to be reachable by the autonomous engine
 * without importing Sentinel.
 *
 * The path and the exported surface are both preserved EXACTLY, so every
 * existing import site stays correct and this extraction changes no behaviour.
 * Named rather than `export *` deliberately: a star re-export would widen this
 * module to the whole package, and a shim that exports more than the file it
 * replaces is not a shim. New code should import from `@tradew/strategy-core`.
 */

export {
  findSwings,
  analyseStructure,
  analyseLiquidity,
  detectSweep,
  readBehaviour,
} from '@tradew/strategy-core';

export type {
  SwingPoint,
  StructureState,
  StructureEventKind,
  MarketStructure,
  LiquidityPool,
  LiquidityRead,
  BehaviourRead,
  MarketBehaviour,
} from '@tradew/strategy-core';
