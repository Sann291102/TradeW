/**
 * The TypeScript implementations of user-strategy conditions.
 *
 * ## The contract, and why it has two kinds
 *
 * A user condition is a pure function of the closed candle series. Some ask an
 * instantaneous question ("is price above the EMA right now?"); others ask a
 * historical one ("has a body reclaimed the EMA at any point, and did a later
 * bar close above that candle's high?"). Both must be first-class, because
 * forcing the second kind into a latest-bar boolean is exactly the failure the
 * Phase 1 verification found across the existing `strategy-rules.ts`: a rule
 * that answers "is there a fair value gap in the last three bars" cannot stand
 * in for one that answers "did this displacement leave a gap".
 *
 * The `kind` field is not used for dispatch — both kinds are the same function
 * signature. It is recorded because it is the thing a reviewer must check when
 * adding a condition, and because a `historical` condition scanning only the
 * tail of the series is a bug that is otherwise invisible.
 *
 * ## How "latching" works here
 *
 * It does not need state. `sentinel-py` appears to latch — a confirmed setup
 * stays confirmed — but it stores nothing: each evaluation re-scans the whole
 * session's candles and rediscovers the sequence. A faithful port therefore
 * scans too, and needs no event store, no persistence and no reconciliation.
 * That is why `ConditionContext` carries the full closed series rather than a
 * window.
 *
 * ## `met` versus `indeterminate`
 *
 * `met` must equal the Python boolean exactly — that is what the parity
 * harness asserts. But Python returns `False` both for "the condition is not
 * satisfied" and for "there is not enough data to say", and those must not be
 * the same thing to an agent deciding whether to trade. So `indeterminate`
 * rides alongside: it never changes `met`, and the trading gate refuses on it
 * rather than reading it as a clean negative.
 */
import type { Candle, CandleInterval } from '@tradew/types';
import {
  atr as computeAtr,
  classifySlope,
  emaOf,
  findBullishReclaim,
  findBullishReclaims,
  volumeAboveAverage,
} from './indicators';

export interface ConditionOutcome {
  /** Must match the Python evaluator's boolean for the same candles. */
  met: boolean;
  /** Plain statement of what was measured, in the Python original's shape. */
  detail: string;
  /**
   * True when the condition could not be judged rather than being false —
   * missing history, no volume, no ATR. Never affects `met`.
   */
  indeterminate?: boolean;
}

/** Everything a condition may read. Closed candles only, by construction. */
export interface ConditionContext {
  /** The closed candle series, oldest first. Never contains a forming bar. */
  candles: Candle[];
  interval: CandleInterval;
  /** The newest closed bar — the one this evaluation is about. */
  bar: Candle;
  /** Memoised ATR(14) over the series. */
  atr(): number | null;
  /** Memoised EMA series for a period. */
  ema(period: number): number[];
}

export function createContext(candles: Candle[], interval: CandleInterval): ConditionContext {
  const emaCache = new Map<number, number[]>();
  let atrCache: number | null | undefined;
  return {
    candles,
    interval,
    bar: candles[candles.length - 1],
    atr() {
      if (atrCache === undefined) atrCache = computeAtr(candles);
      return atrCache;
    },
    ema(period: number) {
      let series = emaCache.get(period);
      if (!series) {
        series = emaOf(candles, period);
        emaCache.set(period, series);
      }
      return series;
    },
  };
}

export interface UserCondition {
  id: string;
  /** See the header — recorded for review, not used for dispatch. */
  kind: 'instantaneous' | 'historical';
  /** Minimum closed bars before this condition can be judged at all. */
  minBars: number;
  /** Indicator/data dependencies, for the certification report. */
  requires: readonly string[];
  /** The Python function this is a port of, so drift has an address. */
  pythonSource: string;
  /** Intentional differences from the Python original. Empty means none. */
  divergences: readonly string[];
  evaluate(ctx: ConditionContext): ConditionOutcome;
}

const notEnough = (period: number): ConditionOutcome => ({
  met: false,
  detail: `not enough candles for an EMA-${period}`,
  indeterminate: true,
});

/**
 * V1 registry — the `ema7_bullish_reclaim` family.
 *
 * Chosen deliberately as the first certified set: it is the strategy in the
 * user's own workspace, it is long-only (so no direction inference is needed),
 * and every dependency is computable from OHLCV. It requires none of the four
 * models Phase 1 found missing — no zones, no anchored liquidity event, no
 * level/flip model, no VWAP series — so it is the shortest honest path from
 * "watching" to "autonomously paper trading".
 *
 * A condition absent from this registry is NOT tradable. There is deliberately
 * no fallback, no fuzzy match and no nearest-neighbour: `certifyStrategy`
 * reports it as unsupported and the strategy stays watch-only.
 */
export const USER_CONDITIONS: Record<string, UserCondition> = {
  /** Port of `_price_above_ema(bars, 7)`. */
  price_above_ema7: {
    id: 'price_above_ema7',
    kind: 'instantaneous',
    minBars: 7,
    requires: ['ema7'],
    pythonSource: 'evaluator._price_above_ema(bars, 7)',
    divergences: [],
    evaluate(ctx) {
      const values = ctx.ema(7);
      if (values.length === 0) return notEnough(7);
      const level = values[values.length - 1];
      const close = ctx.bar.close;
      return {
        met: close > level,
        detail: `close ${close.toFixed(2)} vs EMA-7 ${level.toFixed(2)}`,
      };
    },
  },

  /** Port of `_ema_rising(bars, 7)`. */
  ema7_rising: {
    id: 'ema7_rising',
    kind: 'instantaneous',
    // classify_slope needs lookback + 1 = 4 EMA values, and the EMA series
    // starts at candle 7, so four values need ten candles.
    minBars: 10,
    requires: ['ema7', 'atr14'],
    pythonSource: 'evaluator._ema_rising(bars, 7)',
    divergences: [
      'ATR is optional here exactly as in Python: below 15 candles classify_slope falls back to a relative threshold rather than refusing.',
    ],
    evaluate(ctx) {
      const values = ctx.ema(7);
      if (values.length === 0) return notEnough(7);
      const slope = classifySlope(values, 3, ctx.atr());
      return {
        met: slope === 'rising',
        detail: `EMA-7 is ${slope} (${values[values.length - 1].toFixed(2)})`,
      };
    },
  },

  /** Port of `_ema_body_reclaim(bars, 7)`. */
  ema7_body_reclaim: {
    id: 'ema7_body_reclaim',
    kind: 'historical',
    minBars: 7,
    requires: ['ema7'],
    pythonSource: 'evaluator._ema_body_reclaim(bars, 7)',
    divergences: [],
    evaluate(ctx) {
      const values = ctx.ema(7);
      if (values.length === 0) return notEnough(7);
      const reclaim = findBullishReclaim(ctx.candles, values);
      if (reclaim === null) {
        return { met: false, detail: 'no candle body has reached EMA-7 and closed back above it' };
      }
      return { met: true, detail: reclaim.detail };
    },
  },

  /**
   * Port of `_reclaim_followed_through(bars, 7)`.
   *
   * The patience requirement, and the reason this family needs a `historical`
   * condition kind at all: the reclaim alone is not the setup. ANY reclaim that
   * a later candle closed above counts — checking only the newest would mean a
   * candle that both confirmed an earlier reclaim and touched the EMA itself
   * reset the setup to "waiting" forever.
   */
  reclaim_retest_or_consolidation: {
    id: 'reclaim_retest_or_consolidation',
    kind: 'historical',
    minBars: 8,
    requires: ['ema7'],
    pythonSource: 'evaluator._reclaim_followed_through(bars, 7)',
    divergences: [],
    evaluate(ctx) {
      const values = ctx.ema(7);
      if (values.length === 0) return notEnough(7);
      const reclaims = findBullishReclaims(ctx.candles, values);
      if (reclaims.length === 0) {
        return { met: false, detail: 'no reclaim to follow through from' };
      }
      for (const reclaim of reclaims) {
        const trigger = ctx.candles[reclaim.index].high;
        for (let i = reclaim.index + 1; i < ctx.candles.length; i++) {
          if (ctx.candles[i].close > trigger) {
            return {
              met: true,
              detail: `closed ${ctx.candles[i].close.toFixed(2)} above the reclaim candle high ${trigger.toFixed(2)}`,
            };
          }
        }
      }
      const latest = ctx.candles[reclaims[reclaims.length - 1].index].high;
      return {
        met: false,
        detail: `waiting for a close above the reclaim candle high ${latest.toFixed(2)}`,
      };
    },
  },

  /** Port of `_volume_above_average(bars)` — 20-period, current bar excluded. */
  volume_above_20_period_avg: {
    id: 'volume_above_20_period_avg',
    kind: 'instantaneous',
    minBars: 21,
    requires: ['volume'],
    pythonSource: 'evaluator._volume_above_average(bars)',
    divergences: [
      'Deliberately NOT intelligence/indicators.ts averageVolume, which includes the current bar in its own baseline.',
    ],
    evaluate(ctx) {
      if (ctx.candles.length < 21) {
        return { met: false, detail: 'not enough candles for a 20-period volume average', indeterminate: true };
      }
      const read = volumeAboveAverage(ctx.candles, 20);
      if (read === null) {
        return { met: false, detail: 'no volume reported for this instrument', indeterminate: true };
      }
      return {
        met: read.met,
        detail: `volume ${read.latest} vs 20-period avg ${read.average.toFixed(0)}`,
      };
    },
  },
};

export function isSupportedCondition(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(USER_CONDITIONS, id);
}

/**
 * Conditions deliberately withheld from autonomous trading, with the reason.
 *
 * Kept as data rather than as an absence so the certification report can tell a
 * user "this is deferred, and here is why" instead of the far less useful
 * "unknown condition".
 */
export const DEFERRED_CONDITIONS: Record<string, string> = {
  zone_present: 'The supply/demand zone model is not implemented in TypeScript.',
  zone_reaction: 'Depends on the deferred zone model.',
  price_returns_to_zone: 'Depends on the deferred zone model.',
  zone_htf_aligned:
    'Depends on the deferred zone model, and additionally needs a higher-timeframe series the snapshot does not carry.',
};
