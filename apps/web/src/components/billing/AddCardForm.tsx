'use client';

import { useEffect, useState } from 'react';
import { PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { buttonClasses, CandleLoader } from '@tradew/ui';
import { createSetupIntent, type Address } from '@/lib/payments';
import { StripeElements } from './StripeElements';

/**
 * Add a card: the server creates a SetupIntent for the caller's Stripe
 * Customer, Stripe's Payment Element collects the card (and runs 3-D Secure
 * when the bank asks), and `confirmSetup` attaches it. The card never passes
 * through TradeW. The card list refreshes from Stripe afterwards; the
 * `setup_intent.succeeded` webhook makes it the default if there was none.
 */
export function AddCardForm({
  publishableKey,
  billing,
  email,
  onDone,
  onCancel,
}: {
  publishableKey: string;
  billing: Address | null;
  email: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    createSetupIntent()
      .then((r) => live && setClientSecret(r.clientSecret))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not start adding a card.'));
    return () => {
      live = false;
    };
  }, []);

  if (error) {
    return (
      <p role="alert" className="text-sm text-down">
        {error}
      </p>
    );
  }
  if (!clientSecret) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted" role="status">
        <CandleLoader size="sm" decorative /> Preparing secure card form…
      </div>
    );
  }
  return (
    <StripeElements publishableKey={publishableKey} clientSecret={clientSecret}>
      <AddCardInner billing={billing} email={email} onDone={onDone} onCancel={onCancel} />
    </StripeElements>
  );
}

function AddCardInner({ billing, email, onDone, onCancel }: { billing: Address | null; email: string; onDone: () => void; onCancel: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    const { error: stripeError } = await stripe.confirmSetup({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/settings/billing?card=added`,
        payment_method_data: {
          billing_details: billing
            ? {
                name: billing.name,
                email,
                // With these fields hidden ('never'), Stripe.js requires every
                // one to be supplied; an absent value must be '' not undefined.
                phone: billing.phone || '',
                address: {
                  line1: billing.line1,
                  line2: billing.line2 || '',
                  city: billing.city,
                  state: billing.state || '',
                  postal_code: billing.postalCode,
                  country: billing.country,
                },
              }
            : { email },
        },
      },
      redirect: 'if_required',
    });
    setBusy(false);
    if (stripeError) {
      setError(stripeError.message ?? 'The card could not be saved.');
      return;
    }
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Add a card">
      <PaymentElement options={{ layout: 'tabs', fields: { billingDetails: billing ? { address: 'never', name: 'never', email: 'never', phone: 'never' } : 'auto' } }} />
      {error && (
        <p role="alert" className="text-sm text-down">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={!stripe || busy} className={buttonClasses({ size: 'sm' })}>
          {busy ? 'Saving card…' : 'Save card'}
        </button>
        <button type="button" onClick={onCancel} className={buttonClasses({ size: 'sm', variant: 'ghost' })}>
          Cancel
        </button>
      </div>
      <p className="text-[11px] text-faint">Card details go directly to Stripe. TradeW stores only the brand, last four digits and expiry.</p>
    </form>
  );
}
