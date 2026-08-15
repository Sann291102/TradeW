import { Controller, Get } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  CURRENCY,
  DEMO_PASSES,
  FREE_PAPER_ORDERS_PER_DAY,
  LEARNING_MONTHLY,
  SENTINEL_TERMS,
  sentinelSaving,
} from '@tradew/types';

/**
 * The product's own price list, served from one place.
 *
 * ── WHY THIS IS PUBLIC ─────────────────────────────────────────────────────
 *
 * Deliberately unauthenticated. The landing page is the primary consumer and
 * its whole job is reaching people who do not have accounts — putting prices
 * behind a login would mean a signed-out visitor could not find out what the
 * product costs, which is the opposite of the point. Nothing here is
 * user-specific: it is the same list for everyone, and it contains no
 * entitlement state. Whether a given user HAS a plan is `/entitlements/me`,
 * which is authenticated.
 *
 * ── AND WHY IT EXISTS AT ALL ───────────────────────────────────────────────
 *
 * Prices previously lived in two hardcoded frontend copies with no server
 * involvement. This is the "backend pricing configuration" that was missing:
 * one list, in `@tradew/types`, served here, consumed by every surface. It does
 * not charge anyone — no payment provider is wired (SUBSCRIPTIONS.md §6).
 */
@ApiTags('pricing')
@Controller('pricing')
export class PricingController {
  @ApiResponse({
    status: 200,
    description:
      'The active price list. Sentinel has exactly three terms — 1, 3 and 6 months. There is no annual term.',
  })
  @Get()
  get() {
    return {
      currency: CURRENCY,
      sentinel: SENTINEL_TERMS.map((t) => ({ ...t, saving: sentinelSaving(t) })),
      learning: { monthly: LEARNING_MONTHLY },
      demoPasses: DEMO_PASSES,
      free: { paperOrdersPerDay: FREE_PAPER_ORDERS_PER_DAY },
      // Stated in the payload rather than only in the UI: any client rendering
      // this list is obliged to say the same thing, and a client that forgets
      // cannot claim it was not told.
      billingEnabled: false,
      notice: 'Payments are not enabled yet. No account can be charged.',
    };
  }
}
