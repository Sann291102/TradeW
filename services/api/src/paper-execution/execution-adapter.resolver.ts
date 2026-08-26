import { Injectable, Logger } from '@nestjs/common';
import { BrokerExecutionAdapter } from './broker-execution.adapter';
import { LiveExecutionNotAuthorizedError, type ExecutionAdapter } from './execution-adapter';
import { PaperExecutionAdapter } from './paper-execution.adapter';
import { environmentFor, isExecutingState, type ExecutionProfileState } from './execution-state';

/**
 * Which engine a profile executes against — the one place that decision is made.
 *
 * ## Why this object exists at all
 *
 * Without it, `PaperExecutionService` would hold both adapters and choose
 * between them with an `if`. That reads fine and is exactly the shape §12 warns
 * about: the live adapter would then be one import and one inverted condition
 * away from every paper order in the system, and the condition would sit in a
 * 600-line method next to nine other conditions.
 *
 * With it, the executor holds no adapter at all until it asks, and the asking
 * takes a STATE — not a boolean, not an environment string from the row, not a
 * caller's opinion.
 *
 * ## The refusal is the default
 *
 * `environmentFor` returns null for every non-executing state, and null falls
 * through to a throw. Adding a new state to the enum without adding it to
 * `PAPER_EXECUTING_STATES`/`LIVE_EXECUTING_STATES` therefore produces a profile
 * that cannot execute — the safe failure. The alternative shape, a switch with
 * a `default: return paperAdapter`, produces one that silently can.
 *
 * ## Live additionally needs the deployment to have said yes
 *
 * `LIVE_EXECUTION_ENABLED` is a deployment-level kill switch, unset by default.
 * It is NOT the authorization — the state is — but it means a deployment that
 * has never intended to trade live (a staging environment restored from a
 * production dump, say, complete with a LIVE_ARMED profile) cannot, regardless
 * of what its rows say.
 */
@Injectable()
export class ExecutionAdapterResolver {
  private readonly logger = new Logger(ExecutionAdapterResolver.name);

  constructor(
    private readonly paper: PaperExecutionAdapter,
    // Injected, but reachable only through the LIVE branch below. Nest
    // constructs it either way; what matters is that no other class in the
    // execution path holds a reference.
    private readonly brokerAdapter: BrokerExecutionAdapter,
  ) {}

  private get liveEnabledForDeployment(): boolean {
    return (process.env.LIVE_EXECUTION_ENABLED ?? 'false').toLowerCase() === 'true';
  }

  /**
   * The adapter this state may use.
   *
   * @throws LiveExecutionNotAuthorizedError when the state does not permit
   *   execution at all, or permits live on a deployment where live is off.
   */
  resolve(state: ExecutionProfileState, profileName = 'profile'): ExecutionAdapter {
    if (!isExecutingState(state)) {
      throw new LiveExecutionNotAuthorizedError(
        `${profileName} is ${state} and may not execute in any engine.`,
      );
    }

    const engine = environmentFor(state);

    if (engine === 'LIVE') {
      if (!this.liveEnabledForDeployment) {
        throw new LiveExecutionNotAuthorizedError(
          `${profileName} is ${state}, but LIVE_EXECUTION_ENABLED is not "true" on this deployment. ` +
            'No broker order was attempted.',
        );
      }
      this.logger.warn(`${profileName}: resolving the LIVE broker adapter (state ${state}).`);
      return this.brokerAdapter;
    }

    if (engine === 'PAPER') return this.paper;

    // Unreachable while `environmentFor` and `isExecutingState` agree, which is
    // asserted in execution-state.spec.ts. Kept as a throw rather than a
    // fallback to paper: a state the two functions disagree about is a bug, and
    // executing anyway would hide it.
    throw new LiveExecutionNotAuthorizedError(`${profileName}: no execution engine resolves for state ${state}.`);
  }

  /** Which engine a state would use, without constructing anything. */
  engineFor(state: ExecutionProfileState): 'PAPER' | 'LIVE' | null {
    return environmentFor(state);
  }
}
