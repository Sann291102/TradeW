'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn, Badge } from '@tradew/ui';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { useAssistant, type AssistantTurn } from '@/lib/assistant/useAssistant';
import { useVoiceInput } from '@/lib/assistant/useVoiceInput';
import { useVoiceOutput } from '@/lib/assistant/useVoiceOutput';
import { NARRATION_MODES } from '@/lib/assistant/narration';
import {
  ASSISTANT_DISCLAIMER,
  ASSISTANT_NAME,
  ASSISTANT_TRIGGER_LABEL,
} from '@/lib/assistant/identity';
import { MascotMark } from '@/components/brand/MascotMark';
import { MicIcon, SpeakerIcon, SpeakerOffIcon } from './icons';

/**
 * TradeW AI floating assistant (shell chrome) — the permanent bottom-right dock
 * from the canonical terminal (#aiFab + #aiDock) and TRADEW-ASSISTANT.md.
 *
 * Phase 1 (2026-07-26) makes this a WORKING command surface: the dock now
 * resolves what the user types and takes control of the application — opens
 * routes and option contracts, shows/hides panels, applies layouts, switches
 * theme — and shows a Comet-style trace of what it actually did. Resolution
 * lives in `lib/assistant/` (pure, no LLM call, no network); execution lives in
 * `lib/assistant/useAssistant.ts`.
 *
 * The previous visual-only scaffold ("responses arrive in a later milestone")
 * is preserved at `archive/web-floating-ai-visual-scaffold.tsx.txt` per repo
 * Rule 1. All of its layout, classnames and animation are kept here unchanged
 * — only the inert body was replaced with a live transcript and input.
 *
 * NOT built yet (Phase 2): the analysis half — chart reads, support/resistance,
 * option-chain interpretation. Those utterances are classified and parked with
 * an honest "not wired up yet" rather than answered.
 *
 * Open state lives in the workspace store so Escape/the command palette can
 * close it centrally alongside every other overlay.
 *
 * The trigger and dock header wear the TradeW AI mascot (`MascotMark`) rather
 * than the generic SparkleIcon they used to. A sparkle is what every product's
 * AI button looks like; the robot is the agent identity a visitor already met
 * on the landing page, so the same character greets them once they're inside.
 * AppFrame mounts this component, so the swap covers every workspace route at
 * once — there is no per-page copy of the trigger to keep in sync.
 */

/** Quick chips — every one is a real command the resolver handles. */
const QUICK_CHIPS = [
  'What is NIFTY 50 trading at',
  'RELIANCE day range',
  'Show the option chain',
  'What can you do',
];

export function FloatingAI() {
  const open = useWorkspaceStore((s) => s.aiDockOpen);
  const setOpen = useWorkspaceStore((s) => s.setAiDockOpen);
  const mode = useWorkspaceStore((s) => s.assistantMode);
  const setMode = useWorkspaceStore((s) => s.setAssistantMode);
  const reduce = useReducedMotion();
  const { turns, send, confirmPlan, cancelPlan } = useAssistant();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the newest turn in view — the trace lines mean an answer is often
  // several lines tall, so without this the reply scrolls off as it renders.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  function submit(text: string) {
    send(text);
    setDraft('');
  }

  // Speaking sends straight through rather than filling the box and waiting
  // for Enter — someone who just spoke a command has already committed to it,
  // and making them reach for the keyboard to confirm defeats the point.
  const voice = useVoiceInput((text) => submit(text));

  /**
   * Tara's voice. Off until asked for, and persisted, because an app that
   * starts talking unprompted in an open-plan office gets muted permanently.
   * Silent narration mode suppresses it too — "don't narrate" includes "don't
   * say it out loud".
   */
  const speechOn = useWorkspaceStore((s) => s.assistantSpeech);
  const setSpeechOn = useWorkspaceStore((s) => s.setAssistantSpeech);
  const speech = useVoiceOutput(speechOn && mode !== 'silent');

  // Speak each NEW assistant turn once. Keyed on turn id rather than on the
  // array, or every unrelated re-render would replay the last reply.
  const spokenRef = useRef<string | null>(null);
  useEffect(() => {
    const last = turns[turns.length - 1];
    if (!last || last.role !== 'assistant') return;
    if (spokenRef.current === last.id) return;
    spokenRef.current = last.id;
    // The greeting is not spoken: the dock opens on a click, and a voice
    // arriving unprompted from a click is startling.
    if (last.id === 'greeting') return;
    speech.speak(last.text);
  }, [turns, speech]);

  return (
    <>
      {/* FAB */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={ASSISTANT_TRIGGER_LABEL}
        aria-expanded={open}
        className={cn(
          // z-[120], above the discipline gate's z-[110]. See the note on the
          // dock's own z-index below for why the assistant outranks that gate.
          'fixed bottom-5 right-5 z-[120] flex h-12 w-12 items-center justify-center rounded-full',
          'bg-teal text-white shadow-card transition-transform duration-micro',
          'hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
          open && 'pointer-events-none opacity-0',
        )}
      >
        <MascotMark size={24} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.aside
            key="ai-dock"
            role="dialog"
            aria-label={`${ASSISTANT_NAME} assistant`}
            initial={reduce ? { opacity: 0 } : { opacity: 0, x: 24, y: 8 }}
            animate={{ opacity: 1, x: 0, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, x: 24, y: 8 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            /**
             * z-[120] — ABOVE the discipline gate (z-[110]).
             *
             * The gate is a full-screen `fixed inset-0` overlay, so at z-50 the
             * assistant was not merely behind it, it was unreachable: the FAB
             * could not be clicked, the input could not be typed into, and the
             * mic could not be pressed. Whenever a discipline session was
             * required, the AI simply did not respond — which reads exactly like
             * a broken assistant rather than a deliberate gate.
             *
             * The gate exists to make someone set limits BEFORE TRADING. The
             * assistant cannot place, modify or cancel an order — that is
             * structural (AssistantAction has no order variant) — so nothing it
             * can do bypasses the gate's purpose. Asking "what is NIFTY trading
             * at", or "what is this screen asking me for", while the gate is up
             * is safe, and being unable to is just a dead product.
             *
             * The gate still blocks everything it is meant to: the workspace,
             * the order ticket, the command palette. Only the observation-only
             * assistant sits above it.
             */
            className="fixed bottom-5 right-5 z-[120] flex h-[560px] max-h-[calc(100vh-2.5rem)] w-[380px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-card border border-border bg-card shadow-card"
          >
            <header className="flex items-center gap-2 border-b border-border px-4 py-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal text-white">
                <MascotMark size={18} />
              </span>
              <div className="min-w-0">
                <div className="text-sm font-bold text-text">{ASSISTANT_NAME}</div>
                <div className="flex items-center gap-1 text-[11px] text-muted">
                  <span className="h-1.5 w-1.5 rounded-full bg-up" /> Online
                </div>
              </div>
              {speech.supported && (
                <button
                  type="button"
                  onClick={() => {
                    if (speechOn) speech.cancel();
                    setSpeechOn(!speechOn);
                  }}
                  aria-label={speechOn ? `Mute ${ASSISTANT_NAME}` : `Let ${ASSISTANT_NAME} speak`}
                  aria-pressed={speechOn}
                  title={speech.voiceName ? `Voice: ${speech.voiceName}` : undefined}
                  className={cn(
                    'ml-auto rounded-lg p-1.5 transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                    speechOn ? 'text-teal hover:bg-hover' : 'text-faint hover:bg-hover hover:text-text',
                  )}
                >
                  {speechOn ? <SpeakerIcon className="h-4 w-4" /> : <SpeakerOffIcon className="h-4 w-4" />}
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close assistant"
                className="rounded-lg px-2 py-1 text-xs font-semibold text-muted hover:bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                Close
              </button>
            </header>

            {/* Narration mode (AI-OPERATING-SYSTEM.md §9). Persisted in the
                workspace store, so it is set once and not per session. */}
            <div
              role="radiogroup"
              aria-label="How much the assistant explains"
              className="flex items-center gap-1 border-b border-border px-4 py-2"
            >
              {NARRATION_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.id}
                  title={m.hint}
                  onClick={() => setMode(m.id)}
                  className={cn(
                    'rounded-full px-2.5 py-1 text-[10px] font-semibold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                    mode === m.id
                      ? 'bg-teal text-white'
                      : 'text-muted hover:bg-hover hover:text-text',
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <div ref={scrollRef} className="flex-1 space-y-3 overflow-auto p-4">
              {turns.map((turn) => (
                <Turn
                  key={turn.id}
                  turn={turn}
                  onConfirm={() => confirmPlan(turn.id)}
                  onCancel={() => cancelPlan(turn.id)}
                />
              ))}
              <div className="flex items-center gap-2 text-[11px] text-faint">
                <Badge tone="brand" className="px-1.5 py-0 text-[9px]">
                  BETA
                </Badge>
                Prices, voice and app control are live · chart analysis is next
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5 px-4 pb-2">
              {QUICK_CHIPS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => submit(c)}
                  className="rounded-full border border-border2 px-2.5 py-1 text-[11px] font-semibold text-muted transition-colors duration-micro hover:border-teal hover:text-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {c}
                </button>
              ))}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit(draft);
              }}
              className="flex items-center gap-2 border-t border-border p-3"
            >
              <input
                aria-label={`Message ${ASSISTANT_NAME}`}
                placeholder={voice.listening ? 'Listening…' : `Ask ${ASSISTANT_NAME}…`}
                value={voice.interim || draft}
                onChange={(e) => setDraft(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-border2 bg-bg px-3 py-2 text-sm text-text placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              />

              {/* Hidden entirely where the browser has no SpeechRecognition
                  (Firefox) rather than rendered as a button that does nothing. */}
              {voice.supported && (
                <button
                  type="button"
                  onClick={() => (voice.listening ? voice.stop() : voice.start())}
                  aria-label={voice.listening ? 'Stop listening' : `Speak to ${ASSISTANT_NAME}`}
                  aria-pressed={voice.listening}
                  className={cn(
                    'shrink-0 rounded-lg border p-2 transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                    voice.listening
                      ? 'border-teal bg-teal text-white'
                      : 'border-border2 text-muted hover:border-teal hover:text-teal',
                  )}
                >
                  <MicIcon className="h-4 w-4" />
                </button>
              )}
              <button
                type="submit"
                disabled={!draft.trim()}
                className="rounded-lg bg-teal px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                Send
              </button>
            </form>
            {voice.error && (
              <p className="border-t border-border px-4 py-2 text-[11px] leading-tight text-amber">
                {voice.error}
              </p>
            )}
            <p className="border-t border-border px-4 py-2 text-[10px] leading-tight text-faint">
              {ASSISTANT_DISCLAIMER}
            </p>
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}

/**
 * One transcript turn. Refusals get a distinct (warning-toned) treatment rather
 * than reading like a normal answer — a boundary should look like a boundary,
 * not like a failure to understand.
 */
function Turn({
  turn,
  onConfirm,
  onCancel,
}: {
  turn: AssistantTurn;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (turn.role === 'user') {
    return (
      <div className="ml-auto max-w-[85%] rounded-card rounded-br-sm bg-teal px-3 py-2 text-sm text-white">
        {turn.text}
      </div>
    );
  }

  const isRefusal = turn.intent === 'refusal';

  return (
    <div className="max-w-[92%] space-y-1.5">
      <div
        className={cn(
          'rounded-card rounded-tl-sm border px-3 py-2 text-sm',
          // amber, not red: a boundary is a deliberate limit, not an error —
          // and red/green are reserved for market direction (DESIGN-SYSTEM.md
          // §1). Opacity modifiers don't apply to var() colors, so this uses
          // the paired `amber-bg` token rather than `bg-amber/5`.
          isRefusal ? 'border-amber bg-amber-bg text-text' : 'border-border bg-bg text-text',
        )}
      >
        {turn.text.split('\n').map((line, i) => (
          <p key={i} className={cn(line === '' && 'h-2', 'whitespace-pre-wrap')}>
            {renderInlineBold(line)}
          </p>
        ))}
      </div>

      {/* The safety gate (lib/assistant/safety.ts). The plan is shown in full
          BEFORE anything runs — the whole point is that the user reads what is
          about to happen, so the steps are listed rather than summarised. */}
      {turn.pendingPlan && (
        <div className="rounded-card border border-amber bg-amber-bg p-3">
          <p className="text-[11px] font-bold uppercase tracking-wideTrack text-amber">
            Confirm before I run this
          </p>
          <ol className="mt-2 space-y-1">
            {turn.pendingPlan.steps.map((s, i) => (
              <li key={s.id} className="flex gap-2 text-[11px] text-text">
                <span className="text-faint">{i + 1}.</span>
                <span>{s.describe}</span>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-lg bg-teal px-3 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              Yes, do it
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-border2 px-3 py-1.5 text-[11px] font-semibold text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {turn.steps && turn.steps.length > 0 && (
        <ul className="space-y-0.5 pl-1 text-[11px] text-faint">
          {turn.steps.map((s, i) => (
            <li key={i} className="flex gap-1.5">
              <span aria-hidden className="text-teal">
                ›
              </span>
              <span>{s}</span>
            </li>
          ))}
        </ul>
      )}

      {turn.disclaimer && (
        <p className="pl-1 text-[10px] text-faint">Observations only — never investment advice.</p>
      )}
    </div>
  );
}

/** Minimal `**bold**` support — the capability reply uses it for section heads.
 *  Deliberately not a markdown renderer; the assistant emits plain text. */
function renderInlineBold(line: string) {
  const parts = line.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? (
      <strong key={i} className="font-bold text-text">
        {p.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}
