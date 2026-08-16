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
import { RazorpayClient } from '../payments/razorpay.client';

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
 * one list, in `@tradew/types`, served here, consumed by every surface.
 *
 * ── WHY `billingEnabled` IS ASKED, NOT ASSERTED ────────────────────────────
 *
 * It used to be the literal `false`, written when no payment provider was
 * wired. One is wired now, and a constant cannot notice that: the moment
 * `RAZORPAY_KEY_ID`/`_SECRET` are set, `/payments/catalog` reports billing on
 * (`payment.service.ts` reads `RazorpayClient.configured`) while this route
 * would still tell every landing-page visitor "Payments are not enabled yet.
 * No account can be charged." — on a server that is charging accounts. Two
 * endpoints, one question, opposite answers, and the wrong one is the one
 * signed-out visitors see.
 *
 * So both routes now ask the same object. `RazorpayClient` owns what
 * "configured" means, and this controller does not get its own opinion about
 * it. The honesty this payload commits to is only worth anything if it tracks
 * the server's actual state.
 */
@ApiTags('pricing')
@Controller('pricing')
export class PricingController {
  constructor(private readonly razorpay: RazorpayClient) {}

  @ApiResponse({
    status: 200,
    description:
      'The active price list. Sentinel has exactly three terms — 1, 3 and 6 months. There is no annual term.',
  })
  @Get()
  get() {
    const billingEnabled = this.razorpay.configured;
    return {
      currency: CURRENCY,
      sentinel: SENTINEL_TERMS.map((t) => ({ ...t, saving: sentinelSaving(t) })),
      learning: { monthly: LEARNING_MONTHLY },
      demoPasses: DEMO_PASSES,
      free: { paperOrdersPerDay: FREE_PAPER_ORDERS_PER_DAY },
      // Stated in the payload rather than only in the UI: any client rendering
      // this list is obliged to say the same thing, and a client that forgets
      // cannot claim it was not told.
      billingEnabled,
      // Dropped entirely once billing is on — a `notice` that is present but
      // empty is something clients render as a blank callout, and one that
      // still reads "not enabled" would be the very lie this route exists to
      // avoid. Absent means "nothing to disclose".
      ...(billingEnabled ? {} : { notice: 'Payments are not enabled yet. No account can be charged.' }),
    };
  }
}
