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
