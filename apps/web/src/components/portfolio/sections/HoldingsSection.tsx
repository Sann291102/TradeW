'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge, EmptyState, Skeleton, buttonClasses, cn } from '@tradew/ui';
import { fmt, inr, sign } from '@/lib/format';
import { type HoldingDto, sellHolding } from '@/lib/oms';

export function HoldingsSection({
  holdings,
  error,
  onChanged,
}: {
  holdings: HoldingDto[] | null;
  error: string | null;
  onChanged: () => void;
}) {
  const [sellTarget, setSellTarget] = useState<HoldingDto | null>(null);

  if (holdings === null && !error) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (!holdings || holdings.length === 0) {
    return (
      <EmptyState
        title="No settled holdings"
        description="A CNC (delivery) buy shows up here the trading day after it settles — until then it's in Positions. See the Positions tab for anything bought today."
      />
    );
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-faint">
              <th className="py-2 pr-3">Symbol</th>
              <th className="py-2 pr-3 text-right">Qty</th>
              <th className="py-2 pr-3 text-right">Avg Price</th>
              <th className="py-2 pr-3 text-right">LTP</th>
              <th className="py-2 pr-3 text-right">Current Value</th>
              <th className="py-2 pr-3 text-right">Invested Value</th>
              <th className="py-2 pr-3 text-right">Overall P&L</th>
              <th className="py-2 pr-3 text-right">Day Change</th>
              <th className="py-2 pl-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {holdings.map((h) => (
              <tr key={h.id}>
                <td className="py-2.5 pr-3">
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-text">{h.symbol}</span>
                    {h.priceStatus === 'stale' && (
                      <Badge tone="warning" className="px-1.5 py-0 text-[9px]">
                        STALE
                      </Badge>
                    )}
                  </div>
                  <div className="text-[10px] text-faint">{h.displayName}</div>
                </td>
                <td className="py-2.5 pr-3 text-right font-mono tabular-nums">{h.quantity}</td>
                <td className="py-2.5 pr-3 text-right font-mono tabular-nums">{fmt(h.avgCost)}</td>
                <td className="py-2.5 pr-3 text-right font-mono tabular-nums">{fmt(h.ltp)}</td>
                <td className="py-2.5 pr-3 text-right font-mono tabular-nums">{inr(h.currentValue, 2)}</td>
                <td className="py-2.5 pr-3 text-right font-mono tabular-nums">{inr(h.investedValue, 2)}</td>
                <td className={cn('py-2.5 pr-3 text-right font-mono tabular-nums font-semibold', h.overallPnl >= 0 ? 'text-up' : 'text-down')}>
                  {sign(h.overallPnl)}
                  {inr(Math.abs(h.overallPnl), 2)}
                  <div className="text-[10px] font-normal">
                    {sign(h.overallPnlPct)}
                    {Math.abs(h.overallPnlPct).toFixed(2)}%
                  </div>
                </td>
                <td className={cn('py-2.5 pr-3 text-right font-mono tabular-nums', h.dayChange >= 0 ? 'text-up' : 'text-down')}>
                  {sign(h.dayChange)}
                  {inr(Math.abs(h.dayChange), 2)}
                </td>
                <td className="py-2.5 pl-3">
                  <div className="flex justify-end gap-1.5">
                    <Link
                      href={`/trade?symbol=${encodeURIComponent(h.symbol)}&action=buy`}
                      className={buttonClasses({ variant: 'outline', size: 'sm' })}
                    >
                      Buy
                    </Link>
                    <button type="button" onClick={() => setSellTarget(h)} className={buttonClasses({ variant: 'danger', size: 'sm' })}>
                      Sell
                    </button>
                    <Link href={`/trade?symbol=${encodeURIComponent(h.symbol)}`} className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
                      Chart
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sellTarget && (
        <SellHoldingDialog
          holding={sellTarget}
          onClose={() => setSellTarget(null)}
          onSold={() => {
            setSellTarget(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function SellHoldingDialog({ holding, onClose, onSold }: { holding: HoldingDto; onClose: () => void; onSold: () => void }) {
  const [quantity, setQuantity] = useState(holding.quantity);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await sellHolding(holding.instrumentId, quantity);
      onSold();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sell this holding');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-card border border-border bg-card p-4 shadow-card">
        <h3 className="text-base font-bold text-text">Sell {holding.symbol}</h3>
        <p className="mt-1 text-xs text-muted">
          {holding.quantity} settled @ avg {fmt(holding.avgCost)}, LTP {fmt(holding.ltp)}
        </p>

        <label className="mt-3 block text-xs font-semibold text-muted">
          Quantity
          <input
            type="number"
            min={1}
            max={holding.quantity}
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Math.min(holding.quantity, Number(e.target.value) || 1)))}
            className="mt-1 w-full rounded-lg border border-border2 bg-bg px-3 py-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          />
        </label>

        <p className="mt-2 font-mono text-xs tabular-nums text-muted">Est. proceeds: {inr(quantity * holding.ltp, 2)}</p>

        {error && <p className="mt-2 text-xs text-down">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={submitting} className={cn(buttonClasses({ variant: 'danger', size: 'sm' }), 'disabled:opacity-50')}>
            {submitting ? 'Selling…' : 'Sell'}
          </button>
        </div>
      </div>
    </div>
  );
}
