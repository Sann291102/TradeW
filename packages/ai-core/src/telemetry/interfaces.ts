/**
 * Telemetry contracts — what the AI foundation reports about itself.
 *
 * These types exist so the admin portal can answer three questions that
 * nothing in the product surface can: what LLM calls were made, what did they
 * cost, and what were the agents doing while they ran.
 *
 * ai-core defines the SHAPE and emits the events; it deliberately does not
 * know where they go. `@tradew/ai-core` has no database dependency and must
 * not acquire one — persistence is a `TelemetrySink` installed by the host
 * process (`services/api` writes to Postgres; a test installs a collector; a
 * CLI installs nothing and the events are dropped). This is the same
 * inversion the provider layer uses: the package defines the contract, the
 * host chooses the implementation.
 */

/** One completed call to an LLM provider. Emitted after the call settles — success or failure. */
export interface AiCallEvent {
  /** Correlates to the HTTP request that triggered this, when there was one. */
  requestId?: string;
  /** Product surface: 'sentinel' | 'tradew-ai' | 'research' | 'learning'. */
  system: string;
  /** Agent name from the system's `definitions.json`. 'unattributed' when a call is made outside an agent. */
  agent: string;
  provider: string;
  model: string;
  tier?: string;
  promptTokens: number;
  completionTokens: number;
  /** USD, computed at call time from the rate card — see `estimateCostUsd`. */
  costUsd: number;
  latencyMs: number;
  status: 'ok' | 'error' | 'timeout' | 'refused' | 'fallback';
  /** Message only. Never a stack, and never the prompt or completion — this is
   *  rendered in a browser and prompts can carry user positions. */
  error?: string;
  userId?: string;
}

/**
 * One state transition of one agent within a run.
 *
 * The state vocabulary is small and fixed because the admin portal renders it
 * directly as a visual: each state maps to one orb appearance in the Sentinel
 * orbit. Adding a state means adding a visual, so new values are a deliberate
 * change rather than a free-form string.
 *
 *  · `queued`    — the orchestrator has decided to call this agent, nothing has run
 *  · `thinking`  — the agent is computing or waiting on its LLM call
 *  · `sending`   — handing a result to `peer` (almost always the orchestrator)
 *  · `receiving` — taking input from `peer`
 *  · `done`      — finished and reported
 *  · `error`     — failed; the run may still complete without it
 *  · `idle`      — did not participate in this run
 */
export type AgentState = 'queued' | 'thinking' | 'sending' | 'receiving' | 'done' | 'error' | 'idle';

export interface AgentActivityEvent {
  runId: string;
  requestId?: string;
  system: string;
  agent: string;
  state: AgentState;
  /** The other end of a directional transition. */
  peer?: string;
  /** One short line, safe to render: 'scanning 15m structure', not a prompt dump. */
  detail?: string;
  durationMs?: number;
  /** Epoch ms. Set by the emitter so ordering survives a buffered write. */
  at: number;
}

/** A run opening. */
export interface AgentRunStartEvent {
  runId: string;
  requestId?: string;
  system: string;
  /** 'observe' | 'chat' | 'market-close' | 'backtest' */
  trigger: string;
  symbol?: string;
  userId?: string;
  at: number;
}

/** A run closing. `agentsRan` is filled in by the tracker, not the caller. */
export interface AgentRunEndEvent {
  runId: string;
  status: 'ok' | 'error';
  agentsRan: string[];
  /** Did the run produce user-facing copy? Sentinel staying silent is a normal,
   *  non-error outcome — this is how the portal distinguishes the two. */
  surfaced: boolean;
  confidence?: number;
  error?: string;
  durationMs: number;
  at: number;
}

/**
 * Where telemetry goes. Every method is fire-and-forget and MUST NOT throw:
 * the bus calls these from inside product code paths, and a telemetry failure
 * degrading a trader-facing request would invert the entire point of the
 * system. Implementations swallow their own errors.
 */
export interface TelemetrySink {
  aiCall(event: AiCallEvent): void;
  agentActivity(event: AgentActivityEvent): void;
  runStart(event: AgentRunStartEvent): void;
  runEnd(event: AgentRunEndEvent): void;
}
