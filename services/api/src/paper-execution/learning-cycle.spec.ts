import { describe, expect, it } from 'vitest';
import {
  HIGH_GIVE_BACK,
  IMPROVEMENT_KINDS,
  LOSING_BUCKET_R,
  MIN_SAMPLE,
  isRiskReducing,
  runLearningCycle,
  type JournalRecord,
} from './learning-cycle';
import { HOLDOUT_FRACTION, splitHoldout, validateCandidate } from './learning-validation';

let seq = 0;
function trade(over: Partial<JournalRecord> = {}): JournalRecord {
  seq++;
  return {
    id: `t${seq}`,
    strategyId: 'agent-trend-momentum',
    strategyName: 'Trend momentum',
    strategyVersion: '1.0.0',
    regime: 'trending',
    result: 'LOSS',
    rMultiple: -1,
    realizedPnl: -10_000,
    exitReason: 'STOP',
    confidence: 80,
    thesisCorrect: false,
    mfeR: 0.1,
    maeR: 1,
    entrySlippage: 0.2,
    giveBackPct: null,
    holdingSeconds: 600,
    ...over,
  };
}

const CURRENT = { minConfidence: 70, trailStepPoints: 3, strategyIds: ['agent-trend-momentum'] };

function cycle(today: JournalRecord[], history: JournalRecord[] = today) {
  return runLearningCycle({
    sessionDate: '2026-09-07',
    agent: 'sentinel-alpha',
    today,
    history,
    rejections: [{ checkId: 'confidence-floor', label: 'Confidence floor', count: 12 }],
    current: CURRENT,
  });
}

describe('runLearningCycle — metrics and observations', () => {
  it('counts the session and separates wins from losses', () => {
    const r = cycle([
      trade({ result: 'WIN', rMultiple: 2, realizedPnl: 20_000, exitReason: 'TARGET' }),
      trade({ result: 'LOSS', rMultiple: -1, realizedPnl: -10_000 }),
    ]);
    expect(r.tradesAnalysed).toBe(2);
    expect(r.wins).toBe(1);
    expect(r.losses).toBe(1);
    expect(r.metrics.totalPnl).toBe(10_000);
    expect(r.metrics.winRate).toBe(0.5);
    expect(r.metrics.avgR).toBe(0.5);
  });

  it('reports a session with no trades as a normal outcome rather than a failure', () => {
    const r = cycle([], []);
    expect(r.tradesAnalysed).toBe(0);
    expect(r.observations.some((o) => o.id === 'no-trades')).toBe(true);
    expect(r.observations.find((o) => o.id === 'no-trades')!.actionable).toBe(false);
    expect(r.candidates).toHaveLength(0);
  });

  it('marks an under-sampled strategy/regime reading as NOT actionable', () => {
    const r = cycle([trade(), trade(), trade()]);
    const obs = r.observations.find((o) => o.topic === 'strategy-regime');
    expect(obs!.sampleSize).toBe(3);
    expect(obs!.actionable).toBe(false);
    expect(obs!.statement).toContain('not a conclusion');
  });

  it('counts rejected setups as part of the session', () => {
    const r = cycle([trade()]);
    expect(r.rejectedSetups).toBe(12);
    expect(r.observations.some((o) => o.topic === 'rejections')).toBe(true);
  });

  it('never averages a missing measurement as zero', () => {
    const r = cycle([trade({ entrySlippage: null, maeR: null, thesisCorrect: null })]);
    expect(r.metrics.executionQuality.avgEntrySlippage).toBeNull();
    expect(r.metrics.executionQuality.avgMaeR).toBeNull();
    expect(r.metrics.executionQuality.thesisCorrectRate).toBeNull();
  });
});

describe('runLearningCycle — candidates cannot come from one session', () => {
  it('proposes NOTHING from a single bad day, however bad', () => {
    // Three catastrophic losses. An overfitting pipeline would disable the
    // strategy on the spot; this one has not seen the sample floor.
    const day = [
      trade({ rMultiple: -3, realizedPnl: -30_000 }),
      trade({ rMultiple: -3, realizedPnl: -30_000 }),
      trade({ rMultiple: -3, realizedPnl: -30_000 }),
    ];
    const r = cycle(day, day);
    expect(r.candidates).toHaveLength(0);
  });

  it('proposes disabling a strategy/regime only once the ACCUMULATED sample clears the floor', () => {
    const history = Array.from({ length: MIN_SAMPLE }, () => trade({ rMultiple: -1, realizedPnl: -10_000 }));
    const r = cycle([trade()], history);
    const candidate = r.candidates.find((c) => c.kind === IMPROVEMENT_KINDS.STRATEGY_REGIME_DISABLE);
    expect(candidate).toBeTruthy();
    expect(candidate!.evidence).toMatchObject({ trades: MIN_SAMPLE, sampleFloor: MIN_SAMPLE });
    expect(candidate!.rationale).toContain('reduces exposure');
  });

  it('does not propose disabling a bucket that is merely mediocre', () => {
    // Average R above the losing threshold: not a candidate.
    const history = Array.from({ length: MIN_SAMPLE * 2 }, () =>
      trade({ rMultiple: LOSING_BUCKET_R + 0.2, realizedPnl: -100 }),
    );
    const r = cycle([trade()], history);
    expect(r.candidates.some((c) => c.kind === IMPROVEMENT_KINDS.STRATEGY_REGIME_DISABLE)).toBe(false);
  });
});

describe('runLearningCycle — every candidate is risk-reducing', () => {
  it('only ever proposes RAISING a confidence floor', () => {
    // Low-confidence trades lose, high-confidence ones win.
    const low = Array.from({ length: MIN_SAMPLE }, () => trade({ confidence: 71, rMultiple: -1, realizedPnl: -10_000 }));
    const high = Array.from({ length: MIN_SAMPLE }, () =>
      trade({ confidence: 90, rMultiple: 2, realizedPnl: 20_000, result: 'WIN', exitReason: 'TARGET' }),
    );
    const r = cycle([trade()], [...low, ...high]);
    const candidate = r.candidates.find((c) => c.kind === IMPROVEMENT_KINDS.CONFIDENCE_FLOOR_RAISE);
    expect(candidate).toBeTruthy();
    expect(Number(candidate!.proposedValue.minConfidence)).toBeGreaterThan(CURRENT.minConfidence);
    expect(candidate!.rationale).toContain('strictly reduces');
  });

  it('only ever proposes TIGHTENING a trail step', () => {
    const history = Array.from({ length: MIN_SAMPLE }, () =>
      trade({ mfeR: 3, giveBackPct: 0.9, result: 'WIN', rMultiple: 0.3, realizedPnl: 3_000, exitReason: 'TRAIL' }),
    );
    const r = cycle([trade()], history);
    const candidate = r.candidates.find((c) => c.kind === IMPROVEMENT_KINDS.TRAIL_STEP_TIGHTEN);
    expect(candidate).toBeTruthy();
    expect(Number(candidate!.proposedValue.trailStepPoints)).toBeLessThan(CURRENT.trailStepPoints);
    expect(candidate!.rationale).toContain('no additional risk');
  });

  it('every emitted candidate is declared risk-reducing or neutral', () => {
    // The structural guarantee: a loosening proposal is unrepresentable, and
    // the generator filters on the declaration as well.
    const history = [
      ...Array.from({ length: MIN_SAMPLE }, () => trade({ rMultiple: -1, realizedPnl: -10_000, confidence: 71 })),
      ...Array.from({ length: MIN_SAMPLE }, () =>
        trade({ confidence: 90, rMultiple: 2, realizedPnl: 20_000, result: 'WIN', mfeR: 3, giveBackPct: 0.9 }),
      ),
    ];
    const r = cycle([trade()], history);
    expect(r.candidates.length).toBeGreaterThan(0);
    for (const c of r.candidates) expect(isRiskReducing(c.kind)).toBe(true);
  });

  it('refuses to treat an undeclared kind as safe', () => {
    // Adding a kind without declaring a risk direction must not be promotable.
    expect(isRiskReducing('SOME_FUTURE_LOOSENING_KIND')).toBe(false);
    expect(isRiskReducing(IMPROVEMENT_KINDS.STRATEGY_REGIME_DISABLE)).toBe(true);
  });

  it('states plainly in the report that nothing has been applied', () => {
    const history = Array.from({ length: MIN_SAMPLE }, () => trade({ rMultiple: -1, realizedPnl: -10_000 }));
    const r = cycle([trade()], history);
    expect(r.report).toContain('No candidate has changed anything');
    expect(r.report).toContain('operator');
  });
});

describe('splitHoldout / validateCandidate — out-of-sample or it proves nothing', () => {
  it('holds out the LATER portion, preserving chronology', () => {
    const rows = Array.from({ length: 10 }, (_, i) => trade({ id: `x${i}` }));
    const { train, holdout } = splitHoldout(rows);
    expect(train).toHaveLength(7);
    expect(holdout).toHaveLength(3);
    expect(holdout[0].id).toBe('x7'); // the later trades, not a random sample
    expect(HOLDOUT_FRACTION).toBe(0.3);
  });

  it('is inconclusive when the holdout is too small to judge', () => {
    const r = validateCandidate({
      kind: IMPROVEMENT_KINDS.STRATEGY_REGIME_DISABLE,
      proposedValue: { strategyId: 'agent-trend-momentum', regime: 'trending' },
      holdout: [trade(), trade()],
    });
    expect(r.conclusive).toBe(false);
    expect(r.supported).toBeNull();
    expect(r.reason).toContain('below the');
  });

  it('SUPPORTS removing a subset that genuinely dragged the holdout down', () => {
    const holdout = [
      ...Array.from({ length: 5 }, () => trade({ regime: 'ranging', rMultiple: -1, realizedPnl: -10_000 })),
      ...Array.from({ length: 5 }, () =>
        trade({ regime: 'trending', result: 'WIN', rMultiple: 2, realizedPnl: 20_000 }),
      ),
    ];
    const r = validateCandidate({
      kind: IMPROVEMENT_KINDS.STRATEGY_REGIME_DISABLE,
      proposedValue: { strategyId: 'agent-trend-momentum', regime: 'ranging' },
      holdout,
    });
    expect(r.conclusive).toBe(true);
    expect(r.supported).toBe(true);
    expect(r.pnlDelta).toBe(50_000); // the five losers removed
  });

  it('REFUTES a proposal whose pattern did not persist out of sample', () => {
    // The 'ranging' bucket made money in the held-out period, so removing it
    // would have hurt — exactly the overfit the holdout exists to catch.
    const holdout = [
      ...Array.from({ length: 5 }, () =>
        trade({ regime: 'ranging', result: 'WIN', rMultiple: 2, realizedPnl: 20_000 }),
      ),
      ...Array.from({ length: 5 }, () => trade({ regime: 'trending', rMultiple: -1, realizedPnl: -10_000 })),
    ];
    const r = validateCandidate({
      kind: IMPROVEMENT_KINDS.STRATEGY_REGIME_DISABLE,
      proposedValue: { strategyId: 'agent-trend-momentum', regime: 'ranging' },
      holdout,
    });
    expect(r.conclusive).toBe(true);
    expect(r.supported).toBe(false);
    expect(r.reason).toContain('did not persist');
  });

  it('is inconclusive — never "supported" — when the holdout contains no matching trades', () => {
    const holdout = Array.from({ length: 10 }, () => trade({ regime: 'trending' }));
    const r = validateCandidate({
      kind: IMPROVEMENT_KINDS.STRATEGY_REGIME_DISABLE,
      proposedValue: { strategyId: 'agent-trend-momentum', regime: 'ranging' },
      holdout,
    });
    expect(r.conclusive).toBe(false);
    expect(r.supported).toBeNull();
  });

  it('validates a confidence-floor raise by removing the band below it', () => {
    const holdout = [
      ...Array.from({ length: 5 }, () => trade({ confidence: 71, rMultiple: -1, realizedPnl: -10_000 })),
      ...Array.from({ length: 5 }, () =>
        trade({ confidence: 90, result: 'WIN', rMultiple: 2, realizedPnl: 20_000 }),
      ),
    ];
    const r = validateCandidate({
      kind: IMPROVEMENT_KINDS.CONFIDENCE_FLOOR_RAISE,
      proposedValue: { minConfidence: 75 },
      holdout,
    });
    expect(r.supported).toBe(true);
    expect(r.pnlDelta).toBe(50_000);
  });

  it('REFUSES TO FAKE a trail-step validation the journal cannot support', () => {
    // The journal records what happened under the trail that was in force. It
    // contains no path to re-run a different one, so claiming validation here
    // would be a fabrication.
    const r = validateCandidate({
      kind: IMPROVEMENT_KINDS.TRAIL_STEP_TIGHTEN,
      proposedValue: { trailStepPoints: 2 },
      holdout: Array.from({ length: 20 }, () => trade({ mfeR: 3, giveBackPct: 0.9 })),
    });
    expect(r.conclusive).toBe(false);
    expect(r.supported).toBeNull();
    expect(r.method).toBe('not-decidable-from-journal');
    expect(r.reason).toContain('backtest');
  });

  it('has no validation method for an unknown kind, and says so', () => {
    const r = validateCandidate({
      kind: 'SOMETHING_ELSE',
      proposedValue: {},
      holdout: Array.from({ length: 20 }, () => trade()),
    });
    expect(r.conclusive).toBe(false);
    expect(r.reason).toContain('No validation method');
  });

  it('the give-back threshold is the documented one', () => {
    expect(HIGH_GIVE_BACK).toBe(0.5);
  });
});
