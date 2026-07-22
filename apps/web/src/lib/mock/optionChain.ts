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

/** Symbols with no NSE F&O contract at all in this app's universe — MCX
 *  commodity futures (GOLD/SILVER/CRUDEOIL/NATURALGAS/COPPER). Real MCX does
 *  have its own commodity options, but this app doesn't model that market
 *  (different strike/lot conventions, different exchange) — showing an
 *  equity-style NIFTY-shaped chain for them would be actively misleading
 *  rather than just illustrative, so the Option Chain tab is hidden instead. */
const NON_OPTIONABLE = new Set(['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER']);

export function hasOptionChain(symbol: string): boolean {
  return !NON_OPTIONABLE.has(symbol);
}
