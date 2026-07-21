import Link from 'next/link';
import { buttonClasses } from '@tradew/ui';
import { OBSERVATION_ONLY_DISCLAIMER } from '@/lib/sentinel/types';
import { SentinelIcon } from '../shell/icons';

/**
 * Shown to authenticated users who lack the `sentinel` capability
 * (SUBSCRIPTIONS.md §4) — gating stays exactly as it was, only the
 * presentation moved to match the new standalone shell. Gated content is
 * always replaced by a visible CTA, never a silent absence.
 */
export function SentinelLocked() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-5 py-24 text-center">
      <SentinelIcon className="h-8 w-8 text-teal" aria-hidden="true" />
      <h1 className="text-lg font-bold text-text">Sentinel is a paid safety layer</h1>
      <p className="text-sm text-muted">{OBSERVATION_ONLY_DISCLAIMER} Unlock it to see live market context and safety observations for every session.</p>
      <Link href="/settings" className={buttonClasses({ variant: 'primary', size: 'md' })}>
        Start free trial
      </Link>
      <p className="text-[11px] text-faint">Observation only — never investment advice.</p>
    </div>
  );
}
