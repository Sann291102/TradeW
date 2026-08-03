import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { RiskAssessment, Signal, TradeSummary } from '../domain';
import { EmotionIntelligenceService } from '../intelligence/emotion-intelligence.service';
import { MarketIntelligenceService, type MarketSnapshot } from '../intelligence/market-intelligence.service';
import { NewsIntelligenceService } from '../intelligence/news-intelligence.service';
import { RiskIntelligenceService } from '../intelligence/risk-intelligence.service';
import { StrategyEngineService, type StrategyDetection } from '../intelligence/strategy-engine.service';
import { TrapIntelligenceService } from '../intelligence/trap-intelligence.service';
import { AgentRegistryService } from './agents/agent-registry.service';
import type { AgentContext } from './agents/agent.contract';
import { CorpusIngestionService } from './knowledge/corpus-ingestion.service';
import { KnowledgeIndexService } from './knowledge/knowledge-index.service';
import { ReasoningGraphService } from './knowledge/reasoning-graph.service';
import { SI_CONFIG, SentinelIntelligenceConfig } from './si.config';
import { CrossCheckService } from './synthesis/cross-check.service';
import { SynthesisService } from './synthesis/synthesis.service';
import { RequestParserService } from './understanding/request-parser.service';
import { TaskDecomposerService } from './understanding/task-decomposer.service';
import type { AgentVerdict, ReasonRequest, ReasoningRun, Subtask } from './types';

/**
 * SentinelIntelligence — the master reasoning and orchestration engine.
 *
 * Runs strictly alongside `SentinelOrchestratorService`, which is untouched and
 * remains the production `/observe` path. Both compose the same deterministic
 * intelligence engines; they differ in what they do with the results.
 *
 *   Orchestrator          → one continuous session narrative, state machine,
 *                           timeline, LLM-polished prose, two surfacing gates.
 *   SentinelIntelligence  → one request at a time, understood and decomposed,
 *                           answered by ten named agents whose every claim
 *                           carries a citation, cross-checked for conflicts,
 *                           and surfaced only on corroborated ≥70% confidence.
 *
 * The pipeline, in order:
 *
 *   understand → decompose → compute shared market state (once) → run agents
 *   → validate → cross-check and resolve conflicts → synthesize → gate
 *
 * Market state is computed ONCE and shared. Ten agents each fetching their own
 * candles would multiply the data load by ten and, worse, could have agents
 * disagreeing because they read different ticks — a fake conflict the
 * cross-checker cannot distinguish from a real one.
 */
@Injectable()
export class SentinelIntelligenceService {
  private readonly logger = new Logger(SentinelIntelligenceService.name);

  constructor(
    @Inject(SI_CONFIG) private readonly config: SentinelIntelligenceConfig,
    private readonly parser: RequestParserService,
    private readonly decomposer: TaskDecomposerService,
    private readonly registry: AgentRegistryService,
    private readonly crossCheck: CrossCheckService,
    private readonly synthesis: SynthesisService,
    private readonly corpus: CorpusIngestionService,
    private readonly index: KnowledgeIndexService,
    private readonly graph: ReasoningGraphService,
    private readonly market: MarketIntelligenceService,
    private readonly strategies: StrategyEngineService,
    private readonly traps: TrapIntelligenceService,
    private readonly emotion: EmotionIntelligenceService,
    private readonly news: NewsIntelligenceService,
    private readonly risk: RiskIntelligenceService,
  ) {}

  /**
   * Answer one request.
   *
   * Always returns a full `ReasoningRun`, including when nothing is surfaced.
   * The run IS the product: the plan, every verdict, every citation, every
   * conflict and the reason for silence are all inspectable. A caller that
   * only wants the conclusion reads `synthesis.observation`; a caller
   * auditing the reasoning has everything it needs without a second call.
   */
  async reason(request: ReasonRequest): Promise<ReasoningRun> {
    const runId = randomUUID();
    const startedAt = new Date();

    // The corpus is the substrate for every citation. Building it lazily here
    // means the first request after a cold start pays for indexing rather than
    // silently reasoning against an empty knowledge base and producing verdicts
    // with no citations at all.
    await this.ensureCorpus();

    const understood = this.parser.parse(request, startedAt);
    const plan = this.decomposer.decompose(understood, request);

    const shared = await this.computeSharedState(understood.market.symbol, request, startedAt);
    const verdicts = await this.runAgents(plan.subtasks, understood, shared, request, startedAt);

    const crossCheckResult = this.crossCheck.check(verdicts, plan.subtasks);
    const synthesisResult = this.synthesis.synthesize(understood, verdicts, crossCheckResult, {
      confidenceThreshold: request.confidenceThreshold,
      requiredCorroboration: request.requiredCorroboration,
    });

    const finishedAt = new Date();
    this.logger.log(
      `run ${runId.slice(0, 8)} ${understood.market.symbol}/${understood.timeframe} ` +
        `intent=${understood.intent} agents=${verdicts.length} ` +
        `abstained=${verdicts.filter((v) => v.abstained).length} conflicts=${crossCheckResult.conflicts.length} ` +
        `confidence=${(synthesisResult.confidence * 100).toFixed(0)}% surfaced=${synthesisResult.surfaced} ` +
        `in ${finishedAt.getTime() - startedAt.getTime()}ms`,
    );

    return {
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      understood,
      plan,
      verdicts,
      synthesis: synthesisResult,
      corpus: this.corpus.corpusState(),
    };
  }

  /** Shared market state used by every agent in a run. */
  async computeSharedState(
    symbol: string,
    request: ReasonRequest,
    at: Date,
  ): Promise<SharedMarketState> {
    const trades = (request.recentTrades ?? []) as unknown as TradeSummary[];

    let snapshot: MarketSnapshot | null = null;
    try {
      snapshot = await this.market.snapshot(symbol);
    } catch (err) {
      // A data outage degrades every agent to an abstention with a stated
      // reason, which is a materially better outcome than failing the request:
      // the emotion agent, for one, needs no market data at all and can still
      // answer.
      this.logger.warn(`market data unavailable for ${symbol} (agents will abstain): ${(err as Error).message}`);
    }

    const signals: Signal[] = [];
    let detections: StrategyDetection[] = [];
    let riskAssessment: RiskAssessment | null = null;

    if (snapshot) {
      signals.push(...this.market.signals(snapshot));
      signals.push(...this.traps.signals(snapshot, trades));
      detections = this.strategies.scan(snapshot, at);
      riskAssessment = this.risk.assess(snapshot, signals, request.account, at);
      signals.push(...this.risk.signals(riskAssessment));
    }

    if (trades.length > 0) signals.push(...this.emotion.signals(trades));

    // News reaches the network, so a failure there must not take the run down.
    try {
      signals.push(...(await this.news.signals(symbol)));
    } catch (err) {
      this.logger.warn(`news signals unavailable (non-fatal): ${(err as Error).message}`);
    }

    return { snapshot, signals, detections, risk: riskAssessment, trades };
  }

  /**
   * Run the plan.
   *
   * Everything except compliance runs concurrently — the agents are pure
   * functions over shared state with no ordering dependency between them, and
   * `dependsOn` in the plan documents which verdict informs which for a reader
   * rather than forcing serial execution.
   *
   * Compliance is the exception and genuinely must run last: it audits the
   * text the other nine produced.
   */
  private async runAgents(
    subtasks: Subtask[],
    understood: ReasoningRun['understood'],
    shared: SharedMarketState,
    request: ReasonRequest,
    at: Date,
  ): Promise<AgentVerdict[]> {
    const build = (subtask: Subtask): AgentContext => ({
      understood,
      subtask,
      snapshot: shared.snapshot,
      signals: shared.signals,
      detections: shared.detections,
      risk: shared.risk,
      trades: request.recentTrades ?? [],
      account: request.account,
      index: this.index,
      graph: this.graph,
      at,
    });

    const complianceTasks = subtasks.filter((s) => s.agent === 'compliance-intelligence');
    const otherTasks = subtasks.filter((s) => s.agent !== 'compliance-intelligence');

    const verdicts = await Promise.all(otherTasks.map((subtask) => this.registry.run(build(subtask))));

    for (const subtask of complianceTasks) {
      const auditable = verdicts
        .filter((v) => !v.abstained)
        .flatMap((v) => [v.headline, ...v.evidence.map((e) => e.statement)]);
      this.registry.complianceAgent.withText(auditable);
      verdicts.push(await this.registry.run(build(subtask)));
    }

    return verdicts;
  }

  /** Index the corpus if it has not been built yet. */
  private async ensureCorpus(): Promise<void> {
    if (this.index.size > 0 && this.graph.size > 0) return;
    try {
      await this.corpus.ingest();
    } catch (err) {
      // Reasoning continues without citations rather than failing outright.
      // Agents that need corpus support will report weak grounding, which the
      // confidence blend already accounts for.
      this.logger.error(`corpus ingestion failed; reasoning will proceed with weak grounding: ${(err as Error).message}`);
      if (this.graph.size === 0) {
        try {
          this.graph.build();
        } catch {
          /* the ontology is optional too — verdicts simply carry no concepts */
        }
      }
    }
  }

  /** Corpus and roster status, for the operator endpoint. */
  status() {
    return {
      corpus: this.corpus.corpusState(),
      index: this.index.stats(),
      graph: this.graph.stats(),
      agents: this.registry.roster(),
      gates: {
        confidenceThreshold: this.config.confidenceThreshold,
        requiredCorroboration: this.config.requiredCorroboration,
      },
    };
  }

  /** Force a corpus re-index. Incremental unless `force` is set. */
  reindex(force = false) {
    return this.corpus.ingest({ force });
  }
}

export interface SharedMarketState {
  snapshot: MarketSnapshot | null;
  signals: Signal[];
  detections: StrategyDetection[];
  risk: RiskAssessment | null;
  trades: TradeSummary[];
}
