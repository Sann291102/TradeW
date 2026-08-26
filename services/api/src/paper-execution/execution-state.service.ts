import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ExecutionEnvironment, ExecutionProfileState as PrismaState, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  type ExecutionProfileState,
  type ExecutionStateAction,
  STATE_LABELS,
  environmentFor,
  evaluateTransition,
  isExecutingState,
} from './execution-state';

/**
 * The only writer of `ExecutionProfile.state`.
 *
 * ## Why every state change goes through one object
 *
 * Three things must happen together, or the model is a lie:
 *
 *   1. the state moves, and only along a legal edge;
 *   2. `enabled` is re-derived from it, because a dozen existing queries filter
 *      on that column and a profile that reads `enabled=true` while its state
 *      says DISARMED would keep being selected by the loop;
 *   3. an `ExecutionStateTransition` row records who did it and why.
 *
 * Doing those in three places is how they come apart. They are one transaction
 * here, and no other code in the repository updates `state` — the executor's
 * own PAPER_ARMED → PAPER_RUNNING promotion calls `noteRunning` on this
 * service rather than writing the column.
 *
 * ## The compare-and-set is the concurrency guarantee
 *
 * The update's WHERE clause carries the state the transition was decided
 * against. Two administrators clicking Disarm and Arm Live at the same instant
 * therefore cannot both succeed: the second's `updateMany` matches zero rows
 * and it is told the profile moved underneath it. A read-then-write would let
 * the loser's decision, computed against a state that no longer exists, land
 * anyway — and on this particular table the losing write could be the one that
 * authorizes live money.
 */
@Injectable()
export class ExecutionStateService {
  private readonly logger = new Logger(ExecutionStateService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Apply one action to one profile.
   *
   * `actor` is a principal string — `admin:<operator>`, `user:<userId>` or
   * `system`. Recorded verbatim on the transition; never parsed for
   * authorization, which happens in the guard before this is reached.
   */
  async apply(
    profileId: string,
    action: ExecutionStateAction,
    actor: string,
    options: { reason?: string | null; silent?: boolean } = {},
  ) {
    const profile = await this.prisma.executionProfile.findUnique({
      where: { id: profileId },
      include: { qualification: true },
    });
    if (!profile) throw new NotFoundException(`No execution profile ${profileId}`);

    const from = profile.state as ExecutionProfileState;
    const decision = evaluateTransition({
      from,
      action,
      resumeState: (profile.resumeState as ExecutionProfileState | null) ?? null,
      qualificationPassed: profile.qualification?.passed ?? false,
      // Resuming into a live state requires the administrator's live arm to
      // still be on the row — otherwise `resumeState` alone would be a second
      // door into live execution. See TransitionRequest.liveArmed.
      liveArmed: profile.liveArmedAt != null,
    });

    if (!decision.allowed || !decision.to) {
      // The system-driven actions are called speculatively on every pass —
      // `noteRunning` fires whether or not a promotion applies — so a refusal
      // there is ordinary and must not raise. Operator actions raise, because
      // an operator who clicked a button is owed an answer.
      if (options.silent) return { changed: false as const, from, to: from, reason: decision.reason };
      throw new ConflictException(decision.reason ?? 'That transition is not permitted.');
    }

    const to = decision.to;
    if (to === from) return { changed: false as const, from, to, reason: 'Already in that state.' };

    const now = new Date();
    const enabled = isExecutingState(to);
    const env = environmentFor(to) ?? environmentFor(from) ?? 'PAPER';

    const data: Prisma.ExecutionProfileUpdateManyMutationInput = {
      state: to as PrismaState,
      enabled,
      // The environment column follows the state, so an intent written by the
      // next pass is stamped with the engine that actually executed it. It is a
      // RECORD, not a permission — see execution-state.ts.
      environment: env as ExecutionEnvironment,
    };

    // Pause remembers where to come back to; every other transition clears it,
    // so a stale resume target can never outlive the pause that set it.
    if (to === 'PAUSED') {
      data.resumeState = from as PrismaState;
      data.pausedAt = now;
      data.pausedReason = options.reason ?? null;
    } else {
      data.resumeState = null;
      data.pausedAt = null;
      data.pausedReason = null;
    }

    if (action === 'ARM_PAPER') {
      data.paperArmedAt = now;
      data.paperArmedBy = actor;
      data.disarmedAt = null;
      data.disarmedBy = null;
      // Arming clears a previous fault's message so the console does not show a
      // resolved error beside a freshly armed profile.
      data.lastError = null;
      data.lastErrorAt = null;
    }
    if (action === 'ARM_LIVE') {
      data.liveArmedAt = now;
      data.liveArmedBy = actor;
    }
    if (action === 'DISARM_LIVE') {
      data.liveArmedAt = null;
      data.liveArmedBy = null;
    }
    if (action === 'DISARM') {
      data.disarmedAt = now;
      data.disarmedBy = actor;
      // Standing a profile down also withdraws live authorization. Leaving
      // `liveArmedAt` set would let a later re-arm read as though live had never
      // been withdrawn.
      data.liveArmedAt = null;
      data.liveArmedBy = null;
    }
    if (action === 'CLEAR_ERROR') {
      data.lastError = null;
      data.lastErrorAt = null;
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // COMPARE-AND-SET. `state: from` in the WHERE is the whole concurrency
      // story — see the class docstring.
      const updated = await tx.executionProfile.updateMany({
        where: { id: profileId, state: from as PrismaState },
        data,
      });
      if (updated.count !== 1) return null;

      await tx.executionStateTransition.create({
        data: {
          profileId,
          fromState: from as PrismaState,
          toState: to as PrismaState,
          environment: env as ExecutionEnvironment,
          actor,
          reason: options.reason ?? null,
          // The evidence an ARM_LIVE was justified by, frozen at the moment it
          // was cited. The live snapshot is recomputed on a schedule and would
          // otherwise change under the audit record that relies on it.
          qualificationSnapshot:
            action === 'ARM_LIVE' && profile.qualification
              ? ({
                  evaluatedAt: profile.qualification.evaluatedAt.toISOString(),
                  passed: profile.qualification.passed,
                  trades: profile.qualification.trades,
                  winRate: profile.qualification.winRate,
                  netPnl: Number(profile.qualification.netPnl),
                  maxDrawdownPct: profile.qualification.maxDrawdownPct,
                  criteria: profile.qualification.criteria,
                } as unknown as Prisma.InputJsonValue)
              : undefined,
        },
      });

      // The generic administrative audit log keeps its own copy. The typed
      // table above is what the console renders; this is what a
      // whole-platform audit query reads, and neither should have to know
      // about the other.
      await tx.auditEvent.create({
        data: {
          eventType: `execution.state.${action.toLowerCase()}`,
          metadata: {
            profileId,
            profileName: profile.name,
            from,
            to,
            environment: env,
            actor,
            ...(options.reason ? { reason: options.reason } : {}),
          },
        },
      });

      return tx.executionProfile.findUnique({ where: { id: profileId } });
    });

    if (!result) {
      throw new ConflictException(
        `This profile moved out of ${STATE_LABELS[from]} while the change was being applied. Reload and try again.`,
      );
    }

    this.logger.log(`${profile.name}: ${from} → ${to} by ${actor}${options.reason ? ` (${options.reason})` : ''}`);
    return { changed: true as const, from, to, reason: options.reason ?? null, profile: result };
  }

  /**
   * Promote an armed profile to running, once it has actually produced a
   * decision.
   *
   * Called by the executor on every pass that reached a decision, so the
   * no-op case is the common one and must be silent — hence `silent: true`.
   * The distinction it maintains ("armed" vs "running") is the one the console
   * could not previously show at all.
   */
  async noteRunning(profileId: string) {
    return this.apply(profileId, 'NOTE_RUNNING', 'system', {
      reason: 'First decision produced.',
      silent: true,
    });
  }

  /** Record a fault and halt the profile. No automatic recovery — see ERROR. */
  async markError(profileId: string, message: string) {
    await this.prisma.executionProfile.update({
      where: { id: profileId },
      data: { lastError: message.slice(0, 500), lastErrorAt: new Date() },
    });
    return this.apply(profileId, 'MARK_ERROR', 'system', { reason: message.slice(0, 500), silent: true });
  }

  /**
   * The live authorization question, answered from the database at the moment
   * it is asked.
   *
   * `PaperExecutionService` calls this immediately before submitting — not at
   * the top of the pass, and not from a value the scheduler cached — because
   * §15 requires a disarm to stop the pass that is already in flight, not the
   * one after it. A Sentinel evaluation takes seconds; an operator hitting the
   * stop button during those seconds must win.
   */
  async currentAuthorization(profileId: string): Promise<{
    state: ExecutionProfileState;
    environment: 'PAPER' | 'LIVE' | null;
    mayExecute: boolean;
    autoTradeEnabled: boolean;
    accountScope: string;
  }> {
    const row = await this.prisma.executionProfile.findUnique({
      where: { id: profileId },
      select: { state: true, autoTradeEnabled: true, accountScope: true },
    });
    if (!row) throw new NotFoundException(`No execution profile ${profileId}`);
    const state = row.state as ExecutionProfileState;
    return {
      state,
      environment: environmentFor(state),
      mayExecute: isExecutingState(state),
      autoTradeEnabled: row.autoTradeEnabled,
      accountScope: row.accountScope,
    };
  }

  /** The profile's transition history, newest first. */
  async history(profileId: string, limit = 50) {
    const rows = await this.prisma.executionStateTransition.findMany({
      where: { profileId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map((t) => ({
      id: t.id,
      at: t.createdAt.toISOString(),
      from: t.fromState,
      to: t.toState,
      environment: t.environment,
      actor: t.actor,
      reason: t.reason,
      fromLabel: STATE_LABELS[t.fromState as ExecutionProfileState],
      toLabel: STATE_LABELS[t.toState as ExecutionProfileState],
    }));
  }

  /**
   * Backward-compatible arm/disarm for the console's original switch.
   *
   * `POST /admin/execution/profiles/:id/enabled` predates the state machine and
   * is still what an older console build calls. Mapping it onto the actions
   * rather than letting it write `enabled` directly is what keeps the invariant
   * true for every caller — including one this repository no longer contains.
   */
  async setEnabled(profileId: string, enabled: boolean, actor: string) {
    const current = await this.prisma.executionProfile.findUnique({
      where: { id: profileId },
      select: { state: true },
    });
    if (!current) throw new NotFoundException(`No execution profile ${profileId}`);
    const state = current.state as ExecutionProfileState;

    if (enabled) {
      if (isExecutingState(state)) return { changed: false as const, from: state, to: state, reason: 'Already armed.' };
      if (state === 'PAUSED') return this.apply(profileId, 'RESUME', actor, { reason: 'Re-armed from the console.' });
      return this.apply(profileId, 'ARM_PAPER', actor, { reason: 'Armed from the console.' });
    }
    if (!isExecutingState(state) && state !== 'PAUSED') {
      return { changed: false as const, from: state, to: state, reason: 'Already disarmed.' };
    }
    return this.apply(profileId, 'DISARM', actor, { reason: 'Disarmed from the console.' });
  }

  /** Guard for a caller that must not proceed unless the profile may execute. */
  assertExecutable(state: ExecutionProfileState): void {
    if (!isExecutingState(state)) {
      throw new BadRequestException(`This profile is ${STATE_LABELS[state]} and may not execute.`);
    }
  }
}
