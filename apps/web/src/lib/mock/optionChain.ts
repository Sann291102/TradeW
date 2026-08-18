/** Shared mock expiry table — used by OptionChainTab (the ladder) and
 *  ChartPanel/TradeWorkspace (to compute time-to-expiry for a contract
 *  arrived at via query params), so the two never drift apart. */
export const EXPIRIES = [
  { label: '21 Jul', days: 1 },
  { label: '28 Jul', days: 8 },
  { label: '4 Aug', days: 15 },
  { label: '11 Aug', days: 22 },
  { label: '18 Aug', days: 29 },
  { label: '25 Aug', days: 36 },
  { label: '29 Sept', days: 71 },
] as const;

/** Mock IV smile — mirrors OptionChainTab's row generation (base + distance
 *  from ATM in strike steps, raised). Kept here so contract-mode chart/
 *  analysis can derive the same IV a user saw in the chain without repeating
 *  the formula. */
export function mockIvPct(strikeStepsFromAtm: number): number {
  return 12.5 + Math.pow(Math.abs(strikeStepsFromAtm), 1.5) * 1.1;
}

export const ATM_STRIKE = 23900;
export const STRIKE_STEP = 50;

/** Real NSE strike intervals per underlying (illustrative set — exchange
 *  circulars are the source of truth and these do get revised). Falls back
 *  to STRIKE_STEP for anything not listed (individual stocks, commodities). */
const STRIKE_STEP_BY_SYMBOL: Record<string, number> = {
  NIFTY: 50,
  BANKNIFTY: 100,
  FINNIFTY: 50,
  SENSEX: 100,
  MIDCPNIFTY: 25,
};

export function strikeStepFor(symbol: string): number {
  return STRIKE_STEP_BY_SYMBOL[symbol] ?? STRIKE_STEP;
}

/** ISO `YYYY-MM-DD` -> display label ("28 Jul"), matching the mock EXPIRIES
 *  table's label style so real and simulated expiries look the same in the
 *  UI. Parsed as UTC midnight so the calendar date never shifts a day in
 *  either direction depending on the browser's timezone. */
export function formatExpiryLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolves an `expiry` identifier — either a real ISO date (from a live Dhan
 * option chain, carried through `/trade?expiry=...`) or one of the fixed
 * mock `EXPIRIES` labels (simulated fallback) — into `{label, days}` for
 * Black-Scholes day-count math (contract-mode chart, IV, Greeks). Needed
 * because a real expiry date won't match any mock EXPIRIES label, so a plain
 * `EXPIRIES.find` would silently drop the contract.
 */
export function resolveExpiry(value: string): { label: string; days: number } | null {
  if (ISO_DATE_RE.test(value)) {
    const expiryMs = new Date(`${value}T15:30:00+05:30`).getTime(); // NSE expiry cutoff, IST
    if (Number.isNaN(expiryMs)) return null;
    return { label: formatExpiryLabel(value), days: Math.max(0, (expiryMs - Date.now()) / 86_400_000) };
  }
  return EXPIRIES.find((e) => e.label === value) ?? null;
}
