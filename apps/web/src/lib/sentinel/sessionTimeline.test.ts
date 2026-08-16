import { describe, expect, it } from 'vitest';
import { toTimelineDots } from './sessionTimeline';
import type { TimelineEntry } from './types';

/**
 * The session track renders left-to-right as a chronology, so an entry in the
 * wrong slot is a statement that the market did something at a time it did
 * not. The engine returns entries in APPEND order and stamps them with MARKET
 * time — two correct behaviours that together let a bar-timed detection land
 * after a poll-timed guidance entry. That is the bug these assertions pin.
 */

function entry(over: Partial<TimelineEntry> & { at: string }): TimelineEntry {
  return {
    time: over.at.slice(11, 16),
    event: 'something happened',
    level: 'observation',
    ...over,
  };
}

describe('toTimelineDots — ordering', () => {
  it('orders by the instant each event happened at, not the order it arrived in', () => {
    // Exactly the shape the engine produces: a detection recorded on the 10:20
    // poll but carrying the 10:05 bar its rules matched on, appended after a
    // guidance entry stamped with the poll clock.
    const dots = toTimelineDots([
      entry({ at: '2026-08-16T04:00:00.000Z', event: 'Market open: NIFTY opened at 24350' }),
      entry({ at: '2026-08-16T04:48:00.000Z', event: 'SIDE IN FOCUS — 78% confidence', level: 'guidance' }),
      entry({ at: '2026-08-16T04:35:00.000Z', event: 'ORB Retest forming — 2 of 3 rules', level: 'setup' }),
    ]);
    expect(dots.map((d) => d.at)).toEqual([
      '2026-08-16T04:00:00.000Z',
      '2026-08-16T04:35:00.000Z',
      '2026-08-16T04:48:00.000Z',
    ]);
  });

  it('marks only the newest entry as current', () => {
    const dots = toTimelineDots([
      entry({ at: '2026-08-16T04:48:00.000Z' }),
      entry({ at: '2026-08-16T04:00:00.000Z' }),
    ]);
    expect(dots.map((d) => d.latest)).toEqual([false, true]);
  });

  it('keeps entries sharing one bar timestamp in their original order', () => {
    // Several detections legitimately match on the same candle. Re-ordering
    // them against each other would assert a sequence the data has not got.
    const dots = toTimelineDots([
      entry({ at: '2026-08-16T04:35:00.000Z', event: 'A: first' }),
      entry({ at: '2026-08-16T04:35:00.000Z', event: 'B: second' }),
    ]);
    expect(dots.map((d) => d.title)).toEqual(['A', 'B']);
  });

  it('leaves an unparseable timestamp where it was rather than sorting it to the epoch', () => {
    const dots = toTimelineDots([
      entry({ at: '2026-08-16T04:00:00.000Z' }),
      entry({ at: 'not-a-date' }),
      entry({ at: '2026-08-16T04:48:00.000Z' }),
    ]);
    expect(dots[1].at).toBe('not-a-date');
  });

  it('returns nothing for an absent or empty timeline', () => {
    expect(toTimelineDots(undefined)).toEqual([]);
    expect(toTimelineDots([])).toEqual([]);
  });
});

describe('toTimelineDots — the label split', () => {
  it('splits a sentence at its own colon', () => {
    const [dot] = toTimelineDots([entry({ at: '2026-08-16T04:00:00.000Z', event: 'Market open: NIFTY opened at 24350' })]);
    expect(dot.title).toBe('Market open');
    expect(dot.detail).toBe('NIFTY opened at 24350');
  });

  it('splits at an em dash', () => {
    const [dot] = toTimelineDots([
      entry({ at: '2026-08-16T04:00:00.000Z', event: 'ORB Retest forming — 2 of 3 rules confirmed', level: 'setup' }),
    ]);
    expect(dot.title).toBe('ORB Retest forming');
    expect(dot.detail).toBe('2 of 3 rules confirmed');
  });

  it('keeps a long leading clause whole instead of turning the sentence into a title', () => {
    const long =
      'Sentinel is holding back a directional read because no pattern has a live-market track record: waiting';
    const [dot] = toTimelineDots([entry({ at: '2026-08-16T04:00:00.000Z', event: long })]);
    expect(dot.title).toBe('Observation');
    // No text is lost when the split is declined.
    expect(dot.detail).toBe(long);
  });

  it('never invents text for an empty event', () => {
    const [dot] = toTimelineDots([entry({ at: '2026-08-16T04:00:00.000Z', event: '', level: 'guidance' })]);
    expect(dot.title).toBe('Guidance');
    expect(dot.detail).toBe('');
  });
});

describe('toTimelineDots — the third line', () => {
  it('prefers the state reached over the confidence scored', () => {
    const [dot] = toTimelineDots([
      entry({ at: '2026-08-16T04:00:00.000Z', state: 'SIDE_IN_FOCUS', confidence: 78 }),
    ]);
    expect(dot.meta).toBe('Side In Focus');
  });

  it('falls back to confidence when no state was recorded', () => {
    const [dot] = toTimelineDots([entry({ at: '2026-08-16T04:00:00.000Z', confidence: 78.4 })]);
    expect(dot.meta).toBe('78% confidence');
  });

  it('is blank when the entry carries neither', () => {
    expect(toTimelineDots([entry({ at: '2026-08-16T04:00:00.000Z' })])[0].meta).toBe('');
  });
});
