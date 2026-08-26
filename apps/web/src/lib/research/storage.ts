import { api } from '../api';
import type { PeriodType } from './types';

export interface ResearchWatchlistEntry {
  symbol: string;
  name: string;
  exchange: string;
  addedAt: string;
}

export type SavedResearchKind = 'brief' | 'ai-summary' | 'note' | 'thesis' | 'finding';

export interface SavedResearchEntry {
  id: string;
  symbol: string;
  kind: SavedResearchKind;
  title: string;
  body: string;
  periodType: PeriodType;
  createdAt: string;
}

export interface ResearchHistoryEntry {
  symbol: string;
  periodType: PeriodType;
  viewedAt: string;
}

export interface ResearchPreferences {
  watchlist: ResearchWatchlistEntry[];
  saved: SavedResearchEntry[];
  history: ResearchHistoryEntry[];
}

export const DEFAULT_RESEARCH_PREFERENCES: ResearchPreferences = {
  watchlist: [],
  saved: [],
  history: [],
};

export async function fetchResearchPreferences(): Promise<ResearchPreferences> {
  const raw = (await api('/auth/preferences')) as Record<string, unknown>;
  return parseResearchPreferences(raw.research);
}

export function saveResearchPreferences(value: ResearchPreferences): Promise<unknown> {
  return api('/auth/preferences/research', { method: 'POST', body: JSON.stringify({ value }) });
}

export function parseResearchPreferences(raw: unknown): ResearchPreferences {
  const obj = asObject(raw);
  return {
    watchlist: Array.isArray(obj?.watchlist)
      ? obj.watchlist.map(parseWatchlistEntry).filter((item): item is ResearchWatchlistEntry => item !== null)
      : [],
    saved: Array.isArray(obj?.saved)
      ? obj.saved.map(parseSavedEntry).filter((item): item is SavedResearchEntry => item !== null)
      : [],
    history: Array.isArray(obj?.history)
      ? obj.history.map(parseHistoryEntry).filter((item): item is ResearchHistoryEntry => item !== null)
      : [],
  };
}

function parseWatchlistEntry(value: unknown): ResearchWatchlistEntry | null {
  const obj = asObject(value);
  if (!obj || typeof obj.symbol !== 'string' || typeof obj.name !== 'string' || typeof obj.exchange !== 'string') return null;
  return {
    symbol: obj.symbol.toUpperCase(),
    name: obj.name,
    exchange: obj.exchange,
    addedAt: typeof obj.addedAt === 'string' ? obj.addedAt : new Date().toISOString(),
  };
}

function parseSavedEntry(value: unknown): SavedResearchEntry | null {
  const obj = asObject(value);
  if (
    !obj ||
    typeof obj.id !== 'string' ||
    typeof obj.symbol !== 'string' ||
    typeof obj.kind !== 'string' ||
    typeof obj.title !== 'string' ||
    typeof obj.body !== 'string'
  ) {
    return null;
  }
  if (!['brief', 'ai-summary', 'note', 'thesis', 'finding'].includes(obj.kind)) return null;
  return {
    id: obj.id,
    symbol: obj.symbol.toUpperCase(),
    kind: obj.kind as SavedResearchKind,
    title: obj.title,
    body: obj.body,
    periodType: obj.periodType === 'quarterly' ? 'quarterly' : 'annual',
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : new Date().toISOString(),
  };
}

function parseHistoryEntry(value: unknown): ResearchHistoryEntry | null {
  const obj = asObject(value);
  if (!obj || typeof obj.symbol !== 'string') return null;
  return {
    symbol: obj.symbol.toUpperCase(),
    periodType: obj.periodType === 'quarterly' ? 'quarterly' : 'annual',
    viewedAt: typeof obj.viewedAt === 'string' ? obj.viewedAt : new Date().toISOString(),
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
