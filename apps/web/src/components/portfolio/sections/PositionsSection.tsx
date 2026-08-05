'use client';

import { useState } from 'react';
import { Badge, EmptyState, Skeleton, buttonClasses, cn } from '@tradew/ui';
import { fmt, inr, sign } from '@/lib/format';
import { PRODUCT_TYPE_LABELS, type PositionDto, exitPosition } from '@/lib/oms';
import { PositionManagementDialog } from '../PositionManagementDialog';

export function PositionsSection({
  positions,
  error,
  onChanged,
}: {
  positions: PositionDto[] | null;
  error: string | null;
  onChanged: () => void;
}) {
  const [dialogFor, setDialogFor] = useState<{ position: PositionDto; action: 'convert' | 'add' } | null>(null);
  const [exiting, setExiting] = useState<string | null>(null);

  async function onExit(p: PositionDto) {
    setExiting(p.instrumentId);
    try {
      await exitPosition(p.instrumentId, p.productType);
      onChanged();
    } finally {
      setExiting(null);
    }
  }

  if (positions === null && !error) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (!positions || positions.length === 0) {
    return <EmptyState title="No open positions" description="Positions appear here as soon as an order fills on the Trade screen." />;
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-faint">
              <th className="py-2 pr-3">Symbol</th>
              <th className="py-2 pr-3">Product</th>
              <th className="py-2 pr-3 text-right">Qty</th>
              <th className="py-2 pr-3 text-right">Avg Price</th>
              <th className="py-2 pr-3 text-right">LTP</th>
              <th className="py-2 pr-3 text-right">MTM</th>
              <th className="py-2 pr-3 text-right">Unrealized P&L</th>
              <th className="py-2 pl-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {positions.map((p) => {
              const long = p.quantity > 0;
              return (
                <tr key={p.id}>
                  <td className="py-2.5 pr-3">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-text">{p.symbol}</span>
                      <Badge tone={long ? 'positive' : 'negative'} className="px-1.5 py-0 text-[9px]">
                        {long ? 'LONG' : 'SHORT'}
                      </Badge>
                      {p.priceStatus === 'stale' && (
                        <Badge tone="warning" className="px-1.5 py-0 text-[9px]">
                          STALE
                        </Badge>
                      )}
                    </div>
                    <div className="text-[10px] text-faint">{p.displayName}</div>
                  </td>
                  <td className="py-2.5 pr-3">
                    <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
                      {PRODUCT_TYPE_LABELS[p.productType]} ({p.productType})
                    </Badge>
                  </td>
                  <td className="py-2.5 pr-3 text-right font-mono tabular-nums">{Math.abs(p.quantity)}</td>
                  <td className="py-2.5 pr-3 text-right font-mono tabular-nums">{fmt(p.avgPrice)}</td>
                  <td className="py-2.5 pr-3 text-right font-mono tabular-nums">{fmt(p.currentPrice)}</td>
                  <td className={cn('py-2.5 pr-3 text-right font-mono tabular-nums', p.mtm >= 0 ? 'text-up' : 'text-down')}>
                    {sign(p.mtm)}
                    {inr(Math.abs(p.mtm), 2)}
                  </td>
                  <td className={cn('py-2.5 pr-3 text-right font-mono tabular-nums font-semibold', p.unrealizedPnl >= 0 ? 'text-up' : 'text-down')}>
                    {sign(p.unrealizedPnl)}
                    {inr(Math.abs(p.unrealizedPnl), 2)}
                  </td>
                  <td className="py-2.5 pl-3">
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => onExit(p)}
                        disabled={exiting === p.instrumentId}
                        className={cn(buttonClasses({ variant: 'danger', size: 'sm' }), 'disabled:opacity-40')}
                      >
                        {exiting === p.instrumentId ? 'Exiting…' : 'Exit'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDialogFor({ position: p, action: 'convert' })}
                        className={buttonClasses({ variant: 'outline', size: 'sm' })}
                      >
                        Modify
                      </button>
                      <button
                        type="button"
                        onClick={() => setDialogFor({ position: p, action: 'add' })}
                        className={buttonClasses({ variant: 'ghost', size: 'sm' })}
                      >
                        Add Qty
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {dialogFor && (
        <PositionManagementDialog
          position={dialogFor.position}
          initialAction={dialogFor.action}
          onClose={() => setDialogFor(null)}
          onChanged={() => {
            setDialogFor(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}
