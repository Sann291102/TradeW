'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, Badge, buttonClasses, cn } from '@tradew/ui';
import { SENTINEL_TERMS, sentinelSaving, inr } from '@tradew/types';
import { useSessionStore } from '@/lib/store/sessionStore';

/**
 * Sentinel terms now come from `@tradew/types` rather than being retyped here.
 *
 * They used to be a local literal, and a second copy lived on the marketing
 * landing page — which is how a product ends up quoting one price to a visitor
 * and a different one to a subscriber. One list, one file, served by
 * `GET /pricing` for anything that needs it over the wire.
 *
 * The 9- and 12-month terms were withdrawn 2026-08-11; they are absent from the
 * source list rather than filtered out here, so there is no local code path
 * that could render one.
 */
const SENTINEL_TIERS = SENTINEL_TERMS.map((t) => ({
  ...t,
  save: sentinelSaving(t),
  // 6 months is the longest term now that annual is gone, so it carries the
  // badge the 6-month tier already had.
  popular: t.months === 6,
}));

const inr0 = inr;

/**
 * Settings + Plans workspace (Milestone 4, Step 1). The Sentinel section now
 * reflects the REAL entitlement state from GET /entitlements/me
 * ('sentinel' capability) instead of always rendering "Choose plan" — the
 * milestone's own rule ("no premium analysis without entitlement" /
 * SUBSCRIPTIONS.md §4) requires the reverse to be true too: don't show an
 * upgrade CTA to someone who's already entitled.
 *
 * The endpoint only returns a flat capability list, not which specific term a
 * user is on (no such endpoint exists yet) — so an entitled user sees one
 * "Active" state across the section rather than a per-tier guess.
 */
export function SettingsClient() {
  const sessionStatus = useSessionStore((s) => s.status);
  const sessionUser = useSessionStore((s) => s.user);
  const hasSentinel = useSessionStore((s) => s.hasCapability('sentinel'));
  const redeemCoupon = useSessionStore((s) => s.redeemCoupon);
  const [couponCode, setCouponCode] = useState('HashtagTradeWSetup100');
  const [couponMsg, setCouponMsg] = useState<{ success?: boolean; text: string } | null>(null);

  const handleApplyCoupon = (e: React.FormEvent) => {
    e.preventDefault();
    const res = redeemCoupon(couponCode);
    setCouponMsg({ success: res.success, text: res.message });
  };

  return (
    <div className="mx-auto max-w-[1100px] space-y-6 p-4">
      <Card title="Account" subtitle="· paper trader">
        {sessionStatus === 'authenticated' && sessionUser && (
          <p className="mb-4 text-xs text-muted">
            Signed in as <span className="font-semibold text-text">{sessionUser.email}</span> ·{' '}
            <Link href="/profile" className="text-teal hover:underline">
              Edit profile & preferences →
            </Link>
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-faint">Display name</span>
            <input
              defaultValue="Paper Trader"
              className="mt-1 w-full rounded-lg border border-border2 bg-bg px-3 py-2 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            />
          </label>
          <label className="block text-sm">
            <span className="text-faint">Default order product</span>
            <select className="mt-1 w-full rounded-lg border border-border2 bg-bg px-3 py-2 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
              <option>Intraday (MIS)</option>
              <option>Normal (NRML/CNC)</option>
            </select>
          </label>
        </div>
      </Card>

      <Card title="Redeem Testing Coupon" subtitle="· 100% discount for 1 month access">
        <form onSubmit={handleApplyCoupon} className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="text"
            value={couponCode}
            onChange={(e) => setCouponCode(e.target.value)}
            placeholder="Enter coupon code"
            className="w-full max-w-sm rounded-lg border border-border2 bg-bg px-3 py-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus font-mono"
          />
          <button type="submit" className={buttonClasses({ variant: 'primary', size: 'md' })}>
            Redeem Coupon
          </button>
        </form>
        {couponMsg && (
          <p className={`mt-2 text-xs font-medium ${couponMsg.success ? 'text-up' : 'text-down'}`}>
            {couponMsg.text}
          </p>
        )}
      </Card>

      <section>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-bold text-text">Sentinel — premium intelligence</h2>
          {hasSentinel ? (
            <Badge tone="positive" className="px-1.5 py-0 text-[9px]">ACTIVE</Badge>
          ) : (
            <Badge tone="warning" className="px-1.5 py-0 text-[9px]">PRO</Badge>
          )}
        </div>

        {hasSentinel ? (
          <Card className="border-up bg-up-bg">
            <p className="text-sm text-text">
              Sentinel is active on your account. Observations are available in the Sentinel workspace and the
              dockable Sentinel panel.
            </p>
            <Link href="/sentinel" className={cn('mt-3 inline-flex', buttonClasses({ variant: 'primary', size: 'sm' }))}>
              Open Sentinel →
            </Link>
          </Card>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {SENTINEL_TIERS.map((t) => (
                <div
                  key={t.term}
                  className={cn(
                    'relative flex flex-col rounded-card border bg-card p-4 shadow-card',
                    t.popular ? 'border-teal' : 'border-border',
                  )}
                >
                  {t.popular && (
                    <Badge tone="brand" className="absolute -top-2 right-3 px-1.5 py-0 text-[9px]">
                      POPULAR
                    </Badge>
                  )}
                  <div className="text-sm font-semibold text-text">{t.term}</div>
                  <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-text">
                    {inr0(t.monthly)}
                    <span className="text-xs font-normal text-faint">/mo</span>
                  </div>
                  <div className="text-[11px] text-faint">Total {inr0(t.total)}</div>
                  <div className="mt-1 h-4 text-[11px] font-semibold text-up">
                    {t.save > 0 ? `Save ${inr0(t.save)}` : ''}
                  </div>
                  <button
                    onClick={() => {
                      redeemCoupon('HashtagTradeWSetup100');
                    }}
                    className={cn('mt-3', buttonClasses({ variant: t.popular ? 'primary' : 'outline', size: 'sm' }))}
                  >
                    Redeem Free Trial
                  </button>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-faint">
              Sentinel shares observations only — never investment advice. Use code HashtagTradeWSetup100 to test 1 Month free.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
