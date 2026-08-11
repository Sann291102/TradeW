import type { PanelKind, ThemeName } from '../store/workspaceStore';
import type { QuoteAsk } from './quotes';

/**
 * TradeW AI assistant — control-layer types (Phase 1).
 *
 * Implements the Navigation-intent half of `docs/product-architecture/
 * TRADEW-ASSISTANT.md` §2/§3/§5: the assistant resolves an utterance to
 * concrete app actions and executes them, rather than answering with prose.
 * The product reference is Perplexity's Comet — the agent takes control of
 * the surface on command and shows what it did.
 *
 * Everything in this module is DETERMINISTIC — no LLM call, no network. That
 * is deliberate (TRADEW-ASSISTANT.md §2: "Resolved to a route/action without
 * invoking an LLM analysis agent at all… navigation shouldn't cost a full
 * agent round-trip"), and it means the control layer is fully testable and
 * works with no API key configured.
 *
 * Hard boundaries preserved from ARCHITECTURE.md §3/§4 and TRADEW-AI.md §4:
 * no action here places, modifies, or cancels an order; the widest
 * order-related capability is opening the order-entry surface, which the user
 * must then drive themselves.
 */

// ---------------------------------------------------------------------------
// Actions — the assistant's capability surface
// ---------------------------------------------------------------------------

/**
 * The complete set of things the assistant can DO. Adding a capability means
 * adding a variant here and a case in `executeAction` (useAssistantController)
 * — there is no escape hatch that lets a command run arbitrary code, and
 * deliberately no `placeOrder`/`modifyOrder`/`cancelOrder` variant.
 */
export type AssistantAction =
  | { type: 'navigate'; href: string }
  /**
   * Read back live quotes for these symbols. The ONLY action that performs
   * I/O, and the only one whose result becomes a new assistant turn rather
   * than a change to the workspace — see `useAssistant`. It is read-only by
   * construction: `GET /market-data/quotes` has no write side.
   */
  | { type: 'quote'; symbols: string[]; ask: QuoteAsk }
  | { type: 'selectSymbol'; symbol: string }
  | { type: 'openOverlay'; overlay: 'commandPalette' | 'notifications' | 'shortcuts' }
  | { type: 'setTheme'; theme: ThemeName }
  | { type: 'showPanel'; panel: PanelKind }
  | { type: 'hidePanel'; panel: PanelKind }
  | { type: 'applyLayout'; layoutId: string }
  | { type: 'toggleSidebar' }
  | { type: 'newWorkspaceTab' };

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

/**
 * - `command`  — resolved to actions, executed immediately (this phase).
 * - `analysis` — a market/app question needing the reasoning agents; parked
 *                until Phase 2 rather than answered with an invented reply.
 * - `refusal`  — outside the assistant's remit (see domain-guard.ts).
 */
export type AssistantIntent = 'command' | 'quote' | 'analysis' | 'refusal';

/** Why a refusal happened — drives which copy the dock renders. */
export type RefusalReason =
  /** Not about this application or about markets at all. */
  | 'out-of-domain'
  /** Sentinel's own reasoning is the premium product; the assistant doesn't narrate it. */
  | 'sentinel-boundary'
  /** Asked for a trade decision / entry / target / "should I buy". */
  | 'advice-boundary'
  /** Asked the assistant to place or cancel an order. */
  | 'order-boundary';

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** A resolved utterance: what to say, what to do, and what to show as a trace. */
export interface AssistantPlan {
  intent: AssistantIntent;
  /** The assistant's message. Plain text — the dock renders it as-is. */
  reply: string;
  /** Executed in order. Empty for analysis/refusal plans. */
  actions: AssistantAction[];
  /**
   * Comet-style visible trace ("Resolved NIFTY 24300 CE · 21 Jul 2026",
   * "Opened /trade"). The point is that the user can see what the agent did
   * to their workspace, not just that something changed.
   */
  steps: string[];
  refusalReason?: RefusalReason;
  /** Analysis intents carry the observation-only disclaimer; commands don't
   *  (TRADEW-ASSISTANT.md §7 — a navigation ack is not an analytical claim). */
  disclaimer?: boolean;
  /**
   * This answer is settled — do NOT send the utterance to the conversation
   * brain for a second opinion.
   *
   * Needed because the brain's failure mode on an explain-question is to
   * produce a plausible-looking navigation ("✓ Open Research") and call it an
   * answer. A deliberate, honest "I can't source that yet" must not be
   * overwritten by one. Set only where the deterministic layer knows the
   * answer is complete, never as a general opt-out.
   */
  final?: boolean;
}

/** Convenience constructors — keep plan shapes consistent across resolvers. */
export function commandPlan(
  reply: string,
  actions: AssistantAction[],
  steps: string[] = [],
): AssistantPlan {
  return { intent: 'command', reply, actions, steps };
}

export function refusalPlan(reply: string, refusalReason: RefusalReason): AssistantPlan {
  return { intent: 'refusal', reply, actions: [], steps: [], refusalReason };
}

export function analysisPlan(
  reply: string,
  steps: string[] = [],
  final = false,
): AssistantPlan {
  return { intent: 'analysis', reply, actions: [], steps, disclaimer: true, final };
}

/**
 * A quote lookup. Carries the disclaimer even though a last price is a fact
 * rather than an opinion — `TRADEW-AI.md` §4 attaches it to every response that
 * touches trading data, and a number is exactly the kind of response someone
 * might act on.
 */
export function quotePlan(
  reply: string,
  actions: AssistantAction[],
  steps: string[] = [],
): AssistantPlan {
  return { intent: 'quote', reply, actions, steps, disclaimer: true };
}
