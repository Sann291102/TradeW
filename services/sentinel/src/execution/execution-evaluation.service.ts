import { Injectable, Logger } from '@nestjs/common';
import type { ObserveRequest, ObserveResponse, SideInFocus } from '../domain';
import { SentinelOrchestratorService } from '../orchestrator/sentinel-orchestrator.service';
import type { MarketSnapshot } from '../intelligence/market-intelligence.service';
import { latestDataAt } from '../intelligence/market-intelligence.service';
import {
  StrategyEngineService,
  type StrategyDefinition,
  type StrategyRegime,
} from '../intelligence/strategy-engine.service';
import type { StrategyDetection } from '../intelligence/strategy-engine.service';
import { STRATEGY_RULES } from '../intelligence/strategy-rules';
import {
  DEFAULT_MAX_BAR_AGE_MINUTES,
  DEFAULT_MIN_CANDLES,
  assessDataQuality,
  type DataQualityRead,
} from './data-quality';
import { alignedOptionSide, readIndexDirection, type IndexDirectionRead } from './index-direction';
import { readEvidence, type EvidenceRead } from './evidence';
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
 * Every judgement below comes from `SentinelOrchestratorService.observeInternal`
 * — the same call `apps/web` drives, running the same market snapshot, the same
 * strategy engine, the same confidence engine, the same four-condition
 * publication gate and the same `StrategyAdvisorService.sideInFocus`. Nothing
 * here re-reads the market, re-scores confidence, or manufactures a side the
 * publication gate declined to publish.
 *
 * What it adds is four gates and one selection, all of which can only ever
 * SUBTRACT from what Sentinel already published:
 *
 *   1. DATA QUALITY   — how old are the bars this was computed on, and were
 *                       there enough of them. `data-quality.ts`.
 *   2. AGENT STRATEGY — did one of the four agent-tradable strategies actually
 *                       validate, and is it on this profile's roster.
 *   3. INDEX DIRECTION— does the index's own structural read agree with the
 *                       option side. `index-direction.ts`.
 *   4. EVIDENCE       — of the evidence THIS strategy declares material, does
 *                       enough of it support the direction. `evidence.ts`.
 *
 * then the three-strike evaluation, which is deliberately absent from the
 * trader-facing contract (see `strike-candidates.ts` for why).
 *
 * ## Why gate 3 exists at all
 *
 * `sideInFocus` derives its side from the leading DETECTION's bias. That is a
 * statement about a setup, and a setup's bias and the index's direction can
 * legitimately disagree — a liquidity sweep prints bullish precisely while the
 * index is still making lower highs. For a trader reading a workspace that
 * divergence is information. For an agent about to buy a call it is a coin
 * flip wearing a signal's clothes, so the agent requires both reads to agree
 * and refuses when they do not. Neither overrides the other; the disagreement
 * is the answer.
 *
 * ## Honest degradation
 *
 * Every "no" below is its own verdict, kept distinct because they mean
 * different things to an operator reading the console. None of them is ever
 * reported as a result, and `no-side-in-focus` in particular is the normal,
 * designed resting state rather than a fault.
 */

export type EvaluationVerdict =
  | 'executable'
  | 'no-side-in-focus'
  | 'below-threshold'
  | 'no-option-chain'
  | 'no-tradable-strike'
  // ---- added with the autonomous agents (2026-08-30) ----
  | 'stale-data'
  | 'no-agent-strategy'
  | 'index-direction-conflict'
  | 'evidence-conflict';

/** What the agent strategy contributed, when one validated. */
export interface AgentStrategyRead {
  strategyId: string;
  strategyName: string;
  version: string;
  purpose: string;
  /** `MarketProfile.structure` at decision time — the calibration bucket. */
  regime: string;
  /** True when the strategy declares this regime; false is reported, not fatal. */
  regimeDeclared: boolean;
  bias: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  rulesMatched: string[];
  rulesUnmet: string[];
  /** The rules that will END the position, evaluated by the position manager. */
  exitRules: string[];
  knowledgeConcepts: string[];
}

/** One required confirmation and whether it held. */
export interface ConfirmationRead {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

/**
 * Whether a held position's own exit conditions have fired.
 *
 * ## Why this rides on the ENTRY evaluation
 *
 * A position is managed every couple of seconds against a live premium. Its
 * strategy's exit rules, though, are functions of the CANDLE SNAPSHOT — swing
 * structure, session momentum, VWAP against the EMA stack — none of which
 * changes between two-second ticks, and all of which cost a full market read
 * to recompute.
 *
 * So the fast loop never asks Sentinel anything. The slow evaluation tick,
 * which is already reading this symbol's snapshot to look for an ENTRY, also
 * evaluates the exit rules of whatever is currently open on it, and the
 * position manager consumes that. One read answers both questions.
 *
 * Computed for every verdict, including `no-side-in-focus` — the commonest
 * outcome by far, and the one where a held position most needs its exit rules
 * checked. Attaching this only to executable evaluations would mean a position
 * whose thesis had collapsed was never told so, precisely because its thesis
 * had collapsed.
 */
export interface ExitRuleEvaluation {
  strategyId: string;
  rules: { id: string; fired: boolean; note: string }[];
  /** The subset that fired, for a caller that only wants those. */
  fired: { id: string; note: string }[];
}

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

  // ---- The four agent gates, always reported, whatever the verdict -------
  /** How fresh and how complete the data was. Present on every verdict. */
  dataQuality: DataQualityRead;
  /** The index's own direction, independent of the option side. */
  indexDirection: IndexDirectionRead;
  /** The agent strategy that validated, or null. */
  agentStrategy: AgentStrategyRead | null;
  /** The evidence that strategy declares, read for the evaluated direction. */
  evidence: EvidenceRead | null;
  /** The gates themselves, in order, as pass/fail with detail. */
  confirmations: ConfirmationRead[];
  /**
   * Exit-rule state for the strategies named in `openStrategyIds`.
   *
   * Present on EVERY verdict, because a held position needs its exit rules
   * checked most on the ticks where no new entry is available.
   */
  exitRuleEvaluations: ExitRuleEvaluation[];

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

  // ---- The agent's own configuration, passed through from the profile ----
  /**
   * The agent-tradable strategies this profile may act on. Empty or absent
   * means "any of the four". A strategy not on this list can never produce
   * this agent's trade — which is what makes two agents on two markets two
   * different agents rather than two copies of one.
   */
  strategyIds?: string[];
  /** Data-quality floors. Defaulted from this module's own constants. */
  minCandles?: number;
  maxBarAgeMinutes?: number;

  /**
   * Strategy ids of positions this profile currently HOLDS on this symbol.
   *
   * Their exit rules are evaluated against the same snapshot and returned in
   * `exitRuleEvaluations`, so the two-second position manager never has to
   * make a market read of its own. Absent or empty means nothing is open.
   */
  openStrategyIds?: string[];
}

@Injectable()
export class ExecutionEvaluationService {
  private readonly logger = new Logger(ExecutionEvaluationService.name);

  constructor(
    private readonly orchestrator: SentinelOrchestratorService,
    private readonly strategies: StrategyEngineService,
  ) {}

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

    // ONE market read. `snapshot` and `detections` are the artefacts this
    // observation was computed from — never a second fetch. See
    // `SentinelOrchestratorService.observeInternal`.
    const { response: observation, snapshot, detections } = await this.orchestrator.observeInternal(request);

    const now = new Date();
    const spot = this.spotFrom(observation, snapshot);

    // ---- GATE 1: is the data worth deciding on? --------------------------
    //
    // FIRST, before anything else is reported as meaningful. Every read below
    // is computed from these bars, so a stale bar makes an index direction, an
    // evidence stance and a confidence score equally stale — and reporting
    // them as if they were current is worse than reporting nothing.
    const dataQuality = assessDataQuality({
      now,
      candles: snapshot.candles.length,
      // `latestDataAt`, not `latestBarAt`: this gate asks whether the read is
      // LIVE, and during market hours the newest data is the bar still being
      // written. Measuring against the last closed bar would charge every live
      // observation up to a full 15 minutes of age it does not have, leaving
      // almost nothing of the 30-minute allowance for a genuinely late poll.
      newestBarAt: latestDataAt(snapshot),
      spot,
      optionChainStrikes: snapshot.optionChain?.entries.length ?? 0,
      minCandles: input.minCandles ?? DEFAULT_MIN_CANDLES,
      maxBarAgeMinutes: input.maxBarAgeMinutes ?? DEFAULT_MAX_BAR_AGE_MINUTES,
      // REPORTED, not enforced, here — and the distinction is deliberate. This
      // gate is about the inputs the ANALYSIS was computed from: the bars and
      // the spot. A missing chain is a different operational fact ("the
      // instrument published no chain at evaluation time") with its own
      // verdict, `no-option-chain`, and its own far more useful message. Making
      // it fail here would collapse the two into `stale-data`, which is both
      // wrong and the reason `no-option-chain` briefly became unreachable.
      requireOptionChain: false,
    });

    // The index read is computed whatever the data quality, because an
    // operator asking "why did nothing trade?" needs to see what the agent
    // thought the market was doing, not an empty object.
    const indexDirection = readIndexDirection(snapshot);

    // Computed before any gate can return, so every verdict carries it. A held
    // position must be told its thesis has gone even — especially — on the
    // ticks where Sentinel has nothing new to say.
    const exitRuleEvaluations = this.evaluateExitRules(snapshot, input.openStrategyIds ?? []);
    const base = this.baseEvaluation(observation, input.symbol, spot, dataQuality, indexDirection, exitRuleEvaluations);

    if (!dataQuality.ok) {
      return {
        ...base,
        verdict: 'stale-data',
        executable: false,
        reason: `Refusing to decide on this data: ${dataQuality.reason}`,
        confirmations: [confirmation('data-quality', 'Data quality', false, dataQuality.reason!)],
      };
    }

    const confirmations: ConfirmationRead[] = [
      confirmation(
        'data-quality',
        'Data quality',
        true,
        `${dataQuality.candles} bars, newest ${dataQuality.barAgeMinutes} min old, ${dataQuality.optionChainStrikes} chain strikes.`,
      ),
    ];

    // ---- Sentinel's own authority, unchanged -----------------------------
    const side = observation.sideInFocus;
    if (!side) {
      return {
        ...base,
        verdict: 'no-side-in-focus',
        executable: false,
        reason:
          observation.publication?.waitAndWatchReason ??
          'Sentinel observed the market and published no side in focus. Staying silent is a normal outcome, not a fault.',
        confirmations,
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
        confirmations: [
          ...confirmations,
          confirmation('confidence-floor', 'Confidence floor', false, `${side.confidence}% against a ${floor}% floor.`),
        ],
      };
    }
    confirmations.push(
      confirmation('confidence-floor', 'Confidence floor', true, `${side.confidence}% against a ${floor}% floor.`),
    );

    const direction: 'bullish' | 'bearish' = side.side === 'CE' ? 'bullish' : 'bearish';
    const regime = snapshot.marketProfile?.structure ?? 'unknown';

    // ---- GATE 2: did one of the agent's own strategies validate? ---------
    //
    // `sideInFocus` can be published off any of the twelve strategies, or off
    // the session trend when none led. An AGENT may only act on the four that
    // were written for it — they are the only ones with direction-agnostic
    // rules and declared exit conditions — and only on the subset its profile
    // names.
    const roster = this.rosterFor(input.strategyIds);
    const agentStrategy = this.leadingAgentStrategy(detections, roster, direction, regime);

    if (!agentStrategy) {
      const rosterNames = roster.map((s) => s.id).join(', ');
      return {
        ...base,
        verdict: 'no-agent-strategy',
        executable: false,
        reason:
          `A ${side.side} side is in focus at ${side.confidence}%, but no agent strategy on this profile's roster ` +
          `(${rosterNames}) produced a validated ${direction} setup. The published side came from an observation ` +
          'strategy, which an agent does not trade.',
        confirmations: [
          ...confirmations,
          confirmation('agent-strategy', 'Agent strategy validated', false, `No validated ${direction} setup among ${rosterNames}.`),
        ],
      };
    }
    confirmations.push(
      confirmation(
        'agent-strategy',
        'Agent strategy validated',
        true,
        `${agentStrategy.strategyName} v${agentStrategy.version} validated ${agentStrategy.bias} at ${agentStrategy.confidence}% in a ${agentStrategy.regime} regime.`,
      ),
    );

    // ---- GATE 3: does the INDEX agree with the option side? --------------
    const permitted = alignedOptionSide(indexDirection.direction);
    if (permitted !== side.side) {
      return {
        ...base,
        agentStrategy,
        verdict: 'index-direction-conflict',
        executable: false,
        reason:
          `Sentinel published the ${side.side} side, but the index itself reads ${indexDirection.direction}` +
          (indexDirection.direction === 'unclear' || indexDirection.direction === 'neutral'
            ? ` — ${indexDirection.summary}`
            : `, which permits ${permitted ?? 'no'} only.`) +
          ' The index is the context and the option is the expression; they must agree.',
        confirmations: [
          ...confirmations,
          confirmation(
            'index-direction',
            'Index direction agrees',
            false,
            `Index reads ${indexDirection.direction} (${(indexDirection.strength * 100).toFixed(0)}% agreement); side in focus is ${side.side}.`,
          ),
        ],
      };
    }
    confirmations.push(
      confirmation(
        'index-direction',
        'Index direction agrees',
        true,
        `Index reads ${indexDirection.direction} at ${(indexDirection.strength * 100).toFixed(0)}% agreement, matching the ${side.side} side.`,
      ),
    );

    // ---- GATE 4: does this strategy's own evidence support it? -----------
    const definition = this.strategies.agentStrategy(agentStrategy.strategyId)!;
    const evidence = readEvidence(snapshot, direction, definition.evidenceKeys ?? [], definition.evidenceWeights ?? {});
    const requiredSupport = definition.minEvidenceSupport ?? 0.6;
    const evidenceOk = evidence.supportRatio >= requiredSupport;

    if (!evidenceOk) {
      return {
        ...base,
        agentStrategy,
        evidence,
        verdict: 'evidence-conflict',
        executable: false,
        reason:
          `${agentStrategy.strategyName}'s own evidence does not support the ${direction} case: ` +
          `${(evidence.supportRatio * 100).toFixed(0)}% support against a ${(requiredSupport * 100).toFixed(0)}% floor. ` +
          evidence.summary,
        confirmations: [
          ...confirmations,
          confirmation(
            'evidence-support',
            'Strategy evidence supports',
            false,
            `${(evidence.supportRatio * 100).toFixed(0)}% against a ${(requiredSupport * 100).toFixed(0)}% floor.`,
          ),
        ],
      };
    }
    confirmations.push(
      confirmation(
        'evidence-support',
        'Strategy evidence supports',
        true,
        `${(evidence.supportRatio * 100).toFixed(0)}% of decided evidence supports, against a ${(requiredSupport * 100).toFixed(0)}% floor.`,
      ),
    );

    // ---- The contract ----------------------------------------------------
    const chain = observation.optionChain;
    if (!chain || chain.entries.length === 0) {
      return {
        ...base,
        agentStrategy,
        evidence,
        verdict: 'no-option-chain',
        executable: false,
        reason:
          `A ${side.side} side is in focus for ${input.symbol}, but no option chain was published at evaluation time, ` +
          'so no contract could be priced. Nothing was executed.',
        confirmations,
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
        agentStrategy,
        evidence,
        verdict: 'no-tradable-strike',
        executable: false,
        reason: strikes.unavailableReason ?? 'No candidate strike passed evaluation.',
        strikes,
        expiry: chain.frontExpiry,
        confirmations: [
          ...confirmations,
          confirmation('tradable-strike', 'Tradable contract', false, strikes.unavailableReason ?? 'No candidate passed.'),
        ],
      };
    }
    confirmations.push(
      confirmation(
        'tradable-strike',
        'Tradable contract',
        true,
        `${strikes.selected.strike} ${side.side} at ${strikes.selected.premium?.toFixed(2) ?? 'unpriced'}.`,
      ),
    );

    return {
      ...base,
      agentStrategy,
      evidence,
      verdict: 'executable',
      executable: true,
      reason:
        `${agentStrategy.strategyName} v${agentStrategy.version} validated ${direction}; ` +
        `the index agrees at ${(indexDirection.strength * 100).toFixed(0)}% and ` +
        `${(evidence.supportRatio * 100).toFixed(0)}% of its declared evidence supports. ` +
        `${strikes.selected.strike} ${side.side} selected from three candidates at ${side.confidence}% confidence.`,
      strikes,
      expiry: chain.frontExpiry,
      confirmations,
    };
  }

  /**
   * Evaluate the exit rules of the strategies whose positions are open.
   *
   * Pure over the snapshot — the same `STRATEGY_RULES` predicates the entry
   * scan uses, so an exit rule and an invalidation rule of the same name can
   * never mean two different things.
   *
   * An unknown strategy id yields no evaluation rather than an error: a
   * position opened under a strategy that has since been renamed must still be
   * MANAGEABLE, and the price-based exits in `position-decision.ts` do not
   * depend on this. Silently returning nothing here degrades the position to
   * stop/target/trail/square-off, which is a safe subset, rather than failing
   * a tick that other open positions also depend on.
   */
  private evaluateExitRules(snapshot: MarketSnapshot, strategyIds: string[]): ExitRuleEvaluation[] {
    const out: ExitRuleEvaluation[] = [];
    for (const id of [...new Set(strategyIds)]) {
      const def = this.strategies.agentStrategy(id);
      if (!def || !def.exitRules?.length) continue;
      const rules = def.exitRules.map((ruleId) => {
        const rule = STRATEGY_RULES[ruleId];
        if (!rule) return { id: ruleId, fired: false, note: 'Rule not recognised by this build.' };
        try {
          const outcome = rule(snapshot);
          return { id: ruleId, fired: outcome.ok, note: outcome.note };
        } catch (err) {
          // A throwing rule must not fire. An exit is an irreversible act, and
          // "the predicate crashed" is not evidence that the thesis is gone.
          this.logger.warn(`exit rule ${ruleId} threw for ${def.id}: ${(err as Error).message}`);
          return { id: ruleId, fired: false, note: `Rule raised: ${(err as Error).message}` };
        }
      });
      out.push({ strategyId: id, rules, fired: rules.filter((r) => r.fired).map((r) => ({ id: r.id, note: r.note })) });
    }
    return out;
  }

  /**
   * The agent strategies this profile may act on.
   *
   * An unrecognised id is DROPPED rather than failing the pass, and the
   * remaining roster still applies — but a roster that names only unknown ids
   * resolves to an empty list, which then fails gate 2 with a readable reason.
   * The alternative (falling back to all four when the roster is unusable)
   * would silently widen an agent's permissions on a typo.
   */
  private rosterFor(ids: string[] | undefined): StrategyDefinition[] {
    const all = this.strategies.agentStrategies();
    if (!ids || ids.length === 0) return all;
    const wanted = new Set(ids);
    const matched = all.filter((s) => wanted.has(s.id));
    const unknown = ids.filter((id) => !all.some((s) => s.id === id));
    if (unknown.length) {
      this.logger.warn(`profile roster names non-agent strategy id(s): ${unknown.join(', ')} — ignored`);
    }
    return matched;
  }

  /**
   * The strongest VALIDATED agent detection that agrees with the published side.
   *
   * `validated` is required, not merely "detected": a partially-confirmed
   * setup is exactly what the trader-facing timeline exists to show and
   * exactly what an agent must not act on. `bias` must match the side too —
   * a validated bearish structure shift does not authorise buying a call
   * because something else published one.
   */
  private leadingAgentStrategy(
    detections: StrategyDetection[],
    roster: StrategyDefinition[],
    direction: 'bullish' | 'bearish',
    regime: string,
  ): AgentStrategyRead | null {
    const byId = new Map(roster.map((s) => [s.id, s]));
    // `detections` arrives strongest-first from `StrategyEngineService.scan`.
    const hit = detections.find((d) => byId.has(d.strategyId) && d.validated && d.bias === direction);
    if (!hit) return null;
    const def = byId.get(hit.strategyId)!;
    return {
      strategyId: def.id,
      strategyName: def.name,
      version: def.version ?? '0.0.0',
      purpose: def.purpose ?? '',
      regime,
      // Reported, never fatal. A strategy firing outside its declared regime is
      // worth recording — it is exactly what a calibration bucket is for — but
      // refusing on it would make the regime classifier a hard gate it was
      // never validated as.
      regimeDeclared: (def.regimes ?? []).includes(regime as StrategyRegime),
      bias: hit.bias,
      confidence: hit.confidence,
      rulesMatched: hit.rulesMatched,
      rulesUnmet: hit.rulesUnmet,
      exitRules: (def.exitRules ?? []).filter((r) => Object.prototype.hasOwnProperty.call(STRATEGY_RULES, r)),
      knowledgeConcepts: def.knowledgeConcepts ?? [],
    };
  }

  /**
   * Spot for this observation.
   *
   * Read from the snapshot's own last price first — that is the price every
   * indicator in this evaluation was computed against, so using anything else
   * would locate a strike against a number the analysis never saw. Falls back
   * to the contract watch's index series and then to the live-validation price
   * the side carries. Returns null rather than 0 when none is available: 0
   * would sail through `Number.isFinite` and locate a strike near zero.
   */
  private spotFrom(observation: ObserveResponse, snapshot: MarketSnapshot): number | null {
    if (typeof snapshot.lastPrice === 'number' && snapshot.lastPrice > 0) return snapshot.lastPrice;
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
    dataQuality: DataQualityRead,
    indexDirection: IndexDirectionRead,
    exitRuleEvaluations: ExitRuleEvaluation[],
  ): Omit<ExecutionEvaluation, 'verdict' | 'executable' | 'reason' | 'confirmations'> {
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
      dataQuality,
      indexDirection,
      exitRuleEvaluations,
      agentStrategy: null,
      evidence: null,
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

function confirmation(id: string, label: string, passed: boolean, detail: string): ConfirmationRead {
  return { id, label, passed, detail };
}
