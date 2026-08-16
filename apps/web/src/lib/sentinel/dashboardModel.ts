/**
 * Maps the REAL `/sentinel/observe` response into the view-models the
 * reference-design dashboard cards render. Every value traces back to a field
 * the backend actually produced (marketProfile, confidence, risk, marketState,
 * observations, timeline) — nothing is invented. Where the backend has no
 * reading (e.g. no synthesis in pre-market), the model returns a null/empty
 * shape and the card shows an honest empty/pending state instead of a
 * fabricated one.
 *
 * See docs/product-architecture/SENTINEL.md and lib/sentinel/types.ts.
 */

import { extractMarketContext, type MarketContextDimension } from './deriveContext';
import { toTimelineDots, type TimelineDot } from './sessionTimeline';
import type {
  ConfidenceBreakdown,
  ContractWatch,
  MarketProfile,
  MarketStateSnapshot,
  MarketStateValue,
  Observation,
  ObserveResponse,
  RiskAssessment,
  Synthesis,
} from './types';

export type Tone = 'up' | 'down' | 'amber' | 'teal' | 'neutral';
export type { TimelineDot };

export interface RegimeCard {
  /** short uppercase regime word, e.g. TRENDING / RANGING / VOLATILE */
  label: string;
  /** one-line descriptor, e.g. "Bullish Momentum" */
  detail: string;
  tone: Tone;
}

export interface ConfidenceCard {
  score: number | null;
  threshold: number;
  detail: string;
  tone: Tone;
}

export interface RiskCard {
  score: number | null;
  detail: string;
  tone: Tone;
}

export interface StateCard {
  /** ACTIVE / PRE-MARKET / CLOSED-style word */
  label: string;
  detail: string;
  tone: Tone;
  raw: MarketStateValue | null;
}

export interface RadarFactor {
  key: string;
  label: string;
  /** 0..100 */
  score: number;
}

export interface ObservationCardModel {
  /** headline state, e.g. "WAIT AND WATCH" — null when nothing is published */
  headline: string;
  summary: string;
  /** evidence bullets, each { text, ok } where ok=confirmation, !ok=concern */
  why: { text: string; ok: boolean }[];
  confidence: number | null;
  threshold: number;
  updatedLabel: string;
}

export interface EmotionCard {
  state: string;
  message: string;
  tone: Tone;
}

export interface DashboardModel {
  regime: RegimeCard;
  confidence: ConfidenceCard;
  risk: RiskCard;
  state: StateCard;
  observationCount: number;
  radar: RadarFactor[];
  observation: ObservationCardModel;
  emotion: EmotionCard;
  timeline: TimelineDot[];
  /**
   * The structural read of the market itself — volatility, momentum,
   * structure, trap probability, liquidity, trend, institutional
   * participation. Each dimension carries `known`, and a dimension nothing
   * computes says "not enough data yet" rather than showing a guess.
   */
  marketContext: { tags: string[]; dimensions: MarketContextDimension[] };
  sessionPhase: MarketStateSnapshot['sessionPhase'];
  /** true when the exchange session is live (active/closing) */
  marketActive: boolean;
  /**
   * What the engine read on this observation — the underlying and both option
   * legs at the at-the-money strike, on one interval.
   *
   * Passed through unmapped, deliberately. Every other field here is a
   * presentation model derived from the response; this one is the response's
   * own account of which series it read, and re-shaping it would create a
   * second version of that claim to drift from the engine's.
   */
  contractWatch: ContractWatch | null;
}

// --- regime ----------------------------------------------------------------

function regimeCard(profile?: MarketProfile | null): RegimeCard {
  if (!profile) return { label: 'AWAITING', detail: 'No session read yet', tone: 'neutral' };
  const structure = profile.structure;
  const label =
    structure === 'trending'
      ? 'TRENDING'
      : structure === 'ranging'
        ? 'RANGING'
        : structure === 'breaking-out'
          ? 'BREAKOUT'
          : structure === 'consolidating'
            ? 'COILED'
            : profile.volatility === 'high'
              ? 'VOLATILE'
              : 'NEUTRAL';
  const trendWord =
    profile.trend === 'bullish'
      ? 'Bullish'
      : profile.trend === 'bearish'
        ? 'Bearish'
        : profile.trend === 'choppy'
          ? 'Two-sided'
          : 'Balanced';
  const tone: Tone = profile.trend === 'bullish' ? 'up' : profile.trend === 'bearish' ? 'down' : 'amber';
  return { label, detail: `${trendWord} · ${profile.type}`, tone };
}

// --- confidence ------------------------------------------------------------

function confidenceCard(c?: ConfidenceBreakdown): ConfidenceCard {
  if (!c) return { score: null, threshold: 72, detail: 'No confidence read', tone: 'neutral' };
  const score = Math.round(c.score);
  const detail =
    score >= c.threshold ? 'High Confidence' : score >= c.threshold - 20 ? 'Building Confidence' : 'Low Confidence';
  const tone: Tone = score >= c.threshold ? 'up' : score >= c.threshold - 20 ? 'amber' : 'down';
  return { score, threshold: c.threshold, detail, tone };
}

// --- risk ------------------------------------------------------------------

const RISK_TONE: Record<RiskAssessment['level'], Tone> = {
  very_low: 'up',
  low: 'up',
  moderate: 'amber',
  high: 'down',
  extreme: 'down',
};

function riskCard(r?: RiskAssessment): RiskCard {
  if (!r) return { score: null, detail: 'No risk read', tone: 'neutral' };
  const level = r.level.replace('_', ' ');
  return {
    score: Math.round(r.overallRisk),
    detail: `${level.charAt(0).toUpperCase()}${level.slice(1)} Risk`,
    tone: RISK_TONE[r.level] ?? 'amber',
  };
}

// --- state machine ---------------------------------------------------------

const STATE_LABEL: Partial<Record<MarketStateValue, string>> = {
  PRE_MARKET: 'PRE-MARKET',
  OBSERVATION: 'ACTIVE',
  MARKET_UNDERSTANDING: 'ACTIVE',
  STRATEGY_DETECTION: 'ACTIVE',
  VALIDATION: 'ACTIVE',
  WAIT_AND_WATCH: 'ACTIVE',
  SIDE_IN_FOCUS: 'ACTIVE',
  OPPORTUNITY_ACTIVE: 'ACTIVE',
  MOVE_DEVELOPING: 'ACTIVE',
  MOMENTUM_WEAKENING: 'ACTIVE',
  MOVE_COMPLETE: 'ACTIVE',
  MARKET_CLOSE: 'CLOSED',
};

function humanizeState(s: MarketStateValue): string {
  return s
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function stateCard(ms?: MarketStateSnapshot): StateCard {
  if (!ms) return { label: 'OFFLINE', detail: 'Not connected', tone: 'neutral', raw: null };
  const label = STATE_LABEL[ms.current] ?? 'ACTIVE';
  const tone: Tone = ms.current === 'PRE_MARKET' ? 'amber' : ms.current === 'MARKET_CLOSE' ? 'neutral' : 'teal';
  return { label, detail: `${humanizeState(ms.current)} Mode`, tone, raw: ms.current };
}

// --- risk radar ------------------------------------------------------------

const FACTOR_LABELS: Record<string, string> = {
  market_risk: 'Market Volatility',
  volatility_risk: 'Volatility',
  trade_risk: 'Trade Structure',
  position_risk: 'Concentration',
  news_risk: 'News Sentiment',
  emotional_risk: 'Revenge Trading',
  liquidity_risk: 'Liquidity',
  time_risk: 'Time of Day',
};

function radar(r?: RiskAssessment): RadarFactor[] {
  if (!r?.factors?.length) return [];
  return r.factors.map((f) => ({
    key: f.name,
    label: FACTOR_LABELS[f.name] ?? humanizeState(f.name as MarketStateValue),
    score: Math.round(Math.max(0, Math.min(100, f.score))),
  }));
}

// --- observation card ------------------------------------------------------

function observationCard(
  synthesis: Synthesis | null | undefined,
  confidence: ConfidenceBreakdown | undefined,
  observations: Observation[],
  publication: ObserveResponse['publication'],
  loading: boolean,
): ObservationCardModel {
  const threshold = confidence?.threshold ?? synthesis?.confidence ?? 72;
  const conf = synthesis?.confidence ?? (confidence ? Math.round(confidence.score) : null);

  // Headline: prefer the published synthesis status; otherwise the publication
  // gate's wait-and-watch reason; otherwise a neutral observing state.
  const headline = synthesis?.status || (publication && !publication.publish ? 'WAIT AND WATCH' : 'OBSERVING');
  const summary =
    synthesis?.content ||
    publication?.waitAndWatchReason ||
    (observations[0]?.content ?? 'Sentinel is observing market structure and behavior.');

  // "Why" bullets: the highest-signal recent observations, marked as
  // confirmation vs concern by their category/confidence.
  const why = observations.slice(0, 4).map((o) => ({
    text: o.content,
    ok: o.confidence >= 0.6 && !/miss|below|weak|lower|diverg, |pressure|trap|overbought|oversold/i.test(o.content),
  }));

  return {
    headline,
    summary,
    why,
    confidence: conf,
    threshold,
    updatedLabel: loading ? 'refreshing…' : 'just now',
  };
}

// --- emotion mirror --------------------------------------------------------

function emotionCard(r: RiskAssessment | undefined, observations: Observation[]): EmotionCard {
  const emo = r?.factors?.find((f) => f.name === 'emotional_risk');
  const emoObs = observations.find((o) => o.agent === 'emotion');
  if (!emo && !emoObs) {
    return { state: 'Neutral', message: 'No behavioral signals yet this session.', tone: 'neutral' };
  }
  const score = emo?.score ?? 0;
  if (score < 30) return { state: 'Calm', message: emoObs?.content ?? "You're trading with discipline today. Keep it up!", tone: 'up' };
  if (score < 60) return { state: 'Watchful', message: emoObs?.content ?? 'Mild behavioral drift — stay deliberate.', tone: 'amber' };
  return { state: 'Elevated', message: emoObs?.content ?? 'Emotional risk detected — slow down before acting.', tone: 'down' };
}

// --- top-level -------------------------------------------------------------
//
// Timeline mapping moved to `sessionTimeline.ts`. It used to live here as a
// straight `entries.map(...)`, which preserved the engine's APPEND order — and
// the engine stamps entries with market time, not append time, so the track
// could render an event out of sequence. See that module's header.

export function buildDashboardModel(data: ObserveResponse | null, loading: boolean): DashboardModel {
  const observations = data?.observations ?? [];
  const sessionPhase = data?.marketState?.sessionPhase ?? 'closed';
  return {
    regime: regimeCard(data?.marketProfile),
    confidence: confidenceCard(data?.confidence),
    risk: riskCard(data?.risk),
    state: stateCard(data?.marketState),
    observationCount: observations.length,
    radar: radar(data?.risk),
    observation: observationCard(data?.synthesis, data?.confidence, observations, data?.publication, loading),
    emotion: emotionCard(data?.risk, observations),
    timeline: toTimelineDots(data?.timeline),
    marketContext: extractMarketContext(data?.signals ?? [], {
      profile: data?.marketProfile,
      confidence: data?.confidence,
      risk: data?.risk,
    }),
    sessionPhase,
    marketActive: sessionPhase === 'active' || sessionPhase === 'closing',
    contractWatch: data?.contractWatch ?? null,
  };
}
