/**
 * Futures execution adapter — MCX commodities (gold).
 *
 * Between the other two in complexity. Like spot, the analysed instrument IS
 * the traded one, so stops and targets need no price-space translation. Unlike
 * spot, size is in whole lots and both directions are expressible.
 *
 * ## Two-sided, unlike spot
 *
 * A futures contract can be sold without owning anything, so a bearish read
 * becomes a SELL. That makes gold the only market in this experiment that can
 * act on both directions — worth stating plainly, because it is a confound in
 * any cross-market comparison: if a strategy scores better on gold than on BTC,
 * part of that difference may be that gold could trade its bearish signals and
 * BTC could not. The comparison layer must surface long-only-ness alongside the
 * numbers rather than leaving it to be inferred.
 *
 * ## The lot-size problem is the reason this adapter refuses loudly
 *
 * MCX GOLD is 100 grams per lot. At roughly ₹1,00,000 per 10 g that is a
 * ~₹10 lakh notional, against a `PaperWallet.startingBalance` of ₹10,00,000 —
 * so ONE lot is approximately the entire account, and any sane
 * `capitalAllocationPct` (default 20) can never afford it.
 *
 * The dangerous version of that is silence: the agent evaluates all day, sizes
 * to zero lots, and produces nothing, looking identical to an agent that simply
 * found no setup. `lot-exceeds-allocation` exists so the console's "why did
 * nothing trade today?" breakdown names it on the first pass instead. GOLDM
 * (10 g) is the intended remedy and is already in the registry, pending a feed
 * subscription.
 */

import type { MarketVenue } from '@tradew/market-data';
import { tradableSpec } from '@tradew/market-data';
import type {
  ExecutionAdapter,
  MaterialisationContext,
  MaterialisationResult,
} from './execution-adapter';
import { directSideFor, isActionable, type StrategySignal } from './strategy-signal';

export class FuturesExecutionAdapter implements ExecutionAdapter {
  readonly id = 'futures-mcx';
  readonly style = 'futures' as const;
  readonly venues: readonly MarketVenue[] = ['MCX'];

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

    const side = directSideFor(signal);
    if (!side) {
      return {
        ok: false,
        refusal: {
          checkId: 'signal-not-directional',
          reason: `No order side could be derived for a "${signal.bias}" bias.`,
        },
      };
    }

    const lotSize = spec.lotSize;
    if (!lotSize || lotSize <= 0) {
      return {
        ok: false,
        refusal: {
          checkId: 'symbol-not-tradable',
          reason: `${spec.symbol} has no lot size in the registry, so a futures order cannot be sized.`,
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

    const allocated = context.availableCapital * (context.capitalAllocationPct / 100);
    // MCX quotes gold per 10 g, and the contract is `lotSize` grams — so one
    // lot's notional is price × (lotSize / 10), not price × lotSize. Getting
    // this wrong by the factor of ten would size ten times too large and pass
    // every downstream check, which is why it is spelled out rather than
    // folded into the expression below.
    const QUOTE_UNIT_GRAMS = 10;
    const notionalPerLot = price * (lotSize / QUOTE_UNIT_GRAMS);

    if (notionalPerLot > allocated) {
      return {
        ok: false,
        refusal: {
          checkId: 'lot-exceeds-allocation',
          reason:
            `One ${spec.symbol} lot (${lotSize}g) is ₹${Math.round(notionalPerLot).toLocaleString('en-IN')} ` +
            `at ₹${price}/10g, above the ₹${Math.round(allocated).toLocaleString('en-IN')} this profile may allocate ` +
            `(${context.capitalAllocationPct}% of ₹${Math.round(context.availableCapital).toLocaleString('en-IN')}). ` +
            `A smaller contract (GOLDM, 10g) is the remedy — not a larger allocation.`,
        },
      };
    }

    const lots = Math.floor(allocated / notionalPerLot);
    if (lots < 1) {
      // Unreachable given the check above, kept as a guard rather than removed:
      // the two conditions are only equivalent while the arithmetic stays as it
      // is, and a silent zero-size order is the failure this whole adapter is
      // shaped to prevent.
      return {
        ok: false,
        refusal: {
          checkId: 'lot-exceeds-allocation',
          reason: `Allocation of ₹${Math.round(allocated).toLocaleString('en-IN')} sizes to zero lots.`,
        },
      };
    }

    // Direction-aware, unlike spot: a SELL's stop is ABOVE entry and its target
    // BELOW. Deriving both from the same expression regardless of side would
    // place a short's stop into profit, which every downstream check would
    // accept — the position would simply close instantly at a "loss" that was
    // structurally guaranteed.
    const dir = side === 'BUY' ? 1 : -1;
    const derivedStop =
      signal.stopLoss ?? price * (1 - dir * (context.riskPerTradePct / 100));
    const derivedTarget =
      signal.target ?? price * (1 + dir * (context.rewardPerTradePct / 100));

    const stopSource = signal.stopLoss != null ? 'strategy' : 'derived from riskPerTradePct';
    const targetSource = signal.target != null ? 'strategy' : 'derived from rewardPerTradePct';

    return {
      ok: true,
      order: {
        tradedSymbol: spec.symbol,
        side,
        // In LOTS, matching `ExecutionProfile.lots`' own reasoning: storing a
        // raw quantity "would silently break the moment an exchange revises a
        // lot size".
        quantity: lots,
        referencePrice: price,
        stopLoss: derivedStop,
        target: derivedTarget,
        currency: 'INR',
        explanation:
          `${side} ${lots} lot(s) of ${spec.symbol} (${lotSize}g each) at ₹${price}/10g ` +
          `— ₹${Math.round(lots * notionalPerLot).toLocaleString('en-IN')} notional, ` +
          `${context.capitalAllocationPct}% allocation of ₹${Math.round(context.availableCapital).toLocaleString('en-IN')}. ` +
          `Stop ₹${derivedStop.toFixed(2)} (${stopSource}), target ₹${derivedTarget.toFixed(2)} (${targetSource}).`,
      },
    };
  }
}
