'use client';

import { buttonClasses, cn, CandleLoader } from '@tradew/ui';
import { CheckIcon } from '@/components/shell/icons';

export interface PricingTier {
  id: string;
  term: string;
  /** Total charged up front, pre-formatted. Absent on a placeholder tier. */
  totalLabel?: string;
  /** Per-month equivalent, pre-formatted. */
  monthlyLabel?: string;
  months?: number;
  /** What this term saves against paying monthly, pre-formatted. */
  savingLabel?: string;
  highlight?: boolean;
  /** A "Coming Soon" placeholder — renders inert, with no price and no button. */
  placeholder?: boolean;
}

/**
 * One pricing tier.
 *
 * GST is stated as "+ GST" rather than folded into the figure, because the
 * amount Razorpay actually charges is `amountInr` — the number on this card.
 * Displaying a tax-inclusive total the checkout would not match is the precise
 * way a pricing page becomes a billing complaint.
 */
export function PricingTierCard({
  tier,
  busy,
  disabled,
  ctaLabel,
  onCheckout,
}: {
  tier: PricingTier;
  busy?: boolean;
  disabled?: boolean;
  ctaLabel: string;
  onCheckout: (id: string) => void;
}) {
  if (tier.placeholder) {
    return (
      <div className="flex flex-col rounded-2xl border border-dashed border-border2 bg-card p-5">
        <div className="text-[13px] font-bold text-muted">{tier.term}</div>
        <div className="mt-4 flex flex-1 items-center justify-center py-8">
          <span className="rounded-full border border-border2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
            Coming Soon
          </span>
        </div>
        <p className="text-[11.5px] leading-relaxed text-faint">
          More terms are planned. Nothing here can be bought yet, and no card is collected.
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'relative flex flex-col rounded-2xl border bg-card p-5 shadow-elev2 transition-colors',
        tier.highlight ? 'border-teal' : 'border-border hover:border-border2',
      )}
    >
      {tier.highlight && (
        <span className="absolute -top-2.5 left-5 rounded-full bg-teal px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
          Best value
        </span>
      )}

      <div className="text-[13px] font-bold text-text">{tier.term}</div>

      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="text-[26px] font-extrabold tracking-tightTrack text-text">{tier.totalLabel}</span>
        <span className="text-[12px] font-medium text-muted">+ GST</span>
      </div>

      {tier.monthlyLabel && (
        <p className="mt-1 text-[12px] text-muted">
          {tier.months && tier.months > 1 ? `${tier.monthlyLabel}/mo × ${tier.months}` : `${tier.monthlyLabel}/mo`}
        </p>
      )}

      {tier.savingLabel ? (
        <p className="mt-2 inline-flex items-center gap-1 text-[11.5px] font-semibold text-up">
          <CheckIcon className="h-3 w-3" aria-hidden="true" />
          Saves {tier.savingLabel}
        </p>
      ) : (
        <p className="mt-2 text-[11.5px] text-faint">Billed once for the full term</p>
      )}

      <button
        type="button"
        onClick={() => onCheckout(tier.id)}
        disabled={disabled || busy}
        className={cn(
          buttonClasses({ variant: tier.highlight ? 'primary' : 'outline', size: 'sm' }),
          'mt-5 w-full justify-center',
          (disabled || busy) && 'cursor-not-allowed opacity-60',
        )}
      >
        {busy && <CandleLoader size="sm" decorative />}
        {busy ? 'Starting…' : ctaLabel}
      </button>
    </div>
  );
}
