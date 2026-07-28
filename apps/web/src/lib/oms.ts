import { api, getToken } from './api';

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
