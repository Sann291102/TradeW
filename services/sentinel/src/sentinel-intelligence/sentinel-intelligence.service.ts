import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
import { StrategyIntelligenceService } from '../brain/strategy-intelligence.service';
import { CrossCheckService } from './synthesis/cross-check.service';
import { SynthesisService, resolvePattern } from './synthesis/synthesis.service';
import { RequestParserService } from './understanding/request-parser.service';
import { TaskDecomposerService } from './understanding/task-decomposer.service';
import { MarketWatchService } from './watch/market-watch.service';
import type {
  AgentVerdict,
  LivePerformanceCheck,
  ReasonRequest,
  ReasoningRun,
  Subtask,
} from './types';

/**
 * SentinelIntelligence — the master reasoning and orchestration engine.
 *
 * Runs strictly alongside `SentinelOrchestratorService`, which is untouched and
 * remains the production `/observe` path. Both compose the same deterministic
 * intelligence engines; they differ in what they do with the results.
 *
 *   Orchestrator          → one continuous session narrative, state machine,
 *                           timeline, LLM-polished prose, two surfacing gates.
 *   SentinelIntelligence  → one question at a time, understood and decomposed,
 *                           answered by ten named agents whose every claim
 *                           carries a citation, cross-checked for conflicts,
 *                           and surfaced only on corroborated ≥70% confidence
 *                           in a pattern with a live-market track record.
 *
 * A question no longer has to come from a trader. `MarketWatchService` asks one
 * whenever it sees a new setup form on a watched chart, over the snapshot it
 * already pulled — so noticing a setup and understanding it are no longer
 * separated by whether anyone happened to be at the screen. Identical pipeline
 * on both paths: same agents, same cross-check, same gate.
 *
 * The pipeline, in order:
 *
 *   understand → decompose → compute shared market state (once) → run agents
 *   → validate → cross-check and resolve conflicts → look up the pattern's live
 *   performance → synthesize → gate
 *
 * Market state is computed ONCE and shared. Ten agents each fetching their own
 * candles would multiply the data load by ten and, worse, could have agents
 * disagreeing because they read different ticks — a fake conflict the
 * cross-checker cannot distinguish from a real one.
 */
@Injectable()
export class SentinelIntelligenceService implements OnModuleInit {
  private readonly logger = new Logger(SentinelIntelligenceService.name);

  /** Newest background reasoning run per symbol. See `rememberRun`. */
  private readonly latestRuns = new Map<string, ReasoningRun>();

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
    private readonly strategyIntelligence: StrategyIntelligenceService,
    private readonly watch: MarketWatchService,
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
  async reason(request: ReasonRequest, opts: ReasonOptions = {}): Promise<ReasoningRun> {
    const runId = randomUUID();
    const startedAt = opts.at ?? new Date();

    // The corpus is the substrate for every citation. Building it lazily here
    // means the first request after a cold start pays for indexing rather than
    // silently reasoning against an empty knowledge base and producing verdicts
    // with no citations at all.
    await this.ensureCorpus();

    const understood = this.parser.parse(request, startedAt);
    const plan = this.decomposer.decompose(understood, request);

    // Asking about a symbol is what puts it under continuous watch. The
    // workspace endpoint routes through here too, so the watch list ends up
    // being exactly the charts traders have open on their board — and lapses
    // on its own once they close it.
    //
    // The background watcher passes `register: false`. If its own reasoning
    // re-registered the symbol, the TTL would be refreshed by the very loop
    // the TTL exists to stop, and a board would stay watched forever after the
    // trader closed it.
    if (opts.register !== false) this.watch.register(understood.market.symbol, startedAt);

    const shared =
      opts.sharedState ?? (await this.computeSharedState(understood.market.symbol, request, startedAt));
    const verdicts = await this.runAgents(plan.subtasks, understood, shared, request, startedAt);

    const crossCheckResult = this.crossCheck.check(verdicts, plan.subtasks);

    // The pattern has to be named before synthesis, because the gate needs its
    // live track record and the Brain lookup is async while the gate is not.
    const livePerformance = await this.livePerformanceFor(
      resolvePattern(verdicts, crossCheckResult),
    );

    const synthesisResult = this.synthesis.synthesize(understood, verdicts, crossCheckResult, {
      confidenceThreshold: request.confidenceThreshold,
      requiredCorroboration: request.requiredCorroboration,
      livePerformance,
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

  /**
   * Wire the continuous watch to this engine.
   *
   * A callback rather than an injected dependency, because the watch is
   * already a dependency of *this* service (for `register`) and injecting this
   * service back into the watch would be a DI cycle needing `forwardRef` — a
   * construct that fails at runtime, not compile time, whenever the graph is
   * later rearranged.
   */
  onModuleInit(): void {
    this.watch.setReasoner((symbol, snapshot, at) => this.reasonInBackground(symbol, snapshot, at));
  }

  /**
   * Reason about a symbol the watch just saw a new setup on, with no request
   * behind it.
   *
   * Runs the identical pipeline the request path runs — same agents, same
   * cross-check, same gate — over the snapshot the sweep already fetched. The
   * point of Phase 2 was that nobody was watching; the point of this is that
   * noticing a setup and understanding it should not be separated by whether a
   * trader happened to be at the screen.
   *
   * Returns null rather than reasoning when the corpus is not yet indexed.
   * `reason()` would otherwise trigger a 194-document ingest from inside a
   * timer callback, stalling the sweep behind heavy disk I/O. A real request
   * warms the corpus; the background path never pays that cost.
   */
  private async reasonInBackground(
    symbol: string,
    snapshot: MarketSnapshot | null,
    at: Date,
  ): Promise<ReasoningRun | null> {
    if (this.index.size === 0 || this.graph.size === 0) {
      this.logger.debug(`background reasoning skipped for ${symbol} — corpus not indexed yet`);
      return null;
    }

    // No trader behind this run, so no user id to attribute it to — the
    // constant names the watch itself rather than borrowing whichever trader
    // happened to put the symbol on the list. `recentTrades` and `account` are
    // absent by construction, so the emotion and risk agents see no personal
    // position data on this path; background reasoning is about the market,
    // never about somebody's book.
    const request: ReasonRequest = { query: `Observe ${symbol}`, symbol, userId: WATCH_USER_ID };
    try {
      const shared = await this.composeSharedState(symbol, snapshot, request, at);
      const run = await this.reason(request, { sharedState: shared, register: false, at });
      this.rememberRun(symbol, run);
      return run;
    } catch (err) {
      // A background run failing must never take the sweep — or the other
      // watched symbols — down with it.
      this.logger.warn(`background reasoning failed for ${symbol}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Keep the newest background run per symbol.
   *
   * Bounded by the watch's own symbol cap, and holding one run rather than a
   * history: this is "what does the engine currently make of this symbol",
   * not an audit log. Persisting every background run is a schema decision,
   * not a cache decision, and is deliberately not made here.
   */
  private rememberRun(symbol: string, run: ReasoningRun): void {
    this.latestRuns.set(symbol.toUpperCase(), run);
    for (const key of this.latestRuns.keys()) {
      if (this.latestRuns.size <= this.config.watchMaxSymbols) break;
      this.latestRuns.delete(key);
    }
  }

  /** The most recent background run for a symbol, if the watch has produced one. */
  latestRun(symbol: string): ReasoningRun | null {
    return this.latestRuns.get(symbol.toUpperCase()) ?? null;
  }

  /**
   * How many times this pattern has actually resolved in a live market.
   *
   * Reads the Brain's outcome-tagged occurrences — the same store the
   * orchestrator writes to on every triggered signal — so the two engines are
   * judged against one shared record of what has really happened, not two
   * separate tallies that could disagree.
   *
   * A lookup failure degrades to "no live record", which holds a directional
   * read back. Failing closed is the correct direction: a database outage must
   * not be the reason an unvalidated setup reaches a trader.
   */
  private async livePerformanceFor(pattern: string): Promise<LivePerformanceCheck> {
    try {
      const baseRate = await this.strategyIntelligence.baseRateFor(pattern);
      return { pattern, sample: baseRate.sample, reliable: baseRate.reliable };
    } catch (err) {
      this.logger.warn(
        `live-performance lookup failed for ${pattern} (treating as unproven): ${(err as Error).message}`,
      );
      return { pattern, sample: 0, reliable: false };
    }
  }

  /** Shared market state used by every agent in a run. */
  async computeSharedState(
    symbol: string,
    request: ReasonRequest,
    at: Date,
  ): Promise<SharedMarketState> {
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

    return this.composeSharedState(symbol, snapshot, request, at);
  }

  /**
   * Everything in a shared state except the snapshot fetch.
   *
   * Split out so the continuous watch can reason over the snapshot it has
   * *already* pulled. The snapshot is the only part that costs metered HTTP —
   * two Dhan `/candles` calls — so reusing it makes background reasoning
   * effectively free at the data layer, and stops the watcher and the reasoner
   * disagreeing because they read different ticks a second apart.
   */
  async composeSharedState(
    symbol: string,
    snapshot: MarketSnapshot | null,
    request: ReasonRequest,
    at: Date,
  ): Promise<SharedMarketState> {
    const trades = (request.recentTrades ?? []) as unknown as TradeSummary[];
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
        requireLivePerformance: this.config.requireLivePerformance,
      },
      watch: this.watch.status(),
    };
  }

  /** Force a corpus re-index. Incremental unless `force` is set. */
  reindex(force = false) {
    return this.corpus.ingest({ force });
  }
}

/** Attribution for runs the watch initiates, which have no trader behind them. */
export const WATCH_USER_ID = 'sentinel-watch';

export interface ReasonOptions {
  /**
   * Shared state the caller has already computed. Supplying it skips the
   * snapshot fetch — the only metered part of a run.
   */
  sharedState?: SharedMarketState;
  /**
   * Whether this run puts the symbol under continuous watch. Defaults to true;
   * the watch's own background runs pass false so they cannot refresh the TTL
   * that is supposed to retire them.
   */
  register?: boolean;
  /** Run timestamp, so a background run is stamped with its sweep time. */
  at?: Date;
}

export interface SharedMarketState {
  snapshot: MarketSnapshot | null;
  signals: Signal[];
  detections: StrategyDetection[];
  risk: RiskAssessment | null;
  trades: TradeSummary[];
}
