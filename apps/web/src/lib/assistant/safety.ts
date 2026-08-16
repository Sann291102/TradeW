import type { AssistantAction } from './types';

/**
 * Layer 8 of the AI operating system — the safety gate
 * (`docs/product-architecture/AI-OPERATING-SYSTEM.md` §10).
 *
 * ── THE MISSING MIDDLE ─────────────────────────────────────────────────────
 *
 * `domain-guard.ts` already handles REFUSAL — orders, trade advice, Sentinel's
 * premium reasoning, anything out of remit. Those are things the assistant will
 * never do, at any tier, for any user.
 *
 * What did not exist is the middle: things the assistant SHOULD do, but not
 * without asking. Until now every allowed action executed the instant it
 * resolved, which was fine when the widest capability was "navigate to a page"
 * and stops being fine the moment a single sentence can rearrange somebody's
 * workspace.
 *
 * ── THE GATE READS THE PLAN, NOT THE SENTENCE ──────────────────────────────
 *
 * This function takes actions, never text. Intent is trivially easy to phrase
 * innocently — "just tidy things up for me" is a friendly sentence that can
 * resolve to replacing a layout somebody spent an hour arranging. A plan is a
 * concrete list and can be inspected. So the tier is computed from what will
 * actually happen.
 *
 * ── DESTRUCTIVE BY OMISSION IS STILL DESTRUCTIVE ───────────────────────────
 *
 * `applyLayout` is the clearest case. Nobody says "delete my panels", but
 * applying a layout replaces the current arrangement wholesale, and the user
 * who asked for "my scalping view" did not necessarily mean "and discard what I
 * had". This mirrors workspace Rule 1's posture toward the codebase: superseded
 * state is replaced deliberately, never as a side effect.
 *
 * ── WHAT IS DELIBERATELY *NOT* HERE ────────────────────────────────────────
 *
 * There is no tier that permits an order action. `AssistantAction` has no
 * order variant to gate — the absence is structural, and this module must never
 * become the place someone adds one "behind a confirmation".
 */

export type RiskTier = 'free' | 'confirm';

export interface RiskAssessment {
  tier: RiskTier;
  /** Shown verbatim in the confirmation prompt. Absent when tier is 'free'. */
  reason?: string;
}

/**
 * Plans at or above this many steps are confirmed regardless of what they
 * contain. Not because step six is dangerous, but because a long plan is one a
 * user is unlikely to have fully pictured when they spoke it, and the cheapest
 * moment to catch a misunderstanding is before it runs.
 */
const LONG_PLAN_STEPS = 5;

/** Actions that change something the user cannot trivially put back. */
function isConsequential(a: AssistantAction): string | null {
  switch (a.type) {
    case 'applyLayout':
      return 'This replaces your current panel arrangement.';
    case 'setTheme':
    case 'navigate':
    case 'selectSymbol':
    case 'openOverlay':
    case 'showPanel':
    case 'hidePanel':
    case 'toggleSidebar':
    case 'newWorkspaceTab':
    case 'quote':
    case 'marketFlow':
    case 'chartDetect':
    case 'chartClearDrawings':
      // Drawing is annotation, not workspace surgery: detection replaces only
      // its own tag and clearing it re-runs in one word, so neither destroys
      // anything the user would have to rebuild.
      // All reversible in one click, or read-only. Confirming these would train
      // the user to click through prompts without reading them, which makes the
      // gate worse than useless when it finally guards something that matters.
      return null;
  }
}

export function riskOf(actions: AssistantAction[]): RiskAssessment {
  for (const a of actions) {
    const reason = isConsequential(a);
    if (reason) return { tier: 'confirm', reason };
  }

  if (actions.length >= LONG_PLAN_STEPS) {
    return {
      tier: 'confirm',
      reason: `That's ${actions.length} changes to your workspace in one go.`,
    };
  }

  return { tier: 'free' };
}
