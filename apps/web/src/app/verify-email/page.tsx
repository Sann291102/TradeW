import { Suspense } from 'react';
import { VerifyEmailClient } from './VerifyEmailClient';

export const metadata = {
  title: 'Verify your email · TradeW',
  description: 'Confirm your email address to finish setting up your TradeW account.',
};

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailClient />
    </Suspense>
  );
}
