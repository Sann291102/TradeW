'use client';

import { useCallback, useEffect, useState } from 'react';
import { SENTINEL_TERMS, SENTINEL_TRIAL, sentinelSaving, inr } from '@tradew/types';
import { buttonClasses, cn } from '@tradew/ui';
import { Reveal } from '@/components/common/Reveal';
import { useSessionStore } from '@/lib/store/sessionStore';
import {
  fetchCatalog,
  fetchTrialStatus,
  startCheckout,
  verifyPayment,
  loadRazorpay,
  openRazorpay,
  type Catalog,
  type TrialStatus,
} from '@/lib/payments';
import { PricingTierCard, type PricingTier } from './pricing/PricingTierCard';
import { TrialOffer } from './pricing/TrialOffer';
import { SentinelPreview } from './pricing/SentinelPreview';
import { FeatureList } from './pricing/FeatureList';

/**
 * What `/sentinel` renders for a signed-in account without the capability.
 *
 * A VIEW, NOT A ROUTE. It replaced a standalone public `/sentinel/pricing`
 * (archived 2026-08-15): the page is the same, but it now renders inside the
 * workspace shell, so the sidebar stays put and buying flips this view for the
 * workspace with no navigation at all. Everything that made the old route
 * awkward — a public marketing page that had to bootstrap its own session, then
 * `router.replace` you somewhere else after payment — was a consequence of it
 * being a separate route.
 *
 * Callers guarantee an authenticated session, so there is no signed-out branch
 * here. Activation is reported UP via `onActivated`; this component never
 * navigates and never reloads.
 *
 * Prices render from `@tradew/types` immediately and are overwritten by
 * `/payments/catalog` when it lands — the server is authoritative, but the page
 * must never show a priceless card while waiting for it.
 */
export function SentinelPricingView({ onActivated }: { onActivated: () => void }) {
  const user = useSessionStore((s) => s.user);
  const refreshSession = useSessionStore((s) => s.init);
  const redeemCoupon = useSessionStore((s) => s.redeemCoupon);

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [trialStatus, setTrialStatus] = useState<TrialStatus | null>(null);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const [couponCode, setCouponCode] = useState('HashtagTradeWSetup100');
  const [couponMsg, setCouponMsg] = useState<{ success?: boolean; text: string } | null>(null);
  const [redeeming, setRedeeming] = useState(false);

  useEffect(() => {
    fetchCatalog()
      .then(setCatalog)
      .catch(() =>
        setMessage({ tone: 'bad', text: 'Could not reach the payment service. Prices shown may be out of date.' }),
      );
    fetchTrialStatus().then(setTrialStatus).catch(() => undefined);
  }, []);

  /**
   * Refresh entitlements and tell the parent. No redirect: the capability
   * arriving in the store is what swaps this view for the workspace.
   */
  const activate = useCallback(async () => {
    await refreshSession();
    onActivated();
  }, [refreshSession, onActivated]);

  const buy = useCallback(
    async (itemId: string) => {
      if (!catalog?.billingEnabled) return;
      setBusyItem(itemId);
      setMessage(null);
      try {
        const ready = await loadRazorpay();
        if (!ready) throw new Error('Could not load the payment widget. Check your connection and retry.');

        const order = await startCheckout(itemId);
        const success = await openRazorpay(order, { email: user?.email });
        if (!success) {
          setBusyItem(null); // modal dismissed; nothing charged
          return;
        }

        const result = await verifyPayment({
          itemId,
          razorpayOrderId: success.razorpay_order_id,
          razorpayPaymentId: success.razorpay_payment_id,
          razorpaySignature: success.razorpay_signature,
        });
        if (!result.ok) throw new Error('Payment could not be verified.');

        await activate();
      } catch (e) {
        setMessage({
          tone: 'bad',
          text: e instanceof Error ? e.message : 'Something went wrong. Nothing was charged.',
        });
      } finally {
        setBusyItem((cur) => (cur === itemId ? null : cur));
      }
    },
    [catalog, user, activate],
  );

  const handleRedeem = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (redeeming) return;
      setRedeeming(true);
      setCouponMsg(null);
      try {
        const res = await redeemCoupon(couponCode);
        setCouponMsg({ success: res.success, text: res.message });
        // Redemption grants the same capability a purchase does, so it must
        // flip the view the same way.
        if (res.success) await activate();
      } finally {
        setRedeeming(false);
      }
    },
    [redeeming, redeemCoupon, couponCode, activate],
  );

  const billingEnabled = Boolean(catalog?.billingEnabled);
  const ctaLabel = billingEnabled ? 'Checkout' : 'Unavailable';

  const tiers: PricingTier[] = SENTINEL_TERMS.map((t) => {
    const fromServer = catalog?.items.find((i) => i.id === t.id);
    const saving = sentinelSaving(t);
    return {
      id: t.id,
      term: t.term,
      totalLabel: fromServer?.amountLabel ?? inr(t.total),
      monthlyLabel: inr(t.monthly),
      months: t.months,
      savingLabel: saving > 0 ? inr(saving) : undefined,
      highlight: t.months === 6,
    };
  });
  tiers.push({ id: 'coming_soon', term: 'More terms', placeholder: true });

  const trial = catalog?.trial ?? {
    id: SENTINEL_TRIAL.id,
    label: `Sentinel Pro — ${SENTINEL_TRIAL.term}`,
    days: SENTINEL_TRIAL.days,
    amountInr: SENTINEL_TRIAL.price,
    amountLabel: inr(SENTINEL_TRIAL.price),
    dailyRateLabel: inr(SENTINEL_TRIAL.dailyRate),
    discountPct: SENTINEL_TRIAL.discountPct,
  };

  return (
    <div className="mx-auto max-w-[1100px]">
      <Reveal>
        <p className="text-[11px] font-bold uppercase tracking-wide text-teal">Premium workspace</p>
        <h1 className="mt-2.5 max-w-2xl text-[28px] font-extrabold leading-tight tracking-tightTrack text-text sm:text-[34px]">
          A second set of eyes on the market, and on you.
        </h1>
        <p className="mt-3.5 max-w-2xl text-[13.5px] leading-relaxed text-muted">
          Sentinel watches market structure and your own trading behaviour in parallel, and speaks up only when
          something clears a deliberately strict bar. It explains what it saw and why — it never tells you what
          to buy.
        </p>
      </Reveal>

      {message && (
        <div
          className={`mt-6 rounded-lg border px-3.5 py-2.5 text-[12.5px] ${
            message.tone === 'ok' ? 'border-teal bg-teal-bg text-teal' : 'border-down bg-down-bg text-down'
          }`}
          role="status"
        >
          {message.text}
        </div>
      )}

      {catalog && !billingEnabled && (
        <div className="mt-6 rounded-lg border border-border bg-card px-3.5 py-2.5 text-[12.5px] text-muted">
          {catalog.notice || 'Payments are not enabled yet. No account can be charged.'}
        </div>
      )}

      <Reveal className="mt-12">
        <h2 className="text-[19px] font-extrabold tracking-tightTrack text-text">What Sentinel does</h2>
        <div className="mt-5">
          <FeatureList />
        </div>
      </Reveal>

      <Reveal className="mt-12">
        <h2 className="text-[19px] font-extrabold tracking-tightTrack text-text">What it looks like in use</h2>
        <p className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-muted">
          An illustration of the shape of an observation — a state, a confidence, and the evidence beneath it.
          Not live market data.
        </p>
        <div className="mt-5">
          <SentinelPreview />
        </div>
      </Reveal>

      <Reveal className="mt-12">
        <TrialOffer
          trial={trial}
          status={trialStatus}
          disabled={!billingEnabled}
          busy={busyItem === trial.id}
          ctaLabel={billingEnabled ? 'Start trial' : 'Unavailable'}
          onStart={() => buy(trial.id)}
        />
      </Reveal>

      <Reveal className="mt-12">
        <h2 className="text-[19px] font-extrabold tracking-tightTrack text-text">Or pick a term</h2>
        <p className="mt-1.5 text-[12.5px] text-muted">
          Billed once, up front. Access ends when the term does — nothing auto-renews.
        </p>

        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {tiers.map((t) => (
            <PricingTierCard
              key={t.id}
              tier={t}
              busy={busyItem === t.id}
              disabled={!billingEnabled}
              ctaLabel={ctaLabel}
              onCheckout={buy}
            />
          ))}
        </div>

        <p className="mt-5 text-[11.5px] leading-relaxed text-faint">
          Prices are exclusive of GST. Payments are processed securely by Razorpay — TradeW never sees your card
          details. Sentinel is observation and education only: it does not place orders, and paying for it does
          not change how or whether your orders execute.
        </p>
      </Reveal>

      {/* Preserved from the archived SentinelLocked panel — the only surface
          this code has ever had. */}
      <Reveal className="mt-12">
        <form
          onSubmit={handleRedeem}
          className="space-y-2.5 rounded-xl border border-border bg-card p-4 shadow-elev2"
        >
          <p className="text-xs font-semibold text-text">Have a code?</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={couponCode}
              onChange={(e) => setCouponCode(e.target.value)}
              placeholder="Enter coupon code"
              className="w-full max-w-sm rounded-lg border border-border2 bg-bg px-3 py-2 font-mono text-xs text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus"
            />
            <button
              type="submit"
              disabled={redeeming}
              className={cn(buttonClasses({ variant: 'outline', size: 'sm' }), redeeming && 'opacity-60')}
            >
              {redeeming ? 'Redeeming…' : 'Redeem'}
            </button>
          </div>
          {couponMsg && (
            <p className={`text-xs font-medium ${couponMsg.success ? 'text-up' : 'text-down'}`}>
              {couponMsg.text}
            </p>
          )}
        </form>
      </Reveal>
    </div>
  );
}
