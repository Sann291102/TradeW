import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type {
  AgentActivityEvent,
  AgentRunEndEvent,
  AgentRunStartEvent,
  AgentState,
  AiCallEvent,
  TelemetrySink,
} from './interfaces';

/**
 * The in-process telemetry bus.
 *
 * Two things live here, and they solve the same problem from opposite ends:
 *
 *  1. **A sink registry.** The host installs one sink; everything in ai-core
 *     and its consumers emits through the module-level helpers. Nothing has to
 *     thread a logger through a dozen constructors.
 *  2. **Ambient run context** (`AsyncLocalStorage`). An agent deep inside the
 *     orchestrator needs to stamp its LLM call with the runId and requestId it
 *     belongs to, and those are established several frames up. Passing them
 *     explicitly would mean changing the signature of every intelligence
 *     service to carry a correlation id that only telemetry reads — which is
 *     exactly the kind of change that gets half-applied and leaves the portal
 *     showing orphaned rows. AsyncLocalStorage propagates them across awaits
 *     without touching a single business signature.
 *
 * **No sink installed is a supported state**, not a misconfiguration. Tests,
 * CLIs and the backtest runner import ai-core without a database; they emit
 * into the void and pay one null check for it.
 */

let sink: TelemetrySink | null = null;

/** Install the process-wide sink. Called once at boot by the host. */
export function setTelemetrySink(next: TelemetrySink | null): void {
  sink = next;
}

export function getTelemetrySink(): TelemetrySink | null {
  return sink;
}

/** Correlation context carried across async boundaries for the life of a run. */
export interface TelemetryContext {
  requestId?: string;
  runId?: string;
  system?: string;
  userId?: string;
  /** Set by `runAgentRun`; agents append themselves so the run knows who took part. */
  agentsRan?: Set<string>;
}

const storage = new AsyncLocalStorage<TelemetryContext>();

/** The ambient context, or an empty object outside any run. Never throws. */
export function currentTelemetryContext(): TelemetryContext {
  return storage.getStore() ?? {};
}

/** Run `fn` with `context` merged over whatever is already ambient. */
export function withTelemetryContext<T>(context: TelemetryContext, fn: () => T): T {
  return storage.run({ ...currentTelemetryContext(), ...context }, fn);
}

/**
 * Every emit is wrapped in this. A sink that throws — a Prisma client whose
 * connection died mid-flush, say — must not propagate into the caller's stack,
 * because the caller is a trading feature and telemetry is not.
 */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    /* telemetry never breaks the caller */
  }
}

export function emitAiCall(event: AiCallEvent): void {
  const ctx = currentTelemetryContext();
  safely(() =>
    sink?.aiCall({
      ...event,
      requestId: event.requestId ?? ctx.requestId,
      userId: event.userId ?? ctx.userId,
    }),
  );
}

/**
 * Report an agent state transition. `runId`/`system` fall back to the ambient
 * run, so an agent only has to say what it is doing, not where it is.
 *
 * Silently drops the event when there is no runId anywhere — an activity row
 * with no run to belong to would render as a ghost node in the orbit.
 */
export function emitAgentActivity(
  agent: string,
  state: AgentState,
  extra: { peer?: string; detail?: string; durationMs?: number; runId?: string; system?: string } = {},
): void {
  const ctx = currentTelemetryContext();
  const runId = extra.runId ?? ctx.runId;
  if (!runId) return;
  ctx.agentsRan?.add(agent);
  safely(() =>
    sink?.agentActivity({
      runId,
      requestId: ctx.requestId,
      system: extra.system ?? ctx.system ?? 'unknown',
      agent,
      state,
      peer: extra.peer,
      detail: extra.detail,
      durationMs: extra.durationMs,
      at: Date.now(),
    } satisfies AgentActivityEvent),
  );
}

export interface RunOutcome {
  surfaced?: boolean;
  confidence?: number;
}

/**
 * Wrap one orchestrator run: opens the run, establishes ambient context so
 * every nested agent and LLM call correlates to it, and closes it on the way
 * out — including on the throw path, which is the case that matters. A run
 * that errors is the most interesting row in the table and it is also the one
 * a naive `emit` at the end of the happy path would never write.
 *
 * `fn` receives the runId, and may return `{ surfaced, confidence }` to
 * describe the outcome. Returning nothing is fine.
 */
export async function runAgentRun<T extends RunOutcome | void>(
  start: Omit<AgentRunStartEvent, 'runId' | 'at'> & { runId?: string },
  fn: (runId: string) => Promise<T>,
): Promise<T> {
  const runId = start.runId ?? randomUUID();
  const ctx = currentTelemetryContext();
  const startedAt = Date.now();
  const agentsRan = new Set<string>();

  safely(() =>
    sink?.runStart({
      runId,
      requestId: start.requestId ?? ctx.requestId,
      system: start.system,
      trigger: start.trigger,
      symbol: start.symbol,
      userId: start.userId ?? ctx.userId,
      at: startedAt,
    } satisfies AgentRunStartEvent),
  );

  const close = (status: 'ok' | 'error', outcome: RunOutcome, error?: string) =>
    safely(() =>
      sink?.runEnd({
        runId,
        status,
        agentsRan: [...agentsRan],
        surfaced: outcome.surfaced ?? false,
        confidence: outcome.confidence,
        error,
        durationMs: Date.now() - startedAt,
        at: Date.now(),
      } satisfies AgentRunEndEvent),
    );

  return withTelemetryContext(
    { runId, system: start.system, requestId: start.requestId ?? ctx.requestId, userId: start.userId ?? ctx.userId, agentsRan },
    async () => {
      try {
        const result = await fn(runId);
        close('ok', (result ?? {}) as RunOutcome);
        return result;
      } catch (err) {
        close('error', {}, err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
  );
}

/**
 * Wrap one agent's turn: `thinking` on entry, `sending` (to the orchestrator)
 * on success, `error` on failure. This is the helper the intelligence services
 * call, so a correctly-instrumented agent is three characters of diff rather
 * than four emit calls that can drift out of sync with each other.
 */
export async function trackAgent<T>(
  agent: string,
  fn: () => Promise<T>,
  options: { peer?: string; detail?: string } = {},
): Promise<T> {
  const startedAt = Date.now();
  emitAgentActivity(agent, 'thinking', { detail: options.detail });
  try {
    const result = await fn();
    emitAgentActivity(agent, 'sending', {
      peer: options.peer ?? 'orchestrator',
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    emitAgentActivity(agent, 'error', {
      detail: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}
