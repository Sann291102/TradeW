import { describe, expect, it } from 'vitest';
import { CHART_TIMEFRAMES, isChartTimeframe } from '../store/workspaceStore';
import { validateAction } from './brain';
import { resolveUtterance } from './router';

/**
 * "Change the timeframe to 5 minutes."
 *
 * This was not an unimplemented feature — it was an unreachable one. The
 * timeframe lived in `ChartPanel` as `const [tf, setTf] = useState('15m')`, so
 * nothing outside that component's render could read it or write it. There was
 * no action to add, because there was no state to address.
 *
 * These tests cover the two halves of the fix: the grammar produces the action,
 * and every layer that can accept one agrees on which timeframes exist.
 */

describe('the timeframe vocabulary is declared once', () => {
  it('accepts exactly the store timeframes through the client validator', () => {
    for (const tf of CHART_TIMEFRAMES) {
      expect(
        validateAction({ type: 'chartTimeframe', timeframe: tf }),
        `${tf} is a real timeframe but the validator rejected it`,
      ).toEqual({ type: 'chartTimeframe', timeframe: tf });
    }
  });

  it('rejects a timeframe the chart has no button for', () => {
    // The `showPanel: 'discipline'` failure class: an action that validates but
    // cannot do anything is worse than one that is rejected, because the trace
    // claims success.
    for (const bogus of ['30m', '4H', '1M', '', 'daily', null, 42]) {
      expect(validateAction({ type: 'chartTimeframe', timeframe: bogus })).toBeNull();
    }
  });

  it('guards the store write as well as the type', () => {
    expect(isChartTimeframe('5m')).toBe(true);
    expect(isChartTimeframe('30m')).toBe(false);
    expect(isChartTimeframe(undefined)).toBe(false);
  });
});

describe('resolveUtterance — timeframe commands', () => {
  it('handles the phrasing from the brief', () => {
    const plan = resolveUtterance('change the timeframe to 5 minutes');
    expect(plan.intent).toBe('command');
    expect(plan.actions).toEqual([{ type: 'chartTimeframe', timeframe: '5m' }]);
  });

  it('handles the short forms and the spoken forms', () => {
    expect(resolveUtterance('switch to 15m').actions).toEqual([
      { type: 'chartTimeframe', timeframe: '15m' },
    ]);
    expect(resolveUtterance('make it hourly').actions).toEqual([
      { type: 'chartTimeframe', timeframe: '1H' },
    ]);
    expect(resolveUtterance('set the chart to daily').actions).toEqual([
      { type: 'chartTimeframe', timeframe: '1D' },
    ]);
  });

  it('carries the instrument through when one is named', () => {
    // "Open ETHUSDT on 15m" is one sentence and three steps, and the symbol has
    // to be set first or the timeframe lands on whatever was already loaded.
    const plan = resolveUtterance('open ETHUSDT on 15m chart');
    expect(plan.actions).toEqual([
      { type: 'selectSymbol', symbol: 'ETHUSDT' },
      { type: 'navigate', href: '/trade?symbol=ETHUSDT' },
      { type: 'chartTimeframe', timeframe: '15m' },
    ]);
  });

  it('does not hijack a quote question that merely mentions a period', () => {
    // "what's the day range on BANKNIFTY" is a lookup. Silently changing the
    // chart instead of answering it would be the same class of bug as
    // answering an explain-question by navigating.
    const plan = resolveUtterance("what's the day range on BANKNIFTY");
    expect(plan.actions.some((a) => a.type === 'chartTimeframe')).toBe(false);
  });

  it('leaves an unrelated command alone', () => {
    const plan = resolveUtterance('open settings');
    expect(plan.actions.some((a) => a.type === 'chartTimeframe')).toBe(false);
  });
});
