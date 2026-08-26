/**
 * The wire shape of `/research/*`.
 *
 * ── THE SECTION UNION IS THE WHOLE DESIGN ──────────────────────────────────
 *
 * Every part of a research response is a `ResearchSection<T>`: either
 * `{ available: true, data, provenance }` or `{ available: false, reason }`.
 * There is NO shape in which a section is present but its numbers are absent,
 * and therefore nowhere for a placeholder to live. The surface this feeds
 * previously rendered `P/E 24.62` and `ROE 14.28%` as literals for every symbol;
 * making that unrepresentable in the type system is more durable than agreeing
 * not to do it again.
 *
 * `reason` is written for a human and is rendered verbatim by the UI, so it must
 * say what is missing and why — "the configured data provider (twelvedata)
 * publishes no shareholding register", not "error".
 */

import type {
  CompanyProfile,
  CompanyStatistics,
  ComputedRatio,
  FinancialStatement,
  OwnershipBreakdown,
  PeriodType,
  Provenance,
  ReconciliationCheck,
  SegmentBreakdown,
  SkippedRatio,
  StatementType,
  SymbolSearchHit,
} from '@tradew/market-data';

export type ResearchSection<T> =
  | { available: true; data: T; provenance: Provenance }
  | { available: false; reason: string };

export function available<T>(data: T, provenance: Provenance): ResearchSection<T> {
  return { available: true, data, provenance };
}

export function unavailable<T>(reason: string): ResearchSection<T> {
  return { available: false, reason };
}

/** The company header: identity, descriptive fields and market statistics. */
export interface ResearchOverview {
  profile: CompanyProfile;
  statistics: CompanyStatistics;
}

/** A statement plus the checks that belong to it. */
export interface ResearchStatement {
  statement: FinancialStatement;
  /** Balance sheet only; null for the income and cash-flow statements. */
  reconciliation: ReconciliationCheck | null;
}

export interface ResearchRatios {
  ratios: ComputedRatio[];
  /** Ratios that could NOT be computed, each with the reason. Rendered — a
   *  silent omission looks like the ratio does not exist. */
  skipped: SkippedRatio[];
  /** Which statement periods the ratios were computed from. */
  basisPeriodEnd: string | null;
  periodType: PeriodType;
  currency: string | null;
  /** Market inputs that fed valuation ratios, and where each came from. Null
   *  when no live price was obtainable — the valuation block is then skipped
   *  rather than computed against a stale or invented price. */
  marketInputs: {
    price?: number;
    marketCap?: number;
    enterpriseValue?: number;
    priceSource?: string;
    priceAsOf?: string;
  } | null;
}

/** One metric's history, for the performance charts. */
export interface ResearchHistorySeries {
  metric: string;
  label: string;
  unit: 'currency' | 'percent' | 'ratio';
  currency: string | null;
  points: Array<{ periodEnd: string; fiscalYear: number; fiscalQuarter?: number; value: number }>;
}

export interface ResearchHistory {
  periodType: PeriodType;
  series: ResearchHistorySeries[];
}

/**
 * Grounded AI analysis.
 *
 * `evidence` is not decoration — it is the list of facts that were placed in the
 * prompt, and the UI renders it beside the prose so a reader can see exactly what
 * the model was and was not given. There is deliberately no confidence score and
 * no X/10 rating: this repository has no scoring methodology, and inventing one
 * would reproduce the "Business Quality 9.2/10" defect this rebuild removed.
 */
export interface ResearchAnalysis {
  sections: Array<{ heading: string; body: string }>;
  evidence: Array<{ label: string; detail: string; sourceTimestamp: string | null }>;
  model: string;
  provider: string;
  generatedAt: string;
  /** Named so the UI can state it plainly: the model summarised these inputs. */
  disclaimer: string;
}

export type NewsSentiment = 'positive' | 'negative' | 'neutral';
export type ResearchEventClassification =
  | 'analyst'
  | 'earnings'
  | 'management'
  | 'corporate_action'
  | 'major_announcement'
  | 'other';
export type ResearchEventImpact = 'high' | 'medium' | 'low' | 'unknown';

export interface ResearchNewsItem {
  id: string;
  title: string;
  source: string;
  publishedAt: string;
  url: string;
  summary: string;
  categories: string[];
  sentiment: NewsSentiment;
  eventClassification: ResearchEventClassification;
  eventImpact: ResearchEventImpact;
}

export interface ResearchNews {
  symbol: string;
  companyName: string | null;
  items: ResearchNewsItem[];
}

export type AnalystRating = 'buy' | 'hold' | 'sell';

export interface AnalystResearchItem {
  articleId: string;
  title: string;
  source: string;
  publishedAt: string;
  url: string;
  brokerName?: string;
  analystName?: string;
  rating?: AnalystRating;
  previousRating?: AnalystRating;
  priceTarget?: number;
  currency?: string;
  commentary?: string;
}

export interface AnalystResearch {
  symbol: string;
  coverageNote: string;
  distribution: { buy: number; hold: number; sell: number };
  targetRange: { low: number; high: number; average: number; currency: string } | null;
  items: AnalystResearchItem[];
}

export interface EarningsHistoryRow {
  periodEnd: string;
  fiscalYear: number;
  fiscalQuarter?: number;
  periodType: PeriodType;
  currency?: string;
  revenue?: number;
  eps?: number;
  netIncome?: number;
  revenueGrowthPct?: number;
  epsGrowthPct?: number;
}

export interface UpcomingEarningsEvent {
  symbol: string | null;
  company: string | null;
  purpose: string | null;
  date: string | null;
}

export interface EarningsIntelligence {
  symbol: string;
  history: EarningsHistoryRow[];
  upcoming: UpcomingEarningsEvent[];
  recentEarningsNews: ResearchNewsItem[];
  unavailableDetails: string[];
}

export type ValuationMetricSource = 'provider' | 'calculated';

export interface ValuationMetric {
  key: string;
  label: string;
  value: number;
  unit: 'x' | 'percent' | 'currency' | 'ratio';
  source: ValuationMetricSource;
  detail: string;
}

export interface ValuationScenario {
  label: string;
  basis: string;
  impliedPrice?: number;
  reason?: string;
}

export interface ResearchValuation {
  symbol: string;
  currency: string | null;
  metrics: ValuationMetric[];
  scenarios: ValuationScenario[];
  unavailableDetails: string[];
}

export interface PeerComparisonRow {
  symbol: string;
  name: string;
  exchange: string;
  sector?: string;
  industry?: string;
  metrics: Partial<Record<'pe' | 'pb' | 'ps' | 'ev_ebitda' | 'revenue_growth' | 'net_margin' | 'roe', number>>;
  source: 'cached-research-company';
}

export interface PeerResearch {
  symbol: string;
  subject: { sector?: string; industry?: string };
  peers: PeerComparisonRow[];
  unavailableDetails: string[];
}

export interface KnowledgeGraphRelation {
  relation: string;
  targetId: string;
  targetLabel: string;
  targetType: string;
  weight: number;
}

export interface ResearchKnowledgeGraph {
  symbol: string;
  nodeId: string;
  relationships: KnowledgeGraphRelation[];
}

export interface ResearchSearchResponse {
  query: string;
  results: SymbolSearchHit[];
  /** Present when the provider could not be reached at all. */
  unavailableReason?: string;
}

/** The consolidated read the page loads with. */
export interface ResearchSnapshot {
  symbol: string;
  periodType: PeriodType;
  overview: ResearchSection<ResearchOverview>;
  income: ResearchSection<ResearchStatement>;
  balance: ResearchSection<ResearchStatement>;
  cashFlow: ResearchSection<ResearchStatement>;
  ratios: ResearchSection<ResearchRatios>;
  history: ResearchSection<ResearchHistory>;
  ownership: ResearchSection<OwnershipBreakdown>;
  segments: ResearchSection<SegmentBreakdown[]>;
  /** Which provider answered, for the footer. */
  provider: string;
  generatedAt: string;
}

export type { StatementType, PeriodType };
