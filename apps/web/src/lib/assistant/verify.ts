import { NAV_ALIASES } from '@/components/shell/nav-config';
import type { AssistantAction } from './types';

/**
 * Did the action actually happen?
 *
 * ── WHY THIS DID NOT EXIST, AND WHY THAT WAS THE PROBLEM ───────────────────
 *
 * `runPlan` marked a step `done` when `executeAction` did not throw. Nothing in
 * `executeAction` throws: `router.push` returns before the route changes,
 * `restorePanel` flips a store flag whether or not anything renders it, and the
 * trace line "✓ Opened /trade" was written from the plan, before execution, as
 * a restatement of intent.
 *
 * That produced the failure the repo has hit twice and documented both times.
 * `showPanel: 'discipline'` — not a panel that exists — reported "✓ Open the
 * Discipline panel" while nothing on screen changed. `?view=optionChain` moved
 * the URL while the mounted panel kept its own state, so the assistant
 * truthfully reported "Option Chain is open", was told it was wrong, and said
 * it again, because from its side the navigation HAD succeeded.
 *
 * An agent that cannot observe its own effects cannot be trusted about them,
 * and no amount of prompt work fixes that — the claim is made by code, not by a
 * model. So every effectful action gets a post-condition that is read back off
 * real state.
 *
 * ── PURE ON PURPOSE ────────────────────────────────────────────────────────
 *
 * This module takes a snapshot and returns a verdict. It reads no store, no
 * router and no DOM, so every post-condition is unit-testable without a browser
 * — which matters, because a verifier that is itself wrong is worse than none:
 * it launders an unchecked claim into a checked-looking one.
 */

/** What the workspace looks like right now. Assembled by the caller. */
export interface WorkspaceSnapshot {
  /** `window.location.pathname` — no query string. */
  route: string | null;
  selectedSymbol: string | null;
  chartTimeframe: string | null;
  theme: string | null;
  /** Panels currently open on the workspace. */
  visiblePanels: readonly string[];
  /** Drawing tags currently present on the chart. */
  drawingTags: readonly string[];
}

export interface Verification {
  ok: boolean;
  /** Written into the trace. Says what was OBSERVED, not what was requested. */
  detail: string;
}

/** Strip the query and any trailing slash, the way both validators already do. */
function pathOf(href: string): string {
  return href.split('?')[0]!.replace(/\/+$/, '') || '/';
}

/**
 * Where a route actually lands.
 *
 * `/crypto` and `/forex` redirect onto the Markets workspace, and `/home` and
 * `/alerts` onto their real routes. Verifying against the requested path would
 * fail every one of those — reporting a correct navigation as broken, which is
 * the same class of lie as the one this module exists to stop, pointed the
 * other way.
 */
function destinationOf(href: string): string {
  const path = pathOf(href);
  const alias = NAV_ALIASES[path];
  return alias ? pathOf(alias) : path;
}

/**
 * Check one action against observed state.
 *
 * Returns `null` when there is nothing observable to check — a quote lookup
 * lands as its own transcript turn carrying its own provenance, and an overlay
 * the user may have already dismissed is not a failure. Silence is the honest
 * answer there; inventing a post-condition for it would be theatre.
 */
export function verifyAction(action: AssistantAction, snap: WorkspaceSnapshot): Verification | null {
  switch (action.type) {
    case 'navigate': {
      const want = destinationOf(action.href);
      if (snap.route === null) return null;
      const got = pathOf(snap.route);
      return got === want
        ? { ok: true, detail: `On ${got}` }
        : { ok: false, detail: `Asked for ${want}, still on ${got}` };
    }

    case 'selectSymbol':
      return snap.selectedSymbol === action.symbol
        ? { ok: true, detail: `Instrument is ${action.symbol}` }
        : {
            ok: false,
            detail: `Asked for ${action.symbol}, chart is on ${snap.selectedSymbol ?? 'nothing'}`,
          };

    case 'chartTimeframe':
      return snap.chartTimeframe === action.timeframe
        ? { ok: true, detail: `Chart is on ${action.timeframe}` }
        : {
            ok: false,
            detail: `Asked for ${action.timeframe}, chart is on ${snap.chartTimeframe ?? 'nothing'}`,
          };

    case 'setTheme':
      return snap.theme === action.theme
        ? { ok: true, detail: `Theme is ${action.theme}` }
        : { ok: false, detail: `Theme is still ${snap.theme ?? 'unchanged'}` };

    case 'showPanel':
      return snap.visiblePanels.includes(action.panel)
        ? { ok: true, detail: `${action.panel} panel is open` }
        : {
            ok: false,
            // The `showPanel: 'discipline'` case, caught rather than reported
            // as a success: the flag was set, nothing renders that panel here.
            detail: `${action.panel} did not open — this workspace doesn't render it`,
          };

    case 'hidePanel':
      return snap.visiblePanels.includes(action.panel)
        ? { ok: false, detail: `${action.panel} panel is still open` }
        : { ok: true, detail: `${action.panel} panel is closed` };

    case 'chartDetect':
      return snap.drawingTags.includes(action.detector)
        ? { ok: true, detail: `${action.detector} zones are on the chart` }
        : {
            ok: false,
            // Distinguished from "found none" by the caller, which knows the
            // detector's own count. A detector that ran and found nothing is
            // not a failed action.
            detail: `Nothing was drawn for ${action.detector}`,
          };

    case 'chartClearDrawings':
      return snap.drawingTags.includes(action.tag)
        ? { ok: false, detail: `${action.tag} drawings are still on the chart` }
        : { ok: true, detail: `${action.tag} drawings are cleared` };

    // Nothing observable, or observable only as its own turn.
    case 'quote':
    case 'marketFlow':
    case 'openOverlay':
    case 'toggleSidebar':
    case 'newWorkspaceTab':
    case 'applyLayout':
      return null;
  }
}

/**
 * Fold verifications into trace lines.
 *
 * The mark is now earned: `✓` means a post-condition was read back and held,
 * `✕` means it did not, and `·` means the step ran with nothing observable to
 * check. Previously every line was `✓` as long as no exception was thrown,
 * which made the tick meaningless — and a meaningless tick is worse than none,
 * because the user reasonably reads it as evidence.
 */
export function traceLine(
  describe: string,
  status: 'done' | 'failed',
  verification: Verification | null,
  error?: string,
): string {
  if (status === 'failed') return `✕ ${describe}${error ? ` — ${error}` : ''}`;
  if (!verification) return `· ${describe}`;
  return verification.ok
    ? `✓ ${describe} — ${verification.detail}`
    : `✕ ${describe} — ${verification.detail}`;
}
