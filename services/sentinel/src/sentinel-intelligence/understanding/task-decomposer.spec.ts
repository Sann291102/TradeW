import { describe, expect, it } from 'vitest';
import { TaskDecomposerService } from './task-decomposer.service';
import { ALL_AGENT_IDS, type AgentId, type ReasonRequest, type UnderstoodRequest } from '../types';
import { understood as baseUnderstood, trades } from '../agents/fixtures';

/**
 * The router.
 *
 * It decides which of the ten agents are asked anything at all, and how much
 * each one's answer counts. Two properties matter enough to pin, and both are
 * about the same failure: an agent must never be asked a question it has no
 * data to answer, because a confident "nothing wrong" from an empty input reads
 * as an all-clear when it means "no data".
 *
 *  1. **Skips are explicit and carry a reason.** A skipped agent is absent from
 *     the plan AND present in `skipped` with a human-readable why.
 *  2. **Compliance and learning always run**, whatever the question.
 *
 * Pure over an `UnderstoodRequest` — no container, no data.
 */

const decomposer = new TaskDecomposerService();

function plan(over: Partial<UnderstoodRequest> = {}, request: Partial<ReasonRequest> = {}) {
  const u = baseUnderstood(over);
  return decomposer.decompose(u, { query: u.rawText, userId: 'u1', ...request } as ReasonRequest);
}

const agentsIn = (p: ReturnType<typeof plan>) => p.subtasks.map((s) => s.agent);

describe('task decomposition', () => {
  it('routes to every agent when the request has everything', () => {
    const p = plan({}, { recentTrades: trades() as never });

    expect([...new Set(agentsIn(p))].sort()).toEqual([...ALL_AGENT_IDS].sort());
    expect(p.skipped).toHaveLength(0);
  });

  it('gives every subtask a unique id, so verdicts cannot collide', () => {
    const p = plan({}, { recentTrades: trades() as never });
    const ids = p.subtasks.map((s) => s.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('skips emotion — with a reason — when no trades were supplied', () => {
    const p = plan({}, { recentTrades: [] });

    expect(agentsIn(p)).not.toContain('emotion-intelligence');
    const skip = p.skipped.find((s) => s.agent === 'emotion-intelligence');
    expect(skip).toBeDefined();
    // The reason states the failure mode, not just the absence — this is the
    // line that stops a reader treating silence as an all-clear.
    expect(skip!.reason).toMatch(/all-clear|missing data/i);
  });

  it('skips the option chain — with a reason — for an instrument that has none', () => {
    const p = plan({
      market: { symbol: 'RELIANCE', name: 'Reliance', kind: 'stock', hasOptionChain: false, strikeStep: null },
    } as Partial<UnderstoodRequest>);

    expect(agentsIn(p)).not.toContain('options-chain-intelligence');
    expect(p.skipped.find((s) => s.agent === 'options-chain-intelligence')!.reason).toMatch(
      /no listed option chain/,
    );
  });

  it('never both routes to and skips the same agent', () => {
    const p = plan({}, { recentTrades: [] });
    for (const skip of p.skipped) expect(agentsIn(p)).not.toContain(skip.agent);
  });

  it('always runs compliance and learning, whatever the intent', () => {
    const intents: UnderstoodRequest['intent'][] = [
      'market-read',
      'strategy-check',
      'option-context',
      'risk-review',
      'behaviour-review',
      'visual-workspace',
      'explain',
      'unknown',
    ];

    for (const intent of intents) {
      const agents = agentsIn(plan({ intent }));
      expect(agents, intent).toContain('compliance-intelligence');
      expect(agents, intent).toContain('learning-intelligence');
    }
  });

  it('puts compliance last, because it audits what the others produced', () => {
    const p = plan({}, { recentTrades: trades() as never });
    expect(p.subtasks[p.subtasks.length - 1].agent).toBe('compliance-intelligence');
  });

  it('weights by intent rather than by a fixed hierarchy', () => {
    const weightOf = (intent: UnderstoodRequest['intent'], agent: AgentId) =>
      plan({ intent }).subtasks.find((s) => s.agent === agent)!.weight;

    // The chain agent leads an options question and trails a behaviour review.
    expect(weightOf('option-context', 'options-chain-intelligence')).toBeGreaterThan(
      weightOf('behaviour-review', 'options-chain-intelligence'),
    );
    // And risk leads a risk review over a plain market read.
    expect(weightOf('risk-review', 'risk-intelligence')).toBeGreaterThan(
      weightOf('market-read', 'risk-intelligence'),
    );
  });

  it('keeps every weight inside the unit interval', () => {
    const p = plan({}, { recentTrades: trades() as never });
    for (const s of p.subtasks) {
      expect(s.weight).toBeGreaterThan(0);
      expect(s.weight).toBeLessThanOrEqual(1);
    }
  });

  it('gives every subtask retrieval hints and a stated rationale', () => {
    const p = plan({}, { recentTrades: trades() as never });
    for (const s of p.subtasks) {
      expect(s.knowledgeQueries.length, s.agent).toBeGreaterThan(0);
      expect(s.rationale.length, s.agent).toBeGreaterThan(0);
      expect(s.question.length, s.agent).toBeGreaterThan(0);
    }
  });

  it('carries informedBy as reference only — every id it names exists in the plan', () => {
    // The field documents which verdict informs which; it is NOT an execution
    // DAG and nothing orders agents by it. What must hold is that it does not
    // dangle, or the plan would describe a relationship to a subtask that was
    // never created.
    const p = plan({}, { recentTrades: trades() as never });
    const ids = new Set(p.subtasks.map((s) => s.id));

    for (const s of p.subtasks) {
      for (const ref of s.informedBy) expect(ids, `${s.agent} -> ${ref}`).toContain(ref);
    }
  });

  it('names the requested strategies in the strategy subtask', () => {
    const p = plan({ strategyIds: ['orb-retest', 'ema-cross'] });
    const strategy = p.subtasks.find((s) => s.agent === 'strategy-intelligence')!;

    expect(strategy.question).toContain('orb-retest');
    expect(strategy.rationale).toMatch(/named specific strategies/);
  });

  it('falls back to a handbook scan when no strategy was named', () => {
    const strategy = plan({ strategyIds: [] }).subtasks.find((s) => s.agent === 'strategy-intelligence')!;

    expect(strategy.question).toMatch(/Which learned strategies/);
    expect(strategy.rationale).toMatch(/No strategy was named/);
  });

  it('falls back to market-read weights for an unrecognised intent', () => {
    const rogue = plan({ intent: 'not-a-real-intent' as UnderstoodRequest['intent'] });
    const marketRead = plan({ intent: 'market-read' });

    const weightIn = (p: ReturnType<typeof plan>, agent: AgentId) =>
      p.subtasks.find((s) => s.agent === agent)!.weight;

    expect(weightIn(rogue, 'market-intelligence')).toBe(weightIn(marketRead, 'market-intelligence'));
  });
});
