/**
 * Choosing the instrument the thesis will actually be expressed through —
 * without asking Sentinel.
 *
 * ## Why this exists at all
 *
 * The pre-existing paper path gets its contract from Sentinel:
 * `paper-execution.service.ts` reads `evaluation.strikes.selected` and
 * `evaluation.expiry` off a Sentinel response. Reusing that would have been
 * convenient and would have reintroduced, at the last possible moment, exactly
 * the dependency this architecture exists to remove — the brain would decide
 * independently and then ask Sentinel what to buy.
 *
 * So the selection is done here, from the market-data bridge's own option
 * chain, which is a data source rather than a second opinion.
 *
 * ## What it does
 *
 *     index plan  →  expiry  →  strike  →  premium projection  →  1:3 in PREMIUM
 *
 * and refuses at any step it cannot complete honestly. A market whose chain is
 * unavailable, whose strikes are illiquid, or whose contracts cannot pay 1:3 is
 * not tradable right now, and saying so is the correct output.
 *
 * ## Directly-traded instruments take the short path
 *
 * GOLD is a future: the thesis is expressed in the instrument the strategy
 * already analysed, so there is no translation to do and the index plan IS the
 * tradable plan. That is a different shape, not a special case — `resolve`
 * returns the same `TradableContract` either way so nothing downstream branches
 * on market.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  selectStrike,
  translateToPremium,
  type LevelPlan,
  type OptionQuote,
  type PremiumPlan,
  type PremiumRefusalReason,
} from '@tradew/strategy-core';
import { tradableSpec, type TradableSpec } from '@tradew/market-data';
import { contractSymbol } from '../paper-execution/execution-identity';

const BRIDGE_URL = (process.env.DHAN_LIVE_URL || 'http://localhost:4600').replace(/\/$/, '');
const TIMEOUT_MS = 10_000;

/**
 * Minimum days to expiry.
 *
 * A contract expiring today decays violently and gaps at the close, so a 3R
 * projection over it is fiction. One clear day is the floor; the resolver
 * takes the nearest expiry beyond it.
 */
export const MIN_DAYS_TO_EXPIRY = 1;

export type ContractRefusalReason =
  | PremiumRefusalReason
  | 'unsupported-market'
  | 'no-expiry'
  | 'chain-unavailable';

/** What the brain will actually send to the OMS. */
export interface TradableContract {
  /** The symbol the paper OMS resolves — an option contract, or the future. */
  tradedSymbol: string;
  optionType: 'CE' | 'PE' | null;
  strike: number | null;
  expiry: Date | null;
  /** The plan in the price space that will actually be paid and received. */
  tradable: {
    entry: number;
    stop: number;
    target: number;
    firstReward: number;
    risk: number;
    reward: number;
    rr: number;
  };
  /** Present only when a premium translation happened. */
  premium: PremiumPlan | null;
  rationale: string[];
}

export type ContractOutcome =
  | { ok: true; contract: TradableContract }
  | { ok: false; reason: ContractRefusalReason; detail: string };

interface ChainStrike {
  strike: number;
  ce: Record<string, number>;
  pe: Record<string, number>;
}

@Injectable()
export class ContractSelectorService {
  private readonly logger = new Logger(ContractSelectorService.name);

  /**
   * Resolve the tradable contract for a plan, or refuse.
   *
   * `plan` is the INDEX-space plan and is never modified — the whole point of
   * the premium gate is that the structure is an input to it.
   */
  async resolve(symbol: string, plan: LevelPlan, now: Date = new Date()): Promise<ContractOutcome> {
    const spec = tradableSpec(symbol);
    if (!spec || !spec.tradeable) {
      return { ok: false, reason: 'unsupported-market', detail: `${symbol} is not a tradable instrument.` };
    }

    if (spec.executionStyle !== 'long-option') {
      return this.direct(spec, plan);
    }
    return this.viaOptions(spec, plan, now);
  }

  /**
   * A future or spot instrument: the analysed instrument IS the traded one.
   *
   * The 1:3 was already proven in this price space by `deriveLevels`, so there
   * is nothing further to validate — re-checking it here would just restate
   * the same arithmetic and invite the two to drift.
   */
  private direct(spec: TradableSpec, plan: LevelPlan): ContractOutcome {
    return {
      ok: true,
      contract: {
        tradedSymbol: spec.symbol,
        optionType: null,
        strike: null,
        expiry: null,
        tradable: {
          entry: plan.entry,
          stop: plan.stop,
          target: plan.target,
          firstReward: plan.firstRewardPrice,
          risk: plan.riskPerUnit,
          reward: plan.rewardPerUnit,
          rr: plan.plannedRR,
        },
        premium: null,
        rationale: [
          `${spec.symbol} is traded directly (${spec.executionStyle}), so the structural plan is the ` +
            `tradable plan — entry ${plan.entry}, stop ${plan.stop}, target ${plan.target} at ` +
            `${plan.plannedRR}R.`,
        ],
      },
    };
  }

  /** An index expressed through a long option. */
  private async viaOptions(spec: TradableSpec, plan: LevelPlan, now: Date): Promise<ContractOutcome> {
    const expiry = await this.pickExpiry(spec.symbol, now);
    if (!expiry) {
      return {
        ok: false,
        reason: 'no-expiry',
        detail: `No expiry at least ${MIN_DAYS_TO_EXPIRY} day(s) out is available for ${spec.symbol}.`,
      };
    }

    const chain = await this.fetchChain(spec.symbol, expiry.iso);
    if (!chain) {
      return {
        ok: false,
        reason: 'chain-unavailable',
        detail: `The option chain for ${spec.symbol} ${expiry.iso} could not be read. Refusing rather than guessing a contract.`,
      };
    }

    const quote = selectStrike({ spot: chain.spot, direction: plan.direction, quotes: chain.quotes });
    if (!quote) {
      return {
        ok: false,
        reason: 'no-tradable-strike',
        detail:
          `No near-the-money ${plan.direction === 'long' ? 'CE' : 'PE'} strike for ${spec.symbol} ` +
          `${expiry.iso} has a traded premium, a usable delta and enough open interest.`,
      };
    }

    // The 1:3 floor, applied in the space the account actually pays in.
    const translated = translateToPremium({
      direction: plan.direction,
      spot: chain.spot,
      indexEntry: plan.entry,
      indexStop: plan.stop,
      indexTarget: plan.target,
      indexFirstReward: plan.firstRewardPrice,
      quote,
    });
    if (!translated.ok) {
      return { ok: false, reason: translated.reason, detail: translated.detail };
    }

    const p = translated.plan;
    return {
      ok: true,
      contract: {
        tradedSymbol: contractSymbol({
          underlying: spec.symbol,
          expiry: expiry.date,
          strike: p.strike,
          optionType: p.optionType,
        }),
        optionType: p.optionType,
        strike: p.strike,
        expiry: expiry.date,
        tradable: {
          entry: p.entryPremium,
          stop: p.stopPremium,
          target: p.targetPremium,
          firstReward: p.firstRewardPremium,
          risk: p.riskPerUnit,
          reward: p.rewardPerUnit,
          rr: p.premiumRR,
        },
        premium: p,
        rationale: p.rationale,
      },
    };
  }

  /**
   * The nearest expiry that is at least `MIN_DAYS_TO_EXPIRY` away.
   *
   * The bridge answers with its own `resolvedExpiry` (it auto-rolls an expired
   * request), but that is the answer to a different question — it resolves
   * what was ASKED for. This picks deliberately from the full list.
   */
  private async pickExpiry(symbol: string, now: Date): Promise<{ iso: string; date: Date } | null> {
    const body = await this.getJson<{ expiries?: string[] }>(
      `${BRIDGE_URL}/optionchain/expirylist?symbol=${encodeURIComponent(symbol)}`,
    );
    const list = body?.expiries ?? [];
    const floor = now.getTime() + MIN_DAYS_TO_EXPIRY * 86_400_000;

    for (const iso of list) {
      // Expiries are calendar dates; treat them as end-of-day IST so an expiry
      // dated today is not silently accepted at 09:20.
      const date = new Date(`${iso}T10:00:00.000Z`);
      if (date.getTime() >= floor) return { iso, date };
    }
    return null;
  }

  private async fetchChain(
    symbol: string,
    expiryIso: string,
  ): Promise<{ spot: number; quotes: OptionQuote[] } | null> {
    const body = await this.getJson<{ spot?: number; strikes?: ChainStrike[] }>(
      `${BRIDGE_URL}/optionchain?symbol=${encodeURIComponent(symbol)}&expiry=${encodeURIComponent(expiryIso)}`,
    );
    if (!body || typeof body.spot !== 'number' || !Array.isArray(body.strikes) || body.strikes.length === 0) {
      return null;
    }

    const quotes: OptionQuote[] = [];
    for (const row of body.strikes) {
      for (const side of ['ce', 'pe'] as const) {
        const leg = row[side];
        if (!leg) continue;
        quotes.push({
          strike: row.strike,
          optionType: side === 'ce' ? 'CE' : 'PE',
          ltp: Number(leg.ltp ?? 0),
          oi: Number(leg.oi ?? 0),
          volume: Number(leg.volume ?? 0),
          iv: Number(leg.iv ?? 0),
          delta: Number(leg.delta ?? 0),
          gamma: Number(leg.gamma ?? 0),
          theta: Number(leg.theta ?? 0),
          bid: Number(leg.bid ?? 0),
          ask: Number(leg.ask ?? 0),
        });
      }
    }
    return { spot: body.spot, quotes };
  }

  private async getJson<T>(url: string): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch (err) {
      // A chain we could not read is a refusal, never an empty chain — the
      // distinction the 2026-08-17 incident was made of.
      this.logger.warn(`chain read failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
