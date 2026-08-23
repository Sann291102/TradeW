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
