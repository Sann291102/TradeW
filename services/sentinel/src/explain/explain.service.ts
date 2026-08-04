/**
 * Explain Service — the Neural Brain behind the terminal's "Explain this
 * decision / Explain this module" links, and the Confidence Explainability
 * Engine behind the "Why?" inspector (Master Plan §5).
 *
 * Two jobs, deliberately in one service because they answer the same question
 * at different depths:
 *
 *  - `buildWhy()` is **deterministic**. It reconstructs a confidence figure
 *    from the factors, deductions, strategies, history, news and risk that
 *    produced it. No model is involved, so the breakdown is reproducible and
 *    cannot hallucinate a reason. Master Plan principle 7 requires exactly
 *    that — a number a trader can audit.
 *  - `explain()` optionally puts prose around the structure using a configured
 *    LLM, and degrades to a deterministic note when none is configured. It
 *    never invents evidence: the trace records precisely which evidence lines
 *    and Brain memories fed the answer.
 *
 * Module 5 (Learning Intelligence) attaches here: the Brain's retriever is
 * queried for educational concepts matching the active setup, so guidance
 * cites the Learning Hub instead of asserting from nowhere.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CORE_GUARDRAILS,
  ProviderManager,
  ProviderNotAvailableError,
  Retriever,
  createProviderManager,
  loadProvidersConfigFromEnv,
} from '@tradew/ai-core';
import { HistoricalSimilarityResult } from '../brain/historical-similarity.service';
import { RETRIEVER } from '../brain/tokens';
import { ConfidenceBreakdown, ConfidenceExplainResult, KnowledgeCitation, RiskAssessment, Signal } from '../domain';
import { MarketSnapshot } from '../intelligence/market-intelligence.service';
import { KnowledgeIndexService } from '../sentinel-intelligence/knowledge/knowledge-index.service';
import { StrategyDetection } from '../intelligence/strategy-engine.service';
import { istTimeLabel } from '../market-clock';
import { enforceVocabulary } from '../vocabulary/vocabulary';

export interface ExplainTrace {
  /** the raw evidence lines the caller supplied (e.g. a module's readings) */
  evidenceUsed: string[];
  /** Brain memory records that contributed additional context, if any */
  memoryHits: { summary: string; confidence: number }[];
}

export interface ExplainResult {
  answer: string;
  /** true only when a real configured LLM provider produced the answer */
  live: boolean;
  servedBy?: { provider: string; model: string };
  /** Explainability Engine: exactly what fed this answer — never a black box */
  trace: ExplainTrace;
}

export interface WhyInput {
  /** the non-directive status line being explained */
  status: string;
  snapshot: MarketSnapshot;
  confidence: ConfidenceBreakdown;
  detections: StrategyDetection[];
  risk: RiskAssessment;
  signals: Signal[];
  historical: HistoricalSimilarityResult | null;
  at?: Date;
}

@Injectable()
export class ExplainService {
  private readonly logger = new Logger(ExplainService.name);
  private providers: ProviderManager;

  constructor(
    @Inject(RETRIEVER) private readonly retriever: Retriever,
    private readonly knowledgeIndex: KnowledgeIndexService,
  ) {
    this.providers = createProviderManager(loadProvidersConfigFromEnv());
  }

  // -------------------------------------------------------------------- §5
  /**
   * Reconstruct a confidence reading into its complete, inspectable basis.
   * Deterministic — same inputs, same output, every time.
   */
  async buildWhy(input: WhyInput): Promise<ConfidenceExplainResult> {
    const at = input.at ?? new Date();
    const { confidence, detections, risk, snapshot, historical } = input;

    const matchedStrategies = detections.map((d) => {
      const state = d.validated
        ? 'confirmed'
        : d.invalidationsTriggered.length > 0
          ? 'invalidated'
          : `forming, ${d.rulesMatched.length}/${d.rulesMatched.length + d.rulesUnmet.length} rules`;
      return `${d.strategyName} — ${state} (${d.confidence}%, ${d.bias} side)`;
    });

    const historicalPrecedent =
      !historical || historical.occurrences === 0
        ? 'No prior recorded occurrences of this pattern on this symbol yet — this is the first.'
        : historical.sampleTooSmall
          ? `${historical.occurrences} prior occurrence(s) recorded, but only ${historical.withKnownOutcome} with a known outcome — too few to report a frequency.`
          : describeOutcomes(historical);

    const newsSignal = input.signals.find((s) => s.name === 'news_driven_volatility');
    const newsEnvironment = newsSignal
      ? newsSignal.evidence.join('; ')
      : 'News intelligence did not report for this symbol.';

    const riskNotes = [...risk.factors]
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((f) => `${f.name.replace(/_/g, ' ')}: ${f.score}/100 — ${f.evidence[0] ?? 'no detail recorded'}`);

    const timingRationale = confidence.meetsThreshold
      ? `Surfaced at ${istTimeLabel(at)} IST once confidence reached ${confidence.score}%, clearing the ${confidence.threshold}% threshold.`
      : `Held back at ${istTimeLabel(at)} IST: confidence is ${confidence.score}%, below the ${confidence.threshold}% threshold. Sentinel stays in Wait and Watch rather than surface a low-confidence reading.`;

    return {
      status: input.status,
      score: confidence.score,
      threshold: confidence.threshold,
      meetsThreshold: confidence.meetsThreshold,
      matchedStrategies,
      confirmingIndicators: confirmingIndicators(snapshot),
      historicalPrecedent,
      newsEnvironment,
      riskNotes,
      deductions: confidence.deductions.map((d) => `−${d.points.toFixed(1)}% — ${d.reason}`),
      timingRationale,
      factorScores: Object.fromEntries(confidence.factors.map((f) => [f.label, f.score])),
      learningReferences: await this.learningReferences(detections, snapshot),
      bookCitations: this.bookCitations(detections, snapshot),
    };
  }

  /**
   * Grounds the active setup in SentinelIntelligence's book/document corpus.
   *
   * The Orchestrator and SentinelIntelligence remain two separate engines
   * (see `knowledge/Patterns/2026-08-03 - SentinelIntelligence...md`) — this
   * is a read-only query against the shared `KnowledgeIndexService`, not a
   * dependency on SentinelIntelligence's reasoning pipeline. Synchronous and
   * in-memory, so unlike `learningReferences` it needs no try/catch: an empty
   * corpus just returns no citations.
   */
  private bookCitations(detections: StrategyDetection[], snapshot: MarketSnapshot): KnowledgeCitation[] {
    const topic = detections[0]?.strategyName ?? snapshot.marketProfile?.type;
    if (!topic || this.knowledgeIndex.size === 0) return [];
    return this.knowledgeIndex.cite(topic, { limit: 3, preferKinds: ['book'] });
  }

  /**
   * Module 5 — pull the educational concepts behind the active setup out of
   * the Brain so guidance cites the Learning Hub. Best-effort: a Brain outage
   * removes the citations, never the explanation.
   */
  private async learningReferences(detections: StrategyDetection[], snapshot: MarketSnapshot): Promise<string[]> {
    const topic = detections[0]?.strategyName ?? snapshot.marketProfile?.type;
    if (!topic) return [];
    try {
      const retrieval = await this.retriever.retrieve({
        query: `${topic} — what it is and when it fails`,
        namespace: 'sentinel',
        limit: 3,
      });
      return retrieval.hits.filter((h) => h.record.confidence >= 0.5).map((h) => h.record.summary);
    } catch (err) {
      this.logger.warn(`learning-hub lookup failed (non-fatal): ${err}`);
      return [];
    }
  }

  /** The "Why?" inspector rendered as text, for the /explain answer body. */
  formatWhy(why: ConfidenceExplainResult): string {
    const section = (title: string, lines: string[]): string =>
      lines.length === 0 ? '' : `\n${title}\n${lines.map((l) => `  • ${l}`).join('\n')}`;

    return [
      `${why.status} — confidence ${why.score}% (threshold ${why.threshold}%, ${why.meetsThreshold ? 'met' : 'not met'})`,
      section('Matched strategies', why.matchedStrategies),
      section('Confirming indicators', why.confirmingIndicators),
      section('Historical precedent', [why.historicalPrecedent]),
      section('News & environment', [why.newsEnvironment]),
      section('Risk factors', why.riskNotes),
      section('Confidence deductions', why.deductions),
      section('From the Learning Hub', why.learningReferences),
      section('Book references', why.bookCitations.map((c) => `${c.sourceTitle} (${c.locator}): "${c.quote}"`)),
      section('Timing rationale', [why.timingRationale]),
      section(
        'Factor breakdown',
        Object.entries(why.factorScores).map(([label, score]) => `${label}: ${score}/100`),
      ),
    ]
      .filter(Boolean)
      .join('\n');
  }

  // ----------------------------------------------------------------- prose
  async explain(question: string, context?: string): Promise<ExplainResult> {
    const evidenceUsed = context ? context.split('\n').filter(Boolean) : [];

    let memoryHits: ExplainTrace['memoryHits'] = [];
    try {
      const retrieval = await this.retriever.retrieve({
        query: question,
        namespace: 'sentinel',
        limit: 3,
      });
      memoryHits = retrieval.hits.map((h) => ({
        summary: h.record.summary,
        confidence: h.record.confidence,
      }));
    } catch (err) {
      this.logger.warn(`explain: Brain memory retrieval failed (non-fatal): ${err}`);
    }
    const trace: ExplainTrace = { evidenceUsed, memoryHits };

    try {
      const llm = this.providers.getLlm();
      const memoryContext = memoryHits.length
        ? `\n\nRelevant Brain memory:\n${memoryHits.map((h) => `- ${h.summary}`).join('\n')}`
        : '';
      const response = await llm.complete({
        tier: 'fast',
        maxTokens: 400,
        messages: [
          {
            role: 'system',
            content:
              `You are Sentinel, TradeW's AI market-safety co-pilot. Explain the given module/decision in plain, calm, educational language — what it measured, why it reached this reading, and what a trader should be aware of. Never tell the user to buy, sell, enter, exit, or give a price target.\n\nNon-negotiable rules:\n` +
              CORE_GUARDRAILS.map((g) => `- ${g}`).join('\n'),
          },
          {
            role: 'user',
            content: (context ? `${question}\n\nContext:\n${context}` : question) + memoryContext,
          },
        ],
      });
      const answer = response.text.trim();
      if (answer) {
        // Module 10 applies to generated prose too: a model that ignores its
        // instructions still cannot emit a directive through this endpoint.
        const { clean, violations } = enforceVocabulary(answer);
        if (violations.length > 0) {
          this.logger.warn(`explain: rewrote ${violations.length} directive phrase(s) from the model: ${violations.join(', ')}`);
        }
        return { answer: clean, live: true, servedBy: response.servedBy, trace };
      }
    } catch (err) {
      if (!(err instanceof ProviderNotAvailableError)) {
        this.logger.warn(`explain LLM call failed, using deterministic fallback: ${err}`);
      }
    }

    return {
      answer:
        'Sentinel is running without a configured AI provider right now, so this is a deterministic note rather than a generated explanation: the module reading above is computed directly from live market/behavioral signals — the evidence lines under it are the full basis for the reading, not a summary of something more. Configure an LLM provider (Anthropic, NVIDIA NIM, OpenAI, or a local Ollama model) to get plain-language, contextual explanations here.',
      live: false,
      trace,
    };
  }
}

/** Indicator readings, quoted with their actual values. */
function confirmingIndicators(s: MarketSnapshot): string[] {
  const out: string[] = [];
  if (s.rsi14 !== null) {
    const zone =
      s.rsi14 > 70 ? 'overbought' : s.rsi14 < 30 ? 'oversold' : s.rsi14 > 55 ? 'bullish momentum zone' : s.rsi14 < 45 ? 'bearish momentum zone' : 'neutral zone';
    out.push(`RSI(14): ${s.rsi14.toFixed(1)} (${zone})`);
  }
  if (s.vwap !== null) {
    out.push(`VWAP ${s.vwap.toFixed(1)} — price ${s.lastPrice.toFixed(1)} is ${s.lastPrice >= s.vwap ? 'above' : 'below'} it`);
  }
  if (s.ema20 !== null && s.ema50 !== null) {
    out.push(`EMA20 ${s.ema20.toFixed(1)} / EMA50 ${s.ema50.toFixed(1)} — ${s.ema20 > s.ema50 ? 'fast above slow' : 'fast below slow'}`);
  }
  if (s.cpr) out.push(`CPR ${s.cpr.bc.toFixed(1)}–${s.cpr.tc.toFixed(1)} (pivot ${s.cpr.pivot.toFixed(1)})`);
  if (s.macdHistogram !== null) out.push(`MACD histogram ${s.macdHistogram.toFixed(2)}`);
  if (s.volumeVsAvg !== null) out.push(`Volume ${(s.volumeVsAvg * 100).toFixed(0)}% of the 20-bar average`);
  if (s.optionChain) {
    out.push(
      `Option chain: PCR ${s.optionChain.pcr.toFixed(2)}, max pain ${s.optionChain.maxPain.toFixed(0)} across ${s.optionChain.strikesAnalysed} front-expiry strikes`,
    );
  }
  if (s.vix !== null) out.push(`India VIX ${s.vix.toFixed(1)}`);
  if (s.breadthRatio !== null) out.push(`Advance/decline ratio ${s.breadthRatio.toFixed(2)}`);
  if (s.oiTrend !== 'unknown') out.push(`Open interest trend: ${s.oiTrend}`);
  return out;
}

function describeOutcomes(h: HistoricalSimilarityResult): string {
  const total = Object.values(h.outcomeCounts).reduce((a, b) => a + b, 0) || 1;
  const parts = Object.entries(h.outcomeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k.replace(/_/g, ' ')} ${Math.round((v / total) * 100)}%`);
  return `${h.occurrences} prior occurrences on ${h.symbol}, ${h.withKnownOutcome} with a known outcome: ${parts.join(', ')}. Historical frequency, not a prediction for this instance.`;
}
