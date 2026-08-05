import { API_URL, api, getToken } from './api';

/**
 * Paper Trading OMS client — talks to services/api's `/sim/*` routes (the
 * order engine built in Phase 1: order.service.ts, matching-engine.service.ts).
 * Every call is JWT-authenticated through the shared `api()` helper, which
 * attaches the bearer token and transparently refreshes it on a 401.
 */

export type OrderSide = 'BUY' | 'SELL';
/** SL/SL_M exist in the engine and are deliberately not surfaced in the
 *  order ticket yet — see OrdersPanel. */
export type OrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL_M';
export type OrderValidity = 'DAY' | 'IOC';
/** Wire values are unchanged; the UI labels MIS as "Intraday" and CNC/NRML
 *  as "Delivery" (see PRODUCT_TYPE_LABELS). */
export type ProductType = 'MIS' | 'CNC' | 'NRML';
export type OrderStatus =
  | 'PENDING'
  | 'OPEN'
  | 'TRIGGER_PENDING'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED';

export interface PlaceOrderRequest {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  productType?: ProductType;
  validity?: OrderValidity;
  price?: number;
  triggerPrice?: number;
}

export interface OrderDto {
  id: string;
  symbol?: string;
  instrumentId: string;
  side: OrderSide;
  type: OrderType;
  validity: OrderValidity;
  productType: ProductType;
  status: OrderStatus;
  quantity: number;
  filledQuantity: number;
  price: string | null;
  triggerPrice: string | null;
  avgFillPrice: string | null;
  charges: string;
  rejectReason: string | null;
  placedAt: string;
  instrument?: { symbol: string; displayName: string; lotSize: number };
}

export interface PositionDto {
  id: string;
  instrumentId: string;
  symbol: string;
  displayName: string;
  productType: ProductType;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  dailyPnl: number;
  mtm: number;
  positionValue: number;
  marginUsed: number;
  positionStatus: 'OPEN' | 'CLOSED';
  priceStatus: 'live' | 'stale';
}

/**
 * One executed fill, from GET /sim/trades. Decimal columns arrive as strings
 * over the wire (Prisma serialises Decimal that way) — callers must Number()
 * them rather than assuming a numeric type.
 */
export interface TradeDto {
  id: string;
  orderId: string;
  instrumentId: string;
  side: OrderSide;
  quantity: number;
  fillPrice: string;
  charges: string;
  /** Set only when this fill closed or reduced a position; null when it opened one. */
  realizedPnl: string | null;
  executedAt: string;
  instrument?: { symbol: string; displayName: string; lotSize: number };
}

export interface PortfolioSummary {
  startingBalance: number;
  availableBalance: number;
  marginUsed: number;
  realizedPnl: number;
  unrealizedPnl: number;
  dailyPnl: number;
  positionValue: number;
  netWorth: number;
  openPositionsCount: number;
  positionsUnrealizedPnl: number;
  holdingsUnrealizedPnl: number;
  holdingsValue: number;
  investedAmount: number;
  currentValue: number;
  overallPnl: number;
  availableMargin: number;
}

export interface HoldingDto {
  id: string;
  instrumentId: string;
  symbol: string;
  displayName: string;
  quantity: number;
  avgCost: number;
  ltp: number;
  currentValue: number;
  investedValue: number;
  overallPnl: number;
  overallPnlPct: number;
  dayChange: number;
  dayChangePct: number;
  priceStatus: 'live' | 'stale';
}

export interface TradeHistoryRow {
  id: string;
  instrumentId: string;
  symbol: string;
  displayName: string;
  side: OrderSide;
  productType: ProductType;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  netPnl: number;
  charges: number;
  executedAt: string;
}

export interface TradeHistoryFilters {
  from?: string;
  to?: string;
  symbol?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export type PortfolioValueRange = '1W' | '1M' | '3M' | '1Y' | 'ALL';
export type MonthlyReturnsRange = '3M' | '6M' | '1Y';

export interface PerformanceOverview {
  portfolioValue: number;
  prevClose: number;
  changeAmount: number;
  changePct: number;
  todaysPnl: number;
  overallPnl: number;
  overallReturnPct: number;
  investedAmount: number;
  availableBalance: number;
  unrealizedPnl: number;
  marginUsed: number;
  availableMargin: number;
  totalTrades: number;
  winCount: number;
  lossCount: number;
}

export interface TodayPerformance {
  todaysPnl: number;
  todaysReturnPct: number;
  todaysTrades: number;
  todaysRealizedPnl: number;
  todaysUnrealizedPnl: number;
  todaysCharges: number;
  topGainer: { symbol: string; pnl: number } | null;
  topLoser: { symbol: string; pnl: number } | null;
}

export interface PortfolioValuePoint {
  dateKey: string;
  value: number;
}
export interface DailyPnlBar {
  dateKey: string;
  realizedPnl: number;
  unrealizedPnl: number;
  netPnl: number;
}
export interface MonthlyReturnBar {
  month: string;
  returnPct: number;
  pnl: number;
}
export interface DiaryEntry {
  dateKey: string;
  openingValue: number;
  closingValue: number;
  dailyReturnPct: number;
  realizedPnl: number;
  unrealizedPnl: number;
  fundsInOut: number;
  tradesCount: number;
  winCount: number;
  lossCount: number;
  charges: number;
  bestPerformer: { symbol: string; pnl: number } | null;
  worstPerformer: { symbol: string; pnl: number } | null;
  source: 'snapshot' | 'derived';
}

export interface ConvertPreview {
  currentMargin: number;
  projectedMargin: number;
  marginDelta: number;
}

export const PRODUCT_TYPE_LABELS: Record<ProductType, string> = {
  MIS: 'Intraday',
  CNC: 'Delivery',
  NRML: 'Delivery',
};

/** True when a session token exists at all — the order ticket disables
 *  placement (with a "sign in" message) rather than firing a request that
 *  can only 401. */
export function isSignedIn(): boolean {
  return getToken() != null;
}

/**
 * Canonical option-contract symbol the OMS trades by:
 * `UNDERLYING:YYYYMMDD:STRIKE:CE|PE` (e.g. `NIFTY:20260728:23800:CE`). MUST
 * stay byte-for-byte identical to the backend's `buildOptionSymbol`
 * (services/api/src/sim/market-price.service.ts) — the engine parses this exact
 * shape to resolve the contract. Colon-delimited so NSE symbols that contain
 * `-`/`&` (BAJAJ-AUTO, M&M) round-trip unambiguously.
 */
export function buildOptionSymbol(
  underlying: string,
  expiryIso: string,
  strike: number,
  optionType: 'CE' | 'PE',
): string {
  return `${underlying.toUpperCase()}:${expiryIso.replace(/-/g, '')}:${strike}:${optionType}`;
}

export function placeOrder(req: PlaceOrderRequest): Promise<OrderDto> {
  return api('/sim/orders', { method: 'POST', body: JSON.stringify(req) });
}

export function fetchOrders(status?: OrderStatus[]): Promise<OrderDto[]> {
  const query = status && status.length > 0 ? `?status=${status.join(',')}` : '';
  return api(`/sim/orders${query}`);
}

export function cancelOrder(orderId: string): Promise<OrderDto> {
  return api(`/sim/orders/${orderId}`, { method: 'DELETE' });
}

export interface ModifyOrderRequest {
  quantity?: number;
  price?: number;
  triggerPrice?: number;
}

export function modifyOrder(orderId: string, patch: ModifyOrderRequest): Promise<OrderDto> {
  return api(`/sim/orders/${orderId}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function fetchTrades(): Promise<TradeDto[]> {
  return api('/sim/trades');
}

export function fetchPositions(): Promise<PositionDto[]> {
  return api('/sim/positions');
}

export function fetchPortfolio(): Promise<PortfolioSummary> {
  return api('/sim/portfolio');
}

export function exitPosition(instrumentId: string, productType: ProductType = 'MIS'): Promise<OrderDto> {
  return api(`/sim/positions/${instrumentId}/exit?productType=${productType}`, { method: 'POST' });
}

export function exitAll(): Promise<unknown[]> {
  return api('/sim/positions/exit-all', { method: 'POST' });
}

export function previewConvertPosition(instrumentId: string, from: ProductType, to: ProductType): Promise<ConvertPreview> {
  return api(`/sim/positions/${instrumentId}/convert-preview?from=${from}&to=${to}`);
}

export function convertPosition(instrumentId: string, from: ProductType, to: ProductType): Promise<PositionDto> {
  return api(`/sim/positions/${instrumentId}/convert`, { method: 'POST', body: JSON.stringify({ from, to }) });
}

// ------------------------------------------------------------------ holdings

export function fetchHoldings(): Promise<HoldingDto[]> {
  return api('/sim/holdings');
}

export function sellHolding(instrumentId: string, quantity: number): Promise<HoldingDto | null> {
  return api(`/sim/holdings/${instrumentId}/sell`, { method: 'POST', body: JSON.stringify({ quantity }) });
}

// -------------------------------------------------------------- trade history

function tradeHistoryQuery(filters: TradeHistoryFilters): string {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.symbol) params.set('symbol', filters.symbol);
  if (filters.search) params.set('search', filters.search);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.pageSize) params.set('pageSize', String(filters.pageSize));
  return params.toString();
}

export function fetchTradeHistory(filters: TradeHistoryFilters): Promise<{ rows: TradeHistoryRow[]; total: number }> {
  return api(`/sim/trade-history?${tradeHistoryQuery(filters)}`);
}

/** CSV export needs a raw (non-JSON) fetch — `api()` always parses JSON —
 *  then a client-side Blob download, since the browser has no other way to
 *  save an authenticated fetch response as a file. */
export async function downloadTradeHistoryCsv(filters: Omit<TradeHistoryFilters, 'page' | 'pageSize'>): Promise<void> {
  const token = getToken();
  const res = await fetch(`${API_URL}/sim/trade-history/export?${tradeHistoryQuery(filters)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error('Could not export trade history');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'trade-history.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --------------------------------------------------------------- performance

export function fetchPerformanceOverview(): Promise<PerformanceOverview> {
  return api('/sim/performance/overview');
}

export function fetchTodayPerformance(): Promise<TodayPerformance> {
  return api('/sim/performance/today');
}

export function fetchPortfolioValueSeries(range: PortfolioValueRange): Promise<PortfolioValuePoint[]> {
  return api(`/sim/performance/portfolio-value?range=${range}`);
}

export function fetchDailyPnl(range: PortfolioValueRange): Promise<DailyPnlBar[]> {
  return api(`/sim/performance/daily-pnl?range=${range}`);
}

export function fetchMonthlyReturns(range: MonthlyReturnsRange): Promise<MonthlyReturnBar[]> {
  return api(`/sim/performance/monthly-returns?range=${range}`);
}

export function fetchDiary(page: number, pageSize = 30): Promise<{ rows: DiaryEntry[]; total: number }> {
  return api(`/sim/performance/diary?page=${page}&pageSize=${pageSize}`);
}
