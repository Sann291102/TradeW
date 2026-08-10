'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn, Badge } from '@tradew/ui';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { useAssistant, type AssistantTurn } from '@/lib/assistant/useAssistant';
import { useVoice } from '@/lib/voice/useVoice';
import { SparkleIcon } from './icons';

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
 */

/** Quick chips — every one is a real command the resolver handles. */
const QUICK_CHIPS = [
  'Open NIFTY 24300 call of 21st July',
  'Show the option chain',
  'Open Research',
  'What can you do',
];

export function FloatingAI() {
  const open = useWorkspaceStore((s) => s.aiDockOpen);
  const setOpen = useWorkspaceStore((s) => s.setAiDockOpen);
  const reduce = useReducedMotion();
  const { turns, send, busy, personaName } = useAssistant();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  /**
   * A spoken question goes down the identical path as a typed one, and the
   * answer is spoken back. `send` returns the reply text precisely so voice-out
   * does not have to reach into the transcript to find it.
   */
  const handleTranscript = useCallback(
    async (text: string) => {
      setOpen(true);
      const reply = await send(text, 'voice');
      if (reply) voice.say(reply);
    },
    // `voice` is defined below and is stable across renders for the fields used
    // here; listing it would be a cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [send, setOpen],
  );

  const voice = useVoice({ name: personaName, onTranscript: handleTranscript });

  // Keep the newest turn in view — the trace lines mean an answer is often
  // several lines tall, so without this the reply scrolls off as it renders.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  function submit(text: string) {
    void send(text, 'text');
    setDraft('');
  }

  return (
    <>
      {/* FAB */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Ask TradeW AI"
        aria-expanded={open}
        className={cn(
          'fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full',
          'bg-teal text-white shadow-card transition-transform duration-micro',
          'hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
          open && 'pointer-events-none opacity-0',
        )}
      >
        <SparkleIcon className="h-5 w-5" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.aside
            key="ai-dock"
            role="dialog"
            aria-label="TradeW AI assistant"
            initial={reduce ? { opacity: 0 } : { opacity: 0, x: 24, y: 8 }}
            animate={{ opacity: 1, x: 0, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, x: 24, y: 8 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            className="fixed bottom-5 right-5 z-50 flex h-[560px] max-h-[calc(100vh-2.5rem)] w-[380px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-card border border-border bg-card shadow-card"
          >
            <header className="flex items-center gap-2 border-b border-border px-4 py-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal text-white">
                <SparkleIcon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-bold text-text">{personaName}</div>
                <div className="flex items-center gap-1 text-[11px] text-muted">
                  {voice.state === 'listening' ? (
                    <>
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal" /> Listening…
                    </>
                  ) : voice.state === 'speaking' ? (
                    <>
                      <span className="h-1.5 w-1.5 rounded-full bg-teal" /> Speaking
                    </>
                  ) : busy ? (
                    <>
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber" /> Thinking…
                    </>
                  ) : (
                    <>
                      <span className="h-1.5 w-1.5 rounded-full bg-up" /> Online
                    </>
                  )}
                </div>
              </div>

              {/* Microphone state is always visible while live (AI-VOICE.md §6). */}
              {voice.micLive && (
                <span
                  title={
                    voice.wakeEnabled
                      ? `Listening for “Hey ${personaName}”`
                      : 'Microphone is open'
                  }
                  className="ml-auto flex items-center gap-1 rounded-full border border-teal px-1.5 py-0.5 text-[9px] font-bold text-teal"
                >
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal" />
                  MIC
                </span>
              )}

              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close assistant"
                className="ml-auto rounded-lg px-2 py-1 text-xs font-semibold text-muted hover:bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                Close
              </button>
            </header>

            <div ref={scrollRef} className="flex-1 space-y-3 overflow-auto p-4">
              {turns.map((turn) => (
                <Turn key={turn.id} turn={turn} />
              ))}
              {voice.partial && (
                <div className="ml-auto max-w-[85%] rounded-card rounded-br-sm border border-dashed border-teal px-3 py-2 text-sm italic text-muted">
                  {voice.partial}
                </div>
              )}
              {voice.error && <p className="text-[11px] text-amber">{voice.error}</p>}
              <div className="flex items-center gap-2 text-[11px] text-faint">
                <Badge tone="brand" className="px-1.5 py-0 text-[9px]">
                  BETA
                </Badge>
                App control · voice · market analysis
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
                aria-label={`Message ${personaName}`}
                placeholder={`Ask ${personaName}…`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="flex-1 rounded-lg border border-border2 bg-bg px-3 py-2 text-sm text-text placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              />
              {voice.supported.recognition && (
                <button
                  type="button"
                  onClick={() => (voice.state === 'listening' ? voice.stopListening() : voice.startListening())}
                  aria-label={voice.state === 'listening' ? 'Stop listening' : 'Speak to the assistant'}
                  aria-pressed={voice.state === 'listening'}
                  className={cn(
                    'rounded-lg border px-2.5 py-2 text-sm transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                    voice.state === 'listening'
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

            {voice.supported.recognition && (
              <div className="flex items-center gap-2 border-t border-border px-4 py-2">
                <label className="flex items-center gap-1.5 text-[10px] text-muted">
                  <input
                    type="checkbox"
                    checked={voice.wakeEnabled}
                    onChange={(e) => voice.toggleWake(e.target.checked)}
                    className="h-3 w-3 accent-[var(--teal)]"
                  />
                  “Hey {personaName}”
                </label>
                <label className="flex items-center gap-1.5 text-[10px] text-muted">
                  <input
                    type="checkbox"
                    checked={voice.voiceOutEnabled}
                    onChange={(e) => voice.toggleVoiceOut(e.target.checked)}
                    className="h-3 w-3 accent-[var(--teal)]"
                  />
                  Speak replies
                </label>
              </div>
            )}

            {/*
              The upload disclosure. Wake detection in today's browsers uses the
              vendor's cloud recognition service, so the user is told plainly
              while it is on — never buried in a settings page (AI-VOICE.md §3).
            */}
            {voice.wakeEnabled && voice.wakeUsesRemoteAudio && (
              <p className="border-t border-border bg-amber-bg px-4 py-2 text-[10px] leading-tight text-text">
                Wake word uses your browser’s speech service, so audio is processed off-device while
                it’s listening. Turn it off to use the mic button only.
              </p>
            )}

            <p className="border-t border-border px-4 py-2 text-[10px] leading-tight text-faint">
              {personaName} shares observations only — never investment advice.
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
function Turn({ turn }: { turn: AssistantTurn }) {
  if (turn.role === 'user') {
    return (
      <div className="ml-auto max-w-[85%] rounded-card rounded-br-sm bg-teal px-3 py-2 text-sm text-white">
        {turn.text}
      </div>
    );
  }

  const isRefusal = turn.intent === 'refusal';

  if (turn.pending) {
    return (
      <div className="max-w-[92%]">
        <div className="flex gap-1 rounded-card rounded-tl-sm border border-border bg-bg px-3 py-3">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-faint"
              style={{ animationDelay: `${i * 120}ms` }}
            />
          ))}
        </div>
      </div>
    );
  }

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

      {turn.steps && (
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

      {/*
        Provenance. The single most important chip in this component: it is what
        stops a simulated-feed answer from reading like a live one. Rendered
        whenever the server reported a feed, not only when it is simulated —
        "live" is worth stating too.
      */}
      {turn.provenance && turn.provenance.feeds.length > 0 && (
        <div className="pl-1">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-bold',
              turn.provenance.live ? 'border-up text-up' : 'border-amber text-amber',
            )}
          >
            <span
              className={cn('h-1 w-1 rounded-full', turn.provenance.live ? 'bg-up' : 'bg-amber')}
            />
            {turn.provenance.live ? 'LIVE' : 'SIMULATED'} · {turn.provenance.feeds.join('/')}
          </span>
          {turn.provenance.caveat && (
            <p className="mt-1 text-[10px] leading-tight text-amber">{turn.provenance.caveat}</p>
          )}
        </div>
      )}

      {turn.disclaimer && (
        <p className="pl-1 text-[10px] text-faint">Observations only — never investment advice.</p>
      )}
    </div>
  );
}

/** Microphone glyph. Local rather than in `icons.tsx` — only this dock uses it. */
function MicIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className} aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v4" strokeLinecap="round" />
    </svg>
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
