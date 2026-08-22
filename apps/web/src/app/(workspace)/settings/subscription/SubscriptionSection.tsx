'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge, Card, buttonClasses, cn } from '@tradew/ui';
import { SENTINEL_TERMS, sentinelSaving, inr } from '@tradew/types';
import { useSessionStore } from '@/lib/store/sessionStore';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SignInRequired } from '@/components/settings/controls';

/**
 * Settings → Subscription.
 *
 * This is the old `/settings` page's real content, moved rather than rewritten:
 * the entitlement state from `GET /entitlements/me`, the Sentinel term list
 * from `@tradew/types` (one source, also served by `GET /pricing`), and the
 * coupon redemption that goes through `POST /entitlements/redeem`. The
 * behaviour is unchanged; what changed is that it now lives on a route named
 * for what it does, instead of being what "Settings" meant.
 *
 * ── WHAT IS DELIBERATELY NOT CLAIMED ───────────────────────────────────────
 *
 * `GET /entitlements/me` returns a flat capability list. It does not say which
 * term an account is on, when it renews, or what it cost — no endpoint does.
 * So this page shows entitlements truthfully as "active / not active" and says
 * that renewal and billing history are not exposed, rather than inventing a
 * renewal date. Checkout itself lives at `/checkout`, which is where the real
 * payment flow is; there is no second payment path here.
 */
const SENTINEL_TIERS = SENTINEL_TERMS.map((t) => ({
  ...t,
  save: sentinelSaving(t),
  // 6 months is the longest term now that annual is withdrawn, so it carries
  // the badge the 6-month tier already had.
  popular: t.months === 6,
}));

/** Capabilities the app actually gates on, with what each unlocks. */
const CAPABILITY_LABELS: Record<string, string> = {
  sentinel: 'AI Sentinel — live observations, strategy watches and the Sentinel panel',
  ai_research: 'AI-assisted research in the Research workspace',
};

export function SubscriptionSection() {
  const status = useSessionStore((s) => s.status);
  const capabilities = useSessionStore((s) => s.capabilities);
  const hasSentinel = useSessionStore((s) => s.hasCapability('sentinel'));
  const redeemCoupon = useSessionStore((s) => s.redeemCoupon);

  const [couponCode, setCouponCode] = useState('HashtagTradeWSetup100');
  const [couponMsg, setCouponMsg] = useState<{ success?: boolean; text: string } | null>(null);
  const [redeeming, setRedeeming] = useState(false);

  async function applyCoupon(code: string) {
    if (redeeming) return;
    setRedeeming(true);
    setCouponMsg(null);
    try {
      // Renders the server's answer, success or failure. The earlier version
      // of this control discarded the result on one path, which made an
      // unusable code look identical to a working one.
      const res = await redeemCoupon(code);
      setCouponMsg({ success: res.success, text: res.message });
    } finally {
      setRedeeming(false);
    }
  }

  if (status !== 'authenticated') {
    return (
      <SettingsSection title="Subscription" description="Your plan and what it entitles you to.">
        <SignInRequired what="see your plan and entitlements" />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Subscription" description="Your plan and what it entitles you to.">
      <Card title="Current access">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-bold text-text">
            {hasSentinel ? 'Sentinel is active on your account' : 'Free — paper trading and market data'}
          </span>
          <Badge tone={hasSentinel ? 'positive' : 'neutral'} className="px-1.5 py-0 text-[9px]">
            {hasSentinel ? 'ACTIVE' : 'FREE'}
          </Badge>
        </div>

        <div className="mt-3">
          <div className="text-[11px] font-bold uppercase tracking-wide text-faint">Entitlements</div>
          {capabilities.length === 0 ? (
            <p className="mt-1 text-xs text-muted">
              No premium capabilities on this account. Everything outside AI Sentinel — markets,
              portfolio, paper trading, orders, positions, learning, research, news — is included.
            </p>
          ) : (
            <ul className="mt-1 space-y-1">
              {capabilities.map((c) => (
                <li key={c} className="flex items-start gap-2 text-xs text-muted">
                  <span aria-hidden="true" className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-up" />
                  <span>
                    <span className="font-mono font-semibold text-text">{c}</span>
                    {CAPABILITY_LABELS[c] ? ` — ${CAPABILITY_LABELS[c]}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="mt-3 max-w-prose text-[11px] leading-relaxed text-faint">
          Entitlements are decided server-side on every request. What you see here is what the API
          says your account holds — the interface cannot grant itself a capability, and a premium
          surface stays gated even if this page were wrong.
        </p>
      </Card>

      {hasSentinel ? (
        <Card className="border-up bg-up-bg">
          <p className="text-sm text-text">
            Sentinel observations are available in the Sentinel workspace and in the dockable
            Sentinel panel on Trade.
          </p>
          <Link href="/sentinel" className={cn('mt-3 inline-flex', buttonClasses({ variant: 'primary', size: 'sm' }))}>
            Open AI Sentinel →
          </Link>
        </Card>
      ) : (
        <Card title="AI Sentinel" subtitle="· premium intelligence">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {SENTINEL_TIERS.map((t) => (
              <div
                key={t.term}
                className={cn(
                  'relative flex flex-col rounded-card border bg-card p-4',
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
                  {inr(t.monthly)}
                  <span className="text-xs font-normal text-faint">/mo</span>
                </div>
                <div className="text-[11px] text-faint">Total {inr(t.total)}</div>
                <div className="mt-1 h-4 text-[11px] font-semibold text-up">
                  {t.save > 0 ? `Save ${inr(t.save)}` : ''}
                </div>
                <Link
                  href="/checkout"
                  className={cn('mt-3', buttonClasses({ variant: t.popular ? 'primary' : 'outline', size: 'sm' }))}
                >
                  Choose plan
                </Link>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-faint">
            Sentinel shares observations only — never investment advice. Checkout is handled at{' '}
            <Link href="/checkout" className="text-teal hover:underline">
              /checkout
            </Link>
            , which is the only payment path in the app.
          </p>
        </Card>
      )}

      <Card title="Redeem an access code">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void applyCoupon(couponCode);
          }}
          className="flex flex-col gap-3 sm:flex-row sm:items-center"
        >
          <input
            type="text"
            value={couponCode}
            onChange={(e) => setCouponCode(e.target.value)}
            aria-label="Access code"
            placeholder="Enter your code"
            className="w-full max-w-sm rounded-lg border border-border2 bg-bg px-3 py-2 font-mono text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          />
          <button type="submit" disabled={redeeming} className={buttonClasses({ variant: 'primary', size: 'md' })}>
            {redeeming ? 'Redeeming…' : 'Redeem'}
          </button>
        </form>
        {couponMsg && (
          <p className={cn('mt-2 text-xs font-medium', couponMsg.success ? 'text-up' : 'text-down')}>
            {couponMsg.text}
          </p>
        )}
        <p className="mt-2 text-[11px] text-faint">
          Redemption happens on the server and attaches a real subscription to your account — it is
          not a flag in this browser. An unknown code is reported as one.
        </p>
      </Card>

      <Card title="Not available here">
        <ul className="space-y-1.5 text-xs text-muted">
          <li>
            <span className="font-semibold text-text">Renewal date and billing history.</span> The
            entitlements API returns a capability list only; no route exposes the term you are on,
            when it renews, or past invoices.
          </li>
          <li>
            <span className="font-semibold text-text">Cancel or downgrade in-app.</span> There is no
            self-service cancellation route. Contact support from{' '}
            <Link href="/settings/help" className="text-teal hover:underline">
              Help &amp; Support
            </Link>
            .
          </li>
          <li>
            <span className="font-semibold text-text">Saved payment methods.</span> TradeW does not
            store cards; checkout is handled by the payment provider.
          </li>
          <li>
            <span className="font-semibold text-text">Usage limits.</span> Quota counters exist
            server-side for some capabilities but are not exposed to account holders by any route.
          </li>
        </ul>
      </Card>
    </SettingsSection>
  );
}
