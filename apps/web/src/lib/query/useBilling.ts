'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchCatalog, fetchTrialStatus } from '@/lib/payments';
import { qk } from './keys';

/**
 * The price list and the user's trial state.
 *
 * Two surfaces sell the same thing — `/checkout` and the pricing view inside
 * `/sentinel` — and both called `fetchCatalog()` on mount into their own
 * state. Prices are the one thing in this app that MUST NOT differ between two
 * screens in the same session, and two independent fetches against a catalogue
 * that can be edited server-side is exactly how they come to.
 *
 * One key removes that possibility, and the default five-minute staleTime is
 * right here on its own terms: a price list is not live data, and re-fetching
 * it every time the user opens the pricing panel bought nothing.
 */
export function useCatalog() {
  return useQuery({
    queryKey: qk.billing.catalog(),
    queryFn: fetchCatalog,
  });
}

export function useTrialStatus() {
  return useQuery({
    queryKey: qk.billing.trialStatus(),
    queryFn: fetchTrialStatus,
  });
}
