'use client';

import { useEffect, useState } from 'react';
import { Badge, buttonClasses, cn } from '@tradew/ui';
import { fmt, inr, sign } from '@/lib/format';
import {
  PRODUCT_TYPE_LABELS,
  type PositionDto,
  type ProductType,
  convertPosition,
  exitPosition,
  placeOrder,
  previewConvertPosition,
} from '@/lib/oms';

type Action = 'convert' | 'add' | 'partial-exit' | 'full-exit';

const PRODUCT_TYPES: ProductType[] = ['MIS', 'CNC', 'NRML'];

/**
 * Position Management — Convert product type / Add Quantity / Partial Exit /
 * Full Exit, per the user's expanded scope for "Modify". Stop-Loss/Target/
 * Trailing are deliberately not here yet (no bracket-order support in the
 * engine) — nothing about this dialog's shape needs to change to add them
 * later; they'd just be additional actions in the same list.
 */
export function PositionManagementDialog({
  position,
  initialAction = 'convert',
  onClose,
  onChanged,
}: {
  position: PositionDto;
  initialAction?: Action;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [action, setAction] = useState<Action>(initialAction);

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-card border border-border bg-card p-4 shadow-card">
        <div className="flex items-center gap-1.5">
          <h3 className="text-base font-bold text-text">{position.displayName}</h3>
          <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
            {PRODUCT_TYPE_LABELS[position.productType]}
          </Badge>
        </div>
        <p className="mt-0.5 font-mono text-[11px] tabular-nums text-faint">
          {position.quantity} @ {fmt(position.avgPrice)} → {fmt(position.currentPrice)} &middot; margin {inr(position.marginUsed)}
        </p>
        <p className={cn('mt-1 font-mono text-sm font-bold tabular-nums', position.unrealizedPnl >= 0 ? 'text-up' : 'text-down')}>
          {sign(position.unrealizedPnl)}
          {inr(Math.abs(position.unrealizedPnl), 2)} unrealized
        </p>

        <div role="tablist" className="mt-3 flex flex-wrap gap-1">
          {(['convert', 'add', 'partial-exit', 'full-exit'] as Action[]).map((a) => (
            <button
              key={a}
              type="button"
              role="tab"
              aria-selected={action === a}
              onClick={() => setAction(a)}
              className={cn(
                'rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors duration-micro',
                action === a ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
              )}
            >
              {{ convert: 'Convert', add: 'Add Quantity', 'partial-exit': 'Partial Exit', 'full-exit': 'Full Exit' }[a]}
            </button>
          ))}
        </div>

        <div className="mt-3">
          {action === 'convert' && <ConvertPanel position={position} onClose={onClose} onChanged={onChanged} />}
          {action === 'add' && <AddQuantityPanel position={position} onClose={onClose} onChanged={onChanged} />}
          {action === 'partial-exit' && <PartialExitPanel position={position} onClose={onClose} onChanged={onChanged} />}
          {action === 'full-exit' && <FullExitPanel position={position} onClose={onClose} onChanged={onChanged} />}
        </div>
      </div>
    </div>
  );
}

function DialogFooter({ onClose, onConfirm, confirming, confirmLabel, disabled }: { onClose: () => void; onConfirm: () => void; confirming: boolean; confirmLabel: string; disabled?: boolean }) {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <button type="button" onClick={onClose} className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
        Cancel
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={confirming || disabled}
        className={cn(buttonClasses({ variant: 'primary', size: 'sm' }), 'disabled:opacity-50')}
      >
        {confirming ? 'Working…' : confirmLabel}
      </button>
    </div>
  );
}

function ConvertPanel({ position, onClose, onChanged }: { position: PositionDto; onClose: () => void; onChanged: () => void }) {
  const [to, setTo] = useState<ProductType>(PRODUCT_TYPES.find((p) => p !== position.productType) ?? 'CNC');
  const [preview, setPreview] = useState<{ currentMargin: number; projectedMargin: number; marginDelta: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);
    previewConvertPosition(position.instrumentId, position.productType, to)
      .then((p) => !cancelled && setPreview(p))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : 'Could not preview this conversion'));
    return () => {
      cancelled = true;
    };
  }, [position.instrumentId, position.productType, to]);

  async function confirm() {
    setSubmitting(true);
    setError(null);
    try {
      await convertPosition(position.instrumentId, position.productType, to);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not convert this position');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <label className="block text-xs font-semibold text-muted">
        Convert to
        <select
          value={to}
          onChange={(e) => setTo(e.target.value as ProductType)}
          className="mt-1 w-full rounded-lg border border-border2 bg-bg px-3 py-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {PRODUCT_TYPES.filter((p) => p !== position.productType).map((p) => (
            <option key={p} value={p}>
              {PRODUCT_TYPE_LABELS[p]} ({p})
            </option>
          ))}
        </select>
      </label>

      {preview && (
        <dl className="mt-3 space-y-1 text-xs">
          <div className="flex justify-between">
            <dt className="text-muted">Current margin</dt>
            <dd className="font-mono tabular-nums text-text">{inr(preview.currentMargin, 2)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Projected margin</dt>
            <dd className="font-mono tabular-nums text-text">{inr(preview.projectedMargin, 2)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Margin impact</dt>
            <dd className={cn('font-mono tabular-nums font-semibold', preview.marginDelta > 0 ? 'text-down' : 'text-up')}>
              {sign(preview.marginDelta)}
              {inr(Math.abs(preview.marginDelta), 2)}
            </dd>
          </div>
        </dl>
      )}
      {error && <p className="mt-2 text-xs text-down">{error}</p>}
      <DialogFooter onClose={onClose} onConfirm={confirm} confirming={submitting} confirmLabel="Convert" disabled={!preview} />
    </div>
  );
}

function AddQuantityPanel({ position, onClose, onChanged }: { position: PositionDto; onClose: () => void; onChanged: () => void }) {
  const [quantity, setQuantity] = useState(Math.abs(position.quantity));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const side = position.quantity >= 0 ? 'BUY' : 'SELL';

  async function confirm() {
    setSubmitting(true);
    setError(null);
    try {
      await placeOrder({ symbol: position.symbol, side, type: 'MARKET', quantity, productType: position.productType });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add to this position');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <p className="text-xs text-muted">
        Adds to the {side === 'BUY' ? 'long' : 'short'} at the live price ({fmt(position.currentPrice)}), same product type.
      </p>
      <label className="mt-2 block text-xs font-semibold text-muted">
        Quantity to add
        <input
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
          className="mt-1 w-full rounded-lg border border-border2 bg-bg px-3 py-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        />
      </label>
      <p className="mt-2 font-mono text-xs tabular-nums text-muted">Est. cost: {inr(quantity * position.currentPrice, 2)}</p>
      {error && <p className="mt-2 text-xs text-down">{error}</p>}
      <DialogFooter onClose={onClose} onConfirm={confirm} confirming={submitting} confirmLabel="Add" />
    </div>
  );
}

function PartialExitPanel({ position, onClose, onChanged }: { position: PositionDto; onClose: () => void; onChanged: () => void }) {
  const maxQty = Math.abs(position.quantity);
  const [quantity, setQuantity] = useState(Math.max(1, Math.floor(maxQty / 2)));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const side = position.quantity >= 0 ? 'SELL' : 'BUY';

  async function confirm() {
    setSubmitting(true);
    setError(null);
    try {
      await placeOrder({ symbol: position.symbol, side, type: 'MARKET', quantity, productType: position.productType });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reduce this position');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <label className="block text-xs font-semibold text-muted">
        Quantity to exit (of {maxQty})
        <input
          type="number"
          min={1}
          max={maxQty - 1}
          value={quantity}
          onChange={(e) => setQuantity(Math.max(1, Math.min(maxQty - 1, Number(e.target.value) || 1)))}
          className="mt-1 w-full rounded-lg border border-border2 bg-bg px-3 py-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        />
      </label>
      <p className="mt-2 text-[11px] text-faint">Leaves {maxQty - quantity} open. Use Full Exit to close the entire position.</p>
      {error && <p className="mt-2 text-xs text-down">{error}</p>}
      <DialogFooter onClose={onClose} onConfirm={confirm} confirming={submitting} confirmLabel="Exit partial" />
    </div>
  );
}

function FullExitPanel({ position, onClose, onChanged }: { position: PositionDto; onClose: () => void; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function confirm() {
    setSubmitting(true);
    setError(null);
    try {
      await exitPosition(position.instrumentId, position.productType);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not exit this position');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <p className="text-xs text-muted">
        Closes all {Math.abs(position.quantity)} at the live price ({fmt(position.currentPrice)}).
      </p>
      {error && <p className="mt-2 text-xs text-down">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
          Cancel
        </button>
        <button
          type="button"
          onClick={confirm}
          disabled={submitting}
          className={cn(buttonClasses({ variant: 'danger', size: 'sm' }), 'disabled:opacity-50')}
        >
          {submitting ? 'Exiting…' : 'Exit all'}
        </button>
      </div>
    </div>
  );
}
