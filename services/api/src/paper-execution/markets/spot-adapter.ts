/**
 * Spot execution adapter — Binance crypto.
 *
 * Turns a directional signal into a spot purchase. The simplest of the three
 * adapters, and deliberately so: the analysed instrument IS the traded one, so
 * there is no contract to select, no expiry to resolve, and no premium-space
 * translation of the stop and target.
 *
 * ## The short constraint is real, and it is NOT a gap
 *
 * `CryptoPosition.quantity` is documented as "Always >= 0. Spot only — there is
 * no short side to represent", and `CryptoWallet` has no margin component
 * because "a buy costs its full USD notional and a sell requires already
 * holding the asset". A bearish signal therefore has no expression here.
 *
 * Three ways that could have been handled, and why this one:
 *
 *   · Silently skip bearish signals — rejected. The experiment's whole purpose
 *     is comparing strategies across markets, and a market that quietly
 *     discards half its signals would report a win rate computed on a filtered
 *     sample while looking like a complete one. That is the most expensive kind
 *     of wrong number this comparison could produce.
 *   · Invert into a "sell what we hold" exit — rejected. That conflates a new
 *     bearish ENTRY with an exit of an existing long. They are different
 *     decisions with different outcomes, and merging them would make the
 *     journal unable to tell them apart.
 *   · Refuse explicitly, with a counted reason — CHOSEN. `evaluatePolicy`'s
 *     refusals are already grouped by `failedCheckId` in the console's "why did
 *     nothing trade today?" breakdown, so a bearish BTC signal shows up there as
 *     a named bar. The asymmetry becomes VISIBLE data about the experiment
 *     rather than an invisible filter on it.
 *
 * The honest consequence: crypto results in the comparison table are long-only.
 * That is a property of the experiment and must be read alongside its win rate,
 * not discovered later.
 */

import type { MarketVenue } from '@tradew/market-data';
import { tradableSpec } from '@tradew/market-data';
import type {
  ExecutionAdapter,
  MaterialisationContext,
  MaterialisationResult,
} from './execution-adapter';
import { isActionable, type StrategySignal } from './strategy-signal';

/**
 * Smallest notional an order may carry, in the venue's quote currency.
 *
 * Binance's own spot minimum for USDT pairs is 10 USDT (`MIN_NOTIONAL`). Below
 * it a real order would be rejected by the exchange, so a paper fill under it
 * would be modelling something that could not happen — the same reasoning that
 * makes `execution-fill.ts` refuse to fill an illiquid strike at ₹0.
 */
const MIN_NOTIONAL_USD = 10;

/**
 * Decimal places a spot size is rounded to.
 *
 * 8 is Binance's own quote precision and matches `CryptoOrder.quantity`'s
 * `Decimal(28,8)`. Rounding DOWN, never to nearest: rounding up would size a
 * position the wallet cannot afford, and the resulting shortfall would surface
 * as a failed submission rather than as the smaller position it should be.
 */
const QUANTITY_DP = 8;

function floorTo(value: number, dp: number): number {
  const factor = 10 ** dp;
  return Math.floor(value * factor) / factor;
}

export class SpotExecutionAdapter implements ExecutionAdapter {
  readonly id = 'spot-binance';
  readonly style = 'spot' as const;
  readonly venues: readonly MarketVenue[] = ['BINANCE'];

  async materialise(
    signal: StrategySignal,
    context: MaterialisationContext,
  ): Promise<MaterialisationResult> {
    const spec = tradableSpec(signal.symbol);
    if (!spec) {
      return {
        ok: false,
        refusal: {
          checkId: 'symbol-unknown',
          reason: `"${signal.symbol}" is not in the tradable market registry.`,
        },
      };
    }

    if (!isActionable(signal)) {
      return {
        ok: false,
        refusal: {
          checkId: 'signal-not-directional',
          reason: 'The signal has no direction; a neutral read is not a weak buy.',
        },
      };
    }

    // The long-only refusal. Named and counted, never silent — see the header.
    if (signal.bias === 'bearish') {
      return {
        ok: false,
        refusal: {
          checkId: 'spot-long-only',
          reason:
            `A bearish read on ${spec.symbol} has no expression in a spot-only account: ` +
            'CryptoPosition cannot hold a short, and there is no margin model to borrow against. ' +
            'Recorded as a refusal so the experiment\'s long-only asymmetry is visible in the results.',
        },
      };
    }

    if (context.availableCapital <= 0) {
      return {
        ok: false,
        refusal: {
          checkId: 'affordable',
          reason: 'The paper wallet has no free capital to commit.',
        },
      };
    }

    const price = signal.referencePrice;
    if (!(price > 0)) {
      return {
        ok: false,
        refusal: {
          checkId: 'quote-freshness',
          reason: `No usable ${spec.symbol} price at decision time; nothing can be sized against it.`,
        },
      };
    }

    // ONE position's share of the wallet. `capitalAllocationPct` is a percentage
    // of EQUITY, per the schema's three-percentages comment — the caller has
    // already resolved equity into `availableCapital`, so this must not apply a
    // second percentage to a number that is already a percentage.
    const allocated = context.availableCapital * (context.capitalAllocationPct / 100);
    if (allocated < MIN_NOTIONAL_USD) {
      return {
        ok: false,
        refusal: {
          checkId: 'size-below-minimum',
          reason:
            `A ${context.capitalAllocationPct}% allocation of ${context.availableCapital.toFixed(2)} USD ` +
            `is ${allocated.toFixed(2)} USD, below the ${MIN_NOTIONAL_USD} USD venue minimum.`,
        },
      };
    }

    // Floored, never rounded — see QUANTITY_DP. Fractional is correct here and
    // is exactly what the rupee `Order.quantity Int` could not express, which is
    // why crypto routes to CryptoOrder rather than to the OMS.
    const quantity = floorTo(allocated / price, QUANTITY_DP);
    if (!(quantity > 0)) {
      return {
        ok: false,
        refusal: {
          checkId: 'size-below-minimum',
          reason: `${allocated.toFixed(2)} USD at ${price} buys less than the smallest representable size (1e-${QUANTITY_DP}).`,
        },
      };
    }

    const notional = quantity * price;

    // Stop and target pass THROUGH untranslated — the analysed instrument is the
    // traded one. The option adapter is where this stops being true.
    //
    // When the strategy declared no level, the risk percentages derive one from
    // the allocation. Derived levels are marked as such in the explanation so a
    // journal reader can tell a strategy's own stop from a policy-derived one;
    // conflating them would make the strategy look more specific than it was.
    const derivedStop =
      signal.stopLoss ?? price * (1 - context.riskPerTradePct / 100);
    const derivedTarget =
      signal.target ?? price * (1 + context.rewardPerTradePct / 100);

    const stopSource = signal.stopLoss != null ? 'strategy' : 'derived from riskPerTradePct';
    const targetSource = signal.target != null ? 'strategy' : 'derived from rewardPerTradePct';

    return {
      ok: true,
      order: {
        tradedSymbol: spec.symbol,
        side: 'BUY',
        quantity,
        referencePrice: price,
        stopLoss: derivedStop,
        target: derivedTarget,
        currency: 'USD',
        explanation:
          `Spot BUY ${quantity} ${spec.symbol} at ${price} ` +
          `(${notional.toFixed(2)} USD, ${context.capitalAllocationPct}% of ${context.availableCapital.toFixed(2)} USD equity). ` +
          `Stop ${derivedStop.toFixed(2)} (${stopSource}), target ${derivedTarget.toFixed(2)} (${targetSource}).`,
      },
    };
  }
}
