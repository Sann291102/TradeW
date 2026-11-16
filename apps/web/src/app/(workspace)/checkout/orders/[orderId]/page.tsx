import { Suspense } from 'react';
import { OrderStatusClient } from './OrderStatusClient';

export const metadata = { title: 'Order · TradeW' };

export default async function OrderPage({ params: paramsPromise }: { params: Promise<{ orderId: string }> }) {
  // Next 15+ passes route params as a Promise.
  const params = await paramsPromise;
  return (
    <Suspense fallback={null}>
      <OrderStatusClient orderId={params.orderId} />
    </Suspense>
  );
}
