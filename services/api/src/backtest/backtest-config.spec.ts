import { describe, expect, it } from 'vitest';
import { CHARGES_RATE } from '../sim/order.service';
import {
  BacktestConfigError,
  DEFAULT_CONFIG,
  configurationHash,
  resolveConfig,
  type BacktestConfig,
} from './backtest-config';

/**
 * Configuration is the other half of reproducibility.
 *
 * The hash is what lets two results be compared honestly, and the resolution is
 * what stops an old result from re-rendering against today's defaults. Both are
 * silent when they go wrong, so both are asserted.
 */

const MINIMAL = {
  symbol: 'nifty',
  exchange: 'nse',
  timeframe: '15m',
  startAt: '2026-05-04T00:00:00.000Z',
  endAt: '2026-06-04T00:00:00.000Z',
};

describe('resolveConfig', () => {
  it('normalises the instrument identity and fills every default', () => {
    const cfg = resolveConfig(MINIMAL);
    expect(cfg.symbol).toBe('NIFTY');
    expect(cfg.exchange).toBe('NSE');
    // Every key of the default set survives resolution — a missing one would
    // mean the run used an undefined knob.
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      expect(cfg[key as keyof BacktestConfig]).toBeDefined();
    }
  });

  it('keeps the fee default tied to the OMS charge rate', () => {
    // Not a style preference: if these diverge, a backtest and a paper trade of
    // the same size are charged differently and nothing in either says so.
    expect(DEFAULT_CONFIG.feeRate).toBe(CHARGES_RATE);
  });

  it('rejects an inverted window', () => {
    expect(() => resolveConfig({ ...MINIMAL, startAt: MINIMAL.endAt, endAt: MINIMAL.startAt })).toThrow(
      BacktestConfigError,
    );
  });

  it('rejects an absurd fee or slippage rate rather than running with it', () => {
    expect(() => resolveConfig({ ...MINIMAL, feeRate: 0.5 })).toThrow(/feeRate/);
    expect(() => resolveConfig({ ...MINIMAL, slippageRate: -1 })).toThrow(/slippageRate/);
  });

  it('rejects a percent-of-capital size above 100', () => {
    expect(() => resolveConfig({ ...MINIMAL, sizingMode: 'CAPITAL_PCT', sizingValue: 250 })).toThrow(/cannot exceed 100/);
  });

  it('refuses a delivery product that is shorted or squared off intraday', () => {
    expect(() => resolveConfig({ ...MINIMAL, productType: 'CNC', allowShort: true })).toThrow(/cannot be shorted/);
    expect(() =>
      resolveConfig({ ...MINIMAL, productType: 'CNC', allowShort: false, intradayOnly: true }),
    ).toThrow(/intradayOnly/);
  });

  it('rejects a missing required field by name', () => {
    expect(() => resolveConfig({ symbol: 'NIFTY' })).toThrow(/Missing required field/);
  });

  it('ignores fields that are not configuration — the label must not be part of the experiment', () => {
    // Regression: `label` and `sourceProfileId` were spread into the stored
    // config and therefore into `configurationHash`, so renaming a run made it
    // a "different experiment". Found by verify:backtest on 2026-08-20.
    const plain = resolveConfig(MINIMAL);
    const labelled = resolveConfig({ ...MINIMAL, label: 'my run', sourceProfileId: 'p-1' } as never);
    expect(Object.keys(labelled).sort()).toEqual(Object.keys(plain).sort());
    expect(configurationHash(labelled, 'sv1', 'dv1')).toBe(configurationHash(plain, 'sv1', 'dv1'));
  });

  it('lets an explicit value override a default', () => {
    expect(resolveConfig({ ...MINIMAL, minConfidence: 55 }).minConfidence).toBe(55);
    // ...and an explicitly-undefined field falls back rather than becoming undefined.
    expect(resolveConfig({ ...MINIMAL, minConfidence: undefined }).minConfidence).toBe(DEFAULT_CONFIG.minConfidence);
  });
});

describe('configurationHash', () => {
  const cfg = resolveConfig(MINIMAL);

  it('is stable across repeated calls', () => {
    expect(configurationHash(cfg, 'sv1', 'dv1')).toBe(configurationHash(cfg, 'sv1', 'dv1'));
  });

  it('ignores JSON key ORDER — the same experiment hashes the same', () => {
    const reordered = Object.fromEntries(Object.entries(cfg).reverse()) as unknown as BacktestConfig;
    expect(configurationHash(reordered, 'sv1', 'dv1')).toBe(configurationHash(cfg, 'sv1', 'dv1'));
  });

  it('changes when ANY knob that could move a number changes', () => {
    const baseline = configurationHash(cfg, 'sv1', 'dv1');
    expect(configurationHash({ ...cfg, feeRate: 0.0004 }, 'sv1', 'dv1')).not.toBe(baseline);
    expect(configurationHash({ ...cfg, slippageRate: 0.001 }, 'sv1', 'dv1')).not.toBe(baseline);
    expect(configurationHash({ ...cfg, maxLossPerDay: 1 }, 'sv1', 'dv1')).not.toBe(baseline);
    expect(configurationHash({ ...cfg, endAt: '2026-07-04T00:00:00.000Z' }, 'sv1', 'dv1')).not.toBe(baseline);
  });

  it('changes when the STRATEGY version changes, with the config untouched', () => {
    // This is the property that makes "strategy v1.3 vs v1.4" comparable: two
    // runs of the same configuration against different rules are different
    // experiments, and the hash has to say so.
    expect(configurationHash(cfg, 'sv2', 'dv1')).not.toBe(configurationHash(cfg, 'sv1', 'dv1'));
  });

  it('changes when the DATA version changes — a backfill makes it a new experiment', () => {
    expect(configurationHash(cfg, 'sv1', 'dv2')).not.toBe(configurationHash(cfg, 'sv1', 'dv1'));
  });

  it('changes when the ENGINE version changes', () => {
    expect(configurationHash(cfg, 'sv1', 'dv1', '9.9.9')).not.toBe(configurationHash(cfg, 'sv1', 'dv1', '1.0.0'));
  });
});
