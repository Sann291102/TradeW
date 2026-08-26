import { Injectable, Logger } from '@nestjs/common';
import { SystemExecutionMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The global paper-execution kill switch.
 *
 * ## What it is, and what it is not
 *
 * `PAPER_EXECUTION_ENABLED` (env) decides whether the scheduler's TIMERS EXIST.
 * This decides whether an already-ticking loop may OPEN NEW POSITIONS. The two
 * are independent on purpose: the env flag is a deploy-time decision, this is
 * the switch an operator flips from the console mid-session and the loop honours
 * on its very next pass — no redeploy, no per-profile disarming, no missed
 * profile.
 *
 * ## The three modes, stated as their effects on the loop
 *
 *   ON             — new entries permitted (still subject to every other gate).
 *   OFF            — no new entries; reconcile and scheduled square-off continue.
 *   EMERGENCY_STOP — no new entries; every open agent position is squared off on
 *                    the next reconcile tick regardless of its profile's own
 *                    `squareOffMinute`.
 *
 * The mapping from mode to those two booleans is the pure function
 * `evaluateSystemControl`, so the rule can be asserted without a database and
 * the loop consumes one small, obvious object rather than re-deriving the
 * meaning of each mode at every call site.
 */

/** The keyed identity of the singleton control row. See the Prisma model. */
export const SYSTEM_CONTROL_KEY = 'GLOBAL';

export interface SystemControlGate {
  mode: SystemExecutionMode;
  /** May the loop open a NEW position this pass? Only when mode is ON. */
  allowNewEntries: boolean;
  /**
   * Must every open agent position be squared off now, ignoring the profile's
   * own square-off minute? Only under EMERGENCY_STOP.
   */
  forceSquareOff: boolean;
}

/**
 * The whole meaning of each mode, as a pure function of the mode alone.
 *
 * Deliberately total over the enum: a mode added to the schema without a branch
 * here fails the exhaustiveness check at compile time rather than silently
 * defaulting to "trade" — the safe default for a new, unconsidered mode is never
 * "keep trading".
 */
export function evaluateSystemControl(mode: SystemExecutionMode): SystemControlGate {
  switch (mode) {
    case 'ON':
      return { mode, allowNewEntries: true, forceSquareOff: false };
    case 'OFF':
      return { mode, allowNewEntries: false, forceSquareOff: false };
    case 'EMERGENCY_STOP':
      return { mode, allowNewEntries: false, forceSquareOff: true };
    default: {
      // Exhaustiveness guard. If the enum grows a member, this stops compiling.
      const unreachable: never = mode;
      return { mode: unreachable, allowNewEntries: false, forceSquareOff: false };
    }
  }
}

export interface SystemControlState {
  mode: SystemExecutionMode;
  reason: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  /** True when no row exists yet — the loop is running on the default (ON). */
  isDefault: boolean;
}

@Injectable()
export class SystemExecutionControlService {
  private readonly logger = new Logger(SystemExecutionControlService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The current control state.
   *
   * A missing row means nobody has ever flipped the switch, which reads as ON —
   * the absence of an explicit stop is not a stop. Reported with `isDefault`
   * so the console can tell "explicitly ON" from "never configured".
   */
  async current(): Promise<SystemControlState> {
    const row = await this.prisma.systemExecutionControl.findUnique({ where: { key: SYSTEM_CONTROL_KEY } });
    if (!row) {
      return { mode: 'ON', reason: null, updatedBy: null, updatedAt: null, isDefault: true };
    }
    return {
      mode: row.mode,
      reason: row.reason,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt.toISOString(),
      isDefault: false,
    };
  }

  /**
   * The gate the execution loop reads every pass.
   *
   * Read fresh, never cached: a kill switch that respects a cache TTL is a kill
   * switch with a delay, and one keyed lookup per 60 s tick is free. If the read
   * itself fails, fail CLOSED — a database the loop cannot reach is not a licence
   * to keep opening positions blind.
   */
  async gate(): Promise<SystemControlGate> {
    try {
      const { mode } = await this.current();
      return evaluateSystemControl(mode);
    } catch (err) {
      this.logger.error(`could not read system execution control — failing closed (no new entries): ${(err as Error).message}`);
      return { mode: 'OFF', allowNewEntries: false, forceSquareOff: false };
    }
  }

  /**
   * Set the mode, audited in the same transaction as the write.
   *
   * The `AuditEvent` and the flag cannot diverge — either both land or neither
   * does — for the same reason `setAgentPaperTrading` audits transactionally:
   * this is the switch that starts and stops autonomous trading, and "who
   * stopped it, and when" must be as durable as the stop itself.
   */
  async setMode(mode: SystemExecutionMode, operator: string, reason?: string | null): Promise<SystemControlState> {
    const previous = await this.current();
    const row = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.systemExecutionControl.upsert({
        where: { key: SYSTEM_CONTROL_KEY },
        create: { key: SYSTEM_CONTROL_KEY, mode, reason: reason ?? null, updatedBy: operator },
        update: { mode, reason: reason ?? null, updatedBy: operator },
      });
      await tx.auditEvent.create({
        data: {
          eventType: 'execution.system-control.set',
          metadata: { mode, previousMode: previous.mode, reason: reason ?? null, operator },
        },
      });
      return saved;
    });
    this.logger.warn(`system execution mode set to ${mode} by ${operator}${reason ? ` — ${reason}` : ''} (was ${previous.mode})`);
    return {
      mode: row.mode,
      reason: row.reason,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt.toISOString(),
      isDefault: false,
    };
  }
}
