'use client';

import { CheckIcon, CloseIcon } from '@/components/shell/icons';

/**
 * Confirms the entitlement landed, because the flip itself is silent.
 *
 * Purchase replaces the pricing view with the workspace in place — no
 * navigation, no reload — which is the point, but it also means nothing else on
 * screen says "that worked". A fixed-position notice is deliberately the whole
 * mechanism: the repo has no toast primitive, and adding one for a single
 * message would be infrastructure nobody asked for. The server-side receipt
 * email and the `announcement` notification raised by `PaymentService.fulfil`
 * remain the durable record.
 */
export function SentinelActivatedToast({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-5 right-5 z-50 flex max-w-sm items-start gap-3 rounded-xl border border-teal bg-card p-3.5 shadow-elev3"
    >
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-teal">
        <CheckIcon className="h-3 w-3 text-white" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-[12.5px] font-bold text-text">Sentinel activated</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">Welcome to Safety Nets.</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="ml-1 shrink-0 rounded p-0.5 text-faint hover:text-text"
      >
        <CloseIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
