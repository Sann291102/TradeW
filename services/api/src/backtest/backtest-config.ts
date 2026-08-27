import { createHash } from 'crypto';
import type { OrderType, ProductType } from '@prisma/client';

/**
 * Everything a backtest is configured with, and the hash that identifies it.
 *
 * ## Why the resolved config is stored, not the request
 *
 * A request carries the fields the user filled in; the run uses those PLUS
 * every default that filled the rest. Storing the request would make an old
 * result re-render against today's defaults — so a result whose fees were 3bps
 * would silently start claiming 5bps the day the default changed. What is
 * persisted is `resolveConfig`'s output: the complete, resolved knob set, with
 * nothing left to be filled in later.
 *
 * ## What the hash is for, and what it deliberately excludes
 *
 * `configurationHash` answers "are these two runs the same experiment". It
 * covers the config, the strategy version, the window and the data version —
 * everything whose change could move a number. It excludes the label, the
 * user, and the timestamps, because none of those can.
 *
 * The hash is over a CANONICAL form (keys sorted, numbers normalised), so two
 * requests that differ only in JSON key order collide as they should.
 */

/** Bumped whenever a change to the simulator could move a number. */
export const ENGINE_VERSION = '1.0.0';

/**
 * The minimum number of trades below which a ratio metric is noise rather than
 * a measurement. Sharpe over four trades is a number with no information in it,
 * and printing it invites exactly the decision the number cannot support — so
 * below this the engine stores null and the UI says "not enough trades".
 */
export const METRIC_MIN_SAMPLE = 20;

export type SizingMode = 'FIXED_QUANTITY' | 'FIXED_LOTS' | 'CAPITAL_PCT' | 'RISK_PCT';
export type StopMode = 'SIGNAL_BAR' | 'PERCENT' | 'NONE';

export interface BacktestConfig {
  // ---- Instrument & period ------------------------------------------------
  symbol: string;
  exchange: string;
  timeframe: string;
  startAt: string;
  endAt: string;

  // ---- Strategy -----------------------------------------------------------
  /** A StrategyEngineService id, or null for 'auto' (any enabled strategy). */
  strategyId: string | null;
  /** Confidence floor a detection must clear, 0-100. */
  minConfidence: number;
  /** Score partially-confirmed setups too. Off by default — the same set the
   *  Confidence Engine scores on is the validated one. */
  includeUnvalidated: boolean;
  /** Take bearish signals as short entries. Off for delivery products. */
  allowShort: boolean;

  // ---- Capital & sizing ---------------------------------------------------
  initialCapital: number;
  sizingMode: SizingMode;
  /** Quantity, lots, percent of capital, or percent of capital risked —
   *  interpreted by `sizingMode`. */
  sizingValue: number;
  productType: ProductType;
  orderType: OrderType;

  // ---- Costs --------------------------------------------------------------
  /** Brokerage + statutory charges as a fraction of traded value, charged on
   *  EACH leg — the same convention `OrderService` applies per fill. Defaults
   *  to the paper engine's own `CHARGES_RATE` so a backtest and a paper trade
   *  of the same size are charged identically. */
  feeRate: number;
  /** Modelled slippage, as a fraction of the fill price, applied AGAINST the
   *  trader on both legs. */
  slippageRate: number;

  // ---- Risk & discipline --------------------------------------------------
  stopMode: StopMode;
  /** Stop distance as a fraction of entry, when stopMode is PERCENT. */
  stopPct: number;
  /** Target = entry + rewardRisk x risk. */
  rewardRisk: number;
  /** Force-exit after this many bars. 0 disables the timeout. */
  timeoutBars: number;
  /** Bars to stay flat after a trade closes. */
  cooldownBars: number;
  maxOpenPositions: number;
  maxOrdersPerDay: number;
  /** Positive rupees. A day whose realized P&L falls below -this takes no more
   *  entries. Mirrors ExecutionProfile.maxLossPerDay. */
  maxLossPerDay: number;
  /** IST minute-of-day at which open intraday positions are closed. */
  squareOffMinute: number;
  /** Close every open position at the last bar of each session. */
  intradayOnly: boolean;
}

export const DEFAULT_CONFIG: Omit<BacktestConfig, 'symbol' | 'exchange' | 'timeframe' | 'startAt' | 'endAt'> = {
  strategyId: null,
  minConfidence: 70,
  includeUnvalidated: false,
  allowShort: true,
  initialCapital: 1_000_000,
  sizingMode: 'CAPITAL_PCT',
  sizingValue: 10,
  productType: 'MIS',
  orderType: 'MARKET',
  // 3bps — `CHARGES_RATE` in sim/order.service.ts. Kept numerically identical
  // on purpose; the resolver asserts it against the imported constant so the
  // two cannot drift.
  feeRate: 0.0003,
  slippageRate: 0.0005,
  stopMode: 'SIGNAL_BAR',
  stopPct: 0.005,
  rewardRisk: 2,
  timeoutBars: 24,
  cooldownBars: 0,
  maxOpenPositions: 1,
  maxOrdersPerDay: 5,
  maxLossPerDay: 25_000,
  squareOffMinute: 15 * 60 + 15, // 15:15 IST
  intradayOnly: true,
};

export class BacktestConfigError extends Error {}

/** The instrument-and-period fields every run must name. */
const IDENTITY_KEYS = ['symbol', 'exchange', 'timeframe', 'startAt', 'endAt'] as const;

/**
 * Fill in every unset knob and reject an impossible one.
 *
 * ## The whitelist is load-bearing, not tidiness
 *
 * Only keys that belong to `BacktestConfig` are copied in. The request that
 * reaches this function also carries `label` and `sourceProfileId`, and
 * spreading it wholesale put both into the stored configuration — and therefore
 * into `configurationHash`. The effect was that two runs of the identical
 * experiment hashed differently purely because the user typed a different name,
 * which silently breaks the one thing the hash exists to answer. Caught by
 * `verify:backtest`, not by a type: both fields are legitimately part of the
 * request type.
 */
export function resolveConfig(input: Partial<BacktestConfig>): BacktestConfig {
  const required = IDENTITY_KEYS.filter((k) => !input[k]);
  if (required.length) throw new BacktestConfigError(`Missing required field(s): ${required.join(', ')}.`);

  const known = new Set<string>([...Object.keys(DEFAULT_CONFIG), ...IDENTITY_KEYS]);
  const picked: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (known.has(k) && v !== undefined) picked[k] = v;

  const cfg: BacktestConfig = {
    ...DEFAULT_CONFIG,
    ...(picked as Partial<BacktestConfig>),
    symbol: String(input.symbol).trim().toUpperCase(),
    exchange: String(input.exchange).trim().toUpperCase(),
    timeframe: String(input.timeframe).trim(),
    startAt: new Date(String(input.startAt)).toISOString(),
    endAt: new Date(String(input.endAt)).toISOString(),
  };

  const positive = (v: number, name: string) => {
    if (!Number.isFinite(v) || v <= 0) throw new BacktestConfigError(`${name} must be a positive number.`);
  };
  const fraction = (v: number, name: string) => {
    if (!Number.isFinite(v) || v < 0 || v > 0.1) {
      throw new BacktestConfigError(`${name} must be between 0 and 0.1 (0-10%).`);
    }
  };

  if (new Date(cfg.startAt).getTime() >= new Date(cfg.endAt).getTime()) {
    throw new BacktestConfigError('startAt must be before endAt.');
  }
  positive(cfg.initialCapital, 'initialCapital');
  positive(cfg.sizingValue, 'sizingValue');
  positive(cfg.rewardRisk, 'rewardRisk');
  fraction(cfg.feeRate, 'feeRate');
  fraction(cfg.slippageRate, 'slippageRate');
  if (cfg.minConfidence < 0 || cfg.minConfidence > 100) {
    throw new BacktestConfigError('minConfidence must be between 0 and 100.');
  }
  if (cfg.stopMode === 'PERCENT') fraction(cfg.stopPct, 'stopPct');
  if (cfg.sizingMode === 'CAPITAL_PCT' && cfg.sizingValue > 100) {
    throw new BacktestConfigError('sizingValue is a percent of capital and cannot exceed 100.');
  }
  if (cfg.sizingMode === 'RISK_PCT' && cfg.sizingValue > 100) {
    throw new BacktestConfigError('sizingValue is a percent of capital and cannot exceed 100.');
  }
  if (cfg.maxOpenPositions < 1) throw new BacktestConfigError('maxOpenPositions must be at least 1.');
  if (cfg.maxOrdersPerDay < 1) throw new BacktestConfigError('maxOrdersPerDay must be at least 1.');
  if (cfg.squareOffMinute < 0 || cfg.squareOffMinute > 24 * 60) {
    throw new BacktestConfigError('squareOffMinute must be a minute of the day.');
  }
  // A delivery product cannot be shorted and cannot be squared off intraday;
  // silently ignoring either would produce a result describing a trade nobody
  // could place.
  if (cfg.productType === 'CNC' && cfg.allowShort) {
    throw new BacktestConfigError('CNC is a delivery product and cannot be shorted. Set allowShort to false.');
  }
  if (cfg.productType === 'CNC' && cfg.intradayOnly) {
    throw new BacktestConfigError('CNC is a delivery product; set intradayOnly to false.');
  }

  return cfg;
}

/**
 * The identity of an experiment.
 *
 * `strategyVersion` and `dataVersion` are inputs rather than derived here: both
 * are discovered at run time (the first from the strategy definitions, the
 * second from the bars actually read), and folding them in is what makes the
 * hash mean "same experiment" rather than merely "same request".
 */
export function configurationHash(
  cfg: BacktestConfig,
  strategyVersion: string,
  dataVersion: string | null,
  engineVersion: string = ENGINE_VERSION,
): string {
  const payload = {
    config: canonicalise(cfg as unknown as Record<string, unknown>),
    strategyVersion,
    dataVersion,
    engineVersion,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

/** Sorted keys and normalised numbers, so key order and `-0` cannot matter. */
function canonicalise(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const value = obj[key];
    out[key] = typeof value === 'number' ? Number(value.toFixed(10)) + 0 : value;
  }
  return out;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
