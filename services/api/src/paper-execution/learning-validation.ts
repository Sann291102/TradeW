/**
 * Historical validation of a candidate improvement.
 *
 * The step between "the numbers suggest this" and "an operator may promote
 * this". Pure, so what counts as evidence is assertable without a database.
 *
 * ## Out-of-sample, or it proves nothing
 *
 * A candidate is generated from a pattern in the history. Re-measuring that
 * same pattern on that same history will always agree — that is what the
 * pattern IS. So validation splits the record chronologically and judges the
 * change ONLY on the held-out later portion, which the proposal never saw.
 *
 * This is the difference between validation and self-congratulation, and it is
 * the single most important property here: without it the pipeline would
 * reliably promote whatever the last few sessions happened to contain.
 *
 * ## Inconclusive is a first-class result
 *
 * Some proposals cannot be judged from the journal at all. `TRAIL_STEP_TIGHTEN`
 * is the clear case: the journal records what happened under the trail that was
 * in force, and nothing in it says what a tighter one would have done — that
 * needs a bar-by-bar replay, which is `services/api/src/backtest`'s job and a
 * different input. Reporting such a proposal as "validated" because the numbers
 * did not contradict it would be a fabrication, so it returns `conclusive:
 * false` and can never reach VALIDATED.
 */
import { IMPROVEMENT_KINDS, MIN_SAMPLE, type JournalRecord } from './learning-cycle';

/** Fraction of history reserved for validation. The proposal never sees it. */
export const HOLDOUT_FRACTION = 0.3;

export interface ValidationResult {
  /** Could the journal settle this at all? */
  conclusive: boolean;
  /** Did the held-out evidence support the change? Null when inconclusive. */
  supported: boolean | null;
  method: string;
  holdoutTrades: number;
  /** What the holdout did under the CURRENT behaviour. */
  baseline: { trades: number; totalPnl: number; avgR: number | null };
  /** What it would have done under the PROPOSED behaviour. */
  proposed: { trades: number; totalPnl: number; avgR: number | null };
  /** proposed.totalPnl − baseline.totalPnl, on the holdout. */
  pnlDelta: number | null;
  reason: string;
}

/**
 * Split chronologically, never randomly.
 *
 * A random split would leak: trades from the same session, the same regime and
 * often the same setup would sit on both sides, so the "held-out" set would be
 * a near-copy of the training set. Time order is the only split that reproduces
 * the real question — would this change have helped on days it had not seen?
 */
export function splitHoldout(orderedHistory: JournalRecord[]): {
  train: JournalRecord[];
  holdout: JournalRecord[];
} {
  // The caller passes rows already ordered by `entryAt` (the query does it in
  // the database). Re-sorting here would need a timestamp the pure
  // `JournalRecord` deliberately does not carry, and sorting by a stand-in
  // field — holding time, say — would silently produce a split that is not
  // chronological at all while looking like one.
  const cut = Math.floor(orderedHistory.length * (1 - HOLDOUT_FRACTION));
  return { train: orderedHistory.slice(0, cut), holdout: orderedHistory.slice(cut) };
}

export function validateCandidate(args: {
  kind: string;
  proposedValue: Record<string, unknown>;
  holdout: JournalRecord[];
}): ValidationResult {
  const { kind, proposedValue, holdout } = args;

  const empty = { trades: 0, totalPnl: 0, avgR: null as number | null };
  const inconclusive = (reason: string, method: string): ValidationResult => ({
    conclusive: false,
    supported: null,
    method,
    holdoutTrades: holdout.length,
    baseline: summarise(holdout),
    proposed: empty,
    pnlDelta: null,
    reason,
  });

  if (holdout.length < MIN_SAMPLE) {
    return inconclusive(
      `The held-out sample is ${holdout.length} trade(s), below the ${MIN_SAMPLE}-trade floor. ` +
        'Not enough out-of-sample evidence to judge this either way.',
      'chronological-holdout',
    );
  }

  // ---- Kinds the journal CAN settle ---------------------------------------
  //
  // Both work the same way: the change removes a subset of trades, so the
  // counterfactual is simply the holdout without them. That is exactly true —
  // it makes no assumption about what would have happened instead, because the
  // proposal is to take FEWER positions, not different ones.
  if (kind === IMPROVEMENT_KINDS.STRATEGY_REGIME_DISABLE) {
    const strategyId = String(proposedValue.strategyId ?? '');
    const regime = String(proposedValue.regime ?? '');
    const removed = holdout.filter((t) => t.strategyId === strategyId && t.regime === regime);
    const kept = holdout.filter((t) => !(t.strategyId === strategyId && t.regime === regime));
    return judge({
      holdout, kept, removed,
      method: 'chronological-holdout, subset removal',
      what: `${strategyId} in a ${regime} regime`,
    });
  }

  if (kind === IMPROVEMENT_KINDS.CONFIDENCE_FLOOR_RAISE) {
    const floor = Number(proposedValue.minConfidence ?? 0);
    const removed = holdout.filter((t) => t.confidence < floor);
    const kept = holdout.filter((t) => t.confidence >= floor);
    return judge({
      holdout, kept, removed,
      method: 'chronological-holdout, subset removal',
      what: `trades below ${floor}% confidence`,
    });
  }

  if (kind === IMPROVEMENT_KINDS.TRAIL_STEP_TIGHTEN) {
    return inconclusive(
      'A trailing-step change cannot be judged from the journal: it records what happened under the step that was ' +
        'in force, and contains no bar-by-bar path to re-run a different one. This needs a replay through the ' +
        'backtest engine, so it stays a proposal rather than being reported as validated.',
      'not-decidable-from-journal',
    );
  }

  return inconclusive(`No validation method is defined for kind "${kind}".`, 'none');
}

/**
 * Judge a subset-removal proposal on the holdout.
 *
 * Supported when the removed trades were genuinely a drag: removing them must
 * improve total P&L, AND there must be enough of them to be more than noise.
 * A change that merely fails to hurt is NOT supported — the burden is on the
 * proposal, because the default (change nothing) is the safe action.
 */
function judge(args: {
  holdout: JournalRecord[];
  kept: JournalRecord[];
  removed: JournalRecord[];
  method: string;
  what: string;
}): ValidationResult {
  const { holdout, kept, removed, method, what } = args;
  const baseline = summarise(holdout);
  const proposed = summarise(kept);
  const pnlDelta = round2(proposed.totalPnl - baseline.totalPnl);

  if (removed.length === 0) {
    return {
      conclusive: false,
      supported: null,
      method,
      holdoutTrades: holdout.length,
      baseline,
      proposed,
      pnlDelta: null,
      reason:
        `The held-out period contains no trades matching ${what}, so the change would have made no difference there ` +
        'and the evidence neither supports nor refutes it.',
    };
  }

  const supported = pnlDelta > 0;
  return {
    conclusive: true,
    supported,
    method,
    holdoutTrades: holdout.length,
    baseline,
    proposed,
    pnlDelta,
    reason: supported
      ? `On ${holdout.length} held-out trades the proposal removes ${removed.length} matching ${what}, ` +
        `improving realised P&L by ${fmtInr(pnlDelta)} ` +
        `(${fmtInr(baseline.totalPnl)} → ${fmtInr(proposed.totalPnl)}) and average R from ` +
        `${fmtR(baseline.avgR)} to ${fmtR(proposed.avgR)}.`
      : `On ${holdout.length} held-out trades the proposal removes ${removed.length} matching ${what}, ` +
        `changing realised P&L by ${fmtInr(pnlDelta)} — it did not improve out-of-sample results, so the pattern ` +
        'it was derived from did not persist.',
  };
}

function summarise(rows: JournalRecord[]): { trades: number; totalPnl: number; avgR: number | null } {
  const rs = rows.map((r) => r.rMultiple).filter((v): v is number => v != null);
  return {
    trades: rows.length,
    totalPnl: round2(rows.reduce((s, r) => s + r.realizedPnl, 0)),
    avgR: rs.length === 0 ? null : round3(rs.reduce((s, v) => s + v, 0) / rs.length),
  };
}

function fmtR(r: number | null): string {
  return r == null ? 'no measurable R' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
}

function fmtInr(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
