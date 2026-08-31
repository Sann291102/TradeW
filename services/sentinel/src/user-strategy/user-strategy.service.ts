/**
 * The service `services/api` calls to evaluate a user-written strategy.
 *
 * ## Why this does not build a MarketSnapshot
 *
 * The v1 certified conditions need OHLCV and nothing else — no option chain,
 * no index direction, no market profile. Building a full `MarketSnapshot` for
 * them would drag in `SNAPSHOT_INTERVAL`, which is hardcoded to 15m and shared
 * across the index and both option legs for a documented reason (comparing a
 * 15m index move against a 1m premium move calls the difference divergence).
 *
 * Reading candles directly at the STRATEGY'S OWN interval sidesteps that
 * entirely: nothing here compares two series, so nothing here needs them on
 * one clock. That is what makes "the strategy timeframe is authoritative"
 * true in v1 without reworking the snapshot pipeline — and it is also the
 * reason a future condition that DOES need the chain cannot simply be added to
 * the registry without revisiting this.
 *
 * ## Single decision authority
 *
 * This returns a verdict. It does not place, size, or manage anything, and it
 * holds no Prisma binding to Order/Trade/Position. `services/api` decides what
 * to do with the verdict, exactly as it does for the built-in agents.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Candle, CandleInterval, MarketDataProvider } from '@tradew/types';
import { MARKET_DATA, readOptionChain } from '../intelligence/market-intelligence.service';
import { DEFAULT_STRIKE_POLICY, evaluateStrikeCandidates, type StrikeEvaluation } from '../execution/strike-candidates';
import { certifyStrategy, type Certification, type UserStrategyRules } from './certification';
import { evaluateUserStrategy, type UserStrategyEvaluation } from './evaluate';
import { intervalMs } from './candle-policy';

export interface UserStrategyEvaluateRequest {
  symbol: string;
  rules: UserStrategyRules;
  /** ISO timestamp of the newest bar already evaluated, for idempotency. */
  lastEvaluatedBarTime?: string | null;
  /** Overrides the clock — used by replay and by tests, never in production. */
  now?: string;
  maxBarAgeMs?: number;
}

export interface UserStrategyEvaluateResponse {
  /**
   * Present only on an ENTRY verdict. The contract the paper order would be
   * placed on, chosen by the SAME `evaluateStrikeCandidates` the built-in
   * agents use.
   *
   * Note what is NOT here: Sentinel's own confidence, index direction and
   * agent-strategy gates. That is deliberate and is the whole point of the
   * feature — the USER'S conditions are the trigger. Sentinel contributes the
   * contract, not the opinion. A design that also required Sentinel's thesis
   * to agree would make the user's strategy a filter on Sentinel's rather than
   * the other way round.
   */
  contract: {
    strike: number;
    optionType: 'CE' | 'PE';
    expiry: string;
    premium: number | null;
    role: string;
  } | null;
  strikes: StrikeEvaluation | null;
  certification: {
    status: Certification['status'];
    summary: string;
    interval: string | null;
    direction: 'long' | 'short' | null;
    minBars: number;
    blockers: Certification['blockers'];
    declaredConditions: string[];
  };
  evaluation: UserStrategyEvaluation | null;
  /** How many closed bars the evaluation actually saw. */
  barsRead: number;
}

/**
 * How far back to fetch. Enough bars for the strategy's own minimum plus room
 * for the history-scanning conditions to find a sequence that began earlier in
 * the session — a reclaim twenty bars ago still counts, so a window sized to
 * `minBars` exactly would make the setup vanish as the session progressed.
 */
const LOOKBACK_BARS = 200;

@Injectable()
export class UserStrategyService {
  private readonly logger = new Logger(UserStrategyService.name);

  constructor(@Inject(MARKET_DATA) private readonly marketData: MarketDataProvider) {}

  /** Certification alone, with no market read — for the arming surface. */
  certify(rules: UserStrategyRules): Certification {
    return certifyStrategy(rules);
  }

  async evaluate(request: UserStrategyEvaluateRequest): Promise<UserStrategyEvaluateResponse> {
    const certification = certifyStrategy(request.rules);
    const reported = {
      status: certification.status,
      summary: certification.summary,
      interval: certification.interval,
      direction: certification.direction,
      minBars: certification.minBars,
      blockers: certification.blockers,
      declaredConditions: certification.declaredConditions,
    };

    // An uncertified strategy is refused BEFORE any market read. Fetching
    // candles for a strategy that can never trade is wasted quota against a
    // rate-limited bridge, and — more to the point — it would let a
    // watch-only strategy look like it was being evaluated.
    if (certification.status !== 'TRADABLE' || !certification.interval) {
      return {
        certification: reported,
        evaluation: evaluateUserStrategy({
          certification,
          candles: [],
          now: request.now ? new Date(request.now) : new Date(),
          lastEvaluatedBarTime: null,
        }),
        contract: null,
        strikes: null,
        barsRead: 0,
      };
    }

    const now = request.now ? new Date(request.now) : new Date();
    const interval = certification.interval as CandleInterval;
    const from = new Date(now.getTime() - intervalMs(interval) * LOOKBACK_BARS);

    let candles: Candle[] = [];
    try {
      candles = await this.marketData.getCandles(request.symbol, interval, from, now);
    } catch (err) {
      // A failed read is a REFUSAL, never an absence of setup. Returning an
      // empty series here would flow into `no-candles`, which is the right
      // verdict but the wrong reason — so it is logged distinctly.
      this.logger.warn(
        `user-strategy: candle read failed for ${request.symbol} ${interval}: ${(err as Error).message}`,
      );
    }

    const evaluation = evaluateUserStrategy({
      certification,
      candles,
      now,
      lastEvaluatedBarTime: request.lastEvaluatedBarTime ? new Date(request.lastEvaluatedBarTime) : null,
      maxBarAgeMs: request.maxBarAgeMs,
    });

    // Strike selection runs ONLY on an entry. A waiting or refused pass must
    // not spend a call against the rate-limited option-chain endpoint, and a
    // contract chosen for a setup that did not fire is a record of nothing.
    let contract: UserStrategyEvaluateResponse['contract'] = null;
    let strikes: StrikeEvaluation | null = null;
    if (evaluation.verdict === 'entry') {
      const picked = await this.selectContract(request.symbol, evaluation.direction, candles);
      strikes = picked.strikes;
      contract = picked.contract;
      if (!contract) {
        // The conditions fired but no contract could be priced. That is a
        // REFUSAL, not an entry — otherwise the caller would be told to trade
        // something that does not exist.
        return {
          certification: reported,
          evaluation: {
            ...evaluation,
            verdict: 'refused',
            refusal: 'no-tradable-strike',
            reason: `${evaluation.reason} But ${picked.reason}`,
          },
          contract: null,
          strikes,
          barsRead: candles.length,
        };
      }
    }

    return { certification: reported, evaluation, contract, strikes, barsRead: candles.length };
  }

  /**
   * Pick the contract for an entry: the aligned side of the front expiry,
   * ranked ITM/ATM/OTM by the shared selector.
   *
   * Spot is the close of the newest CLOSED bar rather than a live tick, so the
   * contract is chosen against the same bar the decision was made on. Using a
   * fresher price here would mean the strike could differ from the one the
   * conditions were evaluated against.
   */
  private async selectContract(
    symbol: string,
    direction: 'long' | 'short' | null,
    candles: Candle[],
  ): Promise<{ contract: UserStrategyEvaluateResponse['contract']; strikes: StrikeEvaluation | null; reason: string }> {
    const side: 'CE' | 'PE' = direction === 'short' ? 'PE' : 'CE';
    const spot = candles.length ? candles[candles.length - 1].close : 0;

    let raw;
    try {
      raw = await this.marketData.getOptionChain(symbol);
    } catch (err) {
      return { contract: null, strikes: null, reason: `the option chain could not be read (${(err as Error).message}).` };
    }
    if (!raw || raw.length === 0) {
      return { contract: null, strikes: null, reason: 'no option chain was published for this instrument.' };
    }

    const read = readOptionChain(raw, spot);
    if (!read || read.entries.length === 0) {
      return { contract: null, strikes: null, reason: 'the option chain carried no usable front-expiry entries.' };
    }

    const expiry = new Date(read.frontExpiry);
    const strikes = evaluateStrikeCandidates({
      symbol,
      spot,
      side,
      chain: read.entries.map((e) => ({ ...e, expiry })),
      policy: DEFAULT_STRIKE_POLICY,
    });

    if (!strikes.selected) {
      return { contract: null, strikes, reason: strikes.unavailableReason ?? 'no candidate strike passed evaluation.' };
    }
    return {
      contract: {
        strike: strikes.selected.strike,
        optionType: strikes.selected.optionType,
        expiry: new Date(read.frontExpiry).toISOString(),
        premium: strikes.selected.premium ?? null,
        role: strikes.selected.role,
      },
      strikes,
      reason: 'contract selected',
    };
  }
}
