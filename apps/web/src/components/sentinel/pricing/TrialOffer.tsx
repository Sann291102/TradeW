'use client';

import { buttonClasses, cn, CandleLoader } from '@tradew/ui';
import type { CatalogTrial, TrialStatus } from '@/lib/payments';

/**
 * The one-time paid trial.
 *
 * The arithmetic is shown rather than asserted — daily rate, the discount, the
 * price — because "20% off" with no visible base is a claim the reader has to
 * take on faith. Every figure comes from the server's catalog, which derives
 * them from the one-month term (see SENTINEL_TRIAL in packages/types), so this
 * component cannot quote a discount the checkout will not honour.
 */
export function TrialOffer({
  trial,
  status,
  disabled: disabledByParent,
  busy,
  ctaLabel,
  onStart,
}: {
  trial: CatalogTrial;
  /** Null while unknown — signed out, or still loading. */
  status: TrialStatus | null;
  /**
   * Purchase policy is the PARENT's to decide, exactly as it is for
   * PricingTierCard — a signed-out visitor's click routes to sign-in and must
   * not be blocked by a payment-provider setting that cannot apply to them yet.
   * Owning that rule in two components is how the trial button ends up
   * disabled on a page whose term buttons are live.
   */
  disabled?: boolean;
  busy: boolean;
  ctaLabel: string;
  onStart: () => void;
}) {
  const claimed = status?.reason === 'already_claimed';
  const disabled = disabledByParent || busy || claimed;

  // `bg-teal-bg`, not `bg-teal/5`: this preset maps colors to var(--token), so
  // Tailwind opacity modifiers are a silent no-op and would paint this panel
  // SOLID teal. Tint tokens are the supported route.
  return (
    <div className="rounded-2xl border border-teal bg-teal-bg p-6 shadow-elev2 sm:p-7">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <span className="inline-block rounded-full bg-teal px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
            {trial.discountPct}% off the daily rate
          </span>

          <h3 className="mt-3 text-[20px] font-extrabold tracking-tightTrack text-text">
            Try Sentinel for {trial.days} days
          </h3>

          <p className="mt-1.5 max-w-lg text-[12.5px] leading-relaxed text-muted">
            The full workspace — every observation, the risk radar, the reasoning behind each card. Not a
            feature-limited preview. It simply ends after {trial.days} days unless you pick a term below.
          </p>

          {/* The derivation, in the open. */}
          <p className="mt-3 font-mono text-[11.5px] text-faint">
            {trial.dailyRateLabel}/day × {trial.days} days − {trial.discountPct}% ={' '}
            <span className="font-semibold text-teal">{trial.amountLabel}</span>
          </p>
        </div>

        <div className="shrink-0 sm:text-right">
          <div className="flex items-baseline gap-1.5 sm:justify-end">
            <span className="text-[32px] font-extrabold tracking-tightTrack text-text">{trial.amountLabel}</span>
            <span className="text-[12px] font-medium text-muted">+ GST</span>
          </div>
          <p className="mt-0.5 text-[11.5px] text-muted">one time, per account</p>

          <button
            type="button"
            onClick={onStart}
            disabled={disabled}
            className={cn(
              buttonClasses({ variant: 'primary', size: 'md' }),
              'mt-4 w-full justify-center sm:w-auto',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            {busy && <CandleLoader size="sm" decorative />}
            {busy ? 'Starting…' : claimed ? 'Already used' : ctaLabel}
          </button>

          {claimed && (
            <p className="mt-2 max-w-[220px] text-[11px] leading-relaxed text-faint sm:ml-auto">
              You have already used your one-time trial. Pick a term below to continue.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
