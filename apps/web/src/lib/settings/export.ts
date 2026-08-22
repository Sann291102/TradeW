'use client';

import { api } from '../api';
import {
  fetchHoldings,
  fetchOrders,
  fetchPortfolio,
  fetchPositions,
  fetchTrades,
} from '../oms';

/**
 * Real exports of the caller's real account data.
 *
 * Everything here is assembled from endpoints the app already reads —
 * `/sim/*` for the paper account, `/auth/*` for identity and settings — and
 * every one of them is scoped server-side to the bearer token's subject. There
 * is no export endpoint, and this file deliberately does not pretend there is:
 * the file is built in the browser from data the user can already see, which
 * is why an export is exactly as complete as the account, and no more.
 *
 * WHAT IS NOT INCLUDED, and why it would be dishonest to claim otherwise:
 * server-side audit rows (`AuditEvent`), API call logs and Sentinel's internal
 * memory are not exposed to the account holder by any route. A "download
 * everything we hold about you" button would therefore be a false claim; this
 * is "download your account data", and the Privacy page says so in those
 * words.
 */

export interface AccountExport {
  exportedAt: string;
  /** Named so a reader of the file knows it was produced by the browser from
   *  the account's own API surface, not by a server-side export job. */
  source: 'tradew-web-client';
  profile: unknown;
  preferences: unknown;
  entitlements: unknown;
  portfolio: unknown;
  positions: unknown;
  holdings: unknown;
  orders: unknown;
  trades: unknown;
}

/** Collect the account into one object. Individual sections that fail are
 *  reported as an error string rather than omitted, so a partial export is
 *  visibly partial instead of quietly short. */
export async function buildAccountExport(): Promise<AccountExport> {
  const [profile, preferences, entitlements, portfolio, positions, holdings, orders, trades] =
    await Promise.all([
      settle(() => api('/auth/me')),
      settle(() => api('/auth/preferences')),
      settle(() => api('/entitlements/me')),
      settle(() => fetchPortfolio()),
      settle(() => fetchPositions()),
      settle(() => fetchHoldings()),
      settle(() => fetchOrders()),
      settle(() => fetchTrades()),
    ]);

  return {
    exportedAt: new Date().toISOString(),
    source: 'tradew-web-client',
    profile,
    preferences,
    entitlements,
    portfolio,
    positions,
    holdings,
    orders,
    trades,
  };
}

async function settle<T>(load: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await load();
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not load this section' };
  }
}

/** Trigger a browser download of `content` under `filename`. */
export function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers; one frame
  // is enough for the click to have been consumed.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `YYYY-MM-DD`, for filenames. */
export function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * CSV from a list of flat records.
 *
 * Quotes every field and doubles embedded quotes — a symbol or a reject reason
 * containing a comma must not shift every later column, which is how an export
 * silently becomes wrong.
 */
export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = [columns.map(escape).join(',')];
  for (const row of rows) lines.push(columns.map((c) => escape(row[c])).join(','));
  return lines.join('\r\n');
}
