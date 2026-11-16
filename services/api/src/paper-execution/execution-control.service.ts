import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The operator kill switch for the autonomous paper-execution loop.
 *
 * ## Why this is durable when `ExecutionLoopStatus` deliberately is not
 *
 * The scheduler's status is process-local on purpose: it describes what THIS
 * process's timers are doing, and a persisted copy would keep asserting
 * "running" after the process that wrote it had gone.
 *
 * A HALT is the opposite kind of fact. It is an operator instruction, and an
 * instruction that evaporates on restart is not a safety control — a crash, a
 * deploy or a leader failover would silently resume trading that a human had
 * stopped for a reason, at exactly the moment nobody is watching. So it lives
 * in one database row and is re-read in the execution path on every pass.
 *
 * ## Halting and flattening are separate acts, and that is the design
 *
 * `entriesHalted` stops NEW positions being opened. It does not touch open
 * positions, and `PositionManagerService` is never gated on it: a halted loop
 * still holds every stop, target and trail it had a second earlier.
 *
 * That separation is deliberate. A single button that stopped entries AND
 * dumped every open position at market would be the most destructive control in
 * the console, and it would look like the safe one — the same trap the disarm
 * path already had (`enabled: false` used to strand open positions with no
 * stop). Flattening is `PositionManagerService.flatten`, reached by its own
 * endpoint, so "stop opening" and "close what is open" can never be one
 * accidental click. A true panic stop is both, in that order.
 *
 * ## The agent cannot reach this
 *
 * Nothing in the strategy, calibration or learning path reads or writes this
 * row. It is set only through the operator surface on `AdminController`, and
 * every change records who made it. A learning loop that could clear its own
 * kill switch is not a kill switch.
 */

/** The singleton row's id. Fixed, so the read is an indexed point lookup. */
const GLOBAL_ID = 'global';

export interface ExecutionControlState {
  entriesHalted: boolean;
  reason: string | null;
  /** The operator who last changed the halt. */
  haltedBy: string | null;
  /** When the halt was last turned ON. Null while running. */
  haltedAt: string | null;
  updatedAt: string | null;
}

const RUNNING: ExecutionControlState = {
  entriesHalted: false,
  reason: null,
  haltedBy: null,
  haltedAt: null,
  updatedAt: null,
};

@Injectable()
export class ExecutionControlService {
  private readonly logger = new Logger(ExecutionControlService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The current halt state.
   *
   * A MISSING row means "never halted", which is the correct default: the table
   * starts empty and a fresh deployment must not be born halted. Note that this
   * is the only absence treated as a value here — if the QUERY itself fails the
   * error propagates, and the caller's pass ends without trading. That is the
   * safe direction, and it is why this is not wrapped in a try/catch that
   * returns `RUNNING`: swallowing a database fault into "not halted" is exactly
   * how a kill switch silently stops working.
   */
  async state(): Promise<ExecutionControlState> {
    const row = await this.prisma.executionControl.findUnique({ where: { id: GLOBAL_ID } });
    if (!row) return RUNNING;
    return {
      entriesHalted: row.entriesHalted,
      reason: row.reason,
      haltedBy: row.haltedBy,
      haltedAt: row.haltedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Halt or resume new entries, globally.
   *
   * `haltedAt` is stamped only when halting and cleared on resume, so it always
   * answers "since when has this been stopped" rather than "when was this row
   * last touched" — `updatedAt` already answers the second question and the two
   * must not be conflated. `haltedBy` records the last operator either way,
   * because who RESUMED trading is as much an audit question as who stopped it.
   */
  async setHalt(args: { halted: boolean; reason?: string | null; operator: string }): Promise<ExecutionControlState> {
    const { halted, operator } = args;
    const reason = args.reason?.trim() || null;
    const now = new Date();

    const row = await this.prisma.executionControl.upsert({
      where: { id: GLOBAL_ID },
      create: {
        id: GLOBAL_ID,
        entriesHalted: halted,
        reason,
        haltedBy: operator,
        haltedAt: halted ? now : null,
      },
      update: {
        entriesHalted: halted,
        reason,
        haltedBy: operator,
        haltedAt: halted ? now : null,
      },
    });

    this.logger.warn(
      halted
        ? `EXECUTION HALTED by ${operator}${reason ? ` — ${reason}` : ''}. No new entries will be opened; open positions remain managed.`
        : `execution resumed by ${operator}${reason ? ` — ${reason}` : ''}. New entries are permitted again.`,
    );

    return {
      entriesHalted: row.entriesHalted,
      reason: row.reason,
      haltedBy: row.haltedBy,
      haltedAt: row.haltedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
