/**
 * The research wire types, mirrored for the client.
 *
 * Hand-mirrored rather than imported from `services/api`: `apps/web` does not
 * depend on the API package (there is no generated client — see
 * ARCHITECTURE.md's note on `packages/sdk` being a placeholder), and the shared
 * vocabulary that DOES cross the boundary lives in `@tradew/market-data`, which
 * both sides already consume.
 *
 * The discriminated union is the important part and is reproduced exactly: a
 * section is either available with data, or unavailable with a reason. There is
 * no third case and no optional-data case, so a component cannot render a value
 * it was not given.
 */

export type PeriodType = 'annual' | 'quarterly';
export type StatementType = 'income' | 'balance' | 'cash_flow';
export type ValueBasis = 'reported' | 'derived';

export interface Provenance {
  source: string;
  sourceTimestamp: string | null;
  fetchedAt: string;
}

export type ResearchSection<T> =
  | { available: true; data: T; provenance: Provenance }
  | { available: false; reason: string };

export interface FinancialFact {
  metric: string;
  value: number;
  currency: string;
  basis: ValueBasis;
  provenance: Provenance;
}

export interface StatementPeriod {
  fiscalYear: number;
  fiscalQuarter?: number;
  periodEnd: string;
  periodType: PeriodType;
  currency: string;
  facts: Record<string, FinancialFact>;
}

export interface FinancialStatement {
  statementType: StatementType;
  periodType: PeriodType;
  symbol: string;
  periods: StatementPeriod[];
}

export interface ReconciliationCheck {
  periodEnd: string;
  balanced: boolean;
  totalAssets: number | null;
  totalLiabilities: number | null;
  totalEquity: number | null;
  difference: number | null;
  differenceBps: number | null;
  currency: string;
  reason?: string;
}

export interface ResearchStatement {
  statement: FinancialStatement;
  reconciliation: ReconciliationCheck | null;
}

export interface CompanyProfile {
  symbol: string;
  exchange: string;
  name: string;
  currency: string;
  sector?: string;
  industry?: string;
  country?: string;
  isin?: string;
  website?: string;
  employees?: number;
  description?: string;
  provenance: Provenance;
}

export interface CompanyStatistics {
  symbol: string;
  currency: string;
  marketCap?: number;
  enterpriseValue?: number;
  sharesOutstanding?: number;
  floatShares?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  beta?: number;
  dividendYield?: number;
  vendorTrailingPe?: number;
  vendorForwardPe?: number;
  vendorPegRatio?: number;
  provenance: Provenance;
}

export interface ResearchOverview {
  profile: CompanyProfile;
  statistics: CompanyStatistics;
}

export type RatioGroup = 'valuation' | 'profitability' | 'health' | 'growth';

export interface ComputedRatio {
  key: string;
  label: string;
  group: RatioGroup;
  value: number;
  unit: 'x' | 'percent' | 'ratio' | 'currency';
  formula: string;
  inputs: Array<{ label: string; value: number }>;
  periodEnd: string;
}

export interface SkippedRatio {
  key: string;
  label: string;
  group: RatioGroup;
  reason: string;
}

export interface ResearchRatios {
  ratios: ComputedRatio[];
  skipped: SkippedRatio[];
  basisPeriodEnd: string | null;
  periodType: PeriodType;
  currency: string | null;
  marketInputs: {
    price?: number;
    marketCap?: number;
    enterpriseValue?: number;
    priceSource?: string;
    priceAsOf?: string;
  } | null;
}

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

export interface OwnershipSlice {
  holder: string;
  percent: number;
  shares?: number;
}

export interface OwnershipBreakdown {
  symbol: string;
  asOf: string | null;
  categories: OwnershipSlice[];
  topHolders: OwnershipSlice[];
  provenance: Provenance;
}

export interface SegmentBreakdown {
  symbol: string;
  dimension: 'business' | 'geography';
  periodEnd: string;
  currency: string;
  rows: Array<{ name: string; revenue?: number; operatingIncome?: number }>;
  provenance: Provenance;
}

export interface ResearchAnalysis {
  sections: Array<{ heading: string; body: string }>;
  evidence: Array<{ label: string; detail: string; sourceTimestamp: string | null }>;
  model: string;
  provider: string;
  generatedAt: string;
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

export interface SymbolSearchHit {
  symbol: string;
  name: string;
  exchange: string;
  micCode?: string;
  country?: string;
  currency?: string;
  instrumentType?: string;
}

export interface ResearchSearchResponse {
  query: string;
  results: SymbolSearchHit[];
  unavailableReason?: string;
}

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
  provider: string;
  generatedAt: string;
}
