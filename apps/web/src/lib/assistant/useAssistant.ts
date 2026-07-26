'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useWorkspaceStore } from '../store/workspaceStore';
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
}

let turnSeq = 0;
function turnId(): string {
  // Client-only, same reasoning as workspaceStore's newTab id generator.
  return `t${++turnSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

const GREETING: AssistantTurn = {
  id: 'greeting',
  role: 'assistant',
  text:
    "I'm TradeW AI. I can open anything in the app — try “open NIFTY 24300 call of 21st July” — or ask me about the markets. Say “what can you do” for the full list.",
};

export function useAssistant() {
  const router = useRouter();

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

  const [turns, setTurns] = useState<AssistantTurn[]>([GREETING]);

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

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;

      const plan = resolveUtterance(text);

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
    },
    [executeAction],
  );

  const reset = useCallback(() => setTurns([GREETING]), []);

  return useMemo(() => ({ turns, send, reset }), [turns, send, reset]);
}
