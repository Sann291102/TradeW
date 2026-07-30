import { CourseTier } from './types';

/**
 * Course catalogue — the mapping from a course IDENTITY to the knowledge-graph
 * selector that fills it.
 *
 * This is NOT hardcoded lesson content and NOT hardcoded lesson counts. Each
 * entry names which ontology domains (or the strategy registry) a course draws
 * from; the actual lessons and their COUNT are generated at runtime from
 * whatever concepts exist in those domains. Adding concepts to the
 * knowledge-base grows the courses with no change here.
 *
 * The catalogue exists because "Trading Basics" is a product identity, not a
 * domain — a curator decides that the beginner course draws from the glossary
 * plus foundational structure. That editorial mapping is legitimately
 * declarative; the teaching material underneath is 100% generated.
 */
export interface CourseSpec {
  id: string;
  name: string;
  tier: CourseTier;
  /** the one free course is marked here; entitlement is enforced server-side */
  free: boolean;
  /** ontology domains this course pulls concepts from */
  domains: string[];
  /** when true, the course is built from the Strategy Registry instead of raw concepts */
  fromStrategyRegistry?: boolean;
  /** when true, the course is built from concepts that carry dated examples (case studies) */
  fromExamples?: boolean;
  order: number;
}

export const COURSE_CATALOG: CourseSpec[] = [
  { id: 'trading-basics', name: 'Trading Basics', tier: 'Beginner', free: true, domains: ['glossary'], order: 1 },
  { id: 'price-action', name: 'Price Action', tier: 'Intermediate', free: false, domains: ['price-action'], order: 2 },
  { id: 'indicators', name: 'Indicators', tier: 'Intermediate', free: false, domains: ['technical-analysis'], order: 3 },
  { id: 'market-structure', name: 'Market Structure', tier: 'Intermediate', free: false, domains: ['market-structure'], order: 4 },
  { id: 'risk-management', name: 'Risk Management', tier: 'All levels', free: false, domains: ['risk-management'], order: 5 },
  { id: 'psychology', name: 'Psychology', tier: 'All levels', free: false, domains: ['trading-psychology'], order: 6 },
  { id: 'options-essentials', name: 'Options Essentials', tier: 'Intermediate', free: false, domains: ['options', 'derivatives'], order: 7 },
  { id: 'institutional-trading', name: 'Institutional Trading', tier: 'Advanced', free: false, domains: ['institutional-concepts', 'market-microstructure'], order: 8 },
  { id: 'volume-order-flow', name: 'Volume & Order Flow', tier: 'Advanced', free: false, domains: ['volume', 'market-microstructure'], order: 9 },
  { id: 'market-regimes', name: 'Market Regimes', tier: 'Advanced', free: false, domains: ['patterns', 'sentiment'], order: 10 },
  { id: 'strategies', name: 'Strategies', tier: 'Advanced', free: false, domains: [], fromStrategyRegistry: true, order: 11 },
  { id: 'historical-case-studies', name: 'Historical Case Studies', tier: 'Advanced', free: false, domains: [], fromExamples: true, order: 12 },
];

const BY_ID = new Map(COURSE_CATALOG.map((c) => [c.id, c]));

export function courseSpec(id: string): CourseSpec | null {
  return BY_ID.get(id) ?? null;
}

/** The single free course id, referenced by the entitlement layer. */
export const FREE_COURSE_ID = 'trading-basics';
