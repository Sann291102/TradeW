'use client';

import { useEffect, useState } from 'react';
import { fetchQuotes, type LiveQuote } from '../marketData';

export type LiveQuotesStatus = 'loading' | 'live' | 'preview';

const POLL_MS = 5000;

/**
 * Polls services/api's real market-data endpoints for the given symbols
 * (Milestone 4, Step 2). Shared by IndexOverview and Ticker so the fetch +
 * poll + graceful-fallback logic exists in exactly one place.
 *
 * `market-data` routes require auth (existing guard, unchanged this step), so
 * guests always land on 'preview' — consistent with the site's no-login-wall
 * design: they still see a representative index view, just not the live one.
 * Polling continues even after a failure so a guest who logs in, or a
 * backend that comes back online, recovers automatically without a reload.
 */
export function useLiveQuotes(symbols: string[]): { quotes: LiveQuote[] | null; status: LiveQuotesStatus } {
  const [quotes, setQuotes] = useState<LiveQuote[] | null>(null);
  const [status, setStatus] = useState<LiveQuotesStatus>('loading');
  const key = symbols.join(',');

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function load() {
      try {
        const data = await fetchQuotes(key ? key.split(',') : []);
        if (cancelled) return;
        if (data.length === 0) throw new Error('no live quotes');
        setQuotes(data);
        setStatus('live');
      } catch {
        if (!cancelled) setStatus('preview');
      } finally {
        if (!cancelled) timer = setTimeout(load, POLL_MS);
      }
    }

    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key]);

  return { quotes, status };
}
