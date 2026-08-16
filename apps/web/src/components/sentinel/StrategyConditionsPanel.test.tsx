/**
 * The conditions panel is a card full of price levels sitting on a surface
 * that is forbidden from recommending any. That is only safe because every
 * number on it originates with the user — so these tests pin the boundary
 * itself: what the panel shows when the user has declared nothing, that it
 * never fills the gap, that the progress bar counts the rules the engine
 * thresholds on rather than every rule, and that the reference mock's
 * position-size recommendation is absent.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { StrategyConditionsPanel } from './StrategyConditionsPanel';
import type { Timeline, TimelineCondition } from '@/lib/sentinel/sentinelPy';

function condition(over: Partial<TimelineCondition> & { id: string }): TimelineCondition {
  return { name: 'breakout_high', mandatory: true, met: false, detail: '', ...over };
}

function timeline(over: {
  conditions?: TimelineCondition[];
  watch?: Partial<Timeline['watch']>;
} = {}): Timeline {
  return {
    watch: {
      id: 'w1',
      symbol: 'NIFTY',
      strike: '24350',
      optionType: 'CE',
      expiry: '2026-08-21',
      state: 'FORMING',
      direction: null,
      strategyId: 's1',
      timeframe: '15m',
      entryPrice: null,
      invalidationPrice: null,
      projectedPrice: null,
      ...over.watch,
    },
    conditions: over.conditions ?? [],
    reading: null,
    events: [],
  };
}

const render = (t: Timeline | null) => renderToStaticMarkup(<StrategyConditionsPanel timeline={t} />);

describe('StrategyConditionsPanel — with no watch', () => {
  it('says there is nothing selected instead of rendering an empty contract', () => {
    const html = render(null);
    expect(html).toContain('No watch selected');
    expect(html).not.toContain('Conditions matched');
  });
});

describe('StrategyConditionsPanel — levels the user has not declared', () => {
  it('never shows an invalidation level Sentinel would have had to invent', () => {
    const html = render(timeline({ conditions: [condition({ id: 'c1', met: true })] }));
    expect(html).toContain('Sentinel never sets one');
    // No price anywhere on the card: the only prices it may show are the two
    // the user typed, and they do not exist yet.
    expect(html).not.toMatch(/\d{2},\d{3}/);
  });

  it('explains that the risk scale comes from the user s own numbers', () => {
    expect(render(timeline())).toContain('your own entry and invalidation');
  });
});

describe('StrategyConditionsPanel — levels the user declared', () => {
  const declared = timeline({
    conditions: [condition({ id: 'c1', met: true })],
    watch: { state: 'IN_TRADE', entryPrice: 24400, invalidationPrice: 24300, projectedPrice: 24700 },
  });

  it('reads the invalidation level back exactly as recorded', () => {
    expect(render(declared)).toContain('24,300');
  });

  it('derives 1R from the distance between the two levels the user typed', () => {
    const html = render(declared);
    expect(html).toContain('1R = ');
    expect(html).toContain('100');
  });

  it('states the projected level as a multiple of the user s own risk', () => {
    // (24700 - 24400) / (24400 - 24300) = 3.00R. Their arithmetic, not a
    // reward:risk Sentinel proposed.
    expect(render(declared)).toContain('3.00R');
  });

  it('omits the projected multiple when no projected level was declared', () => {
    const html = render(
      timeline({ watch: { entryPrice: 24400, invalidationPrice: 24300, projectedPrice: null } }),
    );
    expect(html).toContain('1R = ');
    expect(html).not.toContain('Projected = ');
  });
});

describe('StrategyConditionsPanel — the matched count', () => {
  it('counts mandatory conditions only', () => {
    // 1 of 2 mandatory met, plus an optional one that is met. Counting the
    // optional would read as 2 of 3 — a setup looking closer to confirmed on a
    // rule the user marked as nice-to-have, which is not what the feed's own
    // strength threshold measures.
    const html = render(
      timeline({
        conditions: [
          condition({ id: 'c1', name: 'breakout_high', met: true }),
          condition({ id: 'c2', name: 'volume_confirm', met: false }),
          condition({ id: 'c3', name: 'rsi_support', mandatory: false, met: true }),
        ],
      }),
    );
    expect(html).toContain('1 / 2');
    expect(html).not.toContain('2 / 3');
  });

  it('names the bar as a rule count rather than letting it read as a probability', () => {
    const html = render(timeline({ conditions: [condition({ id: 'c1', met: true })] }));
    expect(html).toContain('not a probability');
  });

  it('renders no bar at all when the strategy defines no mandatory rules', () => {
    const html = render(timeline({ conditions: [condition({ id: 'c1', mandatory: false, met: true })] }));
    expect(html).not.toContain('Conditions matched');
  });
});

describe('StrategyConditionsPanel — the reference mock s forbidden row', () => {
  it('never renders a position-size recommendation', () => {
    // The mock has "Position size — Dynamic (based on volatility)" and a feed
    // line reading "Position size recommended: 75%". Sizing advice is advice
    // (root CLAUDE.md Rule 2), so the slot carries optional confirmations.
    const html = render(
      timeline({
        conditions: [condition({ id: 'c1', met: true }), condition({ id: 'c2', mandatory: false, met: false })],
        watch: { entryPrice: 24400, invalidationPrice: 24300 },
      }),
    );
    expect(html).not.toMatch(/position size/i);
    expect(html).not.toMatch(/recommend/i);
    expect(html).toContain('Optional confirmations');
  });
});
