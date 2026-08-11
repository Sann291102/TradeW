'use client';

import { useEffect, useState } from 'react';
import { Card, Button, Badge, Skeleton } from '@tradew/ui';
import { useSessionStore } from '@/lib/store/sessionStore';
import {
  fetchCatalog,
  startCheckout,
  verifyPayment,
  loadRazorpay,
  openRazorpay,
  type Catalog,
  type CatalogItem,
} from '@/lib/payments';

/**
 * Premium checkout — sells the Sentinel Pro subscription terms via Razorpay.
 *
 * The whole money-touching path lives server-side (services/api /payments/*):
 * this screen creates an order through the API, opens the Razorpay widget with
 * the SERVER's order id + publishable key, and hands the widget's signed
 * callback straight back to the API to verify and fulfil. The browser never
 * decides that a payment succeeded — it only relays a signature the server checks.
 *
 * When billing is not enabled on the server (`billingEnabled:false`), the page
 * is honest about it and disables purchase rather than opening a widget that
 * would 400 — the same honesty `GET /pricing` already commits to.
 */
type Phase = 'idle' | 'starting' | 'paying' | 'verifying' | 'done' | 'error';

export function CheckoutClient() {
  const user = useSessionStore((s) => s.user);
  const hasSentinel = useSessionStore((s) => s.hasCapability('sentinel'));
  const refreshSession = useSessionStore((s) => s.init);

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [activeItem, setActiveItem] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchCatalog()
      .then(setCatalog)
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Could not load plans'))
      .finally(() => setLoading(false));
  }, []);

  async function buy(item: CatalogItem) {
    if (!catalog?.billingEnabled) return;
    setActiveItem(item.id);
    setMessage(null);
    try {
      setPhase('starting');
      const ready = await loadRazorpay();
      if (!ready) throw new Error('Could not load the payment widget. Check your connection and retry.');

      const order = await startCheckout(item.id);
      setPhase('paying');
      const success = await openRazorpay(order, { email: user?.email });
      if (!success) {
        // User closed the modal — not an error, just no purchase.
        setPhase('idle');
        setActiveItem(null);
        return;
      }

      setPhase('verifying');
      const result = await verifyPayment({
        itemId: item.id,
        razorpayOrderId: success.razorpay_order_id,
        razorpayPaymentId: success.razorpay_payment_id,
        razorpaySignature: success.razorpay_signature,
      });
      if (!result.ok) throw new Error('Payment could not be verified.');

      await refreshSession(); // pull the freshly-granted capability
      setPhase('done');
      setMessage(`${item.label} is now active. A receipt is on its way to your email.`);
    } catch (e) {
      setPhase('error');
      setMessage(e instanceof Error ? e.message : 'Something went wrong. Nothing was charged.');
    } finally {
      if (phase !== 'paying') setActiveItem((cur) => (cur === item.id ? null : cur));
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-[760px] space-y-4 p-4">
        <Card title="Upgrade">
          <div className="space-y-3 py-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[760px] space-y-4 p-4">
      <Card
        title="Go premium — Sentinel Pro"
        actions={hasSentinel ? <Badge tone="positive">Active</Badge> : undefined}
      >
        <p className="mb-4 text-sm text-muted">
          Real-time behavioural &amp; market observation, advanced market intelligence, and the neural brain.
          Observation and education only — Sentinel never places trades or recommends them.
        </p>

        {loadError && <p className="mb-3 text-[12.5px] text-red-400">{loadError}</p>}

        {catalog && !catalog.billingEnabled && (
          <div className="mb-4 rounded-lg border border-border bg-hover/40 px-3 py-2 text-[12.5px] text-muted">
            {catalog.notice || 'Payments are not enabled yet. No account can be charged.'}
          </div>
        )}

        {message && (
          <div
            className={`mb-4 rounded-lg border px-3 py-2 text-[12.5px] ${
              phase === 'done'
                ? 'border-teal/40 bg-teal/10 text-teal'
                : 'border-red-500/40 bg-red-500/10 text-red-400'
            }`}
          >
            {message}
          </div>
        )}

        <ul className="space-y-3">
          {(catalog?.items ?? []).map((item) => {
            const perMonth = Math.round(item.amountInr / item.months);
            const busy = activeItem === item.id && phase !== 'idle' && phase !== 'done' && phase !== 'error';
            return (
              <li
                key={item.id}
                className="flex items-center justify-between gap-4 rounded-lg border border-border p-4"
              >
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-text">{item.label}</div>
                  <div className="text-[12px] text-muted">
                    {item.amountLabel} total · ₹{perMonth.toLocaleString('en-IN')}/mo
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() => buy(item)}
                  disabled={!catalog?.billingEnabled || busy || hasSentinel}
                >
                  {busy
                    ? phase === 'starting'
                      ? 'Starting…'
                      : phase === 'paying'
                        ? 'Awaiting payment…'
                        : 'Verifying…'
                    : hasSentinel
                      ? 'Active'
                      : 'Buy'}
                </Button>
              </li>
            );
          })}
        </ul>

        <p className="mt-4 text-[11px] text-faint">
          Payments are processed securely by Razorpay. TradeW never sees your card details.
        </p>
      </Card>
    </div>
  );
}
