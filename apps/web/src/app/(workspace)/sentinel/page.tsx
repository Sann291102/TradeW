'use client';

import { useCallback, useEffect, useState } from 'react';
import { Skeleton } from '@tradew/ui';
import { useSessionStore } from '@/lib/store/sessionStore';
import { SentinelPricingView } from '@/components/sentinel/SentinelPricingView';
import { SentinelWorkspace } from '@/components/sentinel/SentinelWorkspace';
import { SentinelActivatedToast } from '@/components/sentinel/SentinelActivatedToast';

/**
 * `/sentinel` — one route, two views, no navigation between them.
 *
 * Which one renders is a function of the `sentinel` capability in the session
 * store, so buying it does not redirect anywhere: the entitlement refresh that
 * follows a payment re-renders this component and the pricing view is replaced
 * by the workspace in place, with the sidebar untouched.
 *
 * This replaced a standalone public `/sentinel/pricing` route (archived
 * 2026-08-15). Auth is handled where it already was — `middleware.ts` bounces a
 * signed-out visitor to `/?next=%2Fsentinel#auth`, the repo's sign-in path
 * (`/login` is itself only a redirect to `/#auth`).
 *
 * THE THIRD STATE MATTERS. Until the session resolves, `hasCapability` is false
 * for everyone, so branching on it alone would show the pricing page to paying
 * subscribers for one frame on every load. 'idle'/'loading' therefore renders
 * neither view.
 */
export default function SentinelPage() {
  const status = useSessionStore((s) => s.status);
  const hasSentinel = useSessionStore((s) => s.hasCapability('sentinel'));
  const [justActivated, setJustActivated] = useState(false);

  const onActivated = useCallback(() => setJustActivated(true), []);

  // The toast belongs to the workspace that replaces the pricing view, so it
  // outlives the component that triggered it.
  useEffect(() => {
    if (!justActivated) return;
    const t = setTimeout(() => setJustActivated(false), 6000);
    return () => clearTimeout(t);
  }, [justActivated]);

  if (status === 'idle' || status === 'loading') return <SentinelResolving />;

  if (!hasSentinel) return <SentinelPricingShell onActivated={onActivated} />;

  return (
    <>
      {justActivated && <SentinelActivatedToast onDismiss={() => setJustActivated(false)} />}
      <SentinelWorkspace />
    </>
  );
}

function SentinelPricingShell({ onActivated }: { onActivated: () => void }) {
  return (
    <div className="bg-bg">
      <main className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6">
        <SentinelPricingView onActivated={onActivated} />
      </main>
    </div>
  );
}

/** Neither view, while the session is still being established. */
function SentinelResolving() {
  return (
    <div className="bg-bg">
      <main className="mx-auto max-w-[1600px] space-y-4 px-4 py-5 sm:px-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </main>
    </div>
  );
}
