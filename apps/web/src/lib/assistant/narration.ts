import type { AssistantAction } from './types';

/**
 * Layer 7 of the AI operating system — narration modes
 * (`docs/product-architecture/AI-OPERATING-SYSTEM.md` §9).
 *
 * Three settings, because three different people are using the same assistant:
 *
 * - **teaching** — someone learning the platform, or the market. Every step is
 *   explained: what it did AND why that thing is worth knowing about.
 * - **normal** — the Comet-style trace that already shipped. What it did, one
 *   line per step, no tutoring.
 * - **silent** — someone who knows exactly what they asked for and wants the
 *   workspace to change without a paragraph about it.
 *
 * ── SILENT MEANS "DON'T NARRATE", NEVER "DON'T RECORD" ─────────────────────
 *
 * Steps are always computed and always stored on the turn. Silent mode only
 * decides whether the dock renders them. The user can still expand a turn to
 * see exactly what happened — an assistant that acts without leaving a trace it
 * can produce on demand is not a mode, it is a black box.
 *
 * ── AND IT NEVER SILENCES THE SAFETY GATE ──────────────────────────────────
 *
 * A confirmation prompt (`safety.ts`) is not narration. Silent mode suppresses
 * commentary about what happened; it has no bearing on being asked before
 * something consequential happens. Anything else would turn a preference into a
 * way to disable the guardrails.
 */

export type NarrationMode = 'teaching' | 'normal' | 'silent';

export const NARRATION_MODES: ReadonlyArray<{
  id: NarrationMode;
  label: string;
  hint: string;
}> = [
  { id: 'teaching', label: 'Teaching', hint: 'Explains every action as it goes' },
  { id: 'normal', label: 'Normal', hint: 'Shows what it did, one line per step' },
  { id: 'silent', label: 'Silent', hint: 'Just does it — the trace is still there if you want it' },
];

/**
 * The teaching-mode explanation for an action: not what happened (the step
 * already says that) but why it is worth understanding.
 *
 * Deliberately about the PLATFORM, not about the market. "VWAP shows where the
 * average participant sits" is platform literacy; "VWAP is holding so the trend
 * is intact" is analysis, and analysis belongs to the agents that carry the
 * observation-only guardrails (`TRADEW-AI.md` §4). Teaching mode must not
 * become a side door to market commentary.
 */
export function explainAction(a: AssistantAction): string | null {
  switch (a.type) {
    case 'navigate':
      return 'Every workspace lives at its own route, so anything I open is somewhere you can bookmark and come back to.';
    case 'selectSymbol':
      return 'The selected symbol is shared across the workspace — the chart, the chain and the order ticket all follow it, so I only have to set it once.';
    case 'openOverlay':
      return a.overlay === 'commandPalette'
        ? 'The command palette (⌘K) searches symbols and runs the same commands I do — it is the keyboard version of talking to me.'
        : null;
    case 'setTheme':
      return 'Theme is stored with your workspace, so it survives a reload and follows you between sessions.';
    case 'showPanel':
    case 'hidePanel':
      return 'Panels dock into zones rather than floating freely, which is why hiding one gives its space back to its neighbours instead of leaving a hole.';
    case 'applyLayout':
      return 'A layout is a saved arrangement of panels. Applying one replaces what is on screen now — that is why I asked before doing it.';
    case 'toggleSidebar':
      return null;
    case 'newWorkspaceTab':
      return 'Workspace tabs each keep their own panel arrangement, so you can hold one setup for scalping and another for research.';
    case 'quote':
      return 'I read prices from the same live feed the tiles and the ticker use, so what I tell you always matches what is on your screen.';
    case 'marketFlow':
      // Platform mechanics, in the sense the docblock allows: WHERE the number
      // comes from and why it is dated the way it is. Not what it means.
      return 'FII/DII figures come from NSE itself, not from a broker feed — and the exchange publishes them once a day after the close, which is why I always tell you which session you are looking at.';
    case 'chartDetect':
      // Platform mechanics, not market commentary — teaching mode explains how
      // the feature works, never what the market is doing (see the docblock).
      return 'I find these by arithmetic on the bars, not by opinion, so the same chart always gives the same zones — and I draw every one I find rather than picking out the ones that look best.';
    case 'chartClearDrawings':
      return 'Drawings are grouped by what produced them, so clearing one group leaves anything you drew yourself exactly where it was.';
    case 'analyzeMarket':
      // Platform mechanics, per the docblock: where the numbers come from and
      // why they can be trusted. Deliberately says nothing about what any of
      // them MEANS — that would be the market commentary this mode must not
      // become a side door to.
      return 'Every number in that read comes from the same engine our autonomous paper agents decide on, measured off real bars — so the assistant and the agents can never describe two different markets. Anything that could not be measured is listed as unavailable rather than filled in with an estimate.';
  }
}

/**
 * Build the trace lines for a turn, given the mode.
 * `silent` returns nothing to render — the caller keeps the raw steps on the
 * turn regardless.
 */
export function narrate(
  mode: NarrationMode,
  steps: string[],
  actions: AssistantAction[],
): string[] {
  if (mode === 'silent') return [];
  if (mode === 'normal') return steps;

  const teaching: string[] = [...steps];
  const seen = new Set<string>();
  for (const a of actions) {
    const why = explainAction(a);
    // One explanation per action KIND per turn — repeating the same sentence
    // for four panel toggles teaches nothing and buries the trace.
    if (why && !seen.has(a.type)) {
      seen.add(a.type);
      teaching.push(`💡 ${why}`);
    }
  }
  return teaching;
}
