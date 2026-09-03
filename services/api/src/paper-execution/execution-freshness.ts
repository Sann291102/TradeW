/**
 * Is the PRICE current?
 *
 * ## The other half of a question `data-quality.ts` only half answers
 *
 * Sentinel's data-quality gate asks how old the BARS were — how current the
 * analysis is. This asks how old the QUOTE is — how current the price is. They
 * fail independently and for different reasons, which is exactly why there are
 * two of them:
 *
 *   · Stored candles are fresh while the live feed is dead, because
 *     `CandleMarketDataProvider` falls back to the Candle table and a
 *     backfilled bar from ten minutes ago is inside every freshness window.
 *   · The live feed is up while its Dhan credential is dead, which is the
 *     2026-08-17 incident: the bridge answered in ~30 ms, streamed a
 *     tick map, and every one of those ticks was from before the token
 *     expired. Nothing about the bars would have noticed.
 *
 * So the agent checks both, and this is the one that catches the second case.
 *
 * ## What it measures, and the proxy it has to accept
 *
 * The bridge's `/quotes` snapshot stamps every `LiveQuote` with `updatedAt` —
 * the moment that instrument's tick was received. That is a genuine measure of
 * feed liveness.
 *
 * There is NO equivalent for an individual option premium. `/optionchain`
 * returns `{ spot, strikes }` with no timestamp anywhere in it, and the live
 * premium overlay (`withLiveOptionPrices`) writes prices in without recording
 * when each arrived. So the option's own age is genuinely unavailable, and
 * this module uses the INDEX quote's age as a proxy for the whole feed's
 * liveness — the two ride the same WebSocket, so a fresh index tick means the
 * socket is alive and delivering.
 *
 * That proxy is stated in the `PaperFillModel` assumptions and in the journal
 * rather than presented as the option's own age, because it is not. A feed
 * that is alive but has not printed THIS strike in ten minutes would pass
 * here, and the honest position is that the platform cannot currently see
 * that.
 */

export interface FreshnessCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface FreshnessRead {
  ok: boolean;
  /** Milliseconds since the newest index tick, or null when unknown. */
  ageMs: number | null;
  /** ISO of the newest tick the feed reported. */
  quotedAt: string | null;
  marketOpen: boolean;
  checks: FreshnessCheck[];
  failedCheckId: string | null;
  reason: string | null;
}

export interface FreshnessInput {
  now: Date;
  /** Newest `updatedAt` across the bridge's index quotes. Null when unknown. */
  quotedAt: Date | null;
  /** The bridge's own session flag. */
  marketOpen: boolean;
  /** From the profile. */
  maxQuoteAgeMs: number;
}

/**
 * Why the default allowance is 15 seconds.
 *
 * The bridge coalesces ticks and flushes them at `BROADCAST_MS = 300`, and it
 * re-broadcasts on a 30-second heartbeat even when nothing ticked. So a
 * healthy index during market hours updates several times a second and, at its
 * very worst, every 30 s on the heartbeat. 15 s sits between those: tight
 * enough that a dead socket is caught within one management tick or two, loose
 * enough that a genuinely quiet instrument does not read as a fault.
 *
 * A LARGER number here is not a safety improvement. This gate stops the agent
 * trading on a price that has stopped moving because the feed died, and every
 * second added is a second of that being allowed.
 */
export const DEFAULT_MAX_QUOTE_AGE_MS = 15_000;

export function assessFreshness(input: FreshnessInput): FreshnessRead {
  const checks: FreshnessCheck[] = [];
  const push = (id: string, label: string, passed: boolean, detail: string) =>
    checks.push({ id, label, passed, detail });

  const ageMs =
    input.quotedAt != null ? Math.max(0, input.now.getTime() - input.quotedAt.getTime()) : null;

  // Unknown age FAILS, deliberately. The alternative — treating "we could not
  // measure it" as "it is fine" — is how a monitoring gap becomes an outage:
  // the one state in which this check would be most valuable is exactly the
  // state in which a bridge that has stopped answering properly produces no
  // timestamp at all.
  if (ageMs == null) {
    push(
      'quote-age',
      'Live quote is current',
      false,
      'The feed reported no tick timestamp, so quote staleness could not be measured. Refusing rather than assuming.',
    );
  } else {
    const fresh = ageMs <= input.maxQuoteAgeMs;
    push(
      'quote-age',
      'Live quote is current',
      fresh,
      fresh
        ? `Newest index tick ${ageMs} ms ago, inside the ${input.maxQuoteAgeMs} ms allowance.`
        : `Newest index tick ${ageMs} ms ago, past the ${input.maxQuoteAgeMs} ms allowance — the feed is answering but not ticking.`,
    );
  }

  push(
    'session-open',
    'Session is open',
    input.marketOpen,
    input.marketOpen
      ? 'The bridge reports the session open.'
      : 'The bridge reports the session closed, so every quote is a last-known price.',
  );

  const failed = checks.find((c) => !c.passed) ?? null;
  return {
    ok: !failed,
    ageMs,
    quotedAt: input.quotedAt ? input.quotedAt.toISOString() : null,
    marketOpen: input.marketOpen,
    checks,
    failedCheckId: failed ? failed.id : null,
    reason: failed ? failed.detail : null,
  };
}
