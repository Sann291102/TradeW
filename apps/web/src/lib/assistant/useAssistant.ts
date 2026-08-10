'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, getToken } from '../api';
import { useWorkspaceStore } from '../store/workspaceStore';
import { usePageContext, type PageContext } from './pageContext';
import { DEFAULT_PERSONA_NAME, fetchPersona, personaName as readPersonaName } from './persona';
import { resolveUtterance } from './router';
import type { AssistantAction, AssistantIntent, RefusalReason } from './types';

/**
 * The assistant's execution half — turns a resolved plan into actual changes
 * to the running application (TRADEW-ASSISTANT.md §5, "full application
 * control"), and keeps the conversation transcript.
 *
 * Resolution (lib/assistant/router.ts) is pure and framework-free; everything
 * that needs React or the Next router lives here. That split is what makes the
 * command grammar testable without mounting a component.
 */

export interface AssistantTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Comet-style trace of what the agent actually did to the workspace. */
  steps?: string[];
  intent?: AssistantIntent;
  refusalReason?: RefusalReason;
  disclaimer?: boolean;
  /** Streaming placeholder while the server answers an analysis question. */
  pending?: boolean;
  /**
   * Where the numbers behind this answer came from. Rendered as a chip so a
   * simulated-feed answer can never be mistaken for a live one
   * (`AI-VOICE.md` is silent on this; the rule is MarketContextService's).
   */
  provenance?: {
    feeds: string[];
    live: boolean;
    asOf: string | null;
    marketStatus: string;
    caveat?: string;
  } | null;
}

/** The server's answer to POST /ai/ask. */
interface AskResponse {
  reply: string;
  intent: AssistantIntent;
  refusalReason?: RefusalReason;
  provenance?: AssistantTurn['provenance'];
  degraded?: boolean;
  disclaimer?: boolean;
}

let turnSeq = 0;
function turnId(): string {
  // Client-only, same reasoning as workspaceStore's newTab id generator.
  return `t${++turnSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

const greeting = (name: string): AssistantTurn => ({
  id: 'greeting',
  role: 'assistant',
  text: `I'm ${name}. I can open anything in the app — try “open NIFTY 24300 call of 21st July” — or ask me about the markets. Say “what can you do” for the full list.`,
});

export function useAssistant() {
  const router = useRouter();
  const pageContext = usePageContext();

  // Individually-selected setters: selecting the whole store would re-render
  // the dock on every unrelated workspace change (symbol ticks, panel moves).
  const setSelectedSymbol = useWorkspaceStore((s) => s.setSelectedSymbol);
  const setTheme = useWorkspaceStore((s) => s.setTheme);
  const setCommandPaletteOpen = useWorkspaceStore((s) => s.setCommandPaletteOpen);
  const setNotificationCenterOpen = useWorkspaceStore((s) => s.setNotificationCenterOpen);
  const setShortcutsHelpOpen = useWorkspaceStore((s) => s.setShortcutsHelpOpen);
  const restorePanel = useWorkspaceStore((s) => s.restorePanel);
  const closePanel = useWorkspaceStore((s) => s.closePanel);
  const applyLayout = useWorkspaceStore((s) => s.applyLayout);
  const toggleSidebar = useWorkspaceStore((s) => s.toggleSidebar);
  const addWorkspaceTab = useWorkspaceStore((s) => s.addWorkspaceTab);

  const [personaName, setPersonaName] = useState(DEFAULT_PERSONA_NAME);
  const [turns, setTurns] = useState<AssistantTurn[]>([greeting(DEFAULT_PERSONA_NAME)]);
  const [busy, setBusy] = useState(false);
  const pageContextRef = useRef<PageContext>(pageContext);
  pageContextRef.current = pageContext;

  /**
   * Resolve the persona after mount.
   *
   * Not in `useState`'s initializer: that runs during SSR where localStorage
   * does not exist, and seeding from it on the client would hydrate-mismatch
   * against the server's default.
   */
  useEffect(() => {
    const cached = readPersonaName();
    if (cached !== DEFAULT_PERSONA_NAME) {
      setPersonaName(cached);
      setTurns((prev) => (prev.length === 1 && prev[0].id === 'greeting' ? [greeting(cached)] : prev));
    }
    void fetchPersona().then((p) => {
      if (p?.name) {
        setPersonaName(p.name);
        setTurns((prev) => (prev.length === 1 && prev[0].id === 'greeting' ? [greeting(p.name!)] : prev));
      }
    });
  }, []);

  /**
   * Restore today's thread (`AI-CONVERSATION-LIFECYCLE.md` §7).
   *
   * Lazily, on first mount of the dock rather than eagerly on login, so it
   * never blocks first paint.
   */
  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;
    void api('/ai/conversation')
      .then((data: { messages?: Array<{ id: string; role: string; content: string; intent?: string }> } | null) => {
        if (cancelled || !data?.messages?.length) return;
        setTurns(
          data.messages.map((m) => ({
            id: m.id,
            role: m.role === 'assistant' ? 'assistant' : 'user',
            text: m.content,
            intent: m.intent as AssistantIntent | undefined,
          })),
        );
      })
      .catch(() => {
        // Restore is best-effort: the dock opens usable rather than blocking
        // (WORKSPACE-CONTINUITY.md §5).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The only place an action becomes a side effect. Exhaustive over
   * `AssistantAction` — a new variant is a compile error here until it's
   * handled, which is the point: capabilities can't be added by accident, and
   * there is deliberately no order-placement branch.
   */
  const executeAction = useCallback(
    (action: AssistantAction) => {
      switch (action.type) {
        case 'navigate':
          router.push(action.href);
          break;
        case 'selectSymbol':
          setSelectedSymbol(action.symbol);
          break;
        case 'openOverlay':
          if (action.overlay === 'commandPalette') setCommandPaletteOpen(true);
          else if (action.overlay === 'notifications') setNotificationCenterOpen(true);
          else setShortcutsHelpOpen(true);
          break;
        case 'setTheme':
          setTheme(action.theme);
          break;
        case 'showPanel':
          restorePanel(action.panel);
          break;
        case 'hidePanel':
          closePanel(action.panel);
          break;
        case 'applyLayout':
          applyLayout(action.layoutId);
          break;
        case 'toggleSidebar':
          toggleSidebar();
          break;
        case 'newWorkspaceTab':
          addWorkspaceTab();
          break;
      }
    },
    [
      router,
      setSelectedSymbol,
      setCommandPaletteOpen,
      setNotificationCenterOpen,
      setShortcutsHelpOpen,
      setTheme,
      restorePanel,
      closePanel,
      applyLayout,
      toggleSidebar,
      addWorkspaceTab,
    ],
  );

  /**
   * Send one utterance.
   *
   * Two paths, and which one runs is decided locally first:
   *
   *   COMMAND  — resolved and executed here, no network. Instant and free,
   *              which is `TRADEW-ASSISTANT.md` §2's whole point.
   *   ANALYSIS — sent to `POST /ai/ask`, which runs the six-stage pipeline
   *              and returns text that has already passed the server-side
   *              compliance gate.
   *
   * The local resolver's refusals are UX, not enforcement — the server
   * classifies independently and gates its own output, so a client that
   * skipped this function entirely gets the same answer.
   */
  const send = useCallback(
    async (raw: string, inputMode: 'text' | 'voice' = 'text'): Promise<string | null> => {
      const text = raw.trim();
      if (!text) return null;

      const plan = resolveUtterance(text);

      // A resolvable command never leaves the browser.
      if (plan.intent === 'command' || plan.intent === 'refusal') {
        setTurns((prev) => [
          ...prev,
          { id: turnId(), role: 'user', text },
          {
            id: turnId(),
            role: 'assistant',
            text: plan.reply,
            steps: plan.steps.length ? plan.steps : undefined,
            intent: plan.intent,
            refusalReason: plan.refusalReason,
            disclaimer: plan.disclaimer,
          },
        ]);
        for (const action of plan.actions) executeAction(action);
        return plan.reply;
      }

      // Analysis — ask the server.
      const pendingId = turnId();
      setTurns((prev) => [
        ...prev,
        { id: turnId(), role: 'user', text },
        { id: pendingId, role: 'assistant', text: '', pending: true, intent: 'analysis' },
      ]);
      setBusy(true);

      const replace = (patch: Partial<AssistantTurn>) =>
        setTurns((prev) =>
          prev.map((t) => (t.id === pendingId ? { ...t, pending: false, ...patch } : t)),
        );

      if (!getToken()) {
        const reply = 'Sign in and I can pull live data and answer that properly.';
        replace({ text: reply });
        setBusy(false);
        return reply;
      }

      try {
        const res = (await api('/ai/ask', {
          method: 'POST',
          body: JSON.stringify({ text, inputMode, pageContext: pageContextRef.current }),
        })) as AskResponse;

        replace({
          text: res.reply,
          intent: res.intent,
          refusalReason: res.refusalReason,
          disclaimer: res.disclaimer,
          provenance: res.provenance ?? null,
        });
        return res.reply;
      } catch (err) {
        // Say what actually happened. An assistant that answers a market
        // question from nothing when the backend is down is the failure mode
        // this whole system is built to avoid.
        const reply =
          err instanceof Error && 'status' in err && (err as { status: number }).status === 401
            ? 'My session expired — sign in again and I’ll pick this up.'
            : "I couldn't reach my reasoning service just then. That's on my side.";
        replace({ text: reply });
        return reply;
      } finally {
        setBusy(false);
      }
    },
    [executeAction],
  );

  const reset = useCallback(() => setTurns([greeting(personaName)]), [personaName]);

  return useMemo(
    () => ({ turns, send, reset, busy, personaName }),
    [turns, send, reset, busy, personaName],
  );
}
