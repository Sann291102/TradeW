'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { Badge, Card, CandleLoader, buttonClasses, cn } from '@tradew/ui';
import { ApiError } from '@/lib/api';
import { useSessionStore } from '@/lib/store/sessionStore';
import { useCatalog } from '@/lib/query/useBilling';
import { AddressForm } from '@/components/billing/AddressForm';
import { StripeElements } from '@/components/billing/StripeElements';
import { VerifyFirst } from '../settings/billing/BillingSection';
import {
  cardLabel,
  createCheckout,
  fetchBillingProfile,
  fetchQuote,
  getStripe,
  listCards,
  money,
  newAttemptKey,
  saveAddress,
  type BillingProfile,
  type Card as SavedCard,
  type CatalogItem,
  type CheckoutSession,
  type Quote,
} from '@/lib/payments';

/**
 * Checkout (Stripe).
 *
 *  1. Choose a plan (`?item=` preselects one).
 *  2. Billing address: required, because sales tax depends on it.
 *  3. Server quote: subtotal, tax lines, total, all computed by services/api
 *     from the catalog and Stripe Tax. The browser sends only an item id.
 *  4. Pay with a saved card, or a new card in Stripe's Payment Element. For
 *     the one-time pass, "Save this card" is an explicit opt-in.
 *  5. Processing → the order page polls until the WEBHOOK marks it paid.
 *
 * One attempt key per visit makes a double-click (or a reload mid-checkout)
 * return the same order instead of a second charge.
 */
export function CheckoutClient() {
  const router = useRouter();
  const params = useSearchParams();
  const status = useSessionStore((s) => s.status);
  const user = useSessionStore((s) => s.user);
  const catalogQuery = useCatalog();
  const catalog = catalogQuery.data ?? null;

  const [itemId, setItemId] = useState<string | null>(params.get('item'));
  const [profile, setProfile] = useState<BillingProfile | null>(null);
  const [profileError, setProfileError] = useState<{ code: string | null; text: string } | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [cards, setCards] = useState<SavedCard[]>([]);
  const [payWith, setPayWith] = useState<string>('new');
  const [saveCard, setSaveCard] = useState(false);
  const [session, setSession] = useState<CheckoutSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attemptKey = useRef<string>(newAttemptKey());

  const item: CatalogItem | null = useMemo(() => catalog?.items.find((i) => i.id === itemId) ?? null, [catalog, itemId]);

  // Profile (verified check + billing address) and saved cards.
  useEffect(() => {
    if (status !== 'authenticated') return;
    fetchBillingProfile()
      .then((p) => {
        setProfile(p);
        if (p.billingEnabled) listCards().then((r) => {
          setCards(r.cards);
          const def = r.cards.find((c) => c.isDefault && !c.expired);
          if (def) setPayWith(def.id);
        }).catch(() => setCards([]));
      })
      .catch((e) => setProfileError({ code: e instanceof ApiError ? e.code : null, text: e instanceof Error ? e.message : 'Could not load billing details.' }));
  }, [status]);

  // Quote whenever the item or the billing address changes (tax recalculation).
  const billingKey = profile?.billingAddress ? `${profile.billingAddress.updatedAt}` : '';
  useEffect(() => {
    if (!item || !profile?.billingAddress || !catalog?.billingEnabled) {
      setQuote(null);
      return;
    }
    let live = true;
    setQuoteError(null);
    setQuote(null);
    fetchQuote(item.id)
      .then((q) => live && setQuote(q))
      .catch((e) => live && setQuoteError(e instanceof Error ? e.message : 'Could not calculate the total.'));
    return () => {
      live = false;
    };
  }, [item, billingKey, profile?.billingAddress, catalog?.billingEnabled]);

  // Changing the plan or payment method starts a fresh attempt.
  useEffect(() => {
    attemptKey.current = newAttemptKey();
    setSession(null);
    setError(null);
  }, [itemId, payWith, saveCard]);

  const choose = (id: string) => {
    setItemId(id);
    router.replace(`/checkout?item=${encodeURIComponent(id)}`);
  };

  const begin = useCallback(async () => {
    if (!item) return;
    setBusy(true);
    setError(null);
    try {
      const s = await createCheckout({
        itemId: item.id,
        idempotencyKey: attemptKey.current,
        savePaymentMethod: item.kind === 'one_time' ? saveCard : undefined,
        paymentMethodId: payWith !== 'new' ? payWith : undefined,
      });
      setSession(s);
      // Saved card: confirm straight away (Stripe.js runs 3-D Secure if asked).
      if (payWith !== 'new') {
        const stripe = await getStripe(s.publishableKey!);
        if (!stripe || !s.clientSecret) throw new Error('Could not load Stripe.');
        const result = await stripe.confirmCardPayment(s.clientSecret, { payment_method: payWith });
        if (result.error) {
          router.push(`/checkout/orders/${s.orderId}?error=${encodeURIComponent(result.error.message ?? 'Payment failed')}`);
          return;
        }
        router.push(`/checkout/orders/${s.orderId}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the payment. Nothing was charged.');
    } finally {
      setBusy(false);
    }
  }, [item, saveCard, payWith, router]);

  if (status !== 'authenticated') {
    return (
      <Shell>
        <div className="flex items-center gap-2 text-sm text-muted" role="status">
          <CandleLoader size="sm" decorative /> Loading…
        </div>
      </Shell>
    );
  }
  if (profileError?.code === 'EMAIL_NOT_VERIFIED') {
    return (
      <Shell>
        <VerifyFirst email={user?.email ?? ''} />
      </Shell>
    );
  }

  return (
    <Shell>
      {catalog?.mode === 'test' && catalog.billingEnabled && (
        <p className="mb-4 rounded-lg border border-amber/40 bg-amber-bg px-3 py-2 text-xs text-amber">
          Test mode: no real money moves. Use a Stripe test card such as 4242 4242 4242 4242, any future expiry and any CVC.
        </p>
      )}
      {catalog && !catalog.billingEnabled && (
        <p role="status" className="mb-4 rounded-lg border border-border2 px-3 py-2 text-sm text-muted">
          {catalog.notice ?? 'Payments are not enabled on this server yet. No account can be charged.'}
        </p>
      )}
      {profileError && (
        <p role="alert" className="mb-4 text-sm text-down">
          {profileError.text}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
        {/* 1. Plan */}
        <Card title="1. Choose a plan">
          {!catalog ? (
            <div className="flex items-center gap-2 text-sm text-muted" role="status">
              <CandleLoader size="sm" decorative /> Loading plans…
            </div>
          ) : (
            <fieldset className="space-y-2">
              <legend className="sr-only">Plan</legend>
              {catalog.items.map((i) => (
                <label
                  key={i.id}
                  className={cn(
                    'flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm',
                    i.id === itemId ? 'border-teal bg-teal-bg' : 'border-border hover:bg-hover',
                  )}
                >
                  <span className="flex items-center gap-2.5">
                    <input type="radio" name="plan" value={i.id} checked={i.id === itemId} onChange={() => choose(i.id)} className="accent-teal" />
                    <span>
                      <span className="font-semibold text-text">{i.label}</span>
                      <span className="block text-xs text-faint">{i.kind === 'recurring' ? 'Renews automatically. Cancel any time.' : `One-time ${i.days}-day pass. Does not renew.`}</span>
                    </span>
                  </span>
                  <span className="whitespace-nowrap text-right font-semibold text-text">
                    {i.priceLabel}
                    {i.localPrices.map((l) => (
                      <span key={l.country} className="block text-[11px] font-normal text-faint">
                        {l.label} in {l.country === 'IN' ? 'India' : l.country}
                      </span>
                    ))}
                  </span>
                </label>
              ))}
              <p className="pt-1 text-xs text-faint">{catalog.taxNote}</p>
            </fieldset>
          )}
        </Card>

        <div className="space-y-5">
          {/* 2. Billing address */}
          <Card title="2. Billing address" subtitle="Sales tax is calculated from it.">
            {!profile ? (
              <div className="flex items-center gap-2 text-sm text-muted" role="status">
                <CandleLoader size="sm" decorative /> Loading…
              </div>
            ) : profile.billingAddress ? (
              <BillingAddressSummary
                profile={profile}
                onSaved={(a) => {
                  setProfile({ ...profile, billingAddress: a });
                  attemptKey.current = newAttemptKey();
                  setSession(null);
                }}
              />
            ) : (
              <AddressForm
                kind="billing"
                initial={null}
                submitLabel="Save and calculate tax"
                onSave={async (a) => {
                  const saved = await saveAddress('billing', a);
                  setProfile({ ...profile, billingAddress: saved });
                }}
              />
            )}
          </Card>

          {/* 3. Summary + 4. Payment */}
          <Card title="3. Summary">
            {!item ? (
              <p className="text-sm text-muted">Choose a plan to see the total.</p>
            ) : !profile?.billingAddress ? (
              <p className="text-sm text-muted">Add your billing address to see tax and the total.</p>
            ) : catalog && !catalog.billingEnabled ? (
              <p className="text-sm text-muted">
                {item.priceLabel}, plus sales tax. Tax is calculated once payments are enabled on this server.
              </p>
            ) : quoteError ? (
              <p role="alert" className="text-sm text-down">
                {quoteError}
              </p>
            ) : !quote ? (
              <div className="flex items-center gap-2 text-sm text-muted" role="status">
                <CandleLoader size="sm" decorative /> Calculating tax…
              </div>
            ) : (
              <QuoteTable quote={quote} />
            )}
          </Card>

          {item && quote && catalog?.billingEnabled && catalog.publishableKey && (
            <Card title="4. Payment">
              {!session || payWith !== 'new' ? (
                <div className="space-y-3">
                  {cards.length > 0 && (
                    <fieldset className="space-y-1.5">
                      <legend className="text-xs text-faint">Pay with</legend>
                      {cards.map((c) => (
                        <label key={c.id} className="flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="payWith"
                            value={c.id}
                            disabled={c.expired}
                            checked={payWith === c.id}
                            onChange={() => setPayWith(c.id)}
                            className="accent-teal"
                          />
                          {cardLabel(c)}
                          <span className="text-xs text-faint">
                            {String(c.expMonth).padStart(2, '0')}/{c.expYear}
                          </span>
                          {c.isDefault && <Badge tone="brand">Default</Badge>}
                          {c.expired && <Badge tone="negative">Expired</Badge>}
                        </label>
                      ))}
                      <label className="flex items-center gap-2 text-sm">
                        <input type="radio" name="payWith" value="new" checked={payWith === 'new'} onChange={() => setPayWith('new')} className="accent-teal" />
                        A new card
                      </label>
                    </fieldset>
                  )}
                  {item.kind === 'one_time' && payWith === 'new' && (
                    <label className="flex items-start gap-2 text-sm text-muted">
                      <input type="checkbox" checked={saveCard} onChange={(e) => setSaveCard(e.target.checked)} className="mt-0.5 size-4 accent-teal" />
                      <span>
                        Save this card for future purchases.
                        <span className="block text-xs text-faint">Unticked, the card is used for this payment only and is not kept.</span>
                      </span>
                    </label>
                  )}
                  {item.kind === 'recurring' && (
                    <p className="text-xs text-faint">
                      Your card is kept on file with Stripe to renew this subscription. You can change or remove it in Billing.
                    </p>
                  )}
                  {error && (
                    <p role="alert" className="text-sm text-down">
                      {error}
                    </p>
                  )}
                  <button type="button" onClick={begin} disabled={busy} className={buttonClasses({ className: 'w-full' })}>
                    {busy ? 'Starting secure payment…' : payWith === 'new' ? 'Continue to card details' : `Pay ${money(quote.totalMinor, quote.currency)}`}
                  </button>
                </div>
              ) : session.clientSecret ? (
                <StripeElements publishableKey={catalog.publishableKey} clientSecret={session.clientSecret}>
                  <PayWithNewCard session={session} profile={profile!} email={user?.email ?? ''} />
                </StripeElements>
              ) : (
                <p role="alert" className="text-sm text-down">
                  The payment could not be prepared. Nothing was charged. Refresh and try again.
                </p>
              )}
              <p className="mt-3 text-[11px] text-faint">
                Payments are processed by Stripe. TradeW never sees or stores your card number. Educational paper-trading software; not investment advice.
              </p>
            </Card>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-5xl px-1 py-2">
      <p className="text-[11px] font-bold uppercase tracking-wide text-teal">Checkout</p>
      <h1 className="mb-5 mt-1 text-2xl font-extrabold text-text">Upgrade your TradeW workspace</h1>
      {children}
    </div>
  );
}

function BillingAddressSummary({ profile, onSaved }: { profile: BillingProfile; onSaved: (a: NonNullable<BillingProfile['billingAddress']>) => void }) {
  const [editing, setEditing] = useState(false);
  const a = profile.billingAddress!;
  if (editing) {
    return (
      <AddressForm
        kind="billing"
        initial={a}
        submitLabel="Save and recalculate tax"
        onCancel={() => setEditing(false)}
        onSave={async (next) => {
          const saved = await saveAddress('billing', next);
          onSaved(saved);
          setEditing(false);
        }}
      />
    );
  }
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <div>
        <p className="font-semibold text-text">{a.name}</p>
        <p className="text-muted">{[a.line1, a.line2, a.city, [a.state, a.postalCode].filter(Boolean).join(' '), a.country].filter(Boolean).join(', ')}</p>
      </div>
      <button className={buttonClasses({ size: 'sm', variant: 'ghost' })} onClick={() => setEditing(true)}>
        Change
      </button>
    </div>
  );
}

export function QuoteTable({ quote }: { quote: Pick<Quote, 'label' | 'subtotalMinor' | 'taxMinor' | 'totalMinor' | 'taxLines' | 'taxNote' | 'currency'> }) {
  return (
    <table className="w-full text-sm" aria-label="Order summary">
      <tbody>
        <tr>
          <td className="py-1 text-muted">{quote.label}</td>
          <td className="py-1 text-right text-text">{money(quote.subtotalMinor, quote.currency)}</td>
        </tr>
        {quote.taxLines
          .filter((t) => t.amountMinor > 0)
          .map((t, i) => (
            <tr key={i}>
              <td className="py-1 text-muted">
                {t.label}
                {t.ratePercent ? ` (${Number(t.ratePercent)}%)` : ''}
              </td>
              <td className="py-1 text-right text-text">{money(t.amountMinor, quote.currency)}</td>
            </tr>
          ))}
        {quote.taxMinor === 0 && (
          <tr>
            <td className="py-1 text-muted">Tax</td>
            <td className="py-1 text-right text-text">{money(0, quote.currency)}</td>
          </tr>
        )}
        <tr className="border-t border-border">
          <td className="pt-2 font-semibold text-text">Total due today</td>
          <td className="pt-2 text-right text-base font-bold text-text">{money(quote.totalMinor, quote.currency)}</td>
        </tr>
        {quote.taxNote && (
          <tr>
            <td colSpan={2} className="pt-1 text-xs text-faint">
              {quote.taxNote}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function PayWithNewCard({ session, profile, email }: { session: CheckoutSession; profile: BillingProfile; email: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const b = profile.billingAddress!;

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    const { error: stripeError } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        // 3-D Secure redirects (when the bank needs one) come back here.
        return_url: `${window.location.origin}/checkout/orders/${session.orderId}`,
        payment_method_data: {
          billing_details: {
            name: b.name,
            email,
            // Hidden fields ('never') must all be supplied: '' rather than undefined.
            phone: b.phone || '',
            address: { line1: b.line1, line2: b.line2 || '', city: b.city, state: b.state || '', postal_code: b.postalCode, country: b.country },
          },
        },
      },
      redirect: 'if_required',
    });
    if (stripeError) {
      setBusy(false);
      // Card errors are safe to show; they are written by Stripe for customers.
      setError(stripeError.message ?? 'The payment did not go through. Nothing was charged.');
      return;
    }
    router.push(`/checkout/orders/${session.orderId}`);
  }

  return (
    <form onSubmit={pay} className="space-y-3" aria-label="Card payment">
      <PaymentElement options={{ layout: 'tabs', fields: { billingDetails: { address: 'never', name: 'never', email: 'never', phone: 'never' } } }} />
      {error && (
        <p role="alert" className="text-sm text-down">
          {error}
        </p>
      )}
      <button type="submit" disabled={!stripe || busy} className={buttonClasses({ className: 'w-full' })}>
        {busy ? 'Processing…' : `Pay ${money(session.totalMinor, session.currency)}`}
      </button>
    </form>
  );
}
