import { api } from '../api';
import type { AssistantAction } from './types';

/**
 * Layer 1 of the AI operating system, client half — the LLM fallback
 * (AI-OPERATING-SYSTEM.md §3).
 *
 * ── THE FAST PATH RUNS FIRST, ALWAYS ───────────────────────────────────────
 *
 * This module is reached only when `resolveUtterance` could not understand the
 * request. That ordering is the most important decision in the design and is
 * inherited from TRADEW-ASSISTANT.md §2: "open the option chain" must never
 * cost a model round-trip. Navigation is the overwhelming majority of what
 * anyone says to this thing, and it stays instant, free and offline.
 *
 * ── AND EVERYTHING IT RETURNS IS RE-VALIDATED HERE ─────────────────────────
 *
 * `services/tradew-ai` already validates the model's output against the same
 * closed vocabulary. This validates it again. That is not redundancy by
 * accident — a model is a text generator, "it reliably emits valid JSON" is an
 * observation about typical behaviour and not a security property, and the
 * network between here and there is one more place a payload can change. The
 * rule is that an action reaches `executeAction` only after passing a
 * hand-written check on BOTH sides.
 *
 * If this validator and the server's ever disagree, the stricter one is
 * correct and the other is the bug.
 */

export interface BrainPlan {
  goal: string;
  steps: { describe: string; action: AssistantAction }[];
  needsAnalysis: boolean;
  unsupported: string | null;
  /** Actions rejected by either validator. Surfaced in the trace, never hidden. */
  dropped: number;
}

/** Routes the client will navigate to. Kept in sync with the server's list. */
const KNOWN_ROUTES = new Set([
  '/dashboard',
  '/trade',
  '/markets',
  // Both still resolve: they are now redirects onto the Markets workspace's
  // crypto/forex venue tabs rather than pages of their own (see NAV_ALIASES).
  // Kept in the allowlist because "open crypto" is still a thing a user asks
  // for and it still lands on the crypto board.
  '/crypto',
  '/forex',
  '/news',
  '/portfolio',
  '/research',
  '/learning',
  '/sentinel',
  '/settings',
  '/profile',
  '/notifications',
  '/discipline',
]);

/**
 * The real `PanelKind` union. Accepting any string here was a hole with a
 * visible symptom: asked to review discipline, the model emitted
 * `showPanel: 'discipline'` — not a panel that exists — and the dock reported
 * "✓ Open the Discipline panel" while nothing on screen changed. An action that
 * validates but cannot do anything is worse than one that is rejected, because
 * the trace claims success. Same principle as the route allowlist: check the
 * payload, not just the discriminant.
 */
const PANELS = new Set([
  'watchlist',
  'chart',
  'blotter',
  'optionChain',
  'orderTicket',
  'depth',
  'sentinel',
  'news',
  'portfolio',
  'learning',
  'research',
]);

const OVERLAYS = new Set(['commandPalette', 'notifications', 'shortcuts']);
const THEMES = new Set(['light', 'dark', 'high-contrast']);
const ASKS = new Set(['price', 'range', 'volume']);
const SYMBOL_RE = /^[A-Z0-9&_-]{1,24}$/;

function str(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Narrow an untrusted object to `AssistantAction`, or null.
 *
 * Exhaustive by construction: an action type not listed here cannot be
 * executed, which is what makes "the assistant cannot place an order" hold even
 * if the model is prompted, jailbroken or replaced. There is no default branch
 * that lets something through.
 */
export function validateAction(raw: unknown): AssistantAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;

  switch (a.type) {
    case 'navigate': {
      if (!str(a.href)) return null;
      // Exact match on the path, query stripped. `startsWith` would admit
      // "/settings/../admin" and anything else shaped like a path.
      const path = a.href.split('?')[0]!.replace(/\/+$/, '') || '/';
      return KNOWN_ROUTES.has(path) ? { type: 'navigate', href: a.href } : null;
    }
    case 'selectSymbol':
      return str(a.symbol) && SYMBOL_RE.test(a.symbol)
        ? { type: 'selectSymbol', symbol: a.symbol.toUpperCase() }
        : null;
    case 'openOverlay':
      return str(a.overlay) && OVERLAYS.has(a.overlay)
        ? { type: 'openOverlay', overlay: a.overlay as 'commandPalette' | 'notifications' | 'shortcuts' }
        : null;
    case 'setTheme':
      return str(a.theme) && THEMES.has(a.theme)
        ? { type: 'setTheme', theme: a.theme as 'light' | 'dark' | 'high-contrast' }
        : null;
    case 'showPanel':
      return str(a.panel) && PANELS.has(a.panel) ? { type: 'showPanel', panel: a.panel as never } : null;
    case 'hidePanel':
      return str(a.panel) && PANELS.has(a.panel) ? { type: 'hidePanel', panel: a.panel as never } : null;
    case 'applyLayout':
      return str(a.layoutId) ? { type: 'applyLayout', layoutId: a.layoutId } : null;
    case 'toggleSidebar':
      return { type: 'toggleSidebar' };
    case 'newWorkspaceTab':
      return { type: 'newWorkspaceTab' };
    case 'quote': {
      if (!Array.isArray(a.symbols)) return null;
      const symbols = a.symbols
        .filter(str)
        .map((s) => s.toUpperCase())
        .filter((s) => SYMBOL_RE.test(s))
        .slice(0, 5);
      if (!symbols.length) return null;
      return {
        type: 'quote',
        symbols,
        ask: (str(a.ask) && ASKS.has(a.ask) ? a.ask : 'price') as 'price' | 'range' | 'volume',
      };
    }
    default:
      return null;
  }
}

/** Narrow a whole server response, counting anything rejected. */
export function validateBrainPlan(raw: unknown): BrainPlan {
  const p = (raw ?? {}) as Record<string, unknown>;
  const steps: BrainPlan['steps'] = [];
  let dropped = typeof p.dropped === 'number' ? p.dropped : 0;

  if (Array.isArray(p.steps)) {
    for (const s of p.steps) {
      const step = (s ?? {}) as Record<string, unknown>;
      const action = validateAction(step.action);
      if (!action) {
        dropped++;
        continue;
      }
      steps.push({ describe: str(step.describe) ? step.describe : 'Run this step', action });
    }
  }

  return {
    goal: str(p.goal) ? p.goal : '',
    steps,
    needsAnalysis: p.needsAnalysis === true,
    unsupported: str(p.unsupported) ? p.unsupported : null,
    dropped,
  };
}

/**
 * Ask the brain. Returns null when it is unreachable or unconfigured, which the
 * caller treats as "fall back to the existing honest 'I didn't understand'"
 * rather than as an error — a missing API key must not surface as a broken
 * assistant.
 */
export async function askBrain(
  utterance: string,
  context: Record<string, unknown>,
): Promise<BrainPlan | null> {
  try {
    const res = await api('/assistant/interpret', {
      method: 'POST',
      body: JSON.stringify({ utterance, context }),
    });
    return validateBrainPlan(res);
  } catch {
    return null;
  }
}
