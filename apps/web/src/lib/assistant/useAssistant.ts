'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useWorkspaceStore } from '../store/workspaceStore';
import { fetchQuotes, type LiveQuote } from '../marketData';
import { fetchDhanQuotes } from '../dhanLiveFeed';
import { planUtterance, type MultiStepPlan, type PlanStep } from './planner';
import { narrate } from './narration';
import { ASSISTANT_NAME } from './identity';
import { riskOf } from './safety';
import { askBrain, type BrainPlan } from './brain';
import type { QuoteAsk } from './quotes';
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
  /**
   * Comet-style trace of what the agent actually did to the workspace, already
   * filtered for the active narration mode. Empty in silent mode — `rawSteps`
   * keeps the record regardless.
   */
  steps?: string[];
  /** Always populated. Silent mode hides `steps`, never this. */
  rawSteps?: string[];
  intent?: AssistantIntent;
  refusalReason?: RefusalReason;
  disclaimer?: boolean;
  /**
   * Set on the turn that is waiting for a yes/no. The dock renders the plan and
   * the reason instead of executing anything — see `safety.ts`.
   */
  pendingPlan?: MultiStepPlan;
  /** Per-step outcome, shown after a multi-step plan runs. */
  planSteps?: PlanStep[];
}

let turnSeq = 0;
function turnId(): string {
  // Client-only, same reasoning as workspaceStore's newTab id generator.
  return `t${++turnSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// Quote formatting
// ---------------------------------------------------------------------------

const inr = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const MARKET_PHASE: Record<LiveQuote['marketStatus'], string> = {
  'pre-open': 'Pre-open',
  open: 'Market open',
  closed: 'Market closed',
};

/**
 * Turn quotes into the assistant's answer.
 *
 * Two rules, both non-negotiable:
 *
 * 1. **State the source.** `LiveQuote.source` varies per row on the same
 *    response — indices come back `simulated` from our own engine while liquid
 *    equities come back `dhan`. Presenting both as "the price" without saying
 *    which is which is precisely the fabrication problem the repo already
 *    fixed for candles. Simulated rows say so in plain words.
 * 2. **Report, don't interpret.** Numbers, phase, timestamp. No "holding up
 *    well", no "approaching resistance" — that is the analysis agents' job
 *    (`TRADEW-AI.md` §3) and this function must not quietly become them.
 */
/**
 * Get quotes from the SAME place the rest of the workspace gets them.
 *
 * ── THE MISTAKE THIS FUNCTION EXISTS TO PREVENT ────────────────────────────
 *
 * There are two market-data clients in this app and they return different
 * numbers for the same symbol at the same moment:
 *
 * - `dhanLiveFeed.ts` → the live-feed bridge on :4600. Real broker ticks.
 *   NIFTY 24,583.80. Used by IndexOverview, Ticker, MarketMovers,
 *   SectorHeatmap, TrendingStocks, WatchlistWidget, MarketsWorkspace,
 *   CommodityMarkets, DashboardHero and SentinelLiveCharts — i.e. everything
 *   the user can actually see.
 * - `marketData.ts` → services/api's DB-backed routes, whose rows come from
 *   the Simulated Market Data Engine. NIFTY 24,850, `source: 'simulated'`.
 *
 * The assistant was first wired to the second one. It answered "24,850" while
 * the tile two centimetres away said "24,583.80", which is worse than refusing
 * to answer: it makes the app look like it is guessing. An assistant that
 * contradicts the screen is not a feature.
 *
 * So: live bridge first, simulated engine only as a labelled fallback. If both
 * fail the caller says so rather than inventing a number.
 */
async function loadQuotes(symbols: string[]): Promise<LiveQuote[]> {
  const wanted = new Set(symbols.map((s) => s.toUpperCase()));

  try {
    const snap = await fetchDhanQuotes();
    const all = [...snap.indices, ...snap.stocks, ...snap.etfs, ...snap.commodities];
    const hits = all.filter((q) => wanted.has(q.symbol.toUpperCase()));
    if (hits.length) {
      // The bridge leaves open/high/low/close nullable (no intraday history
      // before the first tick of a session); LiveQuote wants numbers. Fall back
      // to ltp rather than rendering "null" at the user.
      return hits.map<LiveQuote>((q) => ({
        ...q,
        open: q.open ?? q.ltp,
        high: q.high ?? q.ltp,
        low: q.low ?? q.ltp,
        close: q.close ?? q.ltp,
        marketStatus: q.marketStatus,
      }));
    }
  } catch {
    // Bridge down or symbol not carried — fall through.
  }

  return fetchQuotes(symbols);
}

function formatQuotes(quotes: LiveQuote[], ask: QuoteAsk): string {
  const lines: string[] = [];

  for (const q of quotes) {
    const sign = q.change >= 0 ? '+' : '';
    lines.push(`**${q.displayName}** — ${inr.format(q.ltp)}`);
    lines.push(`${sign}${inr.format(q.change)} (${sign}${q.changePct.toFixed(2)}%)`);

    if (ask === 'range' || ask === 'volume') {
      lines.push(
        `Open ${inr.format(q.open)} · High ${inr.format(q.high)} · Low ${inr.format(q.low)} · Prev close ${inr.format(q.close)}`,
      );
    }
    if (ask === 'volume') {
      lines.push(`Volume ${new Intl.NumberFormat('en-IN').format(q.volume)}`);
    }

    const when = new Date(q.updatedAt).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const provenance =
      q.source === 'simulated'
        ? "TradeW's simulated market engine — not a live exchange feed"
        : `live feed (${q.source})`;
    lines.push(`${MARKET_PHASE[q.marketStatus]} · ${provenance} · as of ${when}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Read-only workspace context sent with a brain request, so the model can
 * resolve "here", "this" and "back". Deliberately minimal: no positions, no
 * orders, no P&L, no credentials. The brain's job is to understand a sentence,
 * not to be trusted with the account.
 */
function contextSnapshot(): Record<string, unknown> {
  const s = useWorkspaceStore.getState();
  // The selected symbol is per workspace TAB, not global — reading a top-level
  // field would silently send null and cost the brain the antecedent for "it".
  const activeTab = s.workspaceTabs.find((t) => t.id === s.activeTabId);
  return {
    route: typeof window !== 'undefined' ? window.location.pathname : null,
    selectedSymbol: activeTab?.selectedSymbol ?? null,
    theme: s.theme,
  };
}

/** Turn a brain reply into transcript turns. */
function brainTurns(brain: BrainPlan, mode: ReturnType<typeof narrate> extends never ? never : Parameters<typeof narrate>[0]): AssistantTurn[] {
  if (brain.unsupported) {
    return [{ id: turnId(), role: 'assistant', text: brain.unsupported, intent: 'command' }];
  }
  if (brain.needsAnalysis) {
    return [
      {
        id: turnId(),
        role: 'assistant',
        intent: 'analysis',
        disclaimer: true,
        text: "That needs the analysis agents — reading chart structure and interpreting option data is the next phase. I won't improvise an answer.",
        steps: mode === 'silent' ? [] : ['Classified → market analysis'],
        rawSteps: ['Classified → market analysis'],
      },
    ];
  }
  if (!brain.steps.length) return [];

  const trace = [
    ...brain.steps.map((s) => `✓ ${s.describe}`),
    ...(brain.dropped > 0 ? [`${brain.dropped} suggested action(s) were not permitted and were discarded`] : []),
  ];
  return [
    {
      id: turnId(),
      role: 'assistant',
      text: brain.goal || 'Done.',
      steps: narrate(mode, trace, brain.steps.map((s) => s.action)),
      rawSteps: trace,
      intent: 'command',
    },
  ];
}

const GREETING: AssistantTurn = {
  id: 'greeting',
  role: 'assistant',
  text:
    `Hi, I'm ${ASSISTANT_NAME} — TradeW's AI. Ask me a price — “what is NIFTY 50 trading at” — or tell me where to go: “open NIFTY 24300 call of 21st July”. Tap the mic to speak to me, and the speaker if you'd like me to talk back. Say “what can you do” for the full list.`,
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

  // `confirmPlan` needs the turn it is resolving, but must not be rebuilt on
  // every transcript change — that would re-render the dock on each turn and
  // invalidate the callback the confirmation buttons are bound to.
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

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
        case 'quote':
          // The one asynchronous action. Deliberately fire-and-forget with its
          // own turn appended on settle, rather than making `send` async: the
          // user's message and the "Reading NIFTY…" acknowledgement must land
          // immediately, or the dock looks frozen while the request is in
          // flight.
          void (async () => {
            try {
              const quotes = await loadQuotes(action.symbols);
              const missing = action.symbols.filter(
                (s) => !quotes.some((q) => q.symbol.toUpperCase() === s.toUpperCase()),
              );
              setTurns((prev) => [
                ...prev,
                {
                  id: turnId(),
                  role: 'assistant',
                  intent: 'quote',
                  disclaimer: true,
                  text: quotes.length
                    ? formatQuotes(quotes, action.ask)
                    : `I couldn't find a quote for ${action.symbols.join(', ')}.`,
                  steps: [
                    `Read ${quotes.length} quote${quotes.length === 1 ? '' : 's'} from the ${
                      quotes[0]?.source === 'dhan' ? 'live feed' : 'simulated engine'
                    }`,
                    ...(missing.length ? [`No data for ${missing.join(', ')}`] : []),
                  ],
                },
              ]);
            } catch {
              // Say what actually went wrong. An empty dock or a fabricated
              // number would both be worse than admitting the fetch failed.
              setTurns((prev) => [
                ...prev,
                {
                  id: turnId(),
                  role: 'assistant',
                  intent: 'quote',
                  text: "I couldn't reach the market-data service just now, so I don't have a price to give you. I won't guess at one.",
                  steps: ['GET /market-data/quotes failed'],
                },
              ]);
            }
          })();
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
   * Run every step, recording what each one did.
   *
   * Steps run independently and a failure does NOT abort the rest — a plan that
   * half-executed while claiming success is the worst possible outcome, so the
   * contract is "run what can run, then say exactly what didn't"
   * (AI-OPERATING-SYSTEM.md §4).
   */
  const runPlan = useCallback(
    (plan: MultiStepPlan) => {
      const done: PlanStep[] = plan.steps.map((s) => {
        try {
          executeAction(s.action);
          return { ...s, status: 'done' as const };
        } catch (e) {
          return {
            ...s,
            status: 'failed' as const,
            error: e instanceof Error ? e.message : 'failed',
          };
        }
      });

      const failed = done.filter((s) => s.status === 'failed');
      const trace = done.map(
        (s) => `${s.status === 'done' ? '✓' : '✕'} ${s.describe}${s.error ? ` — ${s.error}` : ''}`,
      );

      return { done, failed, trace };
    },
    [executeAction],
  );

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;

      const mode = useWorkspaceStore.getState().assistantMode;
      const plan = planUtterance(text);

      /**
       * The fast path missed — only THEN do we spend a model round-trip
       * (AI-OPERATING-SYSTEM.md §3).
       *
       * ── WHICH REFUSALS MAY BE RECONSIDERED, AND WHICH MAY NOT ────────────
       *
       * Not all refusals are the same thing, and treating them as one category
       * was a bug. `domain-guard.ts` produces two kinds:
       *
       *  - HARD BOUNDARIES ('order-boundary', 'advice-boundary',
       *    'sentinel-boundary') — deliberate limits. These must never reach the
       *    brain. Asking a language model to reconsider a boundary hands the
       *    decision to the component least able to be held to it.
       *
       *  - 'out-of-domain' — a COMPREHENSION judgement made by regex: "I don't
       *    think this is about markets or this app." That is a guess, and it is
       *    exactly the guess an LLM is better at. Observed 2026-08-11: "I want
       *    to look back at how disciplined I was yesterday" — a request for a
       *    page that exists, in an app that has a discipline journal — was
       *    refused as off-topic, and because refusals were excluded wholesale
       *    the brain never got the chance to route it to /discipline.
       *
       * So out-of-domain falls through to the brain; the three real boundaries
       * do not. The brain has no order action in its vocabulary regardless, so
       * this widens comprehension without widening capability.
       */
      const isReconsiderable =
        (plan.intent === 'analysis' && plan.steps.length === 0) ||
        (plan.intent === 'refusal' && plan.refusalReason === 'out-of-domain');

      if (isReconsiderable) {
        /**
         * Show ONE answer, not two.
         *
         * The first cut appended the brain's reply after the fast path's, so
         * "I want to review how disciplined I was yesterday" rendered a refusal
         * ("that's outside what I cover") immediately followed by a success
         * ("Review discipline from yesterday · ✓ Open Discipline"). Both were
         * true of their own layer and the pair read as the app arguing with
         * itself.
         *
         * So the fast path's reply is withheld while the brain is consulted and
         * a placeholder stands in its place. The brain's answer REPLACES the
         * placeholder; if the brain is unreachable the placeholder becomes the
         * original reply, which is the honest fallback rather than a dead end.
         */
        const placeholderId = turnId();
        setTurns((prev) => [
          ...prev,
          { id: turnId(), role: 'user', text },
          { id: placeholderId, role: 'assistant', text: 'Working that out…', intent: 'command' },
        ]);

        void askBrain(text, contextSnapshot()).then((brain) => {
          const replacement: AssistantTurn[] = brain
            ? brainTurns(brain, mode)
            : [
                {
                  id: turnId(),
                  role: 'assistant',
                  text: plan.reply,
                  intent: plan.intent,
                  refusalReason: plan.refusalReason,
                  disclaimer: plan.disclaimer,
                },
              ];

          setTurns((prev) =>
            prev.flatMap((t) => (t.id === placeholderId ? replacement : [t])),
          );

          if (!brain) return;
          if (brain.steps.length) {
            const risk = riskOf(brain.steps.map((s) => s.action));
            if (risk.tier === 'confirm') {
              setTurns((prev) => [
                ...prev,
                {
                  id: turnId(),
                  role: 'assistant',
                  text: risk.reason ?? 'This will change your workspace.',
                  intent: 'command',
                  pendingPlan: {
                    goal: brain.goal || text,
                    steps: brain.steps.map((s) => ({
                      id: turnId(),
                      describe: s.describe,
                      action: s.action,
                      status: 'pending' as const,
                    })),
                    risk: 'confirm',
                    riskReason: risk.reason,
                    intent: 'command',
                    reply: brain.goal || text,
                  },
                },
              ]);
              return;
            }
            for (const s of brain.steps) executeAction(s.action);
          }
        });
        // The placeholder is the only reply for this utterance; falling through
        // would emit the fast path's answer underneath it and reintroduce the
        // double-reply this branch exists to prevent.
        return;
      }

      // Consequential plans stop here and wait. Nothing has run yet.
      if (plan.risk === 'confirm' && plan.steps.length) {
        setTurns((prev) => [
          ...prev,
          { id: turnId(), role: 'user', text },
          {
            id: turnId(),
            role: 'assistant',
            text: plan.riskReason ?? 'This will change your workspace.',
            intent: plan.intent,
            pendingPlan: plan,
          },
        ]);
        return;
      }

      const { done, failed, trace } = runPlan(plan);
      const rawSteps = plan.steps.length ? trace : plan.steps.map((s) => s.describe);

      setTurns((prev) => [
        ...prev,
        { id: turnId(), role: 'user', text },
        {
          id: turnId(),
          role: 'assistant',
          text:
            failed.length && done.length > failed.length
              ? `${plan.reply}\n\n${failed.length} of ${done.length} steps didn't complete.`
              : plan.reply,
          steps: narrate(mode, rawSteps, plan.steps.map((s) => s.action)),
          rawSteps,
          planSteps: done.length > 1 ? done : undefined,
          intent: plan.intent,
          refusalReason: plan.refusalReason,
          disclaimer: plan.disclaimer,
        },
      ]);
    },
    [runPlan],
  );

  /** The user said yes to a confirmation. Runs the plan it was holding. */
  const confirmPlan = useCallback(
    (turnIdToResolve: string) => {
      const turn = turnsRef.current.find((t) => t.id === turnIdToResolve);
      const plan = turn?.pendingPlan;
      if (!plan) return;

      const mode = useWorkspaceStore.getState().assistantMode;
      const { done, trace } = runPlan(plan);

      setTurns((prev) => [
        // Clear the pending flag so the prompt cannot be answered twice.
        ...prev.map((t) => (t.id === turnIdToResolve ? { ...t, pendingPlan: undefined } : t)),
        {
          id: turnId(),
          role: 'assistant',
          text: 'Done.',
          steps: narrate(mode, trace, plan.steps.map((s) => s.action)),
          rawSteps: trace,
          planSteps: done.length > 1 ? done : undefined,
          intent: 'command',
        },
      ]);
    },
    [runPlan],
  );

  /** The user said no. Nothing ran, and the transcript says so. */
  const cancelPlan = useCallback((turnIdToResolve: string) => {
    setTurns((prev) => [
      ...prev.map((t) => (t.id === turnIdToResolve ? { ...t, pendingPlan: undefined } : t)),
      {
        id: turnId(),
        role: 'assistant',
        text: "Cancelled — I haven't changed anything.",
        intent: 'command',
      },
    ]);
  }, []);

  const reset = useCallback(() => setTurns([GREETING]), []);

  return useMemo(
    () => ({ turns, send, reset, confirmPlan, cancelPlan }),
    [turns, send, reset, confirmPlan, cancelPlan],
  );
}
