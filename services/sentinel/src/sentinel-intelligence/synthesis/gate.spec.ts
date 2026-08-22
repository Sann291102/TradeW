import { describe, expect, it } from 'vitest';
import { CrossCheckService } from './cross-check.service';
import { SynthesisService } from './synthesis.service';
import { loadSentinelIntelligenceConfig } from '../si.config';
import type { ReasoningGraphService } from '../knowledge/reasoning-graph.service';
import type {
  AgentId,
  AgentVerdict,
  KnowledgeCitation,
  LivePerformanceCheck,
  Stance,
  Subtask,
  UnderstoodRequest,
  VerdictVeto,
} from '../types';

/**
 * The surfacing gate is the single most important behavioural guarantee in
 * this module: SentinelIntelligence must stay silent unless the evidence is
 * both strong AND corroborated. These tests pin that from both sides — what
 * must be surfaced, and what must not be.
 *
 * Everything is constructed directly. No Nest container, no database, no
 * network: the gate is pure decision logic over verdicts and must remain
 * verifiable without any of that.
 */

const config = loadSentinelIntelligenceConfig({});

/** A graph stub — these tests do not exercise ontology-level contradictions. */
const graphStub = { tensionsAmong: () => [] } as unknown as ReasoningGraphService;

function citation(sourceId: string, relevance = 0.8): KnowledgeCitation {
  return {
    chunkId: `${sourceId}:0`,
    sourceId,
    sourceTitle: `Book ${sourceId}`,
    sourcePath: `docs/Trading Books/${sourceId}.pdf`,
    sourceKind: 'book',
    locator: 'ch. 1',
    charStart: 0,
    charEnd: 100,
    quote: 'A supporting passage from the corpus.',
    relevance,
  };
}

function verdict(
  agent: AgentId,
  stance: Stance,
  confidence: number,
  opts: { sources?: string[]; dataQuality?: number; abstained?: boolean; veto?: VerdictVeto } = {},
): AgentVerdict {
  const citations = (opts.sources ?? ['alpha', 'beta']).map((s) => citation(s));
  return {
    agent,
    subtaskId: `${agent}#1`,
    stance,
    confidence,
    headline: `${agent} reads ${stance}`,
    evidence: [
      { statement: `${agent} measured something`, kind: 'measured', value: 1, citations: [], strength: 0.8 },
      { statement: `${agent} cites the corpus`, kind: 'knowledge', value: null, citations, strength: 0.7 },
    ],
    supportingConcepts: [],
    citations,
    abstained: opts.abstained ?? false,
    abstentionReason: null,
    dataQuality: opts.dataQuality ?? 1,
    latencyMs: 1,
    veto: opts.veto ?? null,
  };
}

function subtask(agent: AgentId, weight = 1): Subtask {
  return {
    id: `${agent}#1`,
    agent,
    question: 'q',
    rationale: 'r',
    knowledgeQueries: [],
    informedBy: [],
    weight,
  };
}

const understood: UnderstoodRequest = {
  rawText: 'what is NIFTY doing',
  market: { symbol: 'NIFTY', name: 'Nifty 50', kind: 'index', hasOptionChain: true, strikeStep: 50 },
  strike: null,
  right: null,
  expiry: null,
  expiryPhrase: null,
  timeframe: '15m',
  strategyIds: [],
  indicators: [],
  style: 'intraday',
  riskProfile: 'balanced',
  intent: 'market-read',
  assumptions: [],
  parseConfidence: 0.5,
};

/**
 * A pattern with enough live-market history to clear the live-performance
 * gate. Supplied by default so each test exercises the one gate it is about;
 * the live-performance tests below pass their own.
 */
const PROVEN: LivePerformanceCheck = { pattern: 'proven_pattern', sample: 12, reliable: true };

function run(
  verdicts: AgentVerdict[],
  subtasks: Subtask[],
  livePerformance: LivePerformanceCheck | null = PROVEN,
) {
  const crossCheck = new CrossCheckService(graphStub);
  const synthesis = new SynthesisService(config);
  const checked = crossCheck.check(verdicts, subtasks);
  return { checked, result: synthesis.synthesize(understood, verdicts, checked, { livePerformance }) };
}

describe('gate 0 — the compliance veto', () => {
  const RESIDUAL: VerdictVeto = {
    code: 'residual-directive-language',
    reason: '2 agent statement(s) still contained directive language after vocabulary enforcement',
  };

  it('withholds a run that would otherwise clear every other gate', () => {
    const verdicts = [
      verdict('market-intelligence', 'bullish', 0.92),
      verdict('strategy-intelligence', 'bullish', 0.9),
      verdict('trap-intelligence', 'bullish', 0.88),
      verdict('compliance-intelligence', 'risk-elevated', 0.9, { veto: RESIDUAL }),
    ];
    const { result } = run(verdicts, [
      subtask('market-intelligence'),
      subtask('strategy-intelligence'),
      subtask('trap-intelligence'),
      // The weight the compliance agent actually carries on every intent. The
      // point of the veto is that this number is irrelevant to the outcome.
      subtask('compliance-intelligence', 0.2),
    ]);

    expect(result.surfaced).toBe(false);
    expect(result.observation).toBeNull();
    expect(result.silenceReason).toMatch(/compliance finding/);
    expect(result.silenceReason).toContain(RESIDUAL.reason);
  });

  it('is checked before corroboration and confidence, so the silence reason names compliance', () => {
    // One agent only: this run also fails gate 1. The veto must still be the
    // reason reported, because it is the one an operator has to act on.
    const verdicts = [
      verdict('market-intelligence', 'bullish', 0.4),
      verdict('compliance-intelligence', 'risk-elevated', 0.9, { veto: RESIDUAL }),
    ];
    const { result } = run(verdicts, [subtask('market-intelligence'), subtask('compliance-intelligence', 0.2)]);

    expect(result.surfaced).toBe(false);
    expect(result.silenceReason).toMatch(/compliance finding/);
    expect(result.silenceReason).not.toMatch(/corroborating agents are required/);
  });

  it('ignores a veto on an abstaining verdict — a dispatch failure is not a finding', () => {
    const verdicts = [
      verdict('market-intelligence', 'bullish', 0.86),
      verdict('strategy-intelligence', 'bullish', 0.82),
      { ...verdict('compliance-intelligence', 'no-read', 0, { abstained: true, veto: RESIDUAL }), evidence: [] },
    ];
    const { result } = run(verdicts, [
      subtask('market-intelligence'),
      subtask('strategy-intelligence'),
      subtask('compliance-intelligence', 0.2),
    ]);

    expect(result.surfaced).toBe(true);
  });

  it('surfaces normally when compliance found nothing to enforce', () => {
    const verdicts = [
      verdict('market-intelligence', 'bullish', 0.86),
      verdict('strategy-intelligence', 'bullish', 0.82),
      verdict('compliance-intelligence', 'neutral', 0.8),
    ];
    const { result } = run(verdicts, [
      subtask('market-intelligence'),
      subtask('strategy-intelligence'),
      subtask('compliance-intelligence', 0.2),
    ]);

    expect(result.surfaced).toBe(true);
    expect(result.silenceReason).toBeNull();
  });
});

describe('the surfacing gate', () => {
  it('surfaces when two agents agree above the threshold', () => {
    const verdicts = [
      verdict('market-intelligence', 'bullish', 0.86),
      verdict('strategy-intelligence', 'bullish', 0.82),
    ];
    const { result } = run(verdicts, [subtask('market-intelligence'), subtask('strategy-intelligence')]);

    expect(result.surfaced).toBe(true);
    expect(result.observation).not.toBeNull();
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.corroboratingAgents).toBe(2);
    expect(result.silenceReason).toBeNull();
  });

  it('stays silent for one very confident agent — confidence never substitutes for corroboration', () => {
    const verdicts = [verdict('market-intelligence', 'bullish', 0.99)];
    const { result } = run(verdicts, [subtask('market-intelligence')]);

    expect(result.surfaced).toBe(false);
    expect(result.observation).toBeNull();
    expect(result.silenceReason).toMatch(/corroborating agents are required/);
  });

  it('stays silent when two agents agree but below the threshold', () => {
    const verdicts = [
      verdict('market-intelligence', 'bullish', 0.5),
      verdict('strategy-intelligence', 'bullish', 0.48),
    ];
    const { result } = run(verdicts, [subtask('market-intelligence'), subtask('strategy-intelligence')]);

    expect(result.surfaced).toBe(false);
    expect(result.silenceReason).toMatch(/below the 70% threshold/);
  });

  it('never counts an abstaining agent toward corroboration', () => {
    const verdicts = [
      verdict('market-intelligence', 'bullish', 0.9),
      { ...verdict('strategy-intelligence', 'no-read', 0, { abstained: true }), evidence: [] },
    ];
    const { result } = run(verdicts, [subtask('market-intelligence'), subtask('strategy-intelligence')]);

    expect(result.corroboratingAgents).toBe(1);
    expect(result.surfaced).toBe(false);
  });

  it('stays silent when the corroborated reading is that nothing is happening', () => {
    const verdicts = [
      verdict('market-intelligence', 'neutral', 0.9),
      verdict('strategy-intelligence', 'neutral', 0.88),
    ];
    const { result } = run(verdicts, [subtask('market-intelligence'), subtask('strategy-intelligence')]);

    expect(result.surfaced).toBe(false);
    expect(result.silenceReason).toMatch(/nothing worth surfacing/);
  });

  it('honours an explicit threshold override', () => {
    const verdicts = [
      verdict('market-intelligence', 'bullish', 0.55),
      verdict('strategy-intelligence', 'bullish', 0.52),
    ];
    const crossCheck = new CrossCheckService(graphStub);
    const synthesis = new SynthesisService(config);
    const checked = crossCheck.check(verdicts, [subtask('market-intelligence'), subtask('strategy-intelligence')]);
    const result = synthesis.synthesize(understood, verdicts, checked, {
      confidenceThreshold: 0.5,
      livePerformance: PROVEN,
    });

    expect(result.threshold).toBe(0.5);
    expect(result.surfaced).toBe(true);
  });

  it('surfaces a corroborated risk warning even with no directional read', () => {
    const verdicts = [
      verdict('trap-intelligence', 'risk-elevated', 0.85),
      verdict('risk-intelligence', 'risk-elevated', 0.82),
    ];
    const { result } = run(verdicts, [subtask('trap-intelligence'), subtask('risk-intelligence')]);

    expect(result.leadingStance).toBe('risk-elevated');
    expect(result.surfaced).toBe(true);
    expect(result.observation?.status).toBe('Risk awareness');
  });

  it('never emits directive language in the surfaced observation', () => {
    const verdicts = [
      verdict('market-intelligence', 'bullish', 0.9),
      verdict('strategy-intelligence', 'bullish', 0.88),
    ];
    const { result } = run(verdicts, [subtask('market-intelligence'), subtask('strategy-intelligence')]);

    expect(result.observation).not.toBeNull();
    expect(result.observation!.content).not.toMatch(/\b(buy|sell|short|stop[- ]?loss|target)\b/i);
    expect(result.observation!.content).toMatch(/not advice/i);
  });
});

/**
 * The live-performance gate. Confidence measures agreement among agents
 * reading the book corpus; it says nothing about whether that corpus is right
 * about this instrument. Only live outcomes say that, so a directional read
 * waits for them — and a safety warning does not.
 */
describe('the live-performance gate', () => {
  const directional = () => [
    verdict('market-intelligence', 'bullish', 0.92),
    verdict('strategy-intelligence', 'bullish', 0.9),
  ];
  const directionalSubtasks = () => [subtask('market-intelligence'), subtask('strategy-intelligence')];

  it('stays silent on a corroborated, high-confidence read with no live track record', () => {
    const { result } = run(directional(), directionalSubtasks(), {
      pattern: 'untested_pattern',
      sample: 0,
      reliable: false,
    });

    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.corroboratingAgents).toBe(2);
    expect(result.surfaced).toBe(false);
    expect(result.observation).toBeNull();
    expect(result.silenceReason).toMatch(/0 outcome-tagged occurrences/);
  });

  it('stays silent when live occurrences exist but are too few to be reliable', () => {
    const { result } = run(directional(), directionalSubtasks(), {
      pattern: 'thin_pattern',
      sample: 3,
      reliable: false,
    });

    expect(result.surfaced).toBe(false);
    expect(result.silenceReason).toMatch(/3 outcome-tagged occurrences/);
  });

  it('stays silent when the live-performance lookup produced nothing at all', () => {
    const { result } = run(directional(), directionalSubtasks(), null);

    expect(result.surfaced).toBe(false);
    expect(result.silenceReason).toMatch(/live-market memory/);
  });

  it('surfaces once the pattern has a reliable live track record', () => {
    const { result } = run(directional(), directionalSubtasks(), {
      pattern: 'proven_pattern',
      sample: 20,
      reliable: true,
    });

    expect(result.surfaced).toBe(true);
    expect(result.observation).not.toBeNull();
  });

  it('never withholds a corroborated risk warning for lack of a track record', () => {
    const { result } = run(
      [verdict('trap-intelligence', 'risk-elevated', 0.85), verdict('risk-intelligence', 'risk-elevated', 0.82)],
      [subtask('trap-intelligence'), subtask('risk-intelligence')],
      { pattern: 'unseen_trap', sample: 0, reliable: false },
    );

    expect(result.surfaced).toBe(true);
    expect(result.observation?.status).toBe('Risk awareness');
  });

  it('names the binding gate — corroboration still reported before live performance', () => {
    const { result } = run(
      [verdict('market-intelligence', 'bullish', 0.99)],
      [subtask('market-intelligence')],
      { pattern: 'untested_pattern', sample: 0, reliable: false },
    );

    expect(result.silenceReason).toMatch(/corroborating agents are required/);
  });

  it('records the live-performance check on every run, surfaced or not', () => {
    const proven = run(directional(), directionalSubtasks(), PROVEN);
    const unproven = run(directional(), directionalSubtasks(), {
      pattern: 'untested_pattern',
      sample: 1,
      reliable: false,
    });

    expect(proven.result.livePerformance).toEqual(PROVEN);
    expect(unproven.result.livePerformance?.sample).toBe(1);
    expect(unproven.result.livePerformance?.reliable).toBe(false);
  });

  it('can be disabled for a cold database without touching the other gates', () => {
    const crossCheck = new CrossCheckService(graphStub);
    const synthesis = new SynthesisService(
      loadSentinelIntelligenceConfig({ SI_REQUIRE_LIVE_PERFORMANCE: 'false' }),
    );
    const verdicts = directional();
    const checked = crossCheck.check(verdicts, directionalSubtasks());
    const result = synthesis.synthesize(understood, verdicts, checked, {
      livePerformance: { pattern: 'untested_pattern', sample: 0, reliable: false },
    });

    expect(result.surfaced).toBe(true);
  });

  it('stays on when the env toggle is absent or malformed', () => {
    expect(loadSentinelIntelligenceConfig({}).requireLivePerformance).toBe(true);
    expect(loadSentinelIntelligenceConfig({ SI_REQUIRE_LIVE_PERFORMANCE: 'no' }).requireLivePerformance).toBe(true);
    expect(loadSentinelIntelligenceConfig({ SI_REQUIRE_LIVE_PERFORMANCE: '' }).requireLivePerformance).toBe(true);
  });
});

describe('cross-checking', () => {
  it('forces neutrality when a directional split is close', () => {
    const verdicts = [
      verdict('market-intelligence', 'bullish', 0.85),
      verdict('strategy-intelligence', 'bearish', 0.83),
    ];
    const { checked, result } = run(verdicts, [subtask('market-intelligence'), subtask('strategy-intelligence')]);

    const conflict = checked.conflicts.find((c) => c.kind === 'directional');
    expect(conflict).toBeDefined();
    expect(conflict!.favoured).toBeNull();
    expect(conflict!.resolution).toMatch(/Unresolved/);
    expect(result.surfaced).toBe(false);
  });

  it('resolves a decisive directional split toward the heavier side', () => {
    const verdicts = [
      verdict('market-intelligence', 'bullish', 0.9),
      verdict('strategy-intelligence', 'bullish', 0.88),
      verdict('news-intelligence', 'bearish', 0.3, { dataQuality: 0.4 }),
    ];
    const { checked } = run(verdicts, [
      subtask('market-intelligence'),
      subtask('strategy-intelligence'),
      subtask('news-intelligence', 0.5),
    ]);

    const conflict = checked.conflicts.find((c) => c.kind === 'directional');
    expect(conflict?.favoured).toBe('market-intelligence');
    expect(checked.leadingStance).toBe('bullish');
  });

  it('does not treat a risk warning as disagreement with a directional read', () => {
    const verdicts = [
      verdict('market-intelligence', 'bullish', 0.88),
      verdict('strategy-intelligence', 'bullish', 0.85),
      verdict('risk-intelligence', 'risk-elevated', 0.8),
    ];
    const { checked } = run(verdicts, [
      subtask('market-intelligence'),
      subtask('strategy-intelligence'),
      subtask('risk-intelligence'),
    ]);

    expect(checked.conflicts.find((c) => c.kind === 'directional')).toBeUndefined();
  });

  it('rejects a knowledge claim carrying no citation', () => {
    const bad = verdict('market-intelligence', 'bullish', 0.9);
    bad.evidence = [
      { statement: 'the books say this is bullish', kind: 'knowledge', value: null, citations: [], strength: 0.9 },
    ];
    const { checked } = run([bad, verdict('strategy-intelligence', 'bullish', 0.9)], [
      subtask('market-intelligence'),
      subtask('strategy-intelligence'),
    ]);

    expect(checked.validationFailures.some((f) => f.rule === 'citation-required')).toBe(true);
    // The malformed verdict is dropped, not merely flagged.
    expect(checked.accepted.some((v) => v.agent === 'market-intelligence')).toBe(false);
  });

  it('rejects a non-abstaining verdict with no evidence', () => {
    const bad = verdict('market-intelligence', 'bullish', 0.9);
    bad.evidence = [];
    const { checked } = run([bad], [subtask('market-intelligence')]);

    expect(checked.validationFailures.some((f) => f.rule === 'evidence-required')).toBe(true);
  });

  it('rejects an abstention that still carries confidence', () => {
    const bad = verdict('market-intelligence', 'no-read', 0.6, { abstained: true });
    const { checked } = run([bad], [subtask('market-intelligence')]);

    expect(checked.validationFailures.some((f) => f.rule === 'abstention-confidence')).toBe(true);
  });

  it('weights a low-data-quality agent below a well-informed one', () => {
    const verdicts = [
      verdict('market-intelligence', 'bullish', 0.8, { dataQuality: 1 }),
      verdict('strategy-intelligence', 'bullish', 0.8, { dataQuality: 0.3 }),
    ];
    const { checked } = run(verdicts, [subtask('market-intelligence'), subtask('strategy-intelligence')]);

    const market = checked.corroboration.find((c) => c.agent === 'market-intelligence')!;
    const strategy = checked.corroboration.find((c) => c.agent === 'strategy-intelligence')!;
    expect(market.effectiveWeight).toBeGreaterThan(strategy.effectiveWeight);
  });
});
