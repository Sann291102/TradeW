import { describe, expect, it } from 'vitest';
import type { Candle } from '@tradew/types';
import {
  annotationMarkers,
  annotationPriceLines,
  annotationsAtBar,
  type StrategyAnnotation,
  type StrategyLevel,
} from './strategyAnnotations';

/**
 * Strategy annotations → chart markers.
 *
 * Every failure here is SILENT in the way that matters most on this particular
 * surface: the chart still renders, the bars are right, and the bot's reasoning
 * is simply absent or misplaced. Absent reads as "the bot did nothing", which is
 * the exact conclusion this chart exists to make trustworthy — so the mapping is
 * asserted rather than eyeballed, following the precedent `drawings.test.ts` set
 * for annotation geometry.
 */

/** 15-minute bars from 10:00 UTC. */
function bars(count: number, startIso = '2026-09-07T10:00:00Z'): Candle[] {
  const start = new Date(startIso).getTime();
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(start + i * 15 * 60_000),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1_000,
  })) as Candle[];
}

function annotation(overrides: Partial<StrategyAnnotation> = {}): StrategyAnnotation {
  return {
    kind: 'signal',
    at: '2026-09-07T10:07:23Z',
    price: 100,
    label: 'ORB',
    detail: 'detail',
    strategyId: 'orb',
    strategyName: 'Opening Range Breakout',
    confidence: 82,
    regime: 'trending',
    ...overrides,
  };
}

const secs = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

describe('snapping annotations to bars', () => {
  it('snaps a mid-bar instant back to the bar that contains it', () => {
    // THE HEADLINE CASE. lightweight-charts silently DROPS a marker whose time
    // has no bar, so an unsnapped 10:07:23 renders nothing at all — and a chart
    // showing no decisions is indistinguishable from a bot that made none.
    const markers = annotationMarkers([annotation({ at: '2026-09-07T10:07:23Z' })], bars(4));
    expect(markers).toHaveLength(1);
    expect(markers[0].time).toBe(secs('2026-09-07T10:00:00Z'));
  });

  it('snaps to the bar that CONTAINS the instant, not the nearest one', () => {
    // 10:14:59 is inside the 10:00 bar even though 10:15 is closer in absolute
    // time. Snapping forward would place a decision on a bar that had not yet
    // formed when the decision was taken.
    const markers = annotationMarkers([annotation({ at: '2026-09-07T10:14:59Z' })], bars(4));
    expect(markers[0].time).toBe(secs('2026-09-07T10:00:00Z'));
  });

  it('DROPS an annotation older than the loaded history rather than clamping it', () => {
    // Clamping to the first bar would stack every out-of-range decision onto
    // the left edge and read as a flurry of activity that never happened.
    const markers = annotationMarkers([annotation({ at: '2026-09-07T08:00:00Z' })], bars(4));
    expect(markers).toEqual([]);
  });

  it('returns nothing when there are no bars at all', () => {
    expect(annotationMarkers([annotation()], [])).toEqual([]);
    expect(annotationMarkers([annotation()], null)).toEqual([]);
  });

  it('emits markers in ascending time order', () => {
    // Out-of-order markers are dropped by lightweight-charts without an error.
    const markers = annotationMarkers(
      [
        annotation({ kind: 'exit', at: '2026-09-07T10:50:00Z' }),
        annotation({ kind: 'signal', at: '2026-09-07T10:05:00Z' }),
        annotation({ kind: 'entry', at: '2026-09-07T10:20:00Z' }),
      ],
      bars(6),
    );
    const times = markers.map((m) => m.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe('rejection spans', () => {
  it('suppresses a span too short to be a state the agent was in', () => {
    const brief = annotationMarkers(
      [annotation({ kind: 'rejection', passes: 1, checkId: 'confidence-floor' })],
      bars(4),
    );
    expect(brief).toEqual([]);
  });

  it('draws a span that held, and labels it with the PEAK confidence', () => {
    // "blocked at 58/70" and "blocked at 12/70" are the same refusal and
    // completely different situations; the peak is what distinguishes them.
    const held = annotationMarkers(
      [
        annotation({
          kind: 'rejection',
          passes: 284,
          checkId: 'confidence-floor',
          label: 'Confidence floor',
          peakConfidence: 58.1,
        }),
      ],
      bars(4),
    );
    expect(held).toHaveLength(1);
    expect(held[0].text).toContain('58');
    // Refusals must be the quietest thing on the chart — they are the most
    // numerous by far and they are context, not events.
    expect(held[0].colorToken).toBe('--muted');
  });

  it('keeps a REJECTED signal visible even though it never became a trade', () => {
    // The agent reached a plan and a bound stopped it. That is a different and
    // more interesting refusal than "no setup", and it must not be filtered by
    // the rejection-span floor, which applies only to `rejection`.
    const markers = annotationMarkers(
      [annotation({ kind: 'signal', label: '▲ ORB', confidence: 74 })],
      bars(4),
    );
    expect(markers).toHaveLength(1);
    expect(markers[0].colorToken).toBe('--accent');
  });
});

describe('one pin per bar per kind', () => {
  it('collapses several spans that land on the same bar', () => {
    // Stacked identical squares render as one smudged block that cannot be
    // read or hovered.
    const markers = annotationMarkers(
      [
        annotation({ kind: 'rejection', at: '2026-09-07T10:01:00Z', passes: 10 }),
        annotation({ kind: 'rejection', at: '2026-09-07T10:06:00Z', passes: 10 }),
        annotation({ kind: 'rejection', at: '2026-09-07T10:12:00Z', passes: 10 }),
      ],
      bars(4),
    );
    expect(markers).toHaveLength(1);
  });

  it('still shows a signal and an entry that share a bar', () => {
    // Different kinds are different facts; collapsing them would hide the entry.
    const markers = annotationMarkers(
      [
        annotation({ kind: 'signal', at: '2026-09-07T10:01:00Z' }),
        annotation({ kind: 'entry', at: '2026-09-07T10:03:00Z' }),
      ],
      bars(4),
    );
    expect(markers).toHaveLength(2);
    expect(markers.map((m) => m.shape).sort()).toEqual(['arrowUp', 'circle']);
  });
});

describe('protection levels', () => {
  const level = (over: Partial<StrategyLevel> = {}): StrategyLevel => ({
    kind: 'stop',
    price: 95,
    label: 'Stop',
    from: '2026-09-07T10:00:00Z',
    until: null,
    intentId: 'i1',
    ...over,
  });

  it('draws only levels still in force', () => {
    // A closed position's stop is history. Drawing it suggests a live level on
    // a chart a trader may act from.
    const lines = annotationPriceLines([
      level(),
      level({ kind: 'target', price: 110, label: 'Target', until: '2026-09-07T11:00:00Z' }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].title).toBe('Stop');
  });

  it('colours stop and target by direction of risk', () => {
    const lines = annotationPriceLines([
      level(),
      level({ kind: 'target', price: 110, label: 'Target' }),
      level({ kind: 'trail', price: 97, label: 'Trail (2 steps)' }),
    ]);
    expect(lines.find((l) => l.title === 'Stop')?.colorToken).toBe('--red');
    expect(lines.find((l) => l.title === 'Target')?.colorToken).toBe('--green');
    expect(lines.find((l) => l.title?.startsWith('Trail'))?.colorToken).toBe('--amber');
  });
});

describe('tooltip lookup', () => {
  it('returns EVERY annotation on a bar, not just the first', () => {
    // Showing one while hiding the other is how a chart starts lying by omission.
    const list = [
      annotation({ kind: 'signal', at: '2026-09-07T10:01:00Z' }),
      annotation({ kind: 'entry', at: '2026-09-07T10:04:00Z' }),
      annotation({ kind: 'exit', at: '2026-09-07T10:31:00Z' }),
    ];
    const atFirst = annotationsAtBar(list, bars(4), secs('2026-09-07T10:00:00Z'));
    expect(atFirst.map((a) => a.kind)).toEqual(['signal', 'entry']);
  });
});
