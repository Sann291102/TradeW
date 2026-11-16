import { Suspense } from 'react';
import { OrderStatusClient } from './OrderStatusClient';

export const metadata = { title: 'Order · TradeW' };

export default function OrderPage({ params }: { params: { orderId: string } }) {
  return (
    <Suspense fallback={null}>
      <OrderStatusClient orderId={params.orderId} />
    </Suspense>
  );
}
