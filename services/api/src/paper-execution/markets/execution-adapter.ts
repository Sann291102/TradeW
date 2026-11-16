/**
 * The execution adapter port — how a market-neutral signal becomes a venue
 * order, and the boundary that keeps markets from contaminating each other.
 *
 * ## The risk-isolation requirement, made structural
 *
 * "A BTC experiment must NEVER accidentally place an Indian-market order."
 *
 * Today that guarantee is implied by the code path: `PaperExecutionService`
 * only knows how to build option contracts, so it can only ever produce NSE
 * orders. That is safe by accident of having one implementation, and it stops
 * being safe the moment there are two. What replaces it must be checkable.
 *
 * So the binding is declared and then VERIFIED, in the same shape
 * `ExecutionAccountService` already uses for account scope — whose comment is
 * the precedent worth quoting:
 *
 *   > This column does not GRANT anything — it declares intent, and
 *   > `ExecutionAccountService` checks that the declaration matches the
 *   > account's actual shape. […] Trusting the column alone would make the
 *   > scope a label rather than a boundary.
 *
 * Identically here: a profile names a venue, and `resolveAdapter` refuses when
 * the named venue disagrees with the symbol's own spec, or when an adapter is
 * handed a signal it was not built for. A mislabelled row is a refusal, not a
 * wrong-market order.
 *
 * ## What an adapter owns, and what it must not
 *
 * OWNS — everything venue-specific about turning a direction into an order:
 * which instrument actually gets bought, how size is computed and rounded,
 * which order table the row lands in, and which wallet is debited.
 *
 * MUST NOT — deciding whether to trade. That is `evaluatePolicy`'s job and it
 * stays upstream of every adapter, so a new venue cannot accidentally arrive
 * with weaker risk checks than the one it sits beside. An adapter may only ever
 * SUBTRACT (refuse to materialise); it can never admit something policy denied.
 */

import { tradableSpec, type ExecutionStyle, type MarketVenue } from '@tradew/market-data';
import type { StrategySignal } from './strategy-signal';

/**
 * Why an adapter could not act. Shaped like `PolicyCheck` so a refusal here
 * lands in the same console breakdown as a policy refusal — the question "why
 * did nothing trade?" does not distinguish them, exactly as
 * `REJECT_CHECK_LABELS`' last two entries already argue.
 */
export interface MaterialisationRefusal {
  checkId: string;
  reason: string;
}

/** Every refusal id an adapter may produce, and how to say it to a person. */
export const ADAPTER_REJECT_LABELS: Record<string, string> = {
  'venue-mismatch': 'Profile venue matches the instrument',
  'adapter-style-mismatch': 'Adapter handles this execution style',
  'symbol-not-tradable': 'Instrument is tradable',
  'symbol-unknown': 'Instrument is in the experiment registry',
  'signal-not-directional': 'Signal has a direction',
  'size-below-minimum': 'Size clears the venue minimum',
  'wallet-currency-mismatch': 'Wallet currency matches the venue',
  // Spot crypto cannot hold a short. Counted rather than silently skipped, so
  // the experiment's long-only asymmetry is visible beside its win rate —
  // see `spot-adapter.ts`.
  'spot-long-only': 'Spot account can express this direction',
  // A whole-lot venue whose one lot exceeds what the profile may allocate. The
  // failure mode this names is an agent that never trades and never says why.
  'lot-exceeds-allocation': 'One lot fits the capital allocation',
};

/**
 * A concrete, submittable order — the adapter's output.
 *
 * Deliberately NOT a `Prisma.OrderCreateInput` or a `CryptoOrderCreateInput`:
 * those are two different shapes with two different precisions, and a port that
 * returned either would leak the venue back into the caller. The caller hands
 * this to the adapter's own `submit`, which is the only thing that knows which
 * table it belongs in.
 */
export interface MaterialisedOrder {
  /** The instrument ACTUALLY traded — an option contract, a pair, a future. */
  tradedSymbol: string;
  side: 'BUY' | 'SELL';
  /**
   * Size in the traded instrument's own units.
   *
   * A number, not a Decimal, because it is a computation result rather than a
   * stored value — but adapters whose venue is fractional MUST NOT round it,
   * and adapters whose venue is whole-lot MUST floor it. `TradableSpec`'s
   * `fractionalQuantity` is the authority on which.
   */
  quantity: number;
  /** Expected fill reference, in the TRADED instrument's price space. */
  referencePrice: number;
  /** Protective levels, translated into the traded instrument's space. */
  stopLoss: number | null;
  target: number | null;
  /** Currency the notional is denominated in. Never converted. */
  currency: 'INR' | 'USD';
  /** Human-readable account of what was built and why, for the trace. */
  explanation: string;
}

/** Everything an adapter needs that is not on the signal itself. */
export interface MaterialisationContext {
  profileId: string;
  accountUserId: string;
  /** The venue the profile DECLARES it trades. Verified, never trusted. */
  declaredVenue: MarketVenue;
  /** Capital the wallet can actually commit, in the venue's own currency. */
  availableCapital: number;
  /** From `ExecutionProfile`. Percentages of three different bases — see the
   *  schema comment on `capitalAllocationPct`, which is the authority. */
  capitalAllocationPct: number;
  riskPerTradePct: number;
  rewardPerTradePct: number;
}

export type MaterialisationResult =
  | { ok: true; order: MaterialisedOrder }
  | { ok: false; refusal: MaterialisationRefusal };

export interface ExecutionAdapter {
  /** Stable id, recorded on the intent as provenance. */
  readonly id: string;
  /** The one style this adapter handles. Checked, not assumed. */
  readonly style: ExecutionStyle;
  /** The venues it may act on. */
  readonly venues: readonly MarketVenue[];

  materialise(
    signal: StrategySignal,
    context: MaterialisationContext,
  ): Promise<MaterialisationResult>;
}

/**
 * Bind a (symbol, declared venue) pair to its adapter, refusing every
 * disagreement.
 *
 * THE FOUR REFUSALS ARE THE POINT. Each corresponds to a way a misconfigured
 * profile row could otherwise place an order on the wrong market:
 *
 *  1. `symbol-unknown` — a symbol outside the experiment registry has no venue
 *     and no execution style, so nothing can be derived for it safely. Refusing
 *     is the only honest answer; defaulting to the Indian path is precisely the
 *     accident this function exists to prevent.
 *  2. `venue-mismatch` — the row claims MCX for a symbol whose spec says
 *     BINANCE. One of the two is wrong and we cannot know which, so neither is
 *     acted on.
 *  3. `symbol-not-tradable` — the registry says there is no execution path for
 *     this instrument yet (GOLDM has no feed subscription). An agent pointed at
 *     it must stop, not fall through to something adjacent.
 *  4. `adapter-style-mismatch` — belt and braces. If registration is ever wrong,
 *     an option adapter handed a spot signal refuses rather than trying to
 *     invent a strike for Bitcoin.
 */
export function resolveAdapter(
  symbol: string,
  declaredVenue: MarketVenue,
  adapters: readonly ExecutionAdapter[],
): { ok: true; adapter: ExecutionAdapter } | { ok: false; refusal: MaterialisationRefusal } {
  const spec = tradableSpec(symbol);
  if (!spec) {
    return {
      ok: false,
      refusal: {
        checkId: 'symbol-unknown',
        reason: `"${symbol}" is not in the tradable market registry, so no venue or execution style can be derived for it.`,
      },
    };
  }

  if (spec.venue !== declaredVenue) {
    return {
      ok: false,
      refusal: {
        checkId: 'venue-mismatch',
        reason: `Profile declares venue ${declaredVenue}, but ${spec.symbol} trades on ${spec.venue}. Refusing rather than guessing which is correct.`,
      },
    };
  }

  if (!spec.tradeable) {
    return {
      ok: false,
      refusal: {
        checkId: 'symbol-not-tradable',
        reason: `${spec.symbol} is registered but not tradable — there is no execution path for it yet.`,
      },
    };
  }

  const adapter = adapters.find(
    (a) => a.style === spec.executionStyle && a.venues.includes(spec.venue),
  );
  if (!adapter) {
    return {
      ok: false,
      refusal: {
        checkId: 'adapter-style-mismatch',
        reason: `No execution adapter is registered for style "${spec.executionStyle}" on ${spec.venue}.`,
      },
    };
  }

  return { ok: true, adapter };
}
