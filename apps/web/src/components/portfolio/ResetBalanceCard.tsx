'use client';

import { useState } from 'react';
import { Card, buttonClasses, cn } from '@tradew/ui';
import { inr } from '@/lib/format';
import { resetWallet, type WalletResetResult } from '@/lib/oms';
import { useInvalidateTradingData } from '@/lib/query/usePortfolio';

/**
 * Reset the paper account to ₹10,00,000.
 *
 * Two deliberate steps — the button opens a confirmation that says exactly what
 * will be closed — because this closes open positions and cancels resting
 * orders. Order and trade history are kept. The server enforces its own
 * confirmation and refuses while an agent holds a position; its message is
 * shown as-is.
 */
export function ResetBalanceCard() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<WalletResetResult | null>(null);
  const invalidateTrading = useInvalidateTradingData();

  async function onReset() {
    setBusy(true);
    setError(null);
    try {
      const result = await resetWallet();
      setDone(result);
      setConfirming(false);
      invalidateTrading();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset your balance');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Reset paper balance">
      <p className="text-xs leading-relaxed text-muted">
        Start over with {inr(1_000_000, 0)} of paper capital. Open positions are closed, resting orders are
        cancelled and your profit and loss counter returns to zero. Your order and trade history is kept.
      </p>

      {done && (
        <p role="status" className="mt-3 rounded-lg bg-teal-bg px-3 py-2 text-xs text-teal">
          Balance reset to {inr(done.balance, 0)} — {done.closedPositions} position(s) closed, {done.cancelledOrders} order(s)
          cancelled.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-amber-bg px-3 py-2 text-xs text-amber">
          {error}
        </p>
      )}

      {confirming ? (
        <div className="mt-3 rounded-lg border border-amber bg-amber-bg p-3">
          <p className="text-xs font-semibold text-text">Reset to {inr(1_000_000, 0)}? This cannot be undone.</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => setConfirming(false)} disabled={busy} className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
              Cancel
            </button>
            <button
              type="button"
              onClick={onReset}
              disabled={busy}
              className={cn(buttonClasses({ variant: 'danger', size: 'sm' }), 'disabled:opacity-50')}
            >
              {busy ? 'Resetting…' : 'Yes, reset my balance'}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setDone(null);
            setError(null);
            setConfirming(true);
          }}
          className={cn(buttonClasses({ variant: 'outline', size: 'sm' }), 'mt-3')}
        >
          Reset balance to {inr(1_000_000, 0)}
        </button>
      )}
    </Card>
  );
}
