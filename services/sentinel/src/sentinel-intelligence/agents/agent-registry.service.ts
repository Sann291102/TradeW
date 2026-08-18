import { Injectable, Logger } from '@nestjs/common';
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

  async run(context: AgentContext): Promise<AgentVerdict> {
    const agent = this.agents.get(context.subtask.agent);
    if (!agent) {
      return abstention(context, `No agent is registered for id "${context.subtask.agent}".`);
    }
    try {
      return await agent.reason(context);
    } catch (err) {
      this.logger.error(`agent ${agent.id} threw during ${context.subtask.id}: ${(err as Error).message}`);
      return abstention(context, `The agent failed while reasoning: ${(err as Error).message}`);
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
  };
}
