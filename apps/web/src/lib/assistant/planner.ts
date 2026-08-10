import { resolveUtterance } from './router';
import { riskOf } from './safety';
import type { AssistantPlan, AssistantAction, AssistantIntent, RefusalReason } from './types';

/**
 * Layer 2 of the AI operating system — the planner
 * (`docs/product-architecture/AI-OPERATING-SYSTEM.md` §4).
 *
 * One sentence is often several actions. "Open the NIFTY chart, then show the
 * option chain and apply my scalping layout" is one request and three steps.
 * Before this existed, the resolver answered only the first clause and silently
 * dropped the rest — the user asked for three things, got one, and was told
 * nothing about the other two.
 *
 * ── WHY SPLITTING IS CONSERVATIVE ──────────────────────────────────────────
 *
 * The obvious implementation splits on "and". That is wrong here, and the
 * counter-example is already in the test suite: "price of nifty and banknifty"
 * is ONE quote lookup for two symbols, not two requests. Split it and the
 * second fragment ("banknifty") resolves as *open the BANKNIFTY chart* — the
 * assistant navigates away from what you were doing because you asked for two
 * prices.
 *
 * So: strong connectives ("then", "after that", ";") always split. A bare "and"
 * splits only when what follows STARTS WITH A VERB the grammar knows — "and
 * show the option chain" does, "and banknifty" does not. Ambiguous phrasing
 * resolves as a single utterance, which is the behaviour that was already
 * shipping and already tested.
 *
 * ── WHY THIS STAYS PURE ────────────────────────────────────────────────────
 *
 * Same contract as `router.ts`: no React, no network, no LLM. The planner
 * decides WHAT will happen and how risky it is; `useAssistant` is the only
 * place any of it becomes a side effect. That split is what lets the safety
 * tier (§10) be computed and shown to the user *before* a single action runs.
 */

export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface PlanStep {
  id: string;
  /** Human-readable, present tense: "Show the option chain". */
  describe: string;
  action: AssistantAction;
  status: StepStatus;
  /** Set when status is 'failed' — shown to the user, never swallowed. */
  error?: string;
}

export interface MultiStepPlan {
  /** The request restated, used as the confirmation prompt's heading. */
  goal: string;
  steps: PlanStep[];
  /** 'confirm' means nothing runs until the user explicitly says yes. */
  risk: 'free' | 'confirm';
  /** Why confirmation is being asked for — shown verbatim in the prompt. */
  riskReason?: string;
  intent: AssistantIntent;
  /** Non-action replies (refusals, capability answers, quote acks). */
  reply: string;
  refusalReason?: RefusalReason;
  disclaimer?: boolean;
}

/** Connectives that always mean "and then do this other thing". */
const STRONG_SPLIT = /\s*(?:;|\bthen\b|\band then\b|\bafter that\b|\bnext,?\s+(?=\w))\s*/i;

/**
 * A bare "and" only starts a new step when a command verb follows it. Kept in
 * sync with the verbs `commands.ts` actually recognises — a verb listed here
 * that the resolver cannot handle produces a fragment that resolves to nothing,
 * which is handled (dropped) but wasteful.
 */
const AND_THEN_VERB =
  /\band\s+(?=(?:open|show|hide|close|switch|apply|go|set|add|remove|draw|zoom|make|put|turn|bring)\b)/i;

let stepSeq = 0;
function stepId(): string {
  return `s${++stepSeq}`;
}

/** Split an utterance into clauses that each look like their own request. */
export function splitUtterance(text: string): string[] {
  const parts = text
    .split(STRONG_SPLIT)
    .flatMap((p) => p.split(AND_THEN_VERB))
    .map((p) => p.trim())
    // A trailing connective leaves an empty fragment; a one-word fragment is
    // never a command worth resolving on its own.
    .filter((p) => p.length > 1);

  return parts.length ? parts : [text.trim()];
}

/**
 * Describe an action in the present tense, for the plan preview and the trace.
 * Deliberately concrete — "Apply the scalping layout" tells you what is about
 * to happen to your workspace in a way "Execute applyLayout" does not.
 */
export function describeAction(a: AssistantAction): string {
  switch (a.type) {
    case 'navigate':
      return `Open ${a.href}`;
    case 'selectSymbol':
      return `Switch to ${a.symbol}`;
    case 'openOverlay':
      return a.overlay === 'commandPalette'
        ? 'Open the command palette'
        : a.overlay === 'notifications'
          ? 'Open notifications'
          : 'Open the shortcuts help';
    case 'setTheme':
      return `Switch to the ${a.theme} theme`;
    case 'showPanel':
      return `Show the ${a.panel} panel`;
    case 'hidePanel':
      return `Hide the ${a.panel} panel`;
    case 'applyLayout':
      return `Apply the ${a.layoutId} layout`;
    case 'toggleSidebar':
      return 'Toggle the sidebar';
    case 'newWorkspaceTab':
      return 'Open a new workspace tab';
    case 'quote':
      return `Read ${a.symbols.join(', ')}`;
  }
}

/**
 * Turn one utterance into a plan.
 *
 * Boundaries are checked on the WHOLE utterance first and short-circuit
 * everything else. Splitting around a refusal would be a real hole: "open the
 * chart then buy 50 lots" must not execute its innocent half and quietly drop
 * the part that was refused — the user would see a chart open and reasonably
 * assume the whole instruction ran.
 */
export function planUtterance(text: string, today = new Date()): MultiStepPlan {
  const whole = resolveUtterance(text, today);

  if (whole.intent === 'refusal' || whole.actions.length === 0) {
    return fromSingle(whole);
  }

  const fragments = splitUtterance(text);
  if (fragments.length < 2) return fromSingle(whole);

  // Resolve each fragment independently. A fragment that refuses poisons the
  // whole plan, for the reason in the docblock above.
  const resolved: AssistantPlan[] = [];
  for (const f of fragments) {
    const p = resolveUtterance(f, today);
    if (p.intent === 'refusal') return fromSingle(p);
    if (p.actions.length) resolved.push(p);
  }

  // Splitting only earns its keep if it found MORE than the whole utterance
  // did. Otherwise the single-utterance resolution is the better answer and is
  // the one already covered by the existing tests.
  const split = resolved.flatMap((p) => p.actions);
  if (resolved.length < 2 || split.length <= whole.actions.length) {
    return fromSingle(whole);
  }

  const steps = split.map<PlanStep>((action) => ({
    id: stepId(),
    describe: describeAction(action),
    action,
    status: 'pending',
  }));

  const risk = riskOf(steps.map((s) => s.action));

  return {
    goal: text.trim(),
    steps,
    risk: risk.tier,
    riskReason: risk.reason,
    intent: 'command',
    reply: `${steps.length} steps.`,
    disclaimer: resolved.some((p) => p.disclaimer),
  };
}

/** Wrap a single-utterance plan in the multi-step shape, so the executor has
 *  exactly one code path to run. */
function fromSingle(plan: AssistantPlan): MultiStepPlan {
  const steps = plan.actions.map<PlanStep>((action) => ({
    id: stepId(),
    describe: describeAction(action),
    action,
    status: 'pending',
  }));
  const risk = riskOf(plan.actions);

  return {
    goal: plan.reply,
    steps,
    risk: risk.tier,
    riskReason: risk.reason,
    intent: plan.intent,
    reply: plan.reply,
    refusalReason: plan.refusalReason,
    disclaimer: plan.disclaimer,
  };
}
