import { ApiError } from '@/lib/api';

/**
 * Why a Sentinel surface has nothing to show.
 *
 * There is deliberately no demo/sample fallback anywhere in Sentinel.
 * Rendering canned DEMO data on failure meant an expired session, an API
 * outage and a dead Sentinel service all looked like a working product — and
 * the banner told every one of them "sign in for live analysis", which was
 * wrong in two cases out of three. Sentinel shows nothing and names the
 * actual fault.
 *
 * Extracted from `useSentinel` so the strategy/watch workspace classifies
 * failures by the same rules rather than growing a second, subtly different
 * copy of the 401/403 distinction below.
 */
export type SentinelUnavailable =
  | { kind: 'unauthenticated' }
  | { kind: 'entitlement-required' }
  | { kind: 'api-unreachable' }
  | { kind: 'service-error'; status: number; message: string };

/**
 * 401 and 403 are NOT the same fault.
 *
 * Both Sentinel controllers put `AuthGuard` before `CapabilityGuard`
 * (services/api/src/sentinel/*.controller.ts) — AuthGuard throws 401 only when
 * there is no valid session; CapabilityGuard throws 403 only once a session
 * already passed AuthGuard and the `sentinel` capability check came back
 * false. A 403 therefore always means "you are signed in, you're just not
 * entitled to Sentinel" — telling that user "Not signed in" sends them nowhere
 * useful, most confusingly right after they believe they *just* activated
 * Sentinel Pro.
 */
export function classifyFault(err: unknown): SentinelUnavailable {
  if (err instanceof ApiError) {
    if (err.status === 401) return { kind: 'unauthenticated' };
    if (err.status === 403) return { kind: 'entitlement-required' };
    return { kind: 'service-error', status: err.status, message: err.message };
  }
  // fetch itself threw — services/api is not reachable at NEXT_PUBLIC_API_URL.
  return { kind: 'api-unreachable' };
}

/**
 * One sentence naming what actually failed, for surfaces that show a line of
 * text rather than a full empty state. `subject` names the thing that could
 * not be loaded, e.g. "your strategies".
 */
export function faultMessage(fault: SentinelUnavailable, subject: string): string {
  switch (fault.kind) {
    case 'unauthenticated':
      return `Sign in to see ${subject}.`;
    case 'entitlement-required':
      return `${capitalizeFirst(subject)} are part of Sentinel Pro, which this account doesn't have active.`;
    case 'api-unreachable':
      return `The TradeW API could not be reached, so ${subject} could not be loaded.`;
    case 'service-error':
      return `${capitalizeFirst(subject)} could not be loaded (HTTP ${fault.status}: ${fault.message}).`;
  }
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
