import { describe, expect, it } from 'vitest';
import { CrossCheckService } from './cross-check.service';
import { SynthesisService } from './synthesis.service';
import { loadSentinelIntelligenceConfig } from '../si.config';
import type { ReasoningGraphService } from '../knowledge/reasoning-graph.service';
import type {
  AgentId,
  AgentVerdict,
  KnowledgeCitation,
  Stance,
  Subtask,
  UnderstoodRequest,
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
  opts: { sources?: string[]; dataQuality?: number; abstained?: boolean } = {},
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
  };
}

function subtask(agent: AgentId, weight = 1): Subtask {
  return {
    id: `${agent}#1`,
    agent,
    question: 'q',
    rationale: 'r',
    knowledgeQueries: [],
    dependsOn: [],
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

function run(verdicts: AgentVerdict[], subtasks: Subtask[]) {
  const crossCheck = new CrossCheckService(graphStub);
  const synthesis = new SynthesisService(config);
  const checked = crossCheck.check(verdicts, subtasks);
  return { checked, result: synthesis.synthesize(understood, verdicts, checked) };
}

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
    const result = synthesis.synthesize(understood, verdicts, checked, { confidenceThreshold: 0.5 });

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
