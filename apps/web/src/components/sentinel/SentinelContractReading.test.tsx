/**
 * The contract reading renders what `/observe` read across the three panels
 * above it, and never more than it read.
 *
 * Two failure modes matter more than layout, and each has its own block:
 *
 *  1. A leg the engine could NOT read must not render as a leg that did not
 *     move. `0.00%` under a PUT panel is a statement about the market; the
 *     truth in that state is a statement about the bridge.
 *  2. Nothing here may read as a recommendation. This is the only surface in
 *     the workspace that names a strike and a side together, so the Rule 2
 *     boundary is asserted rather than assumed.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SentinelContractReading } from './SentinelContractReading';
import type { ContractWatch } from '@/lib/sentinel/types';

function watch(overrides: Partial<ContractWatch> = {}): ContractWatch {
  return {
    underlying: 'NIFTY',
    expiry: '2026-08-27',
    strike: 24_350,
    interval: '15m',
    index: { bars: 20, open: 24_000, last: 24_200, changePct: 0.83, direction: 'rising' },
    ce: {
      side: 'CE',
      strike: 24_350,
      series: { bars: 20, open: 100, last: 140, changePct: 40, direction: 'rising' },
      unavailableReason: null,
    },
    pe: {
      side: 'PE',
      strike: 24_350,
      series: { bars: 20, open: 100, last: 60, changePct: -40, direction: 'falling' },
      unavailableReason: null,
    },
    alignment: 'call-side-tracking',
    notes: ['The underlying moved +0.83% across 20 15m bars read.'],
    contractsReadable: true,
    ...overrides,
  };
}

const render = (w: ContractWatch) => renderToStaticMarkup(<SentinelContractReading watch={w} />);

/** The figure rendered inside the PUT tile, isolated from the other two. */
function putTileValue(html: string): string {
  const match = /PUT[^<]*<\/p><p[^>]*>([^<]*)</.exec(html);
  return match?.[1] ?? '';
}

describe('SentinelContractReading', () => {
  it('renders all three series with the interval they were read on', () => {
    const html = render(watch());

    expect(html).toContain('NIFTY');
    expect(html).toContain('CALL 24350');
    expect(html).toContain('PUT 24350');
    expect(html).toContain('+40.00%');
    expect(html).toContain('-40.00%');
    expect(html).toContain('15m bars');
  });

  it('names the at-the-money pair, so the reading is not mistaken for a strike search', () => {
    const html = render(watch());
    expect(html).toContain('at-the-money pair');
    expect(html).toContain('24350');
  });

  it('renders the alignment in past tense, describing movement', () => {
    expect(render(watch())).toContain('Call leg moved with the underlying');
    expect(render(watch({ alignment: 'put-side-tracking' }))).toContain('Put leg moved with the underlying');
  });

  it('calls both legs gaining a volatility reading, not a directional one', () => {
    const html = render(watch({ alignment: 'both-sides-bid' }));
    expect(html).toContain('volatility reading');
  });

  it('renders every note the engine produced', () => {
    const html = render(watch({ notes: ['First observation.', 'Second observation.'] }));
    expect(html).toContain('First observation.');
    expect(html).toContain('Second observation.');
  });
});

describe('an unreadable leg never renders as an unmoved one', () => {
  it('says unreadable instead of showing a percentage', () => {
    const html = render(
      watch({
        pe: { side: 'PE', strike: 24_350, series: null, unavailableReason: 'Dhan has no traded candles.' },
        alignment: null,
      }),
    );

    expect(html).toContain('unreadable');
    expect(html).toContain('Dhan has no traded candles.');

    // The tell-tale of the collapse this guards against: the PUT tile showing
    // a percentage at all. Asserted on that tile rather than on the whole
    // document, because the CALL's own "+40.00%" contains the "0.00%" a naive
    // substring check would trip on — and a test that fails for the wrong
    // reason is a test that gets deleted.
    expect(putTileValue(html)).toBe('unreadable');
    expect(putTileValue(html)).not.toMatch(/%/);
  });

  it('shows no alignment when a leg is missing — one leg is not an alignment', () => {
    const html = render(
      watch({
        ce: { side: 'CE', strike: 24_350, series: null, unavailableReason: 'no traded candles' },
        alignment: null,
      }),
    );

    expect(html).not.toContain('moved with the underlying');
  });

  it('reports an instrument with no option pair without inventing one', () => {
    const html = render(
      watch({ strike: null, expiry: null, ce: null, pe: null, alignment: null, contractsReadable: true }),
    );

    expect(html).toContain('no option pair for this instrument');
    expect(html).not.toContain('CALL 24350');
  });
});

describe('Rule 2 — nothing here recommends a trade', () => {
  const alignments: ContractWatch['alignment'][] = [
    'call-side-tracking',
    'put-side-tracking',
    'both-sides-bid',
    'both-sides-decaying',
    'index-flat',
    'mixed',
    null,
  ];

  it.each(alignments)('renders no directive or ranking language for %s', (alignment) => {
    const html = render(watch({ alignment })).toLowerCase();

    for (const banned of ['buy ', 'sell ', 'entry', 'target', 'stop-loss', 'best', 'strongest', 'recommend']) {
      expect(html, banned).not.toContain(banned);
    }
  });

  it('states the observation-only boundary and that strikes are not compared', () => {
    const html = render(watch());
    expect(html).toContain('Observation only');
    expect(html).toContain('does not compare strikes');
  });
});
