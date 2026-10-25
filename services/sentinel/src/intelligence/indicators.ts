/**
 * Re-export shim. The implementation moved to `@tradew/strategy-core`.
 *
 * Indicator math is part of the decision core, and the decision core had to
 * stop living inside a service so the autonomous engine and the backtester
 * could share it with Sentinel rather than each carrying a copy.
 *
 * The path and the exported surface are both preserved EXACTLY, so every
 * existing import site stays correct and this extraction changes no behaviour.
 * Named rather than `export *` deliberately: a star re-export would widen this
 * module to the whole package, and a shim that exports more than the file it
 * replaces is not a shim. New code should import from `@tradew/strategy-core`.
 */

export {
  ema,
  rsi,
  vwap,
  macd,
  cpr,
  averageVolume,
  swingLevels,
  realizedVolatilityPct,
  oiTrend,
} from '@tradew/strategy-core';
