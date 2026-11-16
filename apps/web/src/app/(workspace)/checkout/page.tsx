import { Suspense } from 'react';
import { CheckoutClient } from './CheckoutClient';

export const metadata = {
  title: 'Checkout · TradeW',
  description: 'Subscribe to Learning Pro or Sentinel Pro.',
};

export default function CheckoutPage() {
  return (
    <Suspense fallback={null}>
      <CheckoutClient />
    </Suspense>
  );
}
