import { api } from './api';

/**
 * Market news client — real headlines via services/api's `/news`.
 *
 * Replaces `lib/mock/market.ts`'s NEWS constant. The RSS fetch and its cache
 * live server-side: the browser must not fetch newswires directly (no CORS on
 * most of them, and every open tab would hit the publishers independently).
 */

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  url: string;
  publishedAt: string;
  category: string;
  publisher: string;
}

export function fetchNews(limit = 40): Promise<NewsItem[]> {
  return api(`/news?limit=${limit}`);
}

/** Headlines move on the order of minutes, and the server caches for five. */
export const NEWS_POLL_MS = 120_000;

/** 'HH:mm' in IST — the market's clock, matching every other timestamp. */
export function newsTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}
