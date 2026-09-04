import { describe, expect, it } from 'vitest';
import type { OptionChainEntry } from '@tradew/types';
import { hasDirectiveLanguage } from '../vocabulary/vocabulary';
import {
  DEFAULT_POSITIONING_POLICY,
  buildLadder,
  describeOIAction,
  judgePositioning,
  readOptionPositioning,
} from './option-positioning';

const EXPIRY = new Date('2026-09-04T00:00:00Z');

/**
 * A NIFTY-shaped front-expiry chain around the screenshot this module was
 * specified from: spot ~23,986, put OI concentrated at 23,900–23,950, call OI
 * building through 24,100 and peaking at 24,200.
 *
 * Every leg carries a previous OI and a previous close, so the four-quadrant
 * read is exercisable. Overrides replace whole legs per strike.
 */
function chain(over: Partial<Record<number, Partial<OptionChainEntry>>> = {}): OptionChainEntry[] {
  const rows: Record<number, Partial<OptionChainEntry>> = {
    23_800: { callOI: 1_200_000, putOI: 4_100_000 },
    23_850: { callOI: 1_500_000, putOI: 4_600_000 },
    23_900: { callOI: 2_100_000, putOI: 6_300_000 },
    23_950: { callOI: 3_200_000, putOI: 6_900_000 },
    24_000: { callOI: 5_762_000, putOI: 5_751_000 },
    24_050: { callOI: 4_900_000, putOI: 3_100_000 },
    24_100: { callOI: 6_604_000, putOI: 2_200_000 },
    24_150: { callOI: 4_100_000, putOI: 1_400_000 },
    24_200: { callOI: 7_469_000, putOI: 1_100_000 },
    24_250: { callOI: 2_202_000, putOI: 563_000 },
    24_300: { callOI: 1_900_000, putOI: 420_000 },
  };
  return Object.entries(rows).map(([k, row]) => {
    const strike = Number(k);
    const callOI = row.callOI ?? 0;
    const putOI = row.putOI ?? 0;
    return {
      strike,
      expiry: EXPIRY,
      callOI,
      putOI,
      callVolume: 100_000,
      putVolume: 100_000,
      callLtp: 100,
      putLtp: 100,
      // No change anywhere by default — every level `steady`, so a test that
      // wants a verb has to state it, and the baseline can never accidentally
      // supply one.
      callPrevOI: callOI,
      putPrevOI: putOI,
      callPrevClose: 100,
      putPrevClose: 100,
      ...(over[strike] ?? {}),
    };
  });
}

const SPOT = 23_986;

function read(over: Partial<Record<number, Partial<OptionChainEntry>>> = {}) {
  const r = readOptionPositioning({ symbol: 'NIFTY', spot: SPOT, entries: chain(over) });
  expect(r).not.toBeNull();
  return r!;
}

describe('readOptionPositioning — the map', () => {
  it('ranks the resistances above spot in the order price would meet them', () => {
    // The heaviest call strike in the chain is 24,200. The FIRST one price has
    // to get through is 24,000. A ladder that led with the heaviest would
    // describe the journey in the wrong sequence.
    const r = read();
    expect(r.resistances.map((l) => l.strike)).toEqual([24_000, 24_100, 24_200, 24_050]
      .sort((a, b) => a - b));
    expect(r.resistances[0].strike).toBe(24_000);
  });

  it('ranks the supports below spot nearest-first walking down', () => {
    const r = read();
    expect(r.supports[0].strike).toBe(23_950);
    expect(r.supports.map((l) => l.strike)).toEqual([23_950, 23_900, 23_850, 23_800]);
  });

  it('reads 24,000 as the pivot — the strike where the two sides are level', () => {
    // CE 57.62L against PE 57.51L. Nothing else near spot is that balanced.
    expect(read().pivot).toBe(24_000);
  });

  it('computes strike-level PCR, which is not the chain PCR', () => {
    const r = read();
    const atPivot = r.strikes.find((s) => s.strike === 24_000)!;
    expect(atPivot.pcr).toBeCloseTo(0.998, 2);
    // The chain as a whole is call-heavy (the walls above spot dominate the
    // total) while the pivot strike itself is balanced. The two numbers answer
    // different questions and must not be assumed to agree.
    expect(r.pcr).toBeLessThan(1);
  });
});

describe('the four-quadrant read', () => {
  it('calls rising OI with a falling premium fresh writing', () => {
    const r = read({ 24_100: { callOI: 8_000_000, callPrevOI: 6_604_000, callLtp: 60, callPrevClose: 90 } });
    expect(r.strikes.find((s) => s.strike === 24_100)!.callAction).toBe('fresh-writing');
    expect(r.resistances.find((l) => l.strike === 24_100)!.defence).toBe('reinforcing');
  });

  it('calls falling OI with a rising premium covering', () => {
    const r = read({ 24_100: { callOI: 5_000_000, callPrevOI: 6_604_000, callLtp: 140, callPrevClose: 90 } });
    expect(r.strikes.find((s) => s.strike === 24_100)!.callAction).toBe('covering');
    expect(r.resistances.find((l) => l.strike === 24_100)!.defence).toBe('eroding');
  });

  it('calls rising OI with a rising premium fresh buying', () => {
    const r = read({ 24_100: { callOI: 8_000_000, callPrevOI: 6_604_000, callLtp: 140, callPrevClose: 90 } });
    expect(r.strikes.find((s) => s.strike === 24_100)!.callAction).toBe('long-buildup');
  });

  it('ignores a change too small to distinguish from drift', () => {
    // 1% of a 66-lakh wall is 66,000 contracts and is not a change of stance.
    const r = read({ 24_100: { callOI: 6_670_000, callPrevOI: 6_604_000 } });
    expect(r.strikes.find((s) => s.strike === 24_100)!.callAction).toBe('flat');
    expect(r.resistances.find((l) => l.strike === 24_100)!.defence).toBe('steady');
  });

  it('never confuses an absent previous OI with a wall built today', () => {
    const r = read({ 24_200: { callPrevOI: undefined } });
    const row = r.strikes.find((s) => s.strike === 24_200)!;
    expect(row.callOIChange).toBeNull();
    expect(row.callAction).toBe('unknown');
  });
});

describe('migration', () => {
  it('reads both centres moving up the grid as an upward migration', () => {
    const r = read({
      // Calls unwound below, written above; puts rolled up from 23,800 to 24,000.
      24_000: { callOI: 3_000_000, callPrevOI: 5_762_000, putOI: 8_000_000, putPrevOI: 5_751_000 },
      24_300: { callOI: 4_000_000, callPrevOI: 1_900_000 },
      23_800: { putOI: 1_000_000, putPrevOI: 4_100_000 },
    });
    expect(r.migration.direction).toBe('up');
    expect(r.migration.callShiftSteps!).toBeGreaterThan(0);
    expect(r.migration.putShiftSteps!).toBeGreaterThan(0);
  });

  it('names a range tightening as compression rather than as a direction', () => {
    // Calls written LOWER and puts written HIGHER is both sides moving in. It
    // is not bearish and it is not bullish, and calling it either was the
    // easiest available way to make the gate wrong.
    const r = read({
      // Calls rewritten LOWER: the 24,200 wall moved down to 23,850.
      23_850: { callOI: 6_000_000, callPrevOI: 1_500_000 },
      24_200: { callOI: 2_000_000, callPrevOI: 7_469_000 },
      // Puts rolled UP: the 23,800 base moved to 24,050.
      23_800: { putOI: 500_000, putPrevOI: 4_100_000 },
      24_050: { putOI: 6_700_000, putPrevOI: 3_100_000 },
    });
    expect(r.migration.callShiftSteps!).toBeLessThan(0);
    expect(r.migration.putShiftSteps!).toBeGreaterThan(0);
    expect(r.migration.direction).toBe('compressing');
  });

  it('reports migration as unknown when previous OI is missing across the chain', () => {
    const stripped = chain().map((e) => ({ ...e, callPrevOI: undefined, putPrevOI: undefined }));
    const r = readOptionPositioning({ symbol: 'NIFTY', spot: SPOT, entries: stripped })!;
    expect(r.hasOIChange).toBe(false);
    expect(r.migration.direction).toBe('unknown');
    expect(r.supports[0].defence).toBe('unknown');
  });
});

describe('judgePositioning — agreement, never a direction of its own', () => {
  it('confirms a CE side when the level ahead thins, the level behind thickens and the structure migrates up', () => {
    const r = read({
      24_000: { callOI: 2_500_000, callPrevOI: 5_762_000, callLtp: 150, callPrevClose: 90 },
      23_950: { putOI: 9_500_000, putPrevOI: 6_900_000, putLtp: 40, putPrevClose: 70 },
      24_300: { callOI: 4_000_000, callPrevOI: 1_900_000 },
    });
    const j = judgePositioning(r, 'CE');
    expect(j.verdict).toBe('confirms');
    expect(j.score).toBeGreaterThan(DEFAULT_POSITIONING_POLICY.confirmAbove);
  });

  it('conflicts with a CE side when the level ahead is reinforced and the support behind is abandoned', () => {
    const r = read({
      24_000: { callOI: 9_000_000, callPrevOI: 5_762_000, callLtp: 40, callPrevClose: 90 },
      23_950: { putOI: 3_000_000, putPrevOI: 6_900_000, putLtp: 130, putPrevClose: 70 },
      23_800: { putOI: 7_000_000, putPrevOI: 4_100_000 },
    });
    const j = judgePositioning(r, 'CE');
    expect(j.verdict).toBe('conflicts');
    // And the mirror side of the same book is not automatically the opposite
    // verdict — the two are judged independently.
    expect(judgePositioning(r, 'PE').verdict).not.toBe('conflicts');
  });

  it('CANNOT reach a conflict when the feed published no previous OI', () => {
    // This is the load-bearing property of the whole gate: a missing feed
    // field degrades the read, it never blocks an agent. Only `headroom`
    // survives, at weight 0.20, against a −0.30 conflict threshold.
    const stripped = chain().map((e) => ({
      ...e,
      callPrevOI: undefined,
      putPrevOI: undefined,
      callPrevClose: undefined,
      putPrevClose: undefined,
    }));
    // Spot pressed right under a wall — the worst case the surviving signal can
    // produce.
    const r = readOptionPositioning({ symbol: 'NIFTY', spot: 23_999, entries: stripped })!;
    const j = judgePositioning(r, 'CE');
    expect(j.score).toBeGreaterThan(DEFAULT_POSITIONING_POLICY.conflictBelow);
    expect(j.verdict).not.toBe('conflicts');
  });

  it('penalises buying into a wall that is one tick away', () => {
    const r = readOptionPositioning({ symbol: 'NIFTY', spot: 23_999, entries: chain() })!;
    const headroom = judgePositioning(r, 'CE').signals.find((s) => s.id === 'headroom')!;
    expect(headroom.value).toBe(-1);
  });

  it('reports every signal it used, including the ones it could not read', () => {
    const j = judgePositioning(read(), 'CE');
    expect(j.signals.map((s) => s.id)).toEqual(['defence-ahead', 'defence-behind', 'migration', 'headroom']);
    for (const s of j.signals) expect(s.detail.length).toBeGreaterThan(0);
  });
});

describe('buildLadder — the conditional path', () => {
  it('lays the levels out in the order price would meet them, with the support first', () => {
    const ladder = buildLadder(read(), 'bullish', 24_500);
    expect(ladder.steps[0].role).toBe('support');
    expect(ladder.steps[0].strike).toBe(23_950);
    expect(ladder.steps[1].role).toBe('pivot');
    expect(ladder.steps[ladder.steps.length - 1].role).toBe('projected');
    expect(ladder.steps[ladder.steps.length - 1].strike).toBe(24_500);
  });

  it('drops defended levels beyond the projected level rather than overshooting it', () => {
    const ladder = buildLadder(read(), 'bullish', 24_100);
    expect(ladder.steps.filter((s) => s.role === 'level').every((s) => s.strike <= 24_100)).toBe(true);
  });

  it('names the next level still ahead of spot as the decision point', () => {
    expect(buildLadder(read(), 'bullish').nextDecisionPoint).toBe(24_000);
    expect(buildLadder(read(), 'bearish').nextDecisionPoint).toBe(23_950);
  });

  it('invents nothing when no projected level is supplied', () => {
    const ladder = buildLadder(read(), 'bullish');
    expect(ladder.steps.some((s) => s.role === 'projected')).toBe(false);
  });

  it('gives every rung both a confirmation and an invalidation', () => {
    for (const step of buildLadder(read(), 'bullish', 24_500).steps) {
      expect(step.confirms.length).toBeGreaterThan(10);
      expect(step.invalidates.length).toBeGreaterThan(10);
    }
  });
});

describe('compliance', () => {
  it('emits no directive language on any surface a trader can reach', () => {
    // Rule 2 (SENTINEL_MASTER_PLAN §2): this module's strings reach a trader
    // through the options-chain agent's verdict, so they must survive the
    // enforcer unchanged rather than be rewritten downstream.
    const r = read({ 24_100: { callOI: 5_000_000, callPrevOI: 6_604_000, callLtp: 140, callPrevClose: 90 } });
    const strings = [
      r.summary,
      r.migration.note,
      ...r.supports.map((l) => l.note),
      ...r.resistances.map((l) => l.note),
      ...(['CE', 'PE'] as const).flatMap((side) => {
        const j = judgePositioning(r, side);
        return [j.summary, ...j.signals.map((s) => s.detail)];
      }),
      ...(['bullish', 'bearish'] as const).flatMap((dir) => {
        const l = buildLadder(r, dir, dir === 'bullish' ? 24_500 : 23_500);
        return [l.summary, ...l.steps.flatMap((s) => [s.confirms, s.invalidates])];
      }),
      ...(
        ['long-buildup', 'fresh-writing', 'covering', 'long-unwinding', 'flat', 'unknown'] as const
      ).map(describeOIAction),
    ];
    for (const text of strings) {
      expect({ text, directive: hasDirectiveLanguage(text) }).toEqual({ text, directive: false });
    }
  });
});

describe('honest degradation', () => {
  it('returns null rather than a fabricated read when spot is unusable', () => {
    expect(readOptionPositioning({ symbol: 'NIFTY', spot: 0, entries: chain() })).toBeNull();
  });

  it('returns null on an empty chain', () => {
    expect(readOptionPositioning({ symbol: 'NIFTY', spot: SPOT, entries: [] })).toBeNull();
  });
});
