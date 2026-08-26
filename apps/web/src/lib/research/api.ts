'use client';

import { api, ApiError } from '../api';
import type {
  AnalystResearch,
  EarningsIntelligence,
  PeriodType,
  ResearchKnowledgeGraph,
  ResearchAnalysis,
  ResearchNews,
  ResearchSearchResponse,
  ResearchSection,
  ResearchSnapshot,
  ResearchValuation,
  PeerResearch,
} from './types';

/**
 * The research client.
 *
 * Thin on purpose: every decision about what is knowable lives in
 * `services/api`, and this file only carries the request across. In particular
 * it does NOT catch a failure and substitute a shape — a rejected promise stays
 * rejected so the calling component renders its error state, and a section that
 * came back `available: false` is passed through untouched so the component
 * renders the server's reason verbatim.
 */

export function fetchResearchSnapshot(symbol: string, period: PeriodType): Promise<ResearchSnapshot> {
  return api(`/research/${encodeURIComponent(symbol)}?period=${period}`) as Promise<ResearchSnapshot>;
}

export function searchCompanies(query: string): Promise<ResearchSearchResponse> {
  return api(`/research/search?q=${encodeURIComponent(query)}`) as Promise<ResearchSearchResponse>;
}

/**
 * The premium route.
 *
 * A 403 here is not an error condition — it is the un-entitled state, and the
 * UI shows an upgrade prompt beside statements that remain fully readable. It is
 * converted to a section rather than thrown so the caller does not have to
 * inspect status codes to tell "you don't have this plan" from "the model is
 * down".
 */
export async function fetchResearchAnalysis(
  symbol: string,
  period: PeriodType,
): Promise<ResearchSection<ResearchAnalysis> & { entitlementRequired?: boolean }> {
  try {
    return (await api(`/research/${encodeURIComponent(symbol)}/analysis?period=${period}`)) as ResearchSection<ResearchAnalysis>;
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      return {
        available: false,
        reason:
          'AI research synthesis is part of TradeW Pro. Every financial statement, ratio and chart on this page is available on your current plan.',
        entitlementRequired: true,
      };
    }
    throw err;
  }
}

export function fetchResearchNews(symbol: string): Promise<ResearchSection<ResearchNews>> {
  return api(`/research/${encodeURIComponent(symbol)}/news`) as Promise<ResearchSection<ResearchNews>>;
}

export function fetchAnalystResearch(symbol: string): Promise<ResearchSection<AnalystResearch>> {
  return api(`/research/${encodeURIComponent(symbol)}/analyst`) as Promise<ResearchSection<AnalystResearch>>;
}

export function fetchEarningsIntelligence(symbol: string, period: PeriodType): Promise<ResearchSection<EarningsIntelligence>> {
  return api(`/research/${encodeURIComponent(symbol)}/earnings?period=${period}`) as Promise<
    ResearchSection<EarningsIntelligence>
  >;
}

export function fetchResearchValuation(symbol: string, period: PeriodType): Promise<ResearchSection<ResearchValuation>> {
  return api(`/research/${encodeURIComponent(symbol)}/valuation?period=${period}`) as Promise<
    ResearchSection<ResearchValuation>
  >;
}

export function fetchPeerResearch(symbol: string, period: PeriodType): Promise<ResearchSection<PeerResearch>> {
  return api(`/research/${encodeURIComponent(symbol)}/peers?period=${period}`) as Promise<ResearchSection<PeerResearch>>;
}

export function fetchKnowledgeGraph(symbol: string): Promise<ResearchSection<ResearchKnowledgeGraph>> {
  return api(`/research/${encodeURIComponent(symbol)}/graph`) as Promise<ResearchSection<ResearchKnowledgeGraph>>;
}
