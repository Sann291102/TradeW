/**
 * Whether the Agent Lab may run right now — decided as a pure function, so the
 * whole gate can be asserted without a database, a network or a clock.
 *
 * ## Three states, not two
 *
 * `STOPPED` and `WAITING` look the same from outside — nothing is happening —
 * and they mean opposite things. STOPPED is a decision somebody made: the env
 * switch is off, or an operator killed it. WAITING is the Lab wanting to run
 * and being unable to, because a dependency is down or the market is shut.
 *
 * Collapsing them is how an outage gets mistaken for a configuration and goes
 * unnoticed for a day. The control room shows which one it is, and the reason.
 *
 * ## Resume is the absence of a start button
 *
 * There is no "start" transition to miss. The runner evaluates this on every
 * tick and observes when it says it may; a dependency coming back therefore
 * resumes the Lab on the next tick with no operator action and no restart. The
 * same property makes the Lab correct across a deploy, a database failover or a
 * Sentinel restart — it is not recovering, it is simply re-deciding.
 */

export type DependencyStatus = 'ok' | 'degraded' | 'unavailable';

export interface DependencyHealth {
  /** 'database' | 'sentinel' | 'market-data' */
  name: string;
  status: DependencyStatus;
  /** What was actually observed. Upstream text verbatim where there is any. */
  detail: string;
  /** Round-trip of the probe, when it was a call. */
  latencyMs?: number;
}

export type LabState = 'RUNNING' | 'WAITING' | 'STOPPED';

export interface LabHealth {
  state: LabState;
  /** May the Lab run an observation pass on this tick? */
  canObserve: boolean;
  /**
   * May the Lab place a paper order?
   *
   * FALSE THROUGHOUT PHASE 0, and not because a flag says so — because no
   * execution path exists yet. It is reported so the control room can state the
   * Lab's actual capability rather than implying one it does not have.
   */
  canExecute: boolean;
  dependencies: DependencyHealth[];
  session: {
    open: boolean;
    /** 'open' | 'closed:weekend' | 'closed:holiday' | 'closed:outside-hours' */
    reason: string;
  };
  /** Every reason the Lab is not observing, in the order they were found. */
  blockedBy: string[];
  checkedAt: string;
}

export interface HealthInput {
  /** The `AGENT_LAB_ENABLED` switch. */
  enabled: boolean;
  /** Set when an operator has stopped the Lab. Phase 1 wires the kill switch. */
  stoppedByOperator?: string | null;
  dependencies: DependencyHealth[];
  session: { open: boolean; reason: string };
  /**
   * Whether the Lab should observe outside the session.
   *
   * Default false for Indian equities: there are no new bars, so a pass would
   * re-evaluate identical data and write nothing but noise. A 24/7 market
   * adapter (crypto) sets this true, which is why it is an input rather than a
   * constant — the session model belongs to the market, not to the Lab.
   */
  observeOutsideSession: boolean;
  /** Dependencies without which no observation may happen. */
  requiredDependencies: string[];
  checkedAt: Date;
}

export function evaluateHealth(input: HealthInput): LabHealth {
  const blockedBy: string[] = [];

  // STOPPED is checked first and reported alone. An operator who switched the
  // Lab off does not need to be told the market is also closed.
  if (!input.enabled) {
    return stopped(input, 'AGENT_LAB_ENABLED is not "true" — the Lab is switched off.');
  }
  if (input.stoppedByOperator) {
    return stopped(input, `Stopped by ${input.stoppedByOperator}.`);
  }

  for (const name of input.requiredDependencies) {
    const dep = input.dependencies.find((d) => d.name === name);
    if (!dep) {
      blockedBy.push(`${name}: not checked`);
      continue;
    }
    if (dep.status !== 'ok') blockedBy.push(`${name}: ${dep.status} — ${dep.detail}`);
  }

  if (!input.session.open && !input.observeOutsideSession) {
    blockedBy.push(`market session ${input.session.reason}`);
  }

  return {
    state: blockedBy.length === 0 ? 'RUNNING' : 'WAITING',
    canObserve: blockedBy.length === 0,
    // Phase 0 has no execution path at all. See the field's own note.
    canExecute: false,
    dependencies: input.dependencies,
    session: input.session,
    blockedBy,
    checkedAt: input.checkedAt.toISOString(),
  };
}

function stopped(input: HealthInput, reason: string): LabHealth {
  return {
    state: 'STOPPED',
    canObserve: false,
    canExecute: false,
    dependencies: input.dependencies,
    session: input.session,
    blockedBy: [reason],
    checkedAt: input.checkedAt.toISOString(),
  };
}

/**
 * A stable identity for "what is wrong right now", so a health event is written
 * on a CHANGE rather than on every tick.
 *
 * Without this a two-hour Sentinel outage writes a row every minute and buries
 * the timeline it exists to clarify. With it, the outage is one
 * `HEALTH_DEGRADED`, and a second dependency failing later is a genuinely new
 * event because the fingerprint changed.
 *
 * ## It must be built from STATUS, never from the detail text
 *
 * The first version hashed `blockedBy`, which reads well and is wrong. Those
 * strings embed live values — "newest bar … (779949s old)" — so the fingerprint
 * changed every second, and every tick therefore looked like a fresh
 * degradation. The result was a health event and a skip event per tick,
 * i.e. exactly the flood the fingerprint exists to prevent, with the mechanism
 * apparently working. `verify:agent-lab` caught it as duplicate rows; nothing
 * in the code reads as a defect.
 *
 * So the identity is the shape of the problem — which dependencies, in which
 * status, plus the session and the run state — and never the prose describing
 * it. A dependency going from `degraded` to `unavailable` is a real change and
 * still moves the fingerprint; a counter ticking upward inside a message is not.
 */
export function healthFingerprint(health: LabHealth): string {
  const deps = health.dependencies
    .map((d) => `${d.name}:${d.status}`)
    .sort()
    .join(',');
  return `${health.state}|${health.session.reason}|${deps}`;
}
