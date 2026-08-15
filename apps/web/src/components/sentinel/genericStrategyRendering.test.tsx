/**
 * The leak test.
 *
 * Two strategies with nothing in common — a long-only EMA reclaim and a
 * two-sided S/R flip — are rendered through the SAME components, and the
 * component subtree is checked for any branch on strategy identity.
 *
 * If a `template.id === 'ema7…'` check ever appears, the generic contract has
 * leaked into the frontend and the fix belongs in the backend. The point of
 * P7 was to avoid ten bespoke dashboards; this is what holds that line.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ActiveWatchList } from './ActiveWatchList';
import { ObservedContextPanel } from './ObservedContextPanel';
import { StrategyConfigureForm } from './StrategyConfigureForm';
import { StrategyPerformancePanel } from './StrategyPerformancePanel';
import { contextRows, renderableSegments, splitCatalogue } from '@/lib/sentinel/strategyContract';
import type { StrategyContract } from '@/lib/sentinel/strategyContract';

function contract(overrides: Partial<StrategyContract>): StrategyContract {
  return {
    id: 'strat',
    name: 'My strategy',
    status: 'active',
    template: { id: 't', name: 'T', summary: '', available: true },
    configuration: { parameters: [] },
    watches: [],
    focusedWatchId: null,
    currentState: null,
    conditions: [],
    latestObservation: null,
    lifecycle: [],
    performance: {
      strategyId: 'strat',
      funnel: { watches: 1, interactions: 1, confirmations: 0, entries: 0, outcomes: 0, rejections: 0 },
      outcomes: { reachedProjected: 0, reachedInvalidation: 0, stillOpen: 1 },
      r: { completed: 0, expectancy: null, best: null, worst: null, avgMfe: null, avgMae: null },
      sufficient: false,
      note: '0 completed trade(s) — too few to read as a rate.',
    },
    availableAnalytics: [],
    segments: [],
    ...overrides,
  };
}

/** A long-only EMA reclaim: four conditions, a pullback-depth breakdown. */
const ema7 = contract({
  name: 'My EMA-7 Bullish Reclaim',
  template: { id: 'ema7_bullish_reclaim', name: 'EMA-7 Bullish Reclaim', summary: '', available: true, direction: 'long_only' },
  configuration: {
    parameters: [
      { key: 'timeframe', label: 'Timeframe', type: 'choice', value: '5m', options: ['5m', '15m'] },
      { key: 'direction', label: 'Direction', type: 'readonly', value: 'Long only' },
      { key: 'rule_trend', label: 'Price is above the 7 EMA', type: 'toggle', value: true, locked: true, group: 'mandatory' },
      { key: 'rule_volume', label: 'Above-average volume', type: 'toggle', value: true, group: 'optional' },
    ],
  },
  watches: [
    {
      id: 'w-ema',
      symbol: 'NIFTY',
      strike: null,
      optionType: null,
      expiry: null,
      state: 'FORMING',
      status: 'active',
      met: 1,
      total: 2,
      conditions: [
        { id: 'r1', name: 'ema7_rising', mandatory: true, met: true, detail: 'EMA-7 is rising' },
        { id: 'r2', name: 'ema7_body_reclaim', mandatory: true, met: false, detail: 'no reclaim yet' },
      ],
    },
  ],
  focusedWatchId: 'w-ema',
  currentState: 'FORMING',
  latestObservation: {
    at: '2026-08-10T10:00:00Z',
    candleTime: null,
    state: 'FORMING',
    context: { pullback: { classification: 'normal', depthAtr: 1.4 }, mandatoryMet: 1 },
  },
  availableAnalytics: ['pullbackDepth'],
  segments: [
    {
      id: 'pullbackDepth',
      label: 'Pullback depth',
      samples: 3,
      buckets: [
        { label: 'shallow', observations: 1, confirmations: 0 },
        { label: 'normal', observations: 2, confirmations: 1 },
        { label: 'deep', observations: 0, confirmations: 0 },
      ],
    },
  ],
});

/** A two-sided S/R flip on an option: different conditions, different
 *  measurements, different breakdown. Same components. */
const srFlip = contract({
  name: 'My Support / Resistance Flip',
  template: { id: 'sr_flip', name: 'Support / Resistance Flip', summary: '', available: true, direction: 'both' },
  configuration: {
    parameters: [
      { key: 'timeframe', label: 'Timeframe', type: 'choice', value: '15m', options: ['5m', '15m'] },
      { key: 'direction', label: 'Direction', type: 'readonly', value: 'Both directions' },
      { key: 'rule_level', label: 'A level with 2+ touches', type: 'toggle', value: true, locked: true, group: 'mandatory' },
      { key: 'rule_break', label: 'Price closes clear of that level', type: 'toggle', value: true, locked: true, group: 'mandatory' },
      { key: 'rule_flip_retest', label: 'Price returns to the level', type: 'toggle', value: true, locked: true, group: 'mandatory' },
      { key: 'rule_volume', label: 'Above-average volume', type: 'toggle', value: true, group: 'optional' },
    ],
  },
  watches: [
    {
      id: 'w-flip',
      symbol: 'BANKNIFTY',
      strike: '52000',
      optionType: 'CE',
      expiry: '2026-08-28',
      state: 'CONFIRMED',
      status: 'paused',
      met: 3,
      total: 3,
      conditions: [
        { id: 'r1', name: 'established_level_present', mandatory: true, met: true, detail: 'resistance at 52,100' },
        { id: 'r2', name: 'level_break_close', mandatory: true, met: true, detail: 'broke above' },
        { id: 'r3', name: 'level_flip_holds', mandatory: true, met: true, detail: 'held as support' },
      ],
    },
  ],
  focusedWatchId: 'w-flip',
  currentState: 'CONFIRMED',
  latestObservation: {
    at: '2026-08-10T10:00:00Z',
    candleTime: null,
    state: 'CONFIRMED',
    context: { flip: { kind: 'resistance', touches: 3, ageBars: 42 } },
  },
  availableAnalytics: ['levelAge'],
  segments: [
    {
      id: 'levelAge',
      label: 'Level age',
      samples: 5,
      buckets: [
        { label: 'fresh', observations: 1, confirmations: 0 },
        { label: 'established', observations: 4, confirmations: 2 },
        { label: 'old', observations: 0, confirmations: 0 },
      ],
    },
  ],
});

function renderWorkspacePieces(model: StrategyContract): string {
  return [
    renderToStaticMarkup(
      <StrategyConfigureForm
        strategyName={model.name}
        parameters={model.configuration.parameters}
      />,
    ),
    renderToStaticMarkup(
      <ActiveWatchList
        watches={model.watches}
        focusedWatchId={model.focusedWatchId}
        onFocus={() => {}}
      />,
    ),
    renderToStaticMarkup(<ObservedContextPanel observation={model.latestObservation} />),
    renderToStaticMarkup(
      <StrategyPerformancePanel
        performance={model.performance}
        segments={renderableSegments(model)}
      />,
    ),
  ].join('\n');
}

describe('two unrelated strategies render through the same components', () => {
  it('renders both without a strategy-specific component', () => {
    for (const model of [ema7, srFlip]) {
      const html = renderWorkspacePieces(model);
      expect(html).toContain(model.name);
      expect(html).toContain('strategy-configure');
      expect(html).toContain('active-watches');
      expect(html).toContain('strategy-performance');
    }
  });

  it('shows each strategy its own conditions', () => {
    expect(renderWorkspacePieces(ema7)).toContain('ema7_body_reclaim');
    expect(renderWorkspacePieces(srFlip)).toContain('level_flip_holds');
    // Neither leaks into the other.
    expect(renderWorkspacePieces(ema7)).not.toContain('level_flip_holds');
    expect(renderWorkspacePieces(srFlip)).not.toContain('ema7_body_reclaim');
  });

  it('generates a different number of controls from the same form', () => {
    const count = (html: string) => html.split('data-testid="param-').length - 1;
    expect(count(renderWorkspacePieces(srFlip))).toBeGreaterThan(
      count(renderWorkspacePieces(ema7)),
    );
  });

  it('renders each strategy its own observed context without naming it', () => {
    expect(renderWorkspacePieces(ema7)).toContain('Depth Atr');
    expect(renderWorkspacePieces(srFlip)).toContain('Age Bars');
  });

  it('renders whichever breakdown that strategy has samples for', () => {
    expect(renderWorkspacePieces(ema7)).toContain('segment-pullbackDepth');
    expect(renderWorkspacePieces(srFlip)).toContain('segment-levelAge');
  });

  it('renders no breakdown at all when nothing has been observed', () => {
    const fresh = contract({ name: 'Just adopted' });
    const html = renderWorkspacePieces(fresh);
    expect(html).not.toContain('data-testid="segment-');
    // The small-sample note is still shown: silence about the sample size
    // would be worse than saying it is small.
    expect(html).toContain('too few to read as a rate');
  });

  it('drops zero-sample segments even if handed one', () => {
    const empty = contract({
      segments: [{ id: 'vwapTest', label: 'VWAP test', samples: 0, buckets: [] }],
    });
    expect(renderableSegments(empty)).toHaveLength(0);
    expect(renderWorkspacePieces(empty)).not.toContain('segment-vwapTest');
  });
});

describe('no component branches on which strategy it is showing', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const sources = readdirSync(dir)
    .filter((f) => (f.endsWith('.tsx') || f.endsWith('.ts')) && !f.includes('.test.'))
    .map((f) => ({ name: f, body: readFileSync(path.join(dir, f), 'utf8') }));

  const TEMPLATE_IDS = [
    'ema7_bullish_reclaim',
    'ema_9_21_pullback',
    'vwap_bounce',
    'vwap_reversion_eod',
    'sr_flip',
    'flag_pennant',
    'supply_demand_zone',
    'liquidity_sweep_fvg',
    'orb_15m_retest',
    'orb_30m',
    'news_momentum',
  ];

  it('mentions no template id anywhere in the strategy components', () => {
    for (const source of sources) {
      for (const id of TEMPLATE_IDS) {
        expect(source.body, `${source.name} names the template "${id}"`).not.toContain(`'${id}'`);
        expect(source.body, `${source.name} names the template "${id}"`).not.toContain(`"${id}"`);
      }
    }
  });

  it('keeps the catalogue split factual rather than ranked', () => {
    const { available, unavailable } = splitCatalogue([
      { id: 'a', name: 'A', summary: '', available: true },
      { id: 'b', name: 'B', summary: '', available: false, unavailableReason: 'needs a pipeline' },
    ]);
    expect(available.map((t) => t.id)).toEqual(['a']);
    expect(unavailable[0].unavailableReason).toBe('needs a pipeline');
  });

  it('hides internal bookkeeping from observed context', () => {
    const rows = contextRows({
      at: 'now',
      candleTime: null,
      state: 'FORMING',
      context: { mandatoryMet: 2, mandatoryTotal: 4, notified: true, vwap: { slope: 'rising' } },
    });
    expect(rows.map((r) => r.label)).toEqual(['Vwap · Slope']);
  });
});
