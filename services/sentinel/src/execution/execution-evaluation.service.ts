import { Injectable, Logger } from '@nestjs/common';
import type { ObserveRequest, ObserveResponse, SideInFocus } from '../domain';
import { SentinelOrchestratorService } from '../orchestrator/sentinel-orchestrator.service';
import {
  DEFAULT_STRIKE_POLICY,
  type StrikeEvaluation,
  type StrikeEvaluationPolicy,
  evaluateStrikeCandidates,
} from './strike-candidates';

/**
 * The execution-facing read of one Sentinel observation.
 *
 * ## This is not a second Sentinel
 *
 * Every judgement below comes from `SentinelOrchestratorService.observe` — the
 * same call `apps/web` drives, running the same market snapshot, the same
 * strategy engine, the same confidence engine, the same four-condition
 * publication gate and the same `StrategyAdvisorService.sideInFocus`. This
 * service adds exactly one thing the observe path does not have: the
 * three-strike evaluation, which is deliberately absent from the trader-facing
 * contract (see `strike-candidates.ts` for why).
 *
 * So the ordering is: Sentinel decides whether there is a side at all, and this
 * decides which of three contracts expresses it. If Sentinel published no side,
 * this returns `executable: false` and no candidates are even evaluated —
 * there is no path here that manufactures a decision Sentinel declined to make.
 *
 * ## Honest degradation
 *
 * Four distinct "no" outcomes, kept distinct because they mean different things
 * to an operator reading the console:
 *
 *   · `no-side-in-focus`  — Sentinel observed and stayed silent. The normal,
 *                           designed resting state; not a fault.
 *   · `no-option-chain`   — a side was published but the chain was unavailable,
 *                           so no contract could be priced.
 *   · `no-tradable-strike`— the chain was read and all three candidates failed
 *                           their checks. The candidates ARE returned, with the
 *                           check that failed each one.
 *   · `below-threshold`   — a side was published but under the caller's own
 *                           (stricter) confidence floor.
 *
 * None of them is ever reported as a result.
 */

export type EvaluationVerdict =
  | 'executable'
  | 'no-side-in-focus'
  | 'below-threshold'
  | 'no-option-chain'
  | 'no-tradable-strike';

export interface ExecutionEvaluation {
  verdict: EvaluationVerdict;
  /** True only when `verdict === 'executable'` and `selected` is non-null. */
  executable: boolean;
  /** Plain-language statement of the verdict, for the console. */
  reason: string;

  /** AgentRun.runId of the observation this evaluation is of. */
  runId: string | null;
  symbol: string;
  observedAt: string;
  /** Underlying spot the evaluation was made against. */
  spot: number | null;

  /** Sentinel's own read, unmodified. Null when it published no side. */
  sideInFocus: SideInFocus | null;
  confidence: number;
  /** The four-condition publication gate's record, verbatim. */
  publication: ObserveResponse['publication'] | null;
  strategyId: string | null;
  strategyName: string | null;

  /** The three-strike evaluation. Empty candidates when no chain was read. */
  strikes: StrikeEvaluation;
  /** Front expiry the candidates belong to, ISO date. Null with no chain. */
  expiry: string | null;

  /** Compact record of what the market looked like, for the intent's audit trail. */
  marketSnapshot: {
    marketProfile: ObserveResponse['marketProfile'];
    marketState: string | null;
    strategyMatches: { strategyId: string; strategyName: string; confidence: number; bias: string }[];
    risk: { overallRisk: number; level: string } | null;
  };
}

export interface EvaluateInput {
  symbol: string;
  /** The profile's paper account, so Sentinel's own state machine keys per account. */
  userId: string;
  strategyId?: string | null;
  /** The caller's confidence floor, applied ON TOP of Sentinel's own gate. */
  minConfidence?: number;
  policy?: StrikeEvaluationPolicy;
}

@Injectable()
export class ExecutionEvaluationService {
  private readonly logger = new Logger(ExecutionEvaluationService.name);

  constructor(private readonly orchestrator: SentinelOrchestratorService) {}

  async evaluate(input: EvaluateInput): Promise<ExecutionEvaluation> {
    const request: ObserveRequest = {
      userId: input.userId,
      symbol: input.symbol,
      context: 'paper-execution',
      // Pinning a strategy is the profile's choice; absent it, Sentinel picks
      // its own best-corroborated setup exactly as it does for a trader.
      strategyMode: input.strategyId ? 'manual' : 'auto',
      ...(input.strategyId ? { selectedStrategyIds: [input.strategyId] } : {}),
      // The one flag that separates this call from a workspace poll.
      includeOptionChain: true,
    };

    const observation = await this.orchestrator.observe(request);
    const spot = this.spotFrom(observation);
    const base = this.baseEvaluation(observation, input.symbol, spot);

    const side = observation.sideInFocus;
    if (!side) {
      return {
        ...base,
        verdict: 'no-side-in-focus',
        executable: false,
        reason:
          observation.publication?.waitAndWatchReason ??
          'Sentinel observed the market and published no side in focus. Staying silent is a normal outcome, not a fault.',
      };
    }

    // A SECOND floor, never a replacement for Sentinel's own. `sideInFocus` is
    // already unreachable below 70 and below a cleared publication gate; a
    // profile may only ever be stricter than that, never looser.
    const floor = input.minConfidence ?? 0;
    if (side.confidence < floor) {
      return {
        ...base,
        verdict: 'below-threshold',
        executable: false,
        reason: `Side in focus cleared Sentinel's gate at ${side.confidence}%, below this profile's ${floor}% floor.`,
      };
    }

    const chain = observation.optionChain;
    if (!chain || chain.entries.length === 0) {
      return {
        ...base,
        verdict: 'no-option-chain',
        executable: false,
        reason:
          `A ${side.side} side is in focus for ${input.symbol}, but no option chain was published at evaluation time, ` +
          'so no contract could be priced. Nothing was executed.',
      };
    }

    const expiry = new Date(chain.frontExpiry);
    const strikes = evaluateStrikeCandidates({
      symbol: input.symbol,
      spot: spot ?? 0,
      side: side.side,
      // The wire form carries `expiry` per the chain, not per row; re-attach it
      // so the evaluator sees the same `OptionChainEntry` shape the engine uses.
      chain: chain.entries.map((e) => ({ ...e, expiry })),
      policy: input.policy ?? DEFAULT_STRIKE_POLICY,
    });

    if (!strikes.selected) {
      return {
        ...base,
        verdict: 'no-tradable-strike',
        executable: false,
        reason: strikes.unavailableReason ?? 'No candidate strike passed evaluation.',
        strikes,
        expiry: chain.frontExpiry,
      };
    }

    return {
      ...base,
      verdict: 'executable',
      executable: true,
      reason:
        `${side.side} side in focus at ${side.confidence}% confidence; ` +
        `${strikes.selected.strike} ${side.side} selected from three candidates.`,
      strikes,
      expiry: chain.frontExpiry,
    };
  }

  /**
   * Spot for this observation.
   *
   * Read from the contract watch's index series when present — that is the
   * price the strategy engine actually evaluated against — and falls back to
   * the live-validation price the side carries. Returns null rather than 0 when
   * neither is available: 0 would sail through `Number.isFinite` and locate a
   * strike near zero.
   */
  private spotFrom(observation: ObserveResponse): number | null {
    const index = observation.contractWatch?.index?.last;
    if (typeof index === 'number' && index > 0) return index;
    const validation = observation.sideInFocus?.liveValidation?.currentPrice;
    if (typeof validation === 'number' && validation > 0) return validation;
    return null;
  }

  private baseEvaluation(
    observation: ObserveResponse,
    symbol: string,
    spot: number | null,
  ): Omit<ExecutionEvaluation, 'verdict' | 'executable' | 'reason'> {
    const advice = observation.strategyAdvice;
    return {
      runId: observation.runId ?? null,
      symbol,
      observedAt: new Date().toISOString(),
      spot,
      sideInFocus: observation.sideInFocus ?? null,
      confidence: observation.confidence?.score ?? 0,
      publication: observation.publication ?? null,
      strategyId: advice?.activeStrategyId ?? null,
      strategyName: advice?.activeStrategyName ?? null,
      strikes: { candidates: [], selected: null, atmStrike: null, strikeStep: null, unavailableReason: null },
      expiry: null,
      marketSnapshot: {
        marketProfile: observation.marketProfile,
        marketState: observation.marketState?.current ?? null,
        strategyMatches: (observation.strategyMatches ?? []).map((m) => ({
          strategyId: m.strategyId,
          strategyName: m.strategyName,
          confidence: m.confidence,
          bias: m.bias,
        })),
        risk: observation.risk ? { overallRisk: observation.risk.overallRisk, level: observation.risk.level } : null,
      },
    };
  }
}
