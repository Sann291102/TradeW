import { Injectable, Logger } from '@nestjs/common';
import { trackAgent } from '@tradew/ai-core';
import { ComplianceIntelligenceAgent } from './compliance-intelligence.agent';
import { EmotionIntelligenceAgent } from './emotion-intelligence.agent';
import { HistoricalPatternIntelligenceAgent } from './historical-pattern-intelligence.agent';
import { LearningIntelligenceAgent } from './learning-intelligence.agent';
import { MarketIntelligenceAgent } from './market-intelligence.agent';
import { NewsIntelligenceAgent } from './news-intelligence.agent';
import { OptionsChainIntelligenceAgent } from './options-chain-intelligence.agent';
import { RiskIntelligenceAgent } from './risk-intelligence.agent';
import { StrategyIntelligenceAgent } from './strategy-intelligence.agent';
import { TrapIntelligenceAgent } from './trap-intelligence.agent';
import type { AgentContext, IntelligenceAgent } from './agent.contract';
import type { AgentId, AgentVerdict } from '../types';

/**
 * Routes subtasks to agents and guarantees a verdict for every one.
 *
 * An agent that throws produces an abstention rather than failing the run. The
 * alternative — one bad agent aborting the whole observation — would make the
 * system strictly less reliable than its weakest component, and an abstention
 * is already a first-class result that carries zero weight and is visible in
 * the audit trail. The error text is preserved in the abstention reason so a
 * genuine bug is diagnosable rather than silently swallowed.
 */
@Injectable()
export class AgentRegistryService {
  private readonly logger = new Logger(AgentRegistryService.name);
  private readonly agents: Map<AgentId, IntelligenceAgent>;

  constructor(
    market: MarketIntelligenceAgent,
    strategy: StrategyIntelligenceAgent,
    news: NewsIntelligenceAgent,
    options: OptionsChainIntelligenceAgent,
    risk: RiskIntelligenceAgent,
    emotion: EmotionIntelligenceAgent,
    trap: TrapIntelligenceAgent,
    historical: HistoricalPatternIntelligenceAgent,
    private readonly compliance: ComplianceIntelligenceAgent,
    learning: LearningIntelligenceAgent,
  ) {
    this.agents = new Map<AgentId, IntelligenceAgent>([
      [market.id, market],
      [strategy.id, strategy],
      [news.id, news],
      [options.id, options],
      [risk.id, risk],
      [emotion.id, emotion],
      [trap.id, trap],
      [historical.id, historical],
      [compliance.id, compliance],
      [learning.id, learning],
    ]);
  }

  get(id: AgentId): IntelligenceAgent | null {
    return this.agents.get(id) ?? null;
  }

  /** The compliance agent, which needs prior output injected before it runs. */
  get complianceAgent(): ComplianceIntelligenceAgent {
    return this.compliance;
  }

  /** Remit lines for every registered agent — surfaced on the status endpoint. */
  roster(): { id: AgentId; remit: string }[] {
    return [...this.agents.values()].map((a) => ({ id: a.id, remit: a.remit }));
  }

  /**
   * Dispatch one subtask, instrumented.
   *
   * `trackAgent` emits `thinking` on entry and `sending`/`error` on the way
   * out, under the agent's own id — the same id the admin portal draws a node
   * for. Without this the nine agents that run autonomously every sweep
   * produced no activity row at all, so the orbit showed the `/observe`
   * engines and nothing else, and a silently broken background agent was
   * indistinguishable from an idle one.
   *
   * The emit is a no-op outside a run: `emitAgentActivity` drops any event
   * with no ambient runId rather than writing a row with nothing to belong to.
   * So a unit test constructing a registry by hand pays one null check, and a
   * real run — which `SentinelIntelligenceService.reason` wraps in
   * `runAgentRun` — gets a correlated row per agent.
   *
   * Note the ordering against the throw path below: `trackAgent` rethrows, so
   * the `error` transition is emitted BEFORE the abstention is built. An agent
   * that fails is visible as a failure in the portal even though the run
   * survives it.
   */
  async run(context: AgentContext): Promise<AgentVerdict> {
    const agent = this.agents.get(context.subtask.agent);
    if (!agent) {
      return abstention(context, `No agent is registered for id "${context.subtask.agent}".`);
    }
    try {
      return await trackAgent(agent.id, async () => agent.reason(context), {
        detail: context.subtask.question.slice(0, 120),
      });
    } catch (err) {
      this.logger.error(`agent ${agent.id} threw during ${context.subtask.id}: ${(err as Error).message}`);
      return abstention(context, `The agent failed while reasoning: ${(err as Error).message}`);
    }
  }

  /**
   * Give one agent its single round of reply, having seen its peers.
   *
   * Returns null — meaning "keep the first-pass verdict" — in every case where
   * a revision is not clearly better than what the agent already said:
   *
   *   · the agent implements no `deliberate` hook;
   *   · the hook threw. A crash in a SECOND look must never lose the first
   *     one. This is the difference between deliberation being additive and
   *     deliberation being a new way for a run to get worse;
   *   · the hook tried to raise its confidence in a DIRECTIONAL stance. See
   *     rule 3 on `IntelligenceAgent.deliberate`: the synthesis already
   *     rewards corroboration on the directional axis, so an agent that also
   *     rewarded it internally would have the same agreement counted twice,
   *     and a desk that talks itself into a direction is precisely what a
   *     reasoning network must not be.
   *
   *     `risk-elevated` is deliberately exempt, because it is not on that
   *     axis and is not counted toward corroboration (ADR — see
   *     `CrossCheckService`'s header). An agent that learns from a peer that
   *     the environment is more dangerous than it could see alone SHOULD say
   *     so with more confidence, not less; that is the whole point of a desk
   *     conferring, and suppressing it would leave the one finding worth
   *     escalating as the one finding deliberation could not raise.
   *
   * Peers are the other agents' verdicts only. An agent never sees its own
   * first pass here — it already has it, and handing it back invites an agent
   * to reason about its own output rather than about its inputs.
   */
  async deliberate(
    context: AgentContext,
    peers: readonly AgentVerdict[],
    first: AgentVerdict,
  ): Promise<AgentVerdict | null> {
    const agent = this.agents.get(context.subtask.agent);
    if (!agent?.deliberate) return null;
    try {
      const revised = await trackAgent(agent.id, async () => agent.deliberate!(context, peers), {
        detail: `deliberation over ${peers.length} peer verdict(s)`,
      });
      const directional = revised.stance === 'bullish' || revised.stance === 'bearish';
      if (directional && revised.confidence > first.confidence) {
        this.logger.warn(
          `agent ${agent.id} raised its own confidence in a directional stance during deliberation ` +
            `(${first.confidence.toFixed(2)} → ${revised.confidence.toFixed(2)}); keeping the first-pass verdict.`,
        );
        return null;
      }
      return revised;
    } catch (err) {
      this.logger.error(`agent ${agent.id} threw while deliberating: ${(err as Error).message}`);
      return null;
    }
  }
}

function abstention(context: AgentContext, reason: string): AgentVerdict {
  return {
    agent: context.subtask.agent,
    subtaskId: context.subtask.id,
    stance: 'no-read',
    confidence: 0,
    headline: reason,
    evidence: [],
    supportingConcepts: [],
    citations: [],
    abstained: true,
    abstentionReason: reason,
    dataQuality: 0,
    latencyMs: 0,
    // An agent that could not run found nothing to enforce. A dispatch failure
    // must not be able to masquerade as a compliance veto.
    veto: null,
  };
}
