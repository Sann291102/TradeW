'use client';

import { api, ApiError } from '../api';
import type {
  PeriodType,
  ResearchAnalysis,
  ResearchSearchResponse,
  ResearchSection,
  ResearchSnapshot,
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
