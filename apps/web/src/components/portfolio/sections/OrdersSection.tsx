'use client';

import { useState } from 'react';
import { Badge, EmptyState, Skeleton, buttonClasses, cn } from '@tradew/ui';
import { fmt } from '@/lib/format';
import { PRODUCT_TYPE_LABELS, type OrderDto, type OrderStatus, cancelOrder, modifyOrder } from '@/lib/oms';
import { useInvalidateTradingData, useOrders, useSignedIn } from '@/lib/query/usePortfolio';

type Tab = 'Open' | 'Pending' | 'Executed' | 'Cancelled' | 'Rejected';
const TAB_STATUSES: Record<Tab, OrderStatus[]> = {
  Open: ['OPEN', 'TRIGGER_PENDING', 'PARTIALLY_FILLED'],
  Pending: ['PENDING'],
  Executed: ['FILLED'],
  Cancelled: ['CANCELLED'],
  Rejected: ['REJECTED', 'EXPIRED'],
};
const TABS: Tab[] = ['Open', 'Pending', 'Executed', 'Cancelled', 'Rejected'];
const MODIFIABLE: OrderStatus[] = ['OPEN', 'TRIGGER_PENDING', 'PENDING'];
const CANCELLABLE: OrderStatus[] = ['OPEN', 'TRIGGER_PENDING', 'PENDING', 'PARTIALLY_FILLED'];

function statusTone(status: OrderStatus): 'positive' | 'negative' | 'warning' | 'neutral' {
  if (status === 'FILLED') return 'positive';
  if (status === 'REJECTED' || status === 'CANCELLED' || status === 'EXPIRED') return 'negative';
  if (status === 'PENDING') return 'neutral';
  return 'warning';
}

export function OrdersSection() {
  const [tab, setTab] = useState<Tab>('Open');
  const [modifyTarget, setModifyTarget] = useState<OrderDto | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const signedIn = useSignedIn();

  const query = useOrders(TAB_STATUSES[tab], signedIn);
  // Cancelling or modifying moves margin and can unwind a position, so it
  // invalidates the whole trading blast radius rather than just this list —
  // otherwise the Portfolio summary a scroll away keeps showing the margin the
  // cancelled order was holding. See lib/query/usePortfolio.
  const invalidateTrading = useInvalidateTradingData();

  const orders = query.data ?? null;
  const error =
    query.isError && !query.data
      ? query.error instanceof Error
        ? query.error.message
        : 'Could not load orders'
      : null;

  async function onCancel(o: OrderDto) {
    setCancelling(o.id);
    try {
      await cancelOrder(o.id);
      invalidateTrading();
    } finally {
      setCancelling(null);
    }
  }

  return (
    <div>
      <div role="tablist" aria-label="Order status" className="mb-3 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors duration-micro',
              tab === t ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="mb-3 rounded-lg bg-amber-bg px-3 py-2 text-xs leading-relaxed text-amber">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="mt-1.5 font-semibold underline underline-offset-2 hover:no-underline"
          >
            Try again
          </button>
        </div>
      )}

      {orders === null && !error ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : orders && orders.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-faint">
                <th className="py-2 pr-3">Symbol</th>
                <th className="py-2 pr-3">Type</th>
                <th className="py-2 pr-3">Product</th>
                <th className="py-2 pr-3 text-right">Qty</th>
                <th className="py-2 pr-3 text-right">Filled</th>
                <th className="py-2 pr-3 text-right">Price</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Time</th>
                <th className="py-2 pl-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {orders.map((o) => (
                <tr key={o.id}>
                  <td className="py-2.5 pr-3">
                    <span className="font-bold text-text">{o.instrument?.symbol ?? o.symbol}</span>
                  </td>
                  <td className="py-2.5 pr-3">
                    {o.side} {o.type}
                  </td>
                  <td className="py-2.5 pr-3">{PRODUCT_TYPE_LABELS[o.productType]}</td>
                  <td className="py-2.5 pr-3 text-right font-mono tabular-nums">{o.quantity}</td>
                  <td className="py-2.5 pr-3 text-right font-mono tabular-nums">{o.filledQuantity}</td>
                  <td className="py-2.5 pr-3 text-right font-mono tabular-nums">
                    {o.avgFillPrice ? fmt(Number(o.avgFillPrice)) : o.price ? fmt(Number(o.price)) : 'Market'}
                  </td>
                  <td className="py-2.5 pr-3">
                    <Badge tone={statusTone(o.status)} className="px-1.5 py-0 text-[9px]">
                      {o.status.replace('_', ' ')}
                    </Badge>
                  </td>
                  <td className="py-2.5 pr-3 text-[11px] text-muted">{new Date(o.placedAt).toLocaleString()}</td>
                  <td className="py-2.5 pl-3">
                    <div className="flex justify-end gap-1.5">
                      {MODIFIABLE.includes(o.status) && (
                        <button type="button" onClick={() => setModifyTarget(o)} className={buttonClasses({ variant: 'outline', size: 'sm' })}>
                          Modify
                        </button>
                      )}
                      {CANCELLABLE.includes(o.status) && (
                        <button
                          type="button"
                          onClick={() => onCancel(o)}
                          disabled={cancelling === o.id}
                          className={cn(buttonClasses({ variant: 'danger', size: 'sm' }), 'disabled:opacity-40')}
                        >
                          {cancelling === o.id ? 'Cancelling…' : 'Cancel'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title={`No ${tab.toLowerCase()} orders`} description="Orders placed from the Trade screen will show up here." />
      )}

      {modifyTarget && (
        <ModifyOrderDialog
          order={modifyTarget}
          onClose={() => setModifyTarget(null)}
          onModified={() => {
            setModifyTarget(null);
            invalidateTrading();
          }}
        />
      )}
    </div>
  );
}

function ModifyOrderDialog({ order, onClose, onModified }: { order: OrderDto; onClose: () => void; onModified: () => void }) {
  const [quantity, setQuantity] = useState(order.quantity);
  const [price, setPrice] = useState(order.price ? Number(order.price) : undefined);
  const [triggerPrice, setTriggerPrice] = useState(order.triggerPrice ? Number(order.triggerPrice) : undefined);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await modifyOrder(order.id, { quantity, price, triggerPrice });
      onModified();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not modify this order');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-card border border-border bg-card p-4 shadow-card">
        <h3 className="text-base font-bold text-text">
          Modify {order.instrument?.symbol ?? order.symbol} {order.side} {order.type}
        </h3>

        <label className="mt-3 block text-xs font-semibold text-muted">
          Quantity
          <input
            type="number"
            min={1}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value) || 1)}
            className="mt-1 w-full rounded-lg border border-border2 bg-bg px-3 py-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          />
        </label>

        {(order.type === 'LIMIT' || order.type === 'SL') && (
          <label className="mt-3 block text-xs font-semibold text-muted">
            Price
            <input
              type="number"
              step="0.01"
              value={price ?? ''}
              onChange={(e) => setPrice(Number(e.target.value) || undefined)}
              className="mt-1 w-full rounded-lg border border-border2 bg-bg px-3 py-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            />
          </label>
        )}

        {(order.type === 'SL' || order.type === 'SL_M') && (
          <label className="mt-3 block text-xs font-semibold text-muted">
            Trigger price
            <input
              type="number"
              step="0.01"
              value={triggerPrice ?? ''}
              onChange={(e) => setTriggerPrice(Number(e.target.value) || undefined)}
              className="mt-1 w-full rounded-lg border border-border2 bg-bg px-3 py-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            />
          </label>
        )}

        {error && <p className="mt-2 text-xs text-down">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className={cn(buttonClasses({ variant: 'primary', size: 'sm' }), 'disabled:opacity-50')}
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
