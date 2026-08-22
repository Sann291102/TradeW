'use client';

import { useSettingsStore } from './store/settingsStore';

/**
 * Minimal click-logging seam. Logs to the console for now — swap the body
 * for a real analytics call (services/api event endpoint, PostHog, etc.)
 * later without touching call sites.
 *
 * The opt-out from Settings -> Privacy is checked HERE rather than at each
 * call site, so a future real transport inherits it automatically and cannot
 * be added without it. Read at event time, not captured, so switching the
 * preference off stops the very next event.
 */
export function logChartClick(symbol: string, source: string): void {
  if (!useSettingsStore.getState().prefs.privacy.productAnalytics) return;
  // eslint-disable-next-line no-console
  console.log('[analytics] chart_click', { symbol, source, at: new Date().toISOString() });
}
