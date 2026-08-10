'use client';

import { useState } from 'react';
import Link from 'next/link';
import { buttonClasses } from '@tradew/ui';
import { OBSERVATION_ONLY_DISCLAIMER } from '@/lib/sentinel/types';
import { useSessionStore } from '@/lib/store/sessionStore';
import { SentinelIcon } from '../shell/icons';

/**
 * Shown to authenticated users who lack the `sentinel` capability.
 * Displays upgrade CTA and 100% free coupon redemption option.
 */
export function SentinelLocked() {
  const redeemCoupon = useSessionStore((s) => s.redeemCoupon);
  const [couponCode, setCouponCode] = useState('HashtagTradeWSetup100');
  const [couponMsg, setCouponMsg] = useState<{ success?: boolean; text: string } | null>(null);

  const handleApplyCoupon = (e: React.FormEvent) => {
    e.preventDefault();
    const res = redeemCoupon(couponCode);
    setCouponMsg({ success: res.success, text: res.message });
  };

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-5 py-20 text-center">
      <SentinelIcon className="h-8 w-8 text-teal" aria-hidden="true" />
      <h1 className="text-lg font-bold text-text">Sentinel is a paid safety layer</h1>
      <p className="text-sm text-muted">{OBSERVATION_ONLY_DISCLAIMER} Unlock it to see live market context and safety observations for every session.</p>

      <form onSubmit={handleApplyCoupon} className="w-full space-y-2.5 rounded-xl border border-border bg-card p-4 shadow-elev2">
        <p className="text-xs font-semibold text-text">Testing Coupon Code Upgrade</p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={couponCode}
            onChange={(e) => setCouponCode(e.target.value)}
            placeholder="Enter coupon code"
            className="w-full rounded-lg border border-border2 bg-bg px-3 py-2 text-xs text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus font-mono"
          />
          <button type="submit" className={buttonClasses({ variant: 'primary', size: 'sm' })}>
            Redeem 100% Off
          </button>
        </div>
        {couponMsg && (
          <p className={`text-xs font-medium ${couponMsg.success ? 'text-up' : 'text-down'}`}>
            {couponMsg.text}
          </p>
        )}
        <p className="text-[10.5px] text-faint">
          Use code <span className="font-mono text-teal font-semibold">HashtagTradeWSetup100</span> for 1 Month 100% Free PRO
        </p>
      </form>

      <Link href="/settings" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
        Choose standard plan
      </Link>
      <p className="text-[11px] text-faint">Observation only — never investment advice.</p>
    </div>
  );
}
