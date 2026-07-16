import { Injectable, Logger } from '@nestjs/common';
import {
  CORE_GUARDRAILS,
  ProviderManager,
  ProviderNotAvailableError,
  createProviderManager,
  loadProvidersConfigFromEnv,
} from '@tradew/ai-core';
import { HistoricalSimilarityService } from '../brain/historical-similarity.service';
import { MarketContextService } from '../brain/market-context.service';
import { PatternRecognitionService } from '../brain/pattern-recognition.service';
import { ResearchTriggerService } from '../brain/research-trigger.service';
import { ComplianceService } from '../compliance/compliance.service';
import {
  ObserveRequest,
  ObserveResponse,
  SENTINEL_DISCLAIMER,
  SentinelObservationOut,
  Signal,
} from '../domain';
import { EmotionIntelligenceService } from '../intelligence/emotion-intelligence.service';
import { MarketIntelligenceService } from '../intelligence/market-intelligence.service';
import { NewsIntelligenceService } from '../intelligence/news-intelligence.service';
import { TrapIntelligenceService } from '../intelligence/trap-intelligence.service';

/**
 * Sentinel Orchestrator — the only component that produces user-facing copy.
 * Individual agents emit structured signals; the orchestrator surfaces a
 * warning only when multiple signals corroborate (composite design,
 * SENTINEL.md §2-3), always as evidence → pattern name → soft suggestion.
 *
 * LLM polish is optional: with no AI provider configured, a deterministic
 * template composes the same structure, so the service is fully functional
 * in dev without keys and can never be blocked by a provider outage.
 */
@Injectable()
export class SentinelOrchestratorService {
  private readonly logger = new Logger(SentinelOrchestratorService.name);
  private static readonly SURFACE_THRESHOLD = 0.7;
  private providers: ProviderManager;

  constructor(
    private readonly market: MarketIntelligenceService,
    private readonly emotion: EmotionIntelligenceService,
    private readonly traps: TrapIntelligenceService,
    private readonly news: NewsIntelligenceService,
    private readonly compliance: ComplianceService,
    private readonly patternRecognition: PatternRecognitionService,
    private readonly historicalSimilarity: HistoricalSimilarityService,
    private readonly marketContext: MarketContextService,
    private readonly researchTrigger: ResearchTriggerService,
  ) {
    this.providers = createProviderManager(loadProvidersConfigFromEnv());
  }

  async observe(request: ObserveRequest): Promise<ObserveResponse> {
    const symbol = request.symbol ?? 'NIFTY';
    const trades = request.recentTrades ?? [];

    // Continuous Research Engine: event-driven, fire-and-forget so it never
    // adds latency to this response — enriches the Brain for next time.
    void this.researchTrigger.researchIfUnfamiliar(symbol).catch(() => undefined);

    const snapshot = await this.market.snapshot(symbol);
    const signals: Signal[] = [
      ...this.market.signals(snapshot),
      ...this.emotion.signals(trades),
      ...this.traps.signals(snapshot, trades),
      ...(await this.news.signals(symbol)),
    ];

    const triggered = signals.filter((s) => s.triggered);
    const observations: SentinelObservationOut[] = triggered.map((s) => ({
      agent: s.agent,
      category: this.compliance.categoryFor(s),
      pattern: s.name,
      symbol,
      content: s.evidence.join('; '),
      evidence: s.evidence,
      confidence: Math.min(1, 0.4 + s.weight),
    }));

    // Pattern Recognition Engine: every triggered signal becomes durable,
    // queryable knowledge — wrapped so a Brain hiccup never breaks /observe.
    try {
      await Promise.all(triggered.map((s) => this.patternRecognition.recordOccurrence(symbol, s, snapshot.lastPrice)));
    } catch (err) {
      this.logger.warn(`pattern recognition persistence failed (non-fatal): ${err}`);
    }

    // composite gate: surface only when corroborating weight clears the bar
    const compositeWeight = triggered.reduce((sum, s) => sum + s.weight, 0);
    let synthesis: ObserveResponse['synthesis'] = null;
    if (compositeWeight >= SentinelOrchestratorService.SURFACE_THRESHOLD && triggered.length >= 2) {
      const dominant = [...triggered].sort((a, b) => b.weight - a.weight)[0];
      let content = await this.compose(symbol, triggered, dominant);

      // Historical Similarity Engine: append a frequency note when there's
      // genuinely something to say — never a directional call.
      try {
        const hist = await this.historicalSimilarity.similarPast(symbol, dominant.name);
        if (hist.occurrences > 0) content += ' ' + this.historicalSimilarity.describe(hist);
      } catch (err) {
        this.logger.warn(`historical similarity lookup failed (non-fatal): ${err}`);
      }

      synthesis = {
        content,
        pattern: dominant.name,
        confidence: Math.min(0.95, compositeWeight / 2 + 0.3),
        disclaimer: SENTINEL_DISCLAIMER,
      };
      observations.push({
        agent: 'orchestrator',
        category: 'synthesized_risk_awareness',
        pattern: dominant.name,
        symbol,
        content,
        evidence: triggered.flatMap((s) => s.evidence),
        confidence: synthesis.confidence,
      });
    }

    await this.compliance.record(request.userId, observations, synthesis?.content ?? null);

    // Market Context Engine: additive narrative, never blocks the response.
    const marketContext = await this.marketContext.contextFor(symbol, snapshot).catch(() => undefined);

    return { synthesis, observations, signals, marketContext };
  }

  /** evidence → pattern name → soft suggestion; never a directive. */
  private async compose(symbol: string, triggered: Signal[], dominant: Signal): Promise<string> {
    const patternName = dominant.name.replace(/_/g, ' ');
    const evidence = triggered.flatMap((s) => s.evidence).slice(0, 6);
    const fallback = `${evidence.join('. ')}. Together these resemble a ${patternName} pattern on ${symbol}. This is an observation, not advice — consider waiting for confirmation before acting.`;

    try {
      const llm = this.providers.getLlm();
      const response = await llm.complete({
        tier: 'fast',
        maxTokens: 220,
        messages: [
          {
            role: 'system',
            content:
              `You are the Sentinel Orchestrator, an observation-only trading intelligence desk. Rewrite the evidence into one short, calm paragraph following exactly: evidence -> pattern name -> soft suggestion (e.g. "Consider waiting for confirmation."). Educational tone.\n\nNon-negotiable rules:\n` +
              CORE_GUARDRAILS.map((g) => `- ${g}`).join('\n'),
          },
          {
            role: 'user',
            content: `Symbol: ${symbol}\nPattern: ${patternName}\nEvidence:\n${evidence.map((e) => `- ${e}`).join('\n')}`,
          },
        ],
      });
      return response.text.trim() || fallback;
    } catch (err) {
      if (!(err instanceof ProviderNotAvailableError)) {
        this.logger.warn(`LLM synthesis failed, using deterministic composition: ${err}`);
      }
      return fallback;
    }
  }
}
