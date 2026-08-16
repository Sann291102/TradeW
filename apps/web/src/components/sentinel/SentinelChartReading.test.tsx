/**
 * The reading strip renders what the ENGINE measured, and never more than it
 * measured. These tests pin the three ways that could go wrong: inventing a
 * number the sweep did not produce, presenting a stale reading as current, and
 * turning "measured nothing" into "failed".
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SentinelChartReading } from './SentinelChartReading';
import type { TimelineReading } from '@/lib/sentinel/sentinelPy';

function reading(overrides: Partial<TimelineReading> = {}): TimelineReading {
  return {
    at: '2026-08-13T05:00:00Z',
    candleTime: '2026-08-13T04:45:00Z',
    openingRangeHigh: null,
    openingRangeLow: null,
    measurements: {},
    unreadable: null,
    ...overrides,
  };
}

const render = (r: TimelineReading | null) => renderToStaticMarkup(<SentinelChartReading reading={r} />);

describe('SentinelChartReading', () => {
  it('renders each measurement the sweep produced', () => {
    const html = render(
      reading({
        measurements: {
          vwap: { vwap: 24350.5, testOrdinal: 'second', deviationBucket: 'shallow', deviationAtr: 0.42 },
          flip: { price: 24300, kind: 'resistance', touches: 3, ageBars: 42, stage: 'retest', held: true },
        },
      }),
    );

    expect(html).toContain('VWAP');
    expect(html).toContain('second test');
    expect(html).toContain('shallow');
    expect(html).toContain('0.42 ATR');
    expect(html).toContain('Level flip');
    expect(html).toContain('resistance at');
    expect(html).toContain('3 touches');
    expect(html).toContain('42 bars old');
    expect(html).toContain('held');
  });

  it('omits a measurement the sweep did not produce rather than showing an empty row', () => {
    const html = render(reading({ measurements: { pullback: { classification: 'shallow', depthAtr: 0.3 } } }));
    expect(html).toContain('Pullback');
    expect(html).not.toContain('Liquidity sweep');
    expect(html).not.toContain('Zone');
  });

  it('leads with the staleness warning when the latest sweep could not read the market', () => {
    const html = render(
      reading({
        unreadable: 'The Dhan live-feed bridge is unreachable.',
        measurements: { pullback: { classification: 'deep', depthAtr: 1.1 } },
      }),
    );

    // The warning must come BEFORE the numbers it invalidates — a user who
    // reads top-down must not take a stale level as current.
    expect(html.indexOf('could not read the market')).toBeGreaterThan(-1);
    expect(html.indexOf('could not read the market')).toBeLessThan(html.indexOf('Pullback'));
    expect(html).toContain('not what is true now');
  });

  it('says a clean read found no structure — which is a reading, not a failure', () => {
    const html = render(reading());
    expect(html).toContain('measured no structure on this pass');
    expect(html).not.toContain('could not read');
  });

  it('distinguishes never-swept from swept-and-empty', () => {
    const html = render(null);
    expect(html).toContain('has not been swept yet');
  });

  it('reports the last bar the engine actually read', () => {
    expect(render(reading())).toContain('last bar read');
  });

  it('falls back to the sweep time when no candle was read', () => {
    const html = render(reading({ candleTime: null }));
    expect(html).toContain('last swept');
    expect(html).not.toContain('last bar read');
  });

  it('renders the opening range only when the engine measured one', () => {
    expect(render(reading())).not.toContain('Opening range');
    expect(render(reading({ openingRangeHigh: 24400, openingRangeLow: 24310 }))).toContain('Opening range');
  });
});
