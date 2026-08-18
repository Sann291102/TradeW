/**
 * The invariant this panel now has to satisfy:
 *
 *     WHAT THE OPERATOR SELECTED = WHAT THE CHART DRAWS
 *
 * and, separately, that the "Sentinel reads this" badge appears only on a panel
 * whose contract the engine actually read.
 *
 * These are asserted together because collapsing them is the bug this replaced:
 * the panel used to let the engine's own at-the-money resolution decide which
 * contract to DRAW, so the two questions had one answer and the operator's pick
 * reached nothing. See `lib/sentinel/WatchContext.tsx` for the root cause.
 *
 * `renderToStaticMarkup` never runs effects, so every data hook sits in its
 * initial 'loading' state and no network call is made. That is enough: the
 * panel headers, the badges and the notes are all rendered from props.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SentinelLiveCharts } from './SentinelLiveCharts';
import { resolveSeries, type ChartFocus, type EngineChartFocus } from '@/lib/sentinel/chartFocus';

function engineRead(over: Partial<EngineChartFocus> = {}): EngineChartFocus {
  return {
    symbol: 'NIFTY',
    strike: 24_200,
    expiry: '2026-08-18',
    series: resolveSeries('15m'),
    reads: { index: true, ce: true, pe: true },
    contractsReadable: true,
    ...over,
  };
}

function render(props: Partial<Parameters<typeof SentinelLiveCharts>[0]> = {}) {
  return renderToStaticMarkup(
    <SentinelLiveCharts
      symbol="NIFTY"
      marketName="Nifty 50"
      expiry="2026-08-18"
      ceStrike={24_200}
      peStrike={24_300}
      {...props}
    />,
  );
}

describe('the charts draw the selection', () => {
  it('names the selected call contract on the call panel', () => {
    expect(render()).toContain('24200 CALL');
  });

  it('names the selected put contract on the put panel', () => {
    expect(render()).toContain('24300 PUT');
  });

  it('shows the resolved symbol on the index panel, not just the market name', () => {
    const html = render();
    expect(html).toContain('Nifty 50');
    expect(html).toContain('NIFTY');
  });

  it('draws the operator strike even when the engine read a different one', () => {
    // The regression that motivated all of this: `reading?.strike ?? ceStrike`
    // meant the engine's ATM pick silently replaced the operator's.
    const html = render({ ceStrike: 24_400, peStrike: 24_400, engineRead: engineRead({ strike: 24_200 }) });
    expect(html).toContain('24400 CALL');
    expect(html).not.toContain('24200 CALL');
  });

  it('leaves an unselected leg unnamed rather than substituting a strike', () => {
    // The panel body's "No call strike selected" copy needs the data hook's
    // effect to have run, which `renderToStaticMarkup` never does. What IS
    // observable here is the header, and it is the assertion that matters: an
    // unselected leg must not acquire a contract from anywhere.
    const html = render({ ceStrike: null });
    expect(html).toContain('Nifty 50 CALL');
    expect(html).not.toContain('24200 CALL');
    // The other leg is untouched — one null leg is not a blank panel.
    expect(html).toContain('24300 PUT');
  });
});

describe('the reading badge follows the evidence', () => {
  /**
   * Counted rather than merely searched for. The index panel is legitimately
   * badged whenever `/observe` read the selected market, so a bare
   * `not.toContain` would pass for the wrong reason — or fail for a badge that
   * belongs there. The number is the claim: one badge per panel the engine
   * genuinely read.
   */
  const badges = (html: string) => html.split('Sentinel reads this').length - 1;

  it('marks all three panels when the engine read the pair on screen', () => {
    const html = render({ ceStrike: 24_200, peStrike: 24_200, engineRead: engineRead({ strike: 24_200 }) });
    expect(badges(html)).toBe(3);
  });

  it('withholds the badge from a contract the engine did not read', () => {
    // A badge over a chart of a contract nothing evaluated is the exact false
    // claim the badge was introduced to stop making. The index still counts —
    // that one the engine really did read.
    const html = render({ ceStrike: 24_400, peStrike: 24_500, engineRead: engineRead({ strike: 24_200 }) });
    expect(badges(html)).toBe(1);
    expect(html).toContain('24400 CALL');
  });

  it('withholds the badge from a leg the engine failed to fetch', () => {
    const html = render({
      ceStrike: 24_200,
      peStrike: 24_200,
      engineRead: engineRead({ strike: 24_200, reads: { index: true, ce: true, pe: false } }),
    });
    expect(badges(html)).toBe(2);
  });

  it('states which contract the engine read instead', () => {
    const html = render({ ceStrike: 24_400, peStrike: 24_500, engineRead: engineRead({ strike: 24_200 }) });
    expect(html).toContain('Sentinel read the 24200 strike');
  });

  it('says nothing about a mismatch when there is none', () => {
    const html = render({ ceStrike: 24_200, peStrike: 24_200, engineRead: engineRead({ strike: 24_200 }) });
    expect(html).not.toContain('Sentinel read the');
  });

  it('marks nothing when the engine read a different market entirely', () => {
    const html = render({ engineRead: engineRead({ symbol: 'BANKNIFTY' }) });
    expect(badges(html)).toBe(0);
  });

  it('does not claim a reading when neither engine has reported', () => {
    const html = render();
    expect(badges(html)).toBe(0);
    expect(html).toContain('Live Charts');
  });
});

describe('the series claim', () => {
  it('draws the bars the engine evaluates and says so', () => {
    const html = render({ engineRead: engineRead() });
    expect(html).toContain('What Sentinel is reading');
    expect(html).toContain('15m');
  });

  it('reproduces the bridge substitution rather than repeating it silently', () => {
    // A 3m request comes back as 5m bars with no error anywhere in the chain.
    const html = render({ engineRead: engineRead({ series: resolveSeries('3m') }) });
    expect(html).toContain('no 3m series');
  });
});

/** How many panels claim the engine is reading them. */
const badgeCount = (html: string) => html.split('Sentinel reads this').length - 1;

/** A sentinel-py watch focus that names BOTH legs, as a pair watch now does. */
function pairFocus(over: Partial<ChartFocus> = {}): ChartFocus {
  return {
    watchId: 'w1',
    symbol: 'NIFTY',
    strike: 24_200,
    optionType: 'CE',
    ceStrike: 24_200,
    peStrike: 24_100,
    expiry: '2026-08-18',
    state: 'FORMING',
    series: resolveSeries('15m'),
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. The charts resolve to exactly the two contracts the operator selected
// ─────────────────────────────────────────────────────────────────────────────

describe('8 — the pair on screen is the pair that was chosen', () => {
  it('draws two DIFFERENT contracts at once', () => {
    // The case a single-strike model could not represent at all: the operator
    // watching a 24200 call against a 24100 put.
    const html = render({ ceStrike: 24_200, peStrike: 24_100 });
    expect(html).toContain('24200 CALL');
    expect(html).toContain('24100 PUT');
  });

  it('moves one leg without moving the other', () => {
    const html = render({ ceStrike: 24_450, peStrike: 24_100 });
    expect(html).toContain('24450 CALL');
    expect(html).toContain('24100 PUT');
    expect(html).not.toContain('24200 CALL');
  });

  it('draws a leg with no strike as unselected — never as the at-the-money', () => {
    // The regression that made the strike controls look dead for a week: a null
    // leg silently became whatever the panel's own chain poll resolved to.
    //
    // Asserted on the HEADER rather than the empty-state body: this renderer
    // runs no effects, so the candle hook is still in its initial 'loading'
    // state and the body is a skeleton. The header is drawn from props, and it
    // is where a fabricated contract would show up — the unselected call names
    // no strike at all while the put names its own.
    const html = render({ ceStrike: null, peStrike: 24_100 });
    expect(html).toContain('24100 PUT');
    expect(html).toContain('Nifty 50 CALL');
    expect(html).not.toMatch(/\d{5} CALL/);
  });

  it('marks BOTH legs as read for a pair watch, since the sweep reads both', () => {
    const html = render({
      ceStrike: 24_200,
      peStrike: 24_100,
      focus: pairFocus(),
    });
    expect(badgeCount(html)).toBe(2);
  });

  it('marks NEITHER leg when the watch is on a different pair', () => {
    // A watch on 24350/24250 is not the watch for a screen showing 24200/24100,
    // and captioning it as one would present another pair's evaluation as this
    // pair's.
    const html = render({
      ceStrike: 24_200,
      peStrike: 24_100,
      focus: pairFocus({ ceStrike: 24_350, peStrike: 24_250 }),
    });
    expect(badgeCount(html)).toBe(0);
  });

  it('marks only the leg that matches when the watch shares one of the two', () => {
    const html = render({
      ceStrike: 24_200,
      peStrike: 24_100,
      focus: pairFocus({ ceStrike: 24_200, peStrike: 24_250 }),
    });
    expect(badgeCount(html)).toBe(1);
  });

  it('marks the index — and no leg — for an underlying watch', () => {
    const html = render({
      focus: pairFocus({ ceStrike: null, peStrike: null, strike: null, optionType: null }),
    });
    expect(badgeCount(html)).toBe(1);
  });
});
