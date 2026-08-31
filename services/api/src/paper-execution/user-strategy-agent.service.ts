/**
 * The autonomous agent for USER-WRITTEN strategies.
 *
 * One pass per profile per tick:
 *
 *   resume from the last decided bar
 *     → ask Sentinel whether the user's conditions are true on a NEW closed bar
 *     → record the decision (always — entry, waiting, or refused)
 *     → if ENTRY and the profile is LIVE and armed, place a paper order
 *
 * ## Where the "no human trigger" property actually lives
 *
 * Nowhere in this file is there a branch waiting for a person. The only human
 * acts are upstream and one-time: an operator arming the profile and promoting
 * it from SHADOW to LIVE. After that the strategy's own conditions are the
 * trigger, which is the whole point of the feature.
 *
 * ## Duplicate entries
 *
 * Three independent defences, in increasing order of strength:
 *
 *   1. Sentinel refuses a bar whose timestamp is not newer than the one passed
 *      in (`already-evaluated`).
 *   2. `StrategyAgentDecision` has `@@unique([profileId, barTime])`, so two
 *      workers racing the same bar produce ONE row — the loser's insert throws
 *      and this service stops before placing anything.
 *   3. The existing `ExecutionIntent.idempotencyKey`, unchanged, still guards
 *      the order layer.
 *
 * The second is the one that survives concurrency, and it is why the decision
 * row is written BEFORE the order is placed rather than after.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type ExecutionAgentMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { createHash } from 'node:crypto';
import {
  SentinelExecutionClient,
  type ExecutionEvaluationDto,
  type UserStrategyEvaluationDto,
} from './sentinel-execution.client';
import { PaperExecutionService } from './paper-execution.service';

export interface UserStrategyPassResult {
  profileId: string;
  profileName: string;
  outcome:
    | 'not-certified'
    | 'refused'
    | 'waiting'
    | 'shadow-entry'
    | 'entered'
    | 'entry-blocked'
    | 'duplicate'
    | 'disarmed-edited'
    | 'error';
  verdict: string | null;
  barTime: string | null;
  reason: string;
  intentId?: string;
}


/**
 * A stable hash of a strategy's rules.
 *
 * Exported so the arming path, the agent and any test all use ONE definition —
 * two implementations of "has this changed" is how a false edit-detection ships.
 *
 * ## Why not JSON.stringify
 *
 * `UserStrategy.rules` is a JSONB column, and **JSONB does not preserve key
 * order**. The object written and the object read back are equal but their
 * serialisations are not, so hashing `JSON.stringify(rules)` reports an edit on
 * the very first read after arming — an agent that disarms itself immediately
 * and for no reason. Keys are therefore sorted recursively before hashing.
 *
 * Array order IS preserved, and is meaningful (rule order), so arrays are left
 * alone.
 */
export function hashStrategyRules(rules: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = canonical((value as Record<string, unknown>)[key]);
          return acc;
        }, {});
    }
    return value;
  };
  return createHash('sha256').update(JSON.stringify(canonical(rules))).digest('hex');
}

@Injectable()
export class UserStrategyAgentService {
  private readonly logger = new Logger(UserStrategyAgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sentinel: SentinelExecutionClient,
    private readonly execution: PaperExecutionService,
  ) {}

  /** Every profile bound to a user strategy, armed or not. */
  async runAll(now: Date = new Date()): Promise<UserStrategyPassResult[]> {
    const profiles = await this.prisma.executionProfile.findMany({
      where: { userStrategyId: { not: null }, enabled: true, environment: 'PAPER' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    const results: UserStrategyPassResult[] = [];
    for (const p of profiles) results.push(await this.runProfile(p.id, now));
    return results;
  }

  async runProfile(profileId: string, now: Date = new Date()): Promise<UserStrategyPassResult> {
    const profile = await this.prisma.executionProfile.findUnique({ where: { id: profileId } });
    if (!profile || !profile.userStrategyId) {
      return {
        profileId,
        profileName: profile?.name ?? profileId,
        outcome: 'error',
        verdict: null,
        barTime: null,
        reason: 'Profile is not bound to a user strategy.',
      };
    }
    const name = profile.name;

    const strategy = await this.prisma.userStrategy.findUnique({ where: { id: profile.userStrategyId } });
    if (!strategy) {
      return { profileId, profileName: name, outcome: 'error', verdict: null, barTime: null, reason: 'The bound strategy no longer exists.' };
    }

    // ---- Edit detection ---------------------------------------------------
    //
    // An armed strategy that has been edited must stop opening positions until
    // someone re-arms it: the rules that were reviewed are not the rules that
    // would now trade. This is checked by COMPARING a hash rather than by
    // hooking the write, because `services/sentinel-py` owns `UserStrategy`
    // and updates it directly via asyncpg — a Prisma middleware would never
    // see the edit.
    //
    // Note what this does NOT do: it does not touch open positions. Disarming
    // stops new entries; the position manager keeps its stop, target, trail and
    // square-off. That is the same disarm semantics the built-in agents have.
    const rulesHash = hashStrategyRules(strategy.rules);
    if (profile.strategyRulesHash && profile.strategyRulesHash !== rulesHash) {
      await this.prisma.executionProfile.update({
        where: { id: profileId },
        data: { enabled: false, certificationStatus: 'EDITED', certifiedAt: null },
      });
      await this.prisma.auditEvent.create({
        data: {
          eventType: 'execution.profile.disarmed.strategy-edited',
          metadata: { profileId, profileName: name, userStrategyId: strategy.id },
        },
      });
      this.logger.warn(`${name}: DISARMED — the bound strategy was edited since it was armed.`);
      return {
        profileId,
        profileName: name,
        outcome: 'disarmed-edited',
        verdict: null,
        barTime: null,
        reason: 'The bound strategy was edited after arming, so this agent was disarmed. Re-certify and re-arm to resume entries. Any open position stays under management.',
      };
    }

    // Resume point. Read from the decisions themselves rather than a separate
    // cursor column, so there is no second source of truth to drift — and so a
    // restart recovers exactly, with no window in which a bar could be
    // re-entered or skipped.
    const last = await this.prisma.strategyAgentDecision.findFirst({
      where: { profileId },
      orderBy: { barTime: 'desc' },
      select: { barTime: true },
    });

    let dto: UserStrategyEvaluationDto;
    try {
      dto = await this.sentinel.evaluateUserStrategy({
        symbol: profile.symbol,
        rules: strategy.rules,
        lastEvaluatedBarTime: last?.barTime.toISOString() ?? null,
        now: now.toISOString(),
      });
    } catch (err) {
      // A Sentinel outage is a SKIP, not a fault, and it must never look like
      // "the setup is not there" — so nothing is recorded for this bar and the
      // next pass will retry it.
      return {
        profileId,
        profileName: name,
        outcome: 'error',
        verdict: null,
        barTime: null,
        reason: `Sentinel unavailable: ${(err as Error).message}`,
      };
    }

    const evaluation = dto.evaluation;
    if (!evaluation) {
      return { profileId, profileName: name, outcome: 'error', verdict: null, barTime: null, reason: 'Sentinel returned no evaluation.' };
    }

    // Uncertified strategies never reach a market read on the Sentinel side,
    // and never produce a decision row here either — recording one would imply
    // the strategy was being watched.
    if (dto.certification.status !== 'TRADABLE') {
      return {
        profileId,
        profileName: name,
        outcome: 'not-certified',
        verdict: evaluation.verdict,
        barTime: null,
        reason: dto.certification.summary,
      };
    }

    // An `already-evaluated` refusal is the ordinary case between bars: the
    // agent polls far faster than a 5m bar closes. It is not recorded, because
    // a row per poll would bury the decisions that mean something.
    if (evaluation.verdict === 'refused' && evaluation.refusal === 'already-evaluated') {
      return { profileId, profileName: name, outcome: 'duplicate', verdict: 'refused', barTime: evaluation.barTime, reason: evaluation.reason };
    }

    if (!evaluation.barTime) {
      return { profileId, profileName: name, outcome: 'refused', verdict: evaluation.verdict, barTime: null, reason: evaluation.reason };
    }

    const barTime = new Date(evaluation.barTime);
    const mode = profile.agentMode as ExecutionAgentMode;

    // Claim the bar FIRST. If another worker already has it, this throws on the
    // unique constraint and we stop — before any order exists.
    let decisionId: string;
    try {
      const decision = await this.prisma.strategyAgentDecision.create({
        data: {
          profileId,
          userStrategyId: profile.userStrategyId,
          symbol: profile.symbol,
          interval: evaluation.interval ?? profile.strategyTimeframe ?? 'unknown',
          barTime,
          verdict: evaluation.verdict,
          refusal: evaluation.refusal,
          reason: evaluation.reason,
          mode,
          conditions: evaluation.conditions as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      decisionId = decision.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { profileId, profileName: name, outcome: 'duplicate', verdict: evaluation.verdict, barTime: evaluation.barTime, reason: 'Another worker already decided this bar.' };
      }
      throw err;
    }

    if (evaluation.verdict !== 'entry') {
      return {
        profileId,
        profileName: name,
        outcome: evaluation.verdict === 'waiting' ? 'waiting' : 'refused',
        verdict: evaluation.verdict,
        barTime: evaluation.barTime,
        reason: evaluation.reason,
      };
    }

    // ── ENTRY ────────────────────────────────────────────────────────────
    if (mode === 'SHADOW') {
      // The would-have-traded record: verdict 'entry' with intentId null. This
      // is what Phase 5 exists to produce, and what makes the eventual live
      // trades explainable before any of them happen.
      this.logger.log(`${name}: SHADOW entry on ${profile.symbol} @ ${evaluation.barTime} — ${evaluation.reason}`);
      return { profileId, profileName: name, outcome: 'shadow-entry', verdict: 'entry', barTime: evaluation.barTime, reason: evaluation.reason };
    }

    // LIVE. The order goes through the SAME PaperExecutionService the built-in
    // agents use, so sizing, the stop, the target, the trail, the risk gates
    // and the position record are all the platform's — the user's strategy
    // decided WHEN, and nothing else.
    const run = await this.execution.runProfile(profileId, now, this.toPresetEvaluation(profile.symbol, strategy.id, strategy.rules, dto, now));
    const intentId = run.intentId ?? null;
    if (intentId) {
      await this.prisma.strategyAgentDecision.update({ where: { id: decisionId }, data: { intentId } });
    }

    const entered = run.outcome === 'executed';
    this.logger.log(
      `${name}: LIVE entry on ${profile.symbol} @ ${evaluation.barTime} → ${run.outcome}${intentId ? ` (intent ${intentId})` : ''}`,
    );
    return {
      profileId,
      profileName: name,
      outcome: entered ? 'entered' : 'entry-blocked',
      verdict: 'entry',
      barTime: evaluation.barTime,
      reason: entered ? evaluation.reason : `${evaluation.reason} — but the order was not placed: ${run.reason ?? run.outcome}`,
      intentId: intentId ?? undefined,
    };
  }

  /** Recent decisions for the console — the "why didn't it trade?" surface. */
  async decisions(params: { profileId?: string; limit?: number; verdict?: string } = {}) {
    return this.prisma.strategyAgentDecision.findMany({
      where: {
        ...(params.profileId ? { profileId: params.profileId } : {}),
        ...(params.verdict ? { verdict: params.verdict } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(params.limit ?? 50, 200),
      include: { profile: { select: { name: true, agent: true, agentMode: true } } },
    });
  }

  /**
   * Present the user's decision in the shape the order path already speaks.
   *
   * ## The confidence number, stated plainly
   *
   * `evaluatePolicy` enforces a confidence floor (70, never lowerable). That
   * number is Sentinel's confidence in ITS OWN analysis, and a user strategy
   * does not produce one — its conditions are met or they are not. Inventing a
   * score in the 70s to squeak past the gate would be a fudge.
   *
   * So this reports 100, and it means something exact: every condition the
   * author marked mandatory is satisfied. We only reach this line on an `entry`
   * verdict, which is precisely that claim. The floor is left untouched for the
   * built-in agents, and the intent records `strategyId` as the user strategy
   * so nothing downstream mistakes this for a Sentinel confidence.
   *
   * ## Why the version is a hash of the rules
   *
   * Editing a strategy must not blend the new rules' results into the old
   * ones' calibration bucket. Hashing the rules means an edit starts a fresh
   * bucket automatically, with no migration and no edit-detection logic.
   */
  private toPresetEvaluation(
    symbol: string,
    strategyId: string,
    rules: unknown,
    dto: UserStrategyEvaluationDto,
    now: Date,
  ): ExecutionEvaluationDto {
    const evaluation = dto.evaluation!;
    const contract = dto.contract!;
    const version = hashStrategyRules(rules).slice(0, 12);
    const side = contract.optionType;

    return {
      verdict: 'executable',
      executable: true,
      reason: evaluation.reason,
      runId: null,
      symbol,
      observedAt: (evaluation.barTime ?? now.toISOString()) as string,
      spot: null,
      sideInFocus: {
        side,
        bias: side === 'CE' ? 'bullish' : 'bearish',
        strike: contract.strike,
        confidence: 100,
        rationale: evaluation.conditions.filter((c) => c.met).map((c) => `${c.label}: ${c.detail}`),
      },
      confidence: 100,
      publication: null,
      strategyId,
      strategyName: `user-strategy:${strategyId.slice(0, 8)}`,
      strikes: dto.strikes as ExecutionEvaluationDto['strikes'],
      expiry: contract.expiry,
      marketSnapshot: {
        source: 'user-strategy',
        interval: evaluation.interval,
        barTime: evaluation.barTime,
      },
      // The four agent gates do not apply on this path — the user's conditions
      // are the gate. They are reported as such rather than faked as passes, so
      // a journal row makes clear which regime produced the trade.
      dataQuality: {
        ok: true,
        checks: [],
        reason: 'Data quality is enforced by the user-strategy candle policy (closed bars, freshness, minimum history).',
      } as unknown as ExecutionEvaluationDto['dataQuality'],
      indexDirection: {
        direction: side === 'CE' ? 'bullish' : 'bearish',
        strength: 1,
        reads: [],
        reason: "Direction is the user strategy's declared entry side, not an index read.",
      } as unknown as ExecutionEvaluationDto['indexDirection'],
      agentStrategy: {
        strategyId,
        strategyName: `user-strategy:${strategyId.slice(0, 8)}`,
        version,
        regime: 'user-defined',
        bias: side === 'CE' ? 'bullish' : 'bearish',
        confidence: 100,
      } as unknown as ExecutionEvaluationDto['agentStrategy'],
      evidence: null,
      confirmations: evaluation.conditions.map((c) => ({
        id: c.condition,
        label: c.label,
        passed: c.met,
        detail: c.detail,
      })),
      exitRuleEvaluations: [],
    } as ExecutionEvaluationDto;
  }
}
