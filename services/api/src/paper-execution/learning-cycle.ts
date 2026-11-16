/**
 * The Daily Learning Cycle: what one session's executions support believing.
 *
 * Pure and dependency-free, like every other decision module here. It takes the
 * day's journal rows and rejections and produces three DIFFERENT things, which
 * are deliberately not the same thing and are never collapsed:
 *
 *   METRICS       what happened, counted.
 *   OBSERVATIONS  what the numbers support believing, each carrying its own
 *                 sample size. Inert — nothing reads these to make a decision.
 *   CANDIDATES    proposed changes. Also inert: they are rows an operator may
 *                 later promote, never changes that apply themselves.
 *
 * ## The two failure modes this is shaped to avoid
 *
 * 1. OVERFITTING TO A DAY. Every candidate carries a minimum sample and is
 *    generated from the ACCUMULATED bucket, not from today's handful. A single
 *    bad session can surface an observation; it can never on its own produce a
 *    candidate, because `MIN_SAMPLE` is checked against the bucket's lifetime
 *    trade count.
 *
 * 2. A FEEDBACK LOOP THAT LOOSENS RISK. `IMPROVEMENT_KINDS` is a closed set and
 *    every member is risk-neutral or risk-reducing. There is no member that
 *    widens a stop, increases size or exposure, lifts a loss limit or lowers a
 *    confidence floor — so the dangerous proposal is not merely rejected, it is
 *    UNREPRESENTABLE. That is the same technique that makes live money
 *    impossible upstream (`ExecutionEnvironment` has one member).
 */

/** Reuses the calibration sample floor rather than inventing a second one. */
export const MIN_SAMPLE = 8;

/** Average R at or below which a bucket is considered to be losing money. */
export const LOSING_BUCKET_R = -0.3;

/** Fraction of peak gain handed back, above which management is the suspect. */
export const HIGH_GIVE_BACK = 0.5;

/**
 * The closed set of changes learning may ever propose.
 *
 * Each is annotated with its risk direction, and the annotation is enforced by
 * `isRiskReducing` below — a new kind cannot be added without declaring one.
 */
export const IMPROVEMENT_KINDS = {
  /** Trade a strategy in a regime where it loses. Removes exposure. */
  STRATEGY_REGIME_DISABLE: 'STRATEGY_REGIME_DISABLE',
  /** Raise the confidence a setup must clear. Strictly fewer trades. */
  CONFIDENCE_FLOOR_RAISE: 'CONFIDENCE_FLOOR_RAISE',
  /** Ratchet protection sooner. Cannot widen a stop. */
  TRAIL_STEP_TIGHTEN: 'TRAIL_STEP_TIGHTEN',
} as const;

export type ImprovementKind = (typeof IMPROVEMENT_KINDS)[keyof typeof IMPROVEMENT_KINDS];

/**
 * Every kind's risk direction. A kind absent from this map is not proposable —
 * `isRiskReducing` returns false and the generator refuses to emit it.
 *
 * This is the structural guarantee behind "learning cannot bypass risk
 * controls": adding a loosening kind means adding it here as `false`, which
 * makes the refusal explicit and reviewable rather than accidental.
 */
const RISK_DIRECTION: Record<string, 'reduces' | 'neutral'> = {
  [IMPROVEMENT_KINDS.STRATEGY_REGIME_DISABLE]: 'reduces',
  [IMPROVEMENT_KINDS.CONFIDENCE_FLOOR_RAISE]: 'reduces',
  [IMPROVEMENT_KINDS.TRAIL_STEP_TIGHTEN]: 'neutral',
};

export function isRiskReducing(kind: string): boolean {
  return RISK_DIRECTION[kind] === 'reduces' || RISK_DIRECTION[kind] === 'neutral';
}

export interface JournalRecord {
  id: string;
  strategyId: string | null;
  strategyName: string | null;
  strategyVersion: string | null;
  regime: string | null;
  result: string;
  rMultiple: number | null;
  realizedPnl: number;
  exitReason: string;
  confidence: number;
  thesisCorrect: boolean | null;
  mfeR: number | null;
  maeR: number | null;
  entrySlippage: number | null;
  /** From `postTradeAnalysis.difference.giveBackPct`. */
  giveBackPct: number | null;
  holdingSeconds: number | null;
}

export interface RejectionRecord {
  checkId: string | null;
  label: string;
  count: number;
}

export interface BucketStat {
  key: string;
  strategyId: string | null;
  strategyName: string | null;
  regime: string | null;
  trades: number;
  wins: number;
  losses: number;
  avgR: number | null;
  totalPnl: number;
  thesisCorrectRate: number | null;
  avgGiveBack: number | null;
  avgMaeR: number | null;
}

export interface Observation {
  id: string;
  topic: 'strategy' | 'regime' | 'strategy-regime' | 'execution-quality' | 'rejections' | 'confidence';
  statement: string;
  sampleSize: number;
  /** False when the sample is too small to support a change, which most are. */
  actionable: boolean;
}

export interface CandidateImprovement {
  kind: ImprovementKind;
  bucketKey: string | null;
  currentValue: Record<string, unknown>;
  proposedValue: Record<string, unknown>;
  rationale: string;
  evidence: Record<string, unknown>;
}

export interface LearningCycleResult {
  tradesAnalysed: number;
  wins: number;
  losses: number;
  rejectedSetups: number;
  metrics: {
    totalPnl: number;
    avgR: number | null;
    winRate: number | null;
    byStrategy: BucketStat[];
    byRegime: BucketStat[];
    byStrategyRegime: BucketStat[];
    executionQuality: {
      avgEntrySlippage: number | null;
      avgGiveBack: number | null;
      avgMaeR: number | null;
      thesisCorrectRate: number | null;
    };
    rejections: RejectionRecord[];
  };
  observations: Observation[];
  candidates: CandidateImprovement[];
  report: string;
}

/**
 * Run the cycle.
 *
 * `today` is the session's own trades — what the report describes. `history` is
 * every trade the buckets have ever seen, and is what CANDIDATES are generated
 * from. Passing today's rows as history is what "overfitting to one session"
 * literally is, so the two are separate parameters rather than one list with a
 * date filter applied inside.
 */
export function runLearningCycle(args: {
  sessionDate: string;
  agent: string;
  today: JournalRecord[];
  history: JournalRecord[];
  rejections: RejectionRecord[];
  /** Current profile settings, so a candidate can state what it would change FROM. */
  current: { minConfidence: number; trailStepPoints: number; strategyIds: string[] };
}): LearningCycleResult {
  const { today, history, rejections, current } = args;

  const wins = today.filter((t) => t.result === 'WIN').length;
  const losses = today.filter((t) => t.result === 'LOSS').length;
  const totalPnl = round2(today.reduce((s, t) => s + t.realizedPnl, 0));
  const decided = wins + losses;

  const byStrategy = bucketBy(today, (t) => t.strategyId ?? 'unknown');
  const byRegime = bucketBy(today, (t) => t.regime ?? 'unknown');
  const byStrategyRegime = bucketBy(today, (t) => `${t.strategyId ?? 'unknown'}::${t.regime ?? 'unknown'}`);

  const metrics: LearningCycleResult['metrics'] = {
    totalPnl,
    avgR: mean(today.map((t) => t.rMultiple)),
    winRate: decided > 0 ? round3(wins / decided) : null,
    byStrategy,
    byRegime,
    byStrategyRegime,
    executionQuality: {
      avgEntrySlippage: mean(today.map((t) => t.entrySlippage)),
      avgGiveBack: mean(today.map((t) => t.giveBackPct)),
      avgMaeR: mean(today.map((t) => t.maeR)),
      thesisCorrectRate: rateOf(today.map((t) => t.thesisCorrect)),
    },
    rejections,
  };

  const observations = observe({ today, history, metrics, rejections });
  // Candidates come from HISTORY, never from `today` — see the doc comment.
  const candidates = propose({ history, current });

  return {
    tradesAnalysed: today.length,
    wins,
    losses,
    rejectedSetups: rejections.reduce((s, r) => s + r.count, 0),
    metrics,
    observations,
    candidates,
    report: renderReport({ ...args, metrics, observations, candidates, wins, losses, totalPnl }),
  };
}

function observe(args: {
  today: JournalRecord[];
  history: JournalRecord[];
  metrics: LearningCycleResult['metrics'];
  rejections: RejectionRecord[];
}): Observation[] {
  const { today, history, metrics, rejections } = args;
  const out: Observation[] = [];

  if (today.length === 0) {
    out.push({
      id: 'no-trades',
      topic: 'strategy',
      statement:
        'No trades completed this session. A session with nothing to act on is a normal outcome and supports no conclusion about the strategies.',
      sampleSize: 0,
      actionable: false,
    });
  }

  // The central question: which strategy works in which regime. Reported from
  // HISTORY, because one session's three trades cannot answer it.
  for (const bucket of bucketBy(history, (t) => `${t.strategyId ?? 'unknown'}::${t.regime ?? 'unknown'}`)) {
    if (bucket.trades === 0) continue;
    out.push({
      id: `strategy-regime:${bucket.key}`,
      topic: 'strategy-regime',
      statement:
        `${bucket.strategyName ?? bucket.strategyId ?? 'unknown strategy'} in a ${bucket.regime ?? 'unknown'} regime: ` +
        `${bucket.trades} trade(s), ${bucket.wins}W/${bucket.losses}L, average ${fmtR(bucket.avgR)}` +
        (bucket.thesisCorrectRate != null ? `, thesis confirmed on ${pct(bucket.thesisCorrectRate)} of them` : '') +
        (bucket.trades < MIN_SAMPLE ? ` — below the ${MIN_SAMPLE}-trade floor, so this is a reading, not a conclusion.` : '.'),
      sampleSize: bucket.trades,
      actionable: bucket.trades >= MIN_SAMPLE,
    });
  }

  // Management vs selection, in aggregate.
  const giveBack = metrics.executionQuality.avgGiveBack;
  if (giveBack != null && today.length > 0) {
    out.push({
      id: 'execution-give-back',
      topic: 'execution-quality',
      statement:
        `On average ${pct(giveBack)} of peak unrealised gain was not realised` +
        (giveBack >= HIGH_GIVE_BACK
          ? ' — high enough that exits, rather than entries, are the more likely constraint on results.'
          : ' — exits are capturing most of what the entries produced.'),
      sampleSize: today.length,
      actionable: today.length >= MIN_SAMPLE,
    });
  }

  const slip = metrics.executionQuality.avgEntrySlippage;
  if (slip != null && today.length > 0) {
    out.push({
      id: 'execution-slippage',
      topic: 'execution-quality',
      statement: `Entries filled on average ${slip >= 0 ? `${slip.toFixed(2)} points worse` : `${Math.abs(slip).toFixed(2)} points better`} than the fill model predicted.`,
      sampleSize: today.length,
      actionable: false,
    });
  }

  const thesisRate = metrics.executionQuality.thesisCorrectRate;
  if (thesisRate != null) {
    out.push({
      id: 'thesis-rate',
      topic: 'confidence',
      statement:
        `The market confirmed the read on ${pct(thesisRate)} of measurable trades ` +
        `(favourable excursion reached a full risk unit), independent of whether they finished profitable.`,
      sampleSize: today.filter((t) => t.thesisCorrect != null).length,
      actionable: false,
    });
  }

  // Why nothing traded is as much a finding as what did.
  const topRejection = [...rejections].sort((a, b) => b.count - a.count)[0];
  if (topRejection && topRejection.count > 0) {
    out.push({
      id: 'top-rejection',
      topic: 'rejections',
      statement: `The commonest refusal was "${topRejection.label}" (${topRejection.count}×).`,
      sampleSize: topRejection.count,
      actionable: false,
    });
  }

  return out;
}

/**
 * Generate candidates from ACCUMULATED history.
 *
 * Every candidate is checked against `isRiskReducing` before it is emitted —
 * belt and braces, since the closed `IMPROVEMENT_KINDS` set already makes a
 * loosening proposal unrepresentable.
 */
function propose(args: {
  history: JournalRecord[];
  current: { minConfidence: number; trailStepPoints: number; strategyIds: string[] };
}): CandidateImprovement[] {
  const { history, current } = args;
  const out: CandidateImprovement[] = [];

  // ---- 1. A strategy that loses money in a regime --------------------------
  for (const bucket of bucketBy(history, (t) => `${t.strategyId ?? 'unknown'}::${t.regime ?? 'unknown'}`)) {
    if (bucket.trades < MIN_SAMPLE) continue;
    if (bucket.avgR == null || bucket.avgR > LOSING_BUCKET_R) continue;
    if (!bucket.strategyId || !bucket.regime) continue;

    out.push({
      kind: IMPROVEMENT_KINDS.STRATEGY_REGIME_DISABLE,
      bucketKey: bucket.key,
      currentValue: { strategyIds: current.strategyIds, regime: bucket.regime },
      proposedValue: {
        strategyId: bucket.strategyId,
        regime: bucket.regime,
        action: 'stop trading this strategy while this regime is in force',
      },
      rationale:
        `${bucket.strategyName ?? bucket.strategyId} has averaged ${fmtR(bucket.avgR)} over ${bucket.trades} trades ` +
        `in a ${bucket.regime} regime (${bucket.wins}W/${bucket.losses}L, ${fmtInr(bucket.totalPnl)}). ` +
        `Removing that pairing reduces exposure and takes no new risk.`,
      evidence: {
        trades: bucket.trades, wins: bucket.wins, losses: bucket.losses,
        avgR: bucket.avgR, totalPnl: bucket.totalPnl,
        thesisCorrectRate: bucket.thesisCorrectRate,
        sampleFloor: MIN_SAMPLE,
      },
    });
  }

  // ---- 2. Confidence is not discriminating ---------------------------------
  //
  // Only proposable UPWARD. The comparison is between trades above and below
  // the current floor + 5; if the lower band loses and the upper band does not,
  // the floor is in the wrong place.
  const decided = history.filter((t) => t.rMultiple != null);
  if (decided.length >= MIN_SAMPLE * 2) {
    const band = current.minConfidence + 5;
    const lower = decided.filter((t) => t.confidence < band);
    const upper = decided.filter((t) => t.confidence >= band);
    const lowerR = mean(lower.map((t) => t.rMultiple));
    const upperR = mean(upper.map((t) => t.rMultiple));
    if (
      lower.length >= MIN_SAMPLE && upper.length >= MIN_SAMPLE &&
      lowerR != null && upperR != null && lowerR <= LOSING_BUCKET_R && upperR > lowerR
    ) {
      out.push({
        kind: IMPROVEMENT_KINDS.CONFIDENCE_FLOOR_RAISE,
        bucketKey: null,
        currentValue: { minConfidence: current.minConfidence },
        proposedValue: { minConfidence: band },
        rationale:
          `Trades below ${band}% confidence averaged ${fmtR(lowerR)} over ${lower.length}, while trades at or above it ` +
          `averaged ${fmtR(upperR)} over ${upper.length}. Raising the floor to ${band}% removes the losing band and ` +
          `strictly reduces the number of positions taken.`,
        evidence: {
          band, lowerTrades: lower.length, lowerAvgR: lowerR,
          upperTrades: upper.length, upperAvgR: upperR, sampleFloor: MIN_SAMPLE,
        },
      });
    }
  }

  // ---- 3. Winners are handing back their gains -----------------------------
  const peaked = history.filter((t) => t.giveBackPct != null && (t.mfeR ?? 0) >= 1);
  const avgGiveBack = mean(peaked.map((t) => t.giveBackPct));
  if (peaked.length >= MIN_SAMPLE && avgGiveBack != null && avgGiveBack >= HIGH_GIVE_BACK && current.trailStepPoints > 1) {
    const proposed = round2(Math.max(1, current.trailStepPoints * 0.66));
    if (proposed < current.trailStepPoints) {
      out.push({
        kind: IMPROVEMENT_KINDS.TRAIL_STEP_TIGHTEN,
        bucketKey: null,
        currentValue: { trailStepPoints: current.trailStepPoints },
        proposedValue: { trailStepPoints: proposed },
        rationale:
          `Across ${peaked.length} trades that reached at least 1R in their favour, ${pct(avgGiveBack)} of the peak ` +
          `was given back on average. A ${proposed}-point trail step ratchets protection sooner. It cannot widen the ` +
          `initial stop and so takes no additional risk.`,
        evidence: {
          tradesConsidered: peaked.length, avgGiveBackPct: avgGiveBack,
          fromStep: current.trailStepPoints, toStep: proposed, sampleFloor: MIN_SAMPLE,
        },
      });
    }
  }

  // The closed set already makes a loosening proposal unrepresentable; this is
  // the second, explicit refusal, so a future kind added without a declared
  // risk direction cannot reach the table.
  return out.filter((c) => isRiskReducing(c.kind));
}

function renderReport(args: {
  sessionDate: string;
  agent: string;
  metrics: LearningCycleResult['metrics'];
  observations: Observation[];
  candidates: CandidateImprovement[];
  wins: number;
  losses: number;
  totalPnl: number;
  today: JournalRecord[];
}): string {
  const { sessionDate, agent, metrics, observations, candidates, wins, losses, totalPnl, today } = args;
  const lines: string[] = [
    `Daily learning cycle — ${agent}, ${sessionDate}`,
    '',
    `Trades: ${today.length} (${wins}W / ${losses}L)   P&L: ${fmtInr(totalPnl)}   Average: ${fmtR(metrics.avgR)}`,
  ];

  if (metrics.byStrategyRegime.length > 0) {
    lines.push('', 'By strategy and regime:');
    for (const b of metrics.byStrategyRegime) {
      lines.push(`  • ${b.strategyName ?? b.strategyId} / ${b.regime}: ${b.trades} trade(s), ${fmtR(b.avgR)}, ${fmtInr(b.totalPnl)}`);
    }
  }

  const eq = metrics.executionQuality;
  lines.push(
    '',
    'Execution quality:',
    `  • entry slippage ${eq.avgEntrySlippage == null ? 'not measured' : `${eq.avgEntrySlippage.toFixed(2)} pts`}`,
    `  • gave back ${eq.avgGiveBack == null ? 'not measured' : pct(eq.avgGiveBack)} of peak gain`,
    `  • adverse excursion ${eq.avgMaeR == null ? 'not measured' : fmtR(eq.avgMaeR)}`,
    `  • thesis confirmed ${eq.thesisCorrectRate == null ? 'not measured' : pct(eq.thesisCorrectRate)}`,
  );

  if (metrics.rejections.length > 0) {
    lines.push('', 'Why nothing else traded:');
    for (const r of [...metrics.rejections].sort((a, b) => b.count - a.count).slice(0, 5)) {
      lines.push(`  • ${r.label}: ${r.count}`);
    }
  }

  lines.push('', 'Observations:');
  for (const o of observations) {
    lines.push(`  • ${o.statement}${o.actionable ? '' : ' [not actionable]'}`);
  }

  lines.push('', `Candidate improvements: ${candidates.length}`);
  for (const c of candidates) {
    lines.push(`  • [${c.kind}] ${c.rationale}`);
  }
  if (candidates.length > 0) {
    lines.push(
      '',
      'No candidate has changed anything. Each is a proposal requiring historical validation and an operator’s promotion.',
    );
  }

  return lines.join('\n');
}

// ---- helpers --------------------------------------------------------------

function bucketBy(rows: JournalRecord[], key: (t: JournalRecord) => string): BucketStat[] {
  const groups = new Map<string, JournalRecord[]>();
  for (const row of rows) {
    const k = key(row);
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  return [...groups.entries()].map(([k, rs]) => ({
    key: k,
    strategyId: rs[0].strategyId,
    strategyName: rs[0].strategyName,
    regime: rs[0].regime,
    trades: rs.length,
    wins: rs.filter((r) => r.result === 'WIN').length,
    losses: rs.filter((r) => r.result === 'LOSS').length,
    avgR: mean(rs.map((r) => r.rMultiple)),
    totalPnl: round2(rs.reduce((s, r) => s + r.realizedPnl, 0)),
    thesisCorrectRate: rateOf(rs.map((r) => r.thesisCorrect)),
    avgGiveBack: mean(rs.map((r) => r.giveBackPct)),
    avgMaeR: mean(rs.map((r) => r.maeR)),
  }));
}

/** Mean of the values that exist. Null when none do — never 0. */
function mean(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (present.length === 0) return null;
  return round3(present.reduce((s, v) => s + v, 0) / present.length);
}

/** Rate of `true` among the DECIDED values, ignoring nulls. Null when none. */
function rateOf(values: (boolean | null)[]): number | null {
  const present = values.filter((v): v is boolean => v != null);
  if (present.length === 0) return null;
  return round3(present.filter(Boolean).length / present.length);
}

function fmtR(r: number | null): string {
  return r == null ? 'no measurable R' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
}

function fmtInr(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
