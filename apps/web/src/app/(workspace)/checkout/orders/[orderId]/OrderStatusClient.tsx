'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Badge, Card, CandleLoader, buttonClasses } from '@tradew/ui';
import { useSessionStore } from '@/lib/store/sessionStore';
import { confirmOrder, fetchOrder, money, type Order } from '@/lib/payments';
import { QuoteTable } from '../../CheckoutClient';

const POLL_MS = 2000;
const POLL_LIMIT_MS = 90_000;

/**
 * Processing → success / failure, and the order confirmation afterwards.
 *
 * The page does not decide anything. It asks the server, which marks an order
 * paid only when Stripe's signed webhook arrives, and polls until it does (or
 * the payment fails). If the webhook is slow the page says so honestly instead
 * of guessing: the receipt email follows either way.
 */
export function OrderStatusClient({ orderId }: { orderId: string }) {
  const params = useSearchParams();
  const clientError = params.get('error');
  const redirectStatus = params.get('redirect_status'); // set by Stripe after a 3-D Secure redirect
  const refreshSession = useSessionStore((s) => s.init);
  const [order, setOrder] = useState<Order | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    let live = true;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (first: boolean) => {
      try {
        const o = first ? await confirmOrder(orderId) : await fetchOrder(orderId);
        if (!live) return;
        setOrder(o);
        if (o.status === 'paid') {
          await refreshSession(); // new capability unlocks the workspace
          return;
        }
        if (['failed', 'canceled', 'refunded', 'partially_refunded'].includes(o.status)) return;
        if (clientError || redirectStatus === 'failed') return;
        if (Date.now() - started > POLL_LIMIT_MS) {
          setTimedOut(true);
          return;
        }
        timer = setTimeout(() => void tick(false), POLL_MS);
      } catch (e) {
        if (live) setLoadError(e instanceof Error ? e.message : 'Could not load this order.');
      }
    };
    void tick(true);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [orderId, clientError, redirectStatus, refreshSession]);

  const failed = order?.status === 'failed' || Boolean(clientError) || redirectStatus === 'failed';
  const paid = order?.status === 'paid';
  const processing = order && !paid && !failed && !['canceled', 'refunded', 'partially_refunded'].includes(order.status);

  return (
    <div className="mx-auto max-w-xl px-1 py-4">
      <Card>
        <div className="p-2">
          {loadError && (
            <p role="alert" className="text-sm text-down">
              {loadError}
            </p>
          )}
          {!order && !loadError && (
            <div className="flex items-center gap-2 text-sm text-muted" role="status">
              <CandleLoader size="sm" decorative /> Loading your order…
            </div>
          )}

          {order && (
            <>
              <div role="status" aria-live="polite">
                {paid && (
                  <>
                    <p className="text-[11px] font-bold uppercase tracking-wide text-up">Payment successful</p>
                    <h1 className="mt-1 text-xl font-bold text-text">You&apos;re all set</h1>
                    <p className="mt-1 text-sm text-muted">
                      {order.label} is active. A confirmation and a receipt are on their way to your inbox.
                    </p>
                  </>
                )}
                {processing && !timedOut && (
                  <div className="flex items-start gap-3">
                    <CandleLoader size="md" decorative />
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-wide text-amber">Processing</p>
                      <h1 className="mt-1 text-xl font-bold text-text">Confirming your payment…</h1>
                      <p className="mt-1 text-sm text-muted">This usually takes a few seconds. Please keep this page open.</p>
                    </div>
                  </div>
                )}
                {processing && timedOut && (
                  <>
                    <p className="text-[11px] font-bold uppercase tracking-wide text-amber">Still processing</p>
                    <h1 className="mt-1 text-xl font-bold text-text">Your bank is taking a little longer</h1>
                    <p className="mt-1 text-sm text-muted">
                      We&apos;ll email you as soon as the payment is confirmed. You won&apos;t be charged twice. You can leave this page.
                    </p>
                  </>
                )}
                {failed && (
                  <>
                    <p className="text-[11px] font-bold uppercase tracking-wide text-down">Payment failed</p>
                    <h1 className="mt-1 text-xl font-bold text-text">The payment didn&apos;t go through</h1>
                    <p className="mt-1 text-sm text-muted">
                      {clientError || order.failureReason || 'The card was declined or could not be authenticated.'} Nothing was charged.
                    </p>
                  </>
                )}
                {order.status === 'canceled' && <h1 className="text-xl font-bold text-text">This payment was cancelled</h1>}
                {(order.status === 'refunded' || order.status === 'partially_refunded') && (
                  <>
                    <h1 className="text-xl font-bold text-text">Refunded</h1>
                    <p className="mt-1 text-sm text-muted">{money(order.refundedMinor, order.currency)} was refunded to your card.</p>
                  </>
                )}
              </div>

              <div className="mt-5 rounded-lg border border-border p-3">
                <div className="mb-2 flex items-center justify-between text-xs text-faint">
                  <span>Order {order.id.slice(0, 8)}</span>
                  <Badge tone={paid ? 'positive' : failed ? 'negative' : 'warning'}>{order.status.replace('_', ' ')}</Badge>
                </div>
                <QuoteTable quote={{ ...order, taxNote: null }} />
                {order.paidAt && <p className="mt-2 text-xs text-faint">Paid {new Date(order.paidAt).toLocaleString()}</p>}
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                {paid && (
                  <Link href={order.accessPath} className={buttonClasses()}>
                    Start using it
                  </Link>
                )}
                {failed && (
                  <Link href={`/checkout?item=${encodeURIComponent(order.itemId)}`} className={buttonClasses()}>
                    Try again
                  </Link>
                )}
                <Link href="/settings/billing" className={buttonClasses({ variant: 'outline' })}>
                  Billing &amp; receipts
                </Link>
              </div>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
