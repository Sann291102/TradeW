'use client';

import { useMemo } from 'react';
import { Elements } from '@stripe/react-stripe-js';
import type { Appearance } from '@stripe/stripe-js';
import { getStripe } from '@/lib/payments';

/** Dark or light, read from the page's actual background so the iframe matches the theme. */
function isDarkPage(): boolean {
  if (typeof window === 'undefined') return false;
  const bg = getComputedStyle(document.body).backgroundColor;
  const m = bg.match(/\d+/g);
  if (!m) return false;
  const [r, g, b] = m.map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

/**
 * Stripe Elements for one intent's `clientSecret`. Card data is collected
 * inside Stripe's iframe and sent straight to Stripe; this app never sees it.
 */
export function StripeElements({
  publishableKey,
  clientSecret,
  children,
}: {
  publishableKey: string;
  clientSecret: string;
  children: React.ReactNode;
}) {
  const stripePromise = useMemo(() => getStripe(publishableKey), [publishableKey]);
  const appearance: Appearance = useMemo(
    () => ({
      theme: isDarkPage() ? 'night' : 'stripe',
      variables: { colorPrimary: '#0f9e8e', borderRadius: '8px', fontFamily: 'inherit' },
    }),
    [],
  );
  return (
    <Elements stripe={stripePromise} options={{ clientSecret, appearance }} key={clientSecret}>
      {children}
    </Elements>
  );
}
