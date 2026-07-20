/**
 * Minimal click-logging seam. Logs to the console for now — swap the body
 * for a real analytics call (services/api event endpoint, PostHog, etc.)
 * later without touching call sites.
 */
export function logChartClick(symbol: string, source: string): void {
  // eslint-disable-next-line no-console
  console.log('[analytics] chart_click', { symbol, source, at: new Date().toISOString() });
}
