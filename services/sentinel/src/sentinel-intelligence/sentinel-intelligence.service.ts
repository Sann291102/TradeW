import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { runAgentRun } from '@tradew/ai-core';
import type { RiskAssessment, Signal, TradeSummary } from '../domain';
import { EmotionIntelligenceService } from '../intelligence/emotion-intelligence.service';
import { MarketIntelligenceService, type MarketSnapshot } from '../intelligence/market-intelligence.service';
import { NewsIntelligenceService } from '../intelligence/news-intelligence.service';
import { RiskIntelligenceService } from '../intelligence/risk-intelligence.service';
import { StrategyEngineService, type StrategyDetection } from '../intelligence/strategy-engine.service';
import { TrapIntelligenceService } from '../intelligence/trap-intelligence.service';
import {
  readOptionPositioning,
  type OptionPositioningRead,
} from '../execution/option-positioning';
import { AgentRegistryService } from './agents/agent-registry.service';
import type { AgentContext, LiveBaseRate } from './agents/agent.contract';
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
export class SentinelIntelligenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SentinelIntelligenceService.name);

  /** Newest background reasoning run per symbol. See `rememberRun`. */
  private readonly latestRuns = new Map<string, ReasoningRun>();

  /** Deferred boot warm-up. See `scheduleCorpusWarmup`. */
  private warmupTimer: NodeJS.Timeout | null = null;

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
    // Telemetry wrapper around the real pipeline, split out for the same
    // reason the orchestrator splits `observe` from `runObservation`: the
    // instrumentation stays one readable block rather than a `runAgentRun(`
    // that opens at the top of a long method and closes off-screen.
    //
    // This is what makes the ten agents visible. `runAgentRun` opens the
    // AgentRun row and establishes the ambient correlation context that every
    // `trackAgent` call inside `AgentRegistryService.run` inherits — without a
    // run here, those emits have no runId and are dropped by design, which is
    // exactly why the agents produced no telemetry before.
    //
    // `trigger` distinguishes the two ways a run starts, because they answer
    // different operational questions: 'watch' runs prove the autonomous loop
    // is alive, 'reason' runs prove the request path is. Collapsing them would
    // make a dead watch loop invisible behind healthy request traffic.
    //
    // The run id comes FROM `runAgentRun` rather than being minted here, so
    // `ReasoningRun.runId` and the `AgentRun` row are the same identifier. A
    // caller holding a reasoning run can look up its telemetry by primary key
    // instead of searching by timestamp.
    let run!: ReasoningRun;
    await runAgentRun(
      {
        system: 'sentinel',
        trigger: opts.register === false ? 'watch' : 'reason',
        symbol: request.symbol ?? 'NIFTY',
        userId: request.userId,
      },
      async (runId) => {
        run = await this.runReasoning(request, opts, runId);
        return {
          // Reported, never assumed: silence is the designed outcome here, and
          // an operator has to be able to tell a run that stayed quiet from a
          // run that failed.
          surfaced: run.synthesis.surfaced,
          confidence: run.synthesis.confidence,
        };
      },
    );
    return run;
  }

  private async runReasoning(
    request: ReasonRequest,
    opts: ReasonOptions,
    runId: string,
  ): Promise<ReasoningRun> {
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
    this.scheduleCorpusWarmup();
  }

  onModuleDestroy(): void {
    if (this.warmupTimer) clearTimeout(this.warmupTimer);
    this.warmupTimer = null;
  }

  /**
   * Put a symbol under continuous watch for an observation that did not come
   * through `reason()`.
   *
   * `/observe` is the path apps actually call, and it never touched the watch
   * list. The only production caller of `register()` was `reason()`, reachable
   * solely via `POST /intelligence/reason` — a route no app calls — so the
   * watch list stayed empty all day, every tick exited at the `no-symbols`
   * guard, and the ten agents never ran on their own. This is the connection.
   *
   * A thin delegation on purpose: reusing `MarketWatchService.register` keeps
   * one registration mechanism with one idempotency rule, one expiry policy and
   * one symbol cap. A second mechanism here would be a second set of all three.
   */
  watchSymbol(symbol: string, at: Date = new Date()): void {
    this.watch.register(symbol, at);
  }

  /**
   * Build the corpus shortly after boot, off the boot path.
   *
   * Deferred rather than awaited inside the lifecycle hook: parsing the book
   * corpus is heavy disk I/O, and blocking `onModuleInit` on it delays the
   * service's `/health` past most orchestrators' patience. That is the real
   * concern behind `indexOnBoot` having shipped disabled — but the flag was also
   * never read by any code, so "disabled" in practice meant the corpus stayed at
   * zero documents until a human called `/intelligence/reason`, and
   * `reasonInBackground` declined every sweep for as long as that was true. The
   * fix is to run it, just not on the boot path.
   *
   * Idempotent at three levels, so neither a restart nor a concurrent request
   * re-does or double-counts the work: `ensureCorpus()` returns immediately once
   * the index and graph are populated; `CorpusIngestionService.ingest()` shares
   * one in-flight run between concurrent callers; and it skips every document
   * whose checksum is already indexed, including the ones restored from the
   * persisted index on disk.
   */
  private scheduleCorpusWarmup(): void {
    if (!this.config.indexOnBoot) {
      this.logger.log(
        'corpus warm-up disabled (SI_INDEX_ON_BOOT=false) — the corpus will be built by the first /intelligence/reason, ' +
          'and background reasoning stays declined until then',
      );
      return;
    }

    // One pending warm-up at a time. Nest calls `onModuleInit` once, but a
    // second scheduling would leave an orphaned timer that `onModuleDestroy`
    // could no longer cancel — a warm-up that outlives the shutdown asking it
    // to stop.
    if (this.warmupTimer) return;

    this.warmupTimer = setTimeout(() => {
      this.warmupTimer = null;
      void this.ensureCorpus().then(
        () =>
          this.logger.log(
            `corpus warm-up complete — ${this.index.size} chunks indexed, ${this.graph.size} concepts grounded`,
          ),
        (err: unknown) =>
          this.logger.warn(
            `corpus warm-up failed; reasoning will rebuild it on demand: ${(err as Error).message}`,
          ),
      );
    }, CORPUS_WARMUP_DELAY_MS);

    // Never hold the process open for a warm-up nobody is waiting on: a service
    // asked to shut down must not first finish indexing.
    this.warmupTimer.unref?.();
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
   * timer callback, stalling the sweep behind heavy disk I/O. The corpus is
   * warmed at boot instead (`scheduleCorpusWarmup`), so this declines only
   * during the first seconds of a cold start or when warm-up is switched off —
   * it is no longer the permanent state it was while nothing indexed at all.
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

    return {
      snapshot,
      signals,
      detections,
      risk: riskAssessment,
      trades,
      baseRates: await this.baseRatesFor(detections),
      // Computed ONCE, here, for the same reason the snapshot is: ten agents
      // each deriving positioning from the same chain would be ten copies of
      // one arithmetic, and — worse — the risk agent and the options agent
      // could quote different levels inside one run because one of them
      // rounded differently. Pure over the chain already in `snapshot`; no
      // second read, no network.
      positioning:
        snapshot?.optionChain && snapshot.lastPrice > 0
          ? readOptionPositioning({
              symbol,
              spot: snapshot.lastPrice,
              entries: snapshot.optionChain.entries,
            })
          : null,
    };
  }

  /**
   * The Brain's live track record for every pattern this run's detections are
   * about, resolved once and shared.
   *
   * This is the fix for an agent that had no memory. Historical Pattern
   * Intelligence computed self-similarity over the candles in hand and nothing
   * else, while the measured, outcome-tagged record of what those same setups
   * actually did was already sitting in Postgres — read later in the same run,
   * by `livePerformanceFor`, at the gate. The agent whose entire remit is "what
   * happened last time" was the one agent that could not see what happened last
   * time, and the two could disagree inside a single run.
   *
   * Resolved HERE rather than inside the agent so the agent keeps its
   * zero-dependency, zero-I/O property: it reads a map that was handed to it,
   * exactly as it reads the snapshot.
   *
   * Names match `MarketWatchService.validatedSignals` and the orchestrator's
   * `strategySignals` — `strategyId` with dashes as underscores — because that
   * is the string `PatternRecognitionService` writes. A mismatch here would not
   * throw; it would silently return sample 0 for every pattern and look exactly
   * like a cold database.
   */
  private async baseRatesFor(detections: StrategyDetection[]): Promise<ReadonlyMap<string, LiveBaseRate>> {
    const patterns = [
      ...new Set(detections.filter((d) => d.validated).map((d) => d.strategyId.replace(/-/g, '_'))),
    ];
    if (patterns.length === 0) return new Map();

    try {
      const results = await this.strategyIntelligence.baseRatesFor(patterns);
      return new Map(results.map((r) => [r.pattern, r]));
    } catch (err) {
      // An empty map reads as "no live record" everywhere it is consumed, which
      // is the safe direction: a database outage must weaken a verdict, never
      // strengthen one.
      this.logger.warn(`base-rate pre-resolution failed (agents will see no live record): ${(err as Error).message}`);
      return new Map();
    }
  }

  /**
   * Run the plan.
   *
   * Everything except compliance runs concurrently — the agents are pure
   * functions over shared state with no ordering dependency between them, and
   * `informedBy` in the plan documents which verdict informs which for a
   * reader rather than forcing serial execution. The field was called
   * `dependsOn` until 2026-08-21, which implied an execution DAG this method
   * has never built; the rename makes the plan say what the code does.
   *
   * Then ONE deliberation round, added 2026-09-01, in which every agent is
   * offered its peers' first-pass verdicts and may revise its own. Still not a
   * DAG: the round is a second parallel pass over a frozen input set, so it
   * adds one wave of latency and no ordering between agents.
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
      positioning: shared.positioning,
      signals: shared.signals,
      detections: shared.detections,
      risk: shared.risk,
      trades: request.recentTrades ?? [],
      account: request.account,
      baseRates: shared.baseRates,
      index: this.index,
      graph: this.graph,
      at,
    });

    const complianceTasks = subtasks.filter((s) => s.agent === 'compliance-intelligence');
    const otherTasks = subtasks.filter((s) => s.agent !== 'compliance-intelligence');

    const verdicts = await Promise.all(otherTasks.map((subtask) => this.registry.run(build(subtask))));

    // ---- ONE round of deliberation --------------------------------------
    //
    // Until this pass the nine agents reasoned in complete isolation and met
    // only in `CrossCheckService`, which can detect a disagreement and penalise
    // it but cannot ask either party about it. So the options agent could be
    // holding the fact that explains the market agent's structure — a wall
    // being reinforced right where the structure was heading — and that fact
    // reached the synthesis as an unexplained conflict rather than as an
    // explanation.
    //
    // Every agent is now offered the floor once, with its peers' first-pass
    // verdicts. Most decline (no `deliberate` hook) and keep their verdict
    // untouched. See `IntelligenceAgent.deliberate` for the three rules that
    // stop this becoming an echo chamber; the one enforced HERE is the
    // parallelism: every agent deliberates over the SAME first-pass set, so no
    // agent can see another's revision and revise in response to it. That is
    // what makes this one round rather than an unbounded negotiation.
    const revisions = await Promise.all(
      otherTasks.map((subtask, i) =>
        this.registry.deliberate(
          build(subtask),
          verdicts.filter((_, j) => j !== i),
          verdicts[i],
        ),
      ),
    );
    for (let i = 0; i < revisions.length; i++) {
      const revised = revisions[i];
      if (!revised) continue;
      this.logger.debug(
        `${verdicts[i].agent} revised after deliberation: ${verdicts[i].stance} → ${revised.stance} ` +
          `(confidence ${verdicts[i].confidence.toFixed(2)} → ${revised.confidence.toFixed(2)})`,
      );
      verdicts[i] = revised;
    }

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

/**
 * How long after boot the corpus warm-up starts.
 *
 * Long enough that the service has finished wiring and answered its first
 * health check before heavy disk I/O begins, short enough that the first watch
 * sweep a minute later already has a corpus to reason against.
 */
const CORPUS_WARMUP_DELAY_MS = 5_000;

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
  /**
   * The option book as defended levels plus today's change at each — the map
   * every agent reasons against, not just the options agent.
   *
   * Null when the instrument published no chain, when spot was unusable, or
   * when the chain was too thin to read. An agent must treat null as "no
   * positioning read", never as balanced positioning.
   */
  positioning: OptionPositioningRead | null;
  signals: Signal[];
  detections: StrategyDetection[];
  risk: RiskAssessment | null;
  trades: TradeSummary[];
  /** Live base rates for this run's validated detections, keyed by pattern. */
  baseRates: ReadonlyMap<string, LiveBaseRate>;
}
