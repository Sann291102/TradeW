'use client';

import { useEffect, useMemo, useState } from 'react';
import { Panel, Badge, cn } from '@tradew/ui';
import { fmt } from '@/lib/format';
import { useInstrumentMeta } from '@/lib/hooks/useInstrumentMeta';
import { isSignedIn, type OrderSide, type OrderType, type ProductType } from '@/lib/oms';
import {
  DisciplineBreachError,
  placeOrderWithDiscipline,
  type PlaceOrderWithOverride,
} from '@/lib/discipline';
import { useDisciplineStore } from '@/lib/store/disciplineStore';
import { FrictionPrompt } from '@/components/discipline/FrictionPrompt';
import type { DockPanelContentProps } from './types';

export interface OrdersPanelProps extends DockPanelContentProps {
  /** Instrument being traded. Its exchange-defined lot size drives quantity
   *  validation — never hardcoded, see useInstrumentMeta. */
  symbol?: string;
  /** Pre-selects BUY/SELL, e.g. arriving from the Option Chain. */
  defaultSide?: OrderSide;
  /** Shown under the title when prefilled from a specific contract. */
  contractLabel?: string;
  /** True when the symbol refers to an option contract rather than the
   *  underlying itself — options trade in the underlying's DERIVATIVE lot
   *  size (NIFTY 65), cash equity in 1s. */
  isOptionContract?: boolean;
  /** The instrument the order is actually placed against. For an underlying
   *  this equals `symbol`; for an option it's the canonical option symbol
   *  (`NIFTY:20260728:23800:CE`, see buildOptionSymbol) the engine resolves the
   *  real contract from. Undefined for an option whose live expiry isn't known
   *  yet — placement stays blocked rather than trading the wrong instrument. */
  orderSymbol?: string;
  /** Live price, used to prefill the limit price and show order value. For an
   *  option this is the strike's PREMIUM (not the underlying), so order value =
   *  qty x premium. */
  currentPrice?: number;
}

/** Wire value -> label. The engine's ProductType enum is unchanged (MIS/CNC/
 *  NRML); only the user-facing wording differs, since "MIS"/"CNC" are broker
 *  jargon rather than plain descriptions of what they do. */
const PRODUCTS: Array<{ value: ProductType; label: string; hint: string }> = [
  { value: 'MIS', label: 'Intraday', hint: 'Squared off same day, higher leverage' },
  { value: 'CNC', label: 'Delivery', hint: 'Held overnight, full cash required' },
];

/** SL/SL_M are implemented and tested in the engine but deliberately not
 *  offered here yet — they return in a later phase alongside bracket orders. */
const ORDER_TYPES: Array<{ value: OrderType; label: string }> = [
  { value: 'MARKET', label: 'Market' },
  { value: 'LIMIT', label: 'Limit' },
];

type QtyUnit = 'lots' | 'qty';

export function OrdersPanel({
  className,
  actions,
  collapsed,
  symbol,
  defaultSide,
  contractLabel,
  isOptionContract,
  orderSymbol,
  currentPrice,
}: OrdersPanelProps) {
  const [side, setSide] = useState<OrderSide>(defaultSide ?? 'BUY');
  const [orderType, setOrderType] = useState<OrderType>('MARKET');
  const [product, setProduct] = useState<ProductType>('MIS');
  const [qtyUnit, setQtyUnit] = useState<QtyUnit>('lots');
  const [qtyInput, setQtyInput] = useState('1');
  const [limitPrice, setLimitPrice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  /** The order that hit a discipline limit, frozen as it was at that moment. */
  const [pendingRequest, setPendingRequest] = useState<PlaceOrderWithOverride | null>(null);
  const openBreach = useDisciplineStore((s) => s.openBreach);
  const breach = useDisciplineStore((s) => s.breach);

  // "Not now — keep my limit" closes the prompt from inside FrictionPrompt, so
  // drop the snapshot here rather than leaving a stale order primed to be
  // re-sent by the next unrelated breach.
  useEffect(() => {
    if (!breach) setPendingRequest(null);
  }, [breach]);

  // `isSignedIn()` reads localStorage, which doesn't exist during SSR —
  // reading it straight in render made the server and client disagree on the
  // button's disabled state (React hydration mismatch). Resolve it after
  // mount instead, so both passes start from the same "not yet known" state.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const meta = useInstrumentMeta(symbol);
  // Which lot size actually applies depends on what's being traded:
  //  · an option contract  -> the underlying's derivative lot (NIFTY 65,
  //    SENSEX 20, BAJAJ-AUTO 75)
  //  · an INDEX            -> also the derivative lot: an index has no cash
  //    instrument you can buy, so its only tradeable form is a contract
  //  · a stock/ETF/commodity -> its own cash lot (1 for NSE equity)
  // All values come from the exchange's scrip master, never hardcoded.
  const usesDerivativeLot = isOptionContract || meta?.instrumentType === 'INDEX';
  const lotSize = (usesDerivativeLot ? meta?.derivativeLotSize : meta?.lotSize) ?? meta?.lotSize ?? 1;
  const signedIn = mounted && isSignedIn();
  // The instrument actually sent to the engine: the canonical option symbol for
  // a contract, the plain symbol for an underlying. Never silently fall back to
  // the underlying for an option — that would trade the wrong instrument.
  const placementSymbol = isOptionContract ? orderSymbol : symbol;

  useEffect(() => setSide(defaultSide ?? 'BUY'), [defaultSide]);
  useEffect(() => {
    if (orderType === 'LIMIT' && !limitPrice && currentPrice) setLimitPrice(String(currentPrice));
  }, [orderType, currentPrice, limitPrice]);

  const parsedInput = Number(qtyInput);
  const quantity = useMemo(() => {
    if (!Number.isFinite(parsedInput) || parsedInput <= 0) return 0;
    return qtyUnit === 'lots' ? Math.round(parsedInput) * lotSize : Math.floor(parsedInput);
  }, [parsedInput, qtyUnit, lotSize]);

  const lotError = qtyUnit === 'qty' && quantity > 0 && quantity % lotSize !== 0;
  const priceForValue = orderType === 'LIMIT' ? Number(limitPrice) : currentPrice;
  const orderValue = quantity > 0 && priceForValue ? quantity * priceForValue : null;

  /**
   * Margin a SHORT option actually costs.
   *
   * "Order value" (premium × quantity) is what a short option PAYS you, not
   * what it costs — showing it alone on a sell ticket read as though ₹620 was
   * the requirement, when the real figure is ~₹2L. Mirrors
   * SHORT_OPTION_MARGIN_RATE in services/api/src/sim/order.service.ts, taken on
   * the underlying notional.
   *
   * The strike is parsed from the canonical option symbol
   * (UNDERLYING:YYYYMMDD:STRIKE:CE|PE), which is the same fallback the server
   * uses when the option chain has no spot — so the estimate here and the
   * charge there agree. This duplicates a server constant; a /sim/margin-preview
   * endpoint would be the better long-term answer.
   */
  const SHORT_OPTION_MARGIN_RATE = 0.13;
  const shortOptionMargin = useMemo(() => {
    if (!isOptionContract || side !== 'SELL' || quantity <= 0) return null;
    const strike = Number(orderSymbol?.split(':')[2]);
    if (!Number.isFinite(strike) || strike <= 0) return null;
    return strike * quantity * SHORT_OPTION_MARGIN_RATE;
  }, [isOptionContract, side, quantity, orderSymbol]);

  const disabledReason = !mounted
    ? 'Loading…'
    : !symbol
    ? 'No instrument selected'
    : // An option can only be placed once its live contract is resolved (a real
      // ISO expiry → canonical option symbol the engine can price). Without it,
      // block rather than trade the underlying by mistake.
      isOptionContract && !placementSymbol
      ? 'Live option chain needed to place this strike'
      : !signedIn
        ? 'Sign in to place paper orders'
        : !meta
          ? 'Loading contract details…'
          : quantity <= 0
            ? 'Enter a quantity'
            : lotError
              ? `Quantity must be a multiple of ${lotSize}`
              : orderType === 'LIMIT' && !(Number(limitPrice) > 0)
                ? 'Enter a limit price'
                : null;

  /**
   * Issue one placement and report it. Throws rather than swallowing, so both
   * callers below can decide what a discipline breach means to them.
   */
  async function place(request: PlaceOrderWithOverride) {
    const order = await placeOrderWithDiscipline(request);
    setResult(
      order.status === 'REJECTED'
        ? { ok: false, message: order.rejectReason ?? 'Order rejected' }
        : {
            ok: true,
            message:
              order.status === 'FILLED'
                ? `Filled ${order.filledQuantity} @ ${fmt(Number(order.avgFillPrice))}`
                : `${order.status.replace('_', ' ').toLowerCase()} · ${order.quantity} qty`,
          },
    );
  }

  async function submit() {
    if (disabledReason || !placementSymbol) return;
    const request: PlaceOrderWithOverride = {
      symbol: placementSymbol,
      side,
      type: orderType,
      quantity,
      productType: product,
      ...(orderType === 'LIMIT' ? { price: Number(limitPrice) } : {}),
    };
    setSubmitting(true);
    setResult(null);
    try {
      await place(request);
    } catch (err) {
      if (err instanceof DisciplineBreachError) {
        // Not a failure — the order is waiting on the trader. Snapshot the
        // request as it stood when the limit was hit: the prompt takes ~20s to
        // clear, and the form is still editable behind it. Retrying whatever
        // the inputs happen to say later would apply the typed reason to a
        // different order than the one the prompt described.
        setPendingRequest(request);
        openBreach(err);
      } else {
        setResult({ ok: false, message: err instanceof Error ? err.message : 'Order failed' });
      }
    } finally {
      setSubmitting(false);
    }
  }

  /** Retry the snapshotted order carrying the override. Deliberately does NOT
   *  catch: FrictionPrompt handles a refused retry by replacing itself, and a
   *  genuine failure by showing its own banner. */
  async function confirmOverride(override: { overrideToken: string; overrideReason: string }) {
    if (!pendingRequest) return;
    await place({ ...pendingRequest, ...override });
    setPendingRequest(null);
  }

  return (
    <Panel title="Orders" subtitle={contractLabel} className={className} scroll={false} actions={actions} collapsed={collapsed}>
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-bg p-0.5">
        {(['BUY', 'SELL'] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={side === s}
            onClick={() => setSide(s)}
            className={cn(
              'rounded-md py-1.5 text-xs font-bold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              side === s ? (s === 'BUY' ? 'bg-up text-white' : 'bg-down text-white') : 'text-muted hover:text-text',
            )}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="mt-3 space-y-2 text-xs">
        <div>
          <div className="flex items-end gap-2">
            <label className="block flex-1">
              <span className="text-faint">Quantity</span>
              <input
                type="number"
                min={1}
                step={1}
                value={qtyInput}
                onChange={(e) => setQtyInput(e.target.value)}
                className="mt-1 w-full rounded-lg border border-border2 bg-card px-2 py-1.5 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              />
            </label>
            <label className="block w-24">
              <span className="sr-only">Quantity unit</span>
              <select
                value={qtyUnit}
                onChange={(e) => setQtyUnit(e.target.value as QtyUnit)}
                className="mt-1 w-full rounded-lg border border-border2 bg-card px-2 py-1.5 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <option value="lots">Lots</option>
                <option value="qty">Qty</option>
              </select>
            </label>
          </div>
          <div className={cn('mt-1 text-[10.5px]', lotError ? 'text-down' : 'text-faint')}>
            {meta
              ? lotError
                ? `Not a multiple of the ${lotSize}-share lot`
                : `1 lot = ${lotSize} · order = ${quantity > 0 ? quantity : 0} qty`
              : 'Loading lot size…'}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-faint">Product</span>
            <select
              value={product}
              onChange={(e) => setProduct(e.target.value as ProductType)}
              title={PRODUCTS.find((p) => p.value === product)?.hint}
              className="mt-1 w-full rounded-lg border border-border2 bg-card px-2 py-1.5 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {PRODUCTS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-faint">Order type</span>
            <select
              value={orderType}
              onChange={(e) => setOrderType(e.target.value as OrderType)}
              className="mt-1 w-full rounded-lg border border-border2 bg-card px-2 py-1.5 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {ORDER_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {orderType === 'LIMIT' && (
          <label className="block">
            <span className="text-faint">Limit price</span>
            <input
              type="number"
              min={0}
              step={meta?.tickSize ?? 0.05}
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border2 bg-card px-2 py-1.5 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            />
            <span className="mt-1 block text-[10.5px] text-faint">
              Rests until the market reaches this price
              {currentPrice ? ` · now ${fmt(currentPrice)}` : ''}
            </span>
          </label>
        )}

        {orderValue != null && (
          <div className="flex items-center justify-between rounded-lg bg-bg px-2 py-1.5">
            {/* On a short option the premium is received, not paid — labelling
                it "Order value" made ₹620 look like the cost of a position that
                actually blocks ~₹2L. */}
            <span className="text-faint">{shortOptionMargin != null ? 'Premium received' : 'Order value'}</span>
            <span className="font-mono font-semibold text-text">{fmt(orderValue)}</span>
          </div>
        )}

        {shortOptionMargin != null && (
          <div className="flex items-center justify-between rounded-lg bg-amber-bg px-2 py-1.5">
            <span className="text-amber">Margin required</span>
            <span className="font-mono font-semibold text-amber">≈ {fmt(shortOptionMargin)}</span>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={submit}
        disabled={!!disabledReason || submitting}
        title={disabledReason ?? undefined}
        className={cn(
          'mt-3 w-full rounded-lg py-2 text-sm font-bold text-white transition-opacity duration-micro',
          side === 'BUY' ? 'bg-up' : 'bg-down',
          (!!disabledReason || submitting) && 'cursor-not-allowed opacity-50',
        )}
      >
        {submitting ? 'Placing…' : `${side} · Paper`}
      </button>

      {result ? (
        <div className="mt-2 flex items-center justify-center gap-1.5">
          <Badge tone={result.ok ? 'positive' : 'negative'} className="px-1.5 py-0 text-[9px]">
            {result.ok ? 'PLACED' : 'FAILED'}
          </Badge>
          <span className={cn('text-[10.5px]', result.ok ? 'text-muted' : 'text-down')}>{result.message}</span>
        </div>
      ) : (
        <p className="mt-2 text-center text-[10px] text-faint">
          {disabledReason ?? 'Simulated execution against live market prices — no real money.'}
        </p>
      )}

      {/* Fixed-position overlay, so its position in this tree doesn't matter —
          it renders nothing unless a limit was breached. Mounted here, on the
          surface that owns the order, because the retry is this component's
          request to re-issue. */}
      <FrictionPrompt onConfirm={confirmOverride} />
    </Panel>
  );
}
